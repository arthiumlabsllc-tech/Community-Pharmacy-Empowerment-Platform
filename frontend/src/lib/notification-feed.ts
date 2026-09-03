/**
 * Turning notifications into the bell's list.
 *
 * Two sources, one shape. A database that has had migration 003 applied stores
 * stock alerts in the `notifications` table and the bell reads them back; one
 * that has not answers `supported: false` and the bell falls back to deriving
 * the same list from live inventory, which is what it did before the alerts
 * existed. Both paths produce `BellAlert[]` so the dropdown does not know or
 * care which one it is showing.
 *
 * This module is pure — it maps rows and never fetches — because the mappings
 * are the part that fails quietly. Asking the server for `low-stock` with a
 * hyphen is a 400 and an empty bell; asking for the right kind and grouping it
 * under the wrong icon reports an expired lot as a reorder. Neither shows up in
 * a console.
 */

import { formatDateUtc } from './dates';

/**
 * The kinds the writer raises. These are the first segment of a notification's
 * dedupe key, and they are the strings the API accepts in `?kinds=` — it rejects
 * anything else rather than returning nothing, so a hyphen here is a 400.
 */
export type StockAlertKind = 'out_of_stock' | 'low_stock' | 'expired_stock' | 'expiring';

/**
 * The two groups the bell draws, each with its own icon and colour.
 *
 * Hyphenated, and deliberately different from `StockAlertKind`: these are the
 * bell's own names and they predate the alerts table. Keeping the two spellings
 * in separate types is what stops one being passed where the other is expected.
 */
export type AlertGroup = 'low-stock' | 'expiring';

export interface BellAlert {
  id: string;
  group: AlertGroup;
  /** The condition in the writer's own words — 'Out of stock', 'Expiring soon'. */
  label: string;
  /** The product, which arrives in the metadata rather than in the title. */
  title: string;
  detail: string;
  href: string;
  /** Nobody has opened it yet. Only the persisted feed can say. */
  unread: boolean;
}

/** One row of `GET /notifications`. */
export interface PersistedNotification {
  id: string;
  title: string;
  message: string;
  metadata: Record<string, unknown> | null;
  dedupe_key: string | null;
  /** Derived in SQL from the dedupe key, so it cannot disagree with the writer. */
  dedupe_kind: string | null;
  created_at: string;
  read_at: string | null;
}

/** One row of `GET /inventory/low-stock` or `/inventory/expiring`. */
export interface InventoryRow {
  id: string;
  product_name: string;
  batch_number?: string | null;
  quantity: number;
  reorder_level: number;
  expiry_date?: string | null;
}

/**
 * How many rows the bell asks for.
 *
 * Matches the server's own default. The dropdown scrolls, so this is not about
 * fitting on screen — it is the point past which a list of stock problems stops
 * being readable and the pharmacist should be on the inventory page instead.
 * When the live total is higher, the bell says so rather than implying the list
 * is complete.
 */
export const FEED_LIMIT = 20;

/** Per group, in the derived fallback, so one long list cannot hide the other. */
export const DERIVED_PER_GROUP = 4;

/**
 * How far ahead "expiring soon" looks, in days.
 *
 * App-wide rather than the bell's own, which is why the dashboard imports it
 * from here: four surfaces have to agree on this number and only one of them is
 * code the bell controls. The writer's `EXPIRING_ALERT_DAYS` decides what gets
 * alerted on, the Settings screen promises "Stock expiring within the next 90
 * days", the inventory page's expiring tab reads the same window, and the bell
 * and the dashboard's Stock Alerts panel both list from it.
 *
 * The bell used to ask for 30 while the others said 90, so the fallback showed a
 * third of the promised window and nothing complained — a pharmacy can be within
 * 90 days of a date and never hear about it. One constant, used for the queries
 * and for the wording built from them, so they cannot split again.
 */
export const EXPIRING_WINDOW_DAYS = 90;

const GROUP_BY_KIND: Record<StockAlertKind, AlertGroup> = {
  out_of_stock: 'low-stock',
  low_stock: 'low-stock',
  expired_stock: 'expiring',
  expiring: 'expiring',
};

/**
 * The kinds to ask for, from the two preferences in Settings.
 *
 * Four server kinds behind two toggles, because the toggles describe what the
 * pharmacist wants to know about and the kinds describe what is wrong: turning
 * on "low stock alerts" and then not being told about a product at zero would be
 * a preference honoured too literally. `expired_stock` belongs to the expiry
 * toggle for the same reason — it is the same lot, past its date.
 *
 * Empty when both are off, which the caller uses to skip the request entirely.
 */
export function kindsForPreferences(preferences: {
  low_stock_alerts: boolean;
  expiring_alerts: boolean;
}): StockAlertKind[] {
  const kinds: StockAlertKind[] = [];
  if (preferences.low_stock_alerts) kinds.push('out_of_stock', 'low_stock');
  if (preferences.expiring_alerts) kinds.push('expired_stock', 'expiring');
  return kinds;
}

/** The `?kinds=` value, or null when there is nothing to ask for. */
export function kindsParam(kinds: readonly StockAlertKind[]): string | null {
  return kinds.length > 0 ? kinds.join(',') : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * One stored notification as the bell shows it.
 *
 * Null when the kind is not one of the four. The bell only ever asks for those,
 * so this is a guard against the server and the bell drifting apart rather than
 * a routine case — and dropping the row is the honest response, because drawing
 * a claim rejection or an appointment reminder under a stock icon would tell the
 * pharmacist to reorder something that is not stock.
 */
export function toBellAlert(row: PersistedNotification): BellAlert | null {
  const group = GROUP_BY_KIND[row.dedupe_kind as StockAlertKind];
  if (!group) return null;

  const metadata = (row.metadata ?? {}) as Record<string, unknown>;

  return {
    id: row.id,
    group,
    label: row.title,
    // The notification's own title is the condition ('Low stock'), not the
    // product. The product is in the metadata the writer put there for exactly
    // this, and falling back to the title keeps a row readable if it is missing.
    title: text(metadata.product_name) ?? row.title,
    detail: row.message,
    href: text(metadata.href) ?? '/inventory',
    unread: row.read_at === null || row.read_at === undefined,
  };
}

export function toBellAlerts(rows: PersistedNotification[]): BellAlert[] {
  const alerts: BellAlert[] = [];
  for (const row of rows) {
    const alert = toBellAlert(row);
    if (alert) alerts.push(alert);
  }
  return alerts;
}

/**
 * The derived fallback's expiry date, as text.
 *
 * Delegated to `lib/dates` rather than formatted here: `expiry_date` is a date
 * and not a moment, and three screens read it. Doing it in one place is what
 * stops the bell showing 1 June while the inventory table shows 31 May for the
 * same lot on the same day.
 */
const formatExpiryDate = formatDateUtc;

/**
 * Low and out-of-stock rows, from live inventory.
 *
 * Reproduces the wording the bell has always used, so a pharmacy that has not
 * applied migration 003 sees the same thing it saw before rather than a
 * downgrade it has to relearn — with one change: the condition moved into
 * `label`, so `detail` no longer repeats it and a row at zero reads "Out of
 * stock · Reorder at 20" rather than the same phrase twice.
 */
export function deriveLowStockAlerts(rows: InventoryRow[]): BellAlert[] {
  return rows.slice(0, DERIVED_PER_GROUP).map((item) => ({
    id: `low-${item.id}`,
    group: 'low-stock' as const,
    label: item.quantity === 0 ? 'Out of stock' : 'Low stock',
    title: item.product_name,
    detail:
      item.quantity === 0
        ? `Reorder at ${item.reorder_level}`
        : `${item.quantity} left · reorder at ${item.reorder_level}`,
    href: '/inventory',
    unread: false,
  }));
}

/** Stock inside the expiry window, from live inventory. */
export function deriveExpiringAlerts(rows: InventoryRow[]): BellAlert[] {
  return rows.slice(0, DERIVED_PER_GROUP).map((item) => ({
    id: `exp-${item.id}`,
    group: 'expiring' as const,
    label: 'Expiring soon',
    title: item.product_name,
    detail: item.expiry_date
      ? `Expires ${formatExpiryDate(item.expiry_date)}${
          item.batch_number ? ` · batch ${item.batch_number}` : ''
        }`
      : `Expiring within ${EXPIRING_WINDOW_DAYS} days`,
    href: '/inventory',
    unread: false,
  }));
}

/** How many of each group are in a list, for the footer. */
export function countByGroup(alerts: readonly BellAlert[]): Record<AlertGroup, number> {
  return alerts.reduce(
    (acc, alert) => {
      acc[alert.group] += 1;
      return acc;
    },
    { 'low-stock': 0, expiring: 0 } as Record<AlertGroup, number>
  );
}
