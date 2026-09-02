'use client';

import { format } from 'date-fns';
import { AlertTriangle, Printer } from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import {
  amount,
  money,
  PAYMENT_METHOD_LABEL,
  VAT_TREATMENT_LABEL,
  type PaymentStatus,
  type Sale,
} from '@/lib/pos-types';

const PAYMENT_STATUS_LABEL: Record<PaymentStatus, string> = {
  completed: 'Paid',
  authorised: 'Authorised',
  pending: 'Awaiting approval',
  failed: 'Failed',
  refunded: 'Refunded',
};

const PAYMENT_STATUS_BADGE: Record<PaymentStatus, string> = {
  completed: 'badge-success',
  authorised: 'badge-success',
  pending: 'badge-warning',
  failed: 'badge-danger',
  refunded: 'badge-neutral',
};

interface ReceiptModalProps {
  sale: Sale | null;
  open: boolean;
  onClose: () => void;
  pharmacyName?: string | null;
  pharmacyPhone?: string | null;
  /** Extra controls (void, add payment) rendered under the receipt. */
  actions?: React.ReactNode;
}

function when(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : format(date, 'dd MMM yyyy HH:mm');
}

/**
 * The till receipt.
 *
 * Renders exactly what the server stored on the sale row, including the tax
 * split recorded at the moment of sale. Nothing is recalculated here: if the
 * rates change next year an old receipt must still show what was actually
 * charged, which is why `tax_rates` is snapshotted per sale.
 *
 * The `.receipt-sheet` class drives the print stylesheet, so the Print button
 * produces an 80mm slip rather than a screenshot of the whole app.
 */
export function ReceiptModal({
  sale,
  open,
  onClose,
  pharmacyName,
  pharmacyPhone,
  actions,
}: ReceiptModalProps) {
  if (!sale) return null;

  const totalTax = amount(sale.vat_amount) + amount(sale.nhil_amount) + amount(sale.getfund_amount);
  const balance = amount(sale.total_amount) - amount(sale.amount_paid);
  const pendingPayments = sale.payments.filter((payment) => payment.status === 'pending');
  const inclusive = sale.pricing_mode !== 'exclusive';

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Receipt ${sale.receipt_number}`}
      description={when(sale.created_at)}
      size="md"
      footer={
        <div className="flex w-full flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-gray-500">
            {sale.status === 'voided' ? 'Voided — stock returned to shelf' : `${sale.items.length} line item(s)`}
          </span>
          <div className="flex items-center gap-2">
            {actions}
            <button type="button" className="btn-secondary btn-sm" onClick={() => window.print()}>
              <Printer className="h-4 w-4" />
              Print
            </button>
            <button type="button" className="btn-primary btn-sm" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      }
    >
      {/* Not part of the slip: an unresolved MoMo prompt the cashier must act on. */}
      {pendingPayments.length > 0 && sale.status !== 'voided' && (
        <div className="no-print mb-4 flex items-start gap-2 rounded-lg border border-yellow-200 bg-yellow-50 p-3 text-sm text-yellow-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <div>
            <p className="font-medium">
              {money(balance)} still owed — a mobile money prompt was sent but not yet approved.
            </p>
            <p className="mt-0.5 text-xs">
              Ask the customer to approve it on their handset, then use &ldquo;Check payment&rdquo; on the
              sales list. Money is only counted once Paystack confirms it.
            </p>
          </div>
        </div>
      )}

      {sale.status === 'voided' && (
        <div className="no-print mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900">
          <p className="font-medium">This sale was voided.</p>
          <p className="mt-0.5 text-xs">Reason: {sale.void_reason || 'not recorded'} · {when(sale.voided_at)}</p>
        </div>
      )}

      <div className="receipt-sheet mx-auto max-w-[76mm] text-[13px] text-gray-900">
        <div className="border-b border-dashed border-gray-300 pb-2 text-center">
          <p className="text-sm font-bold uppercase tracking-wide">{pharmacyName || 'Community Pharmacy'}</p>
          {pharmacyPhone && <p className="text-xs text-gray-600">Tel: {pharmacyPhone}</p>}
          <p className="mt-1 text-xs text-gray-600">
            {sale.receipt_number} · {when(sale.created_at)}
          </p>
          <p className="text-xs text-gray-600">Served by {sale.served_by_name || '—'}</p>
        </div>

        {(sale.patient_name || sale.customer_name) && (
          <div className="border-b border-dashed border-gray-300 py-2 text-xs">
            <p>
              <span className="text-gray-500">Customer:</span>{' '}
              {sale.patient_name || sale.customer_name || 'Walk-in'}
            </p>
            {sale.patient_nhis_number && (
              <p>
                <span className="text-gray-500">NHIS:</span> {sale.patient_nhis_number}
              </p>
            )}
            {sale.customer_phone || sale.patient_phone ? (
              <p>
                <span className="text-gray-500">Phone:</span> {sale.customer_phone || sale.patient_phone}
              </p>
            ) : null}
          </div>
        )}

        <table className="w-full border-collapse py-2 text-xs">
          <thead>
            <tr className="border-b border-dashed border-gray-300 text-left text-gray-500">
              <th className="py-1 font-medium">Item</th>
              <th className="py-1 text-right font-medium">Qty</th>
              <th className="py-1 text-right font-medium">Price</th>
              <th className="py-1 text-right font-medium">Total</th>
            </tr>
          </thead>
          <tbody>
            {sale.items.map((item) => (
              <tr key={item.id} className="border-b border-dotted border-gray-200 align-top">
                <td className="py-1.5 pr-1">
                  <span className="block font-medium">{item.product_name}</span>
                  {item.batch_number && (
                    <span className="block text-[10px] text-gray-500">Batch {item.batch_number}</span>
                  )}
                  {!inclusive && item.vat_treatment !== 'exempt' && (
                    <span className="block text-[10px] text-gray-500">
                      {VAT_TREATMENT_LABEL[item.vat_treatment]}
                    </span>
                  )}
                </td>
                <td className="py-1.5 text-right tabular-nums">
                  {item.quantity}
                  <span className="block text-[10px] text-gray-500">{item.sell_unit}</span>
                </td>
                <td className="py-1.5 text-right tabular-nums">{amount(item.unit_price).toFixed(2)}</td>
                <td className="py-1.5 text-right font-medium tabular-nums">
                  {amount(item.line_total).toFixed(2)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="space-y-0.5 border-t border-dashed border-gray-300 pt-2 text-xs">
          <Row label="Subtotal" value={amount(sale.subtotal).toFixed(2)} />
          {amount(sale.discount_amount) > 0 && (
            <Row label={`Discount${sale.discount_reason ? ` (${sale.discount_reason})` : ''}`} value={`-${amount(sale.discount_amount).toFixed(2)}`} />
          )}

          {inclusive ? (
            <>
              <Row label="Total" value={amount(sale.total_amount).toFixed(2)} strong />
              {/* Tax-inclusive pricing: the levies are inside the price shown, so
                  they are declared for the customer's information, not added. */}
              <div className="mt-1 border-t border-dotted border-gray-200 pt-1 text-[10px] text-gray-500">
                <p className="font-medium uppercase tracking-wide">Tax included in the above</p>
                <Row label="Taxable base" value={amount(sale.taxable_base).toFixed(2)} muted />
                <Row label="VAT" value={amount(sale.vat_amount).toFixed(2)} muted />
                <Row label="NHIL (2.5%)" value={amount(sale.nhil_amount).toFixed(2)} muted />
                <Row label="GETFund (2.5%)" value={amount(sale.getfund_amount).toFixed(2)} muted />
                <Row label="Total tax" value={totalTax.toFixed(2)} muted />
                {amount(sale.exempt_amount) > 0 && (
                  <Row label="Exempt value" value={amount(sale.exempt_amount).toFixed(2)} muted />
                )}
              </div>
            </>
          ) : (
            <>
              <Row label="Taxable base" value={amount(sale.taxable_base).toFixed(2)} />
              <Row label="VAT" value={amount(sale.vat_amount).toFixed(2)} />
              <Row label="NHIL (2.5%)" value={amount(sale.nhil_amount).toFixed(2)} />
              <Row label="GETFund (2.5%)" value={amount(sale.getfund_amount).toFixed(2)} />
              <Row label="Total" value={amount(sale.total_amount).toFixed(2)} strong />
            </>
          )}
        </div>

        <div className="space-y-0.5 border-t border-dashed border-gray-300 pt-2 text-xs">
          {sale.payments.map((payment) => (
            <div key={payment.id} className="flex items-baseline justify-between gap-2">
              <span className="text-gray-600">
                {PAYMENT_METHOD_LABEL[payment.method] || payment.method}
                {payment.momo_number ? ` · ${payment.momo_number}` : ''}
                {payment.status !== 'completed'
                  ? ` (${PAYMENT_STATUS_LABEL[payment.status]})`
                  : ''}
              </span>
              <span className="tabular-nums">{amount(payment.amount).toFixed(2)}</span>
            </div>
          ))}
          {sale.payments.length === 0 && <p className="text-gray-500">No payment recorded</p>}
          <Row label="Amount paid" value={amount(sale.amount_paid).toFixed(2)} strong />
          {amount(sale.change_due) > 0 && (
            <Row label="Change" value={amount(sale.change_due).toFixed(2)} strong />
          )}
          {balance > 0.009 && sale.status === 'pending' && (
            <Row label="Balance owed" value={balance.toFixed(2)} strong />
          )}
        </div>

        <div className="border-t border-dashed border-gray-300 pt-2 text-center text-[10px] text-gray-500">
          <p>Thank you — get well soon.</p>
          {sale.note && <p className="mt-1 italic">{sale.note}</p>}
        </div>
      </div>

      {/* On screen only: the payment ledger with its live status badges. */}
      <div className="no-print mt-4">
        <p className="label mb-1">Payments</p>
        <div className="space-y-1.5">
          {sale.payments.map((payment) => (
            <div
              key={payment.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-gray-100 bg-gray-50 px-3 py-2 text-sm"
            >
              <div className="min-w-0">
                <p className="font-medium text-gray-900">
                  {PAYMENT_METHOD_LABEL[payment.method] || payment.method} · {money(payment.amount)}
                </p>
                <p className="truncate text-xs text-gray-500">
                  {payment.reference || 'No reference'}
                  {payment.gateway ? ` · ${payment.gateway}` : ' · recorded manually'}
                </p>
              </div>
              <span className={`badge ${PAYMENT_STATUS_BADGE[payment.status]}`}>
                {PAYMENT_STATUS_LABEL[payment.status]}
              </span>
            </div>
          ))}
          {sale.payments.length === 0 && (
            <p className="text-sm text-gray-500">No payments recorded against this sale.</p>
          )}
        </div>
      </div>
    </Modal>
  );
}

function Row({
  label,
  value,
  strong,
  muted,
}: {
  label: string;
  value: string;
  strong?: boolean;
  muted?: boolean;
}) {
  return (
    <div
      className={`flex items-baseline justify-between gap-3 ${
        muted ? 'text-gray-500' : strong ? 'font-semibold text-gray-900' : 'text-gray-700'
      }`}
    >
      <span>{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}
