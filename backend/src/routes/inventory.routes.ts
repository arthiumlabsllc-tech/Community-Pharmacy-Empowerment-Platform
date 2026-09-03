import { Router, Request, Response } from 'express';
import { body, param, query } from 'express-validator';
import { PoolClient } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import db from '../config/database';
import { cacheGet, cacheSet, cacheDel } from '../config/redis';
import { authenticate, authorize } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import { auditLog } from '../middleware/audit.middleware';
import { UserRole } from '../types';
import { describeRates, resolveTaxRates, round2, suggestVatTreatment } from '../utils/ghana-tax';
import logger from '../utils/logger';
import { findReplay, readClientRequestId, recordReplay } from '../utils/idempotency';
import { countBatches, hasBatchTables, recordMovement, type MovementReason } from '../utils/batches';
import { sortBatchesFefo, isAcceptableArrivalDate, todayInGhana, toIsoDate, type BatchRow } from '../utils/fefo';
import { refreshStockAlertsFor } from '../utils/stock-alerts';
import {
  buildRecallBatchQuery,
  buildRecallExposureQuery,
  clampRecallLimit,
  recallContact,
  summariseReach,
  type RecallExposureRow,
  type RecallFilter,
} from '../utils/recall-queries';

const router = Router();

router.use(authenticate);
router.use(auditLog);

// ============ BATCH TRACKING ============
//
// Migration 003 makes inventory_batches the physical truth about stock and
// turns four columns on `inventory` into a summary of it: a BEFORE UPDATE
// trigger recomputes quantity, batch_number, expiry_date and cost_price from
// the batches whenever the product has any. Everything in this section exists
// because of that, and the rule the whole file follows is the trigger's own:
//
//   a product with no batches is edited exactly as it always was;
//   a product with batches has its stock edited through its batches.
//
// Writing a stock figure directly to a batched product is not an error, which
// is what makes it dangerous — the statement succeeds, the trigger discards it,
// and the pharmacist is left believing a correction they never made.

/** Raised for a business-rule rejection so the handler can answer with a clean 4xx. */
class InventoryError extends Error {
  statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

/**
 * One batch row plus the delivery details behind it.
 *
 * `BatchRow` is what the allocator sees and deliberately carries nothing else;
 * a batch panel needs to say where the lot came from and whether it is a
 * recorded delivery or a balance the migration invented.
 */
interface BatchDetail extends BatchRow {
  supplierId: string | null;
  supplierName: string | null;
  invoiceNumber: string | null;
  receivedBy: string | null;
  isBackfill: boolean;
}

function toBatchDetail(row: any): BatchDetail {
  return {
    id: row.id,
    batchNumber: String(row.batch_number),
    // Converted at the boundary. A DATE column arrives as a JavaScript Date at
    // local midnight, and comparing that against an ISO string is how an expiry
    // moves by a day.
    expiryDate: toIsoDate(row.expiry_date),
    quantity: Number(row.quantity) || 0,
    unitCost: Number(row.cost_price) || 0,
    receivedAt: toIsoDate(row.received_at),
    isActive: row.is_active !== false,
    supplierId: row.supplier_id ?? null,
    supplierName: row.name ?? null,
    invoiceNumber: row.invoice_number ?? null,
    receivedBy: row.received_by ?? null,
    isBackfill: row.is_backfill === true,
  };
}

/**
 * Loads one batch with the product it belongs to, locked, inside the caller's
 * transaction. Returns null when the batch is not this pharmacy's — which is
 * the same answer as "does not exist", because the difference is not something
 * a caller from another pharmacy should learn.
 *
 * Locks the batch and not the product row. Every other writer of stock locks
 * in that order — batches first, then the product row the derived-stock trigger
 * updates — and one path locking the other way round is how two tills deadlock.
 */
async function lockBatch(client: PoolClient, pharmacyId: string, batchId: string) {
  const result = await client.query(
    `SELECT b.id, b.inventory_id, b.batch_number, b.expiry_date, b.quantity,
            b.cost_price, b.is_active, b.received_at, b.supplier_id, b.invoice_number,
            b.is_backfill, i.product_name, i.reorder_level
       FROM inventory_batches b
       JOIN inventory i ON i.id = b.inventory_id
      WHERE b.id = $1 AND b.pharmacy_id = $2
      FOR UPDATE OF b`,
    [batchId, pharmacyId]
  );
  return result.rows[0] ?? null;
}

/**
 * The product row as the trigger last left it, for the response to a write.
 *
 * Read back rather than assembled in JavaScript: the point of the derived
 * columns is that the database computes them, and a figure the API recalculated
 * itself is a second implementation that can disagree with the first.
 */
async function readProductStock(client: PoolClient, pharmacyId: string, inventoryId: string) {
  const result = await client.query(
    `SELECT id, product_name, product_code, quantity, batch_number, expiry_date,
            cost_price, unit_price, reorder_level
       FROM inventory
      WHERE id = $1 AND pharmacy_id = $2`,
    [inventoryId, pharmacyId]
  );
  return result.rows[0] ?? null;
}

/** Refuses a batch write when migration 003 has not been applied. */
async function requireBatchTables(client: PoolClient): Promise<void> {
  if (await hasBatchTables(client)) return;

  // 501 rather than 500: the database is fine and the request is fine, the
  // server simply cannot do this yet, and the message says what makes it able
  // to. A retry will not help, which is what an offline queue needs to know.
  throw new InventoryError(
    'Batch tracking is not installed on this database. Run ' +
      'database/migrations/003_inventory_batches.sql to receive stock against a lot number.',
    501
  );
}

// ============ LIST INVENTORY ============
router.get('/', async (req: Request, res: Response) => {
  try {
    const pharmacyId = req.user!.pharmacyId;
    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const offset = (page - 1) * limit;
    const { search, category, sort = 'product_name', order = 'asc' } = req.query;

    let whereClause = 'WHERE i.pharmacy_id = $1 AND i.is_active = true';
    const params: any[] = [pharmacyId];
    let paramIdx = 2;

    if (search) {
      whereClause += ` AND (i.product_name ILIKE $${paramIdx} OR i.generic_name ILIKE $${paramIdx} OR i.product_code ILIKE $${paramIdx})`;
      params.push(`%${search}%`);
      paramIdx++;
    }

    if (category) {
      whereClause += ` AND i.category = $${paramIdx}`;
      params.push(category);
      paramIdx++;
    }

    const validSorts = ['product_name', 'quantity', 'expiry_date', 'unit_price', 'created_at'];
    const sortCol = validSorts.includes(sort as string) ? sort : 'product_name';
    const sortOrder = order === 'desc' ? 'DESC' : 'ASC';

    const [countResult, dataResult] = await Promise.all([
      db.query(`SELECT COUNT(*) as total FROM inventory i ${whereClause}`, params),
      db.query(
        `SELECT * FROM inventory i ${whereClause} ORDER BY i.${sortCol} ${sortOrder} LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
        [...params, limit, offset]
      ),
    ]);

    const total = parseInt(countResult.rows[0].total, 10);
    res.json({
      success: true,
      data: dataResult.rows,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    logger.error('Failed to fetch inventory', error);
    res.status(500).json({ success: false, message: 'Failed to load inventory' });
  }
});

// ============ INVENTORY SUMMARY ============
router.get('/summary', async (req: Request, res: Response) => {
  try {
    const result = await db.query(
      `SELECT
         COUNT(*)::int AS total_items,
         COALESCE(SUM(quantity), 0)::int AS total_units,
         COALESCE(SUM(quantity * unit_price), 0)::numeric AS stock_value,
         COUNT(*) FILTER (WHERE quantity <= reorder_level)::int AS low_stock,
         COUNT(*) FILTER (WHERE quantity = 0)::int AS out_of_stock,
         COUNT(*) FILTER (WHERE expiry_date < CURRENT_DATE)::int AS expired,
         COUNT(*) FILTER (WHERE expiry_date >= CURRENT_DATE AND expiry_date <= CURRENT_DATE + INTERVAL '30 days')::int AS expiring_30d,
         COUNT(*) FILTER (WHERE expiry_date >= CURRENT_DATE AND expiry_date <= CURRENT_DATE + INTERVAL '90 days')::int AS expiring_90d
       FROM inventory
       WHERE pharmacy_id = $1 AND is_active = true`,
      [req.user!.pharmacyId]
    );
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    logger.error('Failed to fetch inventory summary', error);
    res.status(500).json({ success: false, message: 'Failed to load inventory summary' });
  }
});

// ============ ADD INVENTORY ITEM ============
router.post(
  '/',
  authorize(UserRole.PHARMACY_OWNER, UserRole.PHARMACIST),
  validate([
    body('product_name').trim().notEmpty().withMessage('Product name is required'),
    body('product_code').trim().notEmpty().withMessage('Product code is required'),
    body('quantity').isInt({ min: 0 }).withMessage('Quantity must be a positive number'),
    body('unit_price').isFloat({ min: 0 }).withMessage('Unit price must be positive'),
    body('cost_price').isFloat({ min: 0 }).withMessage('Cost price must be positive'),
    body('expiry_date').isDate().withMessage('Valid expiry date is required'),
    body('reorder_level').isInt({ min: 0 }).withMessage('Reorder level is required'),
    body('vat_treatment').optional().isIn(['standard', 'exempt', 'zero_rated'])
      .withMessage('VAT treatment must be standard, exempt or zero_rated'),
    body('pack_size').optional().isInt({ min: 1 }).withMessage('Pack size must be at least 1'),
    body('default_sell_unit').optional().isString().isLength({ max: 20 })
      .withMessage('Selling unit must be 20 characters or fewer'),
  ]),
  async (req: Request, res: Response) => {
    try {
      // Stock received during an outage is queued and replayed. The unique
      // product_code below would catch a retry, but it would answer with a
      // confusing "already exists" for a delivery the pharmacist knows they
      // only entered once — the key returns the original row instead.
      const clientRequestId = readClientRequestId(req);
      const replay = await findReplay(req.user!.pharmacyId, clientRequestId);
      if (replay) return res.status(replay.status).json(replay.body);

      const {
        product_name, product_code, generic_name, category, manufacturer,
        batch_number, quantity, unit_price, cost_price, expiry_date,
        reorder_level, shelf_location, barcode, requires_prescription,
        pack_size, default_sell_unit,
      } = req.body;

      // When the pharmacist does not pick a treatment, suggest one from the
      // category rather than defaulting everything to exempt: Act 1151 exempts
      // Chapter 30 pharmaceuticals, but the toiletries, cosmetics and devices
      // on the same shelf are standard-rated and selling them untaxed is
      // under-declaration. The response flags the suggestion so the form can
      // ask for confirmation instead of applying it silently.
      const vatProvided = ['standard', 'exempt', 'zero_rated'].includes(req.body.vat_treatment);
      const vatTreatment = vatProvided
        ? req.body.vat_treatment
        : suggestVatTreatment(category, product_name);

      const id = uuidv4();
      const openingQuantity = Math.max(parseInt(String(quantity), 10) || 0, 0);

      const created = await db.transaction(async (client) => {
        const result = await client.query(
          `INSERT INTO inventory (id, pharmacy_id, product_name, product_code, generic_name, category,
            manufacturer, batch_number, quantity, unit_price, cost_price, expiry_date,
            reorder_level, shelf_location, barcode, requires_prescription,
            vat_treatment, pack_size, default_sell_unit)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
           RETURNING *`,
          [id, req.user!.pharmacyId, product_name, product_code, generic_name || null,
           category || null, manufacturer || null, batch_number || null, quantity,
           unit_price, cost_price, expiry_date, reorder_level, shelf_location || null,
           barcode || null, requires_prescription || false,
           vatTreatment, pack_size || 1, default_sell_unit || 'pack']
        );

        // The opening stock becomes a batch in the same transaction.
        //
        // Leaving it on the product row alone would work right up until the
        // first delivery: at that point the derived-stock trigger takes over and
        // recomputes quantity from the batches only, so the opening count would
        // vanish and the pharmacy would be short by exactly what it started
        // with. A product created before batch tracking existed is left alone by
        // that trigger, which is why this has to happen here rather than there.
        if (openingQuantity > 0 && (await hasBatchTables(client))) {
          const opening = await client.query(
            `INSERT INTO inventory_batches
               (pharmacy_id, inventory_id, batch_number, expiry_date, quantity,
                cost_price, received_at, received_by, is_backfill)
             VALUES ($1,$2,$3,$4,$5,$6,CURRENT_DATE,$7,false)
             RETURNING id`,
            [req.user!.pharmacyId, id, String(batch_number || '').trim() || 'OPENING',
             expiry_date, openingQuantity, cost_price, req.user!.userId]
          );

          await recordMovement(client, {
            pharmacyId: req.user!.pharmacyId,
            inventoryId: id,
            batchId: opening.rows[0].id,
            quantityChange: openingQuantity,
            quantityAfter: openingQuantity,
            reason: 'opening_balance',
            note: 'Entered with the product',
            userId: req.user!.userId,
          });
        }

        return result.rows[0];
      });

      await cacheDel(`inventory:${req.user!.pharmacyId}:*`);

      // A product created already at or below its reorder level is worth saying
      // so about now, rather than at the next sale of something else.
      await refreshStockAlertsFor(db, req.user!.pharmacyId, [id], 'inventory.create');

      const payload = {
        success: true,
        message: 'Item added to inventory',
        data: created,
        vat_treatment_source: vatProvided ? 'provided' : 'suggested',
      };
      await recordReplay({
        pharmacyId: req.user!.pharmacyId,
        clientRequestId,
        userId: req.user!.userId,
        endpoint: 'POST /inventory',
        status: 201,
        body: payload,
      });

      res.status(201).json(payload);
    } catch (error: any) {
      if (error.code === '23505') {
        return res.status(409).json({ success: false, message: 'An item with this product code already exists' });
      }
      logger.error('Failed to add inventory item', error);
      res.status(500).json({ success: false, message: 'Failed to add item' });
    }
  }
);

// ============ UPDATE INVENTORY ITEM ============
router.put(
  '/:id',
  authorize(UserRole.PHARMACY_OWNER, UserRole.PHARMACIST),
  validate([
    param('id').isUUID(),
    body('vat_treatment').optional().isIn(['standard', 'exempt', 'zero_rated'])
      .withMessage('VAT treatment must be standard, exempt or zero_rated'),
    body('pack_size').optional().isInt({ min: 1 }).withMessage('Pack size must be at least 1'),
  ]),
  async (req: Request, res: Response) => {
    try {
      const {
        product_name, product_code, generic_name, category, manufacturer,
        batch_number, quantity, unit_price, cost_price, expiry_date,
        reorder_level, shelf_location, barcode, requires_prescription,
        vat_treatment, pack_size, default_sell_unit,
      } = req.body;

      const pharmacyId = req.user!.pharmacyId;
      // Whether the four stock figures are this endpoint's to write at all.
      const trackedByBatch = (await countBatches(db, pharmacyId, req.params.id)) > 0;

      const result = await db.query(
        `UPDATE inventory SET
          product_name = COALESCE($3, product_name),
          product_code = COALESCE($4, product_code),
          generic_name = COALESCE($5, generic_name),
          category = COALESCE($6, category),
          manufacturer = COALESCE($7, manufacturer),
          -- Guarded rather than left to the trigger. The trigger would discard
          -- these anyway, but writing a value only to have it thrown away is
          -- indistinguishable from writing it and being ignored, and the
          -- response has to be able to say which of the two happened.
          batch_number = CASE WHEN $20::boolean THEN batch_number ELSE COALESCE($8, batch_number) END,
          quantity     = CASE WHEN $20::boolean THEN quantity     ELSE COALESCE($9, quantity) END,
          unit_price = COALESCE($10, unit_price),
          cost_price   = CASE WHEN $20::boolean THEN cost_price   ELSE COALESCE($11, cost_price) END,
          expiry_date  = CASE WHEN $20::boolean THEN expiry_date  ELSE COALESCE($12, expiry_date) END,
          reorder_level = COALESCE($13, reorder_level),
          shelf_location = COALESCE($14, shelf_location),
          barcode = COALESCE($15, barcode),
          requires_prescription = COALESCE($16, requires_prescription),
          vat_treatment = COALESCE($17, vat_treatment),
          pack_size = COALESCE($18, pack_size),
          default_sell_unit = COALESCE($19, default_sell_unit)
         WHERE id = $1 AND pharmacy_id = $2
         RETURNING *`,
        [req.params.id, pharmacyId, product_name, product_code, generic_name,
         category, manufacturer, batch_number, quantity, unit_price, cost_price,
         expiry_date, reorder_level, shelf_location, barcode, requires_prescription,
         vat_treatment, pack_size, default_sell_unit, trackedByBatch]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ success: false, message: 'Item not found' });
      }

      // Named rather than swallowed. The edit form submits the whole product on
      // every save, so quantity, cost and expiry arrive here whether or not the
      // pharmacist touched them — refusing the request would make a batched
      // product uneditable, and accepting it silently would make a stock
      // correction look like it worked. Telling the caller is the third option.
      const ignoredStockFields = trackedByBatch
        ? ([
            ['batch_number', batch_number],
            ['quantity', quantity],
            ['cost_price', cost_price],
            ['expiry_date', expiry_date],
          ] as Array<[string, unknown]>)
            .filter(([, value]) => value !== undefined && value !== null)
            .map(([field]) => field)
        : [];

      await cacheDel(`inventory:${pharmacyId}:*`);

      // Both the reorder level and the expiry date are editable here, so an edit
      // can create an alert as easily as it clears one.
      await refreshStockAlertsFor(db, pharmacyId, [req.params.id], 'inventory.update');

      res.json({
        success: true,
        message:
          ignoredStockFields.length > 0
            ? `Item updated. ${ignoredStockFields.join(', ')} ${
                ignoredStockFields.length === 1 ? 'comes' : 'come'
              } from the batches this product is tracked by — receive stock or adjust a batch to change ${
                ignoredStockFields.length === 1 ? 'it' : 'them'
              }.`
            : 'Item updated',
        data: result.rows[0],
        stock_tracked_by_batch: trackedByBatch,
        ignored_stock_fields: ignoredStockFields,
      });
    } catch (error) {
      logger.error('Failed to update inventory item', error);
      res.status(500).json({ success: false, message: 'Failed to update item' });
    }
  }
);

// ============ DELETE INVENTORY ITEM ============
router.delete(
  '/:id',
  authorize(UserRole.PHARMACY_OWNER),
  validate([param('id').isUUID()]),
  async (req: Request, res: Response) => {
    try {
      const result = await db.query(
        'UPDATE inventory SET is_active = false WHERE id = $1 AND pharmacy_id = $2 RETURNING id',
        [req.params.id, req.user!.pharmacyId]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ success: false, message: 'Item not found' });
      }
      // Deactivating is how a product's alerts are cleared: classifyStock says
      // nothing about a retired one, so the refresh supersedes whatever it had
      // and keeps the rows as the history of it.
      await refreshStockAlertsFor(
        db,
        req.user!.pharmacyId,
        [req.params.id],
        'inventory.deactivate'
      );

      res.json({ success: true, message: 'Item removed from inventory' });
    } catch (error) {
      res.status(500).json({ success: false, message: 'Failed to delete item' });
    }
  }
);

// ============ BATCHES FOR ONE PRODUCT ============
/**
 * Every batch of a product, in the order FEFO will take them.
 *
 * Ordered by the allocator rather than by the database, so the panel shows the
 * same sequence a sale will actually draw from. Two views of the same stock
 * that disagree about which lot goes next is how a pharmacist ends up
 * quarantining the wrong box.
 */
router.get(
  '/:id/batches',
  validate([param('id').isUUID()]),
  async (req: Request, res: Response) => {
    try {
      const pharmacyId = req.user!.pharmacyId;

      const product = await db.query(
        `SELECT id, product_name, product_code, generic_name, quantity, reorder_level,
                unit_price, cost_price, batch_number,
                to_char(expiry_date, 'YYYY-MM-DD') AS expiry_date
           FROM inventory
          WHERE id = $1 AND pharmacy_id = $2 AND is_active = true`,
        [req.params.id, pharmacyId]
      );
      if (product.rows.length === 0) {
        return res.status(404).json({ success: false, message: 'Item not found' });
      }

      const installed = await hasBatchTables(db);
      const rows = installed
        ? (
            await db.query(
              `SELECT b.id, b.batch_number, b.expiry_date, b.quantity, b.cost_price,
                      b.received_at, b.received_by, b.supplier_id, b.invoice_number,
                      b.is_backfill, b.is_active, b.updated_at,
                      s.name AS supplier_name
                 FROM inventory_batches b
                 LEFT JOIN suppliers s ON s.id = b.supplier_id
                WHERE b.pharmacy_id = $1 AND b.inventory_id = $2`,
              [pharmacyId, req.params.id]
            )
          ).rows
        : [];

      const today = todayInGhana();
      const details = rows.map(toBatchDetail);
      // sortBatchesFefo copies the array, not the objects, so the delivery
      // details come back attached to the batch they belong to.
      const ordered = sortBatchesFefo(details, today) as BatchDetail[];

      const batches = ordered.map((batch) => {
        const expired = Boolean(batch.expiryDate) && batch.expiryDate! < today;
        const daysToExpiry = batch.expiryDate
          ? Math.round(
              (Date.parse(`${batch.expiryDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) /
                86400000
            )
          : null;

        // Four states, because "not sellable" needs an action attached to it.
        // Expired and quarantined both hold stock that cannot be sold, and the
        // first one is a write-off while the second is somebody's decision to
        // revisit.
        let status: 'sellable' | 'expired' | 'quarantined' | 'empty';
        if (!batch.isActive) status = batch.quantity > 0 ? 'quarantined' : 'empty';
        else if (expired) status = 'expired';
        else if (batch.quantity <= 0) status = 'empty';
        else status = 'sellable';

        return {
          id: batch.id,
          batch_number: batch.batchNumber,
          expiry_date: batch.expiryDate,
          received_at: batch.receivedAt,
          quantity: batch.quantity,
          cost_price: batch.unitCost,
          stock_value: round2(batch.quantity * batch.unitCost),
          supplier_id: batch.supplierId,
          supplier_name: batch.supplierName,
          invoice_number: batch.invoiceNumber,
          received_by: batch.receivedBy,
          // Flagged rather than hidden: a migrated balance was not received by
          // anybody against an invoice, and implying otherwise would be a
          // traceability the pharmacy does not have.
          is_backfill: batch.isBackfill,
          is_active: batch.isActive,
          is_expired: expired,
          days_to_expiry: daysToExpiry,
          status,
          sellable: status === 'sellable',
        };
      });

      const unitsIn = (predicate: (batch: typeof batches[number]) => boolean) =>
        batches.filter(predicate).reduce((total, batch) => total + batch.quantity, 0);
      const next = batches.find((batch) => batch.sellable) ?? null;

      res.json({
        success: true,
        data: {
          product: product.rows[0],
          batch_tracking: installed,
          batches,
          // What the till will hand out next, without running a sale to find
          // out. This is the figure that makes the panel worth opening.
          next_batch: next
            ? {
                id: next.id,
                batch_number: next.batch_number,
                expiry_date: next.expiry_date,
                quantity: next.quantity,
              }
            : null,
          totals: {
            batch_count: batches.length,
            sellable_units: unitsIn((batch) => batch.sellable),
            expired_units: unitsIn((batch) => batch.status === 'expired'),
            quarantined_units: unitsIn((batch) => batch.status === 'quarantined'),
            stock_value: round2(batches.reduce((total, batch) => total + batch.stock_value, 0)),
            earliest_expiry:
              batches
                .map((batch) => batch.expiry_date)
                .filter((date): date is string => Boolean(date))
                .sort()[0] ?? null,
            // The product row is supposed to be a summary of these batches.
            // When it is not, something wrote to it directly and no batch has
            // moved since — worth saying here rather than letting a stock-take
            // discover it.
            derived_stock_matches:
              !installed ||
              Number(product.rows[0].quantity) ===
                batches.reduce((total, batch) => total + batch.quantity, 0),
          },
        },
      });
    } catch (error) {
      logger.error('Failed to load batches', error);
      res.status(500).json({ success: false, message: 'Failed to load batches' });
    }
  }
);

// ============ RECEIVE STOCK ============
/**
 * Records a delivery against a lot.
 *
 * `UNIQUE (inventory_id, batch_number)` means a second consignment of the same
 * lot tops the existing batch up rather than creating a row that looks like a
 * separate delivery. The batch is the physical lot; the ledger underneath it is
 * the delivery history, and that is where each consignment keeps its own date,
 * invoice and supplier.
 */
router.post(
  '/:id/receive',
  authorize(UserRole.PHARMACY_OWNER, UserRole.PHARMACIST),
  validate([
    param('id').isUUID(),
    body('batch_number')
      .trim()
      .notEmpty()
      .withMessage('A lot number is required — it is what a recall traces from')
      .isLength({ max: 100 })
      .withMessage('Lot number must be 100 characters or fewer'),
    body('expiry_date').isDate().withMessage('Valid expiry date is required'),
    body('quantity').isInt({ min: 1 }).withMessage('Quantity received must be at least 1'),
    body('cost_price')
      .optional({ nullable: true })
      .isFloat({ min: 0 })
      .withMessage('Cost price cannot be negative'),
    body('supplier_id')
      .optional({ nullable: true })
      .isUUID()
      .withMessage('supplier_id must be a valid id'),
    body('invoice_number')
      .optional({ nullable: true })
      .isString()
      .isLength({ max: 100 })
      .withMessage('Invoice number must be 100 characters or fewer'),
    body('received_at')
      .optional({ nullable: true })
      .isDate()
      .withMessage('received_at must be a date')
      .bail()
      // Refused here and not only in the form, because the offline queue and
      // any other caller reach this endpoint without passing through it. The
      // reason is rotation order, not tidiness — see isAcceptableArrivalDate.
      .custom((value: unknown) => isAcceptableArrivalDate(String(value)))
      .withMessage('A delivery cannot arrive in the future'),
    body('note')
      .optional({ nullable: true })
      .isString()
      .isLength({ max: 500 })
      .withMessage('Note must be 500 characters or fewer'),
  ]),
  async (req: Request, res: Response) => {
    const pharmacyId = req.user!.pharmacyId;
    const userId = req.user!.userId;

    try {
      // A delivery entered during an outage is queued and replayed. Replayed
      // twice without this, the pharmacy is left holding stock it never bought.
      const clientRequestId = readClientRequestId(req);
      const replay = await findReplay(pharmacyId, clientRequestId);
      if (replay) return res.status(replay.status).json(replay.body);

      const batchNumber = String(req.body.batch_number).trim();
      const expiryDate = String(req.body.expiry_date).slice(0, 10);
      const quantity = parseInt(String(req.body.quantity), 10);
      const costPrice = round2(Math.max(Number(req.body.cost_price) || 0, 0));
      const supplierId = req.body.supplier_id || null;
      const invoiceNumber = req.body.invoice_number
        ? String(req.body.invoice_number).trim()
        : null;
      const receivedAt = req.body.received_at ? String(req.body.received_at).slice(0, 10) : null;
      const note = req.body.note ? String(req.body.note).trim() : null;

      const outcome = await db.transaction(async (client) => {
        await requireBatchTables(client);

        const product = await client.query(
          `SELECT id, product_name FROM inventory
            WHERE id = $1 AND pharmacy_id = $2 AND is_active = true`,
          [req.params.id, pharmacyId]
        );
        if (product.rows.length === 0) {
          throw new InventoryError('Item not found', 404);
        }

        if (supplierId) {
          const supplier = await client.query(
            `SELECT id FROM suppliers WHERE id = $1 AND pharmacy_id = $2`,
            [supplierId, pharmacyId]
          );
          if (supplier.rows.length === 0) {
            throw new InventoryError("That supplier is not on this pharmacy's list");
          }
        }

        const existing = await client.query(
          `SELECT id, quantity, cost_price, expiry_date
             FROM inventory_batches
            WHERE pharmacy_id = $1 AND inventory_id = $2 AND batch_number = $3
            FOR UPDATE`,
          [pharmacyId, req.params.id, batchNumber]
        );

        let batchId: string;
        let quantityBefore: number;
        let quantityAfter: number;
        let costAfter: number;
        let merged = false;
        let expiryConflict: { on_file: string; submitted: string; kept: string } | null = null;

        if (existing.rows.length > 0) {
          merged = true;
          const before = existing.rows[0];
          batchId = before.id;
          quantityBefore = Number(before.quantity) || 0;
          quantityAfter = quantityBefore + quantity;

          // Weighted by what each side actually holds. A batch driven negative
          // by a sale recorded during an outage has no cost to contribute, so
          // it counts as holding nothing rather than dragging the average below
          // the price this delivery was bought at.
          const heldBefore = Math.max(quantityBefore, 0);
          const costBefore = Number(before.cost_price) || 0;
          costAfter = round2(
            (heldBefore * costBefore + quantity * costPrice) / (heldBefore + quantity)
          );

          // The earlier date governs. One lot number cannot genuinely carry two
          // expiry dates, so a disagreement means one of them was keyed in wrong
          // — and the safe direction to be wrong in is the one that takes stock
          // off the shelf sooner, not the one that dispenses it later than the
          // manufacturer guaranteed.
          const onFile = toIsoDate(before.expiry_date);
          const kept = onFile && onFile < expiryDate ? onFile : expiryDate;
          if (onFile && onFile !== expiryDate) {
            expiryConflict = { on_file: onFile, submitted: expiryDate, kept };
          }

          await client.query(
            `UPDATE inventory_batches
                SET quantity = $1,
                    cost_price = $2,
                    expiry_date = $3,
                    -- Received again, so it is back on the shelf. A lot that was
                    -- quarantined stays quarantined until somebody says so.
                    is_active = true,
                    -- The lot's origin does not change because a top-up arrived
                    -- from somebody else. Both deliveries are on the ledger.
                    supplier_id = COALESCE(supplier_id, $4),
                    invoice_number = COALESCE(invoice_number, $5)
              WHERE id = $6`,
            [quantityAfter, costAfter, kept, supplierId, invoiceNumber, batchId]
          );
          // received_at is deliberately left alone: this lot has been here since
          // its first delivery, and FEFO's tie-break sells the older lot first.
        } else {
          const inserted = await client.query(
            `INSERT INTO inventory_batches
               (pharmacy_id, inventory_id, batch_number, expiry_date, quantity,
                cost_price, supplier_id, invoice_number, received_at, received_by,
                is_backfill)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9::date, CURRENT_DATE),$10,false)
             RETURNING id`,
            [
              pharmacyId, req.params.id, batchNumber, expiryDate, quantity, costPrice,
              supplierId, invoiceNumber, receivedAt, userId,
            ]
          );
          batchId = inserted.rows[0].id;
          quantityBefore = 0;
          quantityAfter = quantity;
          costAfter = costPrice;
        }

        await recordMovement(client, {
          pharmacyId,
          inventoryId: req.params.id,
          batchId,
          quantityChange: quantity,
          quantityAfter,
          reason: 'receipt',
          note:
            [invoiceNumber ? `Invoice ${invoiceNumber}` : null, note]
              .filter(Boolean)
              .join(' — ') || (merged ? 'Top-up against an existing lot' : 'Stock received'),
          supplierId,
          userId,
          // Backdated to the arrival when the caller says so, so a delivery
          // entered a week late still reads in date order on the ledger.
          occurredAt: receivedAt,
        });

        return {
          batchId,
          quantityBefore,
          quantityAfter,
          costAfter,
          merged,
          expiryConflict,
          product: await readProductStock(client, pharmacyId, req.params.id),
        };
      });

      await cacheDel(`inventory:${pharmacyId}:*`);

      // The delivery is the thing that clears a low-stock alert, and the arrival
      // of a short-dated lot is the thing that raises an expiring one.
      await refreshStockAlertsFor(db, pharmacyId, [req.params.id], 'inventory.receive');

      const payload = {
        success: true,
        message: outcome.merged
          ? `Lot ${batchNumber} already held ${outcome.quantityBefore} — topped up to ${outcome.quantityAfter}`
          : `Received ${outcome.quantityAfter} of lot ${batchNumber}`,
        data: {
          batch_id: outcome.batchId,
          batch_number: batchNumber,
          expiry_date: expiryDate,
          quantity_received: quantity,
          quantity_before: outcome.quantityBefore,
          quantity_after: outcome.quantityAfter,
          cost_price: outcome.costAfter,
          merged_with_existing_lot: outcome.merged,
          // Reported rather than resolved silently. The pharmacist needs to know
          // the date on file and the one on the invoice disagree, because one of
          // them is wrong and only they can find out which.
          expiry_conflict: outcome.expiryConflict,
          product: outcome.product,
        },
      };

      await recordReplay({
        pharmacyId,
        clientRequestId,
        userId,
        endpoint: 'POST /inventory/:id/receive',
        status: 200,
        body: payload,
      });

      res.json(payload);
    } catch (error: any) {
      if (error instanceof InventoryError) {
        return res.status(error.statusCode).json({ success: false, message: error.message });
      }
      logger.error('Failed to receive stock', error);
      res.status(500).json({ success: false, message: 'Failed to receive stock' });
    }
  }
);

// ============ ADJUST A BATCH ============
/**
 * Corrects a batch to what is physically on the shelf.
 *
 * Takes either a counted quantity — what a stock-take produces — or a change,
 * and never both: two ways of saying the same thing in one request is a
 * disagreement waiting to be resolved by whichever field the code reads last.
 */
router.post(
  '/batches/:batchId/adjust',
  authorize(UserRole.PHARMACY_OWNER, UserRole.PHARMACIST),
  validate([
    param('batchId').isUUID(),
    body('quantity_change')
      .optional({ nullable: true })
      .isInt()
      .withMessage('quantity_change must be a whole number of units, positive or negative'),
    body('counted_quantity')
      .optional({ nullable: true })
      .isInt({ min: 0 })
      .withMessage('counted_quantity cannot be negative — there is no such thing as counting fewer than none'),
    body('note')
      .trim()
      .notEmpty()
      .withMessage('A correction needs saying why in writing')
      .isLength({ max: 500 })
      .withMessage('Note must be 500 characters or fewer'),
  ]),
  async (req: Request, res: Response) => {
    const pharmacyId = req.user!.pharmacyId;
    const userId = req.user!.userId;

    try {
      const clientRequestId = readClientRequestId(req);
      const replay = await findReplay(pharmacyId, clientRequestId);
      if (replay) return res.status(replay.status).json(replay.body);

      const blank = (value: unknown) =>
        value === undefined || value === null || value === '';
      const hasChange = !blank(req.body.quantity_change);
      const hasCount = !blank(req.body.counted_quantity);

      if (hasChange === hasCount) {
        return res.status(400).json({
          success: false,
          message: hasCount
            ? 'Send counted_quantity or quantity_change, not both — they are two ways of saying the same thing and they can disagree'
            : 'Send counted_quantity for a stock-take count, or quantity_change to correct by a known difference',
        });
      }

      const noteText = String(req.body.note).trim();
      const counted = hasCount ? parseInt(String(req.body.counted_quantity), 10) : null;

      const outcome = await db.transaction(async (client) => {
        await requireBatchTables(client);

        const batch = await lockBatch(client, pharmacyId, req.params.batchId);
        if (!batch) throw new InventoryError('Batch not found', 404);

        const onHand = Number(batch.quantity) || 0;
        const change = counted !== null
          ? counted - onHand
          : parseInt(String(req.body.quantity_change), 10);

        if (!Number.isFinite(change) || change === 0) {
          throw new InventoryError(
            counted !== null
              ? `Lot ${batch.batch_number} already holds ${onHand} — there is nothing to correct`
              : 'A correction has to change the count by something'
          );
        }

        const after = onHand + change;
        if (after < 0) {
          // A count is a statement about what is on the shelf and there cannot
          // be fewer than none. Below zero is stock that left for a reason, and
          // the reason is the part an insurer or the FDA asks about — that is a
          // write-off, which names one.
          throw new InventoryError(
            `That would take lot ${batch.batch_number} to ${after}. A count cannot go below zero — if the stock is gone, record a write-off and say why.`,
            409
          );
        }

        await client.query(
          `UPDATE inventory_batches
              SET quantity = $1,
                  -- Reaching zero finishes the batch. A count never brings a
                  -- quarantined one back: that takes an explicit decision.
                  is_active = CASE WHEN $2 = 0 THEN false ELSE is_active END
            WHERE id = $3`,
          [after, after, batch.id]
        );

        await recordMovement(client, {
          pharmacyId,
          inventoryId: batch.inventory_id,
          batchId: batch.id,
          quantityChange: change,
          quantityAfter: after,
          reason: 'adjustment',
          // Both figures, not just the reason. "Counted 42, was 50" is what
          // makes the discrepancy checkable a year later.
          note: counted !== null ? `Counted ${counted}, was ${onHand}. ${noteText}` : noteText,
          userId,
        });

        return {
          batchNumber: batch.batch_number,
          productName: batch.product_name,
          onHand,
          change,
          after,
          product: await readProductStock(client, pharmacyId, batch.inventory_id),
        };
      });

      await cacheDel(`inventory:${pharmacyId}:*`);

      // A stock-take correction moves the count both ways: it can find stock
      // that clears an alert or lose stock that raises one.
      await refreshStockAlertsFor(
        db,
        pharmacyId,
        [outcome.product?.id],
        'inventory.batch.adjust'
      );

      const payload = {
        success: true,
        message: `Lot ${outcome.batchNumber} corrected from ${outcome.onHand} to ${outcome.after}`,
        data: {
          batch_id: req.params.batchId,
          batch_number: outcome.batchNumber,
          product_name: outcome.productName,
          quantity_before: outcome.onHand,
          quantity_change: outcome.change,
          quantity_after: outcome.after,
          counted_quantity: counted,
          product: outcome.product,
        },
      };

      await recordReplay({
        pharmacyId,
        clientRequestId,
        userId,
        endpoint: 'POST /inventory/batches/:batchId/adjust',
        status: 200,
        body: payload,
      });

      res.json(payload);
    } catch (error: any) {
      if (error instanceof InventoryError) {
        return res.status(error.statusCode).json({ success: false, message: error.message });
      }
      logger.error('Failed to adjust batch', error);
      res.status(500).json({ success: false, message: 'Failed to adjust batch' });
    }
  }
);

// ============ WRITE OFF A BATCH ============
/** The reasons stock leaves without being sold. Mirrors the ledger's CHECK. */
const WRITE_OFF_REASONS: Array<{ value: MovementReason; label: string }> = [
  { value: 'expiry_writeoff', label: 'Expired' },
  { value: 'damage_writeoff', label: 'Damaged' },
  { value: 'recall', label: 'Recalled' },
];

/**
 * Takes stock off the shelf and says why.
 *
 * The till already refuses expired stock and tells the pharmacist to
 * "quarantine it and record a write-off". Without this endpoint that
 * instruction points at something the system cannot do, and the batch sits
 * there inflating every stock count until somebody edits a number directly.
 */
router.post(
  '/batches/:batchId/write-off',
  authorize(UserRole.PHARMACY_OWNER, UserRole.PHARMACIST),
  validate([
    param('batchId').isUUID(),
    body('reason')
      .isIn(WRITE_OFF_REASONS.map((entry) => entry.value))
      .withMessage('Reason must be expiry_writeoff, damage_writeoff or recall'),
    body('quantity')
      .optional({ nullable: true })
      .isInt({ min: 1 })
      .withMessage('Write-off quantity must be at least 1'),
    body('note')
      .trim()
      .notEmpty()
      .withMessage('A write-off needs saying why — it is the record a supplier, an insurer or the FDA asks for')
      .isLength({ max: 500 })
      .withMessage('Note must be 500 characters or fewer'),
  ]),
  async (req: Request, res: Response) => {
    const pharmacyId = req.user!.pharmacyId;
    const userId = req.user!.userId;

    try {
      const clientRequestId = readClientRequestId(req);
      const replay = await findReplay(pharmacyId, clientRequestId);
      if (replay) return res.status(replay.status).json(replay.body);

      const reason = String(req.body.reason) as MovementReason;
      const label = WRITE_OFF_REASONS.find((entry) => entry.value === reason)?.label ?? reason;
      const noteText = String(req.body.note).trim();
      const requested =
        req.body.quantity === undefined || req.body.quantity === null || req.body.quantity === ''
          ? null
          : parseInt(String(req.body.quantity), 10);

      const outcome = await db.transaction(async (client) => {
        await requireBatchTables(client);

        const batch = await lockBatch(client, pharmacyId, req.params.batchId);
        if (!batch) throw new InventoryError('Batch not found', 404);

        const onHand = Number(batch.quantity) || 0;
        if (onHand <= 0) {
          throw new InventoryError(
            `Lot ${batch.batch_number} has nothing on hand to write off` +
              (onHand < 0
                ? ` — it is ${Math.abs(onHand)} below zero, which is a stock-take to reconcile rather than stock to destroy`
                : '') +
              '.',
            409
          );
        }

        if (requested !== null && requested > onHand) {
          throw new InventoryError(
            `Lot ${batch.batch_number} has ${onHand} on hand; ${requested} cannot be written off it.`,
            409
          );
        }

        // The whole batch unless a quantity is given: damage is usually a
        // carton, expiry and recall are usually the lot.
        const amount = requested ?? onHand;
        const after = onHand - amount;

        await client.query(
          `UPDATE inventory_batches
              SET quantity = $1,
                  is_active = CASE WHEN $2 = 0 THEN false ELSE is_active END
            WHERE id = $3`,
          [after, after, batch.id]
        );

        await recordMovement(client, {
          pharmacyId,
          inventoryId: batch.inventory_id,
          batchId: batch.id,
          quantityChange: -amount,
          quantityAfter: after,
          reason,
          note: `${label}: ${noteText}${after > 0 ? ` (${after} left on the shelf)` : ' (batch closed)'}`,
          userId,
        });

        return {
          batchNumber: batch.batch_number,
          productName: batch.product_name,
          expiryDate: toIsoDate(batch.expiry_date),
          onHand,
          amount,
          after,
          product: await readProductStock(client, pharmacyId, batch.inventory_id),
        };
      });

      await cacheDel(`inventory:${pharmacyId}:*`);

      // The write-off is what the till tells the pharmacist to record, so this
      // is the point at which an expired-stock alert should stop being raised.
      await refreshStockAlertsFor(
        db,
        pharmacyId,
        [outcome.product?.id],
        'inventory.batch.write-off'
      );

      const payload = {
        success: true,
        message:
          outcome.after === 0
            ? `Wrote off lot ${outcome.batchNumber} (${outcome.amount} units) — ${label.toLowerCase()}`
            : `Wrote off ${outcome.amount} of lot ${outcome.batchNumber}; ${outcome.after} left`,
        data: {
          batch_id: req.params.batchId,
          batch_number: outcome.batchNumber,
          product_name: outcome.productName,
          expiry_date: outcome.expiryDate,
          reason,
          reason_label: label,
          quantity_written_off: outcome.amount,
          quantity_before: outcome.onHand,
          quantity_after: outcome.after,
          batch_closed: outcome.after === 0,
          product: outcome.product,
        },
      };

      await recordReplay({
        pharmacyId,
        clientRequestId,
        userId,
        endpoint: 'POST /inventory/batches/:batchId/write-off',
        status: 200,
        body: payload,
      });

      res.json(payload);
    } catch (error: any) {
      if (error instanceof InventoryError) {
        return res.status(error.statusCode).json({ success: false, message: error.message });
      }
      logger.error('Failed to write off batch', error);
      res.status(500).json({ success: false, message: 'Failed to write off batch' });
    }
  }
);

// ============ RECALL TRACEABILITY ============

/**
 * Both halves of a recall read the batch tables, so without migration 003 there
 * is no ledger to trace and no lot to quarantine.
 *
 * 501 rather than 500, for the reason requireBatchTables gives: the request is
 * fine and the database is fine, the server simply cannot do this yet. The
 * message also says what the pharmacy still gets afterwards, because "run the
 * migration" on its own reads as "your history is untraceable", and it is not —
 * the snapshot arm reaches every sale made before the ledger existed.
 */
const RECALL_NEEDS_003 =
  'Batch tracking is not installed on this database, so there is no record of which lot a sale drew from. ' +
  'Run database/migrations/003_inventory_batches.sql: sales made after it are traced exactly, and sales made ' +
  'before it are matched on the lot number recorded on the receipt.';

/** Runs both halves of a recall and shapes the answer. */
async function runRecall(filter: RecallFilter, limit: number) {
  // One more than wanted, so a full list is distinguishable from a truncated
  // one. Silently shortening a recall is the failure mode this whole query
  // exists to avoid.
  const batchQuery = buildRecallBatchQuery(filter);
  const exposureQuery = buildRecallExposureQuery(filter, limit + 1);

  const [batchResult, exposureResult] = await Promise.all([
    db.query(batchQuery.text, batchQuery.params),
    db.query(exposureQuery.text, exposureQuery.params),
  ]);

  const allRows = exposureResult.rows as RecallExposureRow[];
  const truncated = allRows.length > limit;
  const rows = truncated ? allRows.slice(0, limit) : allRows;
  const today = todayInGhana();

  const batches = batchResult.rows.map((batch: any) => {
    const quantity = Number(batch.quantity) || 0;
    const expiryDate = batch.expiry_date as string | null;
    // What to do with the batch today, which is a different question from who
    // to phone. A recall that only produced a patient list would leave the rest
    // of the lot on the shelf being sold.
    const action = quantity > 0
      ? batch.is_active
        ? 'quarantine'
        : 'already_quarantined'
      : 'nothing_on_hand';

    return {
      id: batch.id,
      inventory_id: batch.inventory_id,
      product_name: batch.product_name,
      product_code: batch.product_code,
      generic_name: batch.generic_name,
      manufacturer: batch.manufacturer,
      batch_number: batch.batch_number,
      expiry_date: expiryDate,
      is_expired: expiryDate !== null && expiryDate < today,
      received_at: batch.received_at,
      supplier_name: batch.supplier_name,
      invoice_number: batch.invoice_number,
      quantity_on_hand: quantity,
      stock_value: round2(quantity * (Number(batch.cost_price) || 0)),
      is_active: batch.is_active,
      is_backfill: batch.is_backfill,
      action,
    };
  });

  const sales = rows.map((row) => {
    const contact = recallContact(row);
    const quantity = Number(row.quantity) || 0;
    const unitCost = Number(row.unit_cost) || 0;
    const patientName = row.patient_first_name
      ? `${row.patient_first_name} ${row.patient_last_name ?? ''}`.trim()
      : null;

    return {
      sale_id: row.sale_id,
      receipt_number: row.receipt_number,
      sold_at: row.sold_at,
      sale_status: row.sale_status,
      voided: row.voided,
      recorded_offline: row.recorded_offline,
      product_name: row.product_name,
      product_code: row.product_code,
      generic_name: row.generic_name,
      inventory_id: row.inventory_id,
      batch_id: row.batch_id,
      batch_number: row.matched_batch_number,
      expiry_date: row.expiry_date,
      quantity,
      sell_unit: row.sell_unit,
      unit_cost: unitCost,
      line_value: round2(quantity * unitCost),
      requires_prescription: row.requires_prescription,
      // Said plainly on every row rather than summarised once, because the two
      // sources are not equally trustworthy and the pharmacist reading line 40
      // of a long list will not remember the caveat from the top.
      provenance: row.provenance,
      confirmed: row.provenance === 'batch_ledger',
      patient: row.patient_id
        ? {
            id: row.patient_id,
            name: patientName,
            phone: row.patient_phone,
            alternate_phone: row.patient_alternate_phone,
            nhis_number: row.patient_nhis_number,
          }
        : null,
      customer:
        row.customer_name || row.customer_phone
          ? { name: row.customer_name, phone: row.customer_phone }
          : null,
      contact: contact.phone ? { phone: contact.phone, source: contact.source } : null,
      served_by: row.served_by_id
        ? {
            id: row.served_by_id,
            name: `${row.served_by_first_name ?? ''} ${row.served_by_last_name ?? ''}`.trim(),
          }
        : null,
    };
  });

  const dispensed = sales.filter((sale) => !sale.voided);
  // Invalid dates are dropped before mapping, not after: toISOString() on one
  // throws a RangeError rather than returning a string to filter out.
  const soldAts = dispensed
    .map((sale) => new Date(sale.sold_at as any))
    .filter((date) => !Number.isNaN(date.getTime()))
    .map((date) => date.toISOString())
    .sort();
  const unconfirmed = sales.filter((sale) => !sale.confirmed);
  const reach = summariseReach(rows);
  const onHand = batches.reduce((total: number, batch: any) => total + batch.quantity_on_hand, 0);
  const distinctPatients = new Set(
    dispensed.map((sale) => sale.patient?.id).filter((id): id is string => Boolean(id))
  );

  return {
    batches,
    sales,
    reach,
    totals: {
      batch_count: batches.length,
      sale_count: sales.length,
      voided_count: sales.length - dispensed.length,
      units_dispensed: dispensed.reduce((total, sale) => total + sale.quantity, 0),
      units_returned: sales
        .filter((sale) => sale.voided)
        .reduce((total, sale) => total + sale.quantity, 0),
      distinct_patients: distinctPatients.size,
      units_still_on_hand: onHand,
      units_to_quarantine: batches
        .filter((batch: any) => batch.action === 'quarantine')
        .reduce((total: number, batch: any) => total + batch.quantity_on_hand, 0),
      first_sold_at: soldAts[0] ?? null,
      last_sold_at: soldAts[soldAts.length - 1] ?? null,
      unconfirmed_lines: unconfirmed.length,
    },
    truncated,
    limit,
    // The part that is easy to leave out and dangerous to. A confident list
    // that quietly missed the pharmacy's oldest stock would be acted on.
    caveat:
      unconfirmed.length > 0
        ? `${unconfirmed.length} of these lines were sold before batch tracking was installed. They match the lot number the product was showing at the time, not the lot this line drew from, so treat them as leads to check rather than confirmed exposure.`
        : null,
    no_batch_on_file:
      batches.length === 0 && sales.length > 0
        ? 'No batch on file matches this lot. Every line below was matched on the lot number recorded on the receipt.'
        : null,
  };
}

/**
 * Who was sold a recalled lot, and what is still on the shelf.
 *
 * Owner and pharmacist only: the answer is a list of named patients with their
 * telephone numbers, which is exactly what a recall needs and exactly what a
 * cashier at the till has no business pulling up.
 */
router.get(
  '/recall',
  authorize(UserRole.PHARMACY_OWNER, UserRole.PHARMACIST),
  validate([
    query('inventory_id').optional().isUUID().withMessage('inventory_id must be a valid id'),
    query('from').optional().isDate().withMessage('from must be a date'),
    query('to').optional().isDate().withMessage('to must be a date'),
  ]),
  async (req: Request, res: Response) => {
    try {
      if (!(await hasBatchTables(db))) {
        return res.status(501).json({ success: false, message: RECALL_NEEDS_003 });
      }

      const text = (value: unknown) =>
        typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

      const batchNumber = text(req.query.batch_number);
      const productName = text(req.query.product_name);
      const inventoryId = text(req.query.inventory_id);
      const from = text(req.query.from);
      const to = text(req.query.to);

      if (!batchNumber && !productName && !inventoryId) {
        return res.status(400).json({
          success: false,
          message:
            'A recall needs a lot number, a product, or both — without one this would return every sale the pharmacy has ever made',
        });
      }
      if (from && to && from.slice(0, 10) > to.slice(0, 10)) {
        return res.status(400).json({
          success: false,
          message: 'The from date is after the to date',
        });
      }

      const result = await runRecall(
        { pharmacyId: req.user!.pharmacyId, batchNumber, inventoryId, productName, from, to },
        clampRecallLimit(req.query.limit)
      );

      res.json({
        success: true,
        data: {
          search: { batch_number: batchNumber, product_name: productName, inventory_id: inventoryId, from, to },
          ...result,
        },
      });
    } catch (error) {
      logger.error('Failed to run recall trace', error);
      res.status(500).json({ success: false, message: 'Failed to trace the recall' });
    }
  }
);

/**
 * The same trace, entered from one batch.
 *
 * Resolves the batch to its lot and product and runs the identical search, so
 * the two ways in cannot disagree about what counts as exposure. Narrowing to
 * the product as well as the lot matters: lot numbers are only unique within a
 * medicine, and two products sharing one would otherwise pull each other's
 * sales into the recall.
 */
router.get(
  '/batches/:batchId/sales',
  authorize(UserRole.PHARMACY_OWNER, UserRole.PHARMACIST),
  validate([param('batchId').isUUID()]),
  async (req: Request, res: Response) => {
    try {
      const pharmacyId = req.user!.pharmacyId;

      if (!(await hasBatchTables(db))) {
        return res.status(501).json({ success: false, message: RECALL_NEEDS_003 });
      }

      const found = await db.query(
        `SELECT b.id, b.inventory_id, b.batch_number
           FROM inventory_batches b
          WHERE b.id = $1 AND b.pharmacy_id = $2`,
        [req.params.batchId, pharmacyId]
      );
      if (found.rows.length === 0) {
        return res.status(404).json({ success: false, message: 'Batch not found' });
      }

      const batch = found.rows[0];
      const result = await runRecall(
        {
          pharmacyId,
          batchNumber: batch.batch_number,
          inventoryId: batch.inventory_id,
        },
        clampRecallLimit(req.query.limit)
      );

      res.json({
        success: true,
        data: {
          search: {
            batch_id: batch.id,
            batch_number: batch.batch_number,
            inventory_id: batch.inventory_id,
            from: null,
            to: null,
          },
          ...result,
        },
      });
    } catch (error) {
      logger.error('Failed to trace sales for a batch', error);
      res.status(500).json({ success: false, message: 'Failed to trace sales for this batch' });
    }
  }
);

// ============ EXPIRING SOON ============
router.get('/expiring', async (req: Request, res: Response) => {
  try {
    const days = parseInt(req.query.days as string) || 90;
    // make_interval rather than an interpolated INTERVAL '${days} days'. The
    // parseInt above already makes this safe, but a query string built by
    // concatenation is one refactor away from not being safe, and there is no
    // reason to leave the pattern sitting here for somebody to copy.
    const result = await db.query(
      `SELECT * FROM inventory
       WHERE pharmacy_id = $1 AND is_active = true
         AND expiry_date <= CURRENT_DATE + make_interval(days => $2)
         AND expiry_date >= CURRENT_DATE
       ORDER BY expiry_date ASC`,
      [req.user!.pharmacyId, days]
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to load expiring items' });
  }
});

// ============ LOW STOCK ============
router.get('/low-stock', async (req: Request, res: Response) => {
  try {
    const result = await db.query(
      `SELECT * FROM inventory
       WHERE pharmacy_id = $1 AND is_active = true AND quantity <= reorder_level
       ORDER BY (quantity::float / GREATEST(reorder_level, 1)) ASC`,
      [req.user!.pharmacyId]
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to load low stock items' });
  }
});

// ============ BULK UPLOAD ============
router.post(
  '/bulk-upload',
  authorize(UserRole.PHARMACY_OWNER, UserRole.PHARMACIST),
  async (req: Request, res: Response) => {
    try {
      const { items } = req.body;
      if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ success: false, message: 'No items provided' });
      }

      if (items.length > 500) {
        return res.status(400).json({ success: false, message: 'Maximum 500 items per upload' });
      }

      let inserted = 0;
      let suggested = 0;
      let batched = 0;
      let errors: string[] = [];
      /** The rows that made it in, so one refresh covers the whole import. */
      const imported: string[] = [];

      await db.transaction(async (client) => {
        const batchesAvailable = await hasBatchTables(client);

        for (let i = 0; i < items.length; i++) {
          // A savepoint per row. Without one, the first bad row aborts the whole
          // transaction and every row after it fails with "current transaction
          // is aborted" — so a CSV with a duplicate product code in row 3 would
          // report 497 errors that are really one, and import nothing.
          const savepoint = `row_${i}`;
          await client.query(`SAVEPOINT ${savepoint}`);

          try {
            const item = items[i];
            // A CSV almost never carries a VAT column, so classify from the
            // category and report how many rows were decided automatically.
            const hasTreatment = ['standard', 'exempt', 'zero_rated'].includes(item.vat_treatment);
            const vatTreatment = hasTreatment
              ? item.vat_treatment
              : suggestVatTreatment(item.category, item.product_name);
            if (!hasTreatment) suggested++;

            const id = uuidv4();
            const openingQuantity = Math.max(parseInt(String(item.quantity), 10) || 0, 0);

            await client.query(
              `INSERT INTO inventory (id, pharmacy_id, product_name, product_code, generic_name, category,
                quantity, unit_price, cost_price, expiry_date, reorder_level, requires_prescription,
                vat_treatment)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
              [id, req.user!.pharmacyId, item.product_name, item.product_code,
               item.generic_name || null, item.category || null, openingQuantity,
               item.unit_price || 0, item.cost_price || 0, item.expiry_date,
               item.reorder_level || 10, item.requires_prescription || false,
               vatTreatment]
            );

            // The same reason POST / does it: an opening balance left on the
            // product row survives only until the first delivery against a lot,
            // at which point the derived-stock trigger recomputes the row from
            // the batches and the imported quantity disappears. A whole CSV of
            // stock silently going to zero is worse than one product doing it.
            if (openingQuantity > 0 && batchesAvailable) {
              const opening = await client.query(
                `INSERT INTO inventory_batches
                   (pharmacy_id, inventory_id, batch_number, expiry_date, quantity,
                    cost_price, received_at, received_by, is_backfill)
                 VALUES ($1,$2,$3,$4,$5,$6,CURRENT_DATE,$7,false)
                 RETURNING id`,
                [req.user!.pharmacyId, id,
                 String(item.batch_number || '').trim() || 'OPENING',
                 item.expiry_date, openingQuantity, item.cost_price || 0,
                 req.user!.userId]
              );

              await recordMovement(client, {
                pharmacyId: req.user!.pharmacyId,
                inventoryId: id,
                batchId: opening.rows[0].id,
                quantityChange: openingQuantity,
                quantityAfter: openingQuantity,
                reason: 'opening_balance',
                note: 'Imported with the product',
                userId: req.user!.userId,
              });
              batched++;
            }

            await client.query(`RELEASE SAVEPOINT ${savepoint}`);
            inserted++;
            imported.push(id);
          } catch (err: any) {
            await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
            await client.query(`RELEASE SAVEPOINT ${savepoint}`);
            errors.push(`Row ${i + 1}: ${err.message}`);
          }
        }
      });

      await cacheDel(`inventory:${req.user!.pharmacyId}:*`);

      // One refresh for the whole import rather than one per row: a CSV of 500
      // products is 500 alerts at once on a pharmacy that has just opened, and
      // the rows that failed are not in the list.
      await refreshStockAlertsFor(
        db,
        req.user!.pharmacyId,
        imported,
        'inventory.bulk-upload'
      );

      res.json({
        success: true,
        message: `${inserted} items imported, ${errors.length} errors`,
        data: {
          inserted,
          errors: errors.slice(0, 20),
          totalErrors: errors.length,
          vat_classified_automatically: suggested,
          // Reported so an import that created products but no batches — the
          // migration not being applied yet — is visible rather than assumed.
          opening_batches_created: batched,
        },
      });
    } catch (error) {
      logger.error('Bulk upload failed', error);
      res.status(500).json({ success: false, message: 'Bulk upload failed' });
    }
  }
);

// ============ GET CATEGORIES ============
router.get('/categories/list', async (req: Request, res: Response) => {
  try {
    const result = await db.query(
      `SELECT DISTINCT category, COUNT(*) as count FROM inventory
       WHERE pharmacy_id = $1 AND is_active = true AND category IS NOT NULL
       GROUP BY category ORDER BY category`,
      [req.user!.pharmacyId]
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to load categories' });
  }
});

// ============ VAT CLASSIFICATION REFERENCE ============
// Drives the "VAT treatment" field in the inventory form. Passing an optional
// category and product name also returns a suggested classification, so the
// pharmacist sees a reasoned default rather than having to know Act 1151.
router.get('/vat-treatments', (req: Request, res: Response) => {
  const { category, product_name } = req.query;
  const rates = resolveTaxRates(null);

  res.json({
    success: true,
    data: {
      options: [
        {
          value: 'exempt',
          label: 'Exempt — no VAT',
          description:
            'First Schedule supplies: essential drugs in Chapter 30 of the 2022 Harmonised System, plus mosquito nets. No VAT, NHIL or GETFund levy is charged, and the value is still declared on the return.',
        },
        {
          value: 'standard',
          label: `Standard — ${describeRates(rates).join(' + ')}`,
          description:
            'Everything else a pharmacy sells: toiletries and cosmetics, soaps and sanitisers, thermometers and blood-pressure monitors, baby food, snacks and drinks. All three charges apply to the same taxable value.',
        },
        {
          value: 'zero_rated',
          label: 'Zero-rated — taxable at 0%',
          description:
            'Second Schedule supplies. Taxable at 0%, so input tax remains creditable. Rarely correct for a retail pharmacy shelf — only use it if you are sure.',
        },
      ],
      rates,
      vat_registered_default: true,
      registration_threshold_ghs: 750000,
      // Only offered when the caller gave something to classify.
      ...(category || product_name
        ? {
            suggestion: suggestVatTreatment(
              typeof category === 'string' ? category : null,
              typeof product_name === 'string' ? product_name : null
            ),
          }
        : {}),
    },
  });
});

// ============ GET SINGLE ITEM ============
// Declared last among the GET routes: "/:id" would otherwise swallow
// /summary, /expiring, /low-stock and /categories/list and fail UUID validation.
router.get('/:id', validate([param('id').isUUID()]), async (req: Request, res: Response) => {
  try {
    const result = await db.query(
      'SELECT * FROM inventory WHERE id = $1 AND pharmacy_id = $2',
      [req.params.id, req.user!.pharmacyId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Item not found' });
    }
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to load item' });
  }
});

export default router;
