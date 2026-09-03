'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Boxes,
  ClipboardCheck,
  Info,
  PackagePlus,
  ShieldAlert,
  Trash2,
} from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { api } from '@/lib/api';
import { formatDateUtc } from '@/lib/dates';
import {
  BATCH_MIGRATION,
  BATCH_STATUS,
  isBatchTrackingMissing,
  type BatchPanel,
  type BatchRow,
  type BatchTotals,
} from '@/lib/batches';
import { ReceiveStockForm } from './receive-stock-form';
import { BatchCorrectionForm, type CorrectionKind } from './batch-correction-form';

/**
 * Where the panel is. One modal with four views rather than four dialogs:
 * stacked dialogs both own the Escape key and the body scroll lock, so closing
 * the inner one takes the outer with it and the pharmacist loses the shelf they
 * were looking at.
 */
type PanelView =
  | { name: 'list' }
  | { name: 'receive' }
  | {
      name: 'correct';
      kind: CorrectionKind;
      batch: BatchRow;
      /** Typed into the quantity box, when the pharmacist arrived from a refusal. */
      prefill?: string;
    };

interface BatchPanelModalProps {
  open: boolean;
  productId: string | null;
  /** Owner or pharmacist. Without it the panel is read-only. */
  canEdit: boolean;
  /**
   * Owner or pharmacist, mirroring the guard on `GET /inventory/recall`.
   *
   * Separate from `canEdit` and not defaulted, because the two are different
   * questions and every caller has to answer both: reading a product's lots is
   * allowed for any signed-in user, while a recall trace is a list of named
   * patients with their telephone numbers.
   */
  canTrace: boolean;
  onClose: () => void;
  /** A lot moved, so the table and the summary behind the panel are stale. */
  onChanged: () => void;
}

interface Envelope {
  success: boolean;
  message?: string;
  data?: BatchPanel;
}

/**
 * Every lot of one product, in the order the till will take them.
 *
 * The ordering comes from the server, which sorts with the same FEFO allocator
 * a sale runs, rather than from a database `ORDER BY`. Two views of the same
 * stock that disagree about which lot goes next is how a pharmacist ends up
 * quarantining the wrong box, so the panel deliberately cannot reorder it.
 *
 * There is no way to open this straight into the delivery form. Seeing the lots
 * already on file is the step that stops a second `ABC123` being created because
 * nobody knew the first one was there, so the list comes first every time and
 * receiving is one tap further in.
 */
export function BatchPanelModal({
  open,
  productId,
  canEdit,
  canTrace,
  onClose,
  onChanged,
}: BatchPanelModalProps) {
  const [panel, setPanel] = useState<BatchPanel | null>(null);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [notInstalled, setNotInstalled] = useState(false);
  const [view, setView] = useState<PanelView>({ name: 'list' });

  const load = useCallback(async () => {
    if (!productId) return;
    setLoading(true);
    setFailure(null);
    try {
      const response = await api.get<Envelope>(`/inventory/${productId}/batches`);
      setPanel(response.data ?? null);
      // The endpoint answers 200 with batch_tracking: false when migration 003
      // is missing, and 501 when a mutation was attempted. Both are the same
      // state to the pharmacist and get the same screen.
      setNotInstalled(response.data?.batch_tracking === false);
    } catch (error: any) {
      if (isBatchTrackingMissing(error)) {
        setNotInstalled(true);
        setPanel(null);
      } else {
        setFailure(error?.message || 'Failed to load the batches for this product');
      }
    } finally {
      setLoading(false);
    }
  }, [productId]);

  useEffect(() => {
    if (!open || !productId) return;
    setView({ name: 'list' });
    setPanel(null);
    setNotInstalled(false);
    void load();
  }, [open, productId, load]);

  const afterChange = useCallback(async () => {
    await load();
    onChanged();
  }, [load, onChanged]);

  const product = panel?.product ?? null;
  const batches = panel?.batches ?? [];
  const totals = panel?.totals ?? null;

  return (
    <Modal
      open={open}
      onClose={() => { if (view.name === 'list') onClose(); else setView({ name: 'list' }); }}
      title={view.name === 'list' ? 'Batches and lots' : titleFor(view)}
      description={
        product
          ? `${product.product_name}${product.product_code ? ` · ${product.product_code}` : ''}`
          : undefined
      }
      size="lg"
      footer={
        view.name === 'list' && canEdit && !notInstalled && !loading && product ? (
          <button className="btn-primary btn-sm" onClick={() => setView({ name: 'receive' })}>
            <PackagePlus className="h-4 w-4" />
            Receive stock
          </button>
        ) : undefined
      }
    >
      {loading && !panel ? (
        <div className="py-10 text-center">
          <div className="spinner mx-auto" />
          <p className="mt-2 text-sm text-gray-500">Loading batches...</p>
        </div>
      ) : failure ? (
        <div className="py-10 text-center">
          <AlertTriangle className="mx-auto h-10 w-10 text-red-300" />
          <p className="mt-2 text-sm text-gray-700">{failure}</p>
          <button className="btn-secondary btn-sm mt-4" onClick={() => void load()}>
            Try again
          </button>
        </div>
      ) : notInstalled ? (
        <NotInstalled canEdit={canEdit} />
      ) : view.name === 'receive' && product ? (
        <ReceiveStockForm
          key={product.id}
          productId={product.id}
          productName={product.product_name}
          batches={batches}
          onCancel={() => setView({ name: 'list' })}
          onReceived={() => { setView({ name: 'list' }); void afterChange(); }}
        />
      ) : view.name === 'correct' && product ? (
        <BatchCorrectionForm
          key={`${view.kind}-${view.batch.id}-${view.prefill ?? ''}`}
          kind={view.kind}
          batch={view.batch}
          productName={product.product_name}
          initialQuantity={view.prefill}
          onCancel={() => setView({ name: 'list' })}
          onCorrected={() => { setView({ name: 'list' }); void afterChange(); }}
          onSwitchToWriteOff={(quantity) =>
            // The batch is carried across unchanged: what switches is the form
            // and the number already typed into it, not what is on the shelf.
            setView({ name: 'correct', kind: 'write-off', batch: view.batch, prefill: quantity })
          }
        />
      ) : (
        <div className="space-y-4">
          {totals && !totals.derived_stock_matches && product && (
            <DriftWarning onHand={product.quantity} batches={batches} totals={totals} />
          )}

          <NextOut panel={panel} />

          {totals && <Totals totals={totals} />}

          {batches.length === 0 ? (
            <div className="empty-state py-8">
              <Boxes className="mx-auto h-9 w-9 text-gray-300" />
              <p className="mt-2 text-sm text-gray-500">
                No lots recorded for this product yet — it was added with no stock on hand.
              </p>
              {canEdit && (
                <button
                  className="btn-primary btn-sm mt-4"
                  onClick={() => setView({ name: 'receive' })}
                >
                  <PackagePlus className="h-4 w-4" />
                  Receive the first delivery
                </button>
              )}
            </div>
          ) : (
            <ul className="space-y-2">
              {batches.map((batch, index) => (
                <BatchCard
                  key={batch.id}
                  batch={batch}
                  canEdit={canEdit}
                  canTrace={canTrace}
                  // The list arrives in FEFO order, so position zero is the lot
                  // the till will take from next. Saying it on the card is what
                  // makes the order legible rather than arbitrary.
                  isNext={index === 0 && batch.sellable}
                  onCorrect={() => setView({ name: 'correct', kind: 'adjust', batch })}
                  onWriteOff={() => setView({ name: 'correct', kind: 'write-off', batch })}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </Modal>
  );
}

/**
 * The heading, from the whole view rather than its name.
 *
 * A write-off is not a correction and must not be titled as one: it takes stock
 * off the shelf permanently and the button underneath is red, so the heading
 * saying "Correct a batch" would be the one reassuring thing on the screen and
 * it would be wrong.
 *
 * Typed to exclude the list arm because the caller has already handled it, and
 * a signature that accepts it would have to invent a heading for a view that
 * never asks for one.
 */
function titleFor(view: Exclude<PanelView, { name: 'list' }>): string {
  if (view.name === 'receive') return 'Receive stock';
  return view.kind === 'write-off' ? 'Write off a batch' : 'Correct a batch';
}

/**
 * Migration 003 has not been applied.
 *
 * A state to explain rather than an error to apologise for: the request was
 * well formed and the database is healthy, the pharmacy simply has not
 * installed lot tracking yet. Everything else about inventory still works.
 */
function NotInstalled({ canEdit }: { canEdit: boolean }) {
  return (
    <div className="space-y-3 py-2">
      <div className="flex items-start gap-3 rounded-xl border border-blue-200 bg-blue-50 p-4">
        <Info className="mt-0.5 h-5 w-5 flex-shrink-0 text-blue-600" />
        <div className="text-sm leading-relaxed text-blue-900">
          <p className="font-medium">Batch and lot tracking is not installed on this database yet.</p>
          <p className="mt-1">
            Stock counts, prices, reorder alerts and selling all work as they did. What is missing
            is the record of <em>which lot</em> a unit came from — so a recall cannot be traced to
            the patients who bought it, and the till cannot take the shortest-dated box first.
          </p>
        </div>
      </div>

      <div className="rounded-xl border border-gray-200 p-4 text-sm">
        <p className="font-medium text-gray-900">To turn it on</p>
        <p className="mt-1 text-gray-600">
          Run <code className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-xs">{BATCH_MIGRATION}</code>{' '}
          against the pharmacy database — paste it into the Supabase SQL editor, the same way the
          earlier migrations were applied.
        </p>
        <p className="mt-2 text-xs leading-relaxed text-gray-500">
          It adds one opening batch per existing product, carrying the quantity, lot number and
          expiry date already on the row. Those are marked as migrated balances rather than traced
          deliveries, because nobody received them against an invoice and saying otherwise would be
          a traceability the pharmacy does not have. Nothing is deleted and running it twice does
          not duplicate stock.
        </p>
        {!canEdit && (
          <p className="mt-2 text-xs text-gray-500">
            This needs whoever manages the pharmacy&rsquo;s database.
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * The product row is supposed to be a summary of its batches.
 *
 * When it is not, something wrote to it directly and no batch has moved since.
 * Said here rather than left for a stock-take to discover, because the two
 * numbers are both on screen and a pharmacist who notices the disagreement
 * without an explanation will assume the system is broken.
 *
 * The batch figure is summed from the batches rather than rebuilt from the
 * totals, because that is what the server compares against and the totals do not
 * add up to it: a lot driven negative by a sale recorded during an outage is in
 * neither the sellable nor the expired nor the quarantined count, and dropping
 * it here would report a disagreement that is not the one the server found.
 */
function DriftWarning({
  onHand,
  batches,
  totals,
}: {
  onHand: number;
  batches: BatchRow[];
  totals: BatchTotals;
}) {
  const fromBatches = batches.reduce((total, batch) => total + batch.quantity, 0);
  return (
    <div className="flex items-start gap-2 rounded-xl border border-yellow-300 bg-yellow-50 p-3">
      <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-yellow-600" />
      <p className="text-xs leading-relaxed text-yellow-900">
        This product says <strong>{onHand}</strong> units but its {totals.batch_count} lot
        {totals.batch_count === 1 ? '' : 's'} add up to <strong>{fromBatches}</strong>. The count on
        the product is meant to be a summary of the lots, so something edited it directly — a
        correction made before lot tracking, or an import. Recording a delivery or a correction
        against a lot recomputes it. Until then, trust the lots below and not the figure in the
        table behind this window.
      </p>
    </div>
  );
}

/**
 * What the till will hand over next.
 *
 * The figure that makes the panel worth opening: a pharmacist can see which box
 * to reach for without running a sale to find out, and can check it is the one
 * physically at the front of the shelf.
 */
function NextOut({ panel }: { panel: BatchPanel | null }) {
  const next = panel?.next_batch ?? null;

  if (!next) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 p-3">
        <p className="text-sm font-medium text-red-900">Nothing here can be sold.</p>
        <p className="mt-0.5 text-xs leading-relaxed text-red-800">
          Every lot is empty, expired or quarantined. The till will refuse this product and say why.
          Receive a delivery, or write off what has gone so the count stops claiming stock that is
          not sellable.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-primary-200 bg-primary-50 p-3">
      <p className="text-xs uppercase tracking-wide text-primary-700">Next out at the till</p>
      <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-mono text-base font-semibold text-primary-900">
          {next.batch_number}
        </span>
        <span className="text-sm text-primary-800">
          {next.quantity} unit{next.quantity === 1 ? '' : 's'}
          {next.expiry_date ? ` · expires ${formatDateUtc(next.expiry_date)}` : ''}
        </span>
      </div>
      <p className="mt-1 text-xs text-primary-700">
        First-expiry-first-out: the shortest-dated lot with stock on it goes first. This box should
        be at the front of the shelf.
      </p>
    </div>
  );
}

function Totals({ totals }: { totals: BatchTotals }) {
  const cells: Array<{ label: string; value: string; emphasis?: boolean }> = [
    { label: 'Lots', value: String(totals.batch_count) },
    { label: 'Sellable', value: String(totals.sellable_units), emphasis: true },
    { label: 'Expired', value: String(totals.expired_units) },
    { label: 'Quarantined', value: String(totals.quarantined_units) },
    {
      label: 'Stock value',
      value: `GHS ${Number(totals.stock_value).toFixed(2)}`,
    },
    {
      label: 'Earliest expiry',
      value: totals.earliest_expiry ? formatDateUtc(totals.earliest_expiry) : '—',
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {cells.map((cell) => (
        <div key={cell.label} className="rounded-lg border border-gray-200 px-3 py-2">
          <p className="text-xs text-gray-500">{cell.label}</p>
          <p
            className={`mt-0.5 text-sm font-semibold ${
              cell.emphasis ? 'text-primary-700' : 'text-gray-900'
            }`}
          >
            {cell.value}
          </p>
        </div>
      ))}
    </div>
  );
}

interface BatchCardProps {
  batch: BatchRow;
  canEdit: boolean;
  canTrace: boolean;
  isNext: boolean;
  onCorrect: () => void;
  onWriteOff: () => void;
}

function BatchCard({ batch, canEdit, canTrace, isNext, onCorrect, onWriteOff }: BatchCardProps) {
  const status = BATCH_STATUS[batch.status] ?? BATCH_STATUS.empty;
  const cost = Number(batch.cost_price) || 0;

  return (
    <li className={`rounded-xl border p-3 ${isNext ? 'border-primary-300 bg-primary-50/40' : 'border-gray-200'}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-sm font-semibold text-gray-900">
              {batch.batch_number}
            </span>
            <span className={status.className} title={status.action}>{status.label}</span>
            {isNext && <span className="badge badge-info">Next out</span>}
            {batch.is_backfill && (
              <span
                className="badge badge-neutral"
                title="A balance carried over when lot tracking was installed. Nobody received it against an invoice, so it is not a traced delivery."
              >
                Opening balance
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-gray-500">
            {batch.expiry_date
              ? batch.days_to_expiry !== null && batch.days_to_expiry < 0
                ? `Expired ${formatDateUtc(batch.expiry_date)}`
                : `Expires ${formatDateUtc(batch.expiry_date)}${
                    batch.days_to_expiry !== null ? ` · ${batch.days_to_expiry}d` : ''
                  }`
              : 'No expiry date'}
            {batch.received_at ? ` · received ${formatDateUtc(batch.received_at)}` : ''}
          </p>
          <p className="mt-0.5 text-xs text-gray-400">
            GHS {cost.toFixed(2)}/unit · GHS {Number(batch.stock_value).toFixed(2)} on hand
            {batch.invoice_number ? ` · invoice ${batch.invoice_number}` : ''}
            {batch.supplier_name ? ` · ${batch.supplier_name}` : ''}
          </p>
        </div>

        <div className="flex-shrink-0 text-right">
          <p className="text-xl font-semibold text-gray-900">{batch.quantity}</p>
          <p className="text-xs text-gray-400">units</p>
        </div>
      </div>

      {(canTrace || (canEdit && batch.status !== 'empty')) && (
        <div className="mt-2.5 flex flex-wrap justify-end gap-2 border-t border-gray-100 pt-2.5">
          {/* Offered for an empty lot too, and especially then: nothing on the
              shelf means every unit of this lot reached a customer, so the
              trace is the whole of the answer rather than half of it. */}
          {canTrace && (
            <a href={`/recall?batch=${batch.id}`} className="btn-secondary btn-sm">
              <ShieldAlert className="h-4 w-4" />
              Trace this lot
            </a>
          )}
          {canEdit && batch.status !== 'empty' && (
            <>
              <button type="button" className="btn-secondary btn-sm" onClick={onCorrect}>
                <ClipboardCheck className="h-4 w-4" />
                Correct count
              </button>
              <button type="button" className="btn-secondary btn-sm text-red-600" onClick={onWriteOff}>
                <Trash2 className="h-4 w-4" />
                Write off
              </button>
            </>
          )}
        </div>
      )}

      {canEdit && batch.status === 'empty' && (
        <p className="mt-2 border-t border-gray-100 pt-2 text-xs text-gray-400">
          {status.action}
        </p>
      )}
    </li>
  );
}
