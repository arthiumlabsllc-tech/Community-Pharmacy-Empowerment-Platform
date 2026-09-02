'use client';

import { format } from 'date-fns';
import Link from 'next/link';
import { AlertTriangle, ListChecks, Printer } from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { money, PAYMENT_METHOD_LABEL, type PaymentMethod } from '@/lib/pos-types';

/**
 * The slip for a sale this device recorded but has not yet sent.
 *
 * It is not `ReceiptModal` and does not pretend to be. There is no receipt
 * number, because the server assigns one when the sale is stored, and there is no
 * tax split, because this device does not compute one (see lib/offline/pricing.ts).
 * Inventing either would produce a document that looks final and is not: the
 * customer walks off with a number that does not exist yet, and the pharmacy
 * files a VAT figure the server has not confirmed.
 *
 * What it does carry is the word PROVISIONAL on the printed slip itself, not only
 * on screen. A slip that can be handed to a customer has to say what it is,
 * because the person who reads it later has no way to ask.
 */

export interface ProvisionalLine {
  productName: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
}

export interface ProvisionalPayment {
  method: PaymentMethod;
  amount: number;
  momoNumber?: string | null;
  momoNetwork?: string | null;
  reference?: string | null;
}

export interface ProvisionalSale {
  /** The queue id, which is also the sale's `client_sale_id` once it syncs. */
  clientSaleId: string;
  recordedAt: string;
  servedBy: string;
  lines: ProvisionalLine[];
  payments: ProvisionalPayment[];
  total: number;
  paid: number;
  change: number;
  customerName: string | null;
  customerPhone: string | null;
  note: string | null;
  /** The pricer's own caveats, printed next to the total. */
  warnings: string[];
}

interface OfflineReceiptModalProps {
  sale: ProvisionalSale | null;
  open: boolean;
  onClose: () => void;
  pharmacyName?: string | null;
  pharmacyPhone?: string | null;
}

function when(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : format(date, 'dd MMM yyyy HH:mm');
}

export function OfflineReceiptModal({
  sale,
  open,
  onClose,
  pharmacyName,
  pharmacyPhone,
}: OfflineReceiptModalProps) {
  if (!sale) return null;

  const units = sale.lines.reduce((total, line) => total + line.quantity, 0);
  const digitalPayments = sale.payments.filter(
    (payment) => payment.method === 'momo' || payment.method === 'card'
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Sale recorded on this device"
      description={`${when(sale.recordedAt)} · not yet sent to the server`}
      size="md"
      footer={
        <div className="flex w-full flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-gray-500">
            {sale.lines.length} line item(s) · {units} unit(s)
          </span>
          <div className="flex items-center gap-2">
            <Link href="/sync" className="btn-secondary btn-sm">
              <ListChecks className="h-4 w-4" />
              Pending sales
            </Link>
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
      {/* On screen only: what the cashier has to know before the next customer. */}
      <div className="no-print mb-4 space-y-2">
        <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <div>
            <p className="font-medium">This sale has not reached the server.</p>
            <p className="mt-0.5 text-xs">
              It is queued on this device and will be sent when a connection returns. Stock, takings
              and the VAT return do not include it until then — check the pending sales screen
              before closing the till.
            </p>
          </div>
        </div>

        {digitalPayments.length > 0 && (
          <div className="rounded-lg border border-yellow-200 bg-yellow-50 p-3 text-sm text-yellow-900">
            <p className="font-medium">
              {digitalPayments
                .map((payment) => PAYMENT_METHOD_LABEL[payment.method] || payment.method)
                .join(' and ')}{' '}
              was written down, not charged.
            </p>
            <p className="mt-0.5 text-xs">
              Nothing here could reach a payment gateway. Confirm the money moved on the
              customer&rsquo;s own phone or the network statement; the app will mark this payment
              unverified when it syncs.
            </p>
          </div>
        )}
      </div>

      <div className="receipt-sheet mx-auto max-w-[76mm] text-[13px] text-gray-900">
        <div className="border-b border-dashed border-gray-300 pb-2 text-center">
          <p className="text-sm font-bold uppercase tracking-wide">
            {pharmacyName || 'Community Pharmacy'}
          </p>
          {pharmacyPhone && <p className="text-xs text-gray-600">Tel: {pharmacyPhone}</p>}
          <p className="mt-1 text-[11px] font-bold uppercase tracking-widest text-gray-700">
            Provisional — not yet recorded
          </p>
          <p className="text-xs text-gray-600">{when(sale.recordedAt)}</p>
          <p className="text-xs text-gray-600">Served by {sale.servedBy || '—'}</p>
        </div>

        {(sale.customerName || sale.customerPhone) && (
          <div className="border-b border-dashed border-gray-300 py-2 text-xs">
            {sale.customerName && (
              <p>
                <span className="text-gray-500">Customer:</span> {sale.customerName}
              </p>
            )}
            {sale.customerPhone && (
              <p>
                <span className="text-gray-500">Phone:</span> {sale.customerPhone}
              </p>
            )}
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
            {sale.lines.map((line, index) => (
              <tr
                key={`${line.productName}-${index}`}
                className="border-b border-dotted border-gray-200 align-top"
              >
                <td className="py-1.5 pr-1 font-medium">{line.productName}</td>
                <td className="py-1.5 text-right tabular-nums">{line.quantity}</td>
                <td className="py-1.5 text-right tabular-nums">{line.unitPrice.toFixed(2)}</td>
                <td className="py-1.5 text-right font-medium tabular-nums">
                  {line.lineTotal.toFixed(2)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="space-y-0.5 border-t border-dashed border-gray-300 pt-2 text-xs">
          <Row label="Subtotal" value={sale.lines.reduce((t, l) => t + l.lineTotal, 0).toFixed(2)} />
          <Row label="Total due" value={sale.total.toFixed(2)} strong />
          <p className="pt-1 text-[10px] text-gray-500">
            Tax breakdown and receipt number are printed once this sale has been recorded at the
            server.
          </p>
        </div>

        <div className="space-y-0.5 border-t border-dashed border-gray-300 pt-2 text-xs">
          {sale.payments.map((payment, index) => (
            <div key={`${payment.method}-${index}`} className="flex items-baseline justify-between gap-2">
              <span className="text-gray-600">
                {PAYMENT_METHOD_LABEL[payment.method] || payment.method}
                {payment.momoNumber ? ` · ${payment.momoNumber}` : ''}
                {payment.method === 'momo' || payment.method === 'card' ? ' (unverified)' : ''}
              </span>
              <span className="tabular-nums">{payment.amount.toFixed(2)}</span>
            </div>
          ))}
          <Row label="Amount taken" value={sale.paid.toFixed(2)} strong />
          {sale.change > 0.009 && <Row label="Change" value={sale.change.toFixed(2)} strong />}
        </div>

        <div className="border-t border-dashed border-gray-300 pt-2 text-center text-[10px] text-gray-500">
          <p>Thank you — get well soon.</p>
          {sale.note && <p className="mt-1 italic">{sale.note}</p>}
        </div>
      </div>

      {/* On screen only: the caveats the pricer attached, and the id this sale
          can be found by on the pending sales screen and in the database. */}
      <div className="no-print mt-4 space-y-2">
        {sale.warnings.length > 0 && (
          <ul className="space-y-1 rounded-lg bg-gray-50 p-3 text-xs text-gray-700">
            {sale.warnings.map((warning) => (
              <li key={warning} className="flex items-start gap-1.5">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-amber-500" />
                <span>{warning}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-gray-500">
          Queued as <span className="font-mono">{sale.clientSaleId}</span>. This is the id the sale
          keeps when it syncs, so it can be matched to the receipt later.
        </p>
        <p className="text-xs text-gray-500">Total shown: {money(sale.total)}</p>
      </div>
    </Modal>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div
      className={`flex items-baseline justify-between gap-3 ${
        strong ? 'font-semibold text-gray-900' : 'text-gray-700'
      }`}
    >
      <span>{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}
