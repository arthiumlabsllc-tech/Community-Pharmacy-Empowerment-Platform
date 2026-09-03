import fs from 'fs';
import {
  RECALL_LIMIT_DEFAULT,
  RECALL_LIMIT_MAX,
  buildRecallBatchQuery,
  buildRecallExposureQuery,
  clampRecallLimit,
  recallContact,
  summariseReach,
  type BuiltQuery,
  type RecallFilter,
} from '../utils/recall-queries';
import {
  RECALL_VERIFY_PATH,
  renderRecallVerifySql,
} from '../utils/recall-verify-sql';
import { inlineParams } from '../utils/sql-literal';

/**
 * The other half of the recall contract.
 *
 * database/tests/004_recall_verify.sql runs the real query against a real
 * Postgres and proves what comes back. This suite proves the query that gets
 * there is the one the API sends, and pins the parts of it that a database
 * cannot object to: placeholder numbering, tenant scoping, and the arithmetic
 * that decides whether a recall is finished.
 *
 * A recall that errors is noticed. A recall that quietly returns half the
 * patients is not, and that is the failure every test here is aimed at.
 */

const PHARMACY = 'ph-1';
const EXPOSURE_TYPES = ['uuid', 'text', 'uuid', 'text', 'date', 'date', 'integer'];
const BATCH_TYPES = ['uuid', 'text', 'uuid', 'text'];

/** Omitted rather than optional: a combination that could set its own pharmacy
 *  would quietly stop testing the tenant scope. */
type Filters = Omit<RecallFilter, 'pharmacyId'>;

function placeholders(text: string): number[] {
  return [...text.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]));
}

/** The placeholders used must be exactly $1..$n for n parameters. */
function expectBound(query: BuiltQuery): void {
  const used = placeholders(query.text);
  expect(used.length).toBeGreaterThan(0);
  // A gap means a parameter was pushed that the SQL never reads. A number beyond
  // the length means the SQL asks for one that was never pushed — which against
  // a recall is not an error, it is a filter that silently stopped filtering.
  expect([...new Set(used)].sort((a, b) => a - b)).toEqual(
    query.params.map((_, index) => index + 1)
  );
}

/** Line endings are normalised because the comparison is about the SQL, and
 *  core.autocrlf would otherwise fail this test on a fresh Windows checkout. */
function normalise(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

describe('the generated Postgres harness', () => {
  it('lives beside the migration harnesses', () => {
    expect(RECALL_VERIFY_PATH.replace(/\\/g, '/')).toContain(
      'database/tests/004_recall_verify.sql'
    );
  });

  it('is committed, so the harness can run without a build step', () => {
    expect(fs.existsSync(RECALL_VERIFY_PATH)).toBe(true);
  });

  it('still matches the builders — a stale copy proves nothing about the query', () => {
    const committed = normalise(fs.readFileSync(RECALL_VERIFY_PATH, 'utf8'));
    const rendered = normalise(renderRecallVerifySql());

    if (committed !== rendered) {
      // Thrown rather than diffed: the file is 66KB, and a diff of it hides the
      // one thing worth saying, which is how to fix it.
      throw new Error(
        'database/tests/004_recall_verify.sql no longer matches the recall builders.\n' +
          'Run `cd backend && npm run recall:emit`, re-run the harness against Postgres,\n' +
          'and commit the regenerated file with the builder change.'
      );
    }
    expect(committed).toBe(rendered);
  });

  it('leaves no placeholder and no window sentinel in the SQL it writes', () => {
    const rendered = renderRecallVerifySql();
    expect(rendered).not.toMatch(/\$\d/);
    // The sentinels exist so the window can be relative to the run. If one
    // survived, the date arm would be comparing against 1970 and the assertion
    // would be passing against a filter that excludes everything.
    expect(rendered).not.toContain('1970-01-0');
    expect(rendered).toContain('(CURRENT_DATE - 10)::date');
    expect(rendered).toContain('(CURRENT_DATE - 1)::date');
  });

  it('numbers its PASS lines in order, so a notice names the check that ran', () => {
    const passes = [...renderRecallVerifySql().matchAll(/RAISE NOTICE 'PASS (\d+):/g)].map(
      (match) => Number(match[1])
    );
    expect(passes).toEqual(Array.from({ length: passes.length }, (_, index) => index + 1));
    expect(passes.length).toBeGreaterThanOrEqual(29);
  });

  it('rolls back, so it can be run twice against one database', () => {
    const rendered = renderRecallVerifySql();
    expect(rendered).toContain('BEGIN;');
    expect(rendered).toContain('ROLLBACK;');
    expect(rendered).not.toContain('COMMIT;');
  });
});

describe('both builders bind exactly the parameters they placehold', () => {
  const combinations: Array<[string, Filters]> = [
    ['a lot only', { batchNumber: 'B/RECALL' }],
    ['a product id only', { inventoryId: 'inv-1' }],
    ['a product name only', { productName: 'amox' }],
    ['a lot and a product id', { batchNumber: 'B/RECALL', inventoryId: 'inv-1' }],
    ['a lot and a product name', { batchNumber: 'B/RECALL', productName: 'amox' }],
    ['all three', { batchNumber: 'B/RECALL', inventoryId: 'inv-1', productName: 'amox' }],
    ['a lot and a window', { batchNumber: 'B/RECALL', from: '2026-08-01', to: '2026-08-31' }],
  ];

  it.each(combinations)('exposure: %s', (_label, filter) => {
    expectBound(buildRecallExposureQuery({ pharmacyId: PHARMACY, ...filter }, 25));
  });

  it.each(combinations)('batches: %s', (_label, filter) => {
    expectBound(buildRecallBatchQuery({ pharmacyId: PHARMACY, ...filter }));
  });

  it('refuses to build a recall that names nothing', () => {
    // Without this the query would return every sale and every lot the pharmacy
    // has, which reads like a successful search for nothing.
    expect(() => buildRecallExposureQuery({ pharmacyId: PHARMACY }, 10)).toThrow(
      /has to name a lot, a product or both/
    );
    expect(() => buildRecallBatchQuery({ pharmacyId: PHARMACY })).toThrow(
      /has to name a lot, a product or both/
    );
    expect(() => buildRecallBatchQuery({ pharmacyId: PHARMACY, batchNumber: '   ' })).toThrow(
      /has to name a lot, a product or both/
    );
  });

  it('scopes every row to the pharmacy asking', () => {
    // One pharmacy's recall must not read another's patients. The filter is on
    // the sale, on the batch and on the junction, because each is joined from a
    // different direction.
    const exposure = buildRecallExposureQuery({ pharmacyId: PHARMACY, batchNumber: 'B/1' }, 5);
    expect(exposure.text).toContain('WHERE s.pharmacy_id = $1');
    expect(exposure.text).toContain('WHERE sib.pharmacy_id = $1');
    expect(exposure.text).toContain('s2.pharmacy_id = $1');
    expect(buildRecallBatchQuery({ pharmacyId: PHARMACY, batchNumber: 'B/1' }).text).toContain(
      'WHERE b.pharmacy_id = $1'
    );
  });
});

describe('buildRecallExposureQuery', () => {
  const build = (filter: Filters = {}, limit = 10) =>
    buildRecallExposureQuery({ pharmacyId: PHARMACY, ...filter }, limit);

  it('pushes an absent filter as null, which switches its arm off', () => {
    expect(build({ batchNumber: 'B/1' }).params).toEqual([
      PHARMACY,
      'B/1',
      null,
      null,
      null,
      null,
      10,
    ]);
  });

  it('trims a lot number rather than matching on its padding', () => {
    expect(build({ batchNumber: '  B/1  ' }).params[1]).toBe('B/1');
    // Trimmed to nothing, so the arm switches off instead of matching every lot
    // whose number happens to be blank. A product is named alongside it because
    // a lot that trims to nothing on its own is refused outright, as it should be.
    expect(build({ batchNumber: '   ', inventoryId: 'inv-1' }).params[1]).toBeNull();
  });

  it('dates the window by when the sale happened, not when it synced', () => {
    const query = build({ batchNumber: 'B/1', from: '2026-08-01', to: '2026-08-31' });
    expect(query.params).toEqual([
      PHARMACY,
      'B/1',
      null,
      null,
      '2026-08-01',
      '2026-08-31',
      10,
    ]);

    const soldAt = 'COALESCE(s.client_recorded_at, s.created_at)';
    expect(query.text).toContain(`(${soldAt})::date >= $5::date`);
    expect(query.text).toContain(`(${soldAt})::date <= $6::date`);
    expect(query.text).toContain(`ORDER BY ${soldAt} DESC, s.receipt_number ASC`);
    // The failure this rules out: a till that went down on Friday and reconnected
    // on Monday would have its whole weekend's sales dated Monday, and a recall
    // bounded by "the week it was sold" would miss them.
    expect(query.text).not.toMatch(/s\.created_at(::date)?\s*>=/);
  });

  it('reduces a timestamp to its date, so the last day of a window is kept', () => {
    // A datetime compared against a DATE column loses the final day: the window
    // says "up to 31 August" and the query reads "before midnight on 31 August".
    expect(build({ batchNumber: 'B/1', to: '2026-08-31T23:59:59.000Z' }).params[5]).toBe(
      '2026-08-31'
    );
  });

  it('drops a date it cannot parse instead of handing it to the database', () => {
    const query = build({ batchNumber: 'B/1', from: 'last monday', to: '31/08/2026' });
    expect(query.params[4]).toBeNull();
    expect(query.params[5]).toBeNull();
  });

  it('keeps both provenance arms and labels which is which', () => {
    const text = build({ batchNumber: 'B/1' }).text;
    expect(text).toContain(`'batch_ledger'::text AS provenance`);
    expect(text).toContain(`'product_row'::text AS provenance`);
    expect(text).toContain('UNION ALL');
    // The snapshot arm reads only lines the ledger does not cover. Without the
    // exclusion a post-003 sale appears twice and the unit total doubles.
    expect(text).toContain('NOT EXISTS');
  });

  it('applies the limit it is given, so the caller can ask for one extra', () => {
    // The route asks for limit + 1 and reports `truncated` when it gets it. A
    // list that was silently shortened looks identical to a complete one.
    const query = build({ batchNumber: 'B/1' }, 501);
    expect(query.text).toContain('LIMIT $7');
    expect(query.params[6]).toBe(501);
  });

  it('carries the contact details a recall is for, not just the sale', () => {
    const text = build({ batchNumber: 'B/1' }).text;
    for (const column of [
      'p.phone AS patient_phone',
      'p.alternate_phone AS patient_alternate_phone',
      's.customer_phone',
      's.customer_name',
      'p.nhis_number AS patient_nhis_number',
      's.voided_at IS NOT NULL AS voided',
      's.recorded_offline',
    ]) {
      expect(text).toContain(column);
    }
  });
});

describe('buildRecallBatchQuery', () => {
  it('returns what is on the shelf and who supplied it', () => {
    const query = buildRecallBatchQuery({ pharmacyId: PHARMACY, batchNumber: 'B/1' });
    expect(query.params).toEqual([PHARMACY, 'B/1', null, null]);
    // The quarantine half of a recall: the patient list is useless while the
    // remaining stock is still being sold, and the supplier and invoice are what
    // make the return call possible.
    for (const column of [
      'b.quantity',
      'b.invoice_number',
      's.name AS supplier_name',
      'i.product_name',
      'b.is_active',
    ]) {
      expect(query.text).toContain(column);
    }
  });

  it('matches a lot the way it is read off a notice', () => {
    expect(buildRecallBatchQuery({ pharmacyId: PHARMACY, batchNumber: 'b/1' }).text).toContain(
      'UPPER(TRIM(b.batch_number)) = UPPER(TRIM($2::text))'
    );
  });

  it('hands dates over as text, so a server west of Greenwich cannot move an expiry', () => {
    // node-postgres turns a DATE into a JS Date at local midnight, and
    // toISOString() on that is the previous day for any server west of GMT.
    // Accra is on GMT, but the API is not guaranteed to be hosted there.
    const text = buildRecallBatchQuery({ pharmacyId: PHARMACY, batchNumber: 'B/1' }).text;
    expect(text).toContain(`to_char(b.expiry_date, 'YYYY-MM-DD') AS expiry_date`);
    expect(text).toContain(`to_char(b.received_at, 'YYYY-MM-DD') AS received_at`);
  });
});

describe('clampRecallLimit', () => {
  it('falls back to the default for anything that is not a positive count', () => {
    for (const value of [undefined, null, '', 'abc', 0, -5, '0', NaN]) {
      expect(clampRecallLimit(value)).toBe(RECALL_LIMIT_DEFAULT);
    }
  });

  it('caps at the maximum rather than trusting the caller', () => {
    // A limit of a million against a recall is a memory spike on the API and a
    // browser that never renders, in the middle of a regulator's deadline.
    expect(clampRecallLimit(RECALL_LIMIT_MAX)).toBe(RECALL_LIMIT_MAX);
    expect(clampRecallLimit(RECALL_LIMIT_MAX * 10)).toBe(RECALL_LIMIT_MAX);
    expect(clampRecallLimit('999999')).toBe(RECALL_LIMIT_MAX);
  });

  it('accepts a limit that arrived as a query string', () => {
    expect(clampRecallLimit('250')).toBe(250);
    expect(clampRecallLimit(250)).toBe(250);
  });
});

describe('inlineParams', () => {
  it('refuses to inline a query whose types are not all declared', () => {
    // The types are a hand-written list beside a builder that can grow a
    // parameter. Guessing text for a uuid would produce SQL that fails to
    // compare, and the harness would look broken instead of stale.
    expect(() =>
      inlineParams({ text: 'SELECT $1, $2', params: ['a', 'b'] }, ['text'])
    ).toThrow(/binds 2 parameters but only 1 types are declared/);
  });

  it('leaves no placeholder behind', () => {
    const exposure = buildRecallExposureQuery({ pharmacyId: PHARMACY, batchNumber: 'B/1' }, 10);
    expect(inlineParams(exposure, EXPOSURE_TYPES)).not.toMatch(/\$\d/);

    const batches = buildRecallBatchQuery({ pharmacyId: PHARMACY, batchNumber: 'B/1' });
    expect(inlineParams(batches, BATCH_TYPES)).not.toMatch(/\$\d/);
  });

  it('casts a uuid, because text does not compare against uuid', () => {
    const query = buildRecallBatchQuery({ pharmacyId: PHARMACY, inventoryId: 'inv-1' });
    const sql = inlineParams(query, BATCH_TYPES);
    expect(sql).toContain(`'${PHARMACY}'::uuid`);
    expect(sql).toContain(`'inv-1'::uuid`);
  });

  it('renders an absent filter as a bare NULL and lets the query cast it', () => {
    // toLiteral emits an untyped NULL on purpose: every nullable placeholder in
    // the builders already carries `::uuid` or `::text`, so the cast lands on the
    // NULL rather than beside it. Casting in both places would be the same SQL
    // twice, and casting in neither would leave `NULL IS NULL` unresolvable.
    const query = buildRecallBatchQuery({ pharmacyId: PHARMACY, batchNumber: 'B/1' });
    const sql = inlineParams(query, BATCH_TYPES);
    expect(sql).toContain('NULL::uuid IS NULL OR b.inventory_id = NULL::uuid');
    expect(sql).toContain('NULL::text IS NULL OR i.product_name ILIKE');
  });

  it('escapes a quote in a lot number instead of ending the literal', () => {
    const query = buildRecallBatchQuery({ pharmacyId: PHARMACY, batchNumber: "B/O'HARE" });
    expect(inlineParams(query, BATCH_TYPES)).toContain(`'B/O''HARE'::text`);
  });

  it('replaces the highest placeholder first, so $1 cannot eat $10', () => {
    const sql = inlineParams(
      { text: 'SELECT $1, $10', params: Array(10).fill('x') },
      Array(10).fill('text')
    );
    expect(sql).toBe(`SELECT 'x'::text, 'x'::text`);
  });

  it('renders a limit as a bare integer, not a quoted one', () => {
    const query = buildRecallExposureQuery({ pharmacyId: PHARMACY, batchNumber: 'B/1' }, 501);
    expect(inlineParams(query, EXPOSURE_TYPES)).toContain('LIMIT 501');
  });
});

describe('recallContact', () => {
  it('prefers the patient record over the number keyed at the till', () => {
    expect(
      recallContact({
        patient_phone: '0241111111',
        patient_alternate_phone: '0241111112',
        customer_phone: '0243333333',
      })
    ).toEqual({ phone: '0241111111', source: 'patient' });
  });

  it('falls back to the alternate, then to the till', () => {
    expect(
      recallContact({
        patient_phone: null,
        patient_alternate_phone: '0241111112',
        customer_phone: '0243333333',
      })
    ).toEqual({ phone: '0241111112', source: 'patient' });

    expect(
      recallContact({
        patient_phone: null,
        patient_alternate_phone: null,
        customer_phone: '0243333333',
      })
    ).toEqual({ phone: '0243333333', source: 'customer' });
  });

  it('reports a walk-in as unreachable rather than guessing', () => {
    expect(
      recallContact({
        patient_phone: null,
        patient_alternate_phone: null,
        customer_phone: null,
      })
    ).toEqual({ phone: null, source: null });
  });

  it('treats a blank or padded number as no number at all', () => {
    // What an imported spreadsheet leaves in a phone column. Dialling it wastes
    // the afternoon a recall allows; counting it as reachable closes a recall
    // that is not closed.
    expect(
      recallContact({
        patient_phone: '   ',
        patient_alternate_phone: '',
        customer_phone: '  ',
      })
    ).toEqual({ phone: null, source: null });
  });
});

describe('summariseReach', () => {
  type ReachRow = Parameters<typeof summariseReach>[0][number];

  const row = (overrides: Partial<ReachRow> = {}): ReachRow => ({
    quantity: 1,
    voided: false,
    patient_phone: null,
    patient_alternate_phone: null,
    customer_phone: null,
    ...overrides,
  });

  it('counts a voided sale as stock that came back, not stock that is out there', () => {
    // Still listed by the query — the patient may have been given a replacement
    // from the same lot — but not counted, or the recall reports units nobody
    // is holding.
    expect(
      summariseReach([row({ quantity: 5, voided: true, customer_phone: '0241111111' })])
    ).toEqual({
      reachableUnits: 0,
      unreachableUnits: 0,
      reachableSales: 0,
      unreachableSales: 0,
      distinctContacts: 0,
    });
  });

  it('splits the units it can phone from the units it cannot', () => {
    const reach = summariseReach([
      row({ quantity: 3, patient_phone: '0241111111' }),
      row({ quantity: 2 }),
      row({ quantity: 4, customer_phone: '0242222222' }),
    ]);
    // This pair of numbers is the decision: if unreachableUnits is zero a round
    // of calls closes the recall, and if it is not the pharmacy owes a notice in
    // the window and a call to the supplier.
    expect(reach.reachableUnits).toBe(7);
    expect(reach.unreachableUnits).toBe(2);
    expect(reach.reachableSales).toBe(2);
    expect(reach.unreachableSales).toBe(1);
    expect(reach.distinctContacts).toBe(2);
  });

  it('counts one patient buying the lot twice as one call', () => {
    const reach = summariseReach([
      row({ quantity: 1, patient_phone: '0241111111' }),
      row({ quantity: 1, patient_phone: '0241111111' }),
    ]);
    expect(reach.distinctContacts).toBe(1);
    expect(reach.reachableSales).toBe(2);
    expect(reach.reachableUnits).toBe(2);
  });

  it('says nothing was reached when there is nothing to reach', () => {
    expect(summariseReach([])).toEqual({
      reachableUnits: 0,
      unreachableUnits: 0,
      reachableSales: 0,
      unreachableSales: 0,
      distinctContacts: 0,
    });
  });

  it('does not let a quantity handed back as a string break the total', () => {
    // node-postgres returns INTEGER as a number and DECIMAL as a string. The
    // junction quantity is an integer today; the total must not depend on it
    // staying one, because a NaN in a recall total reads as zero.
    const reach = summariseReach([
      row({ quantity: '3' as unknown as number, customer_phone: '0241111111' }),
    ]);
    expect(reach.reachableUnits).toBe(3);
  });
});
