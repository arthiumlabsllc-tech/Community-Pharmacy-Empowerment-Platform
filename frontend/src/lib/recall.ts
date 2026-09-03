/**
 * Client-side types and pure helpers for the recall trace.
 *
 * The shapes mirror `GET /inventory/recall` and `GET /inventory/batches/:id/sales`
 * exactly, including the two things that are easy to lose in translation:
 *
 * - `provenance` on every line. A line traced through `sale_item_batches` is
 *   proof; a line matched on the lot number the product row was showing is a
 *   lead. The server says so per row rather than once, because the pharmacist
 *   reading line forty of a long list will not remember a caveat from the top.
 * - `action` on every batch. "Who to phone" and "what to take off the shelf"
 *   are different questions, and a recall that answered only the first would
 *   leave the rest of the lot being sold.
 *
 * Nothing here re-derives a total the server already computed. Where a client
 * figure could disagree with a server one, the helper is written so the two can
 * be compared, and the test does compare them.
 */

export type RecallProvenance = 'batch_ledger' | 'product_row';

/** What to do with a batch today, which is not the same as who to phone. */
export type QuarantineAction = 'quarantine' | 'already_quarantined' | 'nothing_on_hand';

export interface RecallBatch {
  id: string;
  inventory_id: string;
  product_name: string;
  product_code: string | null;
  generic_name: string | null;
  manufacturer: string | null;
  batch_number: string;
  expiry_date: string | null;
  is_expired: boolean;
  received_at: string | null;
  supplier_name: string | null;
  invoice_number: string | null;
  quantity_on_hand: number;
  stock_value: number;
  is_active: boolean;
  is_backfill: boolean;
  action: QuarantineAction;
}

export interface RecallPatient {
  id: string;
  name: string | null;
  phone: string | null;
  alternate_phone: string | null;
  nhis_number: string | null;
}

export interface RecallCustomer {
  name: string | null;
  phone: string | null;
}

export interface RecallSale {
  sale_id: string;
  receipt_number: string;
  sold_at: string;
  sale_status: string;
  voided: boolean;
  recorded_offline: boolean;
  product_name: string;
  product_code: string | null;
  generic_name: string | null;
  inventory_id: string | null;
  batch_id: string | null;
  batch_number: string | null;
  expiry_date: string | null;
  quantity: number;
  sell_unit: string | null;
  unit_cost: number;
  line_value: number;
  requires_prescription: boolean;
  provenance: RecallProvenance;
  confirmed: boolean;
  patient: RecallPatient | null;
  customer: RecallCustomer | null;
  contact: { phone: string; source: 'patient' | 'customer' } | null;
  served_by: { id: string; name: string } | null;
}

export interface RecallReach {
  reachableUnits: number;
  unreachableUnits: number;
  reachableSales: number;
  unreachableSales: number;
  /** Distinct phone numbers, so one patient buying the lot twice is one call. */
  distinctContacts: number;
}

export interface RecallTotals {
  batch_count: number;
  sale_count: number;
  voided_count: number;
  units_dispensed: number;
  units_returned: number;
  distinct_patients: number;
  units_still_on_hand: number;
  units_to_quarantine: number;
  first_sold_at: string | null;
  last_sold_at: string | null;
  unconfirmed_lines: number;
}

export interface RecallResult {
  search: {
    batch_number: string | null;
    product_name: string | null;
    inventory_id: string | null;
    from: string | null;
    to: string | null;
  };
  batches: RecallBatch[];
  sales: RecallSale[];
  reach: RecallReach;
  totals: RecallTotals;
  truncated: boolean;
  limit: number;
  caveat: string | null;
  no_batch_on_file: string | null;
}

// ============ THE SEARCH ============

export interface RecallSearchForm {
  batch_number: string;
  product_name: string;
  from: string;
  to: string;
  limit: string;
}

/**
 * Mirrors the server's clamp, so the choices offered are the choices honoured.
 *
 * Declared above `EMPTY_RECALL_SEARCH` rather than beside the other constants
 * because a `const` initialiser runs at module load: below it, this is a
 * temporal-dead-zone error rather than a value.
 */
export const RECALL_LIMIT_DEFAULT = 500;
export const RECALL_LIMIT_MAX = 2000;

export const EMPTY_RECALL_SEARCH: RecallSearchForm = {
  batch_number: '',
  product_name: '',
  from: '',
  to: '',
  limit: String(RECALL_LIMIT_DEFAULT),
};

export const RECALL_LIMIT_CHOICES = [
  { value: '500', label: 'First 500 lines' },
  { value: '1000', label: 'First 1,000 lines' },
  { value: '2000', label: 'First 2,000 lines (the most the server will return)' },
];

/**
 * What the server says when a recall would match everything.
 *
 * Repeated here rather than waited for, because the point of the refusal is
 * that a list of every sale the pharmacy has ever made looks like an answer.
 */
export const RECALL_NEEDS_A_TERM =
  'A recall needs a lot number, a product, or both — without one this would return every sale the pharmacy has ever made';

/**
 * The client-side half of the recall search's validation. The server repeats it.
 *
 * Keyed by every field rather than by `Record<string, string>` for the reason
 * `receiveFormErrors` gives: a component asking about a field with no rule
 * should be a compile error, not `undefined` rendering as "no problem".
 */
export function recallSearchErrors(
  form: RecallSearchForm
): Record<keyof RecallSearchForm, string> {
  const hasTerm = form.batch_number.trim() !== '' || form.product_name.trim() !== '';

  return {
    // Attached to the lot field because that is where somebody looking for a
    // reason to be refused will look first, and the wording names both.
    batch_number: hasTerm ? '' : RECALL_NEEDS_A_TERM,
    product_name: '',
    // Both sliced to ten characters, the comparison the server makes. Without
    // the slice a window carrying a time of day would be refused here and
    // accepted there, or the reverse.
    from:
      form.from !== '' && form.to !== '' && form.from.slice(0, 10) > form.to.slice(0, 10)
        ? 'The from date is after the to date'
        : '',
    to: '',
    // Offered as a fixed set of choices rather than typed, and clamped by the
    // server either way, so there is no wrong value to name.
    limit: '',
  };
}

/**
 * The query string for `GET /inventory/recall`, with blanks left out.
 *
 * Omitted rather than sent empty: the server treats `''` as absent, but a URL
 * carrying `batch_number=&product_name=` is a search for nothing that reads as
 * a search for something, and this string ends up in the address bar.
 */
export function buildRecallQuery(form: RecallSearchForm): string {
  const params = new URLSearchParams();

  const batchNumber = form.batch_number.trim();
  const productName = form.product_name.trim();
  if (batchNumber !== '') params.set('batch_number', batchNumber);
  if (productName !== '') params.set('product_name', productName);
  if (form.from !== '') params.set('from', form.from.slice(0, 10));
  if (form.to !== '') params.set('to', form.to.slice(0, 10));
  if (form.limit !== '') params.set('limit', form.limit);

  return params.toString();
}

// ============ WHAT TO DO WITH THE STOCK ============

export const QUARANTINE_ACTION: Record<
  QuarantineAction,
  { label: string; className: string; instruction: string }
> = {
  quarantine: {
    label: 'On the shelf',
    className: 'badge-danger',
    instruction:
      'Still sellable. Take the boxes off the shelf and record a write-off with the reason "Recalled" so the ledger and the shelf agree.',
  },
  already_quarantined: {
    label: 'Already off the shelf',
    className: 'badge-neutral',
    instruction:
      'Marked inactive, so the till will not draw from it. Check the boxes are physically separated — the record says so, the shelf is the thing that has to be true.',
  },
  // Warning rather than success: there is nothing here to quarantine, which for
  // a recall means every unit of this lot reached somebody.
  nothing_on_hand: {
    label: 'All dispensed',
    className: 'badge-warning',
    instruction:
      'Nothing left to take off the shelf. Every unit of this lot went out, so the phone list is the whole response.',
  },
};

export interface QuarantineGroups {
  toQuarantine: RecallBatch[];
  alreadyOff: RecallBatch[];
  allDispensed: RecallBatch[];
}

/**
 * The batches split by what to do with them.
 *
 * Grouped rather than filtered so the page can show all three: a list of only
 * the ones needing action hides the fact that a lot was checked and was already
 * off the shelf, which is an answer somebody will otherwise go and look for
 * again.
 */
export function groupBatchesForQuarantine(batches: RecallBatch[]): QuarantineGroups {
  const groups: QuarantineGroups = { toQuarantine: [], alreadyOff: [], allDispensed: [] };

  for (const batch of batches) {
    if (batch.action === 'quarantine') groups.toQuarantine.push(batch);
    else if (batch.action === 'already_quarantined') groups.alreadyOff.push(batch);
    else groups.allDispensed.push(batch);
  }

  return groups;
}

// ============ WHO TO PHONE ============

export interface CallTarget {
  phone: string;
  source: 'patient' | 'customer';
  /** Everyone this number belongs to, so a shared household phone is one call. */
  names: string[];
  units: number;
  receipts: string[];
}

/**
 * The phone list, one entry per number.
 *
 * Built from the lines that were not voided, which is the same rule
 * `summariseReach` applies on the server — so `buildCallList(sales).length`
 * equals `reach.distinctContacts` and the two can be compared rather than
 * trusted. A voided sale came back, so it is not stock that is out there; it is
 * still listed in the sales table, marked as voided, because the customer may
 * have been given a replacement from the same lot and was exposed either way.
 *
 * Sorted by units descending: the person holding the most of a recalled lot is
 * the first call, not the alphabetically first one.
 */
export function buildCallList(sales: RecallSale[]): CallTarget[] {
  const byPhone = new Map<string, CallTarget>();

  for (const sale of sales) {
    if (sale.voided || !sale.contact) continue;

    const existing = byPhone.get(sale.contact.phone);
    const name = sale.patient?.name ?? sale.customer?.name ?? null;

    if (existing) {
      existing.units += sale.quantity;
      if (!existing.receipts.includes(sale.receipt_number)) {
        existing.receipts.push(sale.receipt_number);
      }
      if (name !== null && !existing.names.includes(name)) existing.names.push(name);
      continue;
    }

    byPhone.set(sale.contact.phone, {
      phone: sale.contact.phone,
      source: sale.contact.source,
      names: name === null ? [] : [name],
      units: sale.quantity,
      receipts: [sale.receipt_number],
    });
  }

  return [...byPhone.values()].sort(
    (a, b) => b.units - a.units || a.phone.localeCompare(b.phone)
  );
}

/**
 * The lines that reached somebody with no number on file.
 *
 * This is the list that decides whether a recall closes with a round of phone
 * calls or needs a notice in the window and a call to the supplier, which is
 * why the server counts it separately rather than folding it into the reachable
 * total.
 */
export function buildUnreachableList(sales: RecallSale[]): RecallSale[] {
  return sales.filter((sale) => !sale.voided && sale.contact === null);
}

export const PROVENANCE: Record<
  RecallProvenance,
  { label: string; className: string; meaning: string }
> = {
  batch_ledger: {
    label: 'Traced',
    className: 'badge-success',
    meaning:
      'Recorded against the lot this line was actually drawn from, at the moment it was sold.',
  },
  product_row: {
    label: 'Matched on receipt lot',
    className: 'badge-warning',
    meaning:
      'Sold before batch tracking was installed, so this matches the lot number the product was showing at the time. Treat it as a lead to check rather than confirmed exposure.',
  },
};
