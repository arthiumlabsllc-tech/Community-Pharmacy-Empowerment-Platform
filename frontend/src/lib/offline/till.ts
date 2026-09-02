/**
 * Selling with no connection.
 *
 * The till keeps working offline by narrowing what it offers rather than by
 * pretending. Three things are withheld and each is withheld for a reason a
 * cashier can be told:
 *
 *  - Discounts. Spreading one across the lines changes each line's taxable base,
 *    which would mean a second implementation of the server's apportionment.
 *    `priceOfflineBasket` refuses it; the till disables the control.
 *  - Card. Through this app a card payment *is* a Paystack hosted checkout, so
 *    offline there is nothing to do but write down that the customer paid by
 *    card — and the sale would sync as settled money that no terminal here ever
 *    took. MoMo stays, because in Ghana it rides the phone network rather than
 *    the internet, so the money may genuinely have moved. It syncs marked
 *    unverified, for the pharmacy to reconcile against the network statement.
 *  - Patient lookup, which searches the server. Walk-in name and phone are still
 *    taken, so the sale is not anonymous unless the cashier wants it to be.
 *
 * Nothing here decides a tax figure. The amount due comes from
 * `priceOfflineBasket`, is sent as `client_quoted_total`, and the server
 * re-prices the sale from its own inventory row on sync. If the two disagree the
 * pharmacy is told — see the notices store.
 */

import api from '../api';
import {
  money,
  type PaymentConfig,
  type PaymentMethod,
  type PosCategory,
  type PosProduct,
} from '../pos-types';
import {
  cachedPaymentConfig,
  offlineCatalogue,
  rememberCatalogue,
  rememberPaymentConfig,
  rememberTaxSettings,
  applyOfflineStockChange,
} from './catalogue';
import type { OfflineQuote } from './pricing';
import { enqueue, newId, type QueueItem } from './queue';
import { assertNoStrayLocalIds } from './sync';

/** The backend caps a page at 200 rows, so the cache pages through them. */
export const CACHE_PAGE_SIZE = 200;

/**
 * A bound on the paging loop rather than on the catalogue. Twenty-five pages is
 * five thousand products, far beyond a community pharmacy; the bound exists so a
 * server that never returns a short page cannot keep the till fetching forever.
 */
export const CACHE_MAX_PAGES = 25;

export const OFFLINE_WITHHELD_METHODS: PaymentMethod[] = ['card'];

/**
 * The three Ghanaian mobile money networks.
 *
 * This is a constant on the server as well (`GHANA_MOMO_NETWORKS` in
 * paystack.service.ts), not a per-pharmacy setting, so a device can fall back to
 * it without guessing anything about the pharmacy. The alternative is a dead end:
 * the MoMo form refuses a tender with no network and offers no way to pick one.
 */
export const GHANA_MOMO_NETWORKS: Array<{ provider: string; label: string }> = [
  { provider: 'mtn', label: 'MTN MoMo' },
  { provider: 'vod', label: 'Telecel (Vodafone) Cash' },
  { provider: 'atl', label: 'AirtelTigo Money' },
];

export interface CacheRefreshResult {
  /** Products written to the cache. Zero when the fetch failed. */
  products: number;
  /** False when the pharmacy holds more stock than the paging bound allows. */
  complete: boolean;
  /** Why the cache is short of complete, in words the cashier can act on. */
  error: string | null;
  cachedAt: string | null;
}

function reason(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/**
 * Writes the whole catalogue, the tax settings and the payment methods.
 *
 * It must fetch every page before writing anything, because `rememberCatalogue`
 * prunes the cache down to the list it is given. Caching one filtered or
 * truncated page would delete the rest of the pharmacy's stock from the device
 * and silently make it unsellable for the length of an outage — which is why the
 * grid's own filtered fetch is never used to fill the cache.
 *
 * A failure part-way through leaves the previous cache untouched. Stale prices
 * a cashier is told about are better than no ability to sell at all.
 */
export async function refreshOfflineCache(): Promise<CacheRefreshResult> {
  const products: PosProduct[] = [];
  let complete = true;

  try {
    for (let page = 0; page < CACHE_MAX_PAGES; page++) {
      const response = await api.get<{ success: boolean; data: PosProduct[] }>(
        `/pos/products?limit=${CACHE_PAGE_SIZE}&offset=${page * CACHE_PAGE_SIZE}`
      );
      const rows = response.data || [];
      products.push(...rows);

      if (rows.length < CACHE_PAGE_SIZE) break;
      if (page === CACHE_MAX_PAGES - 1) complete = false;
    }
  } catch (error) {
    return {
      products: 0,
      complete: false,
      error: reason(error, 'Could not reach the server to cache stock'),
      cachedAt: null,
    };
  }

  let written = 0;
  try {
    written = await rememberCatalogue(products);
  } catch (error) {
    return {
      products: 0,
      complete: false,
      error: reason(error, 'Offline storage refused the stock list'),
      cachedAt: null,
    };
  }

  const cachedAt = new Date().toISOString();

  // Written after the stock rather than before. Without the tax settings nothing
  // can be priced, but each stage reports what it actually achieved: a device
  // holding stock and no settings is not the same as a device holding nothing,
  // and `canSellOffline` is what tells the cashier which is missing.
  try {
    const response = await api.get<{ success: boolean; data: PaymentConfig }>(
      '/pos/payment-config'
    );
    const config = response.data;
    if (!config) throw new Error('The server did not return the tax settings');

    await rememberTaxSettings(config.tax);
    await rememberPaymentConfig(config);
  } catch (error) {
    return {
      products: written,
      complete: false,
      error: reason(error, 'Could not cache the tax settings'),
      cachedAt,
    };
  }

  return {
    products: written,
    complete: complete && written > 0,
    error: written === 0 ? 'The server returned no products to cache' : null,
    cachedAt,
  };
}

/**
 * What the payment sheet can offer with no connection, from the last config this
 * device saw. Falls back to cash alone, which needs nothing cached and is the
 * one method that is always honest.
 */
export async function offlinePaymentOptions(): Promise<{
  methods: PaymentMethod[];
  networks: Array<{ provider: string; label: string }>;
  currency: string;
}> {
  const cached = await cachedPaymentConfig();
  if (!cached) return { methods: ['cash'], networks: [], currency: 'GHS' };

  const methods = cached.methods.filter((method) => !OFFLINE_WITHHELD_METHODS.includes(method));

  return {
    methods,
    networks:
      methods.includes('momo') && cached.networks.length === 0
        ? GHANA_MOMO_NETWORKS
        : cached.networks,
    currency: cached.currency,
  };
}

export { offlineCatalogue };

// ---------------------------------------------------------------------------
// Filtering the cached catalogue
// ---------------------------------------------------------------------------

export interface OfflineCatalogueFilter {
  search?: string | null;
  category?: string | null;
  inStock?: boolean;
}

/**
 * The server's ORDER BY, reproduced. First-expiry-first-out is a regulatory
 * expectation rather than a nicety, so the offline grid has to offer the
 * shortest-dated stock first too — a cashier who cannot see the order cannot
 * rotate the shelf.
 *
 * Expired rows go last rather than disappearing: they are still stock the
 * pharmacy holds, and hiding them offline while the online grid shows them
 * (disabled) would make the two disagree about what exists.
 */
function compareTillOrder(a: PosProduct, b: PosProduct): number {
  const expiredA = a.is_expired ? 1 : 0;
  const expiredB = b.is_expired ? 1 : 0;
  if (expiredA !== expiredB) return expiredA - expiredB;

  const expiryA = sortableDate(a.expiry_date);
  const expiryB = sortableDate(b.expiry_date);
  if (expiryA !== expiryB) return expiryA - expiryB;

  const byName = a.product_name.localeCompare(b.product_name);
  if (byName !== 0) return byName;

  // Tiebreaker, as in buildTillProductQuery: without a total order two batches
  // of the same product with the same expiry date can swap places between
  // renders.
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/** Undated stock sorts after every dated batch, which is what ASC does in SQL. */
function sortableDate(value: string | null): number {
  if (!value) return Number.POSITIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
}

/**
 * Applies the till's search, category and stock filters to the cached list.
 *
 * Offline there is no server to filter, and a grid showing five thousand cached
 * products is unusable at a counter. The matching mirrors
 * `buildTillProductQuery`: search is a case-insensitive substring of the name,
 * generic name, code or barcode; category is an exact match; "in stock only"
 * means a quantity above zero.
 */
export function filterOfflineCatalogue(
  products: PosProduct[],
  filter: OfflineCatalogueFilter = {}
): PosProduct[] {
  const search = String(filter.search ?? '').trim().toLowerCase();
  const category = String(filter.category ?? '').trim();

  const matched = (products || []).filter((product) => {
    if (category && String(product.category ?? '') !== category) return false;
    if (filter.inStock && !(Number(product.quantity) > 0)) return false;
    if (!search) return true;

    return [product.product_name, product.generic_name, product.product_code, product.barcode].some(
      (field) => String(field ?? '').toLowerCase().includes(search)
    );
  });

  return matched.sort(compareTillOrder);
}

/**
 * The filter chips, derived from the cache because `/pos/categories` is a
 * request this device cannot make. Counts are of cached rows, so they can lag
 * the server — they are a navigation aid, not a stock report.
 */
export function offlineCategories(products: PosProduct[]): PosCategory[] {
  const counts = new Map<string, number>();

  for (const product of products || []) {
    const category = String(product.category ?? '').trim();
    if (!category) continue;
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, count]) => ({ category: name, item_count: count }));
}

// ---------------------------------------------------------------------------
// Queuing the sale
// ---------------------------------------------------------------------------

export interface OfflineSaleLine {
  inventoryId: string;
  quantity: number;
}

export interface OfflineSalePayment {
  method: PaymentMethod;
  amount: number;
  momo_number?: string | null;
  momo_network?: string | null;
  reference?: string | null;
}

export interface OfflineSaleInput {
  lines: OfflineSaleLine[];
  payments: OfflineSalePayment[];
  /** The priced basket, whose grandTotal becomes `client_quoted_total`. */
  quote: OfflineQuote;
  /**
   * Only ever an id the server already handed this device — a patient picked
   * before the connection dropped. The till cannot search for one offline, and
   * a stand-in would be rejected as a malformed uuid hours later, so
   * `assertNoStrayLocalIds` below is what enforces the distinction.
   */
  patientId?: string | null;
  customerName?: string | null;
  customerPhone?: string | null;
  note?: string | null;
  /**
   * Left null offline, and that is safe rather than merely convenient: the
   * server sets the approver to the signed-in user whenever that user is a
   * pharmacist or owner, and `priceOfflineBasket` refuses an Rx basket unless
   * exactly such a user is at the till. A cashier offline cannot reach the
   * approver list, so they cannot sell prescription stock at all.
   */
  approvedBy?: string | null;
  /** When the goods actually left the shelf, which is not when it syncs. */
  recordedAt?: string;
  /**
   * The basket's own id, when it already has one.
   *
   * Carried through as `client_sale_id` rather than minting a fresh one, and
   * that matters in precisely the case idempotency exists for: a Charge that
   * reached the server but whose response was lost drops the till into degraded
   * mode with the basket still on screen. Recording it offline under the same id
   * makes the server return the sale it already created instead of selling the
   * same goods twice — a duplicate here is silent, and surfaces weeks later as a
   * stock count nobody can explain.
   *
   * Anything that is not a UUID is ignored rather than sent: the server validates
   * `client_sale_id` with `isUUID()`, so a malformed one would park the item as
   * dead hours later, long after the customer has gone.
   */
  clientSaleId?: string | null;
}

export interface OfflineSaleDraft {
  /** A UUID, used as both the queue id and the server's replay key. */
  clientSaleId: string;
  payload: Record<string, unknown>;
  /** One line for the review screen. */
  label: string;
  recordedAt: string;
}

/** What the server's `isUUID()` accepts, so a carried id is not sent to be
 *  rejected at the other end of an outage. */
const UUID_RE = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;

/**
 * Builds the request body without sending or storing it.
 *
 * Separate from `queueOfflineSale` so the shape can be pinned by a test: this is
 * the one place where what the till records and what the server accepts have to
 * agree, and a mismatch is not discovered until the sale bounces out of the sync
 * queue hours later.
 */
export function buildOfflineSale(input: OfflineSaleInput): OfflineSaleDraft {
  if (!input.quote.priced) {
    throw new Error(input.quote.refusalReason || 'This basket has not been priced');
  }

  const recordedAt = input.recordedAt || new Date().toISOString();
  // One id for both jobs: it is the queue's own key, the X-Client-Request-Id that
  // makes a replayed request safe, and the client_sale_id that lets the server
  // return the original sale instead of selling twice. Keeping them equal means
  // a row in /sync can be found in the database by the same string.
  const carried = String(input.clientSaleId ?? '').trim();
  const clientSaleId = UUID_RE.test(carried) ? carried : newId();

  const trim = (value?: string | null): string | null => {
    const text = String(value ?? '').trim();
    return text.length > 0 ? text : null;
  };

  const payload: Record<string, unknown> = {
    items: input.lines.map((line) => ({
      inventory_id: line.inventoryId,
      quantity: Math.floor(line.quantity),
    })),
    payments: input.payments.map((payment) => ({
      method: payment.method,
      amount: payment.amount,
      momo_number: payment.momo_number ?? null,
      momo_network: payment.momo_network ?? null,
      email: null,
      reference: payment.reference ?? null,
    })),
    // Always zero: a discounted basket is refused before it gets here, and
    // sending a discount the server cannot reproduce would change the tax.
    discount_amount: 0,
    discount_reason: null,
    patient_id: input.patientId ?? null,
    customer_name: trim(input.customerName),
    customer_phone: trim(input.customerPhone),
    note: trim(input.note),
    approved_by: input.approvedBy ?? null,
    client_sale_id: clientSaleId,
    recorded_offline: true,
    client_recorded_at: recordedAt,
    client_quoted_total: input.quote.grandTotal,
  };

  const units = input.lines.reduce((total, line) => total + Math.floor(line.quantity), 0);

  return {
    clientSaleId,
    payload,
    label: `Sale · ${money(input.quote.grandTotal)} · ${units} item${units === 1 ? '' : 's'}`,
    recordedAt,
  };
}

/** What recording a sale on this device did. */
export interface QueuedOfflineSale {
  item: QueueItem;
  /** Cached products whose quantity was reduced. */
  stockUpdated: number;
  /**
   * Set when the shelf figure could not be updated. The sale is already safely
   * queued — losing it to protect a cached number would be the wrong way round —
   * but the till may then offer stock that has physically gone, and the cashier
   * is told so rather than left to discover it at the next sale.
   */
  stockError: string | null;
}

/**
 * Records the sale on this device.
 *
 * Nothing is sent. The scheduler picks it up when there is a connection, and
 * until then it sits on the review screen where the cashier can see it. The
 * cached shelf figure is reduced in the same step, because the cache is what the
 * till checks before allowing the next sale.
 */
export async function queueOfflineSale(input: OfflineSaleInput): Promise<QueuedOfflineSale> {
  const draft = buildOfflineSale(input);

  // The till cannot pick a patient offline, so a stand-in id here would be a
  // caller bug rather than a dependency to resolve later.
  assertNoStrayLocalIds(draft.payload);

  const item = await enqueue({
    id: draft.clientSaleId,
    entity: 'sale',
    endpoint: '/pos/sales',
    payload: draft.payload,
    label: draft.label,
    recordedAt: draft.recordedAt,
  });

  // Taken off the cached shelf after the queue write, never before: if the
  // storage fails the sale must still exist, whereas the reverse would leave a
  // reduced quantity with no sale to explain it.
  let stockUpdated = 0;
  let stockError: string | null = null;
  try {
    stockUpdated = await applyOfflineStockChange(
      input.lines.map((line) => ({ id: line.inventoryId, sold: line.quantity }))
    );
  } catch (error) {
    stockError = reason(error, 'Offline storage would not update the stock figure');
  }

  return { item, stockUpdated, stockError };
}
