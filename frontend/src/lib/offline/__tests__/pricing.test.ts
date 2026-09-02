import vectors from '../pricing-vectors.json';
import {
  GHANA_TAX_RATES,
  priceOfflineBasket,
  resolveOfflineRates,
  round2,
  toOfflineVatTreatment,
  type OfflineItem,
  type OfflineTaxSettings,
} from '../pricing';
import type { PricingMode, VatTreatment } from '../../pos-types';

/**
 * The other half of the offline parity contract.
 *
 * `pricing-vectors.json` holds worked baskets and what the REAL server engine
 * in backend/src/utils/ghana-tax.ts produces for them. That file is generated
 * by `npm run parity:emit` in the backend and re-verified there on every test
 * run. This suite holds the offline pricer to the same numbers.
 *
 * So the two implementations cannot drift apart quietly: change the server
 * engine and the backend suite fails until the fixture is regenerated; change
 * the fixture and this suite fails until the offline pricer agrees. The thing
 * being protected is what a customer is charged while a pharmacy has no
 * internet, which is not something to discover from a receipt after the fact.
 */

interface VectorItem {
  quantity: number;
  unitPrice: number;
  vatTreatment: string;
}

interface VectorExpectation {
  lineTotals: number[];
  amountsDue: number[];
  subtotal: number;
  grandTotal: number;
  taxableBase: number;
  exemptAmount: number;
  vat: number;
  nhil: number;
  getfund: number;
  totalTax: number;
}

interface Vector {
  id: string;
  description: string;
  settings: {
    vatRegistered: boolean;
    pricingMode: string;
    rates: Record<string, number> | null;
  };
  items: VectorItem[];
  expected: VectorExpectation | null;
}

const parityVectors = (vectors as unknown as { vectors: Vector[] }).vectors;

const toItems = (vector: Vector): OfflineItem[] =>
  vector.items.map((item, index) => ({
    inventoryId: null,
    productName: `Line ${index + 1}`,
    quantity: item.quantity,
    unitPrice: item.unitPrice,
    // Passed through raw on purpose: the pricer has to apply the same
    // normalisation the server does, including for the junk-treatment vector.
    vatTreatment: item.vatTreatment as VatTreatment,
  }));

const toSettings = (vector: Vector): OfflineTaxSettings => ({
  vatRegistered: vector.settings.vatRegistered,
  pricingMode: vector.settings.pricingMode as PricingMode,
  rates: vector.settings.rates,
});

describe('the parity fixture', () => {
  it('is shared with the backend rather than copied', () => {
    // A second copy of these numbers would let the two sides agree with
    // themselves and disagree with each other.
    expect(parityVectors.length).toBeGreaterThanOrEqual(15);
    expect(parityVectors.every((vector) => vector.expected !== null)).toBe(true);
  });
});

describe('priceOfflineBasket agrees with the server engine', () => {
  it.each(parityVectors.map((vector) => [vector.id, vector] as const))(
    '%s',
    (_id, vector) => {
      const expected = vector.expected!;
      const quote = priceOfflineBasket(toItems(vector), toSettings(vector));

      expect(quote.priced).toBe(true);
      expect(quote.lines.map((line) => line.lineTotal)).toEqual(expected.lineTotals);
      expect(quote.lines.map((line) => line.amountDue)).toEqual(expected.amountsDue);
      expect(quote.subtotal).toBe(expected.subtotal);
      expect(quote.grandTotal).toBe(expected.grandTotal);
    }
  );
});

describe('what the offline pricer refuses to do', () => {
  const settings: OfflineTaxSettings = {
    vatRegistered: true,
    pricingMode: 'inclusive',
    rates: null,
  };
  const medicine: OfflineItem = {
    inventoryId: 'item-1',
    productName: 'Amoxicillin 500mg',
    quantity: 1,
    unitPrice: 24,
    vatTreatment: 'exempt',
  };

  it('never produces a tax split', () => {
    const quote = priceOfflineBasket([medicine], settings);
    // Typed null so a receipt cannot render a statutory breakdown built from a
    // cached classification the pharmacy may have changed elsewhere.
    expect(quote.taxSplit).toBeNull();
  });

  it('refuses a discounted basket instead of mispricing it', () => {
    const quote = priceOfflineBasket([medicine], settings, { basketDiscount: 5 });

    expect(quote.priced).toBe(false);
    expect(quote.grandTotal).toBe(0);
    expect(quote.refusalReason).toMatch(/discount/i);
    // The reason has to say what to do about it, not just what went wrong.
    expect(quote.refusalReason).toMatch(/remove the discount/i);
  });

  it('treats a discount below a pesewa as no discount', () => {
    expect(priceOfflineBasket([medicine], settings, { basketDiscount: 0.001 }).priced).toBe(true);
    expect(priceOfflineBasket([medicine], settings, { basketDiscount: -5 }).priced).toBe(true);
  });

  it('refuses when no tax settings have ever been cached', () => {
    const quote = priceOfflineBasket([medicine], null);

    expect(quote.priced).toBe(false);
    expect(quote.refusalReason).toMatch(/never loaded the tax settings/i);
  });

  it('refuses an empty basket', () => {
    expect(priceOfflineBasket([], settings).priced).toBe(false);
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['not a number', NaN],
  ])('refuses a %s quantity', (_label, quantity) => {
    const quote = priceOfflineBasket([{ ...medicine, quantity }], settings);
    expect(quote.priced).toBe(false);
    expect(quote.refusalReason).toMatch(/quantity/i);
  });

  it('floors a fractional quantity the way the server does', () => {
    // buildLine uses Math.floor, so 2.9 packs is 2 packs. Guessing differently
    // here would quote a total the server then rejects.
    const quote = priceOfflineBasket([{ ...medicine, quantity: 2.9 }], settings);
    expect(quote.priced).toBe(true);
    expect(quote.lines[0].quantity).toBe(2);
    expect(quote.grandTotal).toBe(48);
  });

  it('refuses the server quantity ceiling', () => {
    const quote = priceOfflineBasket([{ ...medicine, quantity: 10001 }], settings);
    expect(quote.priced).toBe(false);
    expect(quote.refusalReason).toMatch(/unrealistically large/i);
  });

  it.each([
    ['negative', -1],
    ['not a number', NaN],
  ])('refuses a %s unit price', (_label, unitPrice) => {
    const quote = priceOfflineBasket([{ ...medicine, unitPrice }], settings);
    expect(quote.priced).toBe(false);
    expect(quote.refusalReason).toMatch(/price is required/i);
  });

  it('allows a free line alongside a paid one, because a pharmacy does give away samples', () => {
    const quote = priceOfflineBasket([{ ...medicine, unitPrice: 0 }, medicine], settings);

    expect(quote.priced).toBe(true);
    expect(quote.lines.map((line) => line.lineTotal)).toEqual([0, 24]);
    expect(quote.grandTotal).toBe(24);
  });

  it('refuses a basket that totals zero', () => {
    // The server throws "The sale total must be greater than zero", so quoting
    // it here would only queue a sale guaranteed to bounce on sync.
    const quote = priceOfflineBasket([{ ...medicine, unitPrice: 0 }], settings);

    expect(quote.priced).toBe(false);
    expect(quote.refusalReason).toMatch(/greater than zero/i);
  });

  it('refuses prescription-only medicine to a cashier', () => {
    const script: OfflineItem = { ...medicine, requiresPrescription: true };

    const quote = priceOfflineBasket([script], settings, { userRole: 'cashier' });

    expect(quote.priced).toBe(false);
    expect(quote.refusalReason).toMatch(/pharmacist/i);
  });

  it.each(['pharmacist', 'pharmacy_owner', 'super_admin'])(
    'allows prescription-only medicine to a %s',
    (role) => {
      const script: OfflineItem = { ...medicine, requiresPrescription: true };
      const quote = priceOfflineBasket([script], settings, { userRole: role });

      expect(quote.priced).toBe(true);
      expect(quote.warnings.join(' ')).toMatch(/prescription/i);
    }
  );

  it('refuses prescription-only medicine when nobody is signed in', () => {
    const script: OfflineItem = { ...medicine, requiresPrescription: true };
    expect(priceOfflineBasket([script], settings).priced).toBe(false);
  });
});

describe('the rate handling matches the server', () => {
  it('falls back to the statutory rates', () => {
    expect(resolveOfflineRates(null)).toEqual(GHANA_TAX_RATES);
    expect(resolveOfflineRates(undefined)).toEqual(GHANA_TAX_RATES);
  });

  it('honours an override inside the plausible range', () => {
    expect(resolveOfflineRates({ vat: 0.1 }).vat).toBe(0.1);
    expect(resolveOfflineRates({ vat: 0 }).vat).toBe(0);
    expect(resolveOfflineRates({ vat: 0.5 }).vat).toBe(0.5);
  });

  it.each([
    ['500%', 5],
    ['negative', -1],
    ['not a number', NaN],
    ['infinity', Infinity],
    ['a string', '0.15' as unknown as number],
  ])('discards a %s rate rather than charging it', (_label, vat) => {
    // The server's pickRate rejects anything outside 0..0.5. Trusting a typo in
    // the settings JSONB would multiply what the customer pays.
    expect(resolveOfflineRates({ vat }).vat).toBe(GHANA_TAX_RATES.vat);
  });

  it('rounds exactly as the server does', () => {
    expect(round2(19.99 * 3)).toBe(59.97);
    expect(round2(1.005)).toBe(1.01);
    expect(round2(2.675)).toBe(2.68);
    expect(round2(NaN)).toBe(0);
    expect(round2(Infinity)).toBe(0);
  });

  it('normalises an unknown classification to exempt, as the server does', () => {
    expect(toOfflineVatTreatment('standard')).toBe('standard');
    expect(toOfflineVatTreatment('zero_rated')).toBe('zero_rated');
    expect(toOfflineVatTreatment('exempt')).toBe('exempt');
    expect(toOfflineVatTreatment('STANDARD')).toBe('exempt');
    expect(toOfflineVatTreatment(null)).toBe('exempt');
    expect(toOfflineVatTreatment(undefined)).toBe('exempt');
    expect(toOfflineVatTreatment('')).toBe('exempt');
  });
});

describe('what the cashier is told', () => {
  const standard: OfflineItem = {
    inventoryId: 'item-2',
    productName: 'Sunscreen SPF50',
    quantity: 1,
    unitPrice: 60,
    vatTreatment: 'standard',
  };

  it('always says the total is provisional and the server has the final word', () => {
    const quote = priceOfflineBasket([standard], {
      vatRegistered: true,
      pricingMode: 'inclusive',
      rates: null,
    });

    expect(quote.warnings[0]).toMatch(/provisional/i);
    expect(quote.warnings[0]).toMatch(/re-prices/i);
  });

  it('explains the uplift when the pharmacy prices tax-exclusive', () => {
    const quote = priceOfflineBasket([standard], {
      vatRegistered: true,
      pricingMode: 'exclusive',
      rates: null,
    });

    expect(quote.grandTotal).toBe(72);
    expect(quote.warnings.join(' ')).toMatch(/tax-exclusive/i);
  });

  it('says plainly when no VAT has been charged because the pharmacy is unregistered', () => {
    const quote = priceOfflineBasket([standard], {
      vatRegistered: false,
      pricingMode: 'exclusive',
      rates: null,
    });

    expect(quote.grandTotal).toBe(60);
    expect(quote.warnings.join(' ')).toMatch(/not VAT registered/i);
  });

  it('gives a refusal no warnings, because there is nothing to qualify', () => {
    const quote = priceOfflineBasket([], {
      vatRegistered: true,
      pricingMode: 'inclusive',
      rates: null,
    });

    expect(quote.priced).toBe(false);
    expect(quote.warnings).toEqual([]);
    expect(quote.lines).toEqual([]);
  });
});
