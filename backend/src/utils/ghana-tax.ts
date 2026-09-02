/**
 * Ghana VAT computation.
 *
 * Legal basis: Value Added Tax Act, 2025 (Act 1151), in force from
 * 1 January 2026, and the Ghana Revenue Authority guidance published with it.
 *
 * The Act 1151 regime that matters at a pharmacy counter:
 *
 *  1. One base, three charges. VAT (15%), the National Health Insurance Levy
 *     (2.5%) and the GETFund Levy (2.5%) are all computed on the SAME taxable
 *     value. The pre-2026 cascade — levies added to cost, then 15% VAT on the
 *     inflated figure — was abolished, as was the 1% COVID-19 Health Recovery
 *     Levy. Effective standard-rate burden is therefore 20% of the net price.
 *
 *  2. The 3% VAT Flat Rate Scheme for retailers was abolished. There is no
 *     simplified retail rate to fall back on.
 *
 *  3. Pharmaceuticals supplied in Ghana are EXEMPT (First Schedule), not
 *     zero-rated. "Pharmaceuticals" is confined to essential drugs in Chapter
 *     30 of the 2022 Harmonised System — so medicaments, and the gauze /
 *     bandage / pharmaceutical-goods headings that sit in Chapter 30. An
 *     exempt supply carries no VAT, NHIL or GETFund levy at all.
 *
 *  4. Everything else a pharmacy sells is standard-rated: toiletries and
 *     cosmetics (HS 33), soaps and sanitisers (HS 34/38), thermometers and
 *     blood-pressure monitors (HS 90), baby food, snacks and drinks. Selling
 *     these without VAT is under-declaration, so classification is per item,
 *     not per pharmacy.
 *
 *  5. Mosquito nets, whether or not chemically infused, are separately exempt
 *     under the First Schedule.
 *
 *  6. Tax-inclusive pricing is the default for an advertised price, and the
 *     VAT amount or VAT-inclusive price must be given equal prominence. That
 *     is why the POS stores prices tax-inclusive and shows the breakdown
 *     rather than quietly adding 20% at the till.
 *
 *  7. A business dealing in goods must exceed GHS 750,000 turnover to be
 *     required to register (raised from GHS 200,000). A pharmacy below the
 *     threshold must NOT charge VAT, so registration status is a per-pharmacy
 *     setting that switches the whole engine off.
 *
 * Nothing here should be treated as tax advice; the classification of a given
 * product is the pharmacy's responsibility.
 */

/** Statutory rates on the taxable value. */
export const GHANA_TAX_RATES = {
  vat: 0.15,
  nhil: 0.025,
  getfund: 0.025,
} as const;

/** 15% + 2.5% + 2.5%, all on the same base. */
export const EFFECTIVE_STANDARD_RATE =
  GHANA_TAX_RATES.vat + GHANA_TAX_RATES.nhil + GHANA_TAX_RATES.getfund;

export type VatTreatment = 'standard' | 'exempt' | 'zero_rated';

/**
 * Normalises a stored or submitted classification.
 *
 * Anything that is not explicitly standard or zero-rated becomes exempt. That
 * is the conservative direction for a pharmacy — the default assumes the stock
 * is a Chapter 30 medicine — but it does mean unclassified toiletries or
 * devices are sold without the levy they should carry, so the inventory screen
 * flags a missing classification in amber rather than leaving it invisible.
 *
 * Lives here rather than in the POS routes because the offline till pricer has
 * to apply the identical rule on the device, and both sides are pinned to it by
 * the parity vectors in frontend/src/lib/offline/pricing-vectors.json.
 */
export function toVatTreatment(value: unknown): VatTreatment {
  return value === 'standard' || value === 'zero_rated' ? value : 'exempt';
}

/**
 * Whether stored unit prices already contain the tax. Ghanaian retail shelf
 * prices are tax-inclusive, so the POS backs the tax out rather than adding it.
 */
export type PricingMode = 'inclusive' | 'exclusive';

export interface TaxRates {
  vat: number;
  nhil: number;
  getfund: number;
}

export interface TaxLineInput {
  /** quantity x unit price, less any line discount, before tax handling */
  lineTotal: number;
  vatTreatment: VatTreatment;
}

export interface TaxLineResult extends TaxLineInput {
  /** Value the three charges are computed on; 0 for exempt lines */
  taxableBase: number;
  /** Gross value the customer paid that carried no output tax */
  exemptAmount: number;
  vat: number;
  nhil: number;
  getfund: number;
  totalTax: number;
  /** What the customer actually pays for this line */
  grossTotal: number;
}

export interface TaxSummary {
  subtotal: number;
  taxableBase: number;
  exemptAmount: number;
  vat: number;
  nhil: number;
  getfund: number;
  totalTax: number;
  grandTotal: number;
  lines: TaxLineResult[];
}

/**
 * Rounds to pesewas. Banker's rounding is deliberately NOT used: GRA returns
 * are filed on ordinary commercial rounding, and a receipt that disagrees with
 * the till by a pesewa is a bigger problem than a half-pesewa bias.
 */
export function round2(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function resolveRates(overrides?: Partial<TaxRates> | null): TaxRates {
  return {
    vat: pickRate(overrides?.vat, GHANA_TAX_RATES.vat),
    nhil: pickRate(overrides?.nhil, GHANA_TAX_RATES.nhil),
    getfund: pickRate(overrides?.getfund, GHANA_TAX_RATES.getfund),
  };
}

/**
 * The rates the engine will actually apply, after sanity-checking any stored
 * override. Exported so a receipt snapshot records exactly what computeLineTax
 * uses rather than a re-derivation that could drift from it.
 */
export function resolveTaxRates(overrides?: Partial<TaxRates> | null): TaxRates {
  return resolveRates(overrides);
}

/**
 * Accepts a stored override only when it is a sane rate. A typo in the
 * settings JSONB must never silently zero out somebody's VAT.
 */
function pickRate(candidate: unknown, fallback: number): number {
  if (typeof candidate !== 'number' || !Number.isFinite(candidate)) return fallback;
  if (candidate < 0 || candidate > 0.5) return fallback;
  return candidate;
}

/**
 * Computes the tax for a single basket line.
 *
 * Rounding is per line and the sale total is the sum of the rounded lines, so
 * the receipt always foots. Summing unrounded values and rounding once would
 * produce a total that disagrees with the printed line items.
 */
export function computeLineTax(
  line: TaxLineInput,
  options: { pricingMode?: PricingMode; rates?: Partial<TaxRates> | null; vatRegistered?: boolean } = {}
): TaxLineResult {
  const pricingMode = options.pricingMode ?? 'inclusive';
  const rates = resolveRates(options.rates);
  const vatRegistered = options.vatRegistered ?? true;

  const lineTotal = round2(Math.max(line.lineTotal || 0, 0));

  // An unregistered business charges nothing, and an exempt or zero-rated
  // supply carries no VAT, NHIL or GETFund levy.
  const chargeable = vatRegistered && line.vatTreatment === 'standard';
  const combined = rates.vat + rates.nhil + rates.getfund;

  let taxableBase = 0;
  let vat = 0;
  let nhil = 0;
  let getfund = 0;
  let grossTotal = lineTotal;

  if (chargeable && combined > 0) {
    if (pricingMode === 'inclusive') {
      // The shelf price already contains the tax: back it out of the gross.
      taxableBase = lineTotal / (1 + combined);
      grossTotal = lineTotal;
    } else {
      taxableBase = lineTotal;
      grossTotal = lineTotal * (1 + combined);
    }

    vat = taxableBase * rates.vat;
    nhil = taxableBase * rates.nhil;
    getfund = taxableBase * rates.getfund;

    taxableBase = round2(taxableBase);
    vat = round2(vat);
    nhil = round2(nhil);
    getfund = round2(getfund);
    grossTotal = round2(grossTotal);
  } else if (line.vatTreatment === 'zero_rated' && vatRegistered) {
    // Zero-rated is still a taxable supply, so it belongs in the taxable base
    // even though the output tax is nil and input tax remains creditable.
    taxableBase = lineTotal;
    grossTotal = lineTotal;
  } else {
    // Exempt under the First Schedule, or a pharmacy below the GHS 750,000
    // registration threshold that must not charge VAT at all. Either way no
    // output tax arises and the value is reported separately so the exempt
    // figure on the return is available.
    taxableBase = 0;
    grossTotal = lineTotal;
  }

  const exemptAmount = chargeable || (line.vatTreatment === 'zero_rated' && vatRegistered)
    ? 0
    : lineTotal;

  return {
    lineTotal,
    vatTreatment: line.vatTreatment,
    taxableBase,
    exemptAmount,
    vat,
    nhil,
    getfund,
    totalTax: round2(vat + nhil + getfund),
    grossTotal,
  };
}

/**
 * Computes the tax for a whole basket. The grand total is the sum of the
 * rounded line grosses, never a re-derivation from the aggregate base, so the
 * printed receipt and the stored sale row cannot disagree.
 */
export function computeSaleTax(
  lines: TaxLineInput[],
  options: { pricingMode?: PricingMode; rates?: Partial<TaxRates> | null; vatRegistered?: boolean } = {}
): TaxSummary {
  const computed = lines.map((line) => computeLineTax(line, options));

  const sum = (pick: (line: TaxLineResult) => number) =>
    round2(computed.reduce((total, line) => total + pick(line), 0));

  const grandTotal = sum((line) => line.grossTotal);

  return {
    subtotal: sum((line) => line.lineTotal),
    taxableBase: sum((line) => line.taxableBase),
    exemptAmount: sum((line) => line.exemptAmount),
    vat: sum((line) => line.vat),
    nhil: sum((line) => line.nhil),
    getfund: sum((line) => line.getfund),
    totalTax: sum((line) => line.totalTax),
    grandTotal,
    lines: computed,
  };
}

/**
 * Categories that are almost never Chapter 30 pharmaceuticals and so default to
 * standard-rated. Used only as a suggestion in the inventory form — the
 * pharmacy confirms the classification, and getting it wrong under-declares
 * VAT.
 */
const STANDARD_RATED_CATEGORY_HINTS = [
  'cosmetic',
  'cosmetics',
  'toiletries',
  'toiletry',
  'personal care',
  'skincare',
  'skin care',
  'haircare',
  'hair care',
  'baby care',
  'baby product',
  'baby products',
  'food',
  'beverage',
  'beverages',
  'snack',
  'snacks',
  'supplement',
  'supplements',
  'device',
  'devices',
  'equipment',
  'household',
  'general',
  'other',
];

const EXEMPT_CATEGORY_HINTS = [
  'prescription',
  'medicine',
  'medicines',
  'medication',
  'medications',
  'pharmaceutical',
  'pharmaceuticals',
  'drug',
  'drugs',
  'antibiotic',
  'antibiotics',
  'analgesic',
  'analgesics',
  'antimalarial',
  'antimalarials',
  'antiretroviral',
  'chronic',
  'essential drugs',
  'essential medicines',
];

/**
 * Suggests a VAT treatment from the free-text category. Mosquito nets are
 * called out explicitly because they are exempt in their own right under the
 * First Schedule even though they are not a medicine.
 */
export function suggestVatTreatment(category?: string | null, productName?: string | null): VatTreatment {
  const haystack = `${category || ''} ${productName || ''}`.toLowerCase();

  if (haystack.includes('mosquito net')) return 'exempt';

  if (STANDARD_RATED_CATEGORY_HINTS.some((hint) => haystack.includes(hint))) return 'standard';
  if (EXEMPT_CATEGORY_HINTS.some((hint) => haystack.includes(hint))) return 'exempt';

  // Absent a clear signal, assume the stock is a medicine. This is the
  // conservative default for a pharmacy and is surfaced for confirmation in
  // the UI rather than applied silently.
  return 'exempt';
}

/** Human-readable rate lines for receipts and the tax settings screen. */
export function describeRates(rates?: Partial<TaxRates> | null): string[] {
  const resolved = resolveRates(rates);
  // Scales via integers so 0.15 prints as "15%" and 0.025 as "2.5%" instead of
  // carrying binary floating-point noise into the receipt.
  const percent = (value: number) => `${Math.round(value * 10000) / 100}%`;

  return [
    `VAT ${percent(resolved.vat)}`,
    `NHIL ${percent(resolved.nhil)}`,
    `GETFund Levy ${percent(resolved.getfund)}`,
  ];
}
