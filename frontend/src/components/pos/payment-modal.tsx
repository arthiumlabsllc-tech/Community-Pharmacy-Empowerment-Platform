'use client';

import { useEffect, useMemo, useState } from 'react';
import { Banknote, CreditCard, Landmark, Smartphone, Trash2, Users, Receipt } from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import {
  money,
  PAYMENT_METHOD_LABEL,
  type MomoNetwork,
  type PaymentConfig,
  type PaymentMethod,
} from '@/lib/pos-types';

/** One tender line the cashier has committed to the basket. */
export interface Tender {
  method: PaymentMethod;
  amount: number;
  momo_number?: string;
  momo_network?: string;
  email?: string;
  reference?: string;
}

interface PaymentModalProps {
  open: boolean;
  onClose: () => void;
  /** What the customer still owes on the server-priced basket. */
  balance: number;
  config: PaymentConfig | null;
  tenders: Tender[];
  onTendersChange: (tenders: Tender[]) => void;
  /** Called once the tenders cover the balance and the cashier confirms. */
  onComplete: () => void;
  submitting?: boolean;
}

const METHOD_ICON: Record<PaymentMethod, typeof Banknote> = {
  cash: Banknote,
  momo: Smartphone,
  card: CreditCard,
  bank_transfer: Landmark,
  nhis: Users,
  credit: Receipt,
};

/** Common counter denominations, largest first. */
const QUICK_CASH = [200, 100, 50, 20, 10, 5, 1];

/**
 * Ghana mobile prefixes, used only to pre-select a network so the cashier taps
 * less. The backend resolves the provider the same way and Paystack rejects a
 * number that does not belong to the wallet, so a wrong guess fails loudly
 * rather than charging the wrong customer.
 */
const PREFIX_HINTS: Record<string, string> = {
  '024': 'mtn', '025': 'mtn', '054': 'mtn', '055': 'mtn', '059': 'mtn',
  '020': 'vod', '050': 'vod',
  '026': 'atl', '027': 'atl', '056': 'atl', '057': 'atl',
};

function normalizePhone(input: string): string | null {
  const digits = input.replace(/\D/g, '');
  if (digits.startsWith('233') && digits.length === 12) return `0${digits.slice(3)}`;
  if (digits.length === 9 && digits.startsWith('2')) return `0${digits}`;
  if (digits.length === 10 && digits.startsWith('0')) return digits;
  return null;
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Tender capture with split payments.
 *
 * A basket can be settled by any combination of methods — part cash, part MoMo
 * is ordinary at a pharmacy counter — so tenders accumulate into a list and
 * the sale completes when they cover the balance. Cash alone may exceed the
 * balance (change is given back); every other method is capped at what is
 * still owed, because over-collecting on a wallet would need a refund.
 */
export function PaymentModal({
  open,
  onClose,
  balance,
  config,
  tenders,
  onTendersChange,
  onComplete,
  submitting = false,
}: PaymentModalProps) {
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [amountText, setAmountText] = useState('');
  const [phone, setPhone] = useState('');
  const [network, setNetwork] = useState('');
  const [email, setEmail] = useState('');
  const [reference, setReference] = useState('');
  const [error, setError] = useState<string | null>(null);

  const networks: MomoNetwork[] = config?.networks ?? [];
  const methods: PaymentMethod[] = config?.methods ?? ['cash'];

  // Reset the form whenever a new basket is tendered.
  useEffect(() => {
    if (!open) return;
    setMethod('cash');
    setAmountText(balance > 0 ? balance.toFixed(2) : '');
    setPhone('');
    setNetwork('');
    setEmail('');
    setReference('');
    setError(null);
  }, [open, balance]);

  const committed = useMemo(
    () => round2(tenders.reduce((total, tender) => total + tender.amount, 0)),
    [tenders]
  );
  const remaining = round2(Math.max(balance - committed, 0));
  const entered = Number(amountText);
  // Mirrors the server's change_due = GREATEST(paid - total, 0). Only a first
  // cash tender may exceed the balance, so this is always a cash overpayment.
  const changeDue = committed > balance + 0.004 ? round2(committed - balance) : 0;
  // Live preview while the cashier is still typing the cash handed over, so
  // they can read the change back to the customer before committing it.
  const changePreview =
    changeDue > 0
      ? changeDue
      : method === 'cash' && tenders.length === 0 && entered > balance + 0.004
        ? round2(entered - balance)
        : 0;

  const suggestedNetwork = useMemo(() => {
    const normalized = normalizePhone(phone);
    if (!normalized) return '';
    return PREFIX_HINTS[normalized.slice(0, 3)] ?? '';
  }, [phone]);

  const gatewayConnected = Boolean(config?.gateway.connected);

  function resetEntry() {
    setAmountText(remaining > 0 ? remaining.toFixed(2) : '');
    setPhone('');
    setNetwork('');
    setEmail('');
    setReference('');
    setError(null);
  }

  function addTender() {
    const value = round2(Number(amountText));
    if (!Number.isFinite(value) || value <= 0) {
      setError('Enter an amount greater than zero');
      return;
    }

    // Cash may overpay (change); everything else is capped at what is owed.
    const cap = method === 'cash' && tenders.length === 0 ? Number.POSITIVE_INFINITY : remaining;
    if (value > cap + 0.004) {
      setError(
        method === 'cash'
          ? 'Cash can only overpay on the first tender'
          : `Only ${money(remaining)} is still owed`
      );
      return;
    }

    const tender: Tender = { method, amount: value };

    if (method === 'momo') {
      const normalized = normalizePhone(phone);
      if (!normalized) {
        setError('Enter a valid Ghana mobile money number, e.g. 0241234567');
        return;
      }
      const provider = network || suggestedNetwork;
      if (!provider) {
        setError("Select the customer's mobile money network");
        return;
      }
      tender.momo_number = normalized;
      tender.momo_network = provider;
    }

    if (method === 'card' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) {
      setError('A card payment needs the customer’s email for the Paystack checkout');
      return;
    }
    if (method === 'card') tender.email = email.trim();

    if (reference.trim()) tender.reference = reference.trim();

    onTendersChange([...tenders, tender]);
    resetEntry();
  }

  function keypadPress(key: string) {
    setError(null);
    if (key === 'clear') {
      setAmountText('');
      return;
    }
    if (key === 'back') {
      setAmountText((current) => current.slice(0, -1));
      return;
    }
    // Guard against a runaway amount: two decimals and a sane ceiling.
    setAmountText((current) => {
      if (key === '.' && current.includes('.')) return current;
      const next = `${current}${key}`;
      if (next.split('.')[1]?.length > 2) return current;
      if (Number(next) > 1_000_000) return current;
      return next;
    });
  }

  const canComplete = remaining <= 0.004 && tenders.length > 0;

  return (
    <Modal
      open={open}
      onClose={submitting ? () => {} : onClose}
      title="Take payment"
      description={`${money(remaining)} still to collect of ${money(balance)}`}
      size="lg"
      footer={
        <div className="flex w-full flex-wrap items-center justify-between gap-2">
          <div className="text-sm">
            <span className="text-gray-500">Committed </span>
            <span className="font-semibold text-gray-900">{money(committed)}</span>
            {changePreview > 0 && (
              <span className="ml-2 font-medium text-green-700">Change {money(changePreview)}</span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="btn-secondary btn-sm"
              onClick={onClose}
              disabled={submitting}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={addTender}
              disabled={submitting || remaining <= 0.004}
            >
              Add payment
            </button>
            <button
              type="button"
              className="btn-primary min-h-[48px] px-5 text-base font-semibold"
              onClick={onComplete}
              disabled={submitting || !canComplete}
            >
              {submitting ? 'Recording…' : `Complete · ${money(balance)}`}
            </button>
          </div>
        </div>
      }
    >
      {!gatewayConnected && (
        <div className="mb-4 rounded-lg border border-yellow-200 bg-yellow-50 p-3 text-sm text-yellow-900">
          <p className="font-medium">No payment gateway is connected.</p>
          <p className="mt-0.5 text-xs">
            MoMo and card will be recorded as <strong>manual</strong> — the app writes down what you
            were handed, but it cannot charge a wallet or confirm the money arrived. Add
            PAYSTACK_SECRET_KEY on the server to take real mobile money.
          </p>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        {/* Left: method + amount */}
        <div className="space-y-3">
          <div>
            <p className="label">Method</p>
            <div className="grid grid-cols-3 gap-2">
              {methods.map((option) => {
                const Icon = METHOD_ICON[option] ?? Banknote;
                const disabled = (option === 'momo' || option === 'card') && !gatewayConnected;
                return (
                  <button
                    key={option}
                    type="button"
                    disabled={disabled}
                    onClick={() => {
                      setMethod(option);
                      setError(null);
                      setAmountText(remaining > 0 ? remaining.toFixed(2) : '');
                    }}
                    className={`flex min-h-[60px] flex-col items-center justify-center gap-1 rounded-xl border-2 px-2 py-2 text-xs font-medium transition ${
                      method === option
                        ? 'border-primary-500 bg-primary-50 text-primary-700'
                        : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'
                    } ${disabled ? 'cursor-not-allowed opacity-40' : ''}`}
                  >
                    <Icon className="h-5 w-5" />
                    <span className="text-center leading-tight">
                      {PAYMENT_METHOD_LABEL[option] ?? option}
                    </span>
                  </button>
                );
              })}
            </div>
            {(method === 'momo' || method === 'card') && !gatewayConnected && (
              <p className="mt-1 text-xs text-gray-500">
                Recorded manually — no gateway key is configured on the server.
              </p>
            )}
          </div>

          <div>
            <label className="label" htmlFor="tender-amount">
              Amount (GHS)
            </label>
            <input
              id="tender-amount"
              className="input text-right text-xl font-semibold tabular-nums"
              inputMode="decimal"
              value={amountText}
              onChange={(event) => {
                setAmountText(event.target.value);
                setError(null);
              }}
              placeholder="0.00"
            />
            <div className="mt-2 flex flex-wrap gap-1.5">
              <button
                type="button"
                className="btn-sm btn-secondary"
                onClick={() => setAmountText(remaining.toFixed(2))}
              >
                Exact {money(remaining)}
              </button>
              {method === 'cash' &&
                QUICK_CASH.map((note) => (
                  <button
                    key={note}
                    type="button"
                    className="btn-sm btn-ghost"
                    onClick={() =>
                      setAmountText(round2(Number(amountText || 0) + note).toFixed(2))
                    }
                  >
                    +{note}
                  </button>
                ))}
            </div>
          </div>

          {method === 'momo' && (
            <div className="space-y-2">
              <div>
                <label className="label" htmlFor="momo-phone">
                  Customer mobile money number
                </label>
                <input
                  id="momo-phone"
                  className="input text-lg"
                  inputMode="tel"
                  value={phone}
                  onChange={(event) => setPhone(event.target.value)}
                  placeholder="0241234567"
                />
                {suggestedNetwork && !network && (
                  <p className="mt-1 text-xs text-gray-500">
                    Looks like{' '}
                    {networks.find((entry) => entry.provider === suggestedNetwork)?.label ??
                      suggestedNetwork}{' '}
                    — confirm below.
                  </p>
                )}
              </div>
              <div>
                <p className="label">Network</p>
                <div className="grid grid-cols-3 gap-2">
                  {networks.map((entry) => {
                    const active = (network || suggestedNetwork) === entry.provider;
                    return (
                      <button
                        key={entry.provider}
                        type="button"
                        onClick={() => setNetwork(entry.provider)}
                        className={`min-h-[48px] rounded-xl border-2 px-2 py-2 text-xs font-medium ${
                          network === entry.provider
                            ? 'border-primary-500 bg-primary-50 text-primary-700'
                            : active
                              ? 'border-dashed border-primary-300 bg-white text-primary-600'
                              : 'border-gray-200 bg-white text-gray-600'
                        }`}
                      >
                        {entry.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {method === 'card' && (
            <div>
              <label className="label" htmlFor="card-email">
                Customer email
              </label>
              <input
                id="card-email"
                className="input"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="customer@example.com"
              />
              <p className="mt-1 text-xs text-gray-500">
                Paystack sends a secure checkout link to this address.
              </p>
            </div>
          )}

          {(method === 'bank_transfer' || method === 'nhis' || method === 'credit') && (
            <div>
              <label className="label" htmlFor="tender-reference">
                Reference (optional)
              </label>
              <input
                id="tender-reference"
                className="input"
                value={reference}
                onChange={(event) => setReference(event.target.value)}
                placeholder={
                  method === 'nhis' ? 'NHIS claim or membership number' : 'Transfer or receipt number'
                }
              />
            </div>
          )}

          {error && <p className="text-sm font-medium text-red-600">{error}</p>}
        </div>

        {/* Right: keypad for gloved/finger use at the counter */}
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-2">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', 'back'].map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => keypadPress(key)}
                className="min-h-[56px] rounded-xl border border-gray-200 bg-white text-xl font-semibold text-gray-800 shadow-sm active:bg-gray-100"
                aria-label={key === 'back' ? 'Delete last digit' : key}
              >
                {key === 'back' ? '⌫' : key}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="btn-secondary w-full"
            onClick={() => keypadPress('clear')}
          >
            Clear amount
          </button>

          <div>
            <p className="label">Payments on this sale</p>
            {tenders.length === 0 ? (
              <p className="rounded-lg border border-dashed border-gray-200 p-3 text-sm text-gray-500">
                Nothing added yet. Choose a method and tap &ldquo;Add payment&rdquo;.
              </p>
            ) : (
              <ul className="space-y-1.5">
                {tenders.map((tender, index) => (
                  <li
                    key={`${tender.method}-${index}`}
                    className="flex items-center justify-between gap-2 rounded-lg border border-gray-100 bg-gray-50 px-3 py-2 text-sm"
                  >
                    <div className="min-w-0">
                      <p className="font-medium text-gray-900">
                        {PAYMENT_METHOD_LABEL[tender.method] ?? tender.method} · {money(tender.amount)}
                      </p>
                      <p className="truncate text-xs text-gray-500">
                        {tender.momo_number
                          ? `${tender.momo_number}${
                              tender.momo_network ? ` · ${tender.momo_network.toUpperCase()}` : ''
                            }`
                          : tender.email || tender.reference || 'No extra detail'}
                      </p>
                    </div>
                    <button
                      type="button"
                      className="p-2 rounded-lg text-gray-400 hover:bg-red-50 hover:text-red-600"
                      aria-label="Remove this payment"
                      onClick={() => onTendersChange(tenders.filter((_, i) => i !== index))}
                      disabled={submitting}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-sm">
              <span className="text-gray-500">Remaining </span>
              <span className="font-semibold text-gray-900">{money(remaining)}</span>
              {canComplete && <span className="ml-2 text-green-700">Ready to complete</span>}
            </p>
          </div>
        </div>
      </div>
    </Modal>
  );
}
