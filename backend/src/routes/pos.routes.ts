import { Router, Request, Response } from 'express';
import { body, param } from 'express-validator';
import { PoolClient } from 'pg';
import db from '../config/database';
import { authenticate, authorize } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import { auditLog } from '../middleware/audit.middleware';
import { UserRole } from '../types';
import logger from '../utils/logger';
import {
  computeSaleTax,
  resolveTaxRates,
  round2,
  toVatTreatment,
  type PricingMode,
  type TaxRates,
  type VatTreatment,
} from '../utils/ghana-tax';
import paystack, { PaystackError, type ChargeResult } from '../services/paystack.service';
import { saleTime } from '../utils/sale-time';
import { buildTillProductQuery } from '../utils/pos-queries';
import {
  describeFefoShortfall,
  planFefo,
  summariseAllocations,
  todayInGhana,
  toIsoDate,
  type FefoPlan,
} from '../utils/fefo';
import { hasBatchTables, loadBatches, recordMovement } from '../utils/batches';
import { refreshStockAlertsFor } from '../utils/stock-alerts';

/**
 * Point of Sale.
 *
 * Three rules the whole file is built around:
 *
 *  1. The client never decides a price or a tax treatment. For a stocked item
 *     the unit price, cost and VAT classification are read from the inventory
 *     row inside the transaction. A tampered request cannot sell stock at
 *     GHS 0.01 or downgrade a standard-rated line to exempt.
 *
 *  2. No Paystack call happens inside a database transaction. A MoMo charge
 *     waits on a human entering a PIN on their handset, which can take minutes;
 *     holding a row lock across that would stall every other till in the
 *     pharmacy. Sales are therefore created first, then digital payments are
 *     pushed through the gateway and the sale is re-settled.
 *
 *  3. Stock cannot go negative at the counter. The deduction is a conditional
 *     UPDATE with `quantity >= requested`, so a concurrent sale of the last
 *     pack fails loudly instead of producing phantom stock. The one exception
 *     is a sale replayed from an offline queue: those goods have already left
 *     the building, so the count is allowed to go negative and the line is
 *     reported back for a stock-take to reconcile.
 *
 *  4. A product is not one number, it is a set of batches. Where a product has
 *     been received against a lot, the units come off the shortest-dated batch
 *     first (utils/fefo.ts decides which, inside this transaction), the batches
 *     are decremented rather than the product row, and the receipt line records
 *     the lots it drew from. The derived-stock trigger on `inventory` then
 *     recomputes the product's own quantity, batch and cost from what is left.
 *     A product that has never been received against a batch — or one that
 *     predates the batch tables being populated — falls back to the product row
 *     exactly as before, so nothing that worked stops working.
 */

const router = Router();

/** Settled on the spot, on the cashier's word — no gateway involved. */
const CASH_LIKE_METHODS: string[] = ['cash', 'bank_transfer', 'nhis', 'credit'];
/** Routed through Paystack, and therefore asynchronous. */
const GATEWAY_METHODS: string[] = ['momo', 'card'];
const ALL_PAYMENT_METHODS: string[] = [...CASH_LIKE_METHODS, ...GATEWAY_METHODS];

/** Raised for a business-rule rejection so the handler can return a clean 4xx. */
class PosError extends Error {
  statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

// ---------------------------------------------------------------------------
// Tax settings
// ---------------------------------------------------------------------------

interface TaxSettings {
  vatRegistered: boolean;
  rates: Partial<TaxRates> | null;
  pricingMode: PricingMode;
  /** Stored on every sale so an old receipt still reads correctly if the law changes. */
  snapshot: string;
}

/**
 * Reads the pharmacy's tax configuration from pharmacies.settings.tax.
 *
 * `vat_registered` defaults to true, which is correct for the pharmacies this
 * platform targets and is the safe direction for the exempt-by-default stock:
 * medicines carry no VAT either way, and only lines explicitly classified as
 * standard-rated are affected. A pharmacy below the GHS 750,000 Act 1151
 * registration threshold switches this off in Settings, at which point the
 * engine charges nothing at all.
 */
async function loadTaxSettings(pharmacyId: string, client?: PoolClient): Promise<TaxSettings> {
  const result = await (client ?? db).query('SELECT settings FROM pharmacies WHERE id = $1', [
    pharmacyId,
  ]);
  const tax = result.rows[0]?.settings?.tax || {};
  const vatRegistered = tax.vat_registered !== false;
  const rates = tax.rates && typeof tax.rates === 'object' ? (tax.rates as Partial<TaxRates>) : null;
  const pricingMode: PricingMode = tax.pricing_mode === 'exclusive' ? 'exclusive' : 'inclusive';
  const applied = resolveTaxRates(rates);

  return {
    vatRegistered,
    rates,
    pricingMode,
    // The rates that were actually applied, not the raw overrides: an
    // out-of-range override is discarded by the engine, and the snapshot must
    // not claim a rate that was never charged.
    snapshot: JSON.stringify({
      vat: applied.vat,
      nhil: applied.nhil,
      getfund: applied.getfund,
      vat_registered: vatRegistered,
      pricing_mode: pricingMode,
    }),
  };
}

// ---------------------------------------------------------------------------
// Basket helpers
// ---------------------------------------------------------------------------

interface PosLine {
  inventoryId: string | null;
  productName: string;
  productCode: string | null;
  genericName: string | null;
  batchNumber: string | null;
  expiryDate: string | null;
  requiresPrescription: boolean;
  quantity: number;
  sellUnit: string;
  unitPrice: number;
  unitCost: number;
  discountAmount: number;
  lineTotal: number;
  vatTreatment: VatTreatment;
  /**
   * Which batches this line came out of, in the order they should be taken.
   *
   * Null for an ad-hoc line with no product behind it, and null for a stocked
   * product that has no batches at all — that is the signal to fall back to the
   * product row rather than a shortfall to refuse the sale on.
   */
  batchPlan: FefoPlan | null;
}

/**
 * Splits a basket-level discount across the lines in proportion to their gross
 * value, so the discount reduces the taxable base of each line rather than
 * being applied after tax. Rounding drift is pushed into the largest line,
 * which keeps the shares summing exactly to the discount and the receipt
 * footing to the penny.
 */
function distributeDiscount(grossValues: number[], discount: number): number[] {
  const gross = grossValues.reduce((total, value) => total + value, 0);
  if (discount <= 0 || gross <= 0) return grossValues.map(() => 0);

  const capped = Math.min(discount, gross);
  const shares = grossValues.map((value) => round2((capped * value) / gross));
  const drift = round2(capped - shares.reduce((total, share) => total + share, 0));

  if (drift !== 0 && shares.length > 0) {
    let largest = 0;
    for (let i = 1; i < grossValues.length; i++) {
      if (grossValues[i] > grossValues[largest]) largest = i;
    }
    shares[largest] = round2(shares[largest] + drift);
  }

  return shares;
}

interface RawLine {
  inventory_id?: string;
  product_name?: string;
  quantity?: number;
  unit_price?: number;
  discount_amount?: number;
  vat_treatment?: string;
  sell_unit?: string;
}

/**
 * Turns one submitted basket line into a server-priced PosLine.
 * `stock` is the inventory row; when it is present its price, cost and VAT
 * classification override anything the client sent.
 * `plan` is the FEFO allocation for this line, or null when the product has no
 * batches to allocate from.
 */
function buildLine(
  raw: RawLine,
  stock: any,
  basketDiscountShare: number,
  plan: FefoPlan | null
): PosLine {
  const quantity = Math.floor(Number(raw.quantity));
  if (!Number.isFinite(quantity) || quantity < 1) {
    throw new PosError(`Invalid quantity for ${raw.product_name || stock?.product_name || 'an item'}`);
  }
  if (quantity > 10000) {
    throw new PosError(`Quantity for ${raw.product_name || stock.product_name} is unrealistically large`);
  }

  const stocked = Boolean(stock);
  const unitPrice = stocked
    ? Number(stock.unit_price)
    : Number(raw.unit_price ?? NaN);

  if (!Number.isFinite(unitPrice) || unitPrice < 0) {
    throw new PosError(`A price is required for ${raw.product_name || 'this item'}`);
  }

  const gross = round2(quantity * unitPrice);
  const ownDiscount = Math.min(
    Math.max(round2(Number(raw.discount_amount) || 0), 0),
    gross
  );
  // A line cannot be discounted below zero by the two discounts combined.
  const discountAmount = Math.min(round2(ownDiscount + basketDiscountShare), gross);
  const lineTotal = round2(gross - discountAmount);

  const productName =
    (stocked ? stock.product_name : String(raw.product_name || '').trim()) || 'Unnamed item';
  // The lots that physically went into the bag, when the product is tracked by
  // lot at all. sale_item_batches keeps the full breakdown; this is the label
  // for the receipt line.
  const summary = plan ? summariseAllocations(plan.allocations) : null;
  // Zero-cost batches are a delivery nobody priced yet, not a reason to report
  // the line as free stock. Fall back to the product's own cost in that case
  // rather than printing a 100% margin that is really a missing figure.
  const batchCost = plan && plan.weightedUnitCost > 0 ? plan.weightedUnitCost : null;

  return {
    inventoryId: stocked ? stock.id : null,
    productName,
    productCode: stocked ? stock.product_code : null,
    genericName: stocked ? stock.generic_name : null,
    batchNumber: summary ? summary.batchNumber : stocked ? stock.batch_number : null,
    expiryDate: summary
      ? summary.expiryDate
      : stocked
        ? toIsoDate(stock.expiry_date)
        : null,
    requiresPrescription: stocked ? Boolean(stock.requires_prescription) : false,
    quantity,
    sellUnit: String(raw.sell_unit || (stocked ? stock.default_sell_unit : '') || 'pack'),
    unitPrice: round2(unitPrice),
    unitCost: batchCost ?? (stocked ? Number(stock.cost_price) || 0 : 0),
    discountAmount,
    lineTotal,
    vatTreatment: stocked ? toVatTreatment(stock.vat_treatment) : toVatTreatment(raw.vat_treatment),
    batchPlan: plan,
  };
}

/**
 * How the sale route wants a basket priced.
 */
interface BasketOptions {
  /**
   * Lock the batch rows until the transaction ends. Only the sale route does
   * this. A quote must not: it would hold a lock on stock while the cashier is
   * still deciding what to sell, which is the stall rule 2 exists to avoid.
   */
  reserve?: boolean;
  /**
   * Plan for a sale the till recorded while the network was down. The goods
   * have physically left, so the plan covers the whole quantity even when the
   * shelf cannot and the shortfall is reported instead of refused.
   */
  allowOversell?: boolean;
  /**
   * Refuse the basket when the shelf cannot cover it. Off for a quote, which
   * flags instead — the cashier may legitimately be selling the last pack, and
   * the sale route is what enforces the limit.
   */
  enforceStock?: boolean;
}

/**
 * Prices a whole basket: loads stock rows and their batches, works out which
 * lots each line comes from, distributes the basket discount, builds the lines
 * and runs the Ghana tax engine over them.
 */
async function priceBasket(
  client: PoolClient,
  pharmacyId: string,
  rawItems: RawLine[],
  basketDiscount: number,
  taxSettings: TaxSettings,
  options: BasketOptions = {}
) {
  const { reserve = false, allowOversell = false, enforceStock = false } = options;

  const inventoryIds = rawItems
    .map((item) => item.inventory_id)
    .filter((id): id is string => Boolean(id));

  let stockRows: any[] = [];
  if (inventoryIds.length > 0) {
    const result = await client.query(
      `SELECT id, product_name, product_code, generic_name, batch_number, expiry_date,
              quantity, unit_price, cost_price, reorder_level, requires_prescription,
              vat_treatment, pack_size, default_sell_unit, is_active
         FROM inventory
        WHERE pharmacy_id = $1 AND id = ANY($2::uuid[])`,
      [pharmacyId, inventoryIds]
    );
    stockRows = result.rows;
  }

  const stockById = new Map(stockRows.map((row) => [row.id, row]));
  const batchesByProduct = await loadBatches(client, pharmacyId, inventoryIds, reserve);
  const today = todayInGhana();

  for (const item of rawItems) {
    if (item.inventory_id && !stockById.has(item.inventory_id)) {
      throw new PosError('One of the items is no longer in the product list. Refresh and try again.', 409);
    }
    if (!item.inventory_id && !String(item.product_name || '').trim()) {
      throw new PosError('Every item needs a name');
    }
  }

  // Merge repeated lines for the same product so one receipt shows one row.
  const merged = new Map<string, RawLine>();
  for (const item of rawItems) {
    const key = item.inventory_id || `adhoc:${String(item.product_name).trim().toLowerCase()}`;
    const existing = merged.get(key);
    if (existing) {
      existing.quantity = (Number(existing.quantity) || 0) + (Number(item.quantity) || 0);
      existing.discount_amount = round2(
        (Number(existing.discount_amount) || 0) + (Number(item.discount_amount) || 0)
      );
    } else {
      merged.set(key, { ...item });
    }
  }

  const rawLines = [...merged.values()];
  const grossValues = rawLines.map((raw) => {
    const stock = raw.inventory_id ? stockById.get(raw.inventory_id) : null;
    const price = stock ? Number(stock.unit_price) : Number(raw.unit_price ?? 0);
    return round2(Math.floor(Number(raw.quantity) || 0) * (Number.isFinite(price) ? price : 0));
  });

  const shares = distributeDiscount(grossValues, basketDiscount);
  const stockWarnings: Array<{ productName: string; sold: number; available: number }> = [];

  const lines = rawLines.map((raw, index) => {
    const stock = raw.inventory_id ? stockById.get(raw.inventory_id) : null;
    const batches = raw.inventory_id ? batchesByProduct.get(raw.inventory_id) ?? [] : [];
    // No batches at all is not the same as no stock. A product that has never
    // been received against a lot still has its own quantity on the product row,
    // and null sends the caller down that path; an empty plan would refuse the
    // sale on a shelf that is full.
    const plan = stock && batches.length > 0
      ? planFefo(batches, Math.floor(Number(raw.quantity) || 0), { today, allowOversell })
      : null;

    const line = buildLine(raw, stock ?? null, shares[index] || 0, plan);

    if (plan) {
      if (enforceStock && plan.shortfall > 0) {
        throw new PosError(describeFefoShortfall(line.productName, plan, line.quantity), 409);
      }
      // Reported rather than refused. An offline sale goes ahead because the
      // goods have already left the building; the negative count is the honest
      // statement and a stock-take reconciles it.
      if (plan.available < line.quantity) {
        stockWarnings.push({
          productName: line.productName,
          sold: line.quantity,
          available: plan.available,
        });
      }
    }

    return line;
  });

  const tax = computeSaleTax(
    lines.map((line) => ({ lineTotal: line.lineTotal, vatTreatment: line.vatTreatment })),
    {
      pricingMode: taxSettings.pricingMode,
      rates: taxSettings.rates,
      vatRegistered: taxSettings.vatRegistered,
    }
  );

  return { lines, tax, stockById, stockWarnings };
}

// ---------------------------------------------------------------------------
// Receipt numbering
// ---------------------------------------------------------------------------

/**
 * R-YYYYMMDD-0001, unique per pharmacy per day.
 *
 * The caller must already hold `SELECT ... FOR UPDATE` on the pharmacy row:
 * that is what makes the COUNT() below safe from two tills producing the same
 * number. Serialising sales per pharmacy is an acceptable cost for a counter
 * with a handful of registers, and it removes the need for a retry loop on
 * unique violations.
 */
async function nextReceiptNumber(client: PoolClient, pharmacyId: string): Promise<string> {
  const result = await client.query(
    `SELECT COUNT(*)::int AS n FROM sales
      WHERE pharmacy_id = $1 AND created_at >= date_trunc('day', NOW())`,
    [pharmacyId]
  );
  const now = new Date();
  const day = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('');

  return `R-${day}-${String((result.rows[0]?.n || 0) + 1).padStart(4, '0')}`;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

interface LineItemContext {
  pharmacyId: string;
  userId: string;
  /**
   * When the goods actually left the shelf. For a sale queued offline that is
   * the moment the cashier pressed Charge, not the moment the sync ran — which
   * can be the following morning — and the ledger belongs to the first one.
   */
  occurredAt: string | null;
}

/**
 * Writes the receipt lines, then takes the stock off the batches each one drew
 * from and records the movement.
 *
 * The decrement happens here rather than earlier in the transaction because
 * stock_movements points at a sale_item, and the plan it records was already
 * settled against rows locked in priceBasket — nothing can change the batches
 * in between.
 */
async function insertLineItems(
  client: PoolClient,
  saleId: string,
  lines: PosLine[],
  taxLines: any[],
  context: LineItemContext
) {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const computed = taxLines[i];
    const inserted = await client.query(
      `INSERT INTO sale_items
         (sale_id, inventory_id, product_name, product_code, generic_name, batch_number,
          expiry_date, requires_prescription, quantity, sell_unit, unit_price, discount_amount,
          line_total, vat_treatment, taxable_base, vat_amount, nhil_amount, getfund_amount, unit_cost)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       RETURNING id`,
      [
        saleId, line.inventoryId, line.productName, line.productCode, line.genericName,
        line.batchNumber, line.expiryDate, line.requiresPrescription, line.quantity,
        line.sellUnit, line.unitPrice, line.discountAmount, line.lineTotal, line.vatTreatment,
        computed.taxableBase, computed.vat, computed.nhil, computed.getfund, line.unitCost,
      ]
    );

    const plan = line.batchPlan;
    // No plan means the product is not tracked by lot, and its stock was taken
    // off the product row by the caller instead.
    if (!plan || plan.allocations.length === 0 || !line.inventoryId) continue;

    const saleItemId = inserted.rows[0].id as string;

    for (const allocation of plan.allocations) {
      // No `quantity >= ` guard here. The plan was computed from these locked
      // rows, so the only way it can exceed them is a sale recorded offline,
      // which is allowed to go negative on purpose.
      const drawn = await client.query(
        `UPDATE inventory_batches
            SET quantity = quantity - $1, updated_at = NOW()
          WHERE id = $2 AND pharmacy_id = $3
          RETURNING quantity`,
        [allocation.quantity, allocation.batchId, context.pharmacyId]
      );

      if (drawn.rowCount === 0) {
        // Somebody deleted the batch between the plan and here. Recording the
        // sale against a lot that no longer exists would put a lot number on a
        // receipt that a recall could never find.
        throw new PosError(
          `Batch ${allocation.batchNumber} of ${line.productName} was removed while this sale was being recorded. Try again.`,
          409
        );
      }

      // The product's own quantity, batch, expiry and cost are recomputed from
      // the batches by a trigger, so nothing here writes them.
      await client.query(
        `INSERT INTO sale_item_batches
           (sale_item_id, pharmacy_id, batch_id, batch_number, expiry_date,
            inventory_id, quantity, unit_cost)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          saleItemId, context.pharmacyId, allocation.batchId, allocation.batchNumber,
          allocation.expiryDate, line.inventoryId, allocation.quantity, allocation.unitCost,
        ]
      );

      await recordMovement(client, {
        pharmacyId: context.pharmacyId,
        inventoryId: line.inventoryId,
        batchId: allocation.batchId,
        quantityChange: -allocation.quantity,
        quantityAfter: Number(drawn.rows[0]?.quantity ?? 0),
        reason: 'sale',
        saleId,
        saleItemId,
        userId: context.userId,
        occurredAt: context.occurredAt,
      });
    }
  }
}

interface RawPayment {
  method: string;
  amount: number;
  momo_network?: string | null;
  momo_number?: string | null;
  email?: string | null;
  reference?: string | null;
  gateway?: string | null;
  status?: string | null;
  gateway_response?: unknown;
}

async function insertPayment(
  client: PoolClient,
  saleId: string,
  pharmacyId: string,
  receivedBy: string,
  payment: RawPayment
) {
  const method = String(payment.method).toLowerCase();
  if (!ALL_PAYMENT_METHODS.includes(method as any)) {
    throw new PosError(`Unsupported payment method: ${payment.method}`);
  }

  const amount = round2(Number(payment.amount));
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new PosError('Each payment must be a positive amount');
  }

  const status = ['pending', 'authorised', 'completed', 'failed'].includes(String(payment.status))
    ? String(payment.status)
    : 'completed';

  const result = await client.query(
    `INSERT INTO sale_payments
       (sale_id, pharmacy_id, method, amount, status, momo_network, momo_number,
        reference, gateway, gateway_response, received_by, paid_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, CASE WHEN $5 = 'completed' THEN NOW() ELSE NULL END)
     RETURNING *`,
    [
      saleId, pharmacyId, method, amount, status,
      payment.momo_network || null,
      payment.momo_number ? paystack.normalizeGhanaPhone(payment.momo_number) : null,
      payment.reference || null,
      payment.gateway || null,
      JSON.stringify(payment.gateway_response ?? {}),
      receivedBy,
    ]
  );

  return result.rows[0];
}

/**
 * Recomputes amount_paid / change_due from the settled payments and completes
 * the sale once it is paid in full. Never resurrects a voided sale.
 */
async function settleSale(client: PoolClient, saleId: string) {
  const result = await client.query(
    `UPDATE sales s SET
        amount_paid = p.paid,
        change_due = GREATEST(p.paid - s.total_amount, 0),
        status = CASE
                   WHEN s.status = 'pending' AND p.paid >= s.total_amount THEN 'completed'
                   ELSE s.status
                 END,
        completed_at = CASE
                         WHEN s.completed_at IS NULL AND s.status = 'pending'
                              AND p.paid >= s.total_amount THEN NOW()
                         ELSE s.completed_at
                       END
       FROM (SELECT COALESCE(SUM(amount), 0) AS paid
               FROM sale_payments
              WHERE sale_id = $1 AND status IN ('completed', 'authorised')) p
      WHERE s.id = $1
      RETURNING s.*`,
    [saleId]
  );

  return result.rows[0];
}

async function fetchFullSale(saleId: string, pharmacyId: string) {
  const [saleResult, itemResult, paymentResult] = await Promise.all([
    db.query(
      `SELECT s.*,
              p.first_name || ' ' || p.last_name AS patient_name,
              p.phone AS patient_phone,
              p.nhis_number AS patient_nhis_number,
              srv.first_name || ' ' || srv.last_name AS served_by_name,
              apr.first_name || ' ' || apr.last_name AS approved_by_name
         FROM sales s
         LEFT JOIN patients p ON s.patient_id = p.id
         LEFT JOIN users srv ON s.served_by = srv.id
         LEFT JOIN users apr ON s.approved_by = apr.id
        WHERE s.id = $1 AND s.pharmacy_id = $2`,
      [saleId, pharmacyId]
    ),
    db.query('SELECT * FROM sale_items WHERE sale_id = $1 ORDER BY created_at', [saleId]),
    db.query('SELECT * FROM sale_payments WHERE sale_id = $1 ORDER BY created_at', [saleId]),
  ]);

  if (saleResult.rows.length === 0) return null;

  return { ...saleResult.rows[0], items: itemResult.rows, payments: paymentResult.rows };
}

// ---------------------------------------------------------------------------
// Webhook (registered before authenticate — Paystack calls it unauthenticated)
// ---------------------------------------------------------------------------

/**
 * Paystack event webhook. The body arrives as a raw Buffer because server.ts
 * mounts express.raw() on this exact path ahead of express.json(); the HMAC
 * must be computed over the bytes Paystack signed, not over a re-serialised
 * object.
 */
router.post('/webhooks/paystack', async (req: Request, res: Response) => {
  const signature = req.headers['x-paystack-signature'] as string | undefined;

  let event: { event: string; data: any };
  try {
    event = paystack.parseWebhookEvent(req.body as Buffer, signature);
  } catch (error) {
    const status = error instanceof PaystackError ? error.statusCode : 400;
    logger.warn('Rejected Paystack webhook', { status, message: (error as Error).message });
    res.status(status).json({ success: false, message: 'Webhook rejected' });
    return;
  }

  // Acknowledge immediately: Paystack retries anything that is not a fast 200,
  // and a slow database must not cause duplicate deliveries.
  res.json({ success: true, message: 'Webhook received' });

  const { data } = event;
  const reference = data?.reference;

  if (!reference) {
    logger.warn('Paystack webhook without a reference', { event: event.event });
    return;
  }

  try {
    if (event.event === 'charge.success' || event.event === 'payment.success') {
      const paid = await db.transaction(async (client) => {
        const found = await client.query(
          `SELECT id, sale_id, status FROM sale_payments WHERE reference = $1 FOR UPDATE`,
          [reference]
        );
        if (found.rows.length === 0) return null;

        const payment = found.rows[0];
        if (payment.status === 'completed') return null;

        await client.query(
          `UPDATE sale_payments
              SET status = 'completed', paid_at = COALESCE(paid_at, NOW()),
                  gateway = COALESCE(gateway, 'paystack'),
                  gateway_response = $2
            WHERE id = $1`,
          [payment.id, JSON.stringify(data)]
        );

        return settleSale(client, payment.sale_id);
      });

      if (paid) {
        logger.info('Paystack webhook settled a sale', { reference, saleId: paid.id, status: paid.status });
      }
    } else if (event.event === 'charge.failed' || event.event === 'payment.failed') {
      await db.query(
        `UPDATE sale_payments
            SET status = 'failed', gateway_response = $2
          WHERE reference = $1 AND status <> 'completed'`,
        [reference, JSON.stringify(data)]
      );
    }
  } catch (error) {
    logger.error('Failed to process Paystack webhook', { reference, error });
  }
});

// Everything below this point requires a signed-in pharmacy user.
router.use(authenticate);
router.use(auditLog);

// ---------------------------------------------------------------------------
// Till catalogue
// ---------------------------------------------------------------------------

/**
 * Product grid for the till: searchable, ordered so near-expiry stock leads.
 *
 * Also the source for the offline catalogue cache, which is why it pages: a
 * cache truncated at one page would leave the rest of the pharmacy's stock
 * unsellable during an outage, and it would fail silently.
 */
router.get('/products', async (req: Request, res: Response) => {
  try {
    const { search, category, inStock } = req.query;
    const query = buildTillProductQuery({
      pharmacyId: req.user!.pharmacyId,
      search: typeof search === 'string' ? search : null,
      category: typeof category === 'string' ? category : null,
      inStock: inStock === 'true',
      limit: req.query.limit,
      offset: req.query.offset,
    });

    const result = await db.query(query.text, query.params);

    res.json({ success: true, data: result.rows });
  } catch (error) {
    logger.error('Failed to load POS products', error);
    res.status(500).json({ success: false, message: 'Failed to load products' });
  }
});

/** Distinct categories, for the till filter chips. */
router.get('/categories', async (req: Request, res: Response) => {
  try {
    const result = await db.query(
      `SELECT category, COUNT(*)::int AS item_count
         FROM inventory
        WHERE pharmacy_id = $1 AND is_active = true AND category IS NOT NULL AND category <> ''
        GROUP BY category
        ORDER BY category`,
      [req.user!.pharmacyId]
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    logger.error('Failed to load POS categories', error);
    res.status(500).json({ success: false, message: 'Failed to load categories' });
  }
});

/**
 * Everything the checkout screen needs before it starts: gateway state, tax
 * configuration, supported MoMo networks and the payment methods on offer.
 * Reports the truth so the UI can say "gateway not connected" rather than
 * showing MoMo buttons that cannot charge anybody.
 */
router.get('/payment-config', async (req: Request, res: Response) => {
  try {
    const taxSettings = await loadTaxSettings(req.user!.pharmacyId);
    const gateway = paystack.gatewayStatus();

    res.json({
      success: true,
      data: {
        gateway,
        networks: paystack.networks,
        methods: ALL_PAYMENT_METHODS,
        currency: 'GHS',
        tax: {
          vat_registered: taxSettings.vatRegistered,
          pricing_mode: taxSettings.pricingMode,
          rates: taxSettings.rates ?? null,
        },
      },
    });
  } catch (error) {
    logger.error('Failed to load POS payment config', error);
    res.status(500).json({ success: false, message: 'Failed to load payment configuration' });
  }
});

/**
 * Pharmacists and owners who can approve a prescription sale.
 *
 * A cashier selling a prescription-only medicine must name the pharmacist who
 * authorised the dispense, but `GET /pharmacies/staff` is owner/pharmacist
 * only — so without this the prescription gate would be unusable at the till.
 * Deliberately discloses the minimum needed to pick a name: no contact
 * details, no performance data, no cost price.
 */
router.get('/approvers', async (req: Request, res: Response) => {
  try {
    const result = await db.query(
      `SELECT id, first_name, last_name, role
         FROM users
        WHERE pharmacy_id = $1
          AND is_active = true
          AND role IN ('pharmacist', 'pharmacy_owner')
        ORDER BY
          CASE role WHEN 'pharmacist' THEN 0 ELSE 1 END,
          first_name`,
      [req.user!.pharmacyId]
    );

    res.json({
      success: true,
      data: result.rows.map((row: any) => ({
        id: row.id,
        name: `${row.first_name} ${row.last_name}`.trim(),
        role: row.role,
      })),
    });
  } catch (error) {
    logger.error('Failed to load POS approvers', error);
    res.status(500).json({ success: false, message: 'Failed to load approvers' });
  }
});

// ---------------------------------------------------------------------------
// Quote a basket
// ---------------------------------------------------------------------------

/**
 * Prices a basket without creating a sale.
 *
 * The till shows a running total while the cashier scans, but it must never
 * compute that total itself: duplicating the Act 1151 engine in the browser
 * means two implementations that can drift, and a displayed total that is not
 * what gets charged is a dispute waiting to happen. This route runs the exact
 * same `priceBasket` that `POST /sales` uses, so the number on screen and the
 * number on the receipt come from one place.
 *
 * Nothing is written and no stock is reserved.
 */
router.post(
  '/quote',
  validate([
    body('items').isArray({ min: 1 }).withMessage('A basket needs at least one item'),
    body('items.*.quantity').isInt({ min: 1 }).withMessage('Quantity must be at least 1'),
    body('discount_amount').optional().isFloat({ min: 0 }).withMessage('Discount cannot be negative'),
  ]),
  async (req: Request, res: Response) => {
    const pharmacyId = req.user!.pharmacyId;

    try {
      const rawItems = (req.body.items || []) as RawLine[];
      const basketDiscount = round2(Math.max(Number(req.body.discount_amount) || 0, 0));

      const quote = await db.transaction(async (client) => {
        const taxSettings = await loadTaxSettings(pharmacyId, client);
        const { lines, tax, stockById } = await priceBasket(
          client,
          pharmacyId,
          rawItems,
          basketDiscount,
          taxSettings,
          // Nothing is locked and nothing is refused. The quote has to be able
          // to say what FEFO would do without holding stock hostage while the
          // cashier is still scanning.
          { reserve: false, allowOversell: false, enforceStock: false }
        );

        return {
          pricing_mode: taxSettings.pricingMode,
          vat_registered: taxSettings.vatRegistered,
          rate_snapshot: JSON.parse(taxSettings.snapshot),
          lines: lines.map((line, index) => {
            const computed = tax.lines[index];
            const stock = line.inventoryId ? stockById.get(line.inventoryId) : null;
            return {
              inventory_id: line.inventoryId,
              product_name: line.productName,
              generic_name: line.genericName,
              batch_number: line.batchNumber,
              expiry_date: line.expiryDate,
              requires_prescription: line.requiresPrescription,
              quantity: line.quantity,
              sell_unit: line.sellUnit,
              unit_price: line.unitPrice,
              discount_amount: line.discountAmount,
              line_total: line.lineTotal,
              vat_treatment: line.vatTreatment,
              taxable_base: computed?.taxableBase ?? 0,
              vat_amount: computed?.vat ?? 0,
              nhil_amount: computed?.nhil ?? 0,
              getfund_amount: computed?.getfund ?? 0,
              // Flagged rather than blocked: the cashier may legitimately be
              // selling the last pack, and the sale route enforces the real
              // limit with a conditional UPDATE.
              quantity_available: stock ? Number(stock.quantity) : null,
              oversold: stock ? line.quantity > Number(stock.quantity) : false,
              // What FEFO would actually take, so the till can show the lots
              // behind the total rather than quoting a number the sale then
              // refuses to honour. Empty for a product not tracked by lot.
              batches: (line.batchPlan?.allocations ?? []).map((allocation) => ({
                batch_number: allocation.batchNumber,
                expiry_date: allocation.expiryDate,
                quantity: allocation.quantity,
              })),
              sellable_available: line.batchPlan ? line.batchPlan.available : null,
              // The reason, when there is one. "Out of stock" and "every batch
              // expired" need different things done about them.
              stock_note:
                line.batchPlan && line.batchPlan.shortfall > 0
                  ? describeFefoShortfall(line.productName, line.batchPlan, line.quantity)
                  : null,
            };
          }),
          summary: {
            subtotal: tax.subtotal,
            discount_amount: basketDiscount,
            taxable_base: tax.taxableBase,
            exempt_amount: tax.exemptAmount,
            vat_amount: tax.vat,
            nhil_amount: tax.nhil,
            getfund_amount: tax.getfund,
            total_tax: tax.totalTax,
            total_amount: tax.grandTotal,
          },
        };
      });

      res.json({ success: true, data: quote });
    } catch (error) {
      if (error instanceof PosError) {
        res.status(error.statusCode).json({ success: false, message: error.message });
        return;
      }
      logger.error('Failed to quote basket', error);
      res.status(500).json({ success: false, message: 'Failed to price the basket' });
    }
  }
);

// ---------------------------------------------------------------------------
// Create a sale
// ---------------------------------------------------------------------------

router.post(
  '/sales',
  validate([
    body('items').isArray({ min: 1 }).withMessage('A sale needs at least one item'),
    body('items.*.quantity').isInt({ min: 1 }).withMessage('Quantity must be at least 1'),
    body('payments').optional().isArray().withMessage('Payments must be a list'),
    body('payments.*.method')
      .isIn(ALL_PAYMENT_METHODS)
      .withMessage(`Payment method must be one of: ${ALL_PAYMENT_METHODS.join(', ')}`),
    body('payments.*.amount').isFloat({ min: 0.01 }).withMessage('Payment amount must be positive'),
    body('patient_id').optional({ nullable: true }).isUUID().withMessage('patient_id must be a valid id'),
    body('client_sale_id').optional({ nullable: true }).isUUID().withMessage('client_sale_id must be a UUID'),
    // Provenance for a sale the till rang up while the network was down. None
    // of these change what is charged — they record when it really happened
    // and what the cashier actually took, so a later disagreement is visible.
    body('recorded_offline').optional().isBoolean().withMessage('recorded_offline must be true or false'),
    body('client_recorded_at')
      .optional({ nullable: true })
      .isISO8601()
      .withMessage('client_recorded_at must be an ISO 8601 timestamp'),
    body('client_quoted_total')
      .optional({ nullable: true })
      .isFloat({ min: 0 })
      .withMessage('client_quoted_total must be zero or more'),
  ]),
  async (req: Request, res: Response) => {
    const pharmacyId = req.user!.pharmacyId;
    const userId = req.user!.userId;

    const {
      items = [],
      payments = [],
      discount_amount: rawDiscount = 0,
      discount_reason: discountReason = null,
      note = null,
      patient_id: patientId = null,
      customer_name: customerName = null,
      customer_phone: customerPhone = null,
      prescription_id: prescriptionId = null,
      nhis_claim_id: nhisClaimId = null,
      client_sale_id: clientSaleId = null,
      approved_by: approvedBy = null,
      recorded_offline: rawRecordedOffline = false,
      client_recorded_at: clientRecordedAt = null,
      client_quoted_total: rawClientQuotedTotal = null,
    } = req.body;

    // express-validator's isBoolean() also lets the strings 'true'/'false'
    // through, and a queued request may have been serialised either way.
    const recordedOffline = rawRecordedOffline === true || rawRecordedOffline === 'true';
    const clientQuotedTotal =
      rawClientQuotedTotal === null || rawClientQuotedTotal === undefined || rawClientQuotedTotal === ''
        ? null
        : round2(Number(rawClientQuotedTotal));

    // Digital payments are handled after the sale row exists, so they are
    // pulled out here and pushed through Paystack in phase two.
    const cashPayments: RawPayment[] = [];
    const gatewayPayments: RawPayment[] = [];
    for (const payment of payments as RawPayment[]) {
      const method = String(payment.method || '').toLowerCase();
      if (GATEWAY_METHODS.includes(method)) gatewayPayments.push({ ...payment, method });
      else cashPayments.push({ ...payment, method });
    }

    // Rejecting a bad MoMo number here, before anything is committed, avoids
    // creating a pending sale with stock already deducted.
    if (paystack.isGatewayConfigured()) {
      for (const payment of gatewayPayments) {
        if (payment.method !== 'momo') continue;
        if (!paystack.normalizeGhanaPhone(payment.momo_number)) {
          res.status(400).json({
            success: false,
            message: 'Enter a valid Ghana mobile money number, e.g. 0241234567',
          });
          return;
        }
        if (!paystack.resolveProvider(payment.momo_network, payment.momo_number)) {
          res.status(400).json({
            success: false,
            message: "Select the customer's mobile money network",
          });
          return;
        }
      }
    }

    try {
      const basketDiscount = Math.max(round2(Number(rawDiscount) || 0), 0);

      const created = await db.transaction(async (client) => {
        // Serialise tills for this pharmacy so receipt numbers cannot collide.
        const pharmacyResult = await client.query(
          'SELECT id FROM pharmacies WHERE id = $1 AND is_active = true FOR UPDATE',
          [pharmacyId]
        );
        if (pharmacyResult.rows.length === 0) {
          throw new PosError('Pharmacy account is not active', 403);
        }

        // Offline replay protection: the same client_sale_id returns the
        // original sale instead of creating a duplicate.
        if (clientSaleId) {
          const existing = await client.query(
            'SELECT id FROM sales WHERE pharmacy_id = $1 AND client_sale_id = $2',
            [pharmacyId, clientSaleId]
          );
          if (existing.rows.length > 0) {
            return {
              saleId: existing.rows[0].id as string,
              duplicate: true,
              lines: [] as PosLine[],
              stockWarnings: [] as Array<{ productName: string; sold: number; available: number }>,
            };
          }
        }

        if (patientId) {
          const patient = await client.query(
            'SELECT id FROM patients WHERE id = $1 AND pharmacy_id = $2',
            [patientId, pharmacyId]
          );
          if (patient.rows.length === 0) throw new PosError('That patient does not belong to this pharmacy', 404);
        }

        const taxSettings = await loadTaxSettings(pharmacyId, client);
        const { lines, tax, stockWarnings } = await priceBasket(
          client,
          pharmacyId,
          items as RawLine[],
          basketDiscount,
          taxSettings,
          // Batches are locked for the rest of the transaction, and an offline
          // sale is planned to cover the whole quantity because the goods have
          // already gone — so it is warned about rather than refused.
          { reserve: true, allowOversell: recordedOffline, enforceStock: !recordedOffline }
        );

        if (lines.length === 0) throw new PosError('A sale needs at least one item');

        const totalAmount = tax.grandTotal;
        if (totalAmount <= 0) throw new PosError('The sale total must be greater than zero');

        // A basket containing prescription-only medicine needs a pharmacist.
        const hasPrescriptionItem = lines.some((line) => line.requiresPrescription);
        let approverId: string | null = null;
        if (hasPrescriptionItem) {
          const isPharmacist = [UserRole.PHARMACIST, UserRole.PHARMACY_OWNER, UserRole.SUPER_ADMIN]
            .includes(req.user!.role);

          if (isPharmacist) {
            approverId = userId;
          } else if (approvedBy) {
            const approver = await client.query(
              `SELECT id FROM users
                WHERE id = $1 AND pharmacy_id = $2 AND is_active = true
                  AND role IN ('pharmacist', 'pharmacy_owner')`,
              [approvedBy, pharmacyId]
            );
            if (approver.rows.length === 0) {
              throw new PosError('Prescription items must be approved by a pharmacist', 403);
            }
            approverId = approver.rows[0].id;
          } else {
            throw new PosError(
              'This basket contains prescription-only medicine. A pharmacist must approve the sale.',
              403
            );
          }
        }

        // Stock deduction before the insert: a conditional UPDATE means the
        // last pack cannot be sold twice.
        //
        // A sale recorded offline is exempt from that guard. The goods have
        // already physically left the shelf — possibly from a second till that
        // was also disconnected, possibly against a stock count that had
        // drifted. Refusing to record it would lose a real sale and leave the
        // counter claiming stock that is not there. Instead the quantity is
        // allowed to go negative and the line is reported back, because a
        // negative count is the honest statement: "we sold more than we thought
        // we had", which is what a stock-take then reconciles.
        //
        // Only for products that are not tracked by lot. A batched line was
        // already planned against locked rows in priceBasket and is taken off
        // its batches by insertLineItems, which needs the sale_item ids to point
        // the ledger at. Writing its quantity here as well would deduct it
        // twice, and the trigger would overwrite the result anyway.
        for (const line of lines) {
          if (!line.inventoryId) continue;
          if (line.batchPlan) continue;

          if (recordedOffline) {
            const before = await client.query('SELECT quantity FROM inventory WHERE id = $1', [
              line.inventoryId,
            ]);
            const available = Number(before.rows[0]?.quantity ?? 0);
            await client.query(
              `UPDATE inventory SET quantity = quantity - $1, updated_at = NOW() WHERE id = $2`,
              [line.quantity, line.inventoryId]
            );
            if (available < line.quantity) {
              stockWarnings.push({ productName: line.productName, sold: line.quantity, available });
            }
            continue;
          }

          const updated = await client.query(
            `UPDATE inventory
                SET quantity = quantity - $1, updated_at = NOW()
              WHERE id = $2 AND pharmacy_id = $3 AND quantity >= $1`,
            [line.quantity, line.inventoryId, pharmacyId]
          );

          if (updated.rowCount === 0) {
            const current = await client.query('SELECT quantity FROM inventory WHERE id = $1', [
              line.inventoryId,
            ]);
            const available = current.rows[0]?.quantity ?? 0;
            throw new PosError(
              `Not enough stock of ${line.productName}: ${available} available, ${line.quantity} requested`,
              409
            );
          }
        }

        const receiptNumber = await nextReceiptNumber(client, pharmacyId);

        const sumOf = (list: RawPayment[]) =>
          round2(list.reduce((total, payment) => total + (Number(payment.amount) || 0), 0));
        const cashPaid = sumOf(cashPayments);
        const intended = round2(cashPaid + sumOf(gatewayPayments));

        if (intended < totalAmount) {
          const short = round2(totalAmount - intended);
          throw new PosError(
            `Payment is GHS ${short.toFixed(2)} short of the GHS ${totalAmount.toFixed(2)} total`,
            400
          );
        }

        // Change can only come out of a single cash tender. A MoMo wallet or a
        // card cannot hand back coins, and an oversized bank transfer is almost
        // always a keying mistake worth stopping at the counter.
        if (intended > totalAmount) {
          const singleCashTender =
            gatewayPayments.length === 0 &&
            cashPayments.length === 1 &&
            cashPayments[0].method === 'cash';
          if (!singleCashTender) {
            throw new PosError(
              'Only a single cash tender may exceed the total, so change can be given back',
              400
            );
          }
        }

        // Completed immediately only when cash-like payments already cover it;
        // gateway payments settle asynchronously in phase two.
        const settledByCash = cashPaid >= totalAmount && gatewayPayments.length === 0;

        const saleResult = await client.query(
          `INSERT INTO sales
             (pharmacy_id, receipt_number, patient_id, customer_name, customer_phone,
              served_by, approved_by, subtotal, discount_amount, discount_reason,
              taxable_base, exempt_amount, vat_amount, nhil_amount, getfund_amount,
              total_amount, pricing_mode, tax_rates, status, note,
              prescription_id, nhis_claim_id, client_sale_id,
              recorded_offline, client_recorded_at, client_quoted_total, completed_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,
                   $24,$25,$26,
                   CASE WHEN $19 = 'completed' THEN COALESCE($25, NOW()) ELSE NULL END)
           RETURNING id`,
          [
            pharmacyId, receiptNumber, patientId, customerName, customerPhone,
            userId, approverId,
            tax.subtotal, basketDiscount, discountReason,
            tax.taxableBase, tax.exemptAmount, tax.vat, tax.nhil, tax.getfund,
            totalAmount, taxSettings.pricingMode, taxSettings.snapshot,
            settledByCash ? 'completed' : 'pending', note,
            prescriptionId, nhisClaimId, clientSaleId,
            recordedOffline, clientRecordedAt, clientQuotedTotal,
          ]
        );

        const saleId = saleResult.rows[0].id as string;
        await insertLineItems(client, saleId, lines, tax.lines, {
          pharmacyId,
          userId,
          occurredAt: clientRecordedAt,
        });

        for (const payment of cashPayments) {
          await insertPayment(client, saleId, pharmacyId, userId, payment);
        }

        if (recordedOffline) {
          // A digital payment taken while the till was disconnected cannot be
          // put through Paystack now: the customer has gone. In Ghana MoMo
          // rides the phone network rather than the internet, so the money may
          // genuinely have moved — but nothing here can confirm it. Record it
          // as the till asserts it, marked unverified, and let the pharmacy
          // reconcile against the network statement.
          for (const payment of gatewayPayments) {
            await insertPayment(client, saleId, pharmacyId, userId, {
              ...payment,
              gateway: null,
              status: 'completed',
              gateway_response: {
                recorded_offline: true,
                verified_by_gateway: false,
                note: 'Taken while the till was offline; not confirmed with the payment provider.',
              },
            });
          }
        }

        // amount_paid and change_due are derived from the payment rows that
        // were actually written, never taken from the request.
        const settled = await settleSale(client, saleId);

        return {
          saleId,
          duplicate: false,
          lines,
          totalAmount,
          receiptNumber,
          settled,
          stockWarnings,
        };
      });

      // The stock left the shelf when that committed, so this is the moment an
      // out-of-stock or low-stock alert becomes true. After the commit rather
      // than inside it: a notification that would not insert must not take a
      // finished sale with it. A duplicate sync carries no lines and is skipped.
      await refreshStockAlertsFor(
        db,
        pharmacyId,
        created.lines.map((line) => line.inventoryId),
        'pos.sale'
      );

      // Phase two: gateway payments, deliberately outside the transaction so a
      // slow Paystack call never holds the pharmacy row lock.
      const gatewayResults: Array<{
        method: string;
        amount: number;
        charge?: ChargeResult;
        error?: string;
      }> = [];

      if (!created.duplicate && !recordedOffline) {
        for (const payment of gatewayPayments) {
          const amount = round2(Number(payment.amount) || 0);
          try {
            const charge = await runGatewayCharge(created.saleId, payment, pharmacyId, userId);
            gatewayResults.push({ method: payment.method, amount, charge });
          } catch (error) {
            // The sale row is already committed with stock deducted, so the
            // failure is reported against it rather than losing the sale. The
            // cashier can retry the payment or void it.
            const message =
              error instanceof PaystackError
                ? error.message
                : 'The payment gateway did not respond. Take the payment another way or void the sale.';
            logger.error('Gateway charge failed', { saleId: created.saleId, message });
            gatewayResults.push({ method: payment.method, amount, error: message });
          }
        }
        if (gatewayPayments.length > 0) await settleSaleOutside(created.saleId);
      }

      const sale = await fetchFullSale(created.saleId, pharmacyId);
      if (!sale) {
        res.status(500).json({ success: false, message: 'Sale was created but could not be read back' });
        return;
      }

      // The first unresolved gateway outcome is what the cashier must act on:
      // either "approve the prompt on your phone", or why the charge failed.
      const firstGatewayIssue = gatewayResults.find(
        (result) => result.error || result.charge?.awaitingCustomerApproval
      );

      // The server total is authoritative. If the till charged something else
      // while it was disconnected, that gap has to be visible to the pharmacy
      // rather than absorbed silently — it means a customer paid a figure that
      // the VAT return will not agree with.
      const serverTotal = round2(Number(sale.total_amount));
      const quotedDifference =
        clientQuotedTotal === null ? null : round2(clientQuotedTotal - serverTotal);
      const totalMismatch = quotedDifference !== null && Math.abs(quotedDifference) >= 0.01;

      if (totalMismatch) {
        logger.warn('Offline sale synced with a total that differs from the server figure', {
          pharmacyId,
          saleId: created.saleId,
          receiptNumber: sale.receipt_number,
          clientQuotedTotal,
          serverTotal,
          difference: quotedDifference,
        });
      }
      if (created.stockWarnings.length > 0) {
        logger.warn('Offline sale drove stock below zero', {
          pharmacyId,
          saleId: created.saleId,
          receiptNumber: sale.receipt_number,
          items: created.stockWarnings,
        });
      }

      res.status(created.duplicate ? 200 : 201).json({
        success: true,
        message: created.duplicate
          ? 'This sale was already recorded (duplicate sync ignored)'
          : firstGatewayIssue
            ? firstGatewayIssue.error || firstGatewayIssue.charge?.message || 'Payment incomplete'
            : sale.status === 'completed'
              ? 'Sale completed'
              : 'Sale saved as pending — awaiting payment',
        data: sale,
        duplicate: created.duplicate,
        offline: recordedOffline
          ? {
              recordedOffline: true,
              quotedTotal: clientQuotedTotal,
              difference: quotedDifference,
              totalMismatch,
              stockWarnings: created.stockWarnings,
              unverifiedPayments: gatewayPayments.map((payment) => ({
                method: payment.method,
                amount: round2(Number(payment.amount) || 0),
              })),
            }
          : null,
        gateway: gatewayResults.map((result) => ({
          method: result.method,
          amount: result.amount,
          mode: result.charge?.mode ?? null,
          outcome: result.charge?.outcome ?? 'failed',
          reference: result.charge?.reference ?? null,
          message: result.error || result.charge?.message || 'Payment was not completed',
          awaitingCustomerApproval: result.charge?.awaitingCustomerApproval ?? false,
          authorizationUrl: result.charge?.authorizationUrl ?? null,
        })),
      });
    } catch (error) {
      if (error instanceof PosError) {
        res.status(error.statusCode).json({ success: false, message: error.message });
        return;
      }
      if (error instanceof PaystackError) {
        res.status(error.statusCode).json({ success: false, message: error.message });
        return;
      }
      logger.error('Failed to create sale', error);
      res.status(500).json({ success: false, message: 'Failed to record the sale' });
    }
  }
);

/** Routes a digital payment to the right Paystack call, or to manual mode. */
async function runGatewayCharge(
  saleId: string,
  payment: RawPayment,
  pharmacyId: string,
  userId: string
): Promise<ChargeResult> {
  const amount = round2(Number(payment.amount) || 0);
  const reference = payment.reference || paystack.generateReference(payment.method);

  let charge: ChargeResult;
  if (payment.method === 'momo') {
    charge = await paystack.chargeMobileMoney({
      amount,
      phone: String(payment.momo_number || ''),
      provider: payment.momo_network,
      reference,
      metadata: { sale_id: saleId, pharmacy_id: pharmacyId },
    });
  } else {
    charge = await paystack.initializeCheckout({
      amount,
      email: payment.email,
      reference,
      metadata: { sale_id: saleId, pharmacy_id: pharmacyId },
    });
  }

  await db.transaction(async (client) => {
    await insertPayment(client, saleId, pharmacyId, userId, {
      ...payment,
      amount,
      reference: charge.reference,
      gateway: charge.mode === 'gateway' ? 'paystack' : null,
      status:
        charge.mode === 'manual'
          ? 'completed'
          : charge.outcome === 'success'
            ? 'completed'
            : charge.outcome === 'failed'
              ? 'failed'
              : 'pending',
      momo_number: payment.momo_number
        ? paystack.normalizeGhanaPhone(payment.momo_number)
        : null,
      gateway_response: charge.gatewayResponse ?? {},
    });
  });

  return charge;
}

async function settleSaleOutside(saleId: string) {
  await db.transaction(async (client) => settleSale(client, saleId));
}

// ---------------------------------------------------------------------------
// Sale history and receipts
// ---------------------------------------------------------------------------

router.get('/sales', async (req: Request, res: Response) => {
  try {
    const pharmacyId = req.user!.pharmacyId;
    const page = Math.max(parseInt(req.query.page as string, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit as string, 10) || 25, 1), 100);
    const offset = (page - 1) * limit;
    const { status, from, to, search, method, servedBy, offline } = req.query;

    let whereClause = 'WHERE s.pharmacy_id = $1';
    const params: any[] = [pharmacyId];
    let idx = 2;

    if (status) {
      whereClause += ` AND s.status = $${idx}`;
      params.push(status);
      idx++;
    }
    if (from) {
      whereClause += ` AND ${saleTime('s')} >= $${idx}`;
      params.push(from);
      idx++;
    }
    if (to) {
      whereClause += ` AND ${saleTime('s')} < ($${idx}::timestamptz + INTERVAL '1 day')`;
      params.push(to);
      idx++;
    }
    if (offline) {
      // Lets the till history be filtered to sales that arrived from a queue,
      // which are the ones a pharmacist needs to reconcile against the drawer.
      whereClause += ` AND s.recorded_offline = true`;
    }
    if (servedBy) {
      whereClause += ` AND s.served_by = $${idx}`;
      params.push(servedBy);
      idx++;
    }
    if (method) {
      whereClause += ` AND EXISTS (SELECT 1 FROM sale_payments sp
                     WHERE sp.sale_id = s.id AND sp.method = $${idx})`;
      params.push(method);
      idx++;
    }
    if (search) {
      whereClause += ` AND (s.receipt_number ILIKE $${idx}
                             OR s.customer_name ILIKE $${idx}
                             OR s.customer_phone ILIKE $${idx}
                             OR p.first_name ILIKE $${idx}
                             OR p.last_name ILIKE $${idx})`;
      params.push(`%${search}%`);
      idx++;
    }

    const patientJoin = search ? 'LEFT JOIN patients p ON s.patient_id = p.id' : '';

    const [countResult, dataResult, totalsResult] = await Promise.all([
      db.query(`SELECT COUNT(*)::int AS total FROM sales s ${patientJoin} ${whereClause}`, params),
      db.query(
        `SELECT s.id, s.receipt_number, s.status, s.subtotal, s.discount_amount, s.total_amount,
                s.amount_paid, s.change_due, s.vat_amount, s.nhil_amount, s.getfund_amount,
                s.customer_name, s.created_at, s.completed_at,
                s.recorded_offline, s.client_recorded_at, s.client_quoted_total,
                ${saleTime('s')} AS sale_time,
                p.first_name || ' ' || p.last_name AS patient_name,
                srv.first_name || ' ' || srv.last_name AS served_by_name,
                (SELECT COUNT(*)::int FROM sale_items si WHERE si.sale_id = s.id) AS item_count,
                COALESCE(
                  (SELECT string_agg(DISTINCT sp.method::text, ', ')
                     FROM sale_payments sp WHERE sp.sale_id = s.id), '') AS methods
           FROM sales s
           LEFT JOIN patients p ON s.patient_id = p.id
           LEFT JOIN users srv ON s.served_by = srv.id
           ${whereClause}
          ORDER BY ${saleTime('s')} DESC
          LIMIT $${idx} OFFSET $${idx + 1}`,
        [...params, limit, offset]
      ),
      db.query(
        `SELECT COUNT(*)::int AS sale_count,
                COALESCE(SUM(total_amount), 0)::numeric AS revenue,
                COALESCE(SUM(vat_amount + nhil_amount + getfund_amount), 0)::numeric AS tax
           FROM sales s ${patientJoin} ${whereClause} AND s.status = 'completed'`,
        params
      ),
    ]);

    const total = countResult.rows[0].total;
    res.json({
      success: true,
      data: dataResult.rows,
      summary: totalsResult.rows[0],
      pagination: { total, page, limit, totalPages: Math.max(Math.ceil(total / limit), 1) },
    });
  } catch (error) {
    logger.error('Failed to list sales', error);
    res.status(500).json({ success: false, message: 'Failed to load sales' });
  }
});

router.get(
  '/sales/:id',
  validate([param('id').isUUID().withMessage('A valid sale id is required')]),
  async (req: Request, res: Response) => {
    try {
      const sale = await fetchFullSale(req.params.id, req.user!.pharmacyId);
      if (!sale) {
        res.status(404).json({ success: false, message: 'Sale not found' });
        return;
      }
      res.json({ success: true, data: sale });
    } catch (error) {
      logger.error('Failed to load sale', error);
      res.status(500).json({ success: false, message: 'Failed to load the sale' });
    }
  }
);

// ---------------------------------------------------------------------------
// Add a payment to an existing sale (part payment, settling credit)
// ---------------------------------------------------------------------------

router.post(
  '/sales/:id/payments',
  authorize(UserRole.PHARMACY_OWNER, UserRole.PHARMACIST, UserRole.STAFF),
  validate([
    param('id').isUUID().withMessage('A valid sale id is required'),
    body('method')
      .isIn(ALL_PAYMENT_METHODS)
      .withMessage(`Payment method must be one of: ${ALL_PAYMENT_METHODS.join(', ')}`),
    body('amount').isFloat({ min: 0.01 }).withMessage('Payment amount must be positive'),
  ]),
  async (req: Request, res: Response) => {
    const pharmacyId = req.user!.pharmacyId;
    const userId = req.user!.userId;
    const saleId = req.params.id;
    const method = String(req.body.method).toLowerCase();

    try {
      const existing = await db.query(
        `SELECT s.id, s.status, s.total_amount,
                COALESCE((SELECT SUM(sp.amount) FROM sale_payments sp
                           WHERE sp.sale_id = s.id
                             AND sp.status IN ('completed', 'authorised', 'pending')), 0)::numeric AS committed
           FROM sales s
          WHERE s.id = $1 AND s.pharmacy_id = $2`,
        [saleId, pharmacyId]
      );
      if (existing.rows.length === 0) {
        res.status(404).json({ success: false, message: 'Sale not found' });
        return;
      }
      if (existing.rows[0].status === 'voided') {
        res.status(409).json({ success: false, message: 'A voided sale cannot take a payment' });
        return;
      }
      if (existing.rows[0].status === 'completed') {
        res.status(409).json({ success: false, message: 'This sale is already fully paid' });
        return;
      }

      const amount = round2(Number(req.body.amount));

      // In-flight MoMo prompts count as committed, so a second charge cannot be
      // raised against a customer who is still looking at the first one.
      const outstanding = round2(Number(existing.rows[0].total_amount) - Number(existing.rows[0].committed));
      if (amount > outstanding) {
        throw new PosError(
          `Only GHS ${outstanding.toFixed(2)} is still owed on this sale`,
          400
        );
      }

      if (method === 'momo' && paystack.isGatewayConfigured()) {
        if (!paystack.normalizeGhanaPhone(req.body.momo_number)) {
          throw new PosError('Enter a valid Ghana mobile money number, e.g. 0241234567');
        }
        if (!paystack.resolveProvider(req.body.momo_network, req.body.momo_number)) {
          throw new PosError("Select the customer's mobile money network");
        }
      }

      let charge: ChargeResult | null = null;

      if (GATEWAY_METHODS.includes(method)) {
        charge = await runGatewayCharge(
          saleId,
          {
            method,
            amount,
            momo_network: req.body.momo_network || null,
            momo_number: req.body.momo_number || null,
            email: req.body.email || null,
          },
          pharmacyId,
          userId
        );
      } else {
        await db.transaction(async (client) => {
          await insertPayment(client, saleId, pharmacyId, userId, {
            method,
            amount,
            reference: req.body.reference || null,
            momo_network: req.body.momo_network || null,
            momo_number: req.body.momo_number || null,
          });
        });
      }

      await settleSaleOutside(saleId);
      const sale = await fetchFullSale(saleId, pharmacyId);

      res.json({
        success: true,
        message: charge?.awaitingCustomerApproval
          ? charge.message
          : sale?.status === 'completed'
            ? 'Payment recorded — sale completed'
            : 'Payment recorded',
        data: sale,
        ...(charge ? { gateway: { mode: charge.mode, outcome: charge.outcome, reference: charge.reference, authorizationUrl: charge.authorizationUrl } } : {}),
      });
    } catch (error) {
      if (error instanceof PosError || error instanceof PaystackError) {
        res.status(error.statusCode).json({ success: false, message: error.message });
        return;
      }
      logger.error('Failed to add sale payment', error);
      res.status(500).json({ success: false, message: 'Failed to record the payment' });
    }
  }
);

/**
 * Asks Paystack for the definitive state of a digital payment and settles the
 * sale if it cleared. This is what the "Check payment" button on a pending MoMo
 * sale calls — the charge response alone is never trusted.
 */
router.post(
  '/payments/:reference/verify',
  validate([param('reference').trim().notEmpty().withMessage('A payment reference is required')]),
  async (req: Request, res: Response) => {
    const pharmacyId = req.user!.pharmacyId;
    const { reference } = req.params;

    try {
      const found = await db.query(
        `SELECT sp.id, sp.sale_id, sp.status, sp.amount
           FROM sale_payments sp
          WHERE sp.reference = $1 AND sp.pharmacy_id = $2`,
        [reference, pharmacyId]
      );
      if (found.rows.length === 0) {
        res.status(404).json({ success: false, message: 'No payment with that reference' });
        return;
      }

      if (!paystack.isGatewayConfigured()) {
        res.status(409).json({
          success: false,
          message: 'No payment gateway is connected, so this payment cannot be verified automatically. Confirm it manually with the customer.',
        });
        return;
      }

      const verification = await paystack.verifyTransaction(reference);
      const payment = found.rows[0];

      if (verification.outcome === 'success') {
        await db.transaction(async (client) => {
          await client.query(
            `UPDATE sale_payments
                SET status = 'completed', paid_at = COALESCE(paid_at, NOW()),
                    gateway = COALESCE(gateway, 'paystack'), gateway_response = $2
              WHERE id = $1`,
            [payment.id, JSON.stringify(verification.gatewayResponse ?? {})]
          );
          await settleSale(client, payment.sale_id);
        });
      } else if (verification.outcome === 'failed') {
        await db.query(
          `UPDATE sale_payments SET status = 'failed', gateway_response = $2
            WHERE id = $1 AND status <> 'completed'`,
          [payment.id, JSON.stringify(verification.gatewayResponse ?? {})]
        );
      }

      const sale = await fetchFullSale(payment.sale_id, pharmacyId);

      res.json({
        success: true,
        message:
          verification.outcome === 'success'
            ? 'Payment confirmed'
            : verification.outcome === 'pending'
              ? 'Still waiting for the customer to approve the payment'
              : 'Payment was not completed',
        data: { payment_status: verification.outcome, amount: verification.amount, sale },
      });
    } catch (error) {
      if (error instanceof PaystackError) {
        res.status(error.statusCode).json({ success: false, message: error.message });
        return;
      }
      logger.error('Failed to verify payment', error);
      res.status(500).json({ success: false, message: 'Failed to verify the payment' });
    }
  }
);

// ---------------------------------------------------------------------------
// Void
// ---------------------------------------------------------------------------

router.post(
  '/sales/:id/void',
  authorize(UserRole.PHARMACY_OWNER, UserRole.PHARMACIST),
  validate([
    param('id').isUUID().withMessage('A valid sale id is required'),
    body('reason').trim().notEmpty().withMessage('A reason is required to void a sale'),
  ]),
  async (req: Request, res: Response) => {
    const pharmacyId = req.user!.pharmacyId;
    const userId = req.user!.userId;
    const reason = String(req.body.reason).trim();

    try {
      /** The products whose stock went back, collected as the lines are restored. */
      const affected: string[] = [];

      const sale = await db.transaction(async (client) => {
        const locked = await client.query(
          `SELECT id, status FROM sales WHERE id = $1 AND pharmacy_id = $2 FOR UPDATE`,
          [req.params.id, pharmacyId]
        );
        if (locked.rows.length === 0) throw new PosError('Sale not found', 404);
        if (locked.rows[0].status === 'voided') {
          throw new PosError('This sale has already been voided', 409);
        }

        // Put the stock back where it came from.
        //
        // This used to add the units back onto the product row, which with
        // batches in place does two wrong things at once: the derived-stock
        // trigger recomputes that row from the batches a moment later, so the
        // stock silently disappears, and the product is credited for units that
        // came out of a lot it never held. sale_item_batches says which lots
        // each line drew from, so that is what gets credited.
        //
        // Per line rather than per sale, because a basket can mix a product
        // tracked by lot with one that is not and each goes back its own way.
        const soldLines = await client.query(
          `SELECT id, inventory_id, quantity
             FROM sale_items
            WHERE sale_id = $1 AND inventory_id IS NOT NULL`,
          [req.params.id]
        );
        const batchesAvailable = await hasBatchTables(client);

        for (const sold of soldLines.rows) {
          affected.push(sold.inventory_id);

          const drawn = batchesAvailable
            ? await client.query(
                `SELECT batch_id, quantity FROM sale_item_batches WHERE sale_item_id = $1`,
                [sold.id]
              )
            : { rows: [] as Array<{ batch_id: string | null; quantity: number }> };

          if (drawn.rows.length === 0) {
            // A line recorded before batch tracking existed, or for a product
            // that is not tracked by lot. Back onto the product row, as before.
            await client.query(
              `UPDATE inventory
                  SET quantity = quantity + $1, updated_at = NOW()
                WHERE id = $2 AND pharmacy_id = $3`,
              [sold.quantity, sold.inventory_id, pharmacyId]
            );
            continue;
          }

          for (const entry of drawn.rows) {
            // A null batch_id means the lot was deleted since the sale. The
            // junction row keeps the number for the record, but there is nothing
            // left to credit.
            if (!entry.batch_id) continue;

            const restored = await client.query(
              `UPDATE inventory_batches
                  SET quantity = quantity + $1, updated_at = NOW()
                WHERE id = $2 AND pharmacy_id = $3
                RETURNING quantity`,
              [entry.quantity, entry.batch_id, pharmacyId]
            );
            if (restored.rowCount === 0) continue;

            // The sale is undone but the fact that it happened is not: the
            // customer's units still came out of this lot, so the junction rows
            // stay and the reversal goes to the ledger instead.
            await recordMovement(client, {
              pharmacyId,
              inventoryId: sold.inventory_id,
              batchId: entry.batch_id,
              quantityChange: Number(entry.quantity),
              quantityAfter: Number(restored.rows[0].quantity),
              reason: 'sale_void',
              note: reason,
              saleId: req.params.id,
              saleItemId: sold.id,
              userId,
            });
          }
        }

        await client.query(
          `UPDATE sale_payments SET status = 'refunded'
            WHERE sale_id = $1 AND status = 'completed'`,
          [req.params.id]
        );

        await client.query(
          `UPDATE sales
              SET status = 'voided', voided_at = NOW(), void_reason = $2, amount_paid = 0, change_due = 0
            WHERE id = $1`,
          [req.params.id, reason]
        );

        return settleSale(client, req.params.id);
      });

      // Stock went back on the shelf, so an out-of-stock alert the sale raised
      // may no longer be true — and a partial return may leave it exactly as it
      // was, which the refresh works out rather than the caller guessing.
      await refreshStockAlertsFor(db, pharmacyId, affected, 'pos.void');

      res.json({ success: true, message: 'Sale voided and stock returned to the shelf', data: sale });
    } catch (error) {
      if (error instanceof PosError) {
        res.status(error.statusCode).json({ success: false, message: error.message });
        return;
      }
      logger.error('Failed to void sale', error);
      res.status(500).json({ success: false, message: 'Failed to void the sale' });
    }
  }
);

export default router;
