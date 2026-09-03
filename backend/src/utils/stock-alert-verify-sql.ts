import fs from 'fs';
import path from 'path';
import {
  ALERT_DEDUPE_COLUMNS,
  STOCK_ALERT_KINDS,
  alertKey,
  buildAlertInsert,
  buildLiveAlertQuery,
  buildSchemaProbeQuery,
  buildStockStateQuery,
  buildSupersedeQuery,
  classifyStock,
  type StockAlert,
  type StockAlertKind,
  type StockState,
} from './stock-alerts';
import {
  buildMarkReadQuery,
  buildNotificationCountQuery,
  buildNotificationFeedQuery,
} from './notification-queries';
import { inlineParams, toLiteral, type BuiltQuery } from './sql-literal';
import { Harness } from './verify-harness';

/**
 * Renders database/tests/005_stock_alerts_verify.sql.
 *
 * Covers both halves of the notifications work: the writer in stock-alerts.ts
 * and the reader in notification-queries.ts. One file rather than two because
 * the reader's assertions are only meaningful against rows the writer has just
 * written, and a second harness would have to recreate the same shelf to prove
 * a filter.
 *
 * The alert writer's SQL has three parts that a type checker cannot reach, and
 * all three fail at runtime rather than at build time:
 *
 *   * `ON CONFLICT … WHERE dedupe_key IS NOT NULL AND superseded_at IS NULL`
 *     has to repeat the partial index's predicate exactly. One word out and
 *     Postgres refuses the statement outright — on the sale that triggered it.
 *   * `split_part(dedupe_key, ':', 1) = ANY(…)` is the only thing standing
 *     between a stock refresh and another feature's notifications.
 *   * An empty array parameter has to read as "no narrowing" rather than
 *     "nothing matches", which is a `cardinality` test that is easy to invert.
 *   * The schema probe's `table_schema = current_schema()` has to agree with
 *     where an unqualified `notifications` actually resolves. Get it wrong and
 *     every pharmacy answers "not installed" forever, the bell shows nothing,
 *     and nothing anywhere logs an error — the quietest failure in the module.
 *
 * The reader's are quieter still, because none of them can fail loudly at all:
 *
 *   * `(NOT $3::boolean OR read_at IS NULL)` inverts to a bell that is always
 *     full or always empty, and both look like a pharmacy with no problems.
 *   * `LIMIT` that did not apply is a slow dropdown, not an error.
 *   * A count taken from the limited list rather than its own query understates
 *     the badge, so a pharmacy with sixty low products is told it has twenty.
 *   * `read_at = NOW()` without the `IS NULL` guard silently turns "when this
 *     was first seen" into "when somebody last clicked the bell".
 *
 * So the SQL is rendered from the builders and run against a real Postgres, the
 * same way 004_recall_verify.sql is.
 *
 *   cd backend && npm run alerts:emit
 */

/**
 * Resolved from __dirname rather than the working directory, so it lands in the
 * same place whether this runs from src under ts-node, from dist after a build,
 * or from jest with a different working directory.
 */
export const STOCK_ALERT_VERIFY_PATH = path.resolve(
  __dirname,
  '../../../database/tests/005_stock_alerts_verify.sql'
);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PHARMACY = '11111111-1111-1111-1111-111111111112';
/** A second branch, to prove the dedupe is per pharmacy rather than global. */
const SISTER = '11111111-1111-1111-1111-111111111113';

/**
 * A fixed date rather than `todayInGhana()`.
 *
 * The classifier's date arithmetic is TypeScript and is tested in jest; what
 * this file proves is that the SQL runs and dedupes. Rendering against the real
 * current date would make the generated file differ every morning, so the
 * staleness test would fail daily while testing exactly the same SQL.
 */
const TODAY = '2026-03-01';

const id = (suffix: string) => `a1000000-0000-0000-0000-0000000000${suffix}`;

const LOW = id('01');
const OUT = id('02');
const NEG = id('03');
const EXPIRED = id('04');
const SOON = id('05');
const BOTH = id('06');
const FINE = id('07');
const RETIRED = id('08');

interface Fixture {
  code: string;
  unitPrice: number;
  state: StockState;
  /** Printed into the file, so the shelf says why each row is there. */
  why: string;
}

/**
 * One product per branch of `classifyStock`, plus the two that must stay quiet.
 *
 * The names and dates are chosen so the fixture also exercises the escaping:
 * one product has an apostrophe in its name, which reaches the SQL twice — once
 * as a quoted literal and once inside a jsonb document, where the escaping rules
 * are not the same.
 */
const SHELF: Fixture[] = [
  {
    code: 'AL-240',
    unitPrice: 32.5,
    why: 'below its reorder level with the expiry far off — one low-stock alert and nothing else',
    state: {
      inventoryId: LOW,
      productName: 'Artemether/Lumefantrine 20/120',
      quantity: 5,
      reorderLevel: 15,
      expiryDate: '2027-01-10',
      batchNumber: 'AL-2401',
      isActive: true,
    },
  },
  {
    code: 'INS-100',
    unitPrice: 210.0,
    why: 'at zero — out of stock, and the early return means no expiry alert is stacked on it',
    state: {
      inventoryId: OUT,
      productName: 'Insulin Glargine 100IU/mL',
      quantity: 0,
      reorderLevel: 10,
      expiryDate: '2027-01-10',
      batchNumber: 'INS-88',
      isActive: true,
    },
  },
  {
    code: 'ORS-CH',
    unitPrice: 4.5,
    why: 'below zero, which is a stock-take rather than an order — and an apostrophe to escape',
    state: {
      inventoryId: NEG,
      productName: "ORS Sachets (children's)",
      quantity: -3,
      reorderLevel: 20,
      expiryDate: '2027-08-01',
      batchNumber: null,
      isActive: true,
    },
  },
  {
    code: 'TET-250',
    unitPrice: 8.0,
    why: 'past its date but above its reorder level — expired only, never also expiring',
    state: {
      inventoryId: EXPIRED,
      productName: 'Tetracycline 250mg',
      quantity: 4,
      reorderLevel: 2,
      expiryDate: '2026-02-20',
      batchNumber: 'TET-11',
      isActive: true,
    },
  },
  {
    code: 'OXY-10',
    unitPrice: 45.0,
    why: 'well stocked but 45 days from its date — expiring, with no order implied',
    state: {
      inventoryId: SOON,
      productName: 'Oxytocin 10IU/mL',
      quantity: 30,
      reorderLevel: 10,
      expiryDate: '2026-04-15',
      batchNumber: 'OXY-3',
      isActive: true,
    },
  },
  {
    code: 'ADR-1',
    unitPrice: 15.75,
    why: 'low AND 80 days out — two alerts for one product, because they are two different jobs',
    state: {
      inventoryId: BOTH,
      productName: 'Adrenaline 1mg/mL',
      quantity: 3,
      reorderLevel: 10,
      expiryDate: '2026-05-20',
      batchNumber: 'ADR-7',
      isActive: true,
    },
  },
  {
    code: 'PAR-500',
    unitPrice: 9.0,
    why: 'stocked and far from its date — the product that must never appear in the bell',
    state: {
      inventoryId: FINE,
      productName: 'Paracetamol 500mg',
      quantity: 100,
      reorderLevel: 10,
      expiryDate: '2027-06-01',
      batchNumber: 'PAR-500',
      isActive: true,
    },
  },
  {
    code: 'OLD-1',
    unitPrice: 6.0,
    why: 'retired — raises nothing, which is how deactivating a product clears its alerts',
    state: {
      inventoryId: RETIRED,
      productName: 'Withdrawn Product',
      quantity: 0,
      reorderLevel: 10,
      expiryDate: '2026-01-01',
      batchNumber: 'OLD-1',
      isActive: false,
    },
  },
];

/**
 * The alerts the shelf produces, derived by calling the real classifier rather
 * than by writing them out. A hand-written list here would be a second opinion
 * about what the code does, and the two would drift.
 */
const ALERTS: StockAlert[] = SHELF.flatMap((fixture) => classifyStock(fixture.state, TODAY));

/**
 * How many alerts of one kind the shelf produces.
 *
 * Counted from `ALERTS` rather than written down, for the reason `ALERTS` itself
 * is derived: a number typed here is a second opinion about what the classifier
 * does, and the harness would keep passing after the classifier changed.
 */
const countKind = (kind: StockAlertKind) =>
  ALERTS.filter((alert) => alert.kind === kind).length;

/**
 * The notification a different feature writes, inserted partway through.
 *
 * It shares the table and the dedupe_key column, so it is what proves the kind
 * filter is a filter rather than a coincidence — and that the reader can be
 * asked for a kind this module does not own.
 */
const CLAIM_KIND = 'claim_rejected';
const CLAIM_KEY = `${CLAIM_KIND}:${id('99')}`;
/** Live notifications for the pharmacy once everything has been written. */
const LIVE_TOTAL = ALERTS.length + 1;

const LOW_STOCK_ALERT = ALERTS.find(
  (alert) => alert.dedupeKey === alertKey('low_stock', LOW)
) as StockAlert;
const NEG_ALERT = ALERTS.find(
  (alert) => alert.dedupeKey === alertKey('out_of_stock', NEG)
) as StockAlert;
const SOON_ALERT = ALERTS.find(
  (alert) => alert.dedupeKey === alertKey('expiring', SOON)
) as StockAlert;

// ---------------------------------------------------------------------------
// Parameter inlining
// ---------------------------------------------------------------------------

const STOCK_TYPES = ['uuid', 'uuid[]'];
const LIVE_TYPES = ['uuid', 'text[]', 'text[]'];
const SUPERSEDE_TYPES = ['uuid', 'uuid[]'];
const PROBE_TYPES = ['text[]'];
const FEED_TYPES = ['uuid', 'text[]', 'boolean', 'integer'];
const COUNT_TYPES = ['uuid', 'text[]'];
const READ_TYPES = ['uuid', 'text[]', 'uuid[]'];

/**
 * Columns the probe is asked about that 003 does not add.
 *
 * A probe that answered "installed" no matter what it was asked would pass the
 * assertion that matters and still be useless, so it is also asked about a
 * column that does not exist — both alone and alongside a real one.
 */
const ABSENT_COLUMN = 'no_such_column_005';

/** $1 is the pharmacy, then four per alert: title, message, key, metadata. */
function insertTypes(alerts: StockAlert[]): string[] {
  return ['uuid', ...alerts.flatMap(() => ['text', 'text', 'text', 'jsonb'])];
}

/**
 * The supersede needs the id of a row the harness has just inserted, and that id
 * is `uuid_generate_v4()` — unknown at render time.
 *
 * Same answer as the recall window: bind a sentinel and swap the literal it
 * renders to for a subquery that finds the row. The builder's own SQL text is
 * still what runs, which is the point.
 */
const SUPERSEDE_SENTINEL = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
const SUPERSEDE_TARGET_SQL = `(SELECT id FROM notifications
             WHERE pharmacy_id = ${toLiteral(PHARMACY, 'uuid')}
               AND dedupe_key = ${toLiteral(alertKey('low_stock', LOW), 'text')}
               AND superseded_at IS NULL)`;

/**
 * The same problem again for the reader: clearing one alert by id needs an id
 * that only exists once the harness has run.
 *
 * A different sentinel from the supersede's, so a substitution that silently
 * missed one of them cannot be masked by the other having worked. The target is
 * an out-of-stock alert, deliberately not a low-stock one — the low-stock kind
 * has already been cleared by then, and marking an already-read row would stamp
 * nothing and prove nothing.
 */
const MARK_READ_SENTINEL = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const MARK_READ_TARGET_SQL = `(SELECT id FROM notifications
             WHERE pharmacy_id = ${toLiteral(PHARMACY, 'uuid')}
               AND dedupe_key = ${toLiteral(alertKey('out_of_stock', OUT), 'text')}
               AND superseded_at IS NULL)`;

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function view(name: string, query: BuiltQuery, types: string[], comment: string): string {
  return `
-- ${comment}
CREATE TEMP VIEW ${name} AS
${inlineParams(query, types)};
`;
}

function fixtures(): string {
  const rows = SHELF.map(
    (fixture) => `  (${toLiteral(fixture.state.inventoryId, 'uuid')},
   ${toLiteral(PHARMACY, 'uuid')},
   ${toLiteral(fixture.state.productName, 'text')},
   ${toLiteral(fixture.code, 'text')},
   ${fixture.state.quantity}, ${fixture.unitPrice}, 0,
   ${toLiteral(fixture.state.expiryDate, 'date')},
   ${fixture.state.reorderLevel},
   ${toLiteral(fixture.state.batchNumber, 'text')},
   ${fixture.state.isActive})`
  );

  const shelf = SHELF.map(
    (fixture) => `--   ${fixture.code.padEnd(9)} ${fixture.state.productName}\n--             ${fixture.why}`
  ).join('\n');

  return `
-- ---------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------
INSERT INTO pharmacies (id, name, license_number, phone)
VALUES
  (${toLiteral(PHARMACY, 'uuid')}, 'Alert Test Pharmacy', 'LIC-VERIFY-005', '0240000005'),
  (${toLiteral(SISTER, 'uuid')}, 'Alert Test Pharmacy Ashaiman', 'LIC-VERIFY-006', '0240000006');

-- No batches for any of these, on purpose: the derived-stock trigger returns a
-- product unchanged when it has none, so the quantities below are exactly what
-- the classifier reads. Batch arithmetic is 003_verify.sql's subject.
--
-- The shelf, one product per branch of classifyStock:
${shelf}
INSERT INTO inventory (id, pharmacy_id, product_name, product_code, quantity,
                       unit_price, cost_price, expiry_date, reorder_level,
                       batch_number, is_active)
VALUES
${rows.join(',\n')};
`;
}

function alertsComment(): string {
  return ALERTS.map((alert) => `--   ${alert.dedupeKey}  (${alert.title})`).join('\n');
}

export function renderStockAlertVerifySql(): string {
  const h = new Harness();
  const sections: string[] = [];

  sections.push(`-- =====================================================================
-- Verification harness for the stock alerts and the notification reader
-- =====================================================================
-- GENERATED FILE — DO NOT EDIT BY HAND.
--
-- Rendered from backend/src/utils/stock-alerts.ts (the writer) and
-- backend/src/utils/notification-queries.ts (the reader) by
-- backend/src/utils/stock-alert-verify-sql.ts, so the SQL below is the string
-- the API actually sends, with its parameters inlined as typed literals.
-- Editing it by hand changes nothing; editing a builder and not regenerating
-- fails backend/src/__tests__/stock-alerts.test.ts.
--
--   cd backend && npm run alerts:emit
--   psql -v ON_ERROR_STOP=1 -d pharmacy -f 005_stock_alerts_verify.sql
--
-- Only the SQL is under test here. The wording of each alert and the date
-- arithmetic that decides whether one is due are TypeScript, and they are
-- tested in jest.
-- =====================================================================

\\set ON_ERROR_STOP on

BEGIN;
`);

  // The probe goes first because it is what decides whether the rest is
  // possible at all. Without 003 the fixture INSERT below still fails, but
  // "column dedupe_key does not exist" says less than "the probe found 0 of the
  // 2 columns it needs" — and the probe is what the API actually runs.
  sections.push(`
-- ---------------------------------------------------------------------
-- Whether the alert columns are installed
-- ---------------------------------------------------------------------
-- Read before anything is written, exactly as hasAlertDedupe does it.
${view(
    'probe_both',
    buildSchemaProbeQuery(),
    PROBE_TYPES,
    'The real question: are both columns 003 adds there to be written to?'
  )}
${view(
    'probe_one',
    buildSchemaProbeQuery(['dedupe_key']),
    PROBE_TYPES,
    'Asked about one real column.'
  )}
${view(
    'probe_half',
    buildSchemaProbeQuery(['dedupe_key', ABSENT_COLUMN]),
    PROBE_TYPES,
    'Asked about one real column and one that does not exist. A migration\n-- half-applied must not read as installed, and a name that matches nothing\n-- must not raise.'
  )}
${view(
    'probe_absent',
    buildSchemaProbeQuery([ABSENT_COLUMN]),
    PROBE_TYPES,
    'Asked about a column that does not exist at all, which is the control\n-- that makes the three counts above mean something.'
  )}`);

  sections.push(
    h.expectNumber(
      'probe_both',
      'MAX(columns_found)',
      ALERT_DEDUPE_COLUMNS.length,
      'the probe finds both columns 003 adds, in the schema the module writes to'
    )
  );
  sections.push(
    h.expectNumber(
      'probe_one',
      'MAX(columns_found)',
      1,
      'and counts the columns rather than detecting any'
    )
  );
  sections.push(
    h.expectNumber(
      'probe_half',
      'MAX(columns_found)',
      1,
      'a column that does not exist is not counted, so a half-applied 003 reads as missing'
    )
  );
  sections.push(
    h.expectNumber(
      'probe_absent',
      'MAX(columns_found)',
      0,
      'and the count can be zero, so the assertion above is not satisfied by anything'
    )
  );

  sections.push(fixtures());

  const insert = buildAlertInsert(PHARMACY, ALERTS) as BuiltQuery;
  const insertSql = inlineParams(insert, insertTypes(ALERTS));

  sections.push(`
-- ---------------------------------------------------------------------
-- Writing them
-- ---------------------------------------------------------------------
-- One statement for the whole shelf, which is what the first refresh after the
-- migration looks like: every product already below its reorder level at once.
--
-- These two assertions are the reason the file exists. ON CONFLICT against a
-- partial index has to name the index predicate verbatim, and getting it wrong
-- is not a wrong answer but an error — raised on somebody's sale. If the first
-- of these runs at all, the inference matched.
--
-- What the classifier derived from that shelf:
${alertsComment()}`);

  sections.push(
    h.expectRowCount(
      `${insertSql};`,
      ALERTS.length,
      'the first refresh writes one notification per condition'
    )
  );

  sections.push(
    h.expectRowCount(
      `${insertSql};`,
      0,
      'a second till raising the same alerts writes nothing instead of failing'
    )
  );

  sections.push(`
-- ---------------------------------------------------------------------
-- Reading them back
-- ---------------------------------------------------------------------
-- Views rather than inline subqueries, so a failure names the read it was on.`);

  sections.push(
    view(
      'live_all',
      buildLiveAlertQuery(PHARMACY, []),
      LIVE_TYPES,
      'Every live stock alert for the pharmacy, with no narrowing at all. This\n-- is what the bell reads when it opens.'
    )
  );
  sections.push(
    view(
      'live_one_product',
      buildLiveAlertQuery(PHARMACY, [BOTH]),
      LIVE_TYPES,
      'Narrowed to one product, which is what a refresh after one sale reads.'
    )
  );
  sections.push(
    view(
      'live_expiring_only',
      buildLiveAlertQuery(PHARMACY, [], ['expiring']),
      LIVE_TYPES,
      'Narrowed to one kind. This is the scoping that keeps a stock refresh from\n-- superseding a claim or appointment notification sharing the table.'
    )
  );
  sections.push(
    view(
      'stock_all',
      buildStockStateQuery(PHARMACY, []),
      STOCK_TYPES,
      'The shelf itself. An empty scope has to mean every product, not none.'
    )
  );
  sections.push(
    view(
      'stock_two',
      buildStockStateQuery(PHARMACY, [LOW, FINE]),
      STOCK_TYPES,
      'The same read narrowed to two products.'
    )
  );
  // Not a builder's output: this is the harness's own question about whether a
  // superseded row is still there to be asked about.
  sections.push(`
-- One alert's whole history, superseded rows included. Deliberately not filtered
-- on superseded_at: keeping the row is the point of superseding rather than
-- deleting, and a view that hid them could not show it.
CREATE TEMP VIEW history_of_low_stock AS
SELECT id, superseded_at, created_at
  FROM notifications
 WHERE pharmacy_id = ${toLiteral(PHARMACY, 'uuid')}
   AND dedupe_key = ${toLiteral(alertKey('low_stock', LOW), 'text')};
`);

  sections.push(`
-- ---------------------------------------------------------------------
-- Assertions
-- ---------------------------------------------------------------------`);

  sections.push(h.expectRows('live_all', ALERTS.length, 'all seven conditions are live'));
  sections.push(
    h.expectRows(
      'live_one_product',
      2,
      'one product can carry a low-stock and an expiry alert at the same time'
    )
  );
  sections.push(h.expectRows('live_expiring_only', 2, 'and only the expiry kind is read back'));

  sections.push(
    h.expectText(
      'live_all',
      `MAX(message) FILTER (WHERE dedupe_key = ${toLiteral(NEG_ALERT.dedupeKey, 'text')})`,
      NEG_ALERT.message,
      'a message with an apostrophe and an em-dash comes back as it was written'
    )
  );
  sections.push(
    h.expectText(
      'live_all',
      `MAX(metadata->>'product_name') FILTER (WHERE dedupe_key = ${toLiteral(NEG_ALERT.dedupeKey, 'text')})`,
      NEG_ALERT.metadata.product_name as string,
      'and the jsonb document round-trips the same apostrophe'
    )
  );
  sections.push(
    h.expectNumber(
      'live_all',
      `MAX((metadata->>'days_to_expiry')::int) FILTER (WHERE dedupe_key = ${toLiteral(SOON_ALERT.dedupeKey, 'text')})`,
      45,
      'the metadata says how long there is, so the bell does not have to work it out'
    )
  );

  sections.push(
    h.expectNumber(
      'live_all',
      `COUNT(*) FILTER (WHERE split_part(dedupe_key, ':', 2) = ${toLiteral(RETIRED, 'text')})`,
      0,
      'a retired product raises nothing'
    )
  );
  sections.push(
    h.expectNumber(
      'live_all',
      `COUNT(*) FILTER (WHERE split_part(dedupe_key, ':', 2) = ${toLiteral(FINE, 'text')})`,
      0,
      'and neither does one that is stocked and far from its date'
    )
  );

  sections.push(h.expectRows('stock_all', SHELF.length, 'the shelf read returns every product'));
  sections.push(h.expectRows('stock_two', 2, 'and narrows to the two it was asked for'));
  sections.push(
    h.expectNumber('stock_two', `SUM(quantity)`, 105, 'with the quantities as they were inserted')
  );
  sections.push(
    h.expectText(
      'stock_two',
      `MAX(expiry_date)`,
      '2027-06-01',
      'and the expiry as the ISO text the classifier reads, not as a timestamp'
    )
  );

  // A notification another feature wrote, sharing the table and the column.
  sections.push(`
INSERT INTO notifications (pharmacy_id, type, title, message, channel, status, dedupe_key)
VALUES (${toLiteral(PHARMACY, 'uuid')}, 'in_app', 'Claim rejected',
        'NHIS claim 4471 was rejected: diagnosis code missing.', 'in_app', 'pending',
        ${toLiteral(CLAIM_KEY, 'text')});
`);
  sections.push(
    h.expectRows(
      'live_all',
      ALERTS.length,
      'a claim notification is not a stock alert, so the refresh cannot see or touch it'
    )
  );

  // Superseding, and what it does to the key.
  const supersede = buildSupersedeQuery(PHARMACY, [SUPERSEDE_SENTINEL]) as BuiltQuery;
  const supersedeLiteral = toLiteral(SUPERSEDE_SENTINEL, 'uuid');
  const supersedeSql = inlineParams(supersede, SUPERSEDE_TYPES).split(supersedeLiteral).join(SUPERSEDE_TARGET_SQL);
  if (supersedeSql.includes(SUPERSEDE_SENTINEL)) {
    throw new Error('the supersede sentinel survived substitution; the update would match nothing');
  }

  sections.push(
    h.expectRowCount(`${supersedeSql};`, 1, 'when the stock arrives the live alert is superseded')
  );
  sections.push(
    h.expectRows('live_all', ALERTS.length - 1, 'and stops being read back as live'))
  sections.push(
    h.expectRows(
      'history_of_low_stock',
      1,
      'but the row is kept, so there is a record that it happened'
    )
  );
  sections.push(
    h.expectRowCount(`${supersedeSql};`, 0, 'and an alert already released is not released twice')
  );

  const reraise = buildAlertInsert(PHARMACY, [LOW_STOCK_ALERT]) as BuiltQuery;
  const reraiseSql = inlineParams(reraise, insertTypes([LOW_STOCK_ALERT]));
  sections.push(
    h.expectRowCount(
      `${reraiseSql};`,
      1,
      'so when the product goes low again the pharmacist is told again'
    )
  );
  sections.push(h.expectRows('live_all', ALERTS.length, 'and the count is back to where it was'));
  sections.push(
    h.expectRows(
      'history_of_low_stock',
      2,
      'with the cleared one still beside the new one, which is the record of how often it happens'
    )
  );

  const sister = buildAlertInsert(SISTER, [LOW_STOCK_ALERT]) as BuiltQuery;
  const sisterSql = inlineParams(sister, insertTypes([LOW_STOCK_ALERT]));
  sections.push(
    h.expectRowCount(
      `${sisterSql};`,
      1,
      'the dedupe is per pharmacy, so a second branch can be low on the same thing'
    )
  );
  sections.push(
    h.expectRows(
      'live_all',
      ALERTS.length,
      'and the sister branch reading its own alert leaves this one alone'
    )
  );

  sections.push(readerSection(h));

  sections.push(`
ROLLBACK;

SELECT 'all stock-alert assertions passed' AS result;
`);

  return sections.join('\n');
}

/**
 * The reader, asserted last.
 *
 * Last because it reads what the writer left behind: seven live alerts, one of
 * them superseded and re-raised, plus the claim notification another feature
 * wrote into the same table. Views are live in Postgres rather than
 * materialised, so the mark-read updates below are visible to a view created
 * above them — which is what lets one `counts_all` view be asserted before and
 * after clearing the badge.
 */
function readerSection(h: Harness): string {
  const parts: string[] = [];

  parts.push(`
-- ---------------------------------------------------------------------
-- Reading them back for the bell
-- ---------------------------------------------------------------------
-- notification-queries.ts. The filters here cannot fail loudly: an inverted
-- unread test is a bell that is always full or always empty, and a LIMIT that
-- did not apply is only a slow dropdown.
${view(
    'feed_stock',
    buildNotificationFeedQuery(PHARMACY, { kinds: [...STOCK_ALERT_KINDS], limit: 20 }),
    FEED_TYPES,
    'Every live stock alert, which is what the bell lists.'
  )}
${view(
    'feed_everything',
    buildNotificationFeedQuery(PHARMACY, { limit: 20 }),
    FEED_TYPES,
    'No kind filter at all, so a notification this module does not own is\n-- included rather than quietly dropped.'
  )}
${view(
    'feed_low_stock',
    buildNotificationFeedQuery(PHARMACY, { kinds: ['low_stock'], limit: 20 }),
    FEED_TYPES,
    'Narrowed to one kind.'
  )}
${view(
    'feed_expiring',
    buildNotificationFeedQuery(PHARMACY, { kinds: ['expiring'], limit: 20 }),
    FEED_TYPES,
    'Narrowed to another, which overlaps the first on one product.'
  )}
${view(
    'feed_claim',
    buildNotificationFeedQuery(PHARMACY, { kinds: [CLAIM_KIND], limit: 20 }),
    FEED_TYPES,
    'Asked for a kind this module does not write. A reader hardcoded to the four\n-- stock kinds would return nothing here and the claim feature would have to\n-- duplicate the query.'
  )}
${view(
    'feed_limited',
    buildNotificationFeedQuery(PHARMACY, { kinds: [...STOCK_ALERT_KINDS], limit: 3 }),
    FEED_TYPES,
    'The same read with a limit smaller than the answer.'
  )}
${view(
    'feed_unread_low',
    buildNotificationFeedQuery(PHARMACY, { kinds: ['low_stock'], unread: true, limit: 20 }),
    FEED_TYPES,
    'Unread only. Read before and after the badge is cleared.'
  )}
${view(
    'counts_all',
    buildNotificationCountQuery(PHARMACY),
    COUNT_TYPES,
    'The badge in its own query, because the list above is limited and the\n-- badge must not be.'
  )}`);

  parts.push(
    h.expectRows(
      'feed_stock',
      ALERTS.length,
      'the bell reads back exactly the alerts the writer wrote'
    )
  );
  parts.push(
    h.expectRows(
      'feed_everything',
      LIVE_TOTAL,
      'and with no kind filter another feature\'s live notification is included'
    )
  );
  parts.push(
    h.expectRows('feed_low_stock', countKind('low_stock'), 'narrowing to one kind returns only it')
  );
  parts.push(
    h.expectRows(
      'feed_expiring',
      countKind('expiring'),
      'and to another, which is a different set overlapping on one product'
    )
  );
  parts.push(
    h.expectRows('feed_claim', 1, 'a kind this module does not own can still be asked for')
  );
  parts.push(
    h.expectRows('feed_limited', 3, 'the limit applies, so a long-neglected bell is not a slow one')
  );
  parts.push(
    h.expectNumber(
      'counts_all',
      'MAX(live)',
      LIVE_TOTAL,
      'and the count ignores the limit, so the badge says eight while the list shows three'
    )
  );
  parts.push(
    h.expectNumber('counts_all', 'MAX(unread)', LIVE_TOTAL, 'none of them having been opened yet')
  );
  // Asserted non-empty before it is asserted empty. Without this, a filter that
  // returned nothing at all — an inverted boolean, a kind spelled wrong — would
  // still satisfy the zero below.
  parts.push(
    h.expectRows(
      'feed_unread_low',
      countKind('low_stock'),
      'and an unread-only read of one kind returns that kind until it is cleared'
    )
  );
  parts.push(
    h.expectText(
      'feed_stock',
      `MAX(dedupe_kind) FILTER (WHERE dedupe_key = ${toLiteral(alertKey('low_stock', LOW), 'text')})`,
      'low_stock',
      'the kind is derived in SQL, so the writer\'s key and the reader\'s label cannot disagree'
    )
  );

  // Clearing one kind, by kind rather than by id — which is what "mark all read"
  // does when the bell is filtered.
  const clearLow = inlineParams(
    buildMarkReadQuery(PHARMACY, { kinds: ['low_stock'] }),
    READ_TYPES
  );
  parts.push(
    h.expectRowCount(
      `${clearLow};`,
      countKind('low_stock'),
      'clearing one kind stamps only that kind'
    )
  );
  parts.push(
    h.expectNumber(
      'counts_all',
      'MAX(unread)',
      LIVE_TOTAL - countKind('low_stock'),
      'and the unread count falls by the same number'
    )
  );
  parts.push(
    h.expectRows('feed_unread_low', 0, 'so an unread-only read of that kind is now empty')
  );
  parts.push(
    h.expectRowCount(
      `${clearLow};`,
      0,
      'already-read alerts are not stamped again, so read_at stays the moment it was first seen'
    )
  );

  // Clearing one alert by id needs an id the harness cannot know at render time,
  // so it is rendered against a sentinel and swapped for a subquery — the same
  // trick the supersede above uses.
  const readOne = buildMarkReadQuery(PHARMACY, {
    ids: [MARK_READ_SENTINEL],
  }) as BuiltQuery;
  const readOneSql = inlineParams(readOne, READ_TYPES)
    .split(toLiteral(MARK_READ_SENTINEL, 'uuid'))
    .join(MARK_READ_TARGET_SQL);
  if (readOneSql.includes(MARK_READ_SENTINEL)) {
    throw new Error(
      'the mark-read sentinel survived substitution; the update would match nothing'
    );
  }

  parts.push(
    h.expectRowCount(
      `${readOneSql};`,
      1,
      'and a single alert can be cleared on its own, which is what clicking it does'
    )
  );
  parts.push(
    h.expectNumber(
      'counts_all',
      'MAX(unread)',
      LIVE_TOTAL - countKind('low_stock') - 1,
      'taking the unread count down with it'
    )
  );
  parts.push(
    h.expectRows(
      'feed_stock',
      ALERTS.length,
      'but clearing an alert does not remove it — it is live until the stock arrives'
    )
  );

  return parts.join('\n');
}

export function writeStockAlertVerifySql(target: string = STOCK_ALERT_VERIFY_PATH): string {
  const sql = renderStockAlertVerifySql();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, sql, 'utf8');
  return sql;
}
