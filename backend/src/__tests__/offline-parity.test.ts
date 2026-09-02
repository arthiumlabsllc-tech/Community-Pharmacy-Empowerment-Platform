import { expectedForVector, loadParityVectors, VECTORS_PATH } from '../utils/offline-parity';
import { computeSaleTax, round2, toVatTreatment } from '../utils/ghana-tax';

/**
 * Half of the offline parity contract.
 *
 * frontend/src/lib/offline/pricing.ts prices a basket while the pharmacy is
 * disconnected. This suite proves the fixture it is held to still describes
 * what the server engine actually does, so the two cannot drift apart without
 * a build failing on one side or the other.
 */

const vectors = loadParityVectors();

describe('the parity fixture itself', () => {
  it('loads from the frontend, so both packages are pinned to one file', () => {
    expect(VECTORS_PATH.replace(/\\/g, '/')).toContain(
      'frontend/src/lib/offline/pricing-vectors.json'
    );
  });

  it('has enough vectors to be worth calling a contract', () => {
    expect(vectors.length).toBeGreaterThanOrEqual(15);
  });

  it('gives every vector a unique id', () => {
    const ids = vectors.map((vector) => vector.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has a generated expectation for every vector — a null means parity:emit was not run', () => {
    const missing = vectors.filter((vector) => !vector.expected).map((vector) => vector.id);
    expect(missing).toEqual([]);
  });
});

describe('the server engine still produces the stored expectations', () => {
  it.each(vectors.map((vector) => [vector.id, vector] as const))(
    '%s',
    (_id, vector) => {
      expect(expectedForVector(vector)).toEqual(vector.expected);
    }
  );
});

describe('the offline-relevant guarantees behind those numbers', () => {
  const byId = new Map(vectors.map((vector) => [vector.id, vector]));
  const expectation = (id: string) => {
    const vector = byId.get(id);
    if (!vector || !vector.expected) throw new Error(`Unknown vector ${id}`);
    return vector.expected;
  };

  it('tax-inclusive pricing never changes what the customer pays', () => {
    // The shelf price is the gross. The tax is backed out for the return, not
    // added on at the counter, so amountDue equals lineTotal on every line.
    for (const id of ['inclusive-all-exempt', 'inclusive-all-standard', 'inclusive-mixed-basket']) {
      const expected = expectation(id);
      expect(expected.amountsDue).toEqual(expected.lineTotals);
      expect(expected.grandTotal).toBe(expected.subtotal);
    }
  });

  it('tax-exclusive pricing adds the full 20% burden to a standard-rated line', () => {
    const expected = expectation('exclusive-all-standard');
    expect(expected.lineTotals).toEqual([50, 39.95]);
    expect(expected.amountsDue).toEqual([60, 47.94]);
    expect(expected.grandTotal).toBe(107.94);
  });

  it('leaves exempt and zero-rated lines alone even under exclusive pricing', () => {
    const expected = expectation('exclusive-mixed-basket');
    expect(expected.amountsDue[0]).toBe(42); // exempt medicine
    expect(expected.amountsDue[1]).toBe(32.4); // 27.00 standard, x1.20
    expect(expected.amountsDue[2]).toBe(6.6); // zero rated
  });

  it('charges nothing at all below the GHS 750,000 registration threshold', () => {
    for (const id of ['unregistered-inclusive', 'unregistered-exclusive']) {
      const expected = expectation(id);
      expect(expected.totalTax).toBe(0);
      expect(expected.grandTotal).toBe(expected.subtotal);
    }
  });

  it('does not multiply up an unregistered pharmacy that happens to price tax-exclusive', () => {
    // The trap: pricingMode says "add the tax", registration says "you may not".
    // Registration wins, or the pharmacy overcharges and owes GRA a return it
    // was never required to file.
    const expected = expectation('unregistered-exclusive');
    expect(expected.amountsDue).toEqual([36]);
    expect(expected.vat).toBe(0);
  });

  it('reports the whole value of an unregistered pharmacy as exempt', () => {
    const expected = expectation('unregistered-exclusive');
    expect(expected.taxableBase).toBe(0);
    expect(expected.exemptAmount).toBe(36);
  });

  it('rounds quantity x unit price once, not twice', () => {
    // 3 x 3.333 = 9.999 -> 10.00. Rounding the unit price to 3.33 first would
    // give 9.99, and the offline till would charge a pesewa less than the
    // server records.
    expect(expectation('fractional-unit-price-inclusive').lineTotals).toEqual([10]);
    expect(round2(3 * 3.333)).toBe(10);
    expect(round2(3 * round2(3.333))).toBe(9.99);
  });

  it('keeps a one-pesewa sale above zero', () => {
    const expected = expectation('single-pesewa');
    expect(expected.lineTotals).toEqual([0.01]);
    expect(expected.amountsDue).toEqual([0.01]);
    expect(expected.grandTotal).toBeGreaterThan(0);
  });

  it('sums the ROUNDED lines, so a twelve-line basket still foots', () => {
    const expected = expectation('large-basket-drift');
    const naiveSum = expected.amountsDue.reduce((total, value) => total + value, 0);
    expect(expected.grandTotal).toBe(round2(naiveSum));
    expect(expected.amountsDue).toHaveLength(12);
  });

  it('honours a stored rate override that is within bounds', () => {
    // 10% + 2.5% + 2.5% = 15% on 100.00
    const expected = expectation('rate-override-within-bounds');
    expect(expected.amountsDue).toEqual([115]);
    expect(expected.vat).toBe(10);
  });

  it('discards a stored rate that cannot be a real rate', () => {
    // vat 5 and nhil -1 are both outside 0..0.5, so the statutory rates apply.
    // Trusting the stored values would have charged GHS 500 of VAT on GHS 100.
    const expected = expectation('rate-override-out-of-bounds');
    expect(expected.amountsDue).toEqual([120]);
    expect(expected.vat).toBe(15);
    expect(expected.nhil).toBe(2.5);
    expect(expected.getfund).toBe(2.5);
  });

  it('charges nothing when every rate is stored as zero', () => {
    const expected = expectation('zero-rates-override');
    expect(expected.amountsDue).toEqual([100]);
    expect(expected.totalTax).toBe(0);
  });

  it('treats an unrecognised classification as exempt', () => {
    expect(toVatTreatment('unknown')).toBe('exempt');
    expect(toVatTreatment(null)).toBe('exempt');
    expect(toVatTreatment(undefined)).toBe('exempt');
    expect(toVatTreatment('STANDARD')).toBe('exempt');
    expect(expectation('unclassified-stock').totalTax).toBe(0);
  });

  it('agrees with a direct call to the engine, not just with the fixture', () => {
    // Guards expectedForVector itself: if it ever stopped calling computeSaleTax
    // the whole contract would be decorative.
    const vector = byId.get('inclusive-mixed-basket')!;
    const direct = computeSaleTax(
      vector.items.map((item) => ({
        lineTotal: round2(item.quantity * item.unitPrice),
        vatTreatment: toVatTreatment(item.vatTreatment),
      })),
      {
        pricingMode: 'inclusive',
        rates: vector.settings.rates,
        vatRegistered: vector.settings.vatRegistered,
      }
    );

    expect(direct.grandTotal).toBe(vector.expected!.grandTotal);
    expect(direct.lines.map((line) => line.grossTotal)).toEqual(vector.expected!.amountsDue);
  });
});
