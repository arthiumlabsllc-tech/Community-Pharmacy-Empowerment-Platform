import crypto from 'crypto';
import config from '../config';
import logger from '../utils/logger';

/**
 * Paystack payment service — Ghana Mobile Money (MoMo) and card.
 *
 * Two things this module refuses to do:
 *
 *  1. Pretend to take money. When PAYSTACK_SECRET_KEY is absent the service
 *     returns an explicit `mode: 'manual'` result instead of faking a gateway
 *     response. The POS stores those payments with `gateway = NULL` and the
 *     UI labels them "recorded manually", so a pharmacy that has not yet
 *     onboarded with Paystack can still use the till and nobody is misled
 *     into thinking a charge happened.
 *
 *  2. Trust its own charge call. MoMo is asynchronous: the customer must
 *     approve a prompt on their handset, which can take seconds or minutes,
 *     or never happen. A charge therefore returns `pending` and the money is
 *     only counted as received once `/transaction/verify` or the signed
 *     `charge.success` webhook says so.
 */

const BASE_URL = 'https://api.paystack.co';
const REQUEST_TIMEOUT_MS = 20_000;

export type MomoProvider = 'mtn' | 'vod' | 'atl';

export interface MomoNetworkInfo {
  provider: MomoProvider;
  label: string;
}

export const GHANA_MOMO_NETWORKS: MomoNetworkInfo[] = [
  { provider: 'mtn', label: 'MTN MoMo' },
  { provider: 'vod', label: 'Telecel (Vodafone) Cash' },
  { provider: 'atl', label: 'AirtelTigo Money' },
];

/**
 * Everything a cashier or a customer might type for a network. Keys are the
 * lowercased, punctuation-free form of the input.
 */
const PROVIDER_ALIASES: Record<string, MomoProvider> = {
  mtn: 'mtn',
  momo: 'mtn',
  mtnmomo: 'mtn',
  mtnmobilemoney: 'mtn',
  yellow: 'mtn',
  vod: 'vod',
  vodafone: 'vod',
  vodafonecash: 'vod',
  telecel: 'vod',
  telecelcash: 'vod',
  red: 'vod',
  atl: 'atl',
  airtel: 'atl',
  tigo: 'atl',
  airteltigo: 'atl',
  airteltigomoney: 'atl',
  atm: 'atl',
  atmoney: 'atl',
  blue: 'atl',
};

/**
 * Ghana mobile prefixes, used only to pre-select a network so the cashier taps
 * less. It is a hint: the explicit choice always wins, and Paystack rejects a
 * number that does not belong to the provider, so a wrong guess fails loudly
 * rather than charging the wrong wallet.
 */
const PREFIX_HINTS: Record<string, MomoProvider> = {
  '024': 'mtn', '025': 'mtn', '054': 'mtn', '055': 'mtn', '059': 'mtn',
  '020': 'vod', '050': 'vod',
  '026': 'atl', '027': 'atl', '056': 'atl', '057': 'atl',
};

/**
 * Legacy `bank.code` values, used only for the fallback charge shape (see
 * chargeMobileMoney). The modern API takes `mobile_money.provider`.
 */
const LEGACY_BANK_CODES: Record<MomoProvider, string> = {
  mtn: 'MTN',
  vod: 'VODAFONE',
  atl: 'AIRTELTI',
};

export type ChargeOutcome = 'success' | 'pending' | 'failed' | 'manual';

export interface ChargeResult {
  /** 'gateway' = Paystack was called; 'manual' = cashier confirmed cash-in-hand */
  mode: 'gateway' | 'manual';
  outcome: ChargeOutcome;
  reference: string;
  message: string;
  /** Present when the customer must approve on their handset */
  awaitingCustomerApproval: boolean;
  /** Redirect target for the hosted-checkout path */
  authorizationUrl?: string;
  /** Verbatim gateway payload, stored on the payment row for audit */
  gatewayResponse?: unknown;
}

export class PaystackError extends Error {
  statusCode: number;

  constructor(message: string, statusCode = 502) {
    super(message);
    this.name = 'PaystackError';
    this.statusCode = statusCode;
  }
}

interface PaystackEnvelope<T> {
  status: boolean;
  message: string;
  data: T;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** True when a live secret key is present, i.e. real charges are possible. */
export function isGatewayConfigured(): boolean {
  return Boolean(config.paystack.secretKey && config.paystack.secretKey.trim());
}

/**
 * Describes the payment configuration for the POS settings banner. Deliberately
 * reports the truth so the UI can say "gateway not connected" instead of
 * showing MoMo buttons that cannot charge anybody.
 */
export function gatewayStatus(): { connected: boolean; mode: string; keyPrefix: string } {
  const key = config.paystack.secretKey || '';
  return {
    connected: isGatewayConfigured(),
    mode: isGatewayConfigured() ? 'live gateway' : 'manual recording',
    // Never expose more than the sk_test/sk_live marker.
    keyPrefix: key.slice(0, 7),
  };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** GHS -> pesewas. Paystack amounts are integers in the smallest unit. */
export function toPesewas(amount: number): number {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) {
    throw new PaystackError('Amount must be a positive number', 400);
  }
  return Math.round((value + Number.EPSILON) * 100);
}

/** pesewas -> GHS, for reading amounts back out of verify/webhook payloads. */
export function toCedis(pesewas: number | string): number {
  const value = Number(pesewas);
  if (!Number.isFinite(value)) return 0;
  return Math.round(value) / 100;
}

/**
 * Collapses a Ghanaian number to local format (0XXXXXXXXX).
 * Accepts 0241234567, +233241234567, 233 24 123 4567, 24-123-4567.
 */
export function normalizeGhanaPhone(input?: string | null): string | null {
  if (!input) return null;

  let digits = String(input).replace(/\D/g, '');
  if (!digits) return null;

  if (digits.startsWith('233')) digits = `0${digits.slice(3)}`;
  if (digits.length === 9 && /^[25]/.test(digits)) digits = `0${digits}`;
  if (digits.length !== 10 || !/^0[25]/.test(digits)) return null;

  return digits;
}

/** Resolves any reasonable spelling of a network to a Paystack provider code. */
export function normalizeMomoProvider(input?: string | null): MomoProvider | null {
  if (!input) return null;
  const key = String(input).toLowerCase().replace(/[\s._-]/g, '');
  return PROVIDER_ALIASES[key] ?? null;
}

/**
 * Provider choice for a charge: an explicit selection wins, otherwise the
 * number prefix is used as a hint. Returns null when neither is available.
 */
export function resolveProvider(
  explicit?: string | null,
  phone?: string | null
): MomoProvider | null {
  const chosen = normalizeMomoProvider(explicit);
  if (chosen) return chosen;

  const normalized = normalizeGhanaPhone(phone);
  if (!normalized) return null;
  return PREFIX_HINTS[normalized.slice(0, 3)] ?? null;
}

export function generateReference(prefix: string): string {
  const safe = prefix.replace(/[^a-zA-Z0-9]/g, '').slice(0, 12) || 'pos';
  return `${safe}_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
}

/**
 * Walk-in sales have no customer email, but the charge endpoint requires one.
 * A deterministic placeholder keeps Paystack happy without inventing an
 * address that could receive mail.
 */
function receiptEmail(reference: string, email?: string | null): string {
  if (email && email.includes('@')) return email;
  return `pos+${reference}@payments.local`;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

async function paystackRequest<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: Record<string, unknown>
): Promise<PaystackEnvelope<T>> {
  if (!isGatewayConfigured()) {
    throw new PaystackError('Paystack is not configured on this server', 503);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${config.paystack.secretKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    throw new PaystackError(
      aborted
        ? `Paystack did not respond within ${REQUEST_TIMEOUT_MS / 1000}s`
        : 'Could not reach Paystack. Check the network connection.',
      aborted ? 504 : 502
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let payload: PaystackEnvelope<T>;
  try {
    payload = JSON.parse(text);
  } catch {
    logger.error('Paystack returned a non-JSON body', { path, status: response.status });
    throw new PaystackError(`Paystack returned an unreadable response (HTTP ${response.status})`, 502);
  }

  if (!response.ok || payload.status === false) {
    throw new PaystackError(
      payload.message || `Paystack request failed (HTTP ${response.status})`,
      response.status >= 500 ? 502 : response.status
    );
  }

  return payload;
}

/** True when a failed charge looks like a request-shape problem, not a decline. */
function isShapeRejection(error: unknown): boolean {
  if (!(error instanceof PaystackError)) return false;
  if (error.statusCode !== 400 && error.statusCode !== 422) return false;
  return /bank|mobile_money|provider|invalid|field/i.test(error.message);
}

// ---------------------------------------------------------------------------
// Mobile Money
// ---------------------------------------------------------------------------

export interface MomoChargeInput {
  /** Amount in GHS, not pesewas */
  amount: number;
  phone: string;
  /** Network name as typed/selected by the cashier */
  provider?: string | null;
  email?: string | null;
  reference?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Pushes a payment prompt to a customer's handset.
 *
 * Returns `pending` under normal circumstances — the money has not moved until
 * the customer enters their MoMo PIN. Call `verifyTransaction(reference)` (or
 * wait for the `charge.success` webhook) before handing over goods.
 *
 * Two request shapes are tried because Paystack's mobile-money charge accepts
 * the modern `mobile_money: { phone, provider }` object while older accounts
 * and SDKs document `bank: { code, phone }`. The retry only fires on a 4xx
 * validation rejection, never on a declined charge.
 */
export async function chargeMobileMoney(input: MomoChargeInput): Promise<ChargeResult> {
  const reference = input.reference || generateReference('momo');

  if (!isGatewayConfigured()) {
    return manualChargeResult(reference, 'Mobile Money');
  }

  const phone = normalizeGhanaPhone(input.phone);
  if (!phone) {
    throw new PaystackError('Enter a valid Ghana mobile money number, e.g. 0241234567', 400);
  }

  const provider = resolveProvider(input.provider, phone);
  if (!provider) {
    throw new PaystackError('Select the customer\'s mobile money network', 400);
  }

  const amount = toPesewas(input.amount);
  const base = {
    email: receiptEmail(reference, input.email),
    amount,
    currency: 'GHS',
    reference,
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };

  let data: any;
  try {
    const response = await paystackRequest<any>('POST', '/charge', {
      ...base,
      mobile_money: { phone, provider },
    });
    data = response.data;
  } catch (error) {
    if (!isShapeRejection(error)) throw error;

    logger.warn('Paystack rejected the mobile_money charge shape, retrying with bank.code', {
      reference,
      message: (error as PaystackError).message,
    });
    const response = await paystackRequest<any>('POST', '/charge', {
      ...base,
      bank: { code: LEGACY_BANK_CODES[provider], phone },
    });
    data = response.data;
  }

  const status = String(data?.status || '').toLowerCase();
  const displayText = data?.display_text || data?.gateway_response || '';

  // 'send_otp' / 'pending' / 'send_phone' all mean the customer still has to
  // act on their own handset.
  if (status === 'success') {
    return {
      mode: 'gateway',
      outcome: 'success',
      reference: data?.reference || reference,
      message: 'Payment received',
      awaitingCustomerApproval: false,
      gatewayResponse: data,
    };
  }

  if (status === 'failed' || status === 'abandoned') {
    return {
      mode: 'gateway',
      outcome: 'failed',
      reference: data?.reference || reference,
      message: displayText || 'Mobile money payment was not completed',
      awaitingCustomerApproval: false,
      gatewayResponse: data,
    };
  }

  return {
    mode: 'gateway',
    outcome: 'pending',
    reference: data?.reference || reference,
    message: `A payment prompt was sent to ${phone}. Ask the customer to approve it on their handset.`,
    awaitingCustomerApproval: true,
    gatewayResponse: data,
  };
}

// ---------------------------------------------------------------------------
// Hosted checkout (card + MoMo)
// ---------------------------------------------------------------------------

export interface CheckoutInput {
  amount: number;
  email?: string | null;
  reference?: string;
  callbackUrl?: string | null;
  /** Defaults to card and mobile money — the two channels a pharmacy counter uses. */
  channels?: string[];
  metadata?: Record<string, unknown>;
}

/**
 * Creates a Paystack-hosted payment page and returns its URL. Useful for card
 * payments and as a fallback when the direct MoMo charge is unavailable: the
 * customer enters their own details on Paystack's page.
 */
export async function initializeCheckout(input: CheckoutInput): Promise<ChargeResult> {
  const reference = input.reference || generateReference('pay');

  if (!isGatewayConfigured()) {
    return manualChargeResult(reference, 'Card');
  }

  const response = await paystackRequest<any>('POST', '/transaction/initialize', {
    email: receiptEmail(reference, input.email),
    amount: toPesewas(input.amount),
    currency: 'GHS',
    reference,
    channels: input.channels?.length ? input.channels : ['card', 'mobile_money'],
    ...(input.callbackUrl ? { callback_url: input.callbackUrl } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  });

  const authorizationUrl = response.data?.authorization_url;
  if (!authorizationUrl) {
    throw new PaystackError('Paystack did not return a payment page URL', 502);
  }

  return {
    mode: 'gateway',
    outcome: 'pending',
    reference: response.data?.reference || reference,
    message: 'Complete the payment on the Paystack page, then confirm here.',
    awaitingCustomerApproval: true,
    authorizationUrl,
    gatewayResponse: response.data,
  };
}

// ---------------------------------------------------------------------------
// Verification and webhooks
// ---------------------------------------------------------------------------

export interface VerificationResult {
  outcome: 'success' | 'pending' | 'failed' | 'unknown';
  reference: string;
  amount: number;
  currency: string;
  channel: string;
  paidAt: string | null;
  gatewayResponse?: unknown;
}

/**
 * Asks Paystack for the definitive state of a transaction. This — not the
 * charge response and never the webhook alone — is what marks a sale paid.
 */
export async function verifyTransaction(reference: string): Promise<VerificationResult> {
  const response = await paystackRequest<any>('GET', `/transaction/verify/${encodeURIComponent(reference)}`);
  const data = response.data || {};
  const status = String(data.status || '').toLowerCase();

  let outcome: VerificationResult['outcome'];
  if (status === 'success') outcome = 'success';
  else if (status === 'pending' || status === 'processing' || status === 'queued') outcome = 'pending';
  else if (status) outcome = 'failed';
  else outcome = 'unknown';

  return {
    outcome,
    reference: data.reference || reference,
    amount: toCedis(data.amount ?? 0),
    currency: data.currency || 'GHS',
    channel: data.channel || '',
    paidAt: data.paid_at || null,
    gatewayResponse: data,
  };
}

/**
 * Validates the `x-paystack-signature` header: an HMAC-SHA512 of the RAW
 * request body signed with the secret key. The body must be verified as bytes,
 * because re-serialising a parsed object changes whitespace and breaks the
 * hash. Express must therefore capture this route with express.raw().
 */
export function verifyWebhookSignature(rawBody: Buffer | string, signature?: string | null): boolean {
  if (!signature || !isGatewayConfigured()) return false;

  const expected = crypto
    .createHmac('sha512', config.paystack.secretKey)
    .update(typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody)
    .digest('hex');

  const provided = Buffer.from(String(signature), 'utf8');
  const computed = Buffer.from(expected, 'utf8');
  // Lengths differ => timingSafeEqual throws, so compare explicitly first.
  if (provided.length !== computed.length) return false;

  return crypto.timingSafeEqual(provided, computed);
}

export interface WebhookEvent {
  event: string;
  data: any;
}

/** Parses a signature-checked webhook body. */
export function parseWebhookEvent(rawBody: Buffer | string, signature?: string | null): WebhookEvent {
  if (!verifyWebhookSignature(rawBody, signature)) {
    throw new PaystackError('Invalid webhook signature', 401);
  }

  const text = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new PaystackError('Webhook body is not valid JSON', 400);
  }

  if (!parsed || typeof parsed.event !== 'string') {
    throw new PaystackError('Webhook payload is missing an event name', 400);
  }

  return { event: parsed.event, data: parsed.data ?? {} };
}

// ---------------------------------------------------------------------------
// Refunds
// ---------------------------------------------------------------------------

/**
 * Refunds a completed transaction, in full or in part. `amount` is in GHS and
 * is optional — omit it to refund everything that was charged.
 */
export async function refundTransaction(
  reference: string,
  amount?: number | null
): Promise<{ processed: boolean; reference: string; amount: number; gatewayResponse: unknown }> {
  const payload: Record<string, unknown> = { transaction: reference };
  if (amount !== undefined && amount !== null) payload.amount = toPesewas(amount);

  const response = await paystackRequest<any>('POST', '/refund', payload);
  const data = response.data || {};

  return {
    processed: Boolean(data.status === 'processed' || data.status === 'pending'),
    reference: data.transaction_reference || reference,
    amount: toCedis(data.amount ?? payload.amount ?? 0),
    gatewayResponse: data,
  };
}

// ---------------------------------------------------------------------------
// Manual mode
// ---------------------------------------------------------------------------

/**
 * Result returned when no gateway key is configured. The sale is recorded with
 * gateway = NULL so reports can distinguish money that was actually collected
 * through Paystack from money the pharmacy confirms it received by hand.
 */
function manualChargeResult(reference: string, methodLabel: string): ChargeResult {
  return {
    mode: 'manual',
    outcome: 'manual',
    reference,
    message: `No payment gateway is connected. This ${methodLabel} payment is being recorded manually — confirm with the customer that it was sent and settled.`,
    awaitingCustomerApproval: false,
    gatewayResponse: { mode: 'manual', reason: 'PAYSTACK_SECRET_KEY not configured' },
  };
}

export const paystack = {
  isGatewayConfigured,
  gatewayStatus,
  chargeMobileMoney,
  initializeCheckout,
  verifyTransaction,
  verifyWebhookSignature,
  parseWebhookEvent,
  refundTransaction,
  normalizeGhanaPhone,
  normalizeMomoProvider,
  resolveProvider,
  generateReference,
  toPesewas,
  toCedis,
  networks: GHANA_MOMO_NETWORKS,
};

export default paystack;
