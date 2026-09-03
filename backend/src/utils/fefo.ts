/**
 * First-Expiry-First-Out allocation.
 *
 * A product on the shelf is not one number. It is a set of deliveries, each
 * with its own lot number, expiry date and cost, and the shortest-dated one has
 * to go first — that is the whole point of FEFO, and it is a regulatory
 * expectation rather than a tidy-up: stock that expires on the shelf is stock
 * the pharmacy paid for twice.
 *
 * This module decides *which* batches a quantity comes out of. It does not
 * touch the database. The caller loads the batches inside the transaction,
 * hands them over, and applies what comes back — which means the allocation
 * rule can be tested against every awkward case without a Postgres in sight.
 *
 * Dates are 'YYYY-MM-DD' strings throughout, never Date objects. A DATE column
 * read into JavaScript becomes a Date at local midnight, and comparing one of
 * those against a server in a different timezone moves an expiry by a day. ISO
 * strings compare correctly with < and > and cannot drift.
 */

/** A batch as loaded from inventory_batches. */
export interface BatchRow {
  id: string;
  batchNumber: string;
  expiryDate: string | null;
  quantity: number;
  unitCost: number;
  receivedAt: string | null;
  isActive: boolean;
}

/** One batch's share of a requested quantity. */
export interface BatchAllocation {
  batchId: string;
  batchNumber: string;
  expiryDate: string | null;
  quantity: number;
  unitCost: number;
}

/** A batch that holds stock but was not used, and the reason. */
export interface SkippedBatch {
  batchId: string;
  batchNumber: string;
  expiryDate: string | null;
  quantity: number;
  reason: 'expired' | 'inactive';
}

export interface FefoPlan {
  /** What to take, in the order it should be taken. */
  allocations: BatchAllocation[];
  /** Units requested that no batch could cover. Zero means the sale is covered. */
  shortfall: number;
  /** Usable units across the batches considered, before allocation. */
  available: number;
  /**
   * Stock that is there but cannot be sold. Reported rather than quietly
   * ignored, because it is the difference between "we have none" and "we have
   * twelve and every one of them expired on Tuesday" — and only the second one
   * tells the pharmacist what to do about it.
   */
  skipped: SkippedBatch[];
  /**
   * Cost of what was actually allocated, weighted by quantity. This is the
   * figure that belongs on the sale line: two batches of the same product can
   * have been bought months apart at different prices, and a margin computed
   * against the product's average cost is a margin for stock that was not sold.
   */
  weightedUnitCost: number;
}

export interface FefoOptions {
  /** 'YYYY-MM-DD'. Required: a pure function does not read the clock. */
  today: string;
  /**
   * Let a sale take expired stock. Off by default, because dispensing medicine
   * past its expiry is the one stock error that can hurt somebody. Turned on
   * only by an explicit override for a batch whose date was keyed in wrong —
   * and the override is recorded, not applied silently.
   */
  allowExpired?: boolean;
  /**
   * Cover the whole quantity even when the shelf cannot, by driving the
   * earliest batch negative.
   *
   * Only for a sale recorded during an outage. The goods have physically left,
   * possibly from a second till that was also disconnected, and refusing to
   * record the sale loses real turnover and leaves the counter claiming stock
   * that is not there. A negative count is the honest statement — "we sold more
   * than we thought we had" — and it is what a stock-take then reconciles.
   */
  allowOversell?: boolean;
}

/**
 * A DATE column as node-postgres hands it over: a JavaScript Date built at
 * local midnight. Comparing one of those against an ISO string is how an expiry
 * date moves by a day, so it is converted here at the boundary and never
 * allowed into the allocator.
 */
export function toIsoDate(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;

  if (typeof value === 'string') {
    // Already a DATE rendered as text, which is what a query casting to ::text
    // or a JSON round trip produces.
    return /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;
  }

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    // Local parts, not toISOString(). node-postgres builds the Date from the
    // date parts in the process timezone, so reading it back in UTC moves a
    // server west of Greenwich to the previous day — the exact drift this
    // module exists to avoid.
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${value.getFullYear()}-${month}-${day}`;
  }

  return null;
}

/** Rounds to whole pesewas, away from zero, the way the tax engine does. */
function round2(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function quantityOf(batch: BatchRow): number {
  return Number.isFinite(Number(batch.quantity)) ? Number(batch.quantity) : 0;
}

function costOf(batch: BatchRow): number {
  const cost = Number(batch.unitCost);
  return Number.isFinite(cost) && cost >= 0 ? cost : 0;
}

/**
 * A batch with no expiry date cannot be placed in a first-expiry queue, so it
 * goes last. Sorting it first would mean stock nobody has dated is always
 * dispensed ahead of stock that is about to expire.
 */
function expirySortKey(batch: BatchRow): string {
  return batch.expiryDate || '9999-12-31';
}

/**
 * The FEFO order: usable stock first, then shortest date, then oldest delivery.
 *
 * The received_at tiebreak matters more than it looks. Two batches of the same
 * product frequently share an expiry date, and without a second key the order
 * between them is whatever the database feels like returning, so the same sale
 * rung up twice can draw from different batches and a recall cannot be
 * reproduced.
 */
export function sortBatchesFefo(batches: BatchRow[], today: string): BatchRow[] {
  return [...batches].sort((a, b) => {
    const aExpired = isExpired(a, today) ? 1 : 0;
    const bExpired = isExpired(b, today) ? 1 : 0;
    if (aExpired !== bExpired) return aExpired - bExpired;

    const expiry = expirySortKey(a).localeCompare(expirySortKey(b));
    if (expiry !== 0) return expiry;

    return (a.receivedAt || '').localeCompare(b.receivedAt || '');
  });
}

/**
 * Whether a batch is past its date.
 *
 * A batch is sellable ON its expiry date and expired the day after: the printed
 * date is the last day the manufacturer guarantees it, so medicine dated 30
 * September is still dispensable on 30 September. This matches the inventory
 * summary's `expiry_date < CURRENT_DATE` and the till's FEFO ordering, both of
 * which treat today's date as in-date.
 */
function isExpired(batch: BatchRow, today: string): boolean {
  if (!batch.expiryDate) return false;
  return batch.expiryDate < today;
}

/**
 * Works out which batches a quantity comes out of.
 *
 * Never throws. A shortfall is returned rather than raised, because what to do
 * about one depends on the caller: an online sale refuses, a sale recorded
 * during an outage goes ahead and reports it.
 */
export function planFefo(
  batches: BatchRow[],
  requested: number,
  options: FefoOptions
): FefoPlan {
  const { today, allowExpired = false, allowOversell = false } = options;
  // Guarded on Number.isFinite rather than left to `Number(requested) || 0`.
  // Infinity floors to itself and would otherwise walk the whole shelf into one
  // allocation; a negative would come back as a shortfall the sale never asked
  // for. Units are whole, so anything else is a caller bug and is treated as no
  // request at all.
  const parsed = Number(requested);
  const wanted = Number.isFinite(parsed) ? Math.max(Math.floor(parsed), 0) : 0;

  const skipped: SkippedBatch[] = [];
  const usable: BatchRow[] = [];

  for (const batch of batches) {
    const onHand = quantityOf(batch);

    if (!batch.isActive) {
      // Reported only when there is stock in it. A retired batch that is empty
      // is not something anybody needs to be told about.
      if (onHand > 0) {
        skipped.push({
          batchId: batch.id,
          batchNumber: batch.batchNumber,
          expiryDate: batch.expiryDate,
          quantity: onHand,
          reason: 'inactive',
        });
      }
      continue;
    }

    if (!allowExpired && isExpired(batch, today)) {
      if (onHand > 0) {
        skipped.push({
          batchId: batch.id,
          batchNumber: batch.batchNumber,
          expiryDate: batch.expiryDate,
          quantity: onHand,
          reason: 'expired',
        });
      }
      continue;
    }

    if (onHand > 0) usable.push(batch);
  }

  const ordered = sortBatchesFefo(usable, today);
  const available = ordered.reduce((total, batch) => total + quantityOf(batch), 0);

  const allocations: BatchAllocation[] = [];
  let remaining = wanted;

  for (const batch of ordered) {
    if (remaining <= 0) break;

    const onHand = quantityOf(batch);
    const take = Math.min(onHand, remaining);
    if (take <= 0) continue;

    allocations.push({
      batchId: batch.id,
      batchNumber: batch.batchNumber,
      expiryDate: batch.expiryDate,
      quantity: take,
      unitCost: costOf(batch),
    });
    remaining -= take;
  }

  let shortfall = remaining;

  if (shortfall > 0 && allowOversell) {
    // Onto the earliest batch, which is the one the cashier most likely took
    // from: FEFO is what the shelf is arranged by, so it is also the best guess
    // about what physically left when nobody was watching.
    //
    // With nothing usable at all — every batch empty, or expired — the
    // least-bad candidate is the earliest batch of any kind. Driving an expired
    // batch negative records that expired stock was dispensed, which is a
    // serious thing to have happened and should be visible rather than absorbed
    // silently into a product total.
    const fallback = ordered[0] ?? sortBatchesFefo(batches, today)[0];

    if (fallback) {
      const existing = allocations.find((entry) => entry.batchId === fallback.id);
      if (existing) {
        existing.quantity += shortfall;
      } else {
        allocations.push({
          batchId: fallback.id,
          batchNumber: fallback.batchNumber,
          expiryDate: fallback.expiryDate,
          quantity: shortfall,
          unitCost: costOf(fallback),
        });
      }
      shortfall = 0;
    }
  }

  const allocatedUnits = allocations.reduce((total, entry) => total + entry.quantity, 0);
  const allocatedCost = allocations.reduce(
    (total, entry) => total + entry.quantity * entry.unitCost,
    0
  );

  return {
    allocations,
    shortfall,
    available,
    skipped,
    weightedUnitCost: allocatedUnits > 0 ? round2(allocatedCost / allocatedUnits) : 0,
  };
}

/**
 * The batch label for a receipt line.
 *
 * `sale_items.batch_number` is what prints on the receipt and what a pharmacist
 * reads back down the phone, so it has to name the lots that actually went out.
 * One allocation names its batch. Several are joined with '+', and when the
 * joined form will not fit the column it falls back to the earliest lot plus a
 * count of the others — a truncated list of lot numbers is worse than an honest
 * summary, because a truncated list looks complete.
 *
 * `sale_item_batches` holds every one of them either way, and that is what a
 * recall reads.
 *
 * The expiry date is the earliest across the allocations: the shortest date is
 * the one that matters to anybody checking whether the medicine was in date.
 */
export function summariseAllocations(
  allocations: BatchAllocation[],
  maxChars = 100
): { batchNumber: string | null; expiryDate: string | null } {
  if (allocations.length === 0) return { batchNumber: null, expiryDate: null };

  const dated = allocations
    .map((entry) => entry.expiryDate)
    .filter((date): date is string => Boolean(date))
    .sort();
  const expiryDate = dated.length > 0 ? dated[0] : null;

  if (allocations.length === 1) {
    return { batchNumber: allocations[0].batchNumber, expiryDate };
  }

  const joined = allocations.map((entry) => entry.batchNumber).join('+');
  if (joined.length <= maxChars) return { batchNumber: joined, expiryDate };

  const suffix = ` +${allocations.length - 1} more`;
  if (suffix.length >= maxChars) {
    // Not even room to say there were others. A hard cut is the only option,
    // and it beats handing back a value the column will reject.
    return { batchNumber: joined.slice(0, Math.max(maxChars, 0)), expiryDate };
  }

  const first = allocations[0].batchNumber.slice(0, maxChars - suffix.length);
  return { batchNumber: `${first}${suffix}`, expiryDate };
}

/**
 * Today's date where the pharmacy is.
 *
 * Ghana is on GMT all year — it has no daylight saving — so the UTC date is the
 * Ghanaian date and there is no offset to apply. Spelled out as a function
 * rather than inlined, because "the server's local date" and "the pharmacy's
 * date" are the same thing here by coincidence of geography and not by
 * construction, and a deployment anywhere else would need this to change in one
 * place rather than forty.
 */
export function todayInGhana(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Whether a delivery's arrival date can go into the ledger.
 *
 * FEFO breaks expiry ties on `received_at ASC` — in the derived-stock trigger
 * and in sortBatchesFefo alike — so a lot dated in the future sorts to the back
 * of the rotation queue whenever its expiry ties with another lot's. A
 * transposed year on a delivery note would quietly stop the oldest stock going
 * out first, which is the one thing batch tracking exists to prevent.
 *
 * Compared as ten characters because those ten are the day, and because the
 * route slices the same way before writing the column. Without the slice a
 * value carrying a time of day would be refused here and accepted there.
 */
export function isAcceptableArrivalDate(value: string, today: string = todayInGhana()): boolean {
  return value.slice(0, 10) <= today;
}

/**
 * Turns a plan into the sentence a cashier can act on.
 *
 * Kept beside the allocation rather than in the route, because the two refusal
 * cases need different wording and getting them the same way round matters:
 * "out of stock" sends somebody to the shelf to look again, while "expired"
 * sends somebody to quarantine the batch.
 */
export function describeFefoShortfall(productName: string, plan: FefoPlan, wanted: number): string {
  const expired = plan.skipped.filter((batch) => batch.reason === 'expired');

  if (expired.length > 0 && plan.available === 0) {
    const units = expired.reduce((total, batch) => total + batch.quantity, 0);
    const earliest = expired
      .map((batch) => batch.expiryDate)
      .filter((date): date is string => Boolean(date))
      .sort()[0];

    return (
      `${productName}: ${units} on hand but every batch expired` +
      (earliest ? ` on ${earliest}` : '') +
      `. It cannot be sold — quarantine it and record a write-off.`
    );
  }

  if (expired.length > 0) {
    const units = expired.reduce((total, batch) => total + batch.quantity, 0);
    return (
      `Not enough sellable stock of ${productName}: ${plan.available} available, ` +
      `${wanted} requested. A further ${units} are past their expiry date and cannot be sold.`
    );
  }

  return `Not enough stock of ${productName}: ${plan.available} available, ${wanted} requested`;
}
