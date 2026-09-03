'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { format } from 'date-fns';
import {
  AlertTriangle,
  Boxes,
  Loader2,
  Lock,
  Phone,
  PhoneOff,
  RefreshCw,
  Search,
  ShieldAlert,
} from 'lucide-react';
import { useAuthStore } from '@/store/auth-store';
import { useHydrated } from '@/hooks/use-hydrated';
import { usePermissions } from '@/hooks/use-permissions';
import { DashboardLayout } from '@/components/layout/dashboard-layout';
import { BatchPanelModal } from '@/components/inventory/batch-panel-modal';
import { api } from '@/lib/api';
import { money } from '@/lib/pos-types';
import { formatDateUtc } from '@/lib/dates';
import { BATCH_MIGRATION, isBatchTrackingMissing } from '@/lib/batches';
import {
  buildCallList,
  buildRecallQuery,
  buildUnreachableList,
  EMPTY_RECALL_SEARCH,
  groupBatchesForQuarantine,
  PROVENANCE,
  QUARANTINE_ACTION,
  RECALL_LIMIT_CHOICES,
  recallSearchErrors,
  type RecallBatch,
  type RecallResult,
  type RecallSearchForm,
  type RecallSale,
} from '@/lib/recall';

/**
 * Checked before a deep-linked batch id is put into a URL.
 *
 * The link comes from the batch panel, but the address bar can be edited, and
 * an unchecked string interpolated into a path is how `../` ends up requesting
 * a route nobody intended. The server validates the same thing; this keeps a
 * malformed link from being sent at all.
 */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Recall traceability: who was sold a lot, and what is still on the shelf.
 *
 * Two questions, answered together, because answering only one is how a recall
 * goes wrong. A patient list leaves the rest of the lot being sold; a
 * quarantine list leaves everybody who already bought it uncontacted.
 *
 * Every figure comes from the server, including the split between lines traced
 * through the batch ledger and lines matched on the lot number a receipt
 * recorded. The second kind is a lead and not a proof, and this page says so on
 * each row rather than once at the top.
 */
export default function RecallPage() {
  const { isAuthenticated } = useAuthStore();
  const hydrated = useHydrated();
  const router = useRouter();
  const { canTraceRecall, canEditInventory } = usePermissions();

  const [form, setForm] = useState<RecallSearchForm>(EMPTY_RECALL_SEARCH);
  const [touched, setTouched] = useState(false);
  const [result, setResult] = useState<RecallResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [notInstalled, setNotInstalled] = useState(false);
  /** The lot this trace was entered from, when it was entered from one. */
  const [tracedBatchId, setTracedBatchId] = useState<string | null>(null);
  const [panelProductId, setPanelProductId] = useState<string | null>(null);

  useEffect(() => {
    if (hydrated && !isAuthenticated) router.replace('/login');
  }, [hydrated, isAuthenticated, router]);

  /**
   * Runs a trace and stores the answer.
   *
   * Both ways in end here — a search, and arriving from one batch — because the
   * server shapes the two responses identically. The batch route exists only to
   * resolve a batch id into a lot and a product first, so that the two ways in
   * cannot disagree about what counts as exposure.
   */
  const trace = useCallback(async (path: string) => {
    setLoading(true);
    setFailure(null);
    try {
      const response = await api.get<{ success: boolean; data: RecallResult }>(path);
      setResult(response.data);
      setNotInstalled(false);
    } catch (error) {
      setResult(null);
      if (isBatchTrackingMissing(error)) {
        setNotInstalled(true);
      } else {
        setFailure((error as { message?: string })?.message ?? 'Failed to trace the recall');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  // The batch panel deep-links here with ?batch=<id>. Read from window.location
  // rather than useSearchParams() so the page can still be statically rendered
  // without a Suspense boundary.
  useEffect(() => {
    if (!hydrated || !isAuthenticated || !canTraceRecall) return;
    const batchId = new URLSearchParams(window.location.search).get('batch');
    if (!batchId || !UUID_PATTERN.test(batchId)) return;

    setTracedBatchId(batchId);
    void trace(`/inventory/batches/${batchId}/sales`);
  }, [hydrated, isAuthenticated, canTraceRecall, trace]);

  const errors = recallSearchErrors(form);
  const hasErrors = Object.values(errors).some((message) => message !== '');

  function setField<K extends keyof RecallSearchForm>(field: K, value: RecallSearchForm[K]) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setTouched(true);
    if (hasErrors) return;

    setTracedBatchId(null);
    void trace(`/inventory/recall?${buildRecallQuery(form)}`);
  }

  const groups = useMemo(
    () => groupBatchesForQuarantine(result?.batches ?? []),
    [result]
  );
  const callList = useMemo(() => buildCallList(result?.sales ?? []), [result]);
  const unreachable = useMemo(() => buildUnreachableList(result?.sales ?? []), [result]);

  if (hydrated && isAuthenticated && !canTraceRecall) {
    return (
      <DashboardLayout>
        <div className="empty-state py-20">
          <Lock className="mx-auto h-10 w-10 text-gray-300" />
          <p className="mt-3 font-medium text-gray-800">Recall traces are restricted</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-gray-500">
            A trace is a list of named patients with their telephone numbers. It is available to the
            pharmacy owner and pharmacists only. If a lot needs tracing, ask one of them.
          </p>
          <a href="/inventory" className="btn-primary btn-sm mt-4">Back to inventory</a>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="animate-fade-in space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Recall Trace</h1>
            <p className="text-sm text-gray-500">
              Who was sold a lot, and what is still on the shelf.
            </p>
          </div>
          {result && !loading && (
            <button
              type="button"
              className="btn-secondary btn-sm"
              onClick={() =>
                void trace(
                  tracedBatchId
                    ? `/inventory/batches/${tracedBatchId}/sales`
                    : `/inventory/recall?${buildRecallQuery(form)}`
                )
              }
            >
              <RefreshCw className="h-4 w-4" />
              Run it again
            </button>
          )}
        </div>

        {/* ============ THE SEARCH ============ */}
        <form className="card p-4" onSubmit={onSubmit} noValidate>
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-5">
            <div>
              <label className="label" htmlFor="recall-batch">Lot number</label>
              <input
                id="recall-batch"
                className={`input font-mono ${touched && errors.batch_number ? 'input-error' : ''}`}
                value={form.batch_number}
                onChange={(event) => setField('batch_number', event.target.value)}
                placeholder="ABC123"
                autoComplete="off"
              />
              {touched && errors.batch_number && (
                <p className="mt-1 text-xs text-red-600">{errors.batch_number}</p>
              )}
            </div>
            <div>
              <label className="label" htmlFor="recall-product">Product name</label>
              <input
                id="recall-product"
                className="input"
                value={form.product_name}
                onChange={(event) => setField('product_name', event.target.value)}
                placeholder="Amoxicillin"
                autoComplete="off"
              />
              <p className="mt-1 text-xs text-gray-400">
                Lot numbers are only unique within a medicine, so naming the product narrows it.
              </p>
            </div>
            <div>
              <label className="label" htmlFor="recall-from">Sold from</label>
              <input
                id="recall-from"
                type="date"
                className={`input ${touched && errors.from ? 'input-error' : ''}`}
                value={form.from}
                onChange={(event) => setField('from', event.target.value)}
              />
              {touched && errors.from && (
                <p className="mt-1 text-xs text-red-600">{errors.from}</p>
              )}
            </div>
            <div>
              <label className="label" htmlFor="recall-to">Sold to</label>
              <input
                id="recall-to"
                type="date"
                className="input"
                value={form.to}
                onChange={(event) => setField('to', event.target.value)}
              />
            </div>
            <div>
              <label className="label" htmlFor="recall-limit">How many lines</label>
              <select
                id="recall-limit"
                className="select"
                value={form.limit}
                onChange={(event) => setField('limit', event.target.value)}
              >
                {RECALL_LIMIT_CHOICES.map((choice) => (
                  <option key={choice.value} value={choice.value}>{choice.label}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button type="submit" className="btn-primary btn-sm" disabled={loading}>
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
              Trace this lot
            </button>
            {(form.batch_number !== '' || form.product_name !== '' || form.from !== '' || form.to !== '') && (
              <button
                type="button"
                className="text-sm text-primary-600 hover:underline"
                onClick={() => {
                  setForm(EMPTY_RECALL_SEARCH);
                  setTouched(false);
                }}
              >
                Clear
              </button>
            )}
            {tracedBatchId && (
              <p className="text-xs text-gray-500">
                Traced from one lot. Search above to widen it to a product or a date range.
              </p>
            )}
          </div>
        </form>

        {/* ============ STATES ============ */}
        {notInstalled && <NotInstalled />}

        {failure && (
          <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-900">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <p>{failure}</p>
          </div>
        )}

        {loading && (
          <div className="card flex items-center justify-center py-16 text-gray-400">
            <Loader2 className="h-6 w-6 animate-spin" />
          </div>
        )}

        {!loading && !notInstalled && !failure && !result && (
          <div className="card empty-state py-16">
            <ShieldAlert className="mx-auto h-10 w-10 text-gray-300" />
            <p className="mt-2 font-medium text-gray-700">Nothing traced yet</p>
            <p className="mx-auto max-w-md text-sm text-gray-500">
              Enter the lot number from a recall notice, or a product name, and this will list every
              sale that drew from it — and every box of it still on the shelf.
            </p>
          </div>
        )}

        {!loading && result && (
          <>
            <Banners result={result} />

            {/* ============ THE NUMBERS ============ */}
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="card p-4">
                <p className="stat-label">Still on the shelf</p>
                <p className="stat-value">{result.totals.units_still_on_hand}</p>
                <p className="mt-1 text-xs text-gray-500">
                  {money(
                    result.batches.reduce((total, batch) => total + batch.stock_value, 0)
                  )}{' '}
                  at cost, across {result.totals.batch_count} lot
                  {result.totals.batch_count === 1 ? '' : 's'}.
                </p>
              </div>
              <div className="card p-4">
                <p className="stat-label">To take off the shelf</p>
                <p className="stat-value">{result.totals.units_to_quarantine}</p>
                <p className="mt-1 text-xs text-gray-500">
                  In {groups.toQuarantine.length} lot
                  {groups.toQuarantine.length === 1 ? '' : 's'} still marked sellable.
                </p>
              </div>
              <div className="card p-4">
                <p className="stat-label">Dispensed to customers</p>
                <p className="stat-value">{result.totals.units_dispensed}</p>
                <p className="mt-1 text-xs text-gray-500">
                  Across {result.totals.sale_count - result.totals.voided_count} sale
                  {result.totals.sale_count - result.totals.voided_count === 1 ? '' : 's'}
                  {result.totals.voided_count > 0
                    ? `, plus ${result.totals.units_returned} units on ${result.totals.voided_count} voided line${result.totals.voided_count === 1 ? '' : 's'} that came back`
                    : ''}
                  .
                </p>
              </div>
              <div className="card p-4">
                <p className="stat-label">Calls to make</p>
                <p className="stat-value">{result.reach.distinctContacts}</p>
                <p className="mt-1 text-xs text-gray-500">
                  {result.reach.unreachableUnits > 0
                    ? `${result.reach.unreachableUnits} unit${result.reach.unreachableUnits === 1 ? '' : 's'} went to somebody with no number on file.`
                    : 'Every unit that went out can be telephoned about.'}
                </p>
              </div>
            </div>

            {result.totals.first_sold_at && result.totals.last_sold_at && (
              <p className="text-sm text-gray-500">
                Sold between {format(new Date(result.totals.first_sold_at), 'dd MMM yyyy')} and{' '}
                {format(new Date(result.totals.last_sold_at), 'dd MMM yyyy')}.
              </p>
            )}

            {/* ============ WHAT TO DO WITH THE STOCK ============ */}
            <section className="card p-4">
              <h2 className="flex items-center gap-2 text-base font-semibold text-gray-900">
                <Boxes className="h-4 w-4 text-gray-500" />
                What is still here
              </h2>
              {result.batches.length === 0 ? (
                <p className="mt-2 text-sm text-gray-500">
                  {result.sales.length > 0
                    ? 'No lot on file matches this, so there is nothing here to take off the shelf. The lines below were matched on the lot number a receipt recorded — and with no lot to check against, there is no way to be sure the stock has all gone.'
                    : // The server matches on UPPER(TRIM(...)), so case and
                      // surrounding spaces are already forgiven. Saying "check the
                      // spelling" would send somebody to look at the one thing
                      // that cannot be the problem.
                      'No lot on file matches this, and no sale drew from one either. The match ignores capital letters and spaces at either end, so if the notice is right then the stock was never received here as a tracked lot — try the product name instead.'}
                </p>
              ) : (
                <div className="mt-3 space-y-3">
                  <BatchGroup
                    title="Take these off the shelf"
                    batches={groups.toQuarantine}
                    canEdit={canEditInventory}
                    onOpen={setPanelProductId}
                  />
                  <BatchGroup
                    title="Already off the shelf"
                    batches={groups.alreadyOff}
                    canEdit={canEditInventory}
                    onOpen={setPanelProductId}
                  />
                  <BatchGroup
                    title="Nothing left of these"
                    batches={groups.allDispensed}
                    canEdit={canEditInventory}
                    onOpen={setPanelProductId}
                  />
                </div>
              )}
            </section>

            {/* ============ WHO TO PHONE ============ */}
            <section className="card p-4">
              <h2 className="flex items-center gap-2 text-base font-semibold text-gray-900">
                <Phone className="h-4 w-4 text-gray-500" />
                Who to phone
              </h2>
              <p className="mt-1 text-sm text-gray-500">
                One line per number, biggest quantity first. Voided lines are not here — that stock
                came back — but they are still in the full list below.
              </p>
              {callList.length === 0 ? (
                <p className="mt-3 text-sm text-gray-500">
                  {result.totals.sale_count === 0
                    ? 'No sale drew from this lot, so there is nobody to call.'
                    : 'Nothing on this list can be telephoned about. See below.'}
                </p>
              ) : (
                <ul className="mt-3 divide-y divide-gray-100">
                  {callList.map((target) => (
                    <li key={target.phone} className="flex flex-wrap items-start gap-2 py-2.5">
                      <div className="min-w-0 flex-1">
                        <p className="font-mono text-sm font-medium text-gray-900">
                          <a href={`tel:${target.phone}`} className="hover:underline">
                            {target.phone}
                          </a>
                        </p>
                        <p className="text-xs text-gray-500">
                          {target.names.length > 0 ? target.names.join(', ') : 'No name on the sale'}
                          {target.source === 'customer' ? ' — walk-in number' : ''}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="text-sm font-semibold text-gray-900 tabular-nums">
                          {target.units} unit{target.units === 1 ? '' : 's'}
                        </p>
                        <p className="text-xs text-gray-400">
                          {target.receipts.length === 1
                            ? target.receipts[0]
                            : `${target.receipts.length} receipts`}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* ============ WHO CANNOT BE PHONED ============ */}
            {unreachable.length > 0 && (
              <section className="card border-yellow-200 p-4">
                <h2 className="flex items-center gap-2 text-base font-semibold text-gray-900">
                  <PhoneOff className="h-4 w-4 text-yellow-600" />
                  {unreachable.length} line{unreachable.length === 1 ? '' : 's'} with nobody to phone
                </h2>
                <p className="mt-1 text-sm text-gray-600">
                  {result.reach.unreachableUnits} unit
                  {result.reach.unreachableUnits === 1 ? '' : 's'} went out with no number on the
                  sale. This is the part a round of phone calls does not close: it needs a notice in
                  the window, and a call to the supplier or the FDA.
                </p>
                <ul className="mt-3 space-y-1.5">
                  {unreachable.map((line, index) => (
                    <li
                      // A sale can draw the same product from two lots, so the
                      // sale id alone repeats within one recall.
                      key={`${line.sale_id}-${index}`}
                      className="text-sm text-gray-700"
                    >
                      <span className="font-mono text-xs text-gray-500">{line.receipt_number}</span>{' '}
                      {format(new Date(line.sold_at), 'dd MMM yyyy')} — {line.quantity} ×{' '}
                      {line.product_name}
                      {line.served_by ? <span className="text-gray-500"> by {line.served_by.name}</span> : null}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {/* ============ EVERY MATCHED LINE ============ */}
            <section className="card overflow-hidden">
              <div className="p-4">
                <h2 className="text-base font-semibold text-gray-900">Every matched line</h2>
                <p className="mt-1 text-sm text-gray-500">
                  {result.totals.sale_count} line{result.totals.sale_count === 1 ? '' : 's'}. Each
                  one says how it was matched, because the two kinds are not equally trustworthy.
                </p>
              </div>
              {result.sales.length === 0 ? (
                <div className="empty-state py-10">
                  <p className="text-sm text-gray-500">
                    No sale drew from this lot in the window searched.
                  </p>
                </div>
              ) : (
                <div className="table-container">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Receipt</th>
                        <th>When</th>
                        <th>Lot</th>
                        <th>Who</th>
                        <th className="text-right">Qty</th>
                        <th>Matched</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.sales.map((line, index) => (
                        // Keyed with the position as well as the sale, because one
                        // sale drawing a product from two lots produces two rows
                        // with the same sale_id.
                        <SaleRow key={`${line.sale_id}-${index}`} line={line} />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        )}
      </div>

      {/* The write-off is recorded in the batch panel rather than here: it shows
          every lot of the product, so the box being written off is chosen
          against the ones beside it rather than from a recall list alone.
          `canTrace` is false because this page is the trace — a "Trace this lot"
          link here would only reload what is already on screen. */}
      <BatchPanelModal
        open={!!panelProductId}
        productId={panelProductId}
        canEdit={canEditInventory}
        canTrace={false}
        onClose={() => setPanelProductId(null)}
        onChanged={() => {
          void trace(
            tracedBatchId
              ? `/inventory/batches/${tracedBatchId}/sales`
              : `/inventory/recall?${buildRecallQuery(form)}`
          );
        }}
      />
    </DashboardLayout>
  );
}

/** The three things the server says about a result and the page must not bury. */
function Banners({ result }: { result: RecallResult }) {
  return (
    <>
      {result.truncated && (
        <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <p>
            This is the first {result.limit} matching lines and there are more. The list is not
            complete — raise &ldquo;How many lines&rdquo; or narrow the dates before acting on it.
          </p>
        </div>
      )}

      {result.caveat && (
        <div className="flex items-start gap-2 rounded-xl border border-yellow-200 bg-yellow-50 p-3 text-sm text-yellow-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <p>{result.caveat}</p>
        </div>
      )}

      {result.no_batch_on_file && (
        <div className="flex items-start gap-2 rounded-xl border border-yellow-200 bg-yellow-50 p-3 text-sm text-yellow-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <p>{result.no_batch_on_file}</p>
        </div>
      )}
    </>
  );
}

/**
 * One of the three quarantine groups.
 *
 * The caller passes all three, including the ones that came back empty, so that
 * a lot already off the shelf is still shown — that is an answer somebody would
 * otherwise go and look for again. A group with nothing in it renders nothing at
 * all: a heading over an empty list reads as a section that failed to load.
 */
function BatchGroup({
  title,
  batches,
  canEdit,
  onOpen,
}: {
  title: string;
  batches: RecallBatch[];
  canEdit: boolean;
  onOpen: (productId: string) => void;
}) {
  if (batches.length === 0) return null;

  return (
    <div>
      <h3 className="text-sm font-medium text-gray-700">{title}</h3>
      <ul className="mt-2 space-y-2">
        {batches.map((batch) => {
          const action = QUARANTINE_ACTION[batch.action];
          return (
            <li key={batch.id} className="rounded-xl border border-gray-200 p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-900">{batch.product_name}</p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-gray-500">
                    <span className="badge badge-neutral font-mono">{batch.batch_number}</span>
                    <span className={`badge ${action.className}`}>{action.label}</span>
                    {batch.is_expired && <span className="badge badge-danger">Expired</span>}
                    {batch.is_backfill && (
                      <span
                        className="badge badge-neutral"
                        title="A balance carried over when batch tracking was installed, not a delivery somebody recorded."
                      >
                        Opening balance
                      </span>
                    )}
                  </p>
                  <p className="mt-1.5 text-xs text-gray-500">{action.instruction}</p>
                  <p className="mt-1 text-xs text-gray-400">
                    {batch.manufacturer ? `${batch.manufacturer} · ` : ''}
                    {batch.expiry_date ? `Exp ${formatDateUtc(batch.expiry_date)} · ` : ''}
                    {batch.supplier_name ? `from ${batch.supplier_name}` : 'supplier not recorded'}
                    {batch.invoice_number ? ` · invoice ${batch.invoice_number}` : ''}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-lg font-semibold text-gray-900 tabular-nums">
                    {batch.quantity_on_hand}
                  </p>
                  <p className="text-xs text-gray-400">{money(batch.stock_value)} at cost</p>
                  <button
                    type="button"
                    className="btn-secondary btn-sm mt-2"
                    onClick={() => onOpen(batch.inventory_id)}
                    title="Open every lot of this product, and record the write-off there."
                  >
                    <Boxes className="h-4 w-4" />
                    {canEdit ? 'Open lots' : 'View lots'}
                  </button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** One row of the full exposure list. */
function SaleRow({ line }: { line: RecallSale }) {
  const provenance = PROVENANCE[line.provenance];
  const who = line.patient?.name ?? line.customer?.name ?? 'Walk-in';

  return (
    <tr className={`hover:bg-gray-50 ${line.voided ? 'opacity-60' : ''}`}>
      <td className="font-medium text-gray-900">
        {line.receipt_number}
        {line.voided && <span className="badge badge-danger ml-1.5">Voided</span>}
        {line.recorded_offline && (
          <span
            className="badge badge-neutral ml-1.5"
            title="Rung up while the pharmacy was offline and synced afterwards."
          >
            Offline
          </span>
        )}
      </td>
      <td className="whitespace-nowrap text-gray-600">
        {format(new Date(line.sold_at), 'dd MMM yyyy HH:mm')}
      </td>
      <td className="font-mono text-xs text-gray-600">{line.batch_number || '—'}</td>
      <td className="text-gray-600">
        {who}
        {line.contact && (
          <span className="block font-mono text-xs text-gray-400">{line.contact.phone}</span>
        )}
        {!line.contact && !line.voided && (
          <span className="block text-xs text-yellow-700">No number on file</span>
        )}
      </td>
      <td className="text-right tabular-nums text-gray-600">
        {line.quantity}
        {line.sell_unit ? <span className="text-xs text-gray-400"> {line.sell_unit}</span> : null}
      </td>
      <td>
        <span className={`badge ${provenance.className}`} title={provenance.meaning}>
          {provenance.label}
        </span>
      </td>
    </tr>
  );
}

/**
 * What the page says when the database cannot answer.
 *
 * Names the migration rather than reporting a bare failure, and says what still
 * works afterwards: sales made before the ledger existed are matched on the lot
 * number recorded on the receipt, so the history is not untraceable — it is
 * matched rather than proven.
 */
function NotInstalled() {
  return (
    <div className="card border-yellow-200 p-5">
      <div className="flex items-start gap-3">
        <ShieldAlert className="mt-0.5 h-5 w-5 flex-shrink-0 text-yellow-600" />
        <div>
          <h2 className="text-base font-semibold text-gray-900">
            Batch tracking is not installed on this database
          </h2>
          <p className="mt-1 text-sm text-gray-600">
            Without it there is no record of which lot a sale drew from, so there is nothing to
            trace. Run <code className="font-mono text-xs">{BATCH_MIGRATION}</code> in the Supabase
            SQL editor.
          </p>
          <p className="mt-2 text-sm text-gray-600">
            Afterwards, sales are traced exactly through the batch ledger, and sales made before it
            are matched on the lot number recorded on the receipt — leads to check rather than
            confirmed exposure, and the page says which is which on every line.
          </p>
        </div>
      </div>
    </div>
  );
}
