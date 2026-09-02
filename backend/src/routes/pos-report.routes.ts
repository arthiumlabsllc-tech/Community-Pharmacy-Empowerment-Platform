import { Router, Request, Response } from 'express';
import db from '../config/database';
import { authenticate, authorize } from '../middleware/auth.middleware';
import { UserRole } from '../types';
import logger from '../utils/logger';
import { round2 } from '../utils/ghana-tax';
import { saleTime } from '../utils/sale-time';

/**
 * POS reporting.
 *
 * Restricted to owners and pharmacists: these endpoints expose cost price,
 * gross margin and named staff performance, which is exactly the separation
 * between admin and cashier duties that the role model exists to enforce.
 *
 * Profit figures are computed on NET sales (what the customer paid less the
 * VAT, NHIL and GETFund levy collected on their behalf). Using the gross
 * till total would overstate margin by the 20% standard-rate burden, because
 * that money belongs to GRA and not to the pharmacy.
 */

const router = Router();

router.use(authenticate);
router.use(authorize(UserRole.PHARMACY_OWNER, UserRole.PHARMACIST));

interface Range {
  sql: string;
  params: any[];
  days: number;
  from: string | null;
  to: string | null;
}

/**
 * Builds the sale-time window for a report. `from`/`to` are inclusive dates;
 * without them the window is the last N days (default 30). Parameters are
 * emitted starting at `startIdx` so the caller can keep $1 for pharmacy_id.
 */
function buildRange(req: Request, startIdx: number, alias = 's'): Range {
  const days = Math.min(Math.max(parseInt(req.query.days as string, 10) || 30, 1), 366);
  const from = typeof req.query.from === 'string' && req.query.from ? req.query.from : null;
  const to = typeof req.query.to === 'string' && req.query.to ? req.query.to : null;
  const time = saleTime(alias);

  const sql =
    ` AND ${time} >= COALESCE($${startIdx}::timestamptz,` +
    ` date_trunc('day', NOW()) - ($${startIdx + 1} || ' days')::interval)` +
    ` AND ${time} < COALESCE($${startIdx + 2}::timestamptz + INTERVAL '1 day', NOW())`;

  return { sql, params: [from, String(days), to], days, from, to };
}

const num = (value: unknown): number => round2(Number(value) || 0);

/** Net sales and margin from a gross till total and the tax collected on it. */
function withProfit(row: { gross_sales: unknown; tax: unknown; cogs: unknown }) {
  const grossSales = num(row.gross_sales);
  const tax = num(row.tax);
  const cogs = num(row.cogs);
  const netSales = round2(grossSales - tax);
  const grossProfit = round2(netSales - cogs);

  return {
    gross_sales: grossSales,
    net_sales: netSales,
    tax,
    cogs,
    gross_profit: grossProfit,
    margin_percent: netSales > 0 ? round2((grossProfit / netSales) * 100) : 0,
  };
}

// ---------------------------------------------------------------------------
// Headline summary
// ---------------------------------------------------------------------------

router.get('/summary', async (req: Request, res: Response) => {
  try {
    const pharmacyId = req.user!.pharmacyId;
    const range = buildRange(req, 2);

    const [salesResult, costResult, paymentResult, pendingResult] = await Promise.all([
      db.query(
        `SELECT
           COUNT(*) FILTER (WHERE s.status = 'completed')::int AS transactions,
           COUNT(*) FILTER (WHERE s.status = 'voided')::int AS voided_sales,
           COALESCE(SUM(s.total_amount) FILTER (WHERE s.status = 'completed'), 0)::numeric AS gross_sales,
           COALESCE(SUM(s.vat_amount + s.nhil_amount + s.getfund_amount)
                    FILTER (WHERE s.status = 'completed'), 0)::numeric AS tax,
           COALESCE(SUM(s.discount_amount) FILTER (WHERE s.status = 'completed'), 0)::numeric AS discounts,
           COALESCE(SUM(s.exempt_amount) FILTER (WHERE s.status = 'completed'), 0)::numeric AS exempt_value,
           COALESCE(AVG(s.total_amount) FILTER (WHERE s.status = 'completed'), 0)::numeric AS avg_basket,
           COALESCE(MAX(s.total_amount) FILTER (WHERE s.status = 'completed'), 0)::numeric AS largest_sale
         FROM sales s
        WHERE s.pharmacy_id = $1${range.sql}`,
        [pharmacyId, ...range.params]
      ),
      db.query(
        `SELECT COALESCE(SUM(si.quantity * si.unit_cost), 0)::numeric AS cogs,
                COALESCE(SUM(si.quantity), 0)::int AS units_sold
           FROM sale_items si
           JOIN sales s ON si.sale_id = s.id
          WHERE s.pharmacy_id = $1 AND s.status = 'completed'${range.sql}`,
        [pharmacyId, ...range.params]
      ),
      db.query(
        `SELECT sp.method, COUNT(*)::int AS payment_count,
                COALESCE(SUM(sp.amount), 0)::numeric AS total,
                COUNT(*) FILTER (WHERE sp.gateway IS NULL)::int AS manual_count
           FROM sale_payments sp
           JOIN sales s ON sp.sale_id = s.id
          WHERE s.pharmacy_id = $1 AND s.status = 'completed'
            AND sp.status IN ('completed', 'authorised')${range.sql}
          GROUP BY sp.method
          ORDER BY total DESC`,
        [pharmacyId, ...range.params]
      ),
      db.query(
        `SELECT COUNT(*)::int AS pending_sales,
                COALESCE(SUM(s.total_amount - s.amount_paid), 0)::numeric AS owed
           FROM sales s
          WHERE s.pharmacy_id = $1 AND s.status = 'pending'${range.sql}`,
        [pharmacyId, ...range.params]
      ),
    ]);

    const sales = salesResult.rows[0];
    const costs = costResult.rows[0];
    const pending = pendingResult.rows[0];
    const paymentMethods = paymentResult.rows.map((row: any) => ({
      method: row.method,
      payment_count: row.payment_count,
      total: num(row.total),
      // gateway IS NULL means the pharmacy recorded it by hand, which reports
      // must not count as gateway-settled money.
      manual_count: row.manual_count,
    }));

    res.json({
      success: true,
      data: {
        period: { days: range.days, from: range.from, to: range.to },
        transactions: sales.transactions,
        voided_sales: sales.voided_sales,
        units_sold: costs.units_sold,
        discounts: num(sales.discounts),
        exempt_value: num(sales.exempt_value),
        avg_basket: num(sales.avg_basket),
        largest_sale: num(sales.largest_sale),
        ...withProfit({ gross_sales: sales.gross_sales, tax: sales.tax, cogs: costs.cogs }),
        payment_methods: paymentMethods,
        outstanding: {
          pending_sales: pending.pending_sales,
          owed: num(pending.owed),
        },
      },
    });
  } catch (error) {
    logger.error('Failed to load POS summary', error);
    res.status(500).json({ success: false, message: 'Failed to load the sales summary' });
  }
});

// ---------------------------------------------------------------------------
// Daily series
// ---------------------------------------------------------------------------

router.get('/daily', async (req: Request, res: Response) => {
  try {
    const pharmacyId = req.user!.pharmacyId;
    const range = buildRange(req, 2);

    const result = await db.query(
      `SELECT to_char(${saleTime('s')} AT TIME ZONE 'Africa/Accra', 'YYYY-MM-DD') AS day,
              COUNT(*)::int AS transactions,
              COALESCE(SUM(s.total_amount), 0)::numeric AS gross_sales,
              COALESCE(SUM(s.vat_amount + s.nhil_amount + s.getfund_amount), 0)::numeric AS tax,
              COALESCE(SUM(s.discount_amount), 0)::numeric AS discounts
         FROM sales s
        WHERE s.pharmacy_id = $1 AND s.status = 'completed'${range.sql}
        GROUP BY day
        ORDER BY day`,
      [pharmacyId, ...range.params]
    );

    // A trading day with no sales is a real data point (zero), not a missing
    // row, so the gaps are filled before the chart is drawn.
    const byDay = new Map(result.rows.map((row: any) => [row.day, row]));
    const series: any[] = [];
    const cursor = new Date();
    cursor.setHours(0, 0, 0, 0);
    cursor.setDate(cursor.getDate() - range.days + 1);

    for (let i = 0; i < range.days; i++) {
      const key = [
        cursor.getFullYear(),
        String(cursor.getMonth() + 1).padStart(2, '0'),
        String(cursor.getDate()).padStart(2, '0'),
      ].join('-');
      const row = byDay.get(key);

      series.push({
        day: key,
        transactions: row?.transactions ?? 0,
        gross_sales: num(row?.gross_sales ?? 0),
        net_sales: round2(num(row?.gross_sales ?? 0) - num(row?.tax ?? 0)),
        tax: num(row?.tax ?? 0),
        discounts: num(row?.discounts ?? 0),
      });

      cursor.setDate(cursor.getDate() + 1);
    }

    res.json({ success: true, data: series });
  } catch (error) {
    logger.error('Failed to load daily sales', error);
    res.status(500).json({ success: false, message: 'Failed to load daily sales' });
  }
});

// ---------------------------------------------------------------------------
// Product profitability
// ---------------------------------------------------------------------------

router.get('/products', async (req: Request, res: Response) => {
  try {
    const pharmacyId = req.user!.pharmacyId;
    const range = buildRange(req, 2);
    const limit = Math.min(Math.max(parseInt(req.query.limit as string, 10) || 20, 1), 100);

    const result = await db.query(
      `SELECT si.product_name,
              MAX(si.generic_name) AS generic_name,
              MAX(si.vat_treatment)::text AS vat_treatment,
              SUM(si.quantity)::int AS units_sold,
              COUNT(DISTINCT si.sale_id)::int AS transactions,
              COALESCE(SUM(si.line_total), 0)::numeric AS gross_sales,
              COALESCE(SUM(si.vat_amount + si.nhil_amount + si.getfund_amount), 0)::numeric AS tax,
              COALESCE(SUM(si.quantity * si.unit_cost), 0)::numeric AS cogs
         FROM sale_items si
         JOIN sales s ON si.sale_id = s.id
        WHERE s.pharmacy_id = $1 AND s.status = 'completed'${range.sql}
        GROUP BY si.product_name
        ORDER BY gross_sales DESC
        LIMIT $5`,
      [pharmacyId, ...range.params, limit]
    );

    const products = result.rows.map((row: any) => ({
      product_name: row.product_name,
      generic_name: row.generic_name,
      vat_treatment: row.vat_treatment,
      units_sold: row.units_sold,
      transactions: row.transactions,
      ...withProfit({ gross_sales: row.gross_sales, tax: row.tax, cogs: row.cogs }),
    }));

    res.json({ success: true, data: products, period: { days: range.days } });
  } catch (error) {
    logger.error('Failed to load product profitability', error);
    res.status(500).json({ success: false, message: 'Failed to load product profitability' });
  }
});

// ---------------------------------------------------------------------------
// Staff performance at the till
// ---------------------------------------------------------------------------

router.get('/staff', async (req: Request, res: Response) => {
  try {
    const pharmacyId = req.user!.pharmacyId;
    const range = buildRange(req, 2);

    // The date window lives in the JOIN, not the WHERE, so a staff member with
    // no sales in the period still appears with zeros.
    const result = await db.query(
      `SELECT u.id,
              u.first_name || ' ' || u.last_name AS name,
              u.role::text AS role,
              COUNT(s.id) FILTER (WHERE s.status = 'completed')::int AS transactions,
              COUNT(s.id) FILTER (WHERE s.status = 'voided')::int AS voided_sales,
              COALESCE(SUM(s.total_amount) FILTER (WHERE s.status = 'completed'), 0)::numeric AS gross_sales,
              COALESCE(SUM(s.vat_amount + s.nhil_amount + s.getfund_amount)
                       FILTER (WHERE s.status = 'completed'), 0)::numeric AS tax,
              COALESCE(AVG(s.total_amount) FILTER (WHERE s.status = 'completed'), 0)::numeric AS avg_basket,
              COALESCE(SUM(s.discount_amount) FILTER (WHERE s.status = 'completed'), 0)::numeric AS discounts
         FROM users u
         LEFT JOIN sales s ON s.served_by = u.id${range.sql}
        WHERE u.pharmacy_id = $1 AND u.is_active = true
        GROUP BY u.id, u.first_name, u.last_name, u.role
        ORDER BY gross_sales DESC, transactions DESC`,
      [pharmacyId, ...range.params]
    );

    res.json({
      success: true,
      data: result.rows.map((row: any) => ({
        id: row.id,
        name: row.name,
        role: row.role,
        transactions: row.transactions,
        voided_sales: row.voided_sales,
        gross_sales: num(row.gross_sales),
        net_sales: round2(num(row.gross_sales) - num(row.tax)),
        tax_collected: num(row.tax),
        discounts_given: num(row.discounts),
        avg_basket: num(row.avg_basket),
      })),
      period: { days: range.days },
    });
  } catch (error) {
    logger.error('Failed to load staff sales performance', error);
    res.status(500).json({ success: false, message: 'Failed to load staff performance' });
  }
});

// ---------------------------------------------------------------------------
// Ghana VAT return (Act 1151)
// ---------------------------------------------------------------------------

/**
 * The figures a pharmacy needs for its VAT return, split by treatment.
 *
 * Act 1151 charges VAT (15%), the NHIL (2.5%) and the GETFund Levy (2.5%) on
 * the SAME taxable value, so the three amounts are reported side by side
 * rather than cascaded. Exempt supplies (First Schedule — Chapter 30
 * pharmaceuticals and mosquito nets) carry no output tax at all but their value
 * still has to be declared, which is why exempt_value is returned separately.
 */
router.get('/tax', async (req: Request, res: Response) => {
  try {
    const pharmacyId = req.user!.pharmacyId;
    const range = buildRange(req, 2);

    const [settingsResult, treatmentResult, totalsResult] = await Promise.all([
      db.query('SELECT name, license_number, settings FROM pharmacies WHERE id = $1', [pharmacyId]),
      db.query(
        `SELECT si.vat_treatment::text AS vat_treatment,
                COUNT(*)::int AS line_count,
                COALESCE(SUM(si.quantity), 0)::int AS units,
                COALESCE(SUM(si.line_total), 0)::numeric AS value,
                COALESCE(SUM(si.taxable_base), 0)::numeric AS taxable_base,
                COALESCE(SUM(si.vat_amount), 0)::numeric AS vat,
                COALESCE(SUM(si.nhil_amount), 0)::numeric AS nhil,
                COALESCE(SUM(si.getfund_amount), 0)::numeric AS getfund
           FROM sale_items si
           JOIN sales s ON si.sale_id = s.id
          WHERE s.pharmacy_id = $1 AND s.status = 'completed'${range.sql}
          GROUP BY si.vat_treatment
          ORDER BY si.vat_treatment`,
        [pharmacyId, ...range.params]
      ),
      db.query(
        `SELECT COALESCE(SUM(s.vat_amount), 0)::numeric AS vat,
                COALESCE(SUM(s.nhil_amount), 0)::numeric AS nhil,
                COALESCE(SUM(s.getfund_amount), 0)::numeric AS getfund,
                COALESCE(SUM(s.taxable_base), 0)::numeric AS taxable_base,
                COALESCE(SUM(s.exempt_amount), 0)::numeric AS exempt_value,
                COALESCE(SUM(s.total_amount), 0)::numeric AS gross_sales,
                COUNT(*)::int AS taxable_transactions
           FROM sales s
          WHERE s.pharmacy_id = $1 AND s.status = 'completed'${range.sql}`,
        [pharmacyId, ...range.params]
      ),
    ]);

    const pharmacy = settingsResult.rows[0] || {};
    const taxSettings = pharmacy.settings?.tax || {};
    const vatRegistered = taxSettings.vat_registered !== false;
    const totals = totalsResult.rows[0];

    const vat = num(totals.vat);
    const nhil = num(totals.nhil);
    const getfund = num(totals.getfund);

    res.json({
      success: true,
      data: {
        period: { days: range.days, from: range.from, to: range.to },
        pharmacy: { name: pharmacy.name, license_number: pharmacy.license_number },
        vat_registered: vatRegistered,
        transactions: totals.taxable_transactions,
        gross_sales: num(totals.gross_sales),
        taxable_base: num(totals.taxable_base),
        exempt_value: num(totals.exempt_value),
        vat,
        nhil,
        getfund,
        total_levies: round2(vat + nhil + getfund),
        by_treatment: treatmentResult.rows.map((row: any) => ({
          vat_treatment: row.vat_treatment,
          line_count: row.line_count,
          units: row.units,
          value: num(row.value),
          taxable_base: num(row.taxable_base),
          vat: num(row.vat),
          nhil: num(row.nhil),
          getfund: num(row.getfund),
        })),
        // Stated plainly so nobody files a return from a dashboard that has
        // quietly stopped charging VAT.
        notice: vatRegistered
          ? null
          : 'This pharmacy is marked as NOT VAT registered, so no VAT, NHIL or GETFund levy has been charged on any sale. Act 1151 requires registration above GHS 750,000 turnover — turn this on in Settings once the threshold is passed.',
      },
    });
  } catch (error) {
    logger.error('Failed to load tax report', error);
    res.status(500).json({ success: false, message: 'Failed to load the tax report' });
  }
});

export default router;
