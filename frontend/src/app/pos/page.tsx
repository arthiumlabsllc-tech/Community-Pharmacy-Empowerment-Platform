'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import toast from 'react-hot-toast';
import {
  AlertTriangle,
  ArrowLeft,
  History,
  Loader2,
  Minus,
  Package,
  Percent,
  Pill,
  Plus,
  RefreshCw,
  ScanBarcode,
  Search,
  ShoppingCart,
  Trash2,
  WifiOff,
  X,
} from 'lucide-react';
import { useAuthStore } from '@/store/auth-store';
import { usePharmacyStore } from '@/store/pharmacy-store';
import { useHydrated } from '@/hooks/use-hydrated';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { PatientSelect, type PatientOption } from '@/components/ui/patient-select';
import { PaymentModal, type Tender } from '@/components/pos/payment-modal';
import { ReceiptModal } from '@/components/pos/receipt-modal';
import { api } from '@/lib/api';
import {
  amount,
  money,
  type PaymentConfig,
  type PosCategory,
  type PosProduct,
  type Quote,
  type Sale,
} from '@/lib/pos-types';

/** One line in the till's basket, before the server prices it. */
interface BasketLine {
  inventory_id: string;
  product_name: string;
  generic_name: string | null;
  quantity: number;
  /** Display only — the server re-prices from the stock row and may differ. */
  unit_price: number;
  sell_unit: string;
  requires_prescription: boolean;
  quantity_available: number;
  batch_number: string | null;
  expiry_date: string | null;
}

interface Approver {
  id: string;
  name: string;
  role: string;
}

/**
 * A basket identity for idempotency. Generated once when the first item is
 * added and sent as `client_sale_id`; the server returns the original sale
 * rather than selling twice if a retry lands after a dropped response.
 */
function newBasketId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const random = (Math.random() * 16) | 0;
    const value = char === 'x' ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

function daysUntilExpiry(value: string | null): number | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return Math.ceil((date.getTime() - Date.now()) / 86_400_000);
}

/**
 * The till.
 *
 * Full-bleed rather than inside the dashboard shell: a checkout needs every
 * pixel for the product grid and the basket, and the controls are sized for a
 * finger rather than a mouse.
 *
 * Prices and tax are never computed here. Every total on screen comes from
 * `POST /pos/quote`, which runs the same Act 1151 engine that creates the
 * sale, so what the cashier sees is what the customer is charged.
 */
export default function PosPage() {
  const { isAuthenticated, user } = useAuthStore();
  const pharmacy = usePharmacyStore((state) => state.profile);
  const fetchProfile = usePharmacyStore((state) => state.fetchProfile);
  const profileLoaded = usePharmacyStore((state) => state.loaded);
  const hydrated = useHydrated();
  const router = useRouter();

  const [products, setProducts] = useState<PosProduct[]>([]);
  const [categories, setCategories] = useState<PosCategory[]>([]);
  const [config, setConfig] = useState<PaymentConfig | null>(null);
  const [approvers, setApprovers] = useState<Approver[]>([]);
  const [loadingProducts, setLoadingProducts] = useState(true);
  const [online, setOnline] = useState(true);

  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [inStockOnly, setInStockOnly] = useState(true);

  const [basket, setBasket] = useState<BasketLine[]>([]);
  const [basketId, setBasketId] = useState<string | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);

  const [discountText, setDiscountText] = useState('');
  const [discountReason, setDiscountReason] = useState('');
  const [patient, setPatient] = useState<PatientOption | null>(null);
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [note, setNote] = useState('');
  const [approverId, setApproverId] = useState('');
  const [customerOpen, setCustomerOpen] = useState(false);

  const [paymentOpen, setPaymentOpen] = useState(false);
  const [tenders, setTenders] = useState<Tender[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [receipt, setReceipt] = useState<Sale | null>(null);
  const [receiptOpen, setReceiptOpen] = useState(false);
  const [basketOpen, setBasketOpen] = useState(false);

  const debouncedSearch = useDebouncedValue(search, 350);
  const debouncedDiscount = useDebouncedValue(discountText, 400);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (hydrated && !isAuthenticated) router.replace('/login');
  }, [hydrated, isAuthenticated, router]);

  useEffect(() => {
    if (hydrated && user && !profileLoaded) fetchProfile();
  }, [hydrated, user, profileLoaded, fetchProfile]);

  // The till is useless without the server: it cannot price a basket or take a
  // payment. Say so rather than letting the cashier ring up a sale that will
  // fail at the last tap.
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  const loadCatalogue = useCallback(async () => {
    setLoadingProducts(true);
    try {
      const params = new URLSearchParams({ limit: '120' });
      if (debouncedSearch) params.set('search', debouncedSearch);
      if (category) params.set('category', category);
      if (inStockOnly) params.set('inStock', 'true');

      const response = await api.get<{ success: boolean; data: PosProduct[] }>(
        `/pos/products?${params.toString()}`
      );
      setProducts(response.data || []);
    } catch {
      toast.error('Could not load products from the server');
    } finally {
      setLoadingProducts(false);
    }
  }, [debouncedSearch, category, inStockOnly]);

  const loadMeta = useCallback(async () => {
    try {
      const [categoryResponse, configResponse, approverResponse] = await Promise.all([
        api.get<{ success: boolean; data: PosCategory[] }>('/pos/categories'),
        api.get<{ success: boolean; data: PaymentConfig }>('/pos/payment-config'),
        api.get<{ success: boolean; data: Approver[] }>('/pos/approvers'),
      ]);
      setCategories(categoryResponse.data || []);
      setConfig(configResponse.data || null);
      setApprovers(approverResponse.data || []);
    } catch {
      // The till can still sell cash items without the approver list, so this
      // is not fatal — but the gateway banner depends on it.
      setOnline(false);
    }
  }, []);

  useEffect(() => {
    if (!hydrated || !isAuthenticated) return;
    loadMeta();
  }, [hydrated, isAuthenticated, loadMeta]);

  useEffect(() => {
    if (!hydrated || !isAuthenticated) return;
    loadCatalogue();
  }, [hydrated, isAuthenticated, loadCatalogue]);

  const totalQuantity = useMemo(
    () => basket.reduce((total, line) => total + line.quantity, 0),
    [basket]
  );
  const hasPrescriptionItem = useMemo(
    () => basket.some((line) => line.requires_prescription),
    [basket]
  );

  // Cashiers cannot self-approve a prescription-only medicine; the server
  // requires the id of a pharmacist or owner at the same pharmacy.
  const needsApprover = hasPrescriptionItem && user?.role === 'staff';
  const approverMissing = needsApprover && !approverId;

  const discountValue = Math.max(Number(debouncedDiscount) || 0, 0);

  // Ask the server to price the basket. Debounced so a rapid +/+/+ on the
  // quantity stepper does not fire three requests.
  useEffect(() => {
    if (!hydrated || !isAuthenticated) return;
    if (basket.length === 0) {
      setQuote(null);
      setQuoteError(null);
      return;
    }

    let cancelled = false;
    setQuoting(true);

    const run = async () => {
      try {
        const response = await api.post<{ success: boolean; data: Quote }>('/pos/quote', {
          items: basket.map((line) => ({
            inventory_id: line.inventory_id,
            quantity: line.quantity,
          })),
          discount_amount: discountValue,
        });
        if (cancelled) return;
        setQuote(response.data);
        setQuoteError(null);
      } catch (error: any) {
        if (cancelled) return;
        setQuote(null);
        setQuoteError(error?.message || 'Could not price this basket');
      } finally {
        if (!cancelled) setQuoting(false);
      }
    };

    const timer = setTimeout(run, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [hydrated, isAuthenticated, basket, discountValue]);

  function addToBasket(product: PosProduct) {
    if (product.quantity <= 0) {
      toast.error(`${product.product_name} is out of stock`);
      return;
    }
    if (product.is_expired) {
      toast.error(`${product.product_name} has expired and cannot be sold`);
      return;
    }

    setBasketId((current) => current ?? newBasketId());
    setBasket((current) => {
      const existing = current.find((line) => line.inventory_id === product.id);
      if (existing) {
        if (existing.quantity + 1 > product.quantity) {
          toast.error(`Only ${product.quantity} in stock`);
          return current;
        }
        return current.map((line) =>
          line.inventory_id === product.id ? { ...line, quantity: line.quantity + 1 } : line
        );
      }
      return [
        ...current,
        {
          inventory_id: product.id,
          product_name: product.product_name,
          generic_name: product.generic_name,
          quantity: 1,
          unit_price: amount(product.unit_price),
          sell_unit: product.default_sell_unit || 'pack',
          requires_prescription: product.requires_prescription,
          quantity_available: product.quantity,
          batch_number: product.batch_number,
          expiry_date: product.expiry_date,
        },
      ];
    });
  }

  function changeQuantity(inventoryId: string, delta: number) {
    setBasket((current) =>
      current
        .map((line) => {
          if (line.inventory_id !== inventoryId) return line;
          const next = line.quantity + delta;
          if (next > line.quantity_available) {
            toast.error(`Only ${line.quantity_available} in stock`);
            return line;
          }
          return { ...line, quantity: Math.max(next, 0) };
        })
        .filter((line) => line.quantity > 0)
    );
  }

  function removeLine(inventoryId: string) {
    setBasket((current) => current.filter((line) => line.inventory_id !== inventoryId));
  }

  function clearBasket() {
    setBasket([]);
    setBasketId(null);
    setQuote(null);
    setTenders([]);
    setDiscountText('');
    setDiscountReason('');
    setPatient(null);
    setCustomerName('');
    setCustomerPhone('');
    setNote('');
    setApproverId('');
  }

  function openPayment() {
    if (basket.length === 0) {
      toast.error('The basket is empty');
      return;
    }
    if (!quote) {
      toast.error('Waiting for the server to price this basket');
      return;
    }
    if (approverMissing) {
      toast.error('Name the pharmacist who approved this prescription');
      return;
    }
    const oversold = quote.lines.filter((line) => line.oversold);
    if (oversold.length > 0) {
      toast.error(`Not enough stock of ${oversold[0].product_name}`);
      return;
    }
    setTenders([]);
    setPaymentOpen(true);
  }

  async function completeSale() {
    if (!quote) return;
    setSubmitting(true);

    try {
      const response = await api.post<{
        success: boolean;
        message: string;
        data: Sale;
        duplicate?: boolean;
        gateway?: Array<{
          awaitingCustomerApproval: boolean;
          authorizationUrl: string | null;
          message: string;
          outcome: string;
        }>;
      }>('/pos/sales', {
        items: basket.map((line) => ({
          inventory_id: line.inventory_id,
          quantity: line.quantity,
        })),
        payments: tenders.map((tender) => ({
          method: tender.method,
          amount: tender.amount,
          momo_number: tender.momo_number || null,
          momo_network: tender.momo_network || null,
          email: tender.email || null,
          reference: tender.reference || null,
        })),
        discount_amount: discountValue,
        discount_reason: discountReason.trim() || null,
        patient_id: patient?.id || null,
        customer_name: customerName.trim() || null,
        customer_phone: customerPhone.trim() || null,
        note: note.trim() || null,
        approved_by: needsApprover ? approverId : null,
        client_sale_id: basketId,
      });

      const sale = response.data;
      const gateway = response.gateway || [];
      const checkout = gateway.find((entry) => entry.authorizationUrl);
      const awaiting = gateway.find((entry) => entry.awaitingCustomerApproval);

      if (checkout?.authorizationUrl) {
        // Card goes through Paystack's hosted page; the sale stays pending
        // until the webhook or a manual verify confirms it.
        window.open(checkout.authorizationUrl, '_blank', 'noopener,noreferrer');
        toast('Card checkout opened in a new tab', { icon: '💳' });
      } else if (awaiting) {
        toast.success(awaiting.message || 'Ask the customer to approve the prompt on their phone');
      } else if (sale.status === 'completed') {
        toast.success(response.message || 'Sale completed');
      } else {
        toast(response.message || 'Sale saved as awaiting payment', { icon: '⏳' });
      }

      setPaymentOpen(false);
      setReceipt(sale);
      setReceiptOpen(true);
      clearBasket();
      // Stock moved, so the grid would otherwise show quantities that are gone.
      loadCatalogue();
    } catch (error: any) {
      const message = error?.message || 'Could not record the sale';
      toast.error(message);
      // A 409 means stock changed underneath the till — refresh the grid.
      if (error?.status === 409) loadCatalogue();
    } finally {
      setSubmitting(false);
    }
  }

  const balance = quote ? amount(quote.summary.total_amount) : 0;

  return (
    <div className="flex h-screen flex-col bg-gray-50">
      {/* ---------------- Till header ---------------- */}
      <header className="no-print flex flex-wrap items-center gap-2 border-b border-gray-200 bg-white px-3 py-2 sm:px-4">
        <Link
          href="/"
          className="flex min-h-[40px] items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-gray-600 hover:bg-gray-100"
        >
          <ArrowLeft className="h-4 w-4" />
          <span className="hidden sm:inline">Dashboard</span>
        </Link>

        <div className="min-w-0 flex-1">
          <h1 className="truncate text-base font-bold text-gray-900 sm:text-lg">Point of Sale</h1>
          <p className="truncate text-xs text-gray-500">
            {pharmacy?.name || 'Pharmacy'} · {user?.first_name} {user?.last_name}
          </p>
        </div>

        {!online && (
          <span className="badge badge-danger flex items-center gap-1">
            <WifiOff className="h-3 w-3" /> Offline
          </span>
        )}
        {config && (
          <span
            className={`badge ${config.gateway.connected ? 'badge-success' : 'badge-warning'}`}
            title={
              config.gateway.connected
                ? `Paystack connected (${config.gateway.keyPrefix}…)`
                : 'No PAYSTACK_SECRET_KEY on the server — MoMo and card are recorded by hand'
            }
          >
            {config.gateway.connected ? 'Gateway live' : 'Manual mode'}
          </span>
        )}

        <Link href="/sales" className="btn-secondary btn-sm">
          <History className="h-4 w-4" />
          <span className="hidden sm:inline">Sales</span>
        </Link>
      </header>

      {!online && (
        <div className="no-print flex items-center gap-2 bg-red-600 px-4 py-2 text-sm text-white">
          <WifiOff className="h-4 w-4 flex-shrink-0" />
          <span>
            Offline — the till cannot price a basket or take payment. Reconnect to continue.
          </span>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* ---------------- Product picker ---------------- */}
        <section className="flex min-w-0 flex-1 flex-col">
          <div className="no-print space-y-2 border-b border-gray-200 bg-white p-3">
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                <input
                  ref={searchRef}
                  className="input h-12 pl-9 text-base"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search name, generic, code or barcode…"
                  aria-label="Search products"
                />
                {search && (
                  <button
                    type="button"
                    onClick={() => setSearch('')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-lg text-gray-400 hover:bg-gray-100"
                    aria-label="Clear search"
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>
              <button
                type="button"
                className="btn-secondary h-12 px-3"
                onClick={() => searchRef.current?.focus()}
                aria-label="Scan barcode"
                title="Focus search to scan a barcode"
              >
                <ScanBarcode className="h-5 w-5" />
              </button>
              <button
                type="button"
                className="btn-ghost h-12 px-3"
                onClick={loadCatalogue}
                aria-label="Refresh products"
              >
                <RefreshCw className={`h-5 w-5 ${loadingProducts ? 'animate-spin' : ''}`} />
              </button>
            </div>

            <div className="flex items-center gap-2 overflow-x-auto pb-1">
              <button
                type="button"
                onClick={() => setCategory('')}
                className={`flex-shrink-0 rounded-full border px-3 py-1.5 text-sm font-medium ${
                  category === ''
                    ? 'border-primary-500 bg-primary-50 text-primary-700'
                    : 'border-gray-200 bg-white text-gray-600'
                }`}
              >
                All
              </button>
              {categories.map((entry) => (
                <button
                  key={entry.category}
                  type="button"
                  onClick={() => setCategory(entry.category)}
                  className={`flex-shrink-0 rounded-full border px-3 py-1.5 text-sm font-medium ${
                    category === entry.category
                      ? 'border-primary-500 bg-primary-50 text-primary-700'
                      : 'border-gray-200 bg-white text-gray-600'
                  }`}
                >
                  {entry.category}
                  <span className="ml-1 text-xs opacity-60">{entry.item_count}</span>
                </button>
              ))}
              <label className="ml-auto flex flex-shrink-0 cursor-pointer items-center gap-1.5 text-xs text-gray-600">
                <input
                  type="checkbox"
                  checked={inStockOnly}
                  onChange={(event) => setInStockOnly(event.target.checked)}
                  className="h-4 w-4 rounded border-gray-300"
                />
                In stock only
              </label>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {loadingProducts ? (
              <div className="flex h-full items-center justify-center text-gray-400">
                <Loader2 className="h-6 w-6 animate-spin" />
              </div>
            ) : products.length === 0 ? (
              <div className="empty-state">
                <Package className="mx-auto h-10 w-10 text-gray-300" />
                <p className="mt-2 font-medium text-gray-700">No products to show</p>
                <p className="text-sm text-gray-500">
                  {inStockOnly
                    ? 'Nothing matches this filter with stock available.'
                    : 'Nothing matches this search.'}
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
                {products.map((product) => (
                  <ProductCard
                    key={product.id}
                    product={product}
                    inBasket={
                      basket.find((line) => line.inventory_id === product.id)?.quantity ?? 0
                    }
                    onAdd={() => addToBasket(product)}
                  />
                ))}
              </div>
            )}
          </div>
        </section>

        {/* ---------------- Basket ---------------- */}
        <aside
          className={`no-print fixed inset-y-0 right-0 z-40 flex w-[92%] max-w-sm flex-col border-l border-gray-200 bg-white transition-transform lg:static lg:z-auto lg:w-[400px] lg:translate-x-0 ${
            basketOpen ? 'translate-x-0' : 'translate-x-full'
          }`}
        >
          <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-gray-900">
              <ShoppingCart className="h-4 w-4" />
              Basket
              <span className="badge badge-neutral">{totalQuantity}</span>
            </h2>
            <div className="flex items-center gap-1">
              {basket.length > 0 && (
                <button
                  type="button"
                  onClick={clearBasket}
                  className="p-2 rounded-lg text-gray-400 hover:bg-red-50 hover:text-red-600"
                  aria-label="Clear basket"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
              <button
                type="button"
                onClick={() => setBasketOpen(false)}
                className="p-2 rounded-lg text-gray-400 hover:bg-gray-100 lg:hidden"
                aria-label="Close basket"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            {basket.length === 0 ? (
              <div className="empty-state py-10">
                <ShoppingCart className="mx-auto h-9 w-9 text-gray-300" />
                <p className="mt-2 text-sm text-gray-500">Tap a product to add it</p>
              </div>
            ) : (
              <ul className="space-y-2">
                {basket.map((line) => {
                  const quoted = quote?.lines.find(
                    (entry) => entry.inventory_id === line.inventory_id
                  );
                  const expiryDays = daysUntilExpiry(line.expiry_date);
                  return (
                    <li
                      key={line.inventory_id}
                      className="rounded-xl border border-gray-200 p-2.5"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-gray-900">
                            {line.product_name}
                          </p>
                          {line.generic_name && (
                            <p className="truncate text-xs text-gray-500">{line.generic_name}</p>
                          )}
                          <div className="mt-1 flex flex-wrap items-center gap-1">
                            {line.requires_prescription && (
                              <span className="badge badge-info flex items-center gap-0.5 text-2xs">
                                <Pill className="h-3 w-3" /> Rx
                              </span>
                            )}
                            {line.batch_number && (
                              <span className="badge badge-neutral text-2xs">
                                {line.batch_number}
                              </span>
                            )}
                            {expiryDays !== null && expiryDays <= 90 && (
                              <span
                                className={`badge text-2xs ${
                                  expiryDays < 0 ? 'badge-danger' : 'badge-warning'
                                }`}
                              >
                                {expiryDays < 0 ? 'Expired' : `Exp ${expiryDays}d`}
                              </span>
                            )}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => removeLine(line.inventory_id)}
                          className="p-1.5 rounded-lg text-gray-400 hover:bg-red-50 hover:text-red-600"
                          aria-label={`Remove ${line.product_name}`}
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </div>

                      <div className="mt-2 flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => changeQuantity(line.inventory_id, -1)}
                            className="flex h-10 w-10 items-center justify-center rounded-lg border border-gray-200 text-gray-700 active:bg-gray-100"
                            aria-label={`Decrease ${line.product_name}`}
                          >
                            <Minus className="h-4 w-4" />
                          </button>
                          <span className="w-10 text-center text-base font-semibold tabular-nums">
                            {line.quantity}
                          </span>
                          <button
                            type="button"
                            onClick={() => changeQuantity(line.inventory_id, 1)}
                            disabled={line.quantity >= line.quantity_available}
                            className="flex h-10 w-10 items-center justify-center rounded-lg border border-gray-200 text-gray-700 active:bg-gray-100 disabled:opacity-40"
                            aria-label={`Increase ${line.product_name}`}
                          >
                            <Plus className="h-4 w-4" />
                          </button>
                          <span className="ml-1 text-xs text-gray-400">
                            {line.quantity_available} avail
                          </span>
                        </div>
                        <span className="text-sm font-semibold tabular-nums text-gray-900">
                          {quoted ? money(quoted.line_total) : money(line.unit_price * line.quantity)}
                        </span>
                      </div>

                      {quoted?.oversold && (
                        <p className="mt-1 flex items-center gap-1 text-xs font-medium text-red-600">
                          <AlertTriangle className="h-3 w-3" />
                          Only {quoted.quantity_available} left on the shelf
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}

            {basket.length > 0 && (
              <div className="mt-4 space-y-2 border-t border-gray-100 pt-3">
                <button
                  type="button"
                  onClick={() => setCustomerOpen((open) => !open)}
                  className="flex w-full items-center justify-between rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700"
                >
                  <span>
                    {patient
                      ? `Patient: ${patient.first_name} ${patient.last_name}`
                      : customerName
                        ? `Customer: ${customerName}`
                        : 'Walk-in customer'}
                  </span>
                  <span className="text-xs text-primary-600">
                    {customerOpen ? 'Hide' : 'Add'}
                  </span>
                </button>

                {customerOpen && (
                  <div className="space-y-2 rounded-lg bg-gray-50 p-3">
                    <PatientSelect value={patient} onChange={setPatient} label="Patient (optional)" />
                    <input
                      className="input"
                      value={customerName}
                      onChange={(event) => setCustomerName(event.target.value)}
                      placeholder="Walk-in name (optional)"
                      aria-label="Customer name"
                    />
                    <input
                      className="input"
                      inputMode="tel"
                      value={customerPhone}
                      onChange={(event) => setCustomerPhone(event.target.value)}
                      placeholder="Phone (optional)"
                      aria-label="Customer phone"
                    />
                    <textarea
                      className="input"
                      rows={2}
                      value={note}
                      onChange={(event) => setNote(event.target.value)}
                      placeholder="Note for the receipt (optional)"
                      aria-label="Sale note"
                    />
                  </div>
                )}

                {needsApprover && (
                  <div>
                    <label className="label" htmlFor="approver">
                      Prescriber approval
                    </label>
                    <select
                      id="approver"
                      className="select"
                      value={approverId}
                      onChange={(event) => setApproverId(event.target.value)}
                    >
                      <option value="">Select the pharmacist who approved…</option>
                      {approvers.map((approver) => (
                        <option key={approver.id} value={approver.id}>
                          {approver.name} ({approver.role === 'pharmacy_owner' ? 'Owner' : 'Pharmacist'})
                        </option>
                      ))}
                    </select>
                    <p className="mt-1 text-xs text-gray-500">
                      This basket contains a prescription-only medicine. A pharmacist must be named.
                    </p>
                  </div>
                )}

                <div>
                  <label className="label" htmlFor="discount">
                    Discount (GHS)
                  </label>
                  <div className="flex gap-2">
                    <div className="relative flex-1">
                      <Percent className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                      <input
                        id="discount"
                        className="input pl-9 tabular-nums"
                        inputMode="decimal"
                        value={discountText}
                        onChange={(event) => setDiscountText(event.target.value)}
                        placeholder="0.00"
                      />
                    </div>
                    <input
                      className="input flex-1"
                      value={discountReason}
                      onChange={(event) => setDiscountReason(event.target.value)}
                      placeholder="Reason"
                      aria-label="Discount reason"
                      disabled={discountValue <= 0}
                    />
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* ---------------- Totals ---------------- */}
          <div className="border-t border-gray-200 bg-gray-50 px-4 py-3">
            {quoteError && (
              <p className="mb-2 flex items-start gap-1.5 text-xs font-medium text-red-600">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
                {quoteError}
              </p>
            )}

            <div className="space-y-1 text-sm">
              <TotalRow label="Subtotal" value={quote ? money(quote.summary.subtotal) : '—'} />
              {quote && amount(quote.summary.discount_amount) > 0 && (
                <TotalRow
                  label="Discount"
                  value={`-${money(quote.summary.discount_amount)}`}
                  tone="text-green-700"
                />
              )}
              {quote && amount(quote.summary.total_tax) > 0 && (
                <TotalRow
                  label={
                    quote.pricing_mode === 'exclusive'
                      ? 'VAT + NHIL + GETFund'
                      : 'Tax included'
                  }
                  value={money(quote.summary.total_tax)}
                  muted
                />
              )}
              <div className="flex items-baseline justify-between border-t border-gray-200 pt-2">
                <span className="text-sm font-semibold text-gray-900">Total</span>
                <span className="text-2xl font-bold tabular-nums text-gray-900">
                  {quoting ? (
                    <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
                  ) : quote ? (
                    money(quote.summary.total_amount)
                  ) : (
                    '—'
                  )}
                </span>
              </div>
              {quote && !quote.vat_registered && (
                <p className="text-xs text-amber-700">
                  Not VAT registered — no levies are being charged.
                </p>
              )}
            </div>

            <button
              type="button"
              onClick={openPayment}
              disabled={
                basket.length === 0 || !quote || Boolean(quoteError) || approverMissing || !online
              }
              className="btn-primary mt-3 w-full py-4 text-lg font-semibold"
            >
              <ShoppingCart className="h-5 w-5" />
              Charge {quote ? money(quote.summary.total_amount) : ''}
            </button>
          </div>
        </aside>
      </div>

      {/* Mobile basket toggle */}
      {basketOpen && (
        <div
          className="no-print fixed inset-0 z-30 bg-black/40 lg:hidden"
          onClick={() => setBasketOpen(false)}
        />
      )}
      <button
        type="button"
        onClick={() => setBasketOpen(true)}
        className="no-print fixed bottom-4 right-4 z-30 flex items-center gap-2 rounded-full bg-primary-600 px-5 py-3.5 text-sm font-semibold text-white shadow-lg lg:hidden"
      >
        <ShoppingCart className="h-5 w-5" />
        {totalQuantity} · {quote ? money(quote.summary.total_amount) : money(0)}
      </button>

      <PaymentModal
        open={paymentOpen}
        onClose={() => (submitting ? undefined : setPaymentOpen(false))}
        balance={balance}
        config={config}
        tenders={tenders}
        onTendersChange={setTenders}
        onComplete={completeSale}
        submitting={submitting}
      />

      <ReceiptModal
        sale={receipt}
        open={receiptOpen}
        onClose={() => {
          setReceiptOpen(false);
          setReceipt(null);
        }}
        pharmacyName={pharmacy?.name}
        pharmacyPhone={pharmacy?.phone}
      />
    </div>
  );
}

function TotalRow({
  label,
  value,
  muted,
  tone,
}: {
  label: string;
  value: string;
  muted?: boolean;
  tone?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className={muted ? 'text-xs text-gray-500' : 'text-gray-600'}>{label}</span>
      <span className={`tabular-nums ${tone || (muted ? 'text-gray-500' : 'text-gray-900')}`}>
        {value}
      </span>
    </div>
  );
}

function ProductCard({
  product,
  inBasket,
  onAdd,
}: {
  product: PosProduct;
  inBasket: number;
  onAdd: () => void;
}) {
  const expiryDays = daysUntilExpiry(product.expiry_date);
  const unavailable = product.quantity <= 0 || product.is_expired;

  return (
    <button
      type="button"
      onClick={onAdd}
      disabled={unavailable}
      className={`relative flex min-h-[104px] flex-col justify-between rounded-xl border-2 bg-white p-2.5 text-left transition active:scale-[0.98] ${
        unavailable
          ? 'cursor-not-allowed border-gray-100 opacity-50'
          : inBasket > 0
            ? 'border-primary-400 shadow-sm'
            : 'border-gray-200 hover:border-primary-300'
      }`}
    >
      {inBasket > 0 && (
        <span className="absolute -right-1.5 -top-1.5 flex h-6 min-w-[24px] items-center justify-center rounded-full bg-primary-600 px-1.5 text-xs font-bold text-white">
          {inBasket}
        </span>
      )}

      <div className="min-w-0">
        <p className="truncate text-sm font-semibold leading-tight text-gray-900">
          {product.product_name}
        </p>
        {product.generic_name && (
          <p className="truncate text-xs text-gray-500">{product.generic_name}</p>
        )}
      </div>

      <div className="mt-1.5 flex items-end justify-between gap-1">
        <span className="text-base font-bold tabular-nums text-primary-700">
          {money(product.unit_price)}
        </span>
        <span
          className={`text-xs font-medium tabular-nums ${
            product.quantity === 0
              ? 'text-red-600'
              : product.needs_reorder
                ? 'text-amber-600'
                : 'text-gray-500'
          }`}
        >
          {product.quantity === 0 ? 'Out' : `${product.quantity} left`}
        </span>
      </div>

      <div className="mt-1 flex flex-wrap gap-1">
        {product.requires_prescription && (
          <span className="badge badge-info text-2xs">Rx</span>
        )}
        {product.vat_treatment === 'standard' && (
          <span className="badge badge-neutral text-2xs">VAT</span>
        )}
        {product.is_expired ? (
          <span className="badge badge-danger text-2xs">Expired</span>
        ) : product.near_expiry ? (
          <span className="badge badge-warning text-2xs">Exp {expiryDays}d</span>
        ) : null}
        {product.needs_reorder && product.quantity > 0 && (
          <span className="badge badge-warning text-2xs">Reorder</span>
        )}
      </div>
    </button>
  );
}
