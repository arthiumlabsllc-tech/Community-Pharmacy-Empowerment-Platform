/**
 * Batch and lot tracking on the client.
 *
 * Types for the four batch endpoints and the arithmetic that decides what a
 * correction will do. Pure, like `lib/notification-feed` and `lib/pos-totals`:
 * nothing here fetches, so the rules can be tested without a server and a
 * component can render a consequence before it asks for one.
 *
 * The server remains the authority on every figure. What is mirrored here is
 * only what a pharmacist needs to see *before* committing — that a lot number
 * already exists and will be topped up rather than duplicated, that two expiry
 * dates disagree, that a count would go below zero — and each of those is shown
 * again afterwards in the server's own words, so a disagreement between the two
 * is visible rather than silent.
 */

import { todayUtcDay } from './dates';

// ============ WHAT THE API RETURNS ============

/**
 * Four states rather than a boolean, because "not sellable" needs an action
 * attached to it. Expired and quarantined both hold stock the till will refuse;
 * the first is a write-off and the second is somebody's decision to revisit.
 */
export type BatchStatus = 'sellable' | 'expired' | 'quarantined' | 'empty';

export interface BatchRow {
  id: string;
  batch_number: string;
  expiry_date: string | null;
  received_at: string | null;
  quantity: number;
  cost_price: string | number;
  stock_value: number;
  supplier_id: string | null;
  supplier_name: string | null;
  invoice_number: string | null;
  received_by: string | null;
  /** A migrated balance, not a traced delivery — flagged, never hidden. */
  is_backfill: boolean;
  is_active: boolean;
  is_expired: boolean;
  days_to_expiry: number | null;
  status: BatchStatus;
  sellable: boolean;
}

/** The stock the four derived columns describe, as the mutations return it. */
export interface ProductStock {
  id: string;
  product_name: string;
  product_code: string | null;
  quantity: number;
  batch_number: string | null;
  expiry_date: string | null;
  cost_price: string | number;
  unit_price: string | number;
  reorder_level: number;
}

export interface BatchPanelProduct extends ProductStock {
  generic_name: string | null;
}

/** The lot the till will draw from next, already in FEFO order. */
export interface NextBatch {
  id: string;
  batch_number: string;
  expiry_date: string | null;
  quantity: number;
}

export interface BatchTotals {
  batch_count: number;
  sellable_units: number;
  expired_units: number;
  quarantined_units: number;
  stock_value: number;
  earliest_expiry: string | null;
  /**
   * False when the product row is not the sum of its batches. Something wrote
   * to it directly and no batch has moved since — the panel says so rather than
   * letting a stock-take discover it.
   */
  derived_stock_matches: boolean;
}

export interface BatchPanel {
  product: BatchPanelProduct;
  /** False without migration 003, in which case `batches` is empty. */
  batch_tracking: boolean;
  batches: BatchRow[];
  next_batch: NextBatch | null;
  totals: BatchTotals;
}

/** The two dates on file for one lot number, and the one that was kept. */
export interface ExpiryConflict {
  on_file: string;
  submitted: string;
  kept: string;
}

export interface ReceiveOutcome {
  batch_id: string;
  batch_number: string;
  expiry_date: string;
  quantity_received: number;
  quantity_before: number;
  quantity_after: number;
  cost_price: number;
  merged_with_existing_lot: boolean;
  expiry_conflict: ExpiryConflict | null;
  product: ProductStock;
}

export interface AdjustOutcome {
  batch_id: string;
  batch_number: string;
  product_name: string;
  quantity_before: number;
  quantity_change: number;
  quantity_after: number;
  /** Null when the caller sent a change rather than a count. */
  counted_quantity: number | null;
  product: ProductStock;
}

export interface WriteOffOutcome {
  batch_id: string;
  batch_number: string;
  product_name: string;
  expiry_date: string | null;
  reason: WriteOffReason;
  reason_label: string;
  quantity_written_off: number;
  quantity_before: number;
  quantity_after: number;
  batch_closed: boolean;
  product: ProductStock;
}

// ============ WHAT THE SCREENS SAY ============

export const BATCH_STATUS: Record<
  BatchStatus,
  { label: string; className: string; action: string }
> = {
  sellable: {
    label: 'Sellable',
    className: 'badge-success',
    action: 'The till will draw from this lot.',
  },
  expired: {
    label: 'Expired',
    className: 'badge-danger',
    action: 'Cannot be sold. Write it off and say why.',
  },
  quarantined: {
    label: 'Quarantined',
    className: 'badge-warning',
    action: 'Taken off the shelf by a decision rather than by a date. Still counted here.',
  },
  empty: {
    label: 'Empty',
    className: 'badge-neutral',
    action: 'Nothing left. Kept because the ledger and any recall still read it.',
  },
};

/**
 * The reasons stock leaves without being sold.
 *
 * Mirrors the backend's own list, which mirrors the ledger's CHECK constraint.
 * A test pins the values so the three cannot drift: a reason the client offers
 * and the database rejects is a 500 on a form that looked valid.
 */
export const WRITE_OFF_REASONS = [
  {
    value: 'expiry_writeoff',
    label: 'Expired',
    hint: 'Past its date. Usually the whole lot.',
  },
  {
    value: 'damage_writeoff',
    label: 'Damaged',
    hint: 'Broken, wet, tampered with. Usually a carton, so say how many.',
  },
  {
    value: 'recall',
    label: 'Recalled',
    hint: 'Withdrawn by the supplier, the manufacturer or the FDA.',
  },
] as const;

export type WriteOffReason = (typeof WRITE_OFF_REASONS)[number]['value'];

/** Named in the "not installed" message so the fix is one command, not a hunt. */
export const BATCH_MIGRATION = 'database/migrations/003_inventory_batches.sql';

/**
 * True when a batch endpoint answered 501 because migration 003 is not applied.
 *
 * A state to render rather than an error to toast: the request was well formed
 * and the database is healthy, the pharmacy simply has not installed lot
 * tracking yet. Saying "failed to load" would send somebody looking for a bug.
 */
export function isBatchTrackingMissing(error: unknown): boolean {
  return (error as { status?: number } | null | undefined)?.status === 501;
}

// ============ WHAT A CHANGE WILL DO ============

/**
 * A correction is either a counted quantity — what a stock-take produces — or a
 * change. Never both, and never neither: two ways of saying the same thing in
 * one request is a disagreement waiting to be resolved by whichever field the
 * code happens to read last. The server refuses it with a 400; this refuses it
 * first, in the form.
 */
export type AdjustMode = 'counted' | 'change';

export const ADJUST_MODES: Array<{ value: AdjustMode; label: string; hint: string }> = [
  {
    value: 'counted',
    label: 'What I counted',
    hint: 'Enter the number on the shelf. The difference is worked out.',
  },
  {
    value: 'change',
    label: 'Correct by',
    hint: 'Enter a difference: negative to take stock off, positive to add it back.',
  },
];

export type Preview<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Parses a whole number from a text input.
 *
 * Strict on purpose. `Number('12.5')` is 12.5 and `parseInt` quietly drops the
 * half, so a form that accepted it would tell the pharmacist one thing and send
 * another. An empty field is not zero either — zero units is an answer, and
 * guessing it turns a half-filled form into a stock-take that closed a batch.
 */
export function parseWholeUnits(raw: string): number | null {
  const text = raw.trim();
  if (text === '') return null;
  if (!/^-?\d+$/.test(text)) return null;
  return Number(text);
}

/**
 * What receiving this delivery will do, before it is sent.
 *
 * `UNIQUE (inventory_id, batch_number)` means a second consignment of the same
 * lot tops the existing batch up rather than creating a row that looks like a
 * separate delivery. Worth saying before the pharmacist presses the button,
 * because "Received 40 of lot ABC" and "Lot ABC already held 60 — topped up to
 * 100" are different facts about the same shelf.
 */
export function previewReceive(
  lotNumber: string,
  quantity: number,
  expiryDate: string,
  batches: readonly BatchRow[]
): { merged: boolean; quantityAfter: number; expiryConflict: ExpiryConflict | null } {
  const lot = lotNumber.trim();
  const existing = batches.find((batch) => batch.batch_number === lot);
  if (!existing) {
    return { merged: false, quantityAfter: quantity, expiryConflict: null };
  }
  return {
    merged: true,
    quantityAfter: existing.quantity + quantity,
    expiryConflict: expiryConflictBetween(existing.expiry_date, expiryDate),
  };
}

/**
 * The two expiry dates on one lot number, when they disagree.
 *
 * The earlier date governs. One lot number cannot genuinely carry two expiry
 * dates, so a disagreement means one of them was keyed in wrong — and the safe
 * direction to be wrong in is the one that takes stock off the shelf sooner, not
 * the one that dispenses it later than the manufacturer guaranteed.
 *
 * Compared as strings because both sides are `YYYY-MM-DD`, where lexicographic
 * order *is* chronological order.
 */
export function expiryConflictBetween(
  onFile: string | null,
  submitted: string
): ExpiryConflict | null {
  if (!onFile || onFile === submitted) return null;
  return { on_file: onFile, submitted, kept: onFile < submitted ? onFile : submitted };
}

/**
 * Lots already on file that differ from this one only in case or spacing.
 *
 * Not the same as a merge: the unique constraint is exact, so `abc123` beside
 * `ABC123` creates a second lot that looks like a separate delivery and splits
 * the reorder level across two rows — the precise thing migration 003 exists to
 * stop. The server cannot know which spelling the pack is printed with, so this
 * is a warning the pharmacist can overrule rather than a refusal.
 */
export function similarLots(
  batches: readonly BatchRow[],
  lotNumber: string
): BatchRow[] {
  const wanted = normaliseLot(lotNumber);
  if (wanted === '') return [];
  return batches.filter(
    (batch) =>
      batch.batch_number !== lotNumber.trim() && normaliseLot(batch.batch_number) === wanted
  );
}

function normaliseLot(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '');
}

/**
 * What a correction will do to the shelf.
 *
 * Refuses a count below zero for the reason the server gives: there is no such
 * thing as counting fewer than none. And it refuses a change that would land
 * below zero, because a count is a statement about what is on the shelf while
 * stock that has *gone* left for a reason — and the reason is the part an
 * insurer or the FDA asks about. That is a write-off, which names one.
 */
export function previewAdjust(
  mode: AdjustMode,
  rawValue: string,
  onHand: number
): Preview<{ change: number; after: number }> {
  const value = parseWholeUnits(rawValue);
  if (value === null) {
    return {
      ok: false,
      error:
        mode === 'counted'
          ? 'Enter the whole number of units you counted'
          : 'Enter a whole number of units, negative to take stock off',
    };
  }

  if (mode === 'counted' && value < 0) {
    return {
      ok: false,
      error:
        'A count cannot be negative — there is no such thing as counting fewer than none. ' +
        'To take stock off, correct by a negative amount, or record a write-off if it has gone for a reason.',
    };
  }

  const change = mode === 'counted' ? value - onHand : value;
  if (change === 0) {
    return {
      ok: false,
      error:
        mode === 'counted'
          ? `This lot already holds ${onHand} — there is nothing to correct`
          : 'A correction has to change the count by something',
    };
  }

  const after = onHand + change;
  if (after < 0) {
    return {
      ok: false,
      error: `That would take this lot to ${after}. Stock cannot go below zero — if it is gone, record a write-off and say why.`,
    };
  }

  return { ok: true, value: { change, after } };
}

/**
 * What a write-off will take off the shelf.
 *
 * The whole batch unless a quantity is given: damage is usually a carton, while
 * expiry and recall are usually the lot.
 */
export function previewWriteOff(
  rawQuantity: string,
  onHand: number
): Preview<{ amount: number; after: number; closesBatch: boolean }> {
  if (onHand <= 0) {
    return {
      ok: false,
      error:
        onHand < 0
          ? `This lot is ${Math.abs(onHand)} below zero, which is a stock-take to reconcile rather than stock to destroy. Correct the count instead.`
          : 'This lot has nothing on hand to write off.',
    };
  }

  const trimmed = rawQuantity.trim();
  const amount = trimmed === '' ? onHand : parseWholeUnits(trimmed);
  if (amount === null) {
    return { ok: false, error: 'Enter a whole number of units, or leave it blank for the whole lot' };
  }
  if (amount < 1) {
    return { ok: false, error: 'Write at least 1 unit off, or close the form and leave the lot as it is' };
  }
  if (amount > onHand) {
    return { ok: false, error: `This lot has ${onHand} on hand; ${amount} cannot be written off it.` };
  }

  const after = onHand - amount;
  return { ok: true, value: { amount, after, closesBatch: after === 0 } };
}

// ============ WHAT GETS SENT ============

export interface ReceiveForm {
  batch_number: string;
  expiry_date: string;
  quantity: string;
  cost_price: string;
  invoice_number: string;
  received_at: string;
  note: string;
}

export const EMPTY_RECEIVE_FORM: ReceiveForm = {
  batch_number: '',
  expiry_date: '',
  quantity: '',
  cost_price: '',
  invoice_number: '',
  received_at: '',
  note: '',
};

/**
 * The body for `POST /inventory/:id/receive`.
 *
 * Optional fields are omitted rather than sent as empty strings: the server
 * validates `cost_price` with `isFloat` and `received_at` with `isDate`, and
 * `''` fails both even though `optional({ nullable: true })` was meant to allow
 * it to be left out. Omitting the key is the reading that was intended.
 */
export function buildReceivePayload(form: ReceiveForm): Record<string, unknown> {
  const quantity = parseWholeUnits(form.quantity);
  const costPrice = form.cost_price.trim();

  return {
    batch_number: form.batch_number.trim(),
    expiry_date: form.expiry_date,
    quantity: quantity ?? 0,
    ...(costPrice === '' ? {} : { cost_price: Number(costPrice) }),
    ...(form.invoice_number.trim() === '' ? {} : { invoice_number: form.invoice_number.trim() }),
    ...(form.received_at === '' ? {} : { received_at: form.received_at }),
    ...(form.note.trim() === '' ? {} : { note: form.note.trim() }),
  };
}

/**
 * The client-side half of the receive form's validation. The server repeats all
 * of it, and the server's copy is the one that counts — this exists so a
 * mistake is named against the field it was made in, rather than arriving as a
 * 422 after the form has been filled in and submitted.
 */
export function receiveFormErrors(
  form: ReceiveForm,
  today: string = todayUtcDay()
): Record<keyof ReceiveForm, string> {
  const quantity = parseWholeUnits(form.quantity);
  const costPrice = form.cost_price.trim();

  // Keyed by every field of the form rather than by `Record<string, string>`,
  // so a component asking for the error on a field that has no rule is a
  // compile error instead of `undefined` rendering as "no problem". Adding a
  // field to `ReceiveForm` then forces somebody to decide what wrong looks like
  // for it, which is the point.
  return {
    batch_number:
      form.batch_number.trim() === ''
        ? 'A lot number is required — it is what a recall traces from'
        : form.batch_number.trim().length > 100
          ? 'Lot number must be 100 characters or fewer'
          : '',
    expiry_date: form.expiry_date === '' ? 'Valid expiry date is required' : '',
    quantity:
      quantity === null
        ? 'Quantity received must be a whole number'
        : quantity < 1
          ? 'Quantity received must be at least 1'
          : '',
    cost_price:
      costPrice !== '' && !(Number(costPrice) >= 0) ? 'Cost price cannot be negative' : '',
    invoice_number:
      form.invoice_number.trim().length > 100 ? 'Invoice number must be 100 characters or fewer' : '',
    // A delivery cannot have arrived tomorrow. The input caps itself with
    // `max`, but a browser that lets the date be typed does not enforce that,
    // and a future `received_at` puts the ledger out of date order — FEFO
    // breaks expiry ties on it, so a lot dated tomorrow rotates last.
    // Sliced to ten characters to be the comparison the server makes, which
    // slices too: without it a same-day value carrying a time of day would be
    // refused here and accepted there.
    received_at:
      form.received_at !== '' && form.received_at.slice(0, 10) > today
        ? 'A delivery cannot arrive in the future'
        : '',
    note: form.note.trim().length > 500 ? 'Note must be 500 characters or fewer' : '',
  };
}

/**
 * The body for `POST /inventory/batches/:batchId/adjust`.
 *
 * Returns one shape or the other and never both, so the exactly-one-of rule is
 * structural rather than a condition somebody has to remember to keep. A test
 * asserts no payload ever carries two quantity keys.
 */
export function buildAdjustPayload(
  mode: AdjustMode,
  value: number,
  note: string
): { note: string } & ({ counted_quantity: number } | { quantity_change: number }) {
  const trimmed = note.trim();
  return mode === 'counted'
    ? { counted_quantity: value, note: trimmed }
    : { quantity_change: value, note: trimmed };
}

/** The body for `POST /inventory/batches/:batchId/write-off`. */
export function buildWriteOffPayload(
  reason: WriteOffReason,
  quantity: number | null,
  note: string
): Record<string, unknown> {
  return {
    reason,
    // Null means "the whole lot", which is what the server does with an absent
    // quantity. Omitted rather than sent as null so the isInt check never sees it.
    ...(quantity === null ? {} : { quantity }),
    note: note.trim(),
  };
}

/**
 * Why the note is not optional on a correction.
 *
 * Shown beside the field rather than only in an error, because a mandatory box
 * with no explanation reads as paperwork and gets filled with "." — which
 * satisfies the validation and defeats the entire point of it.
 */
export const NOTE_PROMPT =
  'Say why in writing. This is the record a supplier, an insurer or the FDA asks for, ' +
  'and it is read months later by somebody who was not in the room.';
