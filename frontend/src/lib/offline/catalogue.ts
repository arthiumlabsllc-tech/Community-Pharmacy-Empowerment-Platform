import type { MomoNetwork, PaymentConfig, PaymentMethod, PricingMode, PosProduct, VatTreatment } from '../pos-types';
import { CATALOGUE_STORE, SETTINGS_STORE, getAllRecords, getRecord, pruneTo, putMany, putRecord } from './db';
import type { OfflineTaxSettings } from './pricing';

/**
 * What the till needs to keep selling with no connection.
 *
 * Three things: the product list with its prices and VAT classifications, the
 * pharmacy's tax settings, and the payment methods with their mobile money
 * networks. Each is load-bearing rather than convenient — without the first the
 * cashier cannot see a price, without the second the till cannot compute an
 * amount due, and without the third a MoMo tender cannot even be entered, since
 * the network picker would be empty and the form would refuse it.
 *
 * Everything else on the POS screen is either a nicety (staff names, categories)
 * or impossible offline (a gateway charge, patient lookup against the server).
 *
 * The cache is written on every successful catalogue load, which happens each
 * time the till is opened while online. It is never the source of truth — the
 * server re-prices each sale from the inventory row on sync — but it is what
 * lets the cashier see a price and a stock figure, so its age is recorded and
 * shown rather than hidden.
 */

export const TAX_SETTINGS_KEY = 'tax';
export const PAYMENT_CONFIG_KEY = 'payment';

export interface CachedProduct {
  id: string;
  product_name: string;
  generic_name: string | null;
  product_code: string;
  barcode: string | null;
  category: string | null;
  unit_price: number;
  /** Whole packs. The till does not sell loose tablets, offline or online. */
  quantity: number;
  reorder_level: number;
  batch_number: string | null;
  expiry_date: string | null;
  requires_prescription: boolean;
  vat_treatment: VatTreatment;
  pack_size: number;
  default_sell_unit: string;
  shelf_location: string | null;
  is_expired: boolean;
  near_expiry: boolean;
  /** When this device last saw the row. Prices can change without it. */
  cachedAt: string;
}

export interface CachedTaxSettings extends OfflineTaxSettings {
  cachedAt: string;
}

/**
 * Stores the catalogue and drops products that are no longer in it.
 *
 * Pruning matters: a delisted or sold-out-forever item left in the cache would
 * still be sellable offline, and the server would then reject the sale for an
 * inventory_id that no longer exists — a failure discovered hours later.
 *
 * An empty list is refused rather than pruned down to nothing. A pharmacy with
 * genuinely no stock is not a case the till has to support, whereas a failed or
 * truncated catalogue fetch is common — and pruning on that would wipe the cache
 * and remove the ability to sell offline at precisely the moment the connection
 * is proving unreliable.
 */
export async function rememberCatalogue(products: PosProduct[]): Promise<number> {
  if (!Array.isArray(products) || products.length === 0) return 0;

  const cachedAt = new Date().toISOString();
  const entries: Array<[string, CachedProduct]> = products.map((product) => [
    product.id,
    {
      id: product.id,
      product_name: product.product_name,
      generic_name: product.generic_name ?? null,
      product_code: product.product_code,
      barcode: product.barcode ?? null,
      category: product.category ?? null,
      // NUMERIC arrives as a string; the cache stores a number so the offline
      // pricer is not handed a type it has to second-guess.
      unit_price: Number(product.unit_price) || 0,
      quantity: Number(product.quantity) || 0,
      reorder_level: Number(product.reorder_level) || 0,
      batch_number: product.batch_number ?? null,
      expiry_date: product.expiry_date ?? null,
      requires_prescription: Boolean(product.requires_prescription),
      vat_treatment: product.vat_treatment,
      pack_size: Number(product.pack_size) || 1,
      default_sell_unit: product.default_sell_unit || 'pack',
      shelf_location: product.shelf_location ?? null,
      is_expired: Boolean(product.is_expired),
      near_expiry: Boolean(product.near_expiry),
      cachedAt,
    },
  ]);

  await putMany(CATALOGUE_STORE, entries);
  await pruneTo(
    CATALOGUE_STORE,
    entries.map(([id]) => id)
  );

  return entries.length;
}

export async function cachedCatalogue(): Promise<CachedProduct[]> {
  const products = await getAllRecords<CachedProduct>(CATALOGUE_STORE);
  return products.sort((a, b) => a.product_name.localeCompare(b.product_name));
}

export async function cachedProduct(id: string): Promise<CachedProduct | undefined> {
  return getRecord<CachedProduct>(CATALOGUE_STORE, id);
}

/**
 * Takes sold units out of the cached quantity.
 *
 * The cache is what the till checks before allowing the next sale, so a pack
 * that has physically left the shelf has to leave the cache as well. Without
 * this a cashier selling offline all morning can hand out the same box several
 * times over, and nothing says so until the sales sync.
 *
 * `cachedAt` is deliberately not refreshed: the price and the VAT classification
 * are still exactly as old as the last fetch, and stamping them as new would
 * hide that from the cashier.
 */
export async function applyOfflineStockChange(
  changes: Array<{ id: string; sold: number }>
): Promise<number> {
  let updated = 0;

  for (const change of changes) {
    const product = await cachedProduct(change.id);
    if (!product) continue;

    const sold = Math.max(Math.floor(change.sold), 0);
    await putRecord(CATALOGUE_STORE, product.id, {
      ...product,
      // Allowed to go negative, which is what the server does with an
      // offline-recorded sale too. "We sold more than we thought we had" is the
      // honest statement, and a stock-take is what reconciles it.
      quantity: product.quantity - sold,
    });
    updated += 1;
  }

  return updated;
}

export async function rememberTaxSettings(settings: {
  vat_registered: boolean;
  pricing_mode: PricingMode;
  rates: Record<string, number> | null;
}): Promise<CachedTaxSettings> {
  const record: CachedTaxSettings = {
    vatRegistered: settings.vat_registered !== false,
    pricingMode: settings.pricing_mode === 'exclusive' ? 'exclusive' : 'inclusive',
    rates: settings.rates ?? null,
    cachedAt: new Date().toISOString(),
  };

  await putRecord(SETTINGS_STORE, TAX_SETTINGS_KEY, record);
  return record;
}

/**
 * Null when this device has never loaded the settings. The pricer refuses to
 * price on a null, and the till says why: guessing a tax position would be
 * worse than refusing to sell.
 */
export async function cachedTaxSettings(): Promise<CachedTaxSettings | null> {
  const record = await getRecord<CachedTaxSettings>(SETTINGS_STORE, TAX_SETTINGS_KEY);
  return record ?? null;
}

/** Age of each cache in milliseconds, or null when it has never been written. */
export async function cacheAge(): Promise<{ catalogue: number | null; tax: number | null }> {
  const [tax, products] = await Promise.all([cachedTaxSettings(), cachedCatalogue()]);
  const now = Date.now();

  const oldest = products.length > 0 ? Math.min(...products.map((item) => Date.parse(item.cachedAt))) : null;

  return {
    catalogue: oldest === null || Number.isNaN(oldest) ? null : now - oldest,
    tax: tax ? now - Date.parse(tax.cachedAt) : null,
  };
}

/** Whether the device holds enough to sell offline at all. */
export async function canSellOffline(): Promise<{ ready: boolean; products: number; reason: string | null }> {
  const [products, tax] = await Promise.all([cachedCatalogue(), cachedTaxSettings()]);

  if (!tax) {
    return {
      ready: false,
      products: products.length,
      reason: 'Tax settings have never been loaded on this device. Open the till once while online.',
    };
  }
  if (products.length === 0) {
    return {
      ready: false,
      products: 0,
      reason: 'No products are cached on this device. Open the till once while online.',
    };
  }

  return { ready: true, products: products.length, reason: null };
}

// ---------------------------------------------------------------------------
// Payment methods
// ---------------------------------------------------------------------------

/**
 * The methods and networks on offer.
 *
 * Deliberately excludes whether the gateway was connected when this was cached.
 * Offline it is not connected, whatever the last fetch said, and storing a stale
 * `true` would only invite the UI to imply a charge happened when the money was
 * merely written down.
 */
export interface CachedPaymentConfig {
  networks: MomoNetwork[];
  methods: PaymentMethod[];
  currency: string;
  cachedAt: string;
}

export async function rememberPaymentConfig(config: PaymentConfig): Promise<CachedPaymentConfig> {
  const record: CachedPaymentConfig = {
    networks: Array.isArray(config.networks) ? config.networks : [],
    methods: Array.isArray(config.methods) && config.methods.length > 0 ? config.methods : ['cash'],
    currency: config.currency || 'GHS',
    cachedAt: new Date().toISOString(),
  };

  await putRecord(SETTINGS_STORE, PAYMENT_CONFIG_KEY, record);
  return record;
}

/** Null until the till has been opened online once. */
export async function cachedPaymentConfig(): Promise<CachedPaymentConfig | null> {
  const record = await getRecord<CachedPaymentConfig>(SETTINGS_STORE, PAYMENT_CONFIG_KEY);
  return record ?? null;
}

/**
 * A cached row as the till grid expects it.
 *
 * `manufacturer` and `cost_price` are not cached and are filled in with values
 * that render as nothing; neither is shown on the checkout screen and neither is
 * ever sent back to the server, which reads its own copy from the stock row.
 * `needs_reorder` is recomputed from the cached quantity and reorder level
 * rather than stored, so it cannot disagree with them.
 */
export function asPosProduct(product: CachedProduct): PosProduct {
  return {
    id: product.id,
    product_name: product.product_name,
    generic_name: product.generic_name,
    product_code: product.product_code,
    barcode: product.barcode,
    category: product.category,
    manufacturer: null,
    // NUMERIC on the wire, so back to a string here.
    unit_price: String(product.unit_price),
    cost_price: '0',
    quantity: product.quantity,
    reorder_level: product.reorder_level,
    batch_number: product.batch_number,
    expiry_date: product.expiry_date,
    requires_prescription: product.requires_prescription,
    vat_treatment: product.vat_treatment,
    pack_size: product.pack_size,
    default_sell_unit: product.default_sell_unit,
    shelf_location: product.shelf_location,
    needs_reorder: product.quantity <= product.reorder_level,
    is_expired: product.is_expired,
    near_expiry: product.near_expiry,
  };
}

/** The whole cached catalogue in the shape the product grid already renders. */
export async function offlineCatalogue(): Promise<PosProduct[]> {
  const products = await cachedCatalogue();
  return products.map(asPosProduct);
}
