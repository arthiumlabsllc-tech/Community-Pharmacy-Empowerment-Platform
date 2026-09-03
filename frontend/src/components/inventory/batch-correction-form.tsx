'use client';

import { useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { AlertTriangle, ArrowLeft, ClipboardCheck, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { newId } from '@/lib/offline/queue';
import { formatDateUtc } from '@/lib/dates';
import {
  ADJUST_MODES,
  NOTE_PROMPT,
  WRITE_OFF_REASONS,
  buildAdjustPayload,
  buildWriteOffPayload,
  parseWholeUnits,
  previewAdjust,
  previewWriteOff,
  type AdjustMode,
  type BatchRow,
  type WriteOffReason,
} from '@/lib/batches';

/**
 * The two ways stock leaves the shelf without being sold.
 *
 * One component because they share the part that matters — a mandatory note, a
 * quantity, and a preview of the shelf afterwards — and because a pharmacist
 * who starts a stock-take correction and discovers the stock has *gone* should
 * be able to switch to a write-off without losing what they typed.
 *
 * The panel remounts this per visit and keys it by kind, batch and prefill, so
 * there is no reset effect and `initialQuantity` cannot go stale.
 */
export type CorrectionKind = 'adjust' | 'write-off';

interface BatchCorrectionFormProps {
  kind: CorrectionKind;
  batch: BatchRow;
  productName: string;
  /**
   * Starts the quantity box filled in.
   *
   * Set when the pharmacist arrives here from a refusal — a correction that
   * would have taken the lot below zero, or an expired lot the till will not
   * sell. The number they already typed becomes the write-off, so switching
   * does not cost them the figure they worked out.
   */
  initialQuantity?: string;
  onCancel: () => void;
  /** Called with the server's own sentence, which the panel shows and reloads. */
  onCorrected: (message: string) => void;
  /** Offered when a correction turns out to be stock that has gone. */
  onSwitchToWriteOff?: (quantity: string) => void;
}

export function BatchCorrectionForm({
  kind,
  batch,
  productName,
  initialQuantity = '',
  onCancel,
  onCorrected,
  onSwitchToWriteOff,
}: BatchCorrectionFormProps) {
  const [mode, setMode] = useState<AdjustMode>('counted');
  const [value, setValue] = useState(initialQuantity);
  const [reason, setReason] = useState<WriteOffReason>('expiry_writeoff');
  const [note, setNote] = useState('');
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // One key per mounted form, for the reason the receive form gives: a
  // correction that reaches the server and loses its response must be replayed
  // rather than applied twice.
  const [requestId] = useState(newId);

  const isWriteOff = kind === 'write-off';
  const onHand = batch.quantity;

  const preview = useMemo(
    () => (isWriteOff ? previewWriteOff(value, onHand) : previewAdjust(mode, value, onHand)),
    [isWriteOff, value, onHand, mode]
  );
  /**
   * The two fields' problems, kept apart.
   *
   * Collapsing them into one `error` string means working out afterwards which
   * field it belonged to — by testing whether the note happens to be blank, so
   * that the quantity box can be marked red. Two variables say it once and each
   * field reads its own.
   */
  const quantityProblem = preview.ok ? '' : preview.error;
  const noteProblem =
    note.trim() === ''
      ? 'Say why — this cannot be left blank'
      : note.trim().length > 500
        ? 'Note must be 500 characters or fewer'
        : '';
  const canSubmit = quantityProblem === '' && noteProblem === '';
  const showQuantityProblem = touched && quantityProblem !== '';
  const showNoteProblem = touched && noteProblem !== '';

  /**
   * Whether a below-zero correction should offer the write-off rather than just
   * refusing. Only for a change: a count cannot go negative in the first place,
   * and a write-off of nothing is refused too, so the offer would lead nowhere.
   */
  const offerWriteOff =
    !isWriteOff &&
    mode === 'change' &&
    onHand + (parseWholeUnits(value) ?? 0) < 0 &&
    onHand > 0 &&
    onSwitchToWriteOff !== undefined;

  const handleSubmit = async () => {
    setTouched(true);
    if (!canSubmit) return;

    setSubmitting(true);
    try {
      const response = isWriteOff
        ? await api.post<{ success: boolean; message?: string }>(
            `/inventory/batches/${batch.id}/write-off`,
            buildWriteOffPayload(reason, value.trim() === '' ? null : parseWholeUnits(value), note),
            { clientRequestId: requestId }
          )
        : await api.post<{ success: boolean; message?: string }>(
            `/inventory/batches/${batch.id}/adjust`,
            buildAdjustPayload(mode, parseWholeUnits(value)!, note),
            { clientRequestId: requestId }
          );

      toast.success(response.message || (isWriteOff ? 'Write-off recorded' : 'Batch corrected'));
      onCorrected(response.message || '');
    } catch (err: any) {
      // The server's wording, which names the lot and the figures. A 409 here
      // usually means another till moved the stock while this form was open.
      toast.error(err?.message || (isWriteOff ? 'Failed to record the write-off' : 'Failed to correct the batch'));
    } finally {
      setSubmitting(false);
    }
  };

  const after = preview.ok ? preview.value.after : null;

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
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-gray-900">{productName}</p>
            <p className="mt-0.5 text-xs text-gray-500">
              Lot <span className="font-mono">{batch.batch_number}</span>
              {batch.expiry_date ? ` · expires ${formatDateUtc(batch.expiry_date)}` : ''}
            </p>
          </div>
          <div className="flex-shrink-0 text-right">
            <p className="text-xs text-gray-500">On hand</p>
            <p className="text-lg font-semibold text-gray-900">{onHand}</p>
          </div>
        </div>
      </div>

      {isWriteOff ? (
        <>
          <div>
            <span className="label">Why is this stock leaving?</span>
            <div className="mt-1 grid gap-2 sm:grid-cols-3">
              {WRITE_OFF_REASONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setReason(option.value)}
                  aria-pressed={reason === option.value}
                  className={`rounded-xl border p-3 text-left transition-colors ${
                    reason === option.value
                      ? 'border-primary-500 bg-primary-50'
                      : 'border-gray-200 hover:border-gray-300'
                  }`}
                >
                  <span className="block text-sm font-medium text-gray-900">{option.label}</span>
                  <span className="mt-0.5 block text-xs leading-snug text-gray-500">{option.hint}</span>
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="label" htmlFor="writeoff-quantity">Units to write off</label>
            <input
              id="writeoff-quantity"
              type="number"
              min="1"
              max={Math.max(onHand, 0)}
              step="1"
              inputMode="numeric"
              className={`input ${showQuantityProblem ? 'input-error' : ''}`}
              placeholder={`Blank for the whole lot (${onHand})`}
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
            <p className="text-xs text-gray-400 mt-1">
              Damage is usually a carton, so say how many. Expiry and recall are usually the lot.
            </p>
          </div>
        </>
      ) : (
        <>
          <div>
            <span className="label">How are you correcting it?</span>
            <div className="mt-1 flex gap-1 rounded-xl bg-gray-100 p-1">
              {ADJUST_MODES.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => { setMode(option.value); setValue(''); }}
                  className={`flex-1 rounded-lg px-3 py-2 text-sm font-medium transition-all ${
                    mode === option.value
                      ? 'bg-white text-primary-700 shadow'
                      : 'text-gray-600 hover:text-gray-800'
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-xs text-gray-500">
              {ADJUST_MODES.find((option) => option.value === mode)?.hint}
            </p>
          </div>

          <div>
            <label className="label" htmlFor="adjust-value">
              {mode === 'counted' ? 'Units counted' : 'Difference in units'}
            </label>
            <input
              id="adjust-value"
              type="number"
              step="1"
              min={mode === 'counted' ? 0 : undefined}
              inputMode="numeric"
              className={`input ${showQuantityProblem ? 'input-error' : ''}`}
              placeholder={mode === 'counted' ? `On the books: ${onHand}` : 'e.g. -8'}
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          </div>
        </>
      )}

      <div>
        <label className="label" htmlFor="correction-note">Why *</label>
        <textarea
          id="correction-note"
          rows={3}
          className={`input ${showNoteProblem ? 'input-error' : ''}`}
          placeholder={
            isWriteOff
              ? 'e.g. Found expired during the Monday shelf check; 60 strips destroyed per FDA guidance'
              : 'e.g. Annual stock-take, shelf B counted twice on the last run'
          }
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        {showNoteProblem && <p className="text-xs text-red-600 mt-1">{noteProblem}</p>}
        <p className="text-xs text-gray-400 mt-1">{NOTE_PROMPT}</p>
      </div>

      {/* ---- The consequence, stated before the button ---- */}
      {preview.ok && after !== null && (
        <div className="flex items-start gap-2 rounded-xl border border-gray-200 p-3">
          {isWriteOff ? (
            <Trash2 className="mt-0.5 h-4 w-4 flex-shrink-0 text-red-500" />
          ) : (
            <ClipboardCheck className="mt-0.5 h-4 w-4 flex-shrink-0 text-primary-600" />
          )}
          <p className="text-sm text-gray-700">
            Lot <span className="font-mono">{batch.batch_number}</span> goes from{' '}
            <strong>{onHand}</strong> to <strong>{after}</strong>
            {preview.ok && 'change' in preview.value && preview.value.change !== 0 && (
              <> ({preview.value.change > 0 ? '+' : ''}{preview.value.change})</>
            )}
            {after === 0 && <> — the lot closes, and it stays on the ledger and in any recall.</>}
          </p>
        </div>
      )}

      {showQuantityProblem && (
        <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-2.5">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-red-600" />
          <div className="flex-1">
            <p className="text-xs leading-relaxed text-red-900">{quantityProblem}</p>
            {offerWriteOff && (
              <button
                type="button"
                className="btn-secondary btn-sm mt-2"
                onClick={() => onSwitchToWriteOff!(String(onHand))}
              >
                <Trash2 className="h-4 w-4" />
                Write off all {onHand} instead
              </button>
            )}
          </div>
        </div>
      )}

      {/* An expired lot is the case the till itself sends here, so say so rather
          than leaving the pharmacist to work out which button they wanted. */}
      {!isWriteOff && batch.status === 'expired' && (
        <p className="text-xs text-gray-500">
          This lot is past its date and the till will refuse to sell it. A correction changes the
          count; it does not take the stock off the shelf. Switch to a write-off to record it gone.
          {onSwitchToWriteOff && (
            <button
              type="button"
              className="ml-1 text-primary-600 underline"
              onClick={() => onSwitchToWriteOff(String(onHand))}
            >
              Write it off
            </button>
          )}
        </p>
      )}

      <div className="flex items-center justify-end gap-3 border-t border-gray-100 pt-4">
        <button className="btn-secondary btn-sm" onClick={onCancel} disabled={submitting}>
          Cancel
        </button>
        <button
          className={`btn-sm ${isWriteOff ? 'btn-danger' : 'btn-primary'}`}
          onClick={handleSubmit}
          disabled={submitting || (touched && !canSubmit)}
        >
          {submitting && <div className="spinner" />}
          {isWriteOff ? 'Record write-off' : 'Correct batch'}
        </button>
      </div>
    </div>
  );
}
