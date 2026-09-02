'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import toast from 'react-hot-toast';
import { format } from 'date-fns';
import {
  AlertTriangle,
  Ban,
  Clock,
  Loader2,
  RefreshCw,
  Search,
  ShoppingCart,
} from 'lucide-react';
import { useAuthStore } from '@/store/auth-store';
import { usePharmacyStore } from '@/store/pharmacy-store';
import { useHydrated } from '@/hooks/use-hydrated';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { usePermissions } from '@/hooks/use-permissions';
import { DashboardLayout } from '@/components/layout/dashboard-layout';
import { Modal } from '@/components/ui/modal';
import { ReceiptModal } from '@/components/pos/receipt-modal';
import { api } from '@/lib/api';
import {
  amount,
  money,
  SALE_STATUS_LABEL,
  type PaymentMethod,
  type Sale,
  type SaleListRow,
  type SaleStatus,
} from '@/lib/pos-types';

interface ListSummary {
  sale_count: number;
  revenue: string | number;
  tax: string | number;
}

const STATUS_BADGE: Record<SaleStatus, string> = {
  completed: 'badge-success',
  pending: 'badge-warning',
  voided: 'badge-danger',
};

const STATUS_FILTERS: Array<{ value: SaleStatus | ''; label: string }> = [
  { value: '', label: 'All' },
  { value: 'completed', label: 'Completed' },
  { value: 'pending', label: 'Awaiting payment' },
  { value: 'voided', label: 'Voided' },
];

const METHOD_FILTERS: Array<{ value: PaymentMethod | ''; label: string }> = [
  { value: '', label: 'Any method' },
  { value: 'cash', label: 'Cash' },
  { value: 'momo', label: 'Mobile Money' },
  { value: 'card', label: 'Card' },
  { value: 'bank_transfer', label: 'Bank transfer' },
  { value: 'nhis', label: 'NHIS' },
  { value: 'credit', label: 'Credit' },
];

function today(): string {
  return format(new Date(), 'yyyy-MM-dd');
}

/** The first payment still waiting on the customer, if any. */
function pendingReference(sale: Sale): string | null {
  const pending = sale.payments.find((payment) => payment.status === 'pending');
  return pending?.reference || null;
}

/**
 * Sale history and receipts.
 *
 * Every figure comes from the server: the list summary is computed over the
 * filtered set, and the receipt renders the tax that was actually recorded on
 * the sale rather than recomputing it from today's rates.
 */
export default function SalesPage() {
  const { isAuthenticated } = useAuthStore();
  const pharmacy = usePharmacyStore((state) => state.profile);
  const fetchProfile = usePharmacyStore((state) => state.fetchProfile);
  const profileLoaded = usePharmacyStore((state) => state.loaded);
  const hydrated = useHydrated();
  const router = useRouter();
  const { canVoidSale } = usePermissions();

  const [rows, setRows] = useState<SaleListRow[]>([]);
  const [summary, setSummary] = useState<ListSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<SaleStatus | ''>('');
  const [method, setMethod] = useState<PaymentMethod | ''>('');
  const [from, setFrom] = useState(today());
  const [to, setTo] = useState(today());

  const [sale, setSale] = useState<Sale | null>(null);
  const [receiptOpen, setReceiptOpen] = useState(false);
  const [loadingSaleId, setLoadingSaleId] = useState<string | null>(null);
  const [verifyingReference, setVerifyingReference] = useState<string | null>(null);

  const [voidTarget, setVoidTarget] = useState<Sale | null>(null);
  const [voidReason, setVoidReason] = useState('');
  const [voiding, setVoiding] = useState(false);

  const debouncedSearch = useDebouncedValue(search, 400);

  useEffect(() => {
    if (hydrated && !isAuthenticated) router.replace('/login');
  }, [hydrated, isAuthenticated, router]);

  useEffect(() => {
    if (hydrated && isAuthenticated && !profileLoaded) fetchProfile();
  }, [hydrated, isAuthenticated, profileLoaded, fetchProfile]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: '25' });
      if (debouncedSearch) params.set('search', debouncedSearch);
      if (status) params.set('status', status);
      if (method) params.set('method', method);
      if (from) params.set('from', from);
      if (to) params.set('to', to);

      const response = await api.get<{
        success: boolean;
        data: SaleListRow[];
        summary?: ListSummary;
        pagination?: { totalPages: number };
      }>(`/pos/sales?${params.toString()}`);

      setRows(response.data || []);
      setSummary(response.summary || null);
      setTotalPages(response.pagination?.totalPages || 1);
    } catch (error: any) {
      toast.error(error?.message || 'Failed to load sales');
    } finally {
      setLoading(false);
    }
  }, [page, debouncedSearch, status, method, from, to]);

  useEffect(() => {
    if (!hydrated || !isAuthenticated) return;
    load();
  }, [hydrated, isAuthenticated, load]);

  // Changing a filter starts over at page one; otherwise the till can land on
  // an empty page 5 of a two-page result set.
  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, status, method, from, to]);

  async function openSale(id: string) {
    setLoadingSaleId(id);
    try {
      const response = await api.get<{ success: boolean; data: Sale }>(`/pos/sales/${id}`);
      setSale(response.data);
      setReceiptOpen(true);
    } catch (error: any) {
      toast.error(error?.message || 'Failed to load that sale');
    } finally {
      setLoadingSaleId(null);
    }
  }

  /**
   * Asks Paystack for the definitive state of a MoMo or card payment. The
   * charge response is never trusted on its own, so a pending sale stays
   * pending until this (or the signed webhook) says the money arrived.
   */
  async function verify(reference: string) {
    setVerifyingReference(reference);
    try {
      const response = await api.post<{
        success: boolean;
        message: string;
        data: { payment_status: string; sale: Sale };
      }>(`/pos/payments/${encodeURIComponent(reference)}/verify`);

      setSale(response.data.sale);
      const outcome = response.data.payment_status;
      if (outcome === 'success') toast.success(response.message);
      else if (outcome === 'pending') toast(response.message, { icon: '⏳' });
      else toast.error(response.message);

      load();
    } catch (error: any) {
      toast.error(error?.message || 'Could not verify that payment');
    } finally {
      setVerifyingReference(null);
    }
  }

  async function confirmVoid() {
    if (!voidTarget) return;
    if (!voidReason.trim()) {
      toast.error('A reason is required to void a sale');
      return;
    }

    setVoiding(true);
    try {
      const response = await api.post<{ success: boolean; message: string; data: Sale }>(
        `/pos/sales/${voidTarget.id}/void`,
        { reason: voidReason.trim() }
      );
      toast.success(response.message);
      setSale(response.data);
      setVoidTarget(null);
      setVoidReason('');
      setReceiptOpen(true);
      load();
    } catch (error: any) {
      toast.error(error?.message || 'Failed to void the sale');
    } finally {
      setVoiding(false);
    }
  }

  const pendingCount = rows.filter((row) => row.status === 'pending').length;

  return (
    <DashboardLayout>
      <div className="animate-fade-in space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Sales</h1>
            <p className="text-sm text-gray-500">
              Till history, receipts and unresolved mobile money payments.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" className="btn-secondary btn-sm" onClick={load}>
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
            <a href="/pos" className="btn-primary btn-sm">
              <ShoppingCart className="h-4 w-4" />
              Open till
            </a>
          </div>
        </div>

        {/* Summary over the filtered window, computed server-side. */}
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="card p-4">
            <p className="stat-label">Completed sales</p>
            <p className="stat-value">{summary?.sale_count ?? 0}</p>
          </div>
          <div className="card p-4">
            <p className="stat-label">Revenue (incl. tax)</p>
            <p className="stat-value">{money(summary?.revenue)}</p>
          </div>
          <div className="card p-4">
            <p className="stat-label">VAT + NHIL + GETFund collected</p>
            <p className="stat-value">{money(summary?.tax)}</p>
            <p className="mt-1 text-xs text-gray-500">Owed to GRA, not revenue.</p>
          </div>
        </div>

        {pendingCount > 0 && (
          <div className="flex items-start gap-2 rounded-xl border border-yellow-200 bg-yellow-50 p-3 text-sm text-yellow-900">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <p>
              {pendingCount} sale{pendingCount === 1 ? '' : 's'} on this page still awaiting payment.
              A mobile money prompt has been sent but Paystack has not confirmed it — use
              &ldquo;Check payment&rdquo; rather than assuming the money arrived.
            </p>
          </div>
        )}

        {/* Filters */}
        <div className="card p-4">
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-5">
            <div className="relative lg:col-span-2">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
              <input
                className="input pl-9"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Receipt number, customer or patient…"
                aria-label="Search sales"
              />
            </div>
            <div>
              <label className="label" htmlFor="filter-from">From</label>
              <input
                id="filter-from"
                type="date"
                className="input"
                value={from}
                onChange={(event) => setFrom(event.target.value)}
              />
            </div>
            <div>
              <label className="label" htmlFor="filter-to">To</label>
              <input
                id="filter-to"
                type="date"
                className="input"
                value={to}
                onChange={(event) => setTo(event.target.value)}
              />
            </div>
            <div>
              <label className="label" htmlFor="filter-method">Method</label>
              <select
                id="filter-method"
                className="select"
                value={method}
                onChange={(event) => setMethod(event.target.value as PaymentMethod | '')}
              >
                {METHOD_FILTERS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap gap-1.5">
            {STATUS_FILTERS.map((option) => (
              <button
                key={option.value || 'all'}
                type="button"
                onClick={() => setStatus(option.value)}
                className={`rounded-full border px-3 py-1.5 text-sm font-medium ${
                  status === option.value
                    ? 'border-primary-500 bg-primary-50 text-primary-700'
                    : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'
                }`}
              >
                {option.label}
              </button>
            ))}
            <button
              type="button"
              className="ml-auto text-sm text-primary-600 hover:underline"
              onClick={() => {
                setFrom('');
                setTo('');
              }}
            >
              All dates
            </button>
          </div>
        </div>

        {/* Table */}
        <div className="card overflow-hidden">
          {loading ? (
            <div className="flex items-center justify-center py-16 text-gray-400">
              <Loader2 className="h-6 w-6 animate-spin" />
            </div>
          ) : rows.length === 0 ? (
            <div className="empty-state py-16">
              <ShoppingCart className="mx-auto h-10 w-10 text-gray-300" />
              <p className="mt-2 font-medium text-gray-700">No sales in this window</p>
              <p className="text-sm text-gray-500">Try widening the dates or clearing the filters.</p>
            </div>
          ) : (
            <div className="table-container">
              <table className="table">
                <thead>
                  <tr>
                    <th>Receipt</th>
                    <th>When</th>
                    <th>Customer</th>
                    <th className="text-right">Items</th>
                    <th>Method</th>
                    <th className="text-right">Total</th>
                    <th className="text-right">Paid</th>
                    <th>Status</th>
                    <th className="text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const balance = amount(row.total_amount) - amount(row.amount_paid);
                    return (
                      <tr key={row.id} className="hover:bg-gray-50">
                        <td className="font-medium text-gray-900">{row.receipt_number}</td>
                        <td className="whitespace-nowrap text-gray-600">
                          {format(new Date(row.created_at), 'dd MMM HH:mm')}
                        </td>
                        <td className="text-gray-600">
                          {row.patient_name || row.customer_name || 'Walk-in'}
                          <span className="block text-xs text-gray-400">
                            by {row.served_by_name || '—'}
                          </span>
                        </td>
                        <td className="text-right tabular-nums text-gray-600">{row.item_count}</td>
                        <td className="text-xs text-gray-600">
                          {row.methods ? (
                            row.methods.split(', ').map((entry) => (
                              <span key={entry} className="badge badge-neutral mr-1">
                                {entry}
                              </span>
                            ))
                          ) : (
                            <span className="text-gray-400">none</span>
                          )}
                        </td>
                        <td className="text-right font-semibold tabular-nums text-gray-900">
                          {money(row.total_amount)}
                        </td>
                        <td className="text-right tabular-nums text-gray-600">
                          {money(row.amount_paid)}
                          {row.status === 'pending' && balance > 0.009 && (
                            <span className="block text-xs font-medium text-amber-600">
                              owes {money(balance)}
                            </span>
                          )}
                        </td>
                        <td>
                          <span className={`badge ${STATUS_BADGE[row.status]}`}>
                            {SALE_STATUS_LABEL[row.status]}
                          </span>
                        </td>
                        <td>
                          <div className="flex items-center justify-end gap-1">
                            <button
                              type="button"
                              className="btn-ghost btn-sm"
                              onClick={() => openSale(row.id)}
                              disabled={loadingSaleId === row.id}
                            >
                              {loadingSaleId === row.id ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                'Receipt'
                              )}
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {totalPages > 1 && (
            <div className="flex items-center justify-between border-t border-gray-100 px-4 py-3">
              <button
                type="button"
                className="btn-secondary btn-sm"
                onClick={() => setPage((current) => Math.max(current - 1, 1))}
                disabled={page <= 1 || loading}
              >
                Previous
              </button>
              <span className="text-sm text-gray-500">
                Page {page} of {totalPages}
              </span>
              <button
                type="button"
                className="btn-secondary btn-sm"
                onClick={() => setPage((current) => Math.min(current + 1, totalPages))}
                disabled={page >= totalPages || loading}
              >
                Next
              </button>
            </div>
          )}
        </div>
      </div>

      <ReceiptModal
        sale={sale}
        open={receiptOpen}
        onClose={() => {
          setReceiptOpen(false);
          setSale(null);
        }}
        pharmacyName={pharmacy?.name}
        pharmacyPhone={pharmacy?.phone}
        actions={
          sale ? (
            <>
              {(() => {
                const reference = pendingReference(sale);
                if (!reference || sale.status === 'voided') return null;
                return (
                  <button
                    type="button"
                    className="btn-secondary btn-sm"
                    onClick={() => verify(reference)}
                    disabled={verifyingReference === reference}
                  >
                    {verifyingReference === reference ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <RefreshCw className="h-4 w-4" />
                    )}
                    Check payment
                  </button>
                );
              })()}
              {/* Voiding restocks the shelf and is restricted to the same roles
                  the backend allows (owner and pharmacist). */}
              {canVoidSale && sale.status !== 'voided' && (
                <button
                  type="button"
                  className="btn-danger btn-sm"
                  onClick={() => {
                    setVoidTarget(sale);
                    setVoidReason('');
                  }}
                >
                  <Ban className="h-4 w-4" />
                  Void
                </button>
              )}
            </>
          ) : null
        }
      />

      <Modal
        open={Boolean(voidTarget)}
        onClose={() => (voiding ? undefined : setVoidTarget(null))}
        title="Void this sale"
        description={voidTarget ? `Receipt ${voidTarget.receipt_number} · ${money(voidTarget.total_amount)}` : ''}
        size="sm"
        footer={
          <>
            <button
              type="button"
              className="btn-secondary btn-sm"
              onClick={() => setVoidTarget(null)}
              disabled={voiding}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn-danger"
              onClick={confirmVoid}
              disabled={voiding || !voidReason.trim()}
            >
              {voiding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Ban className="h-4 w-4" />}
              Void and restock
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <p>
              This puts every item back on the shelf and marks any completed payment as refunded.
              The sale is kept for audit — it is not deleted.
            </p>
          </div>

          {voidTarget && amount(voidTarget.amount_paid) > 0 && (
            <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900">
              <Clock className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <p>
                {money(voidTarget.amount_paid)} was taken on this sale. Voiding records it as
                refunded, but <strong>returning the money to the customer is a separate step</strong>{' '}
                you must do at the counter. Mobile money refunds are not sent automatically.
              </p>
            </div>
          )}

          <div>
            <label className="label" htmlFor="void-reason">Reason</label>
            <textarea
              id="void-reason"
              className="input"
              rows={3}
              value={voidReason}
              onChange={(event) => setVoidReason(event.target.value)}
              placeholder="e.g. wrong item scanned, customer changed their mind"
            />
          </div>
        </div>
      </Modal>
    </DashboardLayout>
  );
}
