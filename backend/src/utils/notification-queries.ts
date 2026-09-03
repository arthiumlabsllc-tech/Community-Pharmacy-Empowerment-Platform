import type { BuiltQuery } from './sql-literal';
import { STOCK_ALERT_KINDS } from './stock-alerts';

export type { BuiltQuery };

/**
 * Reading the notification table back out.
 *
 * The writer lives in stock-alerts.ts and its four builders are proven by
 * database/tests/005_stock_alerts_verify.sql. These are the reader's half, kept
 * beside it rather than inline in the route for the same reason: the filters
 * here are the ones that fail quietly. An inverted unread test does not error,
 * it shows the pharmacist a bell that is always full or always empty, and both
 * look like a quiet pharmacy.
 *
 * What is *not* here is any decision about which kinds a pharmacy wants to see.
 * Those preferences are local-first on each device — the store keeps them in
 * localStorage and only sometimes pushes them to pharmacies.settings — so the
 * server cannot know them and must not guess. The reader takes the kinds it is
 * asked for and the device decides what to ask for.
 */

/** Which rows to hand back. `unread` narrows to those nobody has opened. */
export interface FeedFilter {
  /** Dedupe-key prefixes. Empty means every live notification. */
  kinds?: string[];
  unread?: boolean;
  limit?: number;
}

export interface FeedRow {
  id: string;
  type: string;
  title: string;
  message: string;
  metadata: Record<string, unknown> | null;
  dedupe_key: string | null;
  /** The first segment of the dedupe key — the alert kind, when there is one. */
  dedupe_kind: string | null;
  status: string | null;
  created_at: string;
  read_at: string | null;
}

export const FEED_DEFAULT_LIMIT = 20;
export const FEED_MAX_LIMIT = 100;

/**
 * The largest list one bell can usefully show.
 *
 * Capped rather than left to the caller because the query has no other bound:
 * a pharmacy that has not opened its bell in a quarter has a live alert for
 * every product that went low in it, and an unbounded read of that is a slow
 * response for a dropdown that renders twenty rows.
 */
export function clampFeedLimit(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return FEED_DEFAULT_LIMIT;
  return Math.min(Math.trunc(parsed), FEED_MAX_LIMIT);
}

/**
 * The kinds a stock alert can have, as the text array the filter binds.
 *
 * Exported so the route and the tests name one list. `notification_type` cannot
 * serve here — it is a channel enum ('sms', 'in_app', …), not a topic, so the
 * only thing that says what a notification is *about* is its dedupe key.
 */
export function stockAlertKinds(): string[] {
  return [...STOCK_ALERT_KINDS];
}

/**
 * The kind filter, written once because three queries need it to mean the same
 * thing.
 *
 * Takes the placeholder rather than hardcoding one. A shared fragment that
 * quietly assumed `$2` would be correct in all three queries below and wrong in
 * the fourth, and the failure would be a filter applied to somebody else's
 * parameter — an array of ids read as an array of kinds, which matches nothing
 * and looks like a pharmacy with no alerts.
 *
 * An empty array means "no narrowing" rather than "nothing matches", which is
 * the same `cardinality` test the writer's two scoped reads use and the same
 * one that is easy to invert.
 *
 * A notification with no dedupe key answers NULL to `split_part`, and
 * `NULL = ANY(…)` is NULL, so it drops out whenever a kinds filter is present
 * and comes back when one is not. That is the intended reading of "only these
 * kinds": something that is not a stock alert is not one of them.
 */
function kindFilter(placeholder: string): string {
  return `(cardinality(${placeholder}::text[]) = 0
         OR split_part(dedupe_key, ':', 1) = ANY(${placeholder}::text[]))`;
}

/**
 * The bell's list.
 *
 * Ordered newest first with `id` as the tiebreak, and the tiebreak matters: one
 * refresh writes every alert it raises in a single INSERT, so they all share a
 * `created_at` — `NOW()` is fixed for the whole transaction. Without a second
 * key the order of those is whatever Postgres felt like, and the bell would
 * reshuffle itself every time it was opened.
 */
export function buildNotificationFeedQuery(
  pharmacyId: string,
  filter: FeedFilter = {}
): BuiltQuery {
  return {
    text: `
      SELECT id, type, title, message, metadata, dedupe_key,
             split_part(dedupe_key, ':', 1) AS dedupe_kind,
             status, created_at, read_at
        FROM notifications
       WHERE pharmacy_id = $1
         AND superseded_at IS NULL
         AND (NOT $3::boolean OR read_at IS NULL)
         AND ${kindFilter('$2')}
       ORDER BY created_at DESC, id DESC
       LIMIT $4`,
    params: [
      pharmacyId,
      filter.kinds ?? [],
      Boolean(filter.unread),
      clampFeedLimit(filter.limit),
    ],
  };
}

/**
 * The badge, in one round trip rather than counting the feed's rows.
 *
 * Separate from the list because the list is limited and the badge must not be:
 * a pharmacy with sixty low products shows "60" and lists twenty.
 */
export function buildNotificationCountQuery(
  pharmacyId: string,
  kinds: string[] = []
): BuiltQuery {
  return {
    text: `
      SELECT COUNT(*)::int AS live,
             COUNT(*) FILTER (WHERE read_at IS NULL)::int AS unread
        FROM notifications
       WHERE pharmacy_id = $1
         AND superseded_at IS NULL
         AND ${kindFilter('$2')}`,
    params: [pharmacyId, kinds],
  };
}

/** The numbers beside the badge. */
export interface NotificationCounts {
  /** Live notifications, read or not. */
  live: number;
  /** Live notifications nobody has opened. */
  unread: number;
}

export function toCounts(row: { live?: number | string; unread?: number | string }): NotificationCounts {
  return {
    live: Number(row.live) || 0,
    unread: Number(row.unread) || 0,
  };
}

/**
 * Marks notifications read.
 *
 * Guarded on `read_at IS NULL` so the column keeps meaning "when this was first
 * seen". Overwriting it on every open would turn a record of when the pharmacist
 * noticed a shortage into a record of when they last clicked the bell.
 *
 * `ids` empty means every live notification the kinds filter allows, which is
 * what "mark all read" asks for — and the reason the filter is shared with the
 * read rather than written twice.
 */
export function buildMarkReadQuery(
  pharmacyId: string,
  options: { ids?: string[]; kinds?: string[] } = {}
): BuiltQuery {
  const ids = options.ids ?? [];
  return {
    text: `
      UPDATE notifications
         SET read_at = NOW()
       WHERE pharmacy_id = $1
         AND superseded_at IS NULL
         AND read_at IS NULL
         AND (cardinality($3::uuid[]) = 0 OR id = ANY($3::uuid[]))
         AND ${kindFilter('$2')}`,
    params: [pharmacyId, options.kinds ?? [], ids],
  };
}
