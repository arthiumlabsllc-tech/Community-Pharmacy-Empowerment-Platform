/**
 * Dates as the database stores them.
 *
 * `inventory.expiry_date`, `inventory_batches.expiry_date` and
 * `sale_items.expiry_date` are DATE columns. A DATE has no time and no zone:
 * `2026-06-01` means the whole of the first of June wherever the pharmacy is.
 * JavaScript parses that bare form as midnight *UTC*, so formatting it in the
 * machine's local zone renders 31 May anywhere west of Greenwich — an alert
 * about a specific date that shows the day before it, which is worse than no
 * alert because it is believed.
 *
 * Everything here therefore reads and writes in UTC. That is also correct
 * rather than merely consistent: Ghana is on GMT all year with no daylight
 * saving, so the UTC day *is* the pharmacy's day. The backend's
 * `todayInGhana()` says the same thing from the other side.
 */

const MS_PER_DAY = 86_400_000;

/** Today's DATE-column day. `YYYY-MM-DD`, in UTC. */
export function todayUtcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * The DATE-column day inside anything JavaScript can parse, or null.
 *
 * Tolerates both `2026-06-01` and `2026-06-01T00:00:00.000Z`, which is what
 * node-postgres returns for a DATE depending on how the column was read.
 */
export function toUtcDay(value: string | null | undefined): string | null {
  if (!value) return null;
  const time = Date.parse(value);
  if (Number.isNaN(time)) return null;
  return new Date(time).toISOString().slice(0, 10);
}

/**
 * A DATE column rendered for a human: `1 Jun 2026`.
 *
 * An unparseable value comes back as it arrived rather than as "Invalid Date" —
 * showing what the server sent is more useful than showing that the browser
 * could not read it, and the empty string is what a blank cell should be.
 */
export function formatDateUtc(value: string | null | undefined): string {
  const day = toUtcDay(value);
  if (day === null) return typeof value === 'string' ? value : '';
  return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * Whole days from `fromDay` to `toDay`. Positive when `toDay` is later.
 *
 * Computed from two dates and nothing else. The alternative — subtracting
 * `Date.now()` from a parsed expiry — is what the till and the inventory table
 * both used to do, and because `Date.now()` carries a time of day while a DATE
 * does not, `Math.ceil` spent a full 24 hours on the wrong side of zero: stock
 * that expired yesterday read as `0 days` until the day after that. A countdown
 * that has already run out but has not yet become the refusal the server will
 * make is the worst of the three answers, because it looks like time remaining.
 */
export function daysBetweenUtcDays(fromDay: string, toDay: string): number | null {
  const from = Date.parse(`${fromDay}T00:00:00Z`);
  const to = Date.parse(`${toDay}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return Math.round((to - from) / MS_PER_DAY);
}

/**
 * Days until an expiry date: positive while there is time, zero on the day
 * itself, negative once it has passed.
 *
 * Zero-on-the-day is the rule the whole system sells by — a lot is sellable *on*
 * its expiry date and not the day after — so it is stated here once rather than
 * re-derived by every caller as `< 0` versus `<= 0`.
 */
export function daysUntilExpiry(
  value: string | null | undefined,
  today: string = todayUtcDay()
): number | null {
  const day = toUtcDay(value);
  if (day === null) return null;
  return daysBetweenUtcDays(today, day);
}

/**
 * The short expiry badge both the till and the inventory table wear.
 *
 * `null` means "say nothing": either there is no date, or it is further away
 * than `withinDays` and a badge would be noise on a screen where every product
 * has one. The window is a parameter because the two surfaces genuinely differ
 * — a cashier needs to know about this month, a pharmacist planning a return
 * needs to know about this quarter — and a hardcoded 90 in one of them is how
 * they were disagreeing before.
 */
export function expiryCountdownLabel(
  value: string | null | undefined,
  withinDays = 90,
  today: string = todayUtcDay()
): { text: string; expired: boolean } | null {
  const days = daysUntilExpiry(value, today);
  if (days === null || days > withinDays) return null;
  return days < 0
    ? { text: 'Expired', expired: true }
    : { text: `Exp ${days}d`, expired: false };
}
