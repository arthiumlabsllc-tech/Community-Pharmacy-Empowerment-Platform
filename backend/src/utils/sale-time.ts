/**
 * When a sale actually happened.
 *
 * `sales.created_at` is written by the database, so for a sale rung up while
 * the till was disconnected it records the moment the device got back online
 * and replayed it — which can be the following morning, or after a weekend.
 * `client_recorded_at` is the time the cashier pressed "Charge", captured on
 * the device and sent with the queued sale.
 *
 * Every date window, day bucket and chronological sort in the sales surfaces
 * has to use the second one where it exists. Reporting on `created_at` would
 * move a whole evening's takings into the wrong trading day, which is not a
 * cosmetic problem: the pharmacy reconciles its till against the daily report,
 * and files its VAT return on those periods.
 *
 * This is a SQL fragment builder, not a value. The alias is interpolated
 * straight into the query, so it must only ever be called with a literal from
 * this codebase — never with anything derived from a request.
 */
export function saleTime(alias: string): string {
  return `COALESCE(${alias}.client_recorded_at, ${alias}.created_at)`;
}
