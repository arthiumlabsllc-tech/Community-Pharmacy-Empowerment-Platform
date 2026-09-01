import { Router, Request, Response } from 'express';
import { body, param, query } from 'express-validator';
import { v4 as uuidv4 } from 'uuid';
import db from '../config/database';
import { cacheGet, cacheSet, cacheDel } from '../config/redis';
import { authenticate, authorize } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import { auditLog } from '../middleware/audit.middleware';
import { UserRole } from '../types';
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

// ============ GET SINGLE ITEM ============
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
  ]),
  async (req: Request, res: Response) => {
    try {
      const {
        product_name, product_code, generic_name, category, manufacturer,
        batch_number, quantity, unit_price, cost_price, expiry_date,
        reorder_level, shelf_location, barcode, requires_prescription,
      } = req.body;

      const id = uuidv4();
      const result = await db.query(
        `INSERT INTO inventory (id, pharmacy_id, product_name, product_code, generic_name, category,
          manufacturer, batch_number, quantity, unit_price, cost_price, expiry_date,
          reorder_level, shelf_location, barcode, requires_prescription)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
         RETURNING *`,
        [id, req.user!.pharmacyId, product_name, product_code, generic_name || null,
         category || null, manufacturer || null, batch_number || null, quantity,
         unit_price, cost_price, expiry_date, reorder_level, shelf_location || null,
         barcode || null, requires_prescription || false]
      );

      await cacheDel(`inventory:${req.user!.pharmacyId}:*`);

      res.status(201).json({ success: true, message: 'Item added to inventory', data: result.rows[0] });
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
  validate([param('id').isUUID()]),
  async (req: Request, res: Response) => {
    try {
      const {
        product_name, product_code, generic_name, category, manufacturer,
        batch_number, quantity, unit_price, cost_price, expiry_date,
        reorder_level, shelf_location, barcode, requires_prescription,
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
          requires_prescription = COALESCE($16, requires_prescription)
         WHERE id = $1 AND pharmacy_id = $2
         RETURNING *`,
        [req.params.id, req.user!.pharmacyId, product_name, product_code, generic_name,
         category, manufacturer, batch_number, quantity, unit_price, cost_price,
         expiry_date, reorder_level, shelf_location, barcode, requires_prescription]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ success: false, message: 'Item not found' });
      }

      res.json({ success: true, message: 'Item updated', data: result.rows[0] });
    } catch (error) {
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
      let errors: string[] = [];

      await db.transaction(async (client) => {
        for (let i = 0; i < items.length; i++) {
          try {
            const item = items[i];
            await client.query(
              `INSERT INTO inventory (id, pharmacy_id, product_name, product_code, generic_name, category,
                quantity, unit_price, cost_price, expiry_date, reorder_level, requires_prescription)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
              [uuidv4(), req.user!.pharmacyId, item.product_name, item.product_code,
               item.generic_name || null, item.category || null, item.quantity || 0,
               item.unit_price || 0, item.cost_price || 0, item.expiry_date,
               item.reorder_level || 10, item.requires_prescription || false]
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
        data: { inserted, errors: errors.slice(0, 20), totalErrors: errors.length },
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

export default router;
