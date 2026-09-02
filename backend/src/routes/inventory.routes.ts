import { Router, Request, Response } from 'express';
import { body, param, query } from 'express-validator';
import { v4 as uuidv4 } from 'uuid';
import db from '../config/database';
import { cacheGet, cacheSet, cacheDel } from '../config/redis';
import { authenticate, authorize } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import { auditLog } from '../middleware/audit.middleware';
import { UserRole } from '../types';
import { describeRates, resolveTaxRates, suggestVatTreatment } from '../utils/ghana-tax';
import logger from '../utils/logger';

const router = Router();

router.use(authenticate);
router.use(auditLog);

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
      const result = await db.query(
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

      await cacheDel(`inventory:${req.user!.pharmacyId}:*`);

      res.status(201).json({
        success: true,
        message: 'Item added to inventory',
        data: result.rows[0],
        vat_treatment_source: vatProvided ? 'provided' : 'suggested',
      });
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

      const result = await db.query(
        `UPDATE inventory SET
          product_name = COALESCE($3, product_name),
          product_code = COALESCE($4, product_code),
          generic_name = COALESCE($5, generic_name),
          category = COALESCE($6, category),
          manufacturer = COALESCE($7, manufacturer),
          batch_number = COALESCE($8, batch_number),
          quantity = COALESCE($9, quantity),
          unit_price = COALESCE($10, unit_price),
          cost_price = COALESCE($11, cost_price),
          expiry_date = COALESCE($12, expiry_date),
          reorder_level = COALESCE($13, reorder_level),
          shelf_location = COALESCE($14, shelf_location),
          barcode = COALESCE($15, barcode),
          requires_prescription = COALESCE($16, requires_prescription),
          vat_treatment = COALESCE($17, vat_treatment),
          pack_size = COALESCE($18, pack_size),
          default_sell_unit = COALESCE($19, default_sell_unit)
         WHERE id = $1 AND pharmacy_id = $2
         RETURNING *`,
        [req.params.id, req.user!.pharmacyId, product_name, product_code, generic_name,
         category, manufacturer, batch_number, quantity, unit_price, cost_price,
         expiry_date, reorder_level, shelf_location, barcode, requires_prescription,
         vat_treatment, pack_size, default_sell_unit]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ success: false, message: 'Item not found' });
      }

      await cacheDel(`inventory:${req.user!.pharmacyId}:*`);

      res.json({ success: true, message: 'Item updated', data: result.rows[0] });
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
      res.json({ success: true, message: 'Item removed from inventory' });
    } catch (error) {
      res.status(500).json({ success: false, message: 'Failed to delete item' });
    }
  }
);

// ============ EXPIRING SOON ============
router.get('/expiring', async (req: Request, res: Response) => {
  try {
    const days = parseInt(req.query.days as string) || 90;
    const result = await db.query(
      `SELECT * FROM inventory
       WHERE pharmacy_id = $1 AND is_active = true
         AND expiry_date <= CURRENT_DATE + INTERVAL '${days} days'
         AND expiry_date >= CURRENT_DATE
       ORDER BY expiry_date ASC`,
      [req.user!.pharmacyId]
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
      let errors: string[] = [];

      await db.transaction(async (client) => {
        for (let i = 0; i < items.length; i++) {
          try {
            const item = items[i];
            // A CSV almost never carries a VAT column, so classify from the
            // category and report how many rows were decided automatically.
            const hasTreatment = ['standard', 'exempt', 'zero_rated'].includes(item.vat_treatment);
            const vatTreatment = hasTreatment
              ? item.vat_treatment
              : suggestVatTreatment(item.category, item.product_name);
            if (!hasTreatment) suggested++;

            await client.query(
              `INSERT INTO inventory (id, pharmacy_id, product_name, product_code, generic_name, category,
                quantity, unit_price, cost_price, expiry_date, reorder_level, requires_prescription,
                vat_treatment)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
              [uuidv4(), req.user!.pharmacyId, item.product_name, item.product_code,
               item.generic_name || null, item.category || null, item.quantity || 0,
               item.unit_price || 0, item.cost_price || 0, item.expiry_date,
               item.reorder_level || 10, item.requires_prescription || false,
               vatTreatment]
            );
            inserted++;
          } catch (err: any) {
            errors.push(`Row ${i + 1}: ${err.message}`);
          }
        }
      });

      await cacheDel(`inventory:${req.user!.pharmacyId}:*`);

      res.json({
        success: true,
        message: `${inserted} items imported, ${errors.length} errors`,
        data: {
          inserted,
          errors: errors.slice(0, 20),
          totalErrors: errors.length,
          vat_classified_automatically: suggested,
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
