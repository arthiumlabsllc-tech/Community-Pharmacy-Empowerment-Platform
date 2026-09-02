import { amount, type PricingMode, type Quote } from './pos-types';
import type { OfflineQuote, OfflineTaxSettings } from './offline/pricing';

/**
 * One view of the till's totals, from either of the two places a price can come
 * from.
 *
 * The checkout screen renders the same panel whether the server priced the
 * basket or this device did, and the two sources do not carry the same fields:
 * a server `Quote` has a VAT/NHIL/GETFund split, an `OfflineQuote` deliberately
 * has none (see lib/offline/pricing.ts). Branching on that in JSX means two
 * copies of the totals panel that drift apart, and the drift shows up as a
 * figure on a customer's receipt.
 *
 * So both are folded into one shape here, and the shape says which fields are
 * absent rather than filling them in. `tax` is null offline, not zero: zero
 * would render as "no tax was charged", which is a different claim from "the
 * split is not known here".
 */

/** Where the figure on screen came from. */
export type TotalsSource = 'server' | 'device';

export interface TotalsLine {
  lineTotal: number;
  /** True when the server says the basket exceeds the stock on the shelf. */
  oversold: boolean;
  quantityAvailable: number | null;
}

export interface OversoldLine {
  productName: string;
  quantityAvailable: number | null;
}

export interface TotalsView {
  /** False when there is no figure to charge yet. */
  priced: boolean;
  /** Why there is no figure, in words the cashier can act on. */
  refusal: string | null;
  /** True while the price is being fetched. Only the server can be slow. */
  pending: boolean;
  subtotal: number;
  discount: number;
  /** Null when the split is not known on this device. Never a guess. */
  tax: number | null;
  /** Caption for the tax row, or null when there is no row to caption. */
  taxLabel: string | null;
  total: number;
  vatRegistered: boolean;
  pricingMode: PricingMode;
  /** Keyed by inventory id, for the basket lines to render against. */
  lines: Record<string, TotalsLine>;
  oversold: OversoldLine[];
  /** Caveats that belong next to the total, not in a toast. */
  warnings: string[];
  /** True when the figure was computed here and the server has not seen it. */
  provisional: boolean;
}

const EMPTY: TotalsView = {
  priced: false,
  refusal: null,
  pending: false,
  subtotal: 0,
  discount: 0,
  tax: null,
  taxLabel: null,
  total: 0,
  vatRegistered: true,
  pricingMode: 'inclusive',
  lines: {},
  oversold: [],
  warnings: [],
  provisional: false,
};

export interface TotalsInput {
  source: TotalsSource;
  /** The server's price. Ignored when the source is the device. */
  quote?: Quote | null;
  /** This device's price. Ignored when the source is the server. */
  offlineQuote?: OfflineQuote | null;
  /**
   * The settings this device priced from, so the panel can say whether the
   * pharmacy is VAT registered without asking the offline quote to carry a fact
   * it was not built to hold. Only read for the device source.
   */
  taxSettings?: OfflineTaxSettings | null;
  /** Why the server could not price the basket, if it could not. */
  quoteError?: string | null;
  /** True while a request for the price is in flight. */
  pending?: boolean;
}

/**
 * A server quote that came back before the connection dropped is not a price
 * this device can charge: the basket may have changed since, and the server has
 * not seen the change. Each source is therefore read on its own and the other is
 * discarded, rather than falling back to whichever is newer.
 */
export function buildTotalsView(input: TotalsInput): TotalsView {
  return input.source === 'device'
    ? fromOfflineQuote(input.offlineQuote ?? null, input.taxSettings ?? null)
    : fromServerQuote(input.quote ?? null, input.quoteError ?? null, input.pending === true);
}

function fromServerQuote(quote: Quote | null, quoteError: string | null, pending: boolean): TotalsView {
  if (!quote) {
    // No refusal while the request is still in flight: "could not price this
    // basket" is a statement about an answer, and there is not one yet.
    return { ...EMPTY, refusal: pending ? null : quoteError, pending };
  }

  const lines: Record<string, TotalsLine> = {};
  const oversold: OversoldLine[] = [];

  for (const line of quote.lines || []) {
    if (line.inventory_id) {
      lines[line.inventory_id] = {
        lineTotal: amount(line.line_total),
        oversold: Boolean(line.oversold),
        quantityAvailable: line.quantity_available ?? null,
      };
    }
    if (line.oversold) {
      oversold.push({
        productName: line.product_name,
        quantityAvailable: line.quantity_available ?? null,
      });
    }
  }

  const pricingMode: PricingMode = quote.pricing_mode === 'exclusive' ? 'exclusive' : 'inclusive';
  const tax = amount(quote.summary.total_tax);

  return {
    priced: true,
    refusal: quoteError,
    pending,
    subtotal: amount(quote.summary.subtotal),
    discount: amount(quote.summary.discount_amount),
    tax,
    // In inclusive pricing the levies are already inside the total, so the row
    // is a declaration rather than an addition — the caption says which.
    taxLabel: tax > 0 ? (pricingMode === 'exclusive' ? 'VAT + NHIL + GETFund' : 'Tax included') : null,
    total: amount(quote.summary.total_amount),
    vatRegistered: quote.vat_registered !== false,
    pricingMode,
    lines,
    oversold,
    warnings: [],
    provisional: false,
  };
}

function fromOfflineQuote(quote: OfflineQuote | null, taxSettings: OfflineTaxSettings | null): TotalsView {
  if (!quote) return { ...EMPTY, provisional: true };

  if (!quote.priced) {
    return {
      ...EMPTY,
      provisional: true,
      refusal: quote.refusalReason || 'This basket cannot be priced on this device',
    };
  }

  const lines: Record<string, TotalsLine> = {};
  for (const line of quote.lines) {
    if (line.inventoryId) {
      lines[line.inventoryId] = {
        lineTotal: line.lineTotal,
        // Stock is never reported as oversold offline. The cached quantity is
        // what this device last saw, and an offline sale is allowed to take
        // stock below zero rather than refuse a customer at the counter; the
        // server reports the shortfall when the sale syncs.
        oversold: false,
        quantityAvailable: null,
      };
    }
  }

  return {
    priced: true,
    refusal: null,
    // A price computed on this device is either ready or refused; there is no
    // request to wait for, so the panel never shows a spinner offline.
    pending: false,
    subtotal: quote.subtotal,
    discount: 0,
    tax: null,
    taxLabel: null,
    total: quote.grandTotal,
    // Read from the settings the device actually priced from. A priced quote
    // always had them — the pricer refuses a null — so this is the belt to that
    // brace, and it keeps the panel from asserting a tax position it was not
    // told.
    vatRegistered: taxSettings ? taxSettings.vatRegistered !== false : true,
    pricingMode: taxSettings?.pricingMode === 'exclusive' ? 'exclusive' : 'inclusive',
    lines,
    oversold: [],
    warnings: quote.warnings,
    provisional: true,
  };
}
