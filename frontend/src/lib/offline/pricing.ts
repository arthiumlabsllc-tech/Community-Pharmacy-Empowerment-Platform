/**
 * Offline pricing for the till.
 *
 * WHAT THIS IS
 *
 * When the pharmacy has no connection, the cashier still has to tell the
 * customer what they owe. This module produces that figure. It is a deliberate
 * partial reimplementation of `backend/src/utils/ghana-tax.ts` — partial in
 * scope, identical in arithmetic.
 *
 * WHAT IT DOES NOT DO, AND WHY
 *
 * It never produces a VAT / NHIL / GETFund breakdown. Two reasons:
 *
 *  1. Two implementations of a statutory calculation will drift. The parity
 *     vectors in `pricing-vectors.json` are checked against the real server
 *     engine by a backend test, so drift is caught — but only for the values
 *     the vectors cover. Keeping the offline surface as small as possible keeps
 *     the unverified surface small too.
 *
 *  2. The breakdown goes on a customer receipt and into a GRA return. The
 *     figures offline would be derived from a *cached* tax classification and a
 *     *cached* rate set, either of which the pharmacy may have changed from
 *     another device. Printing a statutory split that the server then disagrees
 *     with is worse than printing a total and labelling it provisional.
 *
 * The total itself is safe to compute because it is the same number either way
 * round: in inclusive mode the shelf price already contains the tax, so the
 * amount due is `round2(quantity x unitPrice)`; in exclusive mode it is that
 * line multiplied by `(1 + combined rate)` for standard-rated lines only. No
 * backing-out, no apportionment.
 *
 * The server re-prices the sale from the inventory row when it syncs, and that
 * figure is authoritative. The offline total is sent as `client_quoted_total`
 * so that if the two disagree, the pharmacy is told rather than silently
 * absorbing the difference.
 */

import { amount } from '../pos-types';
import type { PricingMode, VatTreatment } from '../pos-types';

// ---------------------------------------------------------------------------
// Arithmetic that must match the server exactly
// ---------------------------------------------------------------------------

/**
 * Verbatim copy of `round2` in backend/src/utils/ghana-tax.ts. Ordinary
 * commercial rounding, not banker's: GRA returns are filed on it, and the
 * `Number.EPSILON` nudge keeps 19.99 from rounding down through binary
 * floating-point noise. Changing one without the other breaks parity.
 */
export function round2(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** Statutory rates under Act 1151, all three on the same taxable base. */
export const GHANA_TAX_RATES = {
  vat: 0.15,
  nhil: 0.025,
  getfund: 0.025,
} as const;

export interface OfflineRates {
  vat: number;
  nhil: number;
  getfund: number;
}

/**
 * Mirrors `pickRate` on the server: a stored override is only honoured when it
 * is a plausible rate, so a typo in the settings JSONB cannot silently zero out
 * somebody's VAT. The 0.5 ceiling is the server's, not an invention here.
 */
function pickRate(candidate: unknown, fallback: number): number {
  if (typeof candidate !== 'number' || !Number.isFinite(candidate)) return fallback;
  if (candidate < 0 || candidate > 0.5) return fallback;
  return candidate;
}

export function resolveOfflineRates(overrides?: Partial<OfflineRates> | null): OfflineRates {
  return {
    vat: pickRate(overrides?.vat, GHANA_TAX_RATES.vat),
    nhil: pickRate(overrides?.nhil, GHANA_TAX_RATES.nhil),
    getfund: pickRate(overrides?.getfund, GHANA_TAX_RATES.getfund),
  };
}

/**
 * Mirrors `toVatTreatment` in backend/src/utils/ghana-tax.ts: anything that is
 * not explicitly standard or zero-rated is treated as exempt. That includes a
 * product nobody has classified yet, which is why the inventory screen flags
 * "Not set" in amber rather than leaving it invisible.
 */
export function toOfflineVatTreatment(value: unknown): VatTreatment {
  return value === 'standard' || value === 'zero_rated' ? value : 'exempt';
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface OfflineTaxSettings {
  vatRegistered: boolean;
  pricingMode: PricingMode;
  /** Raw stored overrides; resolved through resolveOfflineRates before use. */
  rates?: Partial<OfflineRates> | null;
  /** ISO timestamp of when this device last heard these settings from the API. */
  cachedAt?: string | null;
}

export interface OfflineItem {
  inventoryId: string | null;
  productName: string;
  quantity: number;
  unitPrice: number;
  vatTreatment: VatTreatment;
  requiresPrescription?: boolean;
}

export interface OfflineLine {
  inventoryId: string | null;
  productName: string;
  quantity: number;
  unitPrice: number;
  vatTreatment: VatTreatment;
  /** round2(quantity x unitPrice) — what the server's buildLine calls lineTotal */
  lineTotal: number;
  /** What the customer pays for this line, after tax handling. */
  amountDue: number;
}

export interface OfflineQuote {
  /** False when the till must not take this basket offline. */
  priced: boolean;
  /** Plain-language reason for a refusal, safe to show the cashier. */
  refusalReason: string | null;
  lines: OfflineLine[];
  subtotal: number;
  /** The amount to charge. Matches the server's grandTotal for the same input. */
  grandTotal: number;
  /**
   * Always null. The tax split is the server's to produce — see the module
   * docblock. Typed as null so a caller cannot render a breakdown by accident.
   */
  taxSplit: null;
  /** Honest caveats to show alongside a provisional receipt. */
  warnings: string[];
}

/** Role of the person at the till, from the auth store. */
export type OfflineUserRole =
  | 'cashier'
  | 'pharmacist'
  | 'pharmacy_owner'
  | 'super_admin'
  | string;

const PHARMACIST_ROLES = ['pharmacist', 'pharmacy_owner', 'super_admin'];

/**
 * Mirrors the per-line grossTotal from `computeLineTax`, for the chargeable
 * branch and the two non-chargeable ones. Exempt and zero-rated lines are
 * returned unchanged; a pharmacy below the GHS 750,000 threshold charges
 * nothing at all, so `vatRegistered: false` collapses every line to its net.
 */
function amountDueForLine(lineTotal: number, treatment: VatTreatment, combined: number, settings: {
  vatRegistered: boolean;
  pricingMode: PricingMode;
}): number {
  const chargeable = settings.vatRegistered && treatment === 'standard';

  if (chargeable && combined > 0) {
    if (settings.pricingMode === 'inclusive') {
      // The shelf price already contains the tax. Nothing to add.
      return round2(lineTotal);
    }
    return round2(lineTotal * (1 + combined));
  }

  // zero_rated, exempt, or an unregistered pharmacy: the customer pays the net.
  return round2(lineTotal);
}

function refuse(reason: string): OfflineQuote {
  return {
    priced: false,
    refusalReason: reason,
    lines: [],
    subtotal: 0,
    grandTotal: 0,
    taxSplit: null,
    warnings: [],
  };
}

/**
 * Prices a basket with no connection.
 *
 * `basketDiscount` exists only so a discount can be *refused* rather than
 * mispriced. The server spreads a basket discount across the lines in
 * proportion to their gross value and pushes the rounding drift into the
 * largest line, which changes each line's taxable base. Reproducing that here
 * would mean a second implementation of `distributeDiscount`, for a feature
 * that a pharmacy can simply not offer for the length of an outage. The till
 * disables the discount control when it is offline; this guard is what stops a
 * future caller from re-enabling it and quietly getting the tax wrong.
 */
export function priceOfflineBasket(
  items: OfflineItem[],
  settings: OfflineTaxSettings | null,
  options: { basketDiscount?: number; userRole?: OfflineUserRole } = {}
): OfflineQuote {
  const basketDiscount = round2(amount(options.basketDiscount));
  if (basketDiscount > 0) {
    return refuse(
      'Discounts are not available while offline, because the tax on a discounted ' +
        'basket has to be computed by the server. Remove the discount to continue.'
    );
  }

  if (!settings) {
    return refuse(
      'This device has never loaded the tax settings, so it cannot price a sale. ' +
        'Connect to the internet once and open the till to cache them.'
    );
  }

  const rates = resolveOfflineRates(settings.rates);
  const combined = rates.vat + rates.nhil + rates.getfund;
  const pricingMode: PricingMode = settings.pricingMode === 'exclusive' ? 'exclusive' : 'inclusive';
  const vatRegistered = settings.vatRegistered !== false;

  if (!Array.isArray(items) || items.length === 0) {
    return refuse('Add an item to the basket first.');
  }

  const requiresPharmacist = items.some((item) => item.requiresPrescription === true);
  if (requiresPharmacist && !PHARMACIST_ROLES.includes(String(options.userRole || ''))) {
    return refuse(
      'This basket contains prescription-only medicine. A pharmacist must be signed ' +
        'in to sell it, offline or not.'
    );
  }

  const lines: OfflineLine[] = [];
  for (const item of items) {
    // The same bounds buildLine enforces on the server. Refusing here means the
    // cashier finds out at the counter instead of the sale bouncing out of the
    // sync queue hours later.
    const quantity = Math.floor(Number(item.quantity));
    if (!Number.isFinite(quantity) || quantity < 1) {
      return refuse(`Invalid quantity for ${item.productName || 'an item'}.`);
    }
    if (quantity > 10000) {
      return refuse(`Quantity for ${item.productName || 'an item'} is unrealistically large.`);
    }

    const unitPrice = Number(item.unitPrice);
    if (!Number.isFinite(unitPrice) || unitPrice < 0) {
      return refuse(`A price is required for ${item.productName || 'this item'}.`);
    }

    const treatment = toOfflineVatTreatment(item.vatTreatment);
    // The gross is rounded ONCE, from the raw unit price — not from a rounded
    // unit price. buildLine on the server does `round2(quantity * unitPrice)`
    // and rounds the stored unit price separately, so rounding twice here would
    // disagree with it on any price that is not already a whole pesewa amount.
    const lineTotal = round2(quantity * unitPrice);

    lines.push({
      inventoryId: item.inventoryId ?? null,
      productName: String(item.productName || '').trim() || 'Unnamed item',
      quantity,
      unitPrice: round2(unitPrice),
      vatTreatment: treatment,
      lineTotal,
      amountDue: amountDueForLine(lineTotal, treatment, combined, { vatRegistered, pricingMode }),
    });
  }

  // Sum of the ROUNDED line values, never a rounding of the sum: the server
  // does it this way so the printed lines always foot to the total.
  const subtotal = round2(lines.reduce((total, line) => total + line.lineTotal, 0));
  const grandTotal = round2(lines.reduce((total, line) => total + line.amountDue, 0));

  if (grandTotal <= 0) {
    return refuse('The sale total must be greater than zero.');
  }

  const warnings: string[] = [
    'Provisional total. Prices and tax settings are the ones last cached on this device; ' +
      'the server re-prices this sale when it syncs and its figure is the one that counts.',
  ];

  if (pricingMode === 'exclusive') {
    warnings.push(
      'This pharmacy prices tax-exclusive, so the amount due here has VAT, NHIL and the ' +
        'GETFund levy added to the shelf price. The breakdown will appear on the receipt ' +
        'once the sale has synced.'
    );
  }
  if (!vatRegistered) {
    warnings.push('This pharmacy is not VAT registered, so no VAT or levy has been added.');
  }
  if (requiresPharmacist) {
    warnings.push(
      'Prescription-only medicine sold offline. The pharmacist signed in at the till is ' +
        'recorded as the approver.'
    );
  }

  return {
    priced: true,
    refusalReason: null,
    lines,
    subtotal,
    grandTotal,
    taxSplit: null,
    warnings,
  };
}
