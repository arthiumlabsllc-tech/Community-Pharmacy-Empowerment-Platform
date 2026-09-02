/**
 * Wire shapes for /api/pos/*, mirrored from backend/src/routes/pos.routes.ts
 * and backend/src/routes/pos-report.routes.ts.
 *
 * Money arrives as a Postgres NUMERIC, which the pg driver returns as a string.
 * Nothing here assumes a number: read money through `money()` so a `null`, a
 * string or a number all render the same way and the till never shows "NaN".
 */

export type VatTreatment = 'standard' | 'exempt' | 'zero_rated';
export type PricingMode = 'inclusive' | 'exclusive';
export type SaleStatus = 'pending' | 'completed' | 'voided';
export type PaymentStatus = 'pending' | 'completed' | 'authorised' | 'failed' | 'refunded';

/** cash-like methods settle immediately; momo/card go through the gateway. */
export type PaymentMethod =
  | 'cash'
  | 'bank_transfer'
  | 'nhis'
  | 'credit'
  | 'momo'
  | 'card';

export const PAYMENT_METHOD_LABEL: Record<PaymentMethod, string> = {
  cash: 'Cash',
  momo: 'Mobile Money',
  card: 'Card',
  bank_transfer: 'Bank Transfer',
  nhis: 'NHIS',
  credit: 'Credit (owe)',
};

export const SALE_STATUS_LABEL: Record<SaleStatus, string> = {
  completed: 'Completed',
  pending: 'Awaiting payment',
  voided: 'Voided',
};

/** Formats any server money value as GHS. Accepts string, number or null. */
export function money(value: unknown): string {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return 'GHS 0.00';
  return `GHS ${amount.toFixed(2)}`;
}

/** The bare number, for inputs and arithmetic. Never NaN. */
export function amount(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export const VAT_TREATMENT_LABEL: Record<VatTreatment, string> = {
  standard: 'Standard rated',
  exempt: 'VAT exempt',
  zero_rated: 'Zero rated',
};

// ---------------------------------------------------------------------------
// Till catalogue
// ---------------------------------------------------------------------------

export interface PosProduct {
  id: string;
  product_name: string;
  generic_name: string | null;
  product_code: string;
  barcode: string | null;
  category: string | null;
  manufacturer: string | null;
  unit_price: string;
  cost_price: string;
  quantity: number;
  reorder_level: number;
  batch_number: string | null;
  expiry_date: string | null;
  requires_prescription: boolean;
  vat_treatment: VatTreatment;
  pack_size: number;
  default_sell_unit: string;
  shelf_location: string | null;
  needs_reorder: boolean;
  is_expired: boolean;
  near_expiry: boolean;
}

export interface PosCategory {
  category: string;
  item_count: number;
}

export interface MomoNetwork {
  provider: string;
  label: string;
}

export interface PaymentConfig {
  gateway: { connected: boolean; mode: string; keyPrefix: string };
  networks: MomoNetwork[];
  methods: PaymentMethod[];
  currency: string;
  tax: {
    vat_registered: boolean;
    pricing_mode: PricingMode;
    rates: Partial<Record<'vat' | 'nhil' | 'getfund', number>> | null;
  };
}

// ---------------------------------------------------------------------------
// Quote
// ---------------------------------------------------------------------------

export interface QuoteLine {
  inventory_id: string | null;
  product_name: string;
  generic_name: string | null;
  batch_number: string | null;
  expiry_date: string | null;
  requires_prescription: boolean;
  quantity: number;
  sell_unit: string;
  unit_price: number;
  discount_amount: number;
  line_total: number;
  vat_treatment: VatTreatment;
  taxable_base: number;
  vat_amount: number;
  nhil_amount: number;
  getfund_amount: number;
  quantity_available: number | null;
  oversold: boolean;
}

export interface QuoteSummary {
  subtotal: number;
  discount_amount: number;
  taxable_base: number;
  exempt_amount: number;
  vat_amount: number;
  nhil_amount: number;
  getfund_amount: number;
  total_tax: number;
  total_amount: number;
}

export interface Quote {
  pricing_mode: PricingMode;
  vat_registered: boolean;
  rate_snapshot: {
    vat: number;
    nhil: number;
    getfund: number;
    vat_registered: boolean;
    pricing_mode: PricingMode;
  };
  lines: QuoteLine[];
  summary: QuoteSummary;
}

// ---------------------------------------------------------------------------
// Sales
// ---------------------------------------------------------------------------

export interface SaleItemRow {
  id: string;
  sale_id: string;
  inventory_id: string | null;
  product_name: string;
  product_code: string | null;
  generic_name: string | null;
  batch_number: string | null;
  expiry_date: string | null;
  requires_prescription: boolean;
  quantity: number;
  sell_unit: string;
  unit_price: string;
  discount_amount: string;
  line_total: string;
  vat_treatment: VatTreatment;
  taxable_base: string;
  vat_amount: string;
  nhil_amount: string;
  getfund_amount: string;
  unit_cost: string;
  created_at: string;
}

export interface SalePaymentRow {
  id: string;
  sale_id: string;
  pharmacy_id: string;
  method: PaymentMethod;
  amount: string;
  status: PaymentStatus;
  momo_network: string | null;
  momo_number: string | null;
  reference: string | null;
  gateway: string | null;
  received_by: string | null;
  paid_at: string | null;
  created_at: string;
}

/** Full sale as returned by POST /pos/sales, GET /pos/sales/:id and verify. */
export interface Sale {
  id: string;
  pharmacy_id: string;
  receipt_number: string;
  status: SaleStatus;
  patient_id: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  served_by: string;
  approved_by: string | null;
  subtotal: string;
  discount_amount: string;
  discount_reason: string | null;
  taxable_base: string;
  exempt_amount: string;
  vat_amount: string;
  nhil_amount: string;
  getfund_amount: string;
  total_amount: string;
  amount_paid: string;
  change_due: string;
  currency: string;
  pricing_mode: PricingMode;
  tax_rates: Record<string, unknown>;
  note: string | null;
  completed_at: string | null;
  voided_at: string | null;
  void_reason: string | null;
  created_at: string;
  patient_name: string | null;
  patient_phone: string | null;
  patient_nhis_number: string | null;
  served_by_name: string | null;
  approved_by_name: string | null;
  items: SaleItemRow[];
  payments: SalePaymentRow[];
}

/** One row of GET /pos/sales — a projection, not the full sale. */
export interface SaleListRow {
  id: string;
  receipt_number: string;
  status: SaleStatus;
  subtotal: string;
  discount_amount: string;
  total_amount: string;
  amount_paid: string;
  change_due: string;
  vat_amount: string;
  nhil_amount: string;
  getfund_amount: string;
  customer_name: string | null;
  patient_name: string | null;
  served_by_name: string | null;
  item_count: number;
  methods: string;
  created_at: string;
  completed_at: string | null;
}

/** Outcome of one gateway attempt, returned alongside the created sale. */
export interface GatewayOutcome {
  method: string;
  amount: number;
  mode: 'gateway' | 'manual' | null;
  outcome: 'success' | 'pending' | 'failed' | 'manual';
  reference: string | null;
  message: string;
  awaitingCustomerApproval: boolean;
  authorizationUrl: string | null;
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

/**
 * Reports. Mirrors backend/src/routes/pos-report.routes.ts.
 *
 * `withProfit()` on the server already derives net sales (gross less the
 * VAT/NHIL/GETFund that belongs to GRA) and margin from it, so the dashboards
 * must not recompute profit from gross_sales.
 */
export interface ReportPeriod {
  days: number;
  from: string | null;
  to: string | null;
}

export interface ProfitBlock {
  gross_sales: number;
  net_sales: number;
  tax: number;
  cogs: number;
  gross_profit: number;
  margin_percent: number;
}

export interface PaymentMethodBreakdown {
  method: PaymentMethod;
  payment_count: number;
  total: number;
  /** Recorded by hand rather than settled through Paystack. */
  manual_count: number;
}

export interface SalesSummaryReport extends ProfitBlock {
  period: ReportPeriod;
  transactions: number;
  voided_sales: number;
  units_sold: number;
  discounts: number;
  exempt_value: number;
  avg_basket: number;
  largest_sale: number;
  payment_methods: PaymentMethodBreakdown[];
  outstanding: { pending_sales: number; owed: number };
}

export interface DailySalesPoint {
  day: string;
  transactions: number;
  gross_sales: number;
  net_sales: number;
  tax: number;
  discounts: number;
}

export interface ProductProfitRow extends ProfitBlock {
  product_name: string;
  generic_name: string | null;
  vat_treatment: VatTreatment;
  units_sold: number;
  transactions: number;
}

export interface StaffPerformanceRow {
  id: string;
  name: string;
  role: string | null;
  transactions: number;
  voided_sales: number;
  gross_sales: number;
  net_sales: number;
  tax_collected: number;
  discounts_given: number;
  avg_basket: number;
}

export interface VatTreatmentBreakdown {
  vat_treatment: VatTreatment;
  line_count: number;
  units: number;
  value: number;
  taxable_base: number;
  vat: number;
  nhil: number;
  getfund: number;
}

export interface VatReturnReport {
  period: ReportPeriod;
  pharmacy: { name: string; license_number: string | null };
  vat_registered: boolean;
  transactions: number;
  gross_sales: number;
  taxable_base: number;
  exempt_value: number;
  vat: number;
  nhil: number;
  getfund: number;
  total_levies: number;
  by_treatment: VatTreatmentBreakdown[];
  /** Non-null when the pharmacy is not VAT registered — must be shown. */
  notice: string | null;
}
