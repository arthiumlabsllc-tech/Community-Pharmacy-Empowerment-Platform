'use client';

import { useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { AlertTriangle, ArrowLeft, PackagePlus } from 'lucide-react';
import { api } from '@/lib/api';
import { newId } from '@/lib/offline/queue';
import { formatDateUtc, todayUtcDay } from '@/lib/dates';
import {
  EMPTY_RECEIVE_FORM,
  buildReceivePayload,
  previewReceive,
  receiveFormErrors,
  similarLots,
  type BatchRow,
  type ReceiveForm,
  type ReceiveOutcome,
} from '@/lib/batches';

interface ReceiveStockFormProps {
  productId: string;
  productName: string;
  /** What is already on the shelf, so the form can say what a lot number will do. */
  batches: BatchRow[];
  onCancel: () => void;
  onReceived: (outcome: ReceiveOutcome) => void;
}

/**
 * Records a delivery against a lot.
 *
 * Rendered inside the batch panel rather than as its own dialog: two stacked
 * modals would both own the Escape key and the body scroll lock, and closing the
 * inner one would close the outer with it. The panel switches views instead, so
 * the pharmacist never loses sight of the shelf they are adding to.
 *
 * Everything the server will tell them afterwards is shown here beforehand —
 * that a lot number already exists and will be topped up rather than
 * duplicated, and that two expiry dates disagree — because both change what the
 * pharmacist wants to type, and finding out after submitting means undoing a
 * delivery that is already on the ledger.
 *
 * There is no reset effect. The panel mounts this component only while its view
 * is `receive` and keys it by product, so every visit starts from an empty form
 * and a fresh idempotency key without anything here having to notice.
 */
export function ReceiveStockForm({
  productId,
  productName,
  batches,
  onCancel,
  onReceived,
}: ReceiveStockFormProps) {
  const [form, setForm] = useState<ReceiveForm>(EMPTY_RECEIVE_FORM);
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  /**
   * One key for the lifetime of the form, not per attempt.
   *
   * Generated on open so that a submission which reaches the server and loses
   * its response on the way back is replayed rather than recorded twice — the
   * pharmacy would otherwise be left holding stock it never bought. A genuinely
   * new delivery means closing and reopening, which mints a new key.
   */
  const [requestId] = useState(newId);

  const set = (field: keyof ReceiveForm, value: string) =>
    setForm((prev) => ({ ...prev, [field]: value }));

  const errors = useMemo(() => receiveFormErrors(form), [form]);
  const hasErrors = Object.values(errors).some(Boolean);

  const lot = form.batch_number.trim();
  const existing = batches.find((batch) => batch.batch_number === lot) ?? null;
  const preview = useMemo(
    () => previewReceive(form.batch_number, Number(form.quantity) || 0, form.expiry_date, batches),
    [form.batch_number, form.quantity, form.expiry_date, batches]
  );
  const nearMisses = useMemo(
    () => similarLots(batches, form.batch_number),
    [batches, form.batch_number]
  );
  const lotKnown = lot !== '';

  const errorFor = (field: keyof typeof errors) => (touched ? errors[field] : '');

  const handleSubmit = async () => {
    setTouched(true);
    if (hasErrors) return;

    setSubmitting(true);
    try {
      const response = await api.post<{ success: boolean; message?: string; data: ReceiveOutcome }>(
        `/inventory/${productId}/receive`,
        buildReceivePayload(form),
        { clientRequestId: requestId }
      );

      const outcome = response.data;
      // The server's own sentence, which already distinguishes a top-up from a
      // new lot and names the figures. Inventing a friendlier one here would be
      // a second implementation of the same claim.
      toast.success(response.message || `Received ${outcome.quantity_after} units`);

      if (outcome.expiry_conflict) {
        // Shown again even though the form warns beforehand, because another
        // till can receive against the same lot in between and the date that
        // governs is decided at commit time, not at typing time.
        toast(
          `Lot ${outcome.batch_number}: the date on file (${formatDateUtc(
            outcome.expiry_conflict.on_file
          )}) and the one you entered (${formatDateUtc(
            outcome.expiry_conflict.submitted
          )}) disagree. Kept the earlier, ${formatDateUtc(outcome.expiry_conflict.kept)}.`,
          { icon: '⚠️', duration: 9000 }
        );
      }

      onReceived(outcome);
    } catch (error: any) {
      toast.error(error?.message || 'Failed to receive stock');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={onCancel}
        disabled={submitting}
        className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to batches
      </button>

      <div className="rounded-xl border border-gray-200 bg-gray-50 p-3">
        <p className="text-sm font-medium text-gray-900">{productName}</p>
        <p className="mt-0.5 text-xs text-gray-500">
          Record what arrived, against the lot number printed on the pack.
        </p>
      </div>

      <div className="grid sm:grid-cols-2 gap-4">
        <div>
          <label className="label" htmlFor="receive-lot">Lot / batch number *</label>
          <input
            id="receive-lot"
            type="text"
            className={`input ${errorFor('batch_number') ? 'input-error' : ''}`}
            placeholder="e.g. ABC123"
            value={form.batch_number}
            onChange={(e) => set('batch_number', e.target.value)}
          />
          {errorFor('batch_number') && (
            <p className="text-xs text-red-600 mt-1">{errorFor('batch_number')}</p>
          )}
          {!errorFor('batch_number') && (
            <p className="text-xs text-gray-400 mt-1">
              One lot number per product. Re-entering a lot tops it up.
            </p>
          )}
        </div>
        <div>
          <label className="label" htmlFor="receive-expiry">Expiry date *</label>
          <input
            id="receive-expiry"
            type="date"
            className={`input ${errorFor('expiry_date') ? 'input-error' : ''}`}
            value={form.expiry_date}
            onChange={(e) => set('expiry_date', e.target.value)}
          />
          {errorFor('expiry_date') && (
            <p className="text-xs text-red-600 mt-1">{errorFor('expiry_date')}</p>
          )}
        </div>
      </div>

      <div className="grid sm:grid-cols-3 gap-4">
        <div>
          <label className="label" htmlFor="receive-quantity">Units received *</label>
          <input
            id="receive-quantity"
            type="number"
            min="1"
            step="1"
            inputMode="numeric"
            className={`input ${errorFor('quantity') ? 'input-error' : ''}`}
            value={form.quantity}
            onChange={(e) => set('quantity', e.target.value)}
          />
          {errorFor('quantity') && <p className="text-xs text-red-600 mt-1">{errorFor('quantity')}</p>}
        </div>
        <div>
          <label className="label" htmlFor="receive-cost">Cost per unit (GHS)</label>
          <input
            id="receive-cost"
            type="number"
            min="0"
            step="0.01"
            inputMode="decimal"
            className={`input ${errorFor('cost_price') ? 'input-error' : ''}`}
            value={form.cost_price}
            onChange={(e) => set('cost_price', e.target.value)}
          />
          {errorFor('cost_price') && (
            <p className="text-xs text-red-600 mt-1">{errorFor('cost_price')}</p>
          )}
          <p className="text-xs text-gray-400 mt-1">Left blank, the lot is costed at zero.</p>
        </div>
        <div>
          <label className="label" htmlFor="received-at">Arrived on</label>
          <input
            id="received-at"
            type="date"
            max={todayUtcDay()}
            className={`input ${errorFor('received_at') ? 'input-error' : ''}`}
            value={form.received_at}
            onChange={(e) => set('received_at', e.target.value)}
          />
          <p className="text-xs text-gray-400 mt-1">Defaults to today. Backdate a late entry.</p>
        </div>
      </div>

      <div>
        <label className="label" htmlFor="receive-invoice">Invoice number</label>
        <input
          id="receive-invoice"
          type="text"
          className={`input ${errorFor('invoice_number') ? 'input-error' : ''}`}
          placeholder="e.g. INV-4471"
          value={form.invoice_number}
          onChange={(e) => set('invoice_number', e.target.value)}
        />
        {errorFor('invoice_number') && (
          <p className="text-xs text-red-600 mt-1">{errorFor('invoice_number')}</p>
        )}
      </div>

      <div>
        <label className="label" htmlFor="receive-note">Delivery note</label>
        <textarea
          id="receive-note"
          rows={2}
          className={`input ${errorFor('note') ? 'input-error' : ''}`}
          placeholder="Who delivered it, and anything worth remembering about the consignment"
          value={form.note}
          onChange={(e) => set('note', e.target.value)}
        />
        {errorFor('note') && <p className="text-xs text-red-600 mt-1">{errorFor('note')}</p>}
        {/* Suppliers are not managed in this app yet, so there is no dropdown to
            pick one from and no supplier_id to send. Named in the note instead
            of fabricated into a column that would then look authoritative. */}
        <p className="text-xs text-gray-400 mt-1">
          Name the supplier here — supplier records are not set up in this app yet.
        </p>
      </div>

      {/* ---- What this will do, before it does it ---- */}
      {lotKnown && !errors.batch_number && (
        <div className="rounded-xl border border-gray-200 p-3 space-y-2">
          <div className="flex items-start gap-2">
            <PackagePlus className="mt-0.5 h-4 w-4 flex-shrink-0 text-gray-400" />
            <p className="text-sm text-gray-700">
              {preview.merged && existing ? (
                <>
                  Lot <strong>{lot}</strong> already holds{' '}
                  <strong>{existing.quantity}</strong> — this tops it up to{' '}
                  <strong>{preview.quantityAfter}</strong>. One lot cannot be two deliveries, so the
                  consignment keeps its own date and invoice on the ledger underneath.
                </>
              ) : (
                <>
                  This creates a new lot, <strong>{lot}</strong>, holding{' '}
                  <strong>{preview.quantityAfter}</strong> units.
                </>
              )}
            </p>
          </div>

          {preview.expiryConflict && (
            <div className="flex items-start gap-2 rounded-lg border border-yellow-200 bg-yellow-50 p-2.5">
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-yellow-600" />
              <p className="text-xs leading-relaxed text-yellow-900">
                The lot on file expires{' '}
                <strong>{formatDateUtc(preview.expiryConflict.on_file)}</strong> but this delivery
                says <strong>{formatDateUtc(preview.expiryConflict.submitted)}</strong>. One lot
                number cannot carry two dates, so one of them was keyed in wrong. The earlier one
                will be kept — it is the safe direction to be wrong in, because it takes stock off
                the shelf sooner rather than dispensing it later than the manufacturer guaranteed.
                Check the pack before you submit.
              </p>
            </div>
          )}

          {nearMisses.length > 0 && (
            <div className="flex items-start gap-2 rounded-lg border border-yellow-200 bg-yellow-50 p-2.5">
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-yellow-600" />
              <p className="text-xs leading-relaxed text-yellow-900">
                <strong>{nearMisses.map((b) => b.batch_number).join(', ')}</strong> is already on
                file and differs only in capital letters or spacing. Lot numbers are matched
                exactly, so this would create a second lot that looks like a separate delivery and
                split the reorder level across two rows. Use the existing spelling unless the pack
                really is different.
              </p>
            </div>
          )}
        </div>
      )}

      <div className="flex items-center justify-end gap-3 border-t border-gray-100 pt-4">
        <button className="btn-secondary btn-sm" onClick={onCancel} disabled={submitting}>
          Cancel
        </button>
        <button className="btn-primary btn-sm" onClick={handleSubmit} disabled={submitting}>
          {submitting && <div className="spinner" />}
          Receive stock
        </button>
      </div>
    </div>
  );
}
