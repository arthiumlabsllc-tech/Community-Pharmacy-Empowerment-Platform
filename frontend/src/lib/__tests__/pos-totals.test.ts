import { priceOfflineBasket, type OfflineItem, type OfflineTaxSettings } from '../offline/pricing';
import { buildTotalsView } from '../pos-totals';
import type { Quote, QuoteLine } from '../pos-types';

/**
 * The totals panel, and the two sources that feed it.
 *
 * The behaviour worth pinning is what the panel does NOT show. A server quote
 * carries a VAT / NHIL / GETFund split; the offline pricer deliberately produces
 * no split at all. If the panel filled the gap with a zero, an offline receipt
 * would read "no tax was charged" on a standard-rated sale — a false statement
 * to a customer and to GRA. So the offline view says `tax: null`, and these
 * tests hold that line.
 */

const INCLUSIVE: OfflineTaxSettings = { vatRegistered: true, pricingMode: 'inclusive' };

function quoteLine(overrides: Partial<QuoteLine> = {}): QuoteLine {
  return {
    inventory_id: 'inv-1',
    product_name: 'Paracetamol 500mg',
    generic_name: null,
    batch_number: null,
    expiry_date: null,
    requires_prescription: false,
    quantity: 2,
    sell_unit: 'pack',
    unit_price: 12.5,
    discount_amount: 0,
    line_total: 25,
    vat_treatment: 'exempt',
    taxable_base: 0,
    vat_amount: 0,
    nhil_amount: 0,
    getfund_amount: 0,
    quantity_available: 10,
    oversold: false,
    ...overrides,
  };
}

function quote(overrides: Partial<Quote> = {}): Quote {
  return {
    pricing_mode: 'inclusive',
    vat_registered: true,
    rate_snapshot: {
      vat: 0.15,
      nhil: 0.025,
      getfund: 0.025,
      vat_registered: true,
      pricing_mode: 'inclusive',
    },
    lines: [quoteLine()],
    summary: {
      subtotal: 25,
      discount_amount: 0,
      taxable_base: 0,
      exempt_amount: 25,
      vat_amount: 0,
      nhil_amount: 0,
      getfund_amount: 0,
      total_tax: 0,
      total_amount: 25,
    },
    ...overrides,
  };
}

function offlineItem(overrides: Partial<OfflineItem> = {}): OfflineItem {
  return {
    inventoryId: 'inv-1',
    productName: 'Paracetamol 500mg',
    quantity: 2,
    unitPrice: 12.5,
    vatTreatment: 'exempt',
    ...overrides,
  };
}

describe('buildTotalsView from the server', () => {
  it('reads the summary and keys the lines so the basket can render against them', () => {
    const view = buildTotalsView({
      source: 'server',
      quote: quote({
        lines: [quoteLine(), quoteLine({ inventory_id: 'inv-2', line_total: 8 })],
        summary: {
          subtotal: 33,
          discount_amount: 3,
          taxable_base: 30,
          exempt_amount: 0,
          vat_amount: 4.5,
          nhil_amount: 0.75,
          getfund_amount: 0.75,
          total_tax: 6,
          total_amount: 36,
        },
      }),
    });

    expect(view).toMatchObject({
      priced: true,
      provisional: false,
      subtotal: 33,
      discount: 3,
      tax: 6,
      taxLabel: 'Tax included',
      total: 36,
    });
    expect(view.lines['inv-2']).toMatchObject({ lineTotal: 8, oversold: false });
  });

  it('labels the tax row as an addition only when pricing is exclusive', () => {
    const summary = quote().summary;
    const taxed = { ...summary, total_tax: 6, total_amount: 36 };

    expect(
      buildTotalsView({ source: 'server', quote: quote({ summary: taxed }) }).taxLabel
    ).toBe('Tax included');
    expect(
      buildTotalsView({
        source: 'server',
        quote: quote({ pricing_mode: 'exclusive', summary: taxed }),
      }).taxLabel
    ).toBe('VAT + NHIL + GETFund');
    // No tax on the basket, no row to caption — an exempt-only sale.
    expect(buildTotalsView({ source: 'server', quote: quote() }).taxLabel).toBeNull();
  });

  it('names what the shelf cannot cover, so the till can refuse before charging', () => {
    const view = buildTotalsView({
      source: 'server',
      quote: quote({
        lines: [
          quoteLine({ oversold: true, quantity_available: 1 }),
          quoteLine({ inventory_id: 'inv-2', product_name: 'ORS Sachet' }),
        ],
      }),
    });

    expect(view.oversold).toEqual([{ productName: 'Paracetamol 500mg', quantityAvailable: 1 }]);
    expect(view.lines['inv-1'].oversold).toBe(true);
    expect(view.lines['inv-2'].oversold).toBe(false);
  });

  it('says nothing is priced yet while the request is in flight', () => {
    const view = buildTotalsView({ source: 'server', quote: null, pending: true, quoteError: 'Boom' });

    // An error from a previous attempt must not be shown as the answer to a
    // request that has not come back yet.
    expect(view).toMatchObject({ priced: false, pending: true, refusal: null });
  });

  it('shows the server\'s own words when it could not price the basket', () => {
    const view = buildTotalsView({
      source: 'server',
      quote: null,
      quoteError: 'Prescription items must be approved by a pharmacist',
    });

    expect(view.priced).toBe(false);
    expect(view.refusal).toBe('Prescription items must be approved by a pharmacist');
  });

  it('tolerates money arriving as a string, which is what NUMERIC does', () => {
    const view = buildTotalsView({
      source: 'server',
      quote: quote({
        summary: { ...quote().summary, total_amount: '25.00' as unknown as number },
      }),
    });

    expect(view.total).toBe(25);
  });
});

describe('buildTotalsView from this device', () => {
  it('prices a basket and reports the total without inventing a split', () => {
    const view = buildTotalsView({
      source: 'device',
      offlineQuote: priceOfflineBasket([offlineItem()], INCLUSIVE, { userRole: 'pharmacist' }),
      taxSettings: INCLUSIVE,
    });

    expect(view).toMatchObject({ priced: true, provisional: true, subtotal: 25, total: 25 });
    expect(view.tax).toBeNull();
    expect(view.taxLabel).toBeNull();
    expect(view.lines['inv-1']).toMatchObject({ lineTotal: 25, oversold: false });
  });

  it('still shows no split when the pharmacy prices tax-exclusive', () => {
    const settings: OfflineTaxSettings = { vatRegistered: true, pricingMode: 'exclusive' };
    const view = buildTotalsView({
      source: 'device',
      offlineQuote: priceOfflineBasket(
        [offlineItem({ unitPrice: 10, quantity: 1, vatTreatment: 'standard' })],
        settings,
        { userRole: 'pharmacist' }
      ),
      taxSettings: settings,
    });

    // 10 plus the 20% combined burden, with the breakdown left to the server.
    expect(view.total).toBe(12);
    expect(view.subtotal).toBe(10);
    expect(view.tax).toBeNull();
    expect(view.pricingMode).toBe('exclusive');
    expect(view.warnings.join(' ')).toMatch(/breakdown will appear on the receipt/);
  });

  it('takes the tax position from the settings it priced from, not from a default', () => {
    const settings: OfflineTaxSettings = { vatRegistered: false, pricingMode: 'inclusive' };
    const view = buildTotalsView({
      source: 'device',
      offlineQuote: priceOfflineBasket([offlineItem()], settings, { userRole: 'pharmacist' }),
      taxSettings: settings,
    });

    expect(view.vatRegistered).toBe(false);
  });

  it('passes the pricer\'s refusal straight through', () => {
    const view = buildTotalsView({
      source: 'device',
      offlineQuote: priceOfflineBasket([offlineItem()], INCLUSIVE, { basketDiscount: 5 }),
      taxSettings: INCLUSIVE,
    });

    expect(view.priced).toBe(false);
    expect(view.refusal).toMatch(/Discounts are not available while offline/);
    expect(view.total).toBe(0);
  });

  it('never reports a cached quantity as oversold', () => {
    const view = buildTotalsView({
      source: 'device',
      offlineQuote: priceOfflineBasket([offlineItem({ quantity: 500 })], INCLUSIVE, {
        userRole: 'pharmacist',
      }),
      taxSettings: INCLUSIVE,
    });

    // The device does not know the shelf. An offline sale may take stock below
    // zero and the server reports the shortfall when it syncs.
    expect(view.oversold).toEqual([]);
    expect(view.lines['inv-1'].quantityAvailable).toBeNull();
  });

  it('ignores a server quote that arrived before the connection dropped', () => {
    const view = buildTotalsView({
      source: 'device',
      quote: quote({ summary: { ...quote().summary, total_amount: 999 } }),
      offlineQuote: priceOfflineBasket([offlineItem()], INCLUSIVE, { userRole: 'pharmacist' }),
      taxSettings: INCLUSIVE,
    });

    // A stale total the server has not re-checked is worse than no total.
    expect(view.total).toBe(25);
  });

  it('has nothing to show when the basket is empty', () => {
    const view = buildTotalsView({ source: 'device', offlineQuote: null, taxSettings: INCLUSIVE });

    expect(view).toMatchObject({ priced: false, refusal: null, provisional: true, total: 0 });
  });
});
