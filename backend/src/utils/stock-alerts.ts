import logger from './logger';
import { todayInGhana, toIsoDate } from './fefo';
import type { Queryable } from './batches';
import type { BuiltQuery } from './sql-literal';

export type { BuiltQuery };

/**
 * Turning stock state into alerts that survive being read.
 *
 * The bell used to call /inventory/low-stock every time it opened and build its
 * list from whatever came back. That is always current, and it has two costs
 * that only show up over weeks:
 *
 *   * Nothing is new. A product that fell below its reorder level a month ago
 *     is reported every single day, so it stops being read — and the one that
 *     fell this morning is buried in it.
 *   * Nothing is remembered. When the stock arrives the alert simply stops
 *     appearing, so there is no record that it happened, for how long, or
 *     whether it has happened three times this quarter.
 *
 * Migration 003 added `dedupe_key` and `superseded_at` for exactly this: one
 * live notification per product per condition, superseded when the condition
 * clears rather than deleted, so the history stays and the next time it happens
 * the pharmacist is told again.
 *
 * What is written here is deliberately phrased in the past tense — "fell to 5",
 * not "has 5 left". A live alert is not refreshed while it stays live, because
 * re-updating every open alert on every sale is a lot of writing to say nothing
 * new, and a message that claims to be current when it was written on Tuesday
 * is worse than one that plainly reports Tuesday.
 */

/**
 * How far ahead an expiry is worth raising.
 *
 * 90 rather than 30: it matches the notification setting's own wording
 * ("expiring within the next 90 days") and the till's `near_expiry` badge, so
 * the three surfaces agree about what "soon" means. A product a cashier can
 * already see flagged should not come as news in the bell a month later.
 */
export const EXPIRING_ALERT_DAYS = 90;

export type StockAlertKind = 'out_of_stock' | 'low_stock' | 'expired_stock' | 'expiring';

/** Every kind this module owns. Used to scope queries so alerts raised for
 *  another reason — a claim update, an appointment — are never touched. */
export const STOCK_ALERT_KINDS: StockAlertKind[] = [
  'out_of_stock',
  'low_stock',
  'expired_stock',
  'expiring',
];

/** One product's stock, as the derived-stock trigger last left it. */
export interface StockState {
  inventoryId: string;
  productName: string;
  quantity: number;
  reorderLevel: number;
  /** 'YYYY-MM-DD', or null when nothing on file is dated. */
  expiryDate: string | null;
  batchNumber: string | null;
  isActive: boolean;
}

/** The same row as Postgres returns it, before anything has been interpreted. */
export interface StockRow {
  id: string;
  product_name: string;
  quantity: number | string | null;
  reorder_level: number | string | null;
  batch_number: string | null;
  is_active: boolean | null;
  expiry_date: string | null;
}

export interface StockAlert {
  kind: StockAlertKind;
  dedupeKey: string;
  title: string;
  message: string;
  metadata: Record<string, unknown>;
}

export interface RefreshResult {
  /** Products whose state was read. */
  checked: number;
  /** Alerts this refresh wrote. Zero when another transaction wrote them first. */
  raised: number;
  superseded: number;
  /** Live stock alerts for the scope after the refresh, whoever wrote them. */
  live: number;
}

/**
 * Whether the alert columns are installed at all.
 *
 * Migration 003 adds `dedupe_key` and `superseded_at` to a table that exists
 * from init.sql onwards, so a pharmacy that has not applied it has a
 * `notifications` table that cannot hold a deduplicated alert. Without this the
 * first INSERT fails with `column "dedupe_key" does not exist` — on the sale
 * that caused it, which is the worst available moment.
 *
 * Mirrors `hasBatchTables` in batches.ts deliberately: same caching rule, same
 * log, because the two are read side by side and a difference in behaviour
 * between them would need explaining. Only a positive answer is remembered, so
 * applying 003 takes effect without a restart.
 *
 * Probed against information_schema rather than by catching the error, because
 * a failed statement aborts a Postgres transaction and every query after it
 * fails too. Scoped to `current_schema()` because that is where the unqualified
 * `notifications` in every query below actually resolves.
 */
let dedupeColumnsPresent: boolean | null = null;

/** The columns migration 003 adds, and the ones every query below assumes. */
export const ALERT_DEDUPE_COLUMNS = ['dedupe_key', 'superseded_at'];

/**
 * The schema probe, as a builder.
 *
 * Not inlined in `hasAlertDedupe` for the same reason the other four are not
 * inlined in `refreshStockAlerts`: the harness under database/tests can only
 * prove SQL a builder produces, and this is the query whose failure is quietest.
 * Get `current_schema()` wrong and every pharmacy answers "not installed"
 * forever, the bell shows nothing, and nothing in the logs looks like an error.
 *
 * The column list is a parameter so the harness can render the same builder
 * against a column that does not exist and prove the count is not always two.
 *
 * The result column is `columns_found` and not `found`, because every assertion
 * in the generated harness reads it from inside a plpgsql block — and `FOUND` is
 * a plpgsql built-in status variable, so an aggregate over a column called
 * `found` fails there with "column reference is ambiguous". Nothing in the API's
 * own path would notice: node-postgres runs the same SQL outside plpgsql, where
 * the name is unambiguous.
 */
export function buildSchemaProbeQuery(
  columns: readonly string[] = ALERT_DEDUPE_COLUMNS
): BuiltQuery {
  return {
    text: `
      SELECT COUNT(*)::int AS columns_found
        FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'notifications'
         AND column_name = ANY($1::text[])`,
    params: [columns as string[]],
  };
}

export async function hasAlertDedupe(client: Queryable): Promise<boolean> {
  if (dedupeColumnsPresent) return true;

  const probe = buildSchemaProbeQuery();
  const result = await client.query(probe.text, probe.params);
  // Compared against the length of the list rather than a literal 2, so adding a
  // column to the list is what changes the requirement.
  dedupeColumnsPresent = Number(result.rows[0]?.columns_found) === ALERT_DEDUPE_COLUMNS.length;

  if (!dedupeColumnsPresent) {
    logger.warn(
      'Stock alerts are not installed. Run database/migrations/003_inventory_batches.sql. ' +
        'Stock is still tracked correctly, but there is no reorder or expiry alert in the ' +
        'bell and nothing is remembered about a shortage after it ends.'
    );
  }

  return dedupeColumnsPresent;
}

/** Test hook: forgets the probe so a suite can change the schema underneath it. */
export function resetAlertDedupeProbe(): void {
  dedupeColumnsPresent = null;
}

/**
 * Raised when the alert columns are missing.
 *
 * An error rather than a zero-count result, because a refresh that returns
 * `live: 0` and one that could not look are the same object — and a bell that
 * shows nothing is believed. A route can turn this into 501 the way the recall
 * endpoints do; `refreshStockAlertsFor` swallows it, since a mutation site has
 * already been told once by the probe's own warning.
 */
export class StockAlertsUnavailable extends Error {
  readonly statusCode = 501;

  constructor() {
    super(
      'Stock alerts need migration 003_inventory_batches.sql, which adds ' +
        'notifications.dedupe_key and notifications.superseded_at.'
    );
    this.name = 'StockAlertsUnavailable';
  }
}

export function alertKey(kind: StockAlertKind, inventoryId: string): string {
  return `${kind}:${inventoryId}`;
}

/**
 * Reads the stock the alerts are derived from.
 *
 * A builder rather than a string inside `refreshStockAlerts`, because the
 * harness under database/tests can only prove SQL that a builder produces: an
 * inline query would be the one piece of this feature never run against a real
 * Postgres, and `cardinality($2::uuid[]) = 0` is exactly the kind of expression
 * that reads fine and behaves differently.
 */
export function buildStockStateQuery(pharmacyId: string, inventoryIds: string[]): BuiltQuery {
  return {
    // Empty scope means every product, so one static query covers both cases.
    text: `
      SELECT id, product_name, quantity, reorder_level, batch_number, is_active,
             to_char(expiry_date, 'YYYY-MM-DD') AS expiry_date
        FROM inventory
       WHERE pharmacy_id = $1
         AND (cardinality($2::uuid[]) = 0 OR id = ANY($2::uuid[]))`,
    params: [pharmacyId, inventoryIds],
  };
}

/**
 * Interprets one row.
 *
 * Exported beside the query that produces it so the two cannot drift: a column
 * renamed in the SELECT and not here reads as undefined, and `Number(undefined)
 * || 0` turns a missing quantity into zero — which classifies as out of stock
 * and pages the pharmacist about a product that is fine.
 */
export function toStockState(row: StockRow): StockState {
  return {
    inventoryId: row.id,
    productName: row.product_name,
    quantity: Number(row.quantity) || 0,
    reorderLevel: Number(row.reorder_level) || 0,
    expiryDate: toIsoDate(row.expiry_date),
    batchNumber: row.batch_number ?? null,
    isActive: row.is_active !== false,
  };
}

function utcDays(iso: string): number {
  const [year, month, day] = iso.split('-').map(Number);
  // Built in UTC and read back in UTC. Mixing a local constructor with an ISO
  // read is how a day goes missing near midnight.
  return Date.UTC(year, month - 1, day) / 86400000;
}

/** Whole days from one ISO date to another. Negative when `to` is earlier. */
export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round(utcDays(toIso) - utcDays(fromIso));
}

function metadataFor(state: StockState, today: string): Record<string, unknown> {
  return {
    inventory_id: state.inventoryId,
    product_name: state.productName,
    quantity: state.quantity,
    reorder_level: state.reorderLevel,
    batch_number: state.batchNumber,
    expiry_date: state.expiryDate,
    days_to_expiry: state.expiryDate ? daysBetween(today, state.expiryDate) : null,
    // So the bell can link somewhere useful and a future SMS worker can say
    // something specific without re-reading the product.
    href: '/inventory',
  };
}

/**
 * Which conditions hold for one product right now.
 *
 * Pure, and the reason any of this is testable without a database. The order of
 * the branches is the substance: out of stock returns early so a product at zero
 * raises one alert rather than three, and expired returns before expiring so a
 * lot cannot be reported as both "quarantine it" and "sell it soon".
 *
 * Low stock and an expiry are *not* mutually exclusive and both are raised —
 * they are different actions for different people, one an order and one a
 * quarantine.
 */
export function classifyStock(
  state: StockState,
  today: string,
  expiringDays: number = EXPIRING_ALERT_DAYS
): StockAlert[] {
  // A retired product raises nothing, which is also how deactivating one clears
  // the alerts it already had: the refresh supersedes any key no longer wanted.
  if (!state.isActive) return [];

  const alerts: StockAlert[] = [];
  const name = state.productName;
  const key = (kind: StockAlertKind) => alertKey(kind, state.inventoryId);

  if (state.quantity <= 0) {
    // Migration 003 deliberately allows a batch to go negative: a sale recorded
    // during an outage has physically left the shelf whether or not the count
    // agrees. Below zero is therefore out of stock *and* a stock-take, and
    // saying only the first half would send somebody to reorder when what they
    // need to do is count.
    const message =
      state.quantity < 0
        ? `${name} is ${Math.abs(state.quantity)} unit(s) below zero — more was sold than was recorded as received. There is nothing to sell and the count needs a stock-take.`
        : `${name} is out of stock. Its reorder level is ${state.reorderLevel}.`;

    alerts.push({
      kind: 'out_of_stock',
      dedupeKey: key('out_of_stock'),
      title: 'Out of stock',
      message,
      metadata: metadataFor(state, today),
    });
    // Nothing on the shelf, so nothing to quarantine and nothing dated to sell
    // down. One problem, one alert.
    return alerts;
  }

  if (state.quantity <= state.reorderLevel) {
    alerts.push({
      kind: 'low_stock',
      dedupeKey: key('low_stock'),
      title: 'Low stock',
      message: `${name} fell to ${state.quantity} — its reorder level is ${state.reorderLevel}.`,
      metadata: metadataFor(state, today),
    });
  }

  if (!state.expiryDate) return alerts;

  if (state.expiryDate < today) {
    alerts.push({
      kind: 'expired_stock',
      dedupeKey: key('expired_stock'),
      title: 'Expired stock',
      message:
        `${name} has ${state.quantity} unit(s) dated ${state.expiryDate}, which has passed` +
        `${state.batchNumber ? ` (lot ${state.batchNumber})` : ''}. ` +
        'It cannot be sold — quarantine it and record a write-off.',
      metadata: metadataFor(state, today),
    });
    return alerts;
  }

  const days = daysBetween(today, state.expiryDate);
  if (days <= expiringDays) {
    alerts.push({
      kind: 'expiring',
      dedupeKey: key('expiring'),
      title: 'Expiring soon',
      message:
        `${name} expires on ${state.expiryDate}` +
        `${state.batchNumber ? ` (lot ${state.batchNumber})` : ''}, in ${days} day${days === 1 ? '' : 's'}. ` +
        `${state.quantity} unit(s) on hand.`,
      metadata: metadataFor(state, today),
    });
  }

  return alerts;
}

/**
 * The live-alert read, as a builder.
 *
 * Scoped by kind so a stock refresh can never supersede somebody else's
 * notification, and by product so a refresh after one sale does not read every
 * alert the pharmacy has.
 *
 * `split_part` rather than a LIKE prefix, and compared as text rather than cast
 * to uuid: Postgres does not promise to evaluate AND in written order, so a cast
 * on a column another feature also writes to is one malformed key away from
 * failing the whole refresh.
 */
export function buildLiveAlertQuery(
  pharmacyId: string,
  inventoryIds: string[],
  kinds: StockAlertKind[] = STOCK_ALERT_KINDS
): BuiltQuery {
  return {
    text: `
      SELECT id, dedupe_key, title, message, metadata, created_at, read_at
        FROM notifications
       WHERE pharmacy_id = $1
         AND superseded_at IS NULL
         AND dedupe_key IS NOT NULL
         AND split_part(dedupe_key, ':', 1) = ANY($2::text[])
         AND (cardinality($3::text[]) = 0 OR split_part(dedupe_key, ':', 2) = ANY($3::text[]))`,
    params: [pharmacyId, kinds as string[], inventoryIds],
  };
}

/**
 * The insert, as a builder.
 *
 * One statement for the whole batch: the first refresh after migration 003 runs
 * against a pharmacy that may have dozens of products already below their
 * reorder level, and one round trip each would be dozens of queries on the
 * request that opened the bell.
 *
 * ON CONFLICT names the partial index's predicate exactly, because two tills
 * finishing sales at the same moment both try to raise the same alert and the
 * loser must be a no-op rather than a 500 on somebody's sale.
 */
export function buildAlertInsert(
  pharmacyId: string,
  alerts: StockAlert[]
): BuiltQuery | null {
  if (alerts.length === 0) return null;

  const params: unknown[] = [pharmacyId];
  const rows: string[] = [];

  for (const alert of alerts) {
    // $1 is the pharmacy, shared by every row; the rest are four per alert.
    const at = params.length;
    rows.push(
      `($1, 'in_app', $${at + 1}, $${at + 2}, 'in_app', 'pending', $${at + 3}, $${at + 4}::jsonb)`
    );
    params.push(alert.title, alert.message, alert.dedupeKey, JSON.stringify(alert.metadata));
  }

  return {
    text: `
      INSERT INTO notifications
        (pharmacy_id, type, title, message, channel, status, dedupe_key, metadata)
      VALUES
        ${rows.join(',\n        ')}
      ON CONFLICT (pharmacy_id, dedupe_key)
        WHERE dedupe_key IS NOT NULL AND superseded_at IS NULL
      DO NOTHING`,
    params,
  };
}

/** Releases the keys whose condition has cleared, keeping the rows as history. */
export function buildSupersedeQuery(pharmacyId: string, notificationIds: string[]): BuiltQuery | null {
  if (notificationIds.length === 0) return null;

  return {
    text: `
      UPDATE notifications
         SET superseded_at = NOW()
       WHERE pharmacy_id = $1
         AND superseded_at IS NULL
         AND id = ANY($2::uuid[])`,
    params: [pharmacyId, notificationIds],
  };
}

/**
 * Brings the notification table into agreement with the shelf.
 *
 * Takes anything that can run a query, so a caller may hand it its transaction
 * client — but the routes call it after the commit instead, through
 * `refreshStockAlertsFor` below. Inside the transaction, a failure to write a
 * notification would roll back the sale that caused it. After the commit it
 * reads committed stock, so it still cannot announce a change that was rolled
 * back.
 *
 * `inventoryIds` scopes the work. Omit it for a whole-pharmacy refresh, which
 * is what the bell does on open and what covers products nothing has touched
 * since the last one.
 */
export async function refreshStockAlerts(
  client: Queryable,
  pharmacyId: string,
  options: {
    inventoryIds?: string[] | null;
    expiringDays?: number;
    today?: string;
  } = {}
): Promise<RefreshResult> {
  const today = options.today ?? todayInGhana();
  const scope = options.inventoryIds ?? [];

  if (!(await hasAlertDedupe(client))) throw new StockAlertsUnavailable();

  const stockQuery = buildStockStateQuery(pharmacyId, scope);
  const stock = await client.query(stockQuery.text, stockQuery.params);

  const wanted = new Map<string, StockAlert>();
  for (const row of stock.rows as StockRow[]) {
    const alerts = classifyStock(toStockState(row), today, options.expiringDays);
    for (const alert of alerts) wanted.set(alert.dedupeKey, alert);
  }

  const liveQuery = buildLiveAlertQuery(pharmacyId, scope);
  const live = await client.query(liveQuery.text, liveQuery.params);

  const liveKeys = new Map<string, string>();
  for (const row of live.rows) {
    liveKeys.set(row.dedupe_key, row.id);
  }

  const toRaise = [...wanted.values()].filter((alert) => !liveKeys.has(alert.dedupeKey));
  const toSupersede = [...liveKeys.entries()]
    .filter(([key]) => !wanted.has(key))
    .map(([, id]) => id);

  const insert = buildAlertInsert(pharmacyId, toRaise);
  // rowCount rather than toRaise.length: ON CONFLICT DO NOTHING means a second
  // transaction that raised the same alert first leaves this one having written
  // nothing, and reporting an alert that was not written would be a small lie
  // that is hard to notice.
  const insertResult = insert ? await client.query(insert.text, insert.params) : null;
  const raised = insertResult?.rowCount ?? 0;

  const supersede = buildSupersedeQuery(pharmacyId, toSupersede);
  if (supersede) await client.query(supersede.text, supersede.params);

  if (raised > 0 || toSupersede.length > 0) {
    logger.info('Stock alerts refreshed', {
      pharmacyId,
      checked: stock.rows.length,
      raised,
      superseded: toSupersede.length,
    });
  }

  return {
    checked: stock.rows.length,
    raised,
    superseded: toSupersede.length,
    // toRaise.length, not raised. A conflict means somebody else wrote the row a
    // moment ago, so the condition is live either way — counting only what this
    // transaction managed to insert would report a pharmacy as clear at the exact
    // moment two tills were both telling it the same product had run out.
    live: liveKeys.size - toSupersede.length + toRaise.length,
  };
}

/**
 * Refreshes the alerts for the products a request just changed.
 *
 * Call it once the change has committed, and let it fail on its own. An alert is
 * advisory: it is not the record of the stock change, and a cashier who cannot
 * finish a sale because a notification would not insert has been failed by this
 * feature rather than served by it.
 *
 * What must not happen is losing the failure silently, so it is logged with the
 * products it was for. The bell's own whole-pharmacy refresh raises the alert a
 * moment later if this one did not, which is the difference between an alert
 * being late and it being missing.
 *
 * Nulls and duplicates are dropped here rather than at each of the nine call
 * sites: a basket can carry the same product twice, and a line for something
 * rung up without a catalogue entry has no inventory id at all.
 */
export async function refreshStockAlertsFor(
  db: Queryable,
  pharmacyId: string,
  inventoryIds: Array<string | null | undefined>,
  context: string
): Promise<void> {
  const scope = [...new Set(inventoryIds.filter((id): id is string => Boolean(id)))];
  if (scope.length === 0) return;

  try {
    await refreshStockAlerts(db, pharmacyId, { inventoryIds: scope });
  } catch (error) {
    if (error instanceof StockAlertsUnavailable) {
      // The probe has already said what to run. Repeating it per sale would bury
      // the log line that matters — the one about a refresh that should have
      // worked and did not.
      return;
    }
    logger.warn('Stock alerts could not be refreshed', {
      pharmacyId,
      context,
      inventoryIds: scope,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
