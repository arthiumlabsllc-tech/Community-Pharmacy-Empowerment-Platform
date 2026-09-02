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
import { useSyncStatus } from '@/hooks/use-sync-status';
import { PatientSelect, type PatientOption } from '@/components/ui/patient-select';
import { PaymentModal, type Tender } from '@/components/pos/payment-modal';
import { ReceiptModal } from '@/components/pos/receipt-modal';
import {
  OfflineReceiptModal,
  type ProvisionalSale,
} from '@/components/pos/offline-receipt-modal';
import { api, ApiError } from '@/lib/api';
import { buildTotalsView } from '@/lib/pos-totals';
import {
  amount,
  money,
  type PaymentConfig,
  type PosCategory,
  type PosProduct,
  type Quote,
  type Sale,
  type VatTreatment,
} from '@/lib/pos-types';
import {
  canSellOffline,
  cachedTaxSettings,
  applyOfflineStockChange,
  type CachedTaxSettings,
} from '@/lib/offline/catalogue';
import { priceOfflineBasket, round2, type OfflineQuote } from '@/lib/offline/pricing';
import {
  filterOfflineCatalogue,
  offlineCategories,
  offlineCatalogue,
  offlinePaymentOptions,
  queueOfflineSale,
  refreshOfflineCache,
  type CacheRefreshResult,
} from '@/lib/offline/till';

/** One line in the till's basket, before it is priced. */
interface BasketLine {
  inventory_id: string;
  product_name: string;
  generic_name: string | null;
  quantity: number;
  /** Display only — whoever prices the sale re-reads the stock row. */
  unit_price: number;
  sell_unit: string;
  requires_prescription: boolean;
  quantity_available: number;
  batch_number: string | null;
  expiry_date: string | null;
  /** Carried so this device can price the line when the server cannot. */
  vat_treatment: VatTreatment;
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
 * Prices and tax are never computed here while the server can be reached. Every
 * total comes from `POST /pos/quote`, which runs the same Act 1151 engine that
 * creates the sale, so what the cashier sees is what the customer is charged.
 *
 * When it cannot be reached the till narrows instead of stopping: it sells from
 * the catalogue, tax settings and payment methods cached on this device, prices
 * the basket locally (total only — no statutory split), and queues the sale for
 * the sync scheduler. What it will not do offline is discount, take a card or
 * look up a patient, and each of those is withheld with a reason on screen
 * rather than left to fail at the last tap.
 */
export default function PosPage() {
  const { isAuthenticated, user } = useAuthStore();
  const pharmacy = usePharmacyStore((state) => state.profile);
  const fetchProfile = usePharmacyStore((state) => state.fetchProfile);
  const profileLoaded = usePharmacyStore((state) => state.loaded);
  const hydrated = useHydrated();
  const router = useRouter();
  const sync = useSyncStatus();

  const [serverProducts, setServerProducts] = useState<PosProduct[]>([]);
  const [serverCategories, setServerCategories] = useState<PosCategory[]>([]);
  const [config, setConfig] = useState<PaymentConfig | null>(null);
  const [approvers, setApprovers] = useState<Approver[]>([]);
  const [loadingProducts, setLoadingProducts] = useState(true);

  /**
   * Whether the API has been answering. Kept apart from `sync.online`, which is
   * the browser's own view of the network: a pharmacy whose server is down but
   * whose Wi-Fi is up is just as unable to price a basket, and just as able to
   * keep trading from the cache.
   */
  const [serverReachable, setServerReachable] = useState(true);
  const degraded = !sync.online || !serverReachable;

  // Everything this device holds for an outage.
  const [cachedProducts, setCachedProducts] = useState<PosProduct[]>([]);
  const [cachedTax, setCachedTax] = useState<CachedTaxSettings | null>(null);
  const [offlinePayment, setOfflinePayment] = useState<Awaited<
    ReturnType<typeof offlinePaymentOptions>
  > | null>(null);
  const [offlineReadiness, setOfflineReadiness] = useState<{
    ready: boolean;
    products: number;
    reason: string | null;
  } | null>(null);
  const [cacheResult, setCacheResult] = useState<CacheRefreshResult | null>(null);

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
  const [provisional, setProvisional] = useState<ProvisionalSale | null>(null);
  const [provisionalOpen, setProvisionalOpen] = useState(false);
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
      setServerProducts(response.data || []);
      setServerReachable(true);
    } catch (error) {
      // Only a server that could not answer puts the till into offline selling.
      // A 401 or a 403 is a real error the cashier has to see, and hiding it
      // behind "offline" would leave them selling on an expired session.
      if (error instanceof ApiError && error.retryable) {
        setServerReachable(false);
      } else {
        toast.error(error instanceof Error ? error.message : 'Could not load products');
      }
    } finally {
      setLoadingProducts(false);
    }
  }, [debouncedSearch, category, inStockOnly]);

  /**
   * Reads the whole cached catalogue. Filtering is left to `products` below
   * because there is no server to ask, and re-reading storage on every keystroke
   * would buy nothing.
   */
  const loadOfflineCatalogue = useCallback(async () => {
    setLoadingProducts(true);
    try {
      const [rows, tax, payment, readiness] = await Promise.all([
        offlineCatalogue(),
        cachedTaxSettings(),
        offlinePaymentOptions(),
        canSellOffline(),
      ]);
      setCachedProducts(rows);
      setCachedTax(tax);
      setOfflinePayment(payment);
      setOfflineReadiness(readiness);
    } catch (error) {
      setCachedTax(null);
      setOfflineReadiness({
        ready: false,
        products: 0,
        reason:
          error instanceof Error
            ? error.message
            : 'Offline storage is unavailable on this device',
      });
    } finally {
      setLoadingProducts(false);
    }
  }, []);

  const loadMeta = useCallback(async () => {
    try {
      const [categoryResponse, configResponse, approverResponse] = await Promise.all([
        api.get<{ success: boolean; data: PosCategory[] }>('/pos/categories'),
        api.get<{ success: boolean; data: PaymentConfig }>('/pos/payment-config'),
        api.get<{ success: boolean; data: Approver[] }>('/pos/approvers'),
      ]);
      setServerCategories(categoryResponse.data || []);
      setConfig(configResponse.data || null);
      setApprovers(approverResponse.data || []);
      setServerReachable(true);
    } catch (error) {
      // The till can still sell cash items without the approver list, so this is
      // not fatal — but it is how the till finds out the server has gone.
      if (error instanceof ApiError && error.retryable) setServerReachable(false);
    }
  }, []);

  useEffect(() => {
    if (!hydrated || !isAuthenticated || degraded) return;
    loadMeta();
  }, [hydrated, isAuthenticated, degraded, loadMeta]);

  // Online the server does the filtering, so a filter change means a request.
  useEffect(() => {
    if (!hydrated || !isAuthenticated || degraded) return;
    loadCatalogue();
  }, [hydrated, isAuthenticated, degraded, loadCatalogue]);

  // Offline the cache is read once per outage, and filtered in the browser.
  useEffect(() => {
    if (!hydrated || !isAuthenticated || !degraded) return;
    loadOfflineCatalogue();
  }, [hydrated, isAuthenticated, degraded, loadOfflineCatalogue]);

  /**
   * Keeps this device able to survive the next outage.
   *
   * Run whenever the server is answering rather than on a schedule: a till that
   * is opened every morning is a till whose cache is a day old at worst, and the
   * alternative — discovering the cache is empty at the moment the connection
   * drops — is the failure this whole layer exists to prevent.
   */
  useEffect(() => {
    if (!hydrated || !isAuthenticated || degraded) return;
    let cancelled = false;

    (async () => {
      const result = await refreshOfflineCache();
      if (!cancelled) setCacheResult(result);
    })();

    return () => {
      cancelled = true;
    };
  }, [hydrated, isAuthenticated, degraded]);

  /**
   * Takes a discount away the moment the server goes.
   *
   * `priceOfflineBasket` refuses a discounted basket rather than mispricing it,
   * so a figure entered while online would otherwise strand the basket: the
   * cashier would be looking at a total they cannot charge, with the reason
   * buried in a field they entered ten minutes ago. Withholding the discount is
   * the honest outcome — the amount stays what the shelf says — but it has to
   * happen out loud.
   */
  useEffect(() => {
    if (!degraded || !discountText.trim()) return;
    toast('Discount removed — the till cannot apply one offline', { icon: '🧾' });
    setDiscountText('');
    setDiscountReason('');
  }, [degraded, discountText]);

  const totalQuantity = useMemo(
    () => basket.reduce((total, line) => total + line.quantity, 0),
    [basket]
  );
  const hasPrescriptionItem = useMemo(
    () => basket.some((line) => line.requires_prescription),
    [basket]
  );

  /**
   * Lines selling more than this device last counted.
   *
   * A caution, not a refusal. The cached figure is whatever the till saw when it
   * was last online, and a second till that is also disconnected may have sold
   * the same stock since — which is exactly why the server exempts a queued sale
   * from its own `quantity >= requested` guard and reports the shortfall for a
   * stock-take instead of losing a real sale. Stopping the cashier here would
   * mean either turning away a customer holding the goods, or the sale not being
   * recorded at all, and the second is worse than a negative count.
   */
  const overCounted = useMemo(
    () =>
      new Set(
        degraded
          ? basket
              .filter((line) => line.quantity > line.quantity_available)
              .map((line) => line.inventory_id)
          : []
      ),
    [degraded, basket]
  );

  /**
   * The grid, from whichever source is answering. Offline it is the whole cache
   * filtered here — same fields, same order as `GET /pos/products`, so the till
   * looks the same either way.
   */
  const products = useMemo(
    () =>
      degraded
        ? filterOfflineCatalogue(cachedProducts, {
            search: debouncedSearch,
            category,
            inStock: inStockOnly,
          })
        : serverProducts,
    [degraded, cachedProducts, debouncedSearch, category, inStockOnly, serverProducts]
  );

  const categories = useMemo(
    () => (degraded ? offlineCategories(cachedProducts) : serverCategories),
    [degraded, cachedProducts, serverCategories]
  );

  // Cashiers cannot self-approve a prescription-only medicine; the server
  // requires the id of a pharmacist or owner at the same pharmacy. Offline there
  // is no approver list to choose from and none is needed: priceOfflineBasket
  // refuses an Rx basket unless the person signed in here is one of those same
  // roles, and the server then records that person as the approver itself.
  const needsApprover = hasPrescriptionItem && user?.role === 'staff' && !degraded;
  const approverMissing = needsApprover && !approverId;

  const discountValue = Math.max(Number(debouncedDiscount) || 0, 0);

  // Ask the server to price the basket. Debounced so a rapid +/+/+ on the
  // quantity stepper does not fire three requests.
  useEffect(() => {
    if (!hydrated || !isAuthenticated || degraded) return;
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
        setServerReachable(true);
      } catch (error: any) {
        if (cancelled) return;
        setQuote(null);
        setQuoteError(error?.message || 'Could not price this basket');
        // Losing the connection mid-sale is the common case, and the basket the
        // cashier has already rung up should survive it.
        if (error instanceof ApiError && error.retryable) setServerReachable(false);
      } finally {
        if (!cancelled) setQuoting(false);
      }
    };

    const timer = setTimeout(run, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [hydrated, isAuthenticated, degraded, basket, discountValue]);

  /**
   * This device's price for the same basket, computed synchronously from the
   * cached tax settings. Total only: the statutory split stays the server's, so
   * a provisional receipt can never print a breakdown the server then disagrees
   * with.
   */
  const offlineQuote = useMemo<OfflineQuote | null>(() => {
    if (!degraded || basket.length === 0) return null;

    return priceOfflineBasket(
      basket.map((line) => ({
        inventoryId: line.inventory_id,
        productName: line.product_name,
        quantity: line.quantity,
        unitPrice: line.unit_price,
        vatTreatment: line.vat_treatment,
        requiresPrescription: line.requires_prescription,
      })),
      cachedTax,
      { basketDiscount: discountValue, userRole: user?.role }
    );
  }, [degraded, basket, cachedTax, discountValue, user?.role]);

  /** The one figure the whole screen renders from. */
  const totals = useMemo(
    () =>
      buildTotalsView({
        source: degraded ? 'device' : 'server',
        quote,
        offlineQuote,
        taxSettings: cachedTax,
        quoteError,
        pending: quoting,
      }),
    [degraded, quote, offlineQuote, cachedTax, quoteError, quoting]
  );

  /**
   * What the payment sheet is offered. Offline it is assembled from the cache
   * with `gateway.connected: false`, because nothing here can reach Paystack —
   * carrying the last known gateway state into an outage would let the sheet
   * imply a charge that cannot happen.
   */
  const paymentConfig = useMemo<PaymentConfig | null>(() => {
    if (!degraded) return config;

    return {
      gateway: { connected: false, mode: 'manual', keyPrefix: '' },
      networks: offlinePayment?.networks ?? [],
      methods: offlinePayment?.methods ?? ['cash'],
      currency: offlinePayment?.currency ?? 'GHS',
      tax: {
        vat_registered: cachedTax ? cachedTax.vatRegistered : true,
        pricing_mode: cachedTax?.pricingMode ?? 'inclusive',
        rates: cachedTax?.rates ?? null,
      },
    };
  }, [degraded, config, offlinePayment, cachedTax]);

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
        // Online the server is the shelf and its word is final. Offline the
        // cached count is stale by definition, so going past it is allowed and
        // flagged — see `overCounted`.
        if (!degraded && existing.quantity + 1 > product.quantity) {
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
          vat_treatment: product.vat_treatment,
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
          if (!degraded && next > line.quantity_available) {
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
    if (!totals.priced) {
      toast.error(
        totals.refusal ||
          (degraded
            ? 'This basket cannot be priced on this device'
            : 'Waiting for the server to price this basket')
      );
      return;
    }
    if (approverMissing) {
      toast.error('Name the pharmacist who approved this prescription');
      return;
    }
    if (totals.oversold.length > 0) {
      toast.error(`Not enough stock of ${totals.oversold[0].productName}`);
      return;
    }
    // A device that has never been online has no prices and no tax settings, so
    // there is nothing to sell from. Say that here rather than letting the
    // cashier collect money and then fail on the last tap.
    if (degraded && offlineReadiness && !offlineReadiness.ready) {
      toast.error(offlineReadiness.reason || 'This device cannot sell offline');
      return;
    }
    setTenders([]);
    setPaymentOpen(true);
  }

  async function completeSale() {
    if (degraded) return completeSaleOffline();
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
      // And the offline cache would otherwise offer it again during the next
      // outage. Best effort: the sale is safely on the server, and a stale
      // cached figure is corrected by the next full refresh.
      void applyOfflineStockChange(
        basket.map((line) => ({ id: line.inventory_id, sold: line.quantity }))
      ).catch(() => undefined);
    } catch (error: any) {
      const message = error?.message || 'Could not record the sale';
      toast.error(message);
      // A 409 means stock changed underneath the till — refresh the grid.
      if (error?.status === 409) loadCatalogue();
      // The connection went mid-sale. The basket is kept so the cashier can
      // record it on the device instead of ringing it up again.
      if (error instanceof ApiError && error.retryable) setServerReachable(false);
    } finally {
      setSubmitting(false);
    }
  }

  /**
   * Records the sale on this device instead of posting it.
   *
   * Nothing is sent and nothing is charged: the queue holds the sale until the
   * scheduler can reach the server, and the slip says so in as many words. The
   * basket is deliberately not cleared until the write to storage has succeeded,
   * because a basket that vanished without a queued sale behind it is money
   * taken and goods gone with no record of either.
   */
  async function completeSaleOffline() {
    if (!offlineQuote || !offlineQuote.priced) {
      toast.error(offlineQuote?.refusalReason || 'This basket cannot be priced on this device');
      return;
    }

    setSubmitting(true);
    try {
      const { item, stockError } = await queueOfflineSale({
        lines: basket.map((line) => ({
          inventoryId: line.inventory_id,
          quantity: line.quantity,
        })),
        payments: tenders.map((tender) => ({
          method: tender.method,
          amount: tender.amount,
          momo_number: tender.momo_number || null,
          momo_network: tender.momo_network || null,
          reference: tender.reference || null,
        })),
        quote: offlineQuote,
        // Only a patient chosen before the connection dropped; the search itself
        // needs the server, so there is nothing to pick from here.
        patientId: patient?.id || null,
        // The basket's id, so a Charge that reached the server and lost its
        // response comes back as the sale it already created rather than a
        // second one. Also what makes a double tap on Record harmless: the
        // queue keys on it, so the second write replaces the first.
        clientSaleId: basketId,
        customerName,
        customerPhone,
        note,
      });

      const paid = round2(tenders.reduce((total, tender) => total + tender.amount, 0));

      setProvisional({
        clientSaleId: item.id,
        recordedAt: item.recordedAt,
        servedBy: `${user?.first_name ?? ''} ${user?.last_name ?? ''}`.trim(),
        lines: offlineQuote.lines.map((line) => ({
          productName: line.productName,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          lineTotal: line.lineTotal,
        })),
        payments: tenders.map((tender) => ({
          method: tender.method,
          amount: tender.amount,
          momoNumber: tender.momo_number || null,
          momoNetwork: tender.momo_network || null,
          reference: tender.reference || null,
        })),
        total: offlineQuote.grandTotal,
        paid,
        change: Math.max(round2(paid - offlineQuote.grandTotal), 0),
        customerName: customerName.trim() || null,
        customerPhone: customerPhone.trim() || null,
        note: note.trim() || null,
        warnings: offlineQuote.warnings,
      });

      setPaymentOpen(false);
      setProvisionalOpen(true);
      clearBasket();
      // The cache now holds the reduced quantity, so re-read it rather than
      // leaving the grid showing stock that has physically left the shelf.
      await loadOfflineCatalogue();

      toast.success('Sale recorded on this device — it will sync when the connection returns');
      if (stockError) {
        toast.error(
          `${stockError}. The stock figure on this device may now be out of date.`
        );
      }
    } catch (error: any) {
      // Most likely storage: IndexedDB full, or a private window that refuses it.
      // Either way nothing was recorded, and the cashier has to be told that
      // rather than shown a receipt.
      toast.error(error?.message || 'Could not record the sale on this device');
    } finally {
      setSubmitting(false);
    }
  }

  const balance = totals.total;
  const offlineReady = degraded && Boolean(offlineReadiness?.ready);

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

        {degraded && (
          <span className="badge badge-danger flex items-center gap-1">
            <WifiOff className="h-3 w-3" /> {sync.online ? 'Server unreachable' : 'Offline'}
          </span>
        )}

        {sync.counts.total > 0 && (
          <Link
            href="/sync"
            className={`badge flex items-center gap-1 ${
              sync.counts.dead > 0 ? 'badge-danger' : 'badge-warning'
            }`}
            title={
              sync.counts.dead > 0
                ? 'Something was rejected and needs a decision — it will not send itself'
                : 'Recorded on this device, waiting for a connection'
            }
          >
            {sync.counts.total} queued
          </Link>
        )}

        {!degraded && config && (
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

        {/* The gateway badge is withheld offline on purpose: a cached "Gateway
            live" during an outage would imply a charge that cannot happen. */}
        {!degraded && cacheResult && (
          <span
            className={`badge ${cacheResult.complete ? 'badge-success' : 'badge-warning'}`}
            title={
              cacheResult.complete
                ? `${cacheResult.products} products, the tax settings and the payment methods are cached on this device, so the till can keep selling if the connection drops`
                : cacheResult.error || 'The offline cache is incomplete'
            }
          >
            {cacheResult.complete
              ? `Offline ready · ${cacheResult.products}`
              : 'Offline cache incomplete'}
          </span>
        )}

        <Link href="/sales" className="btn-secondary btn-sm">
          <History className="h-4 w-4" />
          <span className="hidden sm:inline">Sales</span>
        </Link>
      </header>

      {degraded && (
        <div className="no-print flex flex-wrap items-center gap-x-2 bg-red-600 px-4 py-2 text-sm text-white">
          <WifiOff className="h-4 w-4 flex-shrink-0" />
          <span className="font-semibold">
            {sync.online ? 'Cannot reach the server' : 'No internet connection'}
          </span>
          {offlineReady ? (
            <span>
              — selling from this device&rsquo;s cache ({offlineReadiness?.products} products). Each
              sale is recorded here and sent when the connection returns.
            </span>
          ) : (
            <span>
              — this device cannot sell:{' '}
              {offlineReadiness
                ? offlineReadiness.reason
                : 'the offline cache is still loading.'}
            </span>
          )}
          <span className="w-full text-xs opacity-85">
            Discounts, card payments and patient lookup are unavailable until the connection is
            back. Mobile money is written down, not charged.
          </span>
          <Link href="/sync" className="ml-auto text-xs font-medium underline underline-offset-2">
            Pending sales{sync.counts.total > 0 ? ` (${sync.counts.total})` : ''}
          </Link>
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
                onClick={degraded ? loadOfflineCatalogue : loadCatalogue}
                aria-label={degraded ? 'Re-read the offline cache' : 'Refresh products'}
                title={
                  degraded
                    ? 'Re-read what this device has cached'
                    : 'Refresh products from the server'
                }
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
              // Told apart because the remedy is different: an empty cache is
              // fixed by getting online once, a filter miss by clearing the
              // filter, and pointing at the wrong one wastes the outage.
              degraded && cachedProducts.length === 0 ? (
                <div className="empty-state">
                  <WifiOff className="mx-auto h-10 w-10 text-gray-300" />
                  <p className="mt-2 font-medium text-gray-700">Nothing is cached on this device</p>
                  <p className="text-sm text-gray-500">
                    {offlineReadiness?.reason ||
                      'The till has not been able to reach the server from here, so there is no stock list to sell from.'}
                  </p>
                  <button
                    type="button"
                    onClick={loadOfflineCatalogue}
                    className="btn-secondary btn-sm mt-3"
                  >
                    <RefreshCw className="h-4 w-4" />
                    Try again
                  </button>
                </div>
              ) : (
                <div className="empty-state">
                  <Package className="mx-auto h-10 w-10 text-gray-300" />
                  <p className="mt-2 font-medium text-gray-700">No products to show</p>
                  <p className="text-sm text-gray-500">
                    {inStockOnly
                      ? 'Nothing matches this filter with stock available.'
                      : 'Nothing matches this search.'}
                  </p>
                </div>
              )
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
                  const quoted = totals.lines[line.inventory_id];
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
                            disabled={!degraded && line.quantity >= line.quantity_available}
                            className="flex h-10 w-10 items-center justify-center rounded-lg border border-gray-200 text-gray-700 active:bg-gray-100 disabled:opacity-40"
                            aria-label={`Increase ${line.product_name}`}
                          >
                            <Plus className="h-4 w-4" />
                          </button>
                          <span className="ml-1 text-xs text-gray-400">
                            {line.quantity_available} {degraded ? 'counted' : 'avail'}
                          </span>
                        </div>
                        <span className="text-sm font-semibold tabular-nums text-gray-900">
                          {quoted ? money(quoted.lineTotal) : money(line.unit_price * line.quantity)}
                        </span>
                      </div>

                      {quoted?.oversold && (
                        <p className="mt-1 flex items-center gap-1 text-xs font-medium text-red-600">
                          <AlertTriangle className="h-3 w-3" />
                          Only {quoted.quantityAvailable} left on the shelf
                        </p>
                      )}

                      {overCounted.has(line.inventory_id) && (
                        <p className="mt-1 flex items-start gap-1 text-xs font-medium text-amber-700">
                          <AlertTriangle className="mt-0.5 h-3 w-3 flex-shrink-0" />
                          More than the {line.quantity_available} this device last counted. Flagged
                          for a stock-take when it syncs.
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
                    {/* The patient search is a server request, so offline there is
                        nothing to pick from. A patient chosen before the
                        connection dropped is kept and named, because dropping
                        them would silently detach the sale from a record the
                        cashier can still see on screen. */}
                    {degraded ? (
                      <p className="text-xs text-gray-600">
                        {patient
                          ? `Selling to ${patient.first_name} ${patient.last_name}, chosen before the connection dropped. Their record is attached when this sale syncs.`
                          : 'Patient records need a connection, so a sale recorded here is a walk-in. A name and phone below are still written onto it.'}
                      </p>
                    ) : (
                      <PatientSelect
                        value={patient}
                        onChange={setPatient}
                        label="Patient (optional)"
                      />
                    )}
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

                {/* Offline there is no approver list to choose from and none is
                    needed: `priceOfflineBasket` refuses an Rx basket unless the
                    person signed in here is a pharmacist, owner or super admin,
                    and the server then records that same person as the approver
                    when the sale syncs. So this note only ever appears on a
                    basket this device is allowed to price. */}
                {hasPrescriptionItem && degraded && totals.priced && (
                  <p className="rounded-lg bg-blue-50 p-2 text-xs text-blue-900">
                    Prescription-only medicine. {user?.first_name} {user?.last_name} is signed in
                    with authority to approve it, and is recorded as the approver when this sale
                    syncs.
                  </p>
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
                        disabled={degraded}
                      />
                    </div>
                    <input
                      className="input flex-1"
                      value={discountReason}
                      onChange={(event) => setDiscountReason(event.target.value)}
                      placeholder="Reason"
                      aria-label="Discount reason"
                      disabled={degraded || discountValue <= 0}
                    />
                  </div>
                  {degraded && (
                    <p className="mt-1 text-xs text-gray-500">
                      Withheld offline. Spreading a discount across the lines changes each
                      line&rsquo;s taxable base, and this device does not compute tax.
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* ---------------- Totals ---------------- */}
          <div className="border-t border-gray-200 bg-gray-50 px-4 py-3">
            {totals.refusal && (
              <p className="mb-2 flex items-start gap-1.5 text-xs font-medium text-red-600">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
                {totals.refusal}
              </p>
            )}

            <div className="space-y-1 text-sm">
              <TotalRow label="Subtotal" value={totals.priced ? money(totals.subtotal) : '—'} />
              {totals.discount > 0 && (
                <TotalRow
                  label="Discount"
                  value={`-${money(totals.discount)}`}
                  tone="text-green-700"
                />
              )}
              {totals.tax !== null && totals.tax > 0 && totals.taxLabel && (
                <TotalRow label={totals.taxLabel} value={money(totals.tax)} muted />
              )}
              {/* Absent rather than zero. This device does not compute the
                  statutory split, and a "Tax 0.00" row would read as a claim
                  that no tax was charged — a different statement, and one the
                  pharmacy would have to answer for on its VAT return. */}
              {totals.priced && totals.tax === null && (
                <p className="text-xs text-gray-500">
                  Tax breakdown is added by the server when this sale syncs.
                </p>
              )}
              <div className="flex items-baseline justify-between border-t border-gray-200 pt-2">
                <span className="text-sm font-semibold text-gray-900">
                  {totals.provisional && totals.priced ? 'Total (provisional)' : 'Total'}
                </span>
                <span className="text-2xl font-bold tabular-nums text-gray-900">
                  {totals.pending ? (
                    <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
                  ) : totals.priced ? (
                    money(totals.total)
                  ) : (
                    '—'
                  )}
                </span>
              </div>
              {totals.priced && !totals.vatRegistered && (
                <p className="text-xs text-amber-700">
                  Not VAT registered — no levies are being charged.
                </p>
              )}
              {totals.warnings.map((warning) => (
                <p key={warning} className="flex items-start gap-1 text-xs text-gray-600">
                  <AlertTriangle className="mt-0.5 h-3 w-3 flex-shrink-0 text-amber-500" />
                  {warning}
                </p>
              ))}
            </div>

            <button
              type="button"
              onClick={openPayment}
              disabled={
                basket.length === 0 ||
                !totals.priced ||
                Boolean(totals.refusal) ||
                approverMissing ||
                (degraded && !offlineReady)
              }
              className="btn-primary mt-3 w-full py-4 text-lg font-semibold"
            >
              <ShoppingCart className="h-5 w-5" />
              {/* "Charge" is a promise about a gateway. Offline nothing is
                  charged — the sale and the money are written down — so the
                  button says so. */}
              {degraded ? 'Record' : 'Charge'} {totals.priced ? money(totals.total) : ''}
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
        {totalQuantity} · {totals.priced ? money(totals.total) : money(0)}
      </button>

      <PaymentModal
        open={paymentOpen}
        onClose={() => (submitting ? undefined : setPaymentOpen(false))}
        balance={balance}
        config={paymentConfig}
        tenders={tenders}
        onTendersChange={setTenders}
        onComplete={completeSale}
        submitting={submitting}
        offline={degraded}
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

      {/* The offline slip. Never `ReceiptModal`: that prints a receipt number
          and a statutory tax split, and this device has neither. */}
      <OfflineReceiptModal
        sale={provisional}
        open={provisionalOpen}
        onClose={() => {
          setProvisionalOpen(false);
          setProvisional(null);
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
