import fs from 'fs';
import {
  ALERT_DEDUPE_COLUMNS,
  EXPIRING_ALERT_DAYS,
  STOCK_ALERT_KINDS,
  StockAlertsUnavailable,
  alertKey,
  buildAlertInsert,
  buildLiveAlertQuery,
  buildSchemaProbeQuery,
  buildStockStateQuery,
  buildSupersedeQuery,
  classifyStock,
  daysBetween,
  hasAlertDedupe,
  refreshStockAlerts,
  refreshStockAlertsFor,
  resetAlertDedupeProbe,
  toStockState,
  type BuiltQuery,
  type StockAlert,
  type StockAlertKind,
  type StockRow,
  type StockState,
} from '../utils/stock-alerts';
import {
  STOCK_ALERT_VERIFY_PATH,
  renderStockAlertVerifySql,
} from '../utils/stock-alert-verify-sql';
import { inlineParams } from '../utils/sql-literal';
import type { Queryable } from '../utils/batches';

/**
 * The alert writer, tested where a database cannot help.
 *
 * database/tests/005_stock_alerts_verify.sql runs the SQL against a real
 * Postgres and proves the dedupe holds. This suite covers the half that never
 * reaches one: which conditions a product is in, what the pharmacist is told
 * about each, and whether the refresh writes what it reports having written.
 *
 * The failure aimed at throughout is an alert that is wrong in a way nobody
 * notices. A bell that cries low stock every day for a month is not an error,
 * it is a bell nobody opens — and by the time a real shortage is missed, the
 * evidence that it was missed is the absence of a notification.
 */

const PHARMACY = 'ph-1';
const TODAY = '2026-03-01';

/** Named in one place because both the builder test and the harness test ask
 *  about a column that must not exist. */
const ABSENT_COLUMN = 'no_such_column_005';

const STOCK_TYPES = ['uuid', 'uuid[]'];
const LIVE_TYPES = ['uuid', 'text[]', 'text[]'];
const SUPERSEDE_TYPES = ['uuid', 'uuid[]'];

function state(overrides: Partial<StockState> = {}): StockState {
  return {
    inventoryId: 'inv-1',
    productName: 'Paracetamol 500mg',
    quantity: 100,
    reorderLevel: 10,
    expiryDate: '2027-06-01',
    batchNumber: 'PAR-500',
    isActive: true,
    ...overrides,
  };
}

function shelfRow(overrides: Partial<StockRow> & { id: string }): StockRow {
  return {
    product_name: 'Paracetamol 500mg',
    quantity: 100,
    reorder_level: 10,
    batch_number: 'PAR-500',
    is_active: true,
    expiry_date: '2027-06-01',
    ...overrides,
  };
}

const kinds = (alerts: StockAlert[]) => alerts.map((alert) => alert.kind);
const keys = (alerts: StockAlert[]) => alerts.map((alert) => alert.dedupeKey);

function placeholders(text: string): number[] {
  return [...text.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]));
}

/** The placeholders used must be exactly $1..$n for n parameters. */
function expectBound(query: BuiltQuery): void {
  const used = placeholders(query.text);
  expect(used.length).toBeGreaterThan(0);
  // A gap means a parameter was pushed that the SQL never reads. A number beyond
  // the length means the SQL asks for one that was never pushed, which here would
  // be an alert written with somebody else's message in it.
  expect([...new Set(used)].sort((a, b) => a - b)).toEqual(
    query.params.map((_, index) => index + 1)
  );
}

/** Line endings are normalised because the comparison is about the SQL, and
 *  core.autocrlf would otherwise fail this test on a fresh Windows checkout. */
function normalise(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

// ---------------------------------------------------------------------------
// The generated harness
// ---------------------------------------------------------------------------

describe('the generated Postgres harness', () => {
  it('lives beside the migration harnesses', () => {
    expect(STOCK_ALERT_VERIFY_PATH.replace(/\\/g, '/')).toContain(
      'database/tests/005_stock_alerts_verify.sql'
    );
  });

  it('is committed, so the harness can run without a build step', () => {
    expect(fs.existsSync(STOCK_ALERT_VERIFY_PATH)).toBe(true);
  });

  it('still matches the builders — a stale copy proves nothing about the query', () => {
    const committed = normalise(fs.readFileSync(STOCK_ALERT_VERIFY_PATH, 'utf8'));
    const rendered = normalise(renderStockAlertVerifySql());

    if (committed !== rendered) {
      // Thrown rather than diffed: the file is mostly inlined SQL, and a diff of
      // it hides the one thing worth saying, which is how to fix it.
      throw new Error(
        'database/tests/005_stock_alerts_verify.sql no longer matches the alert builders.\n' +
          'Run `cd backend && npm run alerts:emit`, re-run the harness against Postgres,\n' +
          'and commit the regenerated file with the builder change.'
      );
    }
    expect(committed).toBe(rendered);
  });

  it('leaves no placeholder and no sentinel in the SQL it writes', () => {
    const rendered = renderStockAlertVerifySql();
    expect(rendered).not.toMatch(/\$\d/);
    // Both sentinels stand in for a notification id the harness cannot know at
    // render time. If either survived, the statement would match a row that does
    // not exist and every assertion after it would pass against nothing.
    expect(rendered).not.toContain('ffffffff-ffff-ffff-ffff-ffffffffffff');
    expect(rendered).not.toContain('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee');
  });

  it('is built on fixed dates, so it does not go stale every morning', () => {
    const rendered = renderStockAlertVerifySql();
    // The classifier's date arithmetic is tested below against these same dates.
    // A harness rendered against today's date would differ daily while proving
    // exactly the same SQL, and the staleness test would fail on the second one.
    expect(rendered).toContain(`'2026-04-15'::date`);
    expect(rendered).not.toContain('CURRENT_DATE');
  });

  it('proves the schema probe against a real database, not only against a fake one', () => {
    // The probe is the quietest failure in the module: get current_schema()
    // wrong and every pharmacy answers "not installed" forever, the bell shows
    // nothing, and no log line looks like an error. A jest fake can only assert
    // the answer it was told to give.
    const rendered = renderStockAlertVerifySql();
    expect(rendered).toContain('table_schema = current_schema()');
    expect(rendered).toContain('CREATE TEMP VIEW probe_both AS');
    // The control that keeps the positive assertion honest: asked about a column
    // that does not exist, the same builder has to count zero.
    expect(rendered).toContain('CREATE TEMP VIEW probe_absent AS');
    expect(rendered).toContain(`'${ABSENT_COLUMN}'::text`);
  });

  it('numbers its PASS lines in order, so a notice names the check that ran', () => {
    const passes = [...renderStockAlertVerifySql().matchAll(/RAISE NOTICE 'PASS (\d+):/g)].map(
      (match) => Number(match[1])
    );
    expect(passes).toEqual(Array.from({ length: passes.length }, (_, index) => index + 1));
    // A floor, not the exact count: the point is that a reader who edits a
    // builder and drops a section cannot leave the harness quietly proving less.
    expect(passes.length).toBeGreaterThanOrEqual(45);
  });

  it('rolls back, so it can be run twice against one database', () => {
    const rendered = renderStockAlertVerifySql();
    expect(rendered).toContain('BEGIN;');
    expect(rendered).toContain('ROLLBACK;');
    expect(rendered).not.toContain('COMMIT;');
  });
});

// ---------------------------------------------------------------------------
// Date arithmetic
// ---------------------------------------------------------------------------

describe('daysBetween', () => {
  it('is zero on the day itself', () => {
    expect(daysBetween(TODAY, TODAY)).toBe(0);
  });

  it('counts forward', () => {
    expect(daysBetween('2026-03-01', '2026-04-15')).toBe(45);
  });

  it('counts backward as negative, which is how expired is recognised', () => {
    expect(daysBetween('2026-03-01', '2026-02-20')).toBe(-9);
  });

  it('knows a leap year, because guessing 28 days in February is a day out', () => {
    expect(daysBetween('2024-02-28', '2024-03-01')).toBe(2);
    expect(daysBetween('2026-02-28', '2026-03-01')).toBe(1);
  });

  it('crosses a year end without a shortcut', () => {
    expect(daysBetween('2026-12-31', '2027-01-01')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Which conditions a product is in
// ---------------------------------------------------------------------------

describe('classifyStock', () => {
  it('says nothing about a product that is stocked and far from its date', () => {
    expect(classifyStock(state(), TODAY)).toEqual([]);
  });

  it('raises low stock at the reorder level, not only below it', () => {
    // The shelf is at the point where ordering is the right thing to do. Waiting
    // until it is under means the order is already late.
    expect(kinds(classifyStock(state({ quantity: 10, reorderLevel: 10 }), TODAY))).toEqual([
      'low_stock',
    ]);
    expect(classifyStock(state({ quantity: 11, reorderLevel: 10 }), TODAY)).toEqual([]);
  });

  it('reports one problem at zero, not three', () => {
    const alerts = classifyStock(
      state({ quantity: 0, reorderLevel: 10, expiryDate: '2026-03-20' }),
      TODAY
    );
    expect(kinds(alerts)).toEqual(['out_of_stock']);
  });

  it('says stock-take below zero, because reorder would be the wrong errand', () => {
    const [alert] = classifyStock(state({ quantity: -3, reorderLevel: 20 }), TODAY);
    expect(alert.kind).toBe('out_of_stock');
    expect(alert.message).toContain('3 unit(s) below zero');
    expect(alert.message).toContain('stock-take');
    // Migration 003 lets a batch go negative on purpose: stock sold during an
    // outage has physically left whether or not the count agrees.
    expect(alert.message).toContain('more was sold than was recorded as received');
  });

  it('separates expired from expiring, so nothing is both quarantined and sold down', () => {
    const alerts = classifyStock(state({ expiryDate: '2026-02-28' }), TODAY);
    expect(kinds(alerts)).toEqual(['expired_stock']);
    expect(alerts[0].message).toContain('quarantine');
  });

  it('still calls an expired product low, because quarantining it does not cancel the order', () => {
    const alerts = classifyStock(
      state({ quantity: 4, reorderLevel: 10, expiryDate: '2026-02-28' }),
      TODAY
    );
    expect(kinds(alerts)).toEqual(['low_stock', 'expired_stock']);
  });

  it('keeps stock sellable on its expiry date, matching the till and the allocator', () => {
    // The rule everywhere else in the codebase is `expiry_date < CURRENT_DATE`:
    // sellable ON the date, expired the day after. An alert that disagreed would
    // tell the pharmacist to quarantine stock a cashier can still legally sell.
    expect(kinds(classifyStock(state({ expiryDate: TODAY }), TODAY))).toEqual(['expiring']);
    expect(kinds(classifyStock(state({ expiryDate: '2026-02-28' }), TODAY))).toEqual([
      'expired_stock',
    ]);
  });

  it('raises an expiry at the horizon and not one day past it', () => {
    expect(EXPIRING_ALERT_DAYS).toBe(90);
    expect(kinds(classifyStock(state({ expiryDate: '2026-05-30' }), TODAY))).toEqual(['expiring']);
    expect(classifyStock(state({ expiryDate: '2026-05-31' }), TODAY)).toEqual([]);
  });

  it('takes the horizon as an argument, so a caller is not stuck with the default', () => {
    expect(kinds(classifyStock(state({ expiryDate: '2026-05-31' }), TODAY, 120))).toEqual([
      'expiring',
    ]);
  });

  it('raises low stock and an expiry together, because they are two different jobs', () => {
    const alerts = classifyStock(
      state({ quantity: 3, reorderLevel: 10, expiryDate: '2026-05-20' }),
      TODAY
    );
    expect(kinds(alerts)).toEqual(['low_stock', 'expiring']);
  });

  it('says nothing about a retired product, which is how deactivating one clears its alerts', () => {
    expect(
      classifyStock(
        state({ isActive: false, quantity: 0, expiryDate: '2026-01-01' }),
        TODAY
      )
    ).toEqual([]);
  });

  it('never reports undated stock as expiring, because there is no date to report', () => {
    expect(classifyStock(state({ expiryDate: null, quantity: 100 }), TODAY)).toEqual([]);
    expect(kinds(classifyStock(state({ expiryDate: null, quantity: 2 }), TODAY))).toEqual([
      'low_stock',
    ]);
  });

  it('names the lot in an expiry alert, so the right box comes off the shelf', () => {
    const [alert] = classifyStock(state({ expiryDate: '2026-04-15', batchNumber: 'OXY-3' }), TODAY);
    expect(alert.message).toContain('lot OXY-3');
    expect(classifyStock(state({ expiryDate: '2026-04-15', batchNumber: null }), TODAY)[0].message)
      // Undated stock exists and "lot null" would be read as a lot called null.
      .not.toContain('lot');
  });

  it('reports the past rather than claiming to be current', () => {
    // A live alert is not refreshed while it stays live. One that said "has 5
    // left" would still say 5 a fortnight later, after three deliveries.
    const [alert] = classifyStock(state({ quantity: 5, reorderLevel: 15 }), TODAY);
    expect(alert.message).toContain('fell to 5');
    expect(alert.message).not.toContain('has 5');
  });

  it('gives every alert a title short enough for a bell', () => {
    const alerts = [
      ...classifyStock(state({ quantity: 0 }), TODAY),
      ...classifyStock(state({ quantity: 1, expiryDate: '2026-02-28' }), TODAY),
      ...classifyStock(state({ quantity: 3, expiryDate: '2026-04-15' }), TODAY),
    ];
    expect(alerts.length).toBeGreaterThan(0);
    for (const alert of alerts) {
      expect(alert.title.length).toBeLessThanOrEqual(20);
      expect(alert.title.length).toBeGreaterThan(0);
    }
  });

  it('carries enough metadata for the bell to link without re-reading the shelf', () => {
    const [alert] = classifyStock(
      state({ inventoryId: 'inv-9', quantity: 30, expiryDate: '2026-04-15' }),
      TODAY
    );
    expect(alert.metadata).toMatchObject({
      inventory_id: 'inv-9',
      product_name: 'Paracetamol 500mg',
      quantity: 30,
      reorder_level: 10,
      batch_number: 'PAR-500',
      expiry_date: '2026-04-15',
      days_to_expiry: 45,
      href: '/inventory',
    });
  });

  it('leaves days_to_expiry null for undated stock rather than inventing a number', () => {
    const [alert] = classifyStock(state({ expiryDate: null, quantity: 2 }), TODAY);
    expect(alert.metadata.days_to_expiry).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The dedupe key
// ---------------------------------------------------------------------------

describe('alertKey', () => {
  it('puts the kind first and the product second, which is what split_part reads', () => {
    const key = alertKey('low_stock', 'inv-7');
    expect(key.split(':')[0]).toBe('low_stock');
    expect(key.split(':')[1]).toBe('inv-7');
    // A colon in the id would make the second segment something else, and the
    // live read would scope to the wrong products. A uuid cannot contain one;
    // this is here so a change of id format fails loudly.
    expect('inv-7').not.toContain(':');
  });

  it('gives two products in the same condition different keys', () => {
    expect(alertKey('low_stock', 'inv-1')).not.toBe(alertKey('low_stock', 'inv-2'));
  });

  it('gives one product in two conditions two keys', () => {
    expect(alertKey('low_stock', 'inv-1')).not.toBe(alertKey('expiring', 'inv-1'));
  });

  it('covers every kind the module can raise, so the live read cannot miss one', () => {
    const raised = new Set<StockAlertKind>();
    for (const fixture of [
      state({ quantity: 0 }),
      state({ quantity: 1 }),
      state({ quantity: 50, expiryDate: '2026-02-28' }),
      state({ quantity: 50, expiryDate: '2026-04-15' }),
    ]) {
      for (const alert of classifyStock(fixture, TODAY)) raised.add(alert.kind);
    }
    expect([...raised].sort()).toEqual([...STOCK_ALERT_KINDS].sort());
  });
});

// ---------------------------------------------------------------------------
// The builders
// ---------------------------------------------------------------------------

describe('buildSchemaProbeQuery', () => {
  it('binds exactly the parameters it placeholds', () => {
    expectBound(buildSchemaProbeQuery());
    expectBound(buildSchemaProbeQuery(['dedupe_key']));
  });

  it('asks about the columns the rest of the module assumes', () => {
    expect(buildSchemaProbeQuery().params[0]).toEqual(ALERT_DEDUPE_COLUMNS);
    expect(ALERT_DEDUPE_COLUMNS).toEqual(['dedupe_key', 'superseded_at']);
  });

  it('looks where an unqualified notifications resolves, not in every schema', () => {
    // A probe that counted columns in any schema would answer "installed" for a
    // table this module cannot write to.
    expect(buildSchemaProbeQuery().text).toContain('table_schema = current_schema()');
    expect(buildSchemaProbeQuery().text).toContain(`table_name = 'notifications'`);
  });

  it('takes a different column list, which is how the harness proves it can count zero', () => {
    expect(inlineParams(buildSchemaProbeQuery([ABSENT_COLUMN]), ['text[]'])).toContain(
      `ARRAY['${ABSENT_COLUMN}'::text]::text[]`
    );
  });

  it('inlines as SQL with nothing left to bind', () => {
    expect(placeholders(inlineParams(buildSchemaProbeQuery(), ['text[]']))).toEqual([]);
  });

  it('does not call its answer "found", which the harness cannot read', () => {
    // FOUND is a plpgsql status variable, so `MAX(found)` inside a DO block is
    // ambiguous and Postgres refuses it. The API would never notice — this was
    // caught only by running 005 against a real database, which is the reason
    // the assertion is pinned here too.
    expect(buildSchemaProbeQuery().text).not.toMatch(/\bAS found\b/);
    expect(buildSchemaProbeQuery().text).toContain('AS columns_found');
  });
});

describe('buildStockStateQuery', () => {
  it('binds exactly the parameters it placeholds', () => {
    expectBound(buildStockStateQuery(PHARMACY, []));
    expectBound(buildStockStateQuery(PHARMACY, ['inv-1', 'inv-2']));
  });

  it('binds an empty scope rather than dropping the placeholder', () => {
    const query = buildStockStateQuery(PHARMACY, []);
    expect(query.params).toEqual([PHARMACY, []]);
    // Empty has to mean "every product". Inverted, the bell would open onto an
    // empty list and read as a pharmacy with nothing wrong.
    expect(query.text).toContain('cardinality($2::uuid[]) = 0 OR id = ANY($2::uuid[])');
  });

  it('is scoped to the pharmacy', () => {
    expect(buildStockStateQuery(PHARMACY, []).params[0]).toBe(PHARMACY);
    expect(buildStockStateQuery(PHARMACY, []).text).toContain('pharmacy_id = $1');
  });

  it('reads the expiry as ISO text, which is what the classifier compares against', () => {
    expect(buildStockStateQuery(PHARMACY, []).text).toContain(
      `to_char(expiry_date, 'YYYY-MM-DD')`
    );
  });

  it('selects every column toStockState reads, so the two cannot drift', () => {
    const query = buildStockStateQuery(PHARMACY, []);
    for (const column of [
      'id',
      'product_name',
      'quantity',
      'reorder_level',
      'batch_number',
      'is_active',
      'expiry_date',
    ]) {
      expect(query.text).toContain(column);
    }
    // And nothing is read that was not selected.
    const mapped = toStockState({
      id: 'inv-1',
      product_name: 'X',
      quantity: 1,
      reorder_level: 2,
      batch_number: null,
      is_active: true,
      expiry_date: null,
    });
    expect(Object.values(mapped)).not.toContain(undefined);
  });

  it('inlines as SQL with nothing left to bind', () => {
    const sql = inlineParams(buildStockStateQuery(PHARMACY, ['inv-1']), STOCK_TYPES);
    expect(sql).not.toMatch(/\$\d/);
    expect(sql).toContain(`ARRAY['inv-1'::uuid]::uuid[]`);
  });
});

describe('toStockState', () => {
  it('reads a row as the classifier expects it', () => {
    expect(
      toStockState(
        shelfRow({
          id: 'inv-4',
          product_name: 'ORS Sachets',
          quantity: -3,
          reorder_level: 20,
          batch_number: null,
          expiry_date: '2027-08-01',
        })
      )
    ).toEqual({
      inventoryId: 'inv-4',
      productName: 'ORS Sachets',
      quantity: -3,
      reorderLevel: 20,
      expiryDate: '2027-08-01',
      batchNumber: null,
      isActive: true,
    });
  });

  it('treats a null is_active as active, because the column defaults to true', () => {
    expect(toStockState(shelfRow({ id: 'i', is_active: null })).isActive).toBe(true);
    expect(toStockState(shelfRow({ id: 'i', is_active: false })).isActive).toBe(false);
  });

  it('accepts the numeric strings a DECIMAL column comes back as', () => {
    const mapped = toStockState(shelfRow({ id: 'i', quantity: '12', reorder_level: '5' }));
    expect(mapped.quantity).toBe(12);
    expect(mapped.reorderLevel).toBe(5);
  });

  it('normalises an unreadable expiry to null rather than to a date', () => {
    expect(toStockState(shelfRow({ id: 'i', expiry_date: 'not a date' })).expiryDate).toBeNull();
    expect(toStockState(shelfRow({ id: 'i', expiry_date: '2027-01-10T00:00:00.000Z' })).expiryDate)
      .toBe('2027-01-10');
  });
});

describe('buildLiveAlertQuery', () => {
  it('binds exactly the parameters it placeholds', () => {
    expectBound(buildLiveAlertQuery(PHARMACY, []));
    expectBound(buildLiveAlertQuery(PHARMACY, ['inv-1'], ['low_stock']));
  });

  it('reads live alerts only', () => {
    const text = buildLiveAlertQuery(PHARMACY, []).text;
    expect(text).toContain('superseded_at IS NULL');
    expect(text).toContain('dedupe_key IS NOT NULL');
  });

  it('scopes by kind with split_part rather than a LIKE prefix', () => {
    const text = buildLiveAlertQuery(PHARMACY, []).text;
    expect(text).toContain(`split_part(dedupe_key, ':', 1) = ANY($2::text[])`);
    // An underscore is a LIKE wildcard, and 'low_stock' has one. A prefix match
    // would also pick up 'low_stockpile' if anything ever wrote such a key.
    expect(text).not.toMatch(/LIKE/i);
  });

  it('compares the kind as text, not as a uuid it is not', () => {
    // The second segment is a product id, but the column is written to by other
    // features too. Casting it would fail the whole refresh on one foreign key,
    // and Postgres does not promise to evaluate AND in the written order.
    const text = buildLiveAlertQuery(PHARMACY, []).text;
    expect(text).toContain(`split_part(dedupe_key, ':', 2) = ANY($3::text[])`);
    expect(text).not.toContain(`split_part(dedupe_key, ':', 2)::uuid`);
  });

  it('defaults to every kind this module owns', () => {
    expect(buildLiveAlertQuery(PHARMACY, []).params[1]).toEqual(STOCK_ALERT_KINDS);
  });

  it('treats an empty product scope as no narrowing', () => {
    expect(buildLiveAlertQuery(PHARMACY, []).text).toContain('cardinality($3::text[]) = 0');
  });

  it('inlines as SQL with nothing left to bind', () => {
    const sql = inlineParams(
      buildLiveAlertQuery(PHARMACY, ['inv-1'], ['low_stock', 'expiring']),
      LIVE_TYPES
    );
    expect(sql).not.toMatch(/\$\d/);
    expect(sql).toContain(`ARRAY['low_stock'::text, 'expiring'::text]::text[]`);
  });
});

describe('buildAlertInsert', () => {
  const low = classifyStock(state({ inventoryId: 'inv-1', quantity: 5 }), TODAY)[0];
  const soon = classifyStock(
    state({ inventoryId: 'inv-2', quantity: 50, expiryDate: '2026-04-15' }),
    TODAY
  )[0];

  it('writes nothing when there is nothing to say', () => {
    expect(buildAlertInsert(PHARMACY, [])).toBeNull();
  });

  it('binds exactly the parameters it placeholds, for one alert and for several', () => {
    for (const alerts of [[low], [low, soon], [low, soon, low]]) {
      expectBound(buildAlertInsert(PHARMACY, alerts) as BuiltQuery);
    }
  });

  it('shares $1 across the rows and numbers the rest four at a time', () => {
    const query = buildAlertInsert(PHARMACY, [low, soon]) as BuiltQuery;
    // 1 pharmacy + 4 per alert. Hand-numbered, so this is the assertion that
    // catches an off-by-one that would put one alert's message on another's key.
    expect(query.params).toHaveLength(9);
    expect(placeholders(query.text).filter((n) => n === 1)).toHaveLength(2);
    expect([...new Set(placeholders(query.text))].sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
  });

  it('puts each alert under its own key and its own message', () => {
    const query = buildAlertInsert(PHARMACY, [low, soon]) as BuiltQuery;
    expect(query.params).toEqual([
      PHARMACY,
      low.title,
      low.message,
      low.dedupeKey,
      JSON.stringify(low.metadata),
      soon.title,
      soon.message,
      soon.dedupeKey,
      JSON.stringify(soon.metadata),
    ]);
  });

  it('binds the metadata as a JSON string, because the column is jsonb', () => {
    const query = buildAlertInsert(PHARMACY, [low]) as BuiltQuery;
    const metadata = query.params[4];
    expect(typeof metadata).toBe('string');
    expect(JSON.parse(metadata as string)).toEqual(low.metadata);
  });

  it('names the partial index predicate exactly, or ON CONFLICT will not resolve', () => {
    const text = (buildAlertInsert(PHARMACY, [low]) as BuiltQuery).text;
    expect(text).toContain('ON CONFLICT (pharmacy_id, dedupe_key)');
    expect(text).toContain('WHERE dedupe_key IS NOT NULL AND superseded_at IS NULL');
  });

  it('does nothing on a conflict rather than updating, so an alert keeps the date it started', () => {
    const text = (buildAlertInsert(PHARMACY, [low]) as BuiltQuery).text;
    expect(text).toContain('DO NOTHING');
    expect(text).not.toContain('DO UPDATE');
  });

  it('inlines as SQL with nothing left to bind', () => {
    const types = ['uuid', 'text', 'text', 'text', 'jsonb', 'text', 'text', 'text', 'jsonb'];
    const sql = inlineParams(buildAlertInsert(PHARMACY, [low, soon]) as BuiltQuery, types);
    expect(sql).not.toMatch(/\$\d/);
    expect(sql).toContain(`'{"inventory_id":"inv-1"`);
  });
});

describe('buildSupersedeQuery', () => {
  it('writes nothing when there is nothing to clear', () => {
    expect(buildSupersedeQuery(PHARMACY, [])).toBeNull();
  });

  it('binds exactly the parameters it placeholds', () => {
    expectBound(buildSupersedeQuery(PHARMACY, ['n-1', 'n-2']) as BuiltQuery);
  });

  it('releases the key without deleting the row', () => {
    const text = (buildSupersedeQuery(PHARMACY, ['n-1']) as BuiltQuery).text;
    expect(text).toContain('superseded_at = NOW()');
    expect(text).not.toMatch(/DELETE/i);
    // The history is the point: how often a product goes low is the difference
    // between a reorder and a supplier problem.
    expect(text).toContain('UPDATE notifications');
  });

  it('only touches alerts that are still live', () => {
    const text = (buildSupersedeQuery(PHARMACY, ['n-1']) as BuiltQuery).text;
    expect(text).toContain('superseded_at IS NULL');
  });

  it('is scoped to the pharmacy and to the ids it was given', () => {
    const query = buildSupersedeQuery(PHARMACY, ['n-1', 'n-2']) as BuiltQuery;
    expect(query.text).toContain('pharmacy_id = $1');
    expect(query.text).toContain('id = ANY($2::uuid[])');
    expect(query.params[1]).toEqual(['n-1', 'n-2']);
  });
});

// ---------------------------------------------------------------------------
// The refresh
// ---------------------------------------------------------------------------

interface Scenario {
  stock?: StockRow[];
  live?: Array<{ id: string; dedupe_key: string }>;
  /** What the INSERT reports having written. Defaults to everything asked for. */
  insertRowCount?: number;
  /** How many of the two alert columns the schema probe finds. Defaults to both. */
  dedupeColumns?: number;
  /** Makes the INSERT fail, which is what a missing column or a deadlock looks like. */
  insertError?: string;
}

class FakeClient implements Queryable {
  readonly calls: Array<{ text: string; params: unknown[] }> = [];

  constructor(
    private readonly respond: (call: { text: string; params: unknown[] }) => {
      rows?: unknown[];
      rowCount?: number;
    }
  ) {}

  async query(text: string, params?: unknown[]) {
    const call = { text, params: params ?? [] };
    this.calls.push(call);
    const result = this.respond(call);
    return { rows: result.rows ?? [], rowCount: result.rowCount ?? 0 } as never;
  }
}

function clientFor(scenario: Scenario): FakeClient {
  return new FakeClient((call) => {
    // First, because it is the only query sent when the columns are missing —
    // and the point of that case is that nothing after it runs.
    if (call.text.includes('information_schema.columns')) {
      return { rows: [{ columns_found: scenario.dedupeColumns ?? 2 }] };
    }
    if (call.text.includes('FROM inventory')) return { rows: scenario.stock ?? [] };
    if (call.text.includes('FROM notifications')) return { rows: scenario.live ?? [] };
    if (call.text.includes('INSERT INTO notifications')) {
      if (scenario.insertError) throw new Error(scenario.insertError);
      // Four parameters per alert after the shared pharmacy id.
      return { rowCount: scenario.insertRowCount ?? (call.params.length - 1) / 4 };
    }
    if (call.text.includes('UPDATE notifications')) {
      return { rowCount: (call.params[1] as string[]).length };
    }
    throw new Error(`the refresh sent a query this test did not expect: ${call.text.slice(0, 90)}`);
  });
}

const sent = (client: FakeClient) =>
  client.calls.map((call) => {
    if (call.text.includes('information_schema.columns')) return 'probe';
    if (call.text.includes('FROM inventory')) return 'stock';
    if (call.text.includes('INSERT INTO notifications')) return 'insert';
    if (call.text.includes('UPDATE notifications')) return 'supersede';
    return 'live';
  });

/** Everything after the schema probe, which every case sends and none is about. */
const wrote = (client: FakeClient) => sent(client).filter((step) => step !== 'probe');

describe('refreshStockAlerts', () => {
  // The probe caches a positive answer for the process. Without this reset the
  // first test would send it and every later one would not, so the query
  // sequence asserted below would depend on the order jest happened to run in.
  beforeEach(resetAlertDedupeProbe);

  it('reads the shelf before it reads the alerts, and writes after both', async () => {
    const client = clientFor({
      stock: [shelfRow({ id: 'inv-1', quantity: 5, reorder_level: 15 })],
    });
    await refreshStockAlerts(client, PHARMACY, { today: TODAY });
    expect(wrote(client)).toEqual(['stock', 'live', 'insert']);
  });

  it('raises an alert the shelf needs and the table does not have', async () => {
    const client = clientFor({
      stock: [shelfRow({ id: 'inv-1', quantity: 5, reorder_level: 15 })],
    });
    const result = await refreshStockAlerts(client, PHARMACY, { today: TODAY });

    expect(result).toEqual({ checked: 1, raised: 1, superseded: 0, live: 1 });
    const insert = client.calls.find((call) => call.text.includes('INSERT INTO notifications'));
    expect(insert?.params[3]).toBe(alertKey('low_stock', 'inv-1'));
  });

  it('does not raise one that is already live', async () => {
    const client = clientFor({
      stock: [shelfRow({ id: 'inv-1', quantity: 5, reorder_level: 15 })],
      live: [{ id: 'n-1', dedupe_key: alertKey('low_stock', 'inv-1') }],
    });
    const result = await refreshStockAlerts(client, PHARMACY, { today: TODAY });

    // This is the whole point of the dedupe key. Without it the pharmacist gets
    // the same notification every time anybody opens the bell.
    expect(result).toEqual({ checked: 1, raised: 0, superseded: 0, live: 1 });
    expect(wrote(client)).toEqual(['stock', 'live']);
  });

  it('supersedes a live alert the shelf no longer needs', async () => {
    const client = clientFor({
      stock: [shelfRow({ id: 'inv-1', quantity: 100, reorder_level: 15 })],
      live: [{ id: 'n-1', dedupe_key: alertKey('low_stock', 'inv-1') }],
    });
    const result = await refreshStockAlerts(client, PHARMACY, { today: TODAY });

    expect(result).toEqual({ checked: 1, raised: 0, superseded: 1, live: 0 });
    const supersede = client.calls.find((call) => call.text.includes('UPDATE notifications'));
    expect(supersede?.params[1]).toEqual(['n-1']);
  });

  it('sends nothing at all when the table already agrees with the shelf', async () => {
    const client = clientFor({ stock: [shelfRow({ id: 'inv-1', quantity: 100 })] });
    const result = await refreshStockAlerts(client, PHARMACY, { today: TODAY });

    expect(result).toEqual({ checked: 1, raised: 0, superseded: 0, live: 0 });
    expect(wrote(client)).toEqual(['stock', 'live']);
  });

  it('reports what it wrote separately from what is now true', async () => {
    // Two tills finishing sales at the same moment both try to raise the same
    // alert. ON CONFLICT DO NOTHING makes the loser write nothing, so `raised`
    // has to come from rowCount rather than from the length of what was asked
    // for — and `live` has to count the alerts anyway, because the other
    // transaction did write them.
    const client = clientFor({
      stock: [
        shelfRow({ id: 'inv-1', quantity: 5, reorder_level: 15 }),
        shelfRow({ id: 'inv-2', quantity: 0, reorder_level: 15 }),
      ],
      live: [],
      insertRowCount: 0,
    });
    const result = await refreshStockAlerts(client, PHARMACY, { today: TODAY });

    expect(result.raised).toBe(0);
    expect(result.live).toBe(2);
    expect(wrote(client)).toEqual(['stock', 'live', 'insert']);
  });

  it('scopes the read to the products it was given', async () => {
    const client = clientFor({ stock: [] });
    await refreshStockAlerts(client, PHARMACY, { inventoryIds: ['inv-7'], today: TODAY });

    const stock = client.calls.find((call) => call.text.includes('FROM inventory'));
    expect(stock?.params[1]).toEqual(['inv-7']);
    // The live read has to be scoped the same way, or a refresh after one sale
    // would supersede every alert for a product it never looked at.
    const live = client.calls.find((call) => call.text.includes('FROM notifications'));
    expect(live?.params[2]).toEqual(['inv-7']);
  });

  it('reads the whole pharmacy when no scope is given', async () => {
    const client = clientFor({ stock: [] });
    await refreshStockAlerts(client, PHARMACY, { today: TODAY });

    const stock = client.calls.find((call) => call.text.includes('FROM inventory'));
    expect(stock?.params[1]).toEqual([]);
    const live = client.calls.find((call) => call.text.includes('FROM notifications'));
    expect(live?.params[2]).toEqual([]);
  });

  it('clears a retired product rather than leaving its old alerts live', async () => {
    const client = clientFor({
      stock: [shelfRow({ id: 'inv-1', quantity: 0, is_active: false })],
      live: [{ id: 'n-1', dedupe_key: alertKey('out_of_stock', 'inv-1') }],
    });
    const result = await refreshStockAlerts(client, PHARMACY, { today: TODAY });
    expect(result.superseded).toBe(1);
  });

  it('never sends a query with a parameter it did not bind', async () => {
    const client = clientFor({
      stock: [
        shelfRow({ id: 'inv-1', quantity: 5, reorder_level: 15 }),
        shelfRow({ id: 'inv-2', quantity: 50, expiry_date: '2026-02-28' }),
      ],
      live: [{ id: 'n-9', dedupe_key: alertKey('expiring', 'inv-3') }],
    });
    await refreshStockAlerts(client, PHARMACY, { today: TODAY });

    // Every query this module sends is built, including the probe, so every one
    // of them is bound. A parameter pushed and not read is as much a defect as
    // one read and not pushed.
    expect(client.calls.length).toBeGreaterThanOrEqual(4);
    for (const call of client.calls) {
      expectBound({ text: call.text, params: call.params });
    }
  });

  it('passes the horizon through to the classifier', async () => {
    const client = clientFor({
      stock: [shelfRow({ id: 'inv-1', quantity: 50, expiry_date: '2026-05-31' })],
    });
    const result = await refreshStockAlerts(client, PHARMACY, {
      today: TODAY,
      expiringDays: 120,
    });
    expect(result.raised).toBe(1);
  });

  it('leaves the transaction to its caller', async () => {
    // The signature takes a Queryable rather than a pool. A refresh that opened
    // or closed its own transaction would commit a half-finished sale, and one
    // that ran after a rolled-back sale would announce stock that never left.
    const client = clientFor({ stock: [shelfRow({ id: 'inv-1', quantity: 5 })] });
    await refreshStockAlerts(client, PHARMACY, { today: TODAY });

    expect(client.calls.length).toBeGreaterThan(0);
    for (const call of client.calls) {
      expect(call.text).not.toMatch(/\b(BEGIN|COMMIT|ROLLBACK)\b/i);
    }
  });
});

// ---------------------------------------------------------------------------
// A schema that does not have the alert columns
// ---------------------------------------------------------------------------

describe('hasAlertDedupe', () => {
  beforeEach(resetAlertDedupeProbe);

  it('asks the schema once and then remembers the answer', async () => {
    const client = clientFor({ stock: [shelfRow({ id: 'inv-1', quantity: 5 })] });

    await refreshStockAlerts(client, PHARMACY, { today: TODAY });
    await refreshStockAlerts(client, PHARMACY, { today: TODAY });

    // Caching the positive is what keeps a per-sale probe from being a second
    // query on every sale. Caching the negative would be the bug — applying 003
    // would then need a restart before the bell worked.
    expect(sent(client).filter((step) => step === 'probe')).toEqual(['probe']);
  });

  it('counts both columns, not whichever one it finds first', async () => {
    const one = clientFor({ dedupeColumns: 1 });
    await expect(hasAlertDedupe(one)).resolves.toBe(false);

    resetAlertDedupeProbe();
    const both = clientFor({ dedupeColumns: 2 });
    await expect(hasAlertDedupe(both)).resolves.toBe(true);
  });

  it('looks in the schema the rest of the module writes to', async () => {
    const client = clientFor({});
    await hasAlertDedupe(client);
    // Unqualified `notifications` resolves through the search path, so a probe
    // that counted columns in every schema would answer yes for a table this
    // module cannot reach.
    expect(client.calls[0].text).toContain('table_schema = current_schema()');
  });
});

describe('refreshStockAlerts against a schema without 003', () => {
  beforeEach(resetAlertDedupeProbe);

  it('says so rather than reporting an empty shelf', async () => {
    const client = clientFor({ dedupeColumns: 0 });
    await expect(refreshStockAlerts(client, PHARMACY, { today: TODAY })).rejects.toBeInstanceOf(
      StockAlertsUnavailable
    );
  });

  it('stops at the probe instead of failing later on a missing column', async () => {
    const client = clientFor({ dedupeColumns: 0 });
    await refreshStockAlerts(client, PHARMACY, { today: TODAY }).catch(() => undefined);

    // Had it gone on, the INSERT would have failed with `column "dedupe_key"
    // does not exist` — true, but reported against somebody's sale.
    expect(sent(client)).toEqual(['probe']);
  });

  it('names the migration to run', async () => {
    const client = clientFor({ dedupeColumns: 0 });
    const error = await refreshStockAlerts(client, PHARMACY, { today: TODAY }).catch(
      (caught: unknown) => caught
    );
    expect((error as StockAlertsUnavailable).message).toContain('003_inventory_batches.sql');
    expect((error as StockAlertsUnavailable).statusCode).toBe(501);
  });
});

// ---------------------------------------------------------------------------
// What the nine mutation sites actually call
// ---------------------------------------------------------------------------

describe('refreshStockAlertsFor', () => {
  beforeEach(resetAlertDedupeProbe);

  it('drops the ids that are not there before asking anything', async () => {
    const client = clientFor({ stock: [] });
    // A basket can carry the same product twice, and a line rung up without a
    // catalogue entry has no inventory id at all.
    await refreshStockAlertsFor(client, PHARMACY, ['inv-1', null, 'inv-1', undefined], 'test');

    const stock = client.calls.find((call) => call.text.includes('FROM inventory'));
    expect(stock?.params[1]).toEqual(['inv-1']);
  });

  it('sends no query at all for a sale with nothing to check', async () => {
    const client = clientFor({ stock: [] });
    await refreshStockAlertsFor(client, PHARMACY, [null, undefined], 'pos.sale');
    expect(client.calls).toEqual([]);
  });

  it('does not let a notification failure take the sale with it', async () => {
    // The whole reason this runs after the commit. A cashier who cannot finish
    // a sale because a bell would not update has been failed by the bell.
    const failing = clientFor({
      stock: [shelfRow({ id: 'inv-1', quantity: 0 })],
      insertError: 'deadlock detected',
    });
    await expect(
      refreshStockAlertsFor(failing, PHARMACY, ['inv-1'], 'pos.sale')
    ).resolves.toBeUndefined();

    // Proving the swallow lives in the wrapper and not in a test that could
    // never fail: the same client, called directly, does reject.
    resetAlertDedupeProbe();
    const same = clientFor({
      stock: [shelfRow({ id: 'inv-1', quantity: 0 })],
      insertError: 'deadlock detected',
    });
    await expect(refreshStockAlerts(same, PHARMACY, { today: TODAY })).rejects.toThrow(
      'deadlock detected'
    );
  });

  it('stays quiet when the columns are not installed', async () => {
    // The probe has already logged what to run. Warning again on every sale
    // would bury the one log line that matters — a refresh that should have
    // worked and did not.
    const client = clientFor({ dedupeColumns: 0, stock: [] });
    await expect(
      refreshStockAlertsFor(client, PHARMACY, ['inv-1'], 'pos.sale')
    ).resolves.toBeUndefined();
    expect(sent(client)).toEqual(['probe']);
  });
});
