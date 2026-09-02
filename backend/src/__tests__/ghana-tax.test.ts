/**
 * Ghana VAT engine tests.
 *
 * The headline assertions reproduce the Ghana Revenue Authority's own worked
 * example for the post-reform computation, published alongside the Value Added
 * Tax Act, 2025 (Act 1151):
 *
 *   Selling price        = 1,000
 *   NHIL                 = 2.5% of 1,000 = 25
 *   GETFund Levy         = 2.5% of 1,000 = 25
 *   VAT                  = 15%  of 1,000 = 150
 *   Total                = 1,000 + 50 + 150 = 1,200
 *
 * If those numbers stop matching, the till is charging the wrong tax.
 */
import {
  computeLineTax,
  computeSaleTax,
  describeRates,
  EFFECTIVE_STANDARD_RATE,
  GHANA_TAX_RATES,
  round2,
  suggestVatTreatment,
} from '../utils/ghana-tax';

describe('Ghana tax rates (Act 1151)', () => {
  it('charges VAT, NHIL and GETFund on one shared base totalling 20%', () => {
    expect(GHANA_TAX_RATES.vat).toBe(0.15);
    expect(GHANA_TAX_RATES.nhil).toBe(0.025);
    expect(GHANA_TAX_RATES.getfund).toBe(0.025);
    expect(EFFECTIVE_STANDARD_RATE).toBeCloseTo(0.2, 10);
  });

  it('reproduces the GRA worked example in tax-exclusive mode', () => {
    const line = computeLineTax(
      { lineTotal: 1000, vatTreatment: 'standard' },
      { pricingMode: 'exclusive' }
    );

    expect(line.taxableBase).toBe(1000);
    expect(line.nhil).toBe(25);
    expect(line.getfund).toBe(25);
    expect(line.vat).toBe(150);
    expect(line.totalTax).toBe(200);
    expect(line.grossTotal).toBe(1200);
  });

  it('backs the same figures out of a tax-inclusive shelf price', () => {
    const line = computeLineTax(
      { lineTotal: 1200, vatTreatment: 'standard' },
      { pricingMode: 'inclusive' }
    );

    expect(line.taxableBase).toBe(1000);
    expect(line.vat).toBe(150);
    expect(line.nhil).toBe(25);
    expect(line.getfund).toBe(25);
    // The customer pays the shelf price — tax-inclusive pricing must not add on top.
    expect(line.grossTotal).toBe(1200);
  });

  it('does not cascade the levies into the VAT base', () => {
    // Pre-2026 the levies were added first and VAT applied to the inflated
    // figure, giving 159 of VAT on a 1,000 net price. Act 1151 abolished that.
    const line = computeLineTax(
      { lineTotal: 1000, vatTreatment: 'standard' },
      { pricingMode: 'exclusive' }
    );
    expect(line.vat).not.toBe(159);
    expect(line.vat).toBe(150);
  });
});

describe('exempt and zero-rated supplies', () => {
  it('charges nothing at all on an exempt pharmaceutical', () => {
    const line = computeLineTax({ lineTotal: 48.5, vatTreatment: 'exempt' });

    expect(line.vat).toBe(0);
    expect(line.nhil).toBe(0);
    expect(line.getfund).toBe(0);
    expect(line.totalTax).toBe(0);
    expect(line.taxableBase).toBe(0);
    expect(line.exemptAmount).toBe(48.5);
    expect(line.grossTotal).toBe(48.5);
  });

  it('keeps a zero-rated supply in the taxable base with nil output tax', () => {
    const line = computeLineTax({ lineTotal: 200, vatTreatment: 'zero_rated' });

    expect(line.taxableBase).toBe(200);
    expect(line.totalTax).toBe(0);
    expect(line.exemptAmount).toBe(0);
    expect(line.grossTotal).toBe(200);
  });

  it('charges no VAT at all for a pharmacy below the registration threshold', () => {
    const line = computeLineTax(
      { lineTotal: 1000, vatTreatment: 'standard' },
      { vatRegistered: false, pricingMode: 'exclusive' }
    );

    expect(line.totalTax).toBe(0);
    expect(line.grossTotal).toBe(1000);
    expect(line.taxableBase).toBe(0);
    expect(line.exemptAmount).toBe(1000);
  });
});

describe('basket totals', () => {
  it('mixes exempt medicines and standard-rated toiletries correctly', () => {
    const summary = computeSaleTax(
      [
        // Amoxicillin capsules — HS 3004, exempt
        { lineTotal: 60, vatTreatment: 'exempt' },
        // Toothpaste — HS 3306, standard-rated, tax-inclusive shelf price
        { lineTotal: 24, vatTreatment: 'standard' },
        // Paracetamol syrup — HS 3004, exempt
        { lineTotal: 36, vatTreatment: 'exempt' },
      ],
      { pricingMode: 'inclusive' }
    );

    expect(summary.subtotal).toBe(120);
    expect(summary.exemptAmount).toBe(96);
    expect(summary.taxableBase).toBe(20);
    expect(summary.vat).toBe(3);
    expect(summary.nhil).toBe(0.5);
    expect(summary.getfund).toBe(0.5);
    expect(summary.totalTax).toBe(4);
    // Tax-inclusive: the grand total is what the shelf prices add up to.
    expect(summary.grandTotal).toBe(120);
  });

  it('foots exactly, so the printed lines always sum to the stored total', () => {
    // A basket of awkward values that would drift if tax were rounded once at
    // the end instead of per line.
    const lines = Array.from({ length: 7 }, (_, index) => ({
      lineTotal: 10.33 + index * 3.07,
      vatTreatment: 'standard' as const,
    }));

    const summary = computeSaleTax(lines, { pricingMode: 'inclusive' });

    const sumOfLines = round2(
      summary.lines.reduce((total, line) => total + line.grossTotal, 0)
    );
    expect(summary.grandTotal).toBe(sumOfLines);

    const sumOfLineVat = round2(summary.lines.reduce((total, line) => total + line.vat, 0));
    expect(summary.vat).toBe(sumOfLineVat);
  });

  it('adds tax on top in tax-exclusive mode', () => {
    const summary = computeSaleTax(
      [{ lineTotal: 100, vatTreatment: 'standard' }],
      { pricingMode: 'exclusive' }
    );

    expect(summary.taxableBase).toBe(100);
    expect(summary.totalTax).toBe(20);
    expect(summary.grandTotal).toBe(120);
  });

  it('returns zeroes for an empty basket instead of NaN', () => {
    const summary = computeSaleTax([]);

    expect(summary.subtotal).toBe(0);
    expect(summary.grandTotal).toBe(0);
    expect(summary.totalTax).toBe(0);
    expect(summary.lines).toEqual([]);
  });

  it('treats a negative or non-finite line value as zero', () => {
    const summary = computeSaleTax([
      { lineTotal: -50, vatTreatment: 'standard' },
      { lineTotal: Number.NaN, vatTreatment: 'standard' },
    ]);

    expect(summary.grandTotal).toBe(0);
    expect(Number.isFinite(summary.grandTotal)).toBe(true);
  });
});

describe('rate overrides', () => {
  it('honours a stored override so an old receipt can be recomputed', () => {
    const line = computeLineTax(
      { lineTotal: 1000, vatTreatment: 'standard' },
      { pricingMode: 'exclusive', rates: { vat: 0.125, nhil: 0.025, getfund: 0.025 } }
    );

    expect(line.vat).toBe(125);
    expect(line.totalTax).toBe(175);
  });

  it('ignores a nonsense override rather than silently zeroing VAT', () => {
    const absurd = computeLineTax(
      { lineTotal: 1000, vatTreatment: 'standard' },
      { pricingMode: 'exclusive', rates: { vat: -5, nhil: 'x' as unknown as number, getfund: 99 } }
    );

    expect(absurd.vat).toBe(150);
    expect(absurd.nhil).toBe(25);
    expect(absurd.getfund).toBe(25);
  });
});

describe('suggestVatTreatment', () => {
  it('defaults medicines to exempt', () => {
    expect(suggestVatTreatment('Prescription Drugs')).toBe('exempt');
    expect(suggestVatTreatment('antimalarials')).toBe('exempt');
    expect(suggestVatTreatment('Essential Medicines')).toBe('exempt');
  });

  it('flags non-drug retail lines as standard-rated', () => {
    expect(suggestVatTreatment('Toiletries')).toBe('standard');
    expect(suggestVatTreatment('Cosmetics')).toBe('standard');
    expect(suggestVatTreatment('Medical Devices', 'Digital thermometer')).toBe('standard');
    expect(suggestVatTreatment('Baby Products')).toBe('standard');
  });

  it('treats mosquito nets as exempt in their own right', () => {
    expect(suggestVatTreatment('General', 'Insecticide-treated mosquito net')).toBe('exempt');
  });

  it('falls back to exempt when there is no clear signal', () => {
    expect(suggestVatTreatment(null, null)).toBe('exempt');
    expect(suggestVatTreatment('')).toBe('exempt');
  });
});

describe('describeRates', () => {
  it('renders the statutory rates for a receipt footer', () => {
    expect(describeRates()).toEqual(['VAT 15%', 'NHIL 2.5%', 'GETFund Levy 2.5%']);
  });
});
