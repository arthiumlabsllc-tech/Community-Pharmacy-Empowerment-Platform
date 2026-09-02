import type { PosProduct } from '../../pos-types';
import {
  cacheAge,
  cachedCatalogue,
  cachedProduct,
  cachedTaxSettings,
  canSellOffline,
  rememberCatalogue,
  rememberTaxSettings,
} from '../catalogue';
import { resetDatabaseHandle } from '../db';
import { installFakeIndexedDb, type FakeIndexedDb } from './fake-indexed-db';

/**
 * What the till can sell with no connection.
 *
 * The two behaviours worth pinning are the ones that fail silently in the field:
 * a stale product left in the cache that the server will later reject, and a
 * device that has never loaded tax settings pricing a sale on a guess. Both are
 * invisible until a customer is standing at the counter.
 */

let fake: FakeIndexedDb;

function product(overrides: Partial<PosProduct> = {}): PosProduct {
  return {
    id: 'inv-1',
    product_name: 'Paracetamol 500mg',
    generic_name: 'Paracetamol',
    product_code: 'PARA-500',
    barcode: null,
    category: 'Analgesic',
    manufacturer: 'Lab A',
    unit_price: '12.50',
    cost_price: '8.00',
    quantity: 40,
    reorder_level: 10,
    batch_number: 'B-100',
    expiry_date: '2027-03-31',
    requires_prescription: false,
    vat_treatment: 'exempt',
    pack_size: 1,
    default_sell_unit: 'pack',
    shelf_location: 'A3',
    needs_reorder: false,
    is_expired: false,
    near_expiry: false,
    ...overrides,
  };
}

beforeEach(() => {
  fake = installFakeIndexedDb();
  resetDatabaseHandle();
});

afterEach(() => {
  resetDatabaseHandle();
  fake.restore();
});

describe('rememberCatalogue', () => {
  it('stores the price as a number, because Postgres NUMERIC arrives as a string', async () => {
    await rememberCatalogue([product({ unit_price: '12.50' })]);

    const cached = await cachedProduct('inv-1');
    expect(cached!.unit_price).toBe(12.5);
    expect(typeof cached!.unit_price).toBe('number');
  });

  it('does not let a nonsense price into the cache as NaN', async () => {
    await rememberCatalogue([product({ unit_price: '' })]);

    expect((await cachedProduct('inv-1'))!.unit_price).toBe(0);
  });

  it('keeps the VAT classification and the prescription flag, which the pricer refuses to guess', async () => {
    await rememberCatalogue([
      product({ id: 'inv-2', vat_treatment: 'standard', requires_prescription: true }),
    ]);

    expect(await cachedProduct('inv-2')).toMatchObject({
      vat_treatment: 'standard',
      requires_prescription: true,
    });
  });

  it('drops a product that is no longer in the catalogue, so it cannot be sold offline and rejected later', async () => {
    await rememberCatalogue([
      product({ id: 'inv-1', product_name: 'Paracetamol 500mg' }),
      product({ id: 'inv-2', product_name: 'Delisted syrup' }),
    ]);
    expect(await cachedCatalogue()).toHaveLength(2);

    await rememberCatalogue([product({ id: 'inv-1', product_name: 'Paracetamol 500mg' })]);

    const cached = await cachedCatalogue();
    expect(cached.map((item) => item.id)).toEqual(['inv-1']);
    expect(await cachedProduct('inv-2')).toBeUndefined();
  });

  it('refuses to prune the cache away on an empty response, which is far more likely to be a failed fetch', async () => {
    await rememberCatalogue([product()]);

    expect(await rememberCatalogue([])).toBe(0);
    expect(await cachedCatalogue()).toHaveLength(1);
  });

  it('returns how many products the till can now sell offline', async () => {
    expect(await rememberCatalogue([product(), product({ id: 'inv-2' })])).toBe(2);
  });

  it('lists them by name, because that is how a cashier looks for one', async () => {
    await rememberCatalogue([
      product({ id: 'inv-1', product_name: 'Zinc tablets' }),
      product({ id: 'inv-2', product_name: 'Amoxicillin 250mg' }),
    ]);

    const cached = await cachedCatalogue();
    expect(cached.map((item) => item.product_name)).toEqual(['Amoxicillin 250mg', 'Zinc tablets']);
  });
});

describe('rememberTaxSettings', () => {
  it('stores the settings the pricer needs, and when it last heard them', async () => {
    const stored = await rememberTaxSettings({
      vat_registered: true,
      pricing_mode: 'exclusive',
      rates: null,
    });

    expect(stored).toMatchObject({ vatRegistered: true, pricingMode: 'exclusive', rates: null });
    expect(stored.cachedAt).toBeTruthy();
    expect(await cachedTaxSettings()).toMatchObject({ pricingMode: 'exclusive' });
  });

  it('falls back to the Ghanaian retail default when the server sends something unrecognised', async () => {
    const stored = await rememberTaxSettings({
      vat_registered: true,
      pricing_mode: 'sideways' as 'inclusive',
      rates: null,
    });

    expect(stored.pricingMode).toBe('inclusive');
  });

  it('treats the pharmacy as registered unless the server says otherwise in so many words', async () => {
    expect(
      await rememberTaxSettings({
        vat_registered: undefined as unknown as boolean,
        pricing_mode: 'inclusive',
        rates: null,
      })
    ).toMatchObject({ vatRegistered: true });

    expect(
      await rememberTaxSettings({
        vat_registered: false,
        pricing_mode: 'inclusive',
        rates: null,
      })
    ).toMatchObject({ vatRegistered: false });
  });

  it('replaces the previous settings rather than keeping both', async () => {
    await rememberTaxSettings({ vat_registered: true, pricing_mode: 'inclusive', rates: null });
    await rememberTaxSettings({ vat_registered: false, pricing_mode: 'exclusive', rates: null });

    expect(await cachedTaxSettings()).toMatchObject({ vatRegistered: false, pricingMode: 'exclusive' });
  });
});

describe('a device that has never been online', () => {
  it('has no tax settings, and says so rather than returning a default', async () => {
    expect(await cachedTaxSettings()).toBeNull();
  });

  it('has no stock, and reports both gaps with an instruction rather than a shrug', async () => {
    expect(await canSellOffline()).toEqual({
      ready: false,
      products: 0,
      reason: 'Tax settings have never been loaded on this device. Open the till once while online.',
    });
  });

  it('reports an unknown cache age rather than claiming a fresh one', async () => {
    expect(await cacheAge()).toEqual({ catalogue: null, tax: null });
  });
});

describe('canSellOffline', () => {
  it('still refuses when stock is cached but the tax position is not known', async () => {
    await rememberCatalogue([product()]);

    const verdict = await canSellOffline();
    expect(verdict).toMatchObject({ ready: false, products: 1 });
    expect(verdict.reason).toContain('Tax settings');
  });

  it('still refuses when the tax position is known but nothing is cached', async () => {
    await rememberTaxSettings({ vat_registered: true, pricing_mode: 'inclusive', rates: null });

    const verdict = await canSellOffline();
    expect(verdict).toMatchObject({ ready: false, products: 0 });
    expect(verdict.reason).toContain('No products are cached');
  });

  it('is ready once both are present', async () => {
    await rememberCatalogue([product(), product({ id: 'inv-2' })]);
    await rememberTaxSettings({ vat_registered: true, pricing_mode: 'inclusive', rates: null });

    expect(await canSellOffline()).toEqual({ ready: true, products: 2, reason: null });
  });
});

describe('cacheAge', () => {
  it('says how long the device has been relying on cached prices', async () => {
    await rememberCatalogue([product()]);
    await rememberTaxSettings({ vat_registered: true, pricing_mode: 'inclusive', rates: null });

    const age = await cacheAge();
    expect(age.catalogue).toBeGreaterThanOrEqual(0);
    expect(age.tax).toBeGreaterThanOrEqual(0);
  });

  it('reports each cache separately, since one can be fresh while the other is stale', async () => {
    await rememberCatalogue([product()]);

    const age = await cacheAge();
    expect(age.catalogue).toBeGreaterThanOrEqual(0);
    expect(age.tax).toBeNull();
  });
});
