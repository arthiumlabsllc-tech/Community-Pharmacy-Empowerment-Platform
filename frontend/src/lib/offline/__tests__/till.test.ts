import {
  cachedCatalogue,
  cachedPaymentConfig,
  cachedTaxSettings,
  rememberCatalogue,
  rememberPaymentConfig,
} from '../catalogue';
import { resetDatabaseHandle } from '../db';
import { priceOfflineBasket, type OfflineItem, type OfflineTaxSettings } from '../pricing';
import { listQueue } from '../queue';
import {
  CACHE_MAX_PAGES,
  CACHE_PAGE_SIZE,
  GHANA_MOMO_NETWORKS,
  buildOfflineSale,
  filterOfflineCatalogue,
  offlineCategories,
  offlinePaymentOptions,
  queueOfflineSale,
  refreshOfflineCache,
} from '../till';
import type { PaymentConfig, PosProduct } from '../../pos-types';
import { installFakeIndexedDb, type FakeIndexedDb } from './fake-indexed-db';

/**
 * Selling with no connection.
 *
 * The payload is the part worth pinning hardest: it is the one place where what
 * the till records and what `POST /pos/sales` accepts have to agree, and a
 * disagreement is not discovered at the counter. It surfaces hours later when the
 * sale bounces out of the sync queue, by which time the customer has gone and
 * the cashier who rang it up has finished their shift.
 */

jest.mock('../../api', () => {
  const actual = jest.requireActual('../../api');
  return {
    __esModule: true,
    ApiError: actual.ApiError,
    isNetworkError: actual.isNetworkError,
    isOffline: actual.isOffline,
    default: {
      get: jest.fn(),
      post: jest.fn(),
      put: jest.fn(),
      delete: jest.fn(),
      fetch: jest.fn(),
    },
  };
});

import api from '../../api';

const get = api.get as unknown as jest.Mock;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const SETTINGS: OfflineTaxSettings = { vatRegistered: true, pricingMode: 'inclusive' };

let fake: FakeIndexedDb;

function item(overrides: Partial<OfflineItem> = {}): OfflineItem {
  return {
    inventoryId: '11111111-1111-4111-8111-111111111111',
    productName: 'Paracetamol 500mg',
    quantity: 2,
    unitPrice: 12.5,
    vatTreatment: 'exempt',
    ...overrides,
  };
}

function priced(items: OfflineItem[] = [item()]) {
  return priceOfflineBasket(items, SETTINGS, { userRole: 'pharmacist' });
}

function productRow(index: number): PosProduct {
  return {
    id: `product-${index}`,
    product_name: `Product ${index}`,
    generic_name: null,
    product_code: `CODE-${index}`,
    barcode: null,
    category: 'Analgesics',
    manufacturer: null,
    unit_price: '10.00',
    cost_price: '6.00',
    quantity: 5,
    reorder_level: 2,
    batch_number: null,
    expiry_date: null,
    requires_prescription: false,
    vat_treatment: 'exempt',
    pack_size: 1,
    default_sell_unit: 'pack',
    shelf_location: null,
    needs_reorder: false,
    is_expired: false,
    near_expiry: false,
  };
}

function page(rows: PosProduct[]) {
  return { success: true, data: rows };
}

const PAYMENT_CONFIG: PaymentConfig = {
  gateway: { connected: false, mode: 'manual', keyPrefix: '' },
  networks: [
    { provider: 'mtn', label: 'MTN MoMo' },
    { provider: 'vod', label: 'Telecel Cash' },
  ],
  methods: ['cash', 'momo', 'card', 'bank_transfer', 'nhis', 'credit'],
  currency: 'GHS',
  tax: { vat_registered: true, pricing_mode: 'inclusive', rates: null },
};

/** Answers the catalogue pages in order, then the payment config. */
function servePages(pages: PosProduct[][], config: PaymentConfig | null = PAYMENT_CONFIG) {
  let call = 0;
  get.mockImplementation(async (endpoint: string) => {
    if (endpoint.startsWith('/pos/payment-config')) {
      if (!config) throw new Error('Could not reach the server');
      return { success: true, data: config };
    }
    const rows = pages[call] ?? [];
    call += 1;
    return page(rows);
  });
}

beforeEach(() => {
  fake = installFakeIndexedDb();
  resetDatabaseHandle();
});

afterEach(() => {
  resetDatabaseHandle();
  fake.restore();
});

describe('buildOfflineSale', () => {
  it('sends exactly the fields POST /pos/sales accepts', () => {
    const { payload } = buildOfflineSale({
      lines: [{ inventoryId: item().inventoryId!, quantity: 2 }],
      payments: [{ method: 'cash', amount: 25 }],
      quote: priced(),
    });

    expect(Object.keys(payload).sort()).toEqual([
      'approved_by',
      'client_quoted_total',
      'client_recorded_at',
      'client_sale_id',
      'customer_name',
      'customer_phone',
      'discount_amount',
      'discount_reason',
      'items',
      'note',
      'patient_id',
      'payments',
      'recorded_offline',
    ]);
  });

  it('says the sale was recorded offline and quotes the figure the till charged', () => {
    const quote = priced();
    const { payload } = buildOfflineSale({
      lines: [{ inventoryId: item().inventoryId!, quantity: 2 }],
      payments: [{ method: 'cash', amount: quote.grandTotal }],
      quote,
    });

    expect(payload.recorded_offline).toBe(true);
    // The server re-prices and its figure wins; this is sent so a disagreement
    // is reported rather than quietly absorbed.
    expect(payload.client_quoted_total).toBe(quote.grandTotal);
    expect(quote.grandTotal).toBe(25);
  });

  it('sends only what the server reads from a line, never a price of its own', () => {
    const { payload } = buildOfflineSale({
      lines: [{ inventoryId: 'inv-1', quantity: 3 }],
      payments: [{ method: 'cash', amount: 37.5 }],
      quote: priced(),
    });

    expect(payload.items).toEqual([{ inventory_id: 'inv-1', quantity: 3 }]);
  });

  it('never sends a discount, because the till cannot price one', () => {
    const { payload } = buildOfflineSale({
      lines: [{ inventoryId: 'inv-1', quantity: 1 }],
      payments: [{ method: 'cash', amount: 12.5 }],
      quote: priced(),
    });

    expect(payload.discount_amount).toBe(0);
    expect(payload.discount_reason).toBeNull();
  });

  it('turns a blank customer field into null rather than an empty string', () => {
    const { payload } = buildOfflineSale({
      lines: [{ inventoryId: 'inv-1', quantity: 1 }],
      payments: [{ method: 'cash', amount: 12.5 }],
      quote: priced(),
      customerName: '   ',
      customerPhone: '',
      note: '  Collecting tomorrow  ',
    });

    expect(payload.customer_name).toBeNull();
    expect(payload.customer_phone).toBeNull();
    expect(payload.note).toBe('Collecting tomorrow');
  });

  it('records when the goods left the shelf, not when the sale syncs', () => {
    const { payload } = buildOfflineSale({
      lines: [{ inventoryId: 'inv-1', quantity: 1 }],
      payments: [{ method: 'cash', amount: 12.5 }],
      quote: priced(),
      recordedAt: '2026-09-01T08:15:00.000Z',
    });

    expect(payload.client_recorded_at).toBe('2026-09-01T08:15:00.000Z');
  });

  it('refuses to build from a basket the pricer refused', () => {
    const refused = priceOfflineBasket([item()], SETTINGS, { basketDiscount: 5 });
    expect(refused.priced).toBe(false);

    expect(() =>
      buildOfflineSale({
        lines: [{ inventoryId: 'inv-1', quantity: 1 }],
        payments: [{ method: 'cash', amount: 1 }],
        quote: refused,
      })
    ).toThrow(/Discounts are not available while offline/);
  });

  it('labels the item so the review screen can show it in one line', () => {
    const { label } = buildOfflineSale({
      lines: [
        { inventoryId: 'inv-1', quantity: 2 },
        { inventoryId: 'inv-2', quantity: 1 },
      ],
      payments: [{ method: 'cash', amount: 37.5 }],
      quote: priced(),
    });

    expect(label).toBe('Sale · GHS 25.00 · 3 items');
  });

  it('keeps a MoMo tender\'s number and network, which is all the proof there is', () => {
    const { payload } = buildOfflineSale({
      lines: [{ inventoryId: 'inv-1', quantity: 1 }],
      payments: [{ method: 'momo', amount: 12.5, momo_number: '0241234567', momo_network: 'mtn' }],
      quote: priced(),
    });

    expect(payload.payments).toEqual([
      {
        method: 'momo',
        amount: 12.5,
        momo_number: '0241234567',
        momo_network: 'mtn',
        email: null,
        reference: null,
      },
    ]);
  });
});

describe('queueOfflineSale', () => {
  const input = {
    lines: [{ inventoryId: 'inv-1', quantity: 2 }],
    payments: [{ method: 'cash' as const, amount: 25 }],
    quote: priced(),
  };

  it('stores one item, addressed to the sales endpoint', async () => {
    await queueOfflineSale(input);

    const queued = await listQueue();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ entity: 'sale', endpoint: '/pos/sales', method: 'POST' });
  });

  it('uses one id for the queue, the replay header and the duplicate check', async () => {
    const { item } = await queueOfflineSale(input);

    // Three separate mechanisms, one string, so a row on the review screen can
    // be found in the database by the same id.
    expect(item.id).toMatch(UUID);
    expect(item.payload.client_sale_id).toBe(item.id);
  });

  it('gives each sale its own id, so two offline sales cannot cancel each other out', async () => {
    const first = await queueOfflineSale(input);
    const second = await queueOfflineSale(input);

    expect(first.item.id).not.toBe(second.item.id);
    expect(await listQueue()).toHaveLength(2);
  });

  it('carries the basket id, so a Charge whose response was lost is not sold twice', async () => {
    // The case idempotency exists for: the request reached the server, the sale
    // was created, the response never came back, and the till dropped into
    // degraded mode with the same basket still on screen.
    const basketId = '33333333-3333-4333-8333-333333333333';

    const { item } = await queueOfflineSale({ ...input, clientSaleId: basketId });

    expect(item.id).toBe(basketId);
    expect(item.payload.client_sale_id).toBe(basketId);
  });

  it('records one sale when Record is tapped twice', async () => {
    const basketId = '44444444-4444-4444-8444-444444444444';

    await queueOfflineSale({ ...input, clientSaleId: basketId });
    await queueOfflineSale({ ...input, clientSaleId: basketId });

    // The queue keys on the id, so the second write replaces the first instead
    // of queuing the same goods again.
    expect(await listQueue()).toHaveLength(1);
  });

  it('mints its own id rather than sending one the server would reject', () => {
    // client_sale_id is validated with isUUID(); a malformed one would park the
    // item as dead hours later, long after the customer has gone.
    for (const unusable of ['local:basket', 'not-a-uuid', '', null]) {
      const { payload } = buildOfflineSale({ ...input, clientSaleId: unusable });
      expect(payload.client_sale_id).toMatch(UUID);
    }
  });

  it('refuses a stand-in stock id, which the server would reject as a malformed uuid', async () => {
    await expect(
      queueOfflineSale({
        ...input,
        lines: [{ inventoryId: 'local:not-a-real-row', quantity: 1 }],
      })
    ).rejects.toThrow(/Queued without a record to resolve local:not-a-real-row/);

    expect(await listQueue()).toHaveLength(0);
  });

  it('keeps a patient picked before the connection dropped, and refuses a stand-in', async () => {
    const { payload } = buildOfflineSale({
      ...input,
      patientId: '22222222-2222-4222-8222-222222222222',
    });
    expect(payload.patient_id).toBe('22222222-2222-4222-8222-222222222222');

    // The till cannot search for a patient offline, so a placeholder here would
    // be a sale that bounces out of the queue hours after the customer left.
    await expect(
      queueOfflineSale({ ...input, patientId: 'local:walk-in' })
    ).rejects.toThrow(/local:walk-in/);
  });
});

describe('queueOfflineSale and the cached shelf', () => {
  const stock = { ...productRow(1), id: 'inv-1', quantity: 5 };

  it('takes what was sold off the cached quantity, so the next sale sees it', async () => {
    await rememberCatalogue([stock]);

    const result = await queueOfflineSale({
      lines: [{ inventoryId: 'inv-1', quantity: 2 }],
      payments: [{ method: 'cash', amount: 25 }],
      quote: priced(),
    });

    expect(result.stockError).toBeNull();
    expect(result.stockUpdated).toBe(1);
    expect((await cachedCatalogue())[0].quantity).toBe(3);
  });

  it('lets the figure go negative rather than refusing the sale', async () => {
    await rememberCatalogue([{ ...stock, quantity: 1 }]);

    const result = await queueOfflineSale({
      lines: [{ inventoryId: 'inv-1', quantity: 4 }],
      payments: [{ method: 'cash', amount: 50 }],
      quote: priced(),
    });

    // "We sold more than we thought we had" is the honest record, and a
    // stock-take is what reconciles it. Refusing at the counter would mean
    // turning a customer away because a cached number was wrong.
    expect((await cachedCatalogue())[0].quantity).toBe(-3);
    expect(await listQueue()).toHaveLength(1);
  });

  it('still queues the sale when the product is not in the cache', async () => {
    const result = await queueOfflineSale({
      lines: [{ inventoryId: 'inv-unknown', quantity: 1 }],
      payments: [{ method: 'cash', amount: 12.5 }],
      quote: priced(),
    });

    expect(result.stockUpdated).toBe(0);
    expect(result.stockError).toBeNull();
    expect(await listQueue()).toHaveLength(1);
  });

  it('does not stamp the cache as freshly seen when only the quantity changed', async () => {
    await rememberCatalogue([stock]);
    const before = (await cachedCatalogue())[0];

    await queueOfflineSale({
      lines: [{ inventoryId: 'inv-1', quantity: 1 }],
      payments: [{ method: 'cash', amount: 12.5 }],
      quote: priced(),
    });

    // The price and the VAT classification are still exactly as old as the last
    // fetch; pretending otherwise would hide the staleness from the cashier.
    expect((await cachedCatalogue())[0].cachedAt).toBe(before.cachedAt);
  });
});

describe('refreshOfflineCache', () => {
  it('caches the stock, the tax settings and the payment methods', async () => {
    servePages([[productRow(1), productRow(2)]]);

    const result = await refreshOfflineCache();

    expect(result).toMatchObject({ products: 2, complete: true, error: null });
    expect(await cachedCatalogue()).toHaveLength(2);
    expect(await cachedTaxSettings()).toMatchObject({ vatRegistered: true, pricingMode: 'inclusive' });
    expect((await cachedPaymentConfig())!.networks).toHaveLength(2);
  });

  it('pages through a catalogue larger than one request', async () => {
    const full = Array.from({ length: CACHE_PAGE_SIZE }, (_, i) => productRow(i));
    servePages([full, [productRow(900)]]);

    const result = await refreshOfflineCache();

    expect(result.products).toBe(CACHE_PAGE_SIZE + 1);
    expect(get).toHaveBeenCalledWith(`/pos/products?limit=${CACHE_PAGE_SIZE}&offset=0`);
    expect(get).toHaveBeenCalledWith(`/pos/products?limit=${CACHE_PAGE_SIZE}&offset=${CACHE_PAGE_SIZE}`);
    expect(await cachedCatalogue()).toHaveLength(CACHE_PAGE_SIZE + 1);
  });

  it('stops asking once a page comes back short', async () => {
    servePages([[productRow(1)]]);

    await refreshOfflineCache();

    const productCalls = get.mock.calls.filter(([endpoint]) =>
      String(endpoint).startsWith('/pos/products')
    );
    expect(productCalls).toHaveLength(1);
  });

  it('keeps the previous cache when a page fails part-way through', async () => {
    // The prune is the danger: rememberCatalogue drops anything not in the list
    // it is given, so writing a half-fetched catalogue would delete the rest of
    // the pharmacy's stock from the device during the very outage the cache
    // exists for.
    await rememberCatalogue([productRow(1), productRow(2)]);

    get.mockImplementation(async (endpoint: string) => {
      if (endpoint.startsWith('/pos/products')) throw new Error('network dropped');
      return { success: true, data: PAYMENT_CONFIG };
    });

    const result = await refreshOfflineCache();

    expect(result).toMatchObject({ products: 0, complete: false });
    expect(result.error).toContain('network dropped');
    expect(await cachedCatalogue()).toHaveLength(2);
  });

  it('reports a catalogue it could not finish, rather than claiming it is complete', async () => {
    // Every page comes back full, so the loop only ever ends on its own bound.
    let served = 0;
    get.mockImplementation(async (endpoint: string) => {
      if (endpoint.startsWith('/pos/payment-config')) return { success: true, data: PAYMENT_CONFIG };
      const start = served;
      served += CACHE_PAGE_SIZE;
      return page(Array.from({ length: CACHE_PAGE_SIZE }, (_, i) => productRow(start + i)));
    });

    const result = await refreshOfflineCache();

    expect(result.complete).toBe(false);
    expect(result.error).toBeNull();
    expect(result.products).toBe(CACHE_PAGE_SIZE * CACHE_MAX_PAGES);
    expect(await cachedCatalogue()).toHaveLength(CACHE_PAGE_SIZE * CACHE_MAX_PAGES);
  });

  it('says the stock is cached but not usable when the tax settings could not be fetched', async () => {
    servePages([[productRow(1)]], null);

    const result = await refreshOfflineCache();

    // Two different situations, told apart: this device can show stock and a
    // price but cannot compute an amount due.
    expect(result).toMatchObject({ products: 1, complete: false });
    expect(result.error).toContain('Could not reach the server');
    expect(await cachedCatalogue()).toHaveLength(1);
    expect(await cachedTaxSettings()).toBeNull();
  });

  it('treats an empty catalogue as a failure rather than wiping the cache', async () => {
    await rememberCatalogue([productRow(1)]);
    servePages([[]]);

    const result = await refreshOfflineCache();

    expect(result.products).toBe(0);
    expect(result.error).toBe('The server returned no products to cache');
    expect(await cachedCatalogue()).toHaveLength(1);
  });
});

describe('offlinePaymentOptions', () => {
  it('withholds card, which through this app is a Paystack page it cannot reach', async () => {
    servePages([[productRow(1)]]);
    await refreshOfflineCache();

    const options = await offlinePaymentOptions();

    expect(options.methods).not.toContain('card');
    expect(options.methods).toContain('momo');
    expect(options.methods).toContain('cash');
    expect(options.networks).toHaveLength(2);
  });

  it('falls back to cash alone on a device that has never been online', async () => {
    expect(await offlinePaymentOptions()).toEqual({
      methods: ['cash'],
      networks: [],
      currency: 'GHS',
    });
  });

  it('offers the three Ghana networks when a partial cache left them out', async () => {
    await rememberPaymentConfig({ ...PAYMENT_CONFIG, networks: [] });

    const options = await offlinePaymentOptions();

    // The networks are a constant on the server too, so this is not a guess
    // about the pharmacy. Without it the MoMo form demands a network and offers
    // no way to pick one.
    expect(options.methods).toContain('momo');
    expect(options.networks).toEqual(GHANA_MOMO_NETWORKS);
  });
});

/**
 * The grid the cashier actually sees during an outage.
 *
 * Both the matching and the order have to agree with `GET /pos/products`,
 * because a till that filters differently offline is a different till: the
 * cashier who learned where a product sits in the list on Monday cannot find it
 * on Tuesday when the connection is down. The order matters for a second reason
 * — shortest-dated stock first is how the shelf gets rotated.
 */
describe('filterOfflineCatalogue', () => {
  function row(overrides: Partial<PosProduct>): PosProduct {
    return { ...productRow(0), ...overrides };
  }

  function shelf(): PosProduct[] {
    return [
      row({
        id: 'a',
        product_name: 'Amoxicillin 500mg',
        generic_name: 'Amoxicillin',
        product_code: 'AMX-500',
        barcode: '6151112223334',
        category: 'Antibiotics',
        quantity: 4,
        expiry_date: '2026-12-01',
        is_expired: false,
      }),
      row({
        id: 'b',
        product_name: 'Paracetamol 500mg',
        generic_name: 'Acetaminophen',
        product_code: 'PCM-500',
        category: 'Analgesics',
        quantity: 0,
        expiry_date: '2026-10-01',
        is_expired: false,
      }),
      row({
        id: 'c',
        product_name: 'ORS Sachet',
        generic_name: null,
        product_code: 'ORS-1',
        category: 'Analgesics',
        quantity: 12,
        expiry_date: '2025-01-01',
        is_expired: true,
      }),
      row({
        id: 'd',
        product_name: 'Vitamin C',
        generic_name: null,
        product_code: 'VIT-C',
        category: null,
        quantity: 3,
        expiry_date: null,
        is_expired: false,
      }),
    ];
  }

  const ids = (rows: PosProduct[]) => rows.map((entry) => entry.id);

  // Typed as tuples rather than left to inference: an inline mixed array would
  // widen every element to `string | string[]` and the search argument would
  // stop type-checking.
  const searchableFields: Array<[string, string, string[]]> = [
    ['the product name', 'amox', ['a']],
    ['the generic name', 'ACET', ['b']],
    ['the product code', 'ors-1', ['c']],
    ['the barcode', '6151112223334', ['a']],
  ];

  it.each(searchableFields)('searches %s, ignoring case', (_label, search, expected) => {
    expect(ids(filterOfflineCatalogue(shelf(), { search }))).toEqual(expected);
  });

  it('treats a blank search as no search at all', () => {
    expect(filterOfflineCatalogue(shelf(), { search: '   ' })).toHaveLength(4);
  });

  it('matches a category exactly, because a partial one would hide stock', () => {
    expect(ids(filterOfflineCatalogue(shelf(), { category: 'Analgesics' }))).toEqual(['b', 'c']);
    expect(filterOfflineCatalogue(shelf(), { category: 'Anal' })).toHaveLength(0);
  });

  it('keeps out-of-stock rows unless the cashier asked not to see them', () => {
    expect(ids(filterOfflineCatalogue(shelf(), { inStock: true }))).toEqual(['a', 'd', 'c']);
    expect(filterOfflineCatalogue(shelf(), { inStock: false })).toHaveLength(4);
  });

  it('offers the shortest-dated stock first and expired stock last', () => {
    expect(ids(filterOfflineCatalogue(shelf()))).toEqual(['b', 'a', 'd', 'c']);
  });

  it('breaks a tie on id, so two batches of the same product hold their places', () => {
    const twins = [
      row({ id: 'z', product_name: 'Ibuprofen', batch_number: 'B2', expiry_date: '2026-11-01' }),
      row({ id: 'y', product_name: 'Ibuprofen', batch_number: 'B1', expiry_date: '2026-11-01' }),
    ];

    expect(ids(filterOfflineCatalogue(twins))).toEqual(['y', 'z']);
  });

  it('leaves the list it was given alone', () => {
    const products = shelf();
    filterOfflineCatalogue(products, { category: 'Analgesics' });

    expect(ids(products)).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('offlineCategories', () => {
  it('counts each category once, in the order the online chips use', () => {
    const rows = [
      { ...productRow(1), id: 'a', category: 'Antibiotics' },
      { ...productRow(2), id: 'b', category: 'Analgesics' },
      { ...productRow(3), id: 'c', category: 'Analgesics' },
      { ...productRow(4), id: 'd', category: null },
      { ...productRow(5), id: 'e', category: '   ' },
    ];

    expect(offlineCategories(rows)).toEqual([
      { category: 'Analgesics', item_count: 2 },
      { category: 'Antibiotics', item_count: 1 },
    ]);
  });

  it('has nothing to offer on a device that has never cached stock', () => {
    expect(offlineCategories([])).toEqual([]);
  });
});
