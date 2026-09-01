import { Router, Request, Response } from 'express';
import { body, query } from 'express-validator';
import db from '../config/database';
import { authenticate, authorize } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import { UserRole } from '../types';
import logger from '../utils/logger';

const router = Router();
router.use(authenticate);
router.use(authorize(UserRole.SUPER_ADMIN));

// ============ SYSTEM ANALYTICS ============
router.get('/analytics', async (_req: Request, res: Response) => {
  try {
    const [pharmacyStats, userStats, claimStats, revenueStats] = await Promise.all([
      db.query(
        `SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE is_active = true) as active,
                COUNT(*) FILTER (WHERE subscription_tier = 'premium') as premium,
                COUNT(*) FILTER (WHERE subscription_tier = 'enterprise') as enterprise,
                COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days') as new_this_month
         FROM pharmacies`
      ),
      db.query(
        `SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE is_active = true) as active
         FROM users`
      ),
      db.query(
        `SELECT COUNT(*) as total,
                COUNT(*) FILTER (WHERE status = 'approved') as approved,
                COUNT(*) FILTER (WHERE status = 'submitted') as pending,
                COALESCE(SUM(total_amount), 0) as total_amount
         FROM nhis_claims`
      ),
      db.query(
        `SELECT COALESCE(SUM(amount), 0) as total_revenue,
                COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days') as payments_this_month
         FROM payments WHERE status = 'completed'`
      ),
    ]);

    res.json({
      success: true,
      data: {
        pharmacies: pharmacyStats.rows[0],
        users: userStats.rows[0],
        claims: claimStats.rows[0],
        revenue: revenueStats.rows[0],
      },
    });
  } catch (error) {
    logger.error('Admin analytics failed', error);
    res.status(500).json({ success: false, message: 'Failed to load analytics' });
  }
});

// ============ LIST ALL PHARMACIES ============
router.get('/pharmacies', async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const offset = (page - 1) * limit;
    const { search, tier, active } = req.query;

    let whereClause = 'WHERE 1=1';
    const params: any[] = [];
    let idx = 1;

    if (search) {
      whereClause += ` AND (p.name ILIKE $${idx} OR p.license_number ILIKE $${idx})`;
      params.push(`%${search}%`);
      idx++;
    }
    if (tier) { whereClause += ` AND p.subscription_tier = $${idx}`; params.push(tier); idx++; }
    if (active !== undefined) { whereClause += ` AND p.is_active = $${idx}`; params.push(active === 'true'); idx++; }

    const [countResult, dataResult] = await Promise.all([
      db.query(`SELECT COUNT(*) as total FROM pharmacies p ${whereClause}`, params),
      db.query(
        `SELECT p.*, (SELECT COUNT(*) FROM users WHERE pharmacy_id = p.id) as user_count
         FROM pharmacies p ${whereClause} ORDER BY p.created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
        [...params, limit, offset]
      ),
    ]);

    const total = parseInt(countResult.rows[0].total, 10);
    res.json({
      success: true,
      data: dataResult.rows,
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to load pharmacies' });
  }
});

// ============ FEATURE FLAGS ============
router.get('/feature-flags', async (_req: Request, res: Response) => {
  try {
    const result = await db.query('SELECT * FROM feature_flags ORDER BY name');
    res.json({ success: true, data: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to load feature flags' });
  }
});

router.post('/feature-flags', validate([body('name').trim().notEmpty()]), async (req: Request, res: Response) => {
  try {
    const { name, description, is_enabled, rollout_percentage } = req.body;
    const { v4: uuidv4 } = require('uuid');

    const result = await db.query(
      `INSERT INTO feature_flags (id, name, description, is_enabled, rollout_percentage)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [uuidv4(), name, description || null, is_enabled || false, rollout_percentage || 0]
    );

    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error: any) {
    if (error.code === '23505') {
      return res.status(409).json({ success: false, message: 'Feature flag with this name already exists' });
    }
    res.status(500).json({ success: false, message: 'Failed to create feature flag' });
  }
});

// ============ AUDIT LOGS ============
router.get('/audit-logs', async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
    const offset = (page - 1) * limit;
    const { pharmacy_id, user_id, action } = req.query;

    let whereClause = 'WHERE 1=1';
    const params: any[] = [];
    let idx = 1;

    if (pharmacy_id) { whereClause += ` AND a.pharmacy_id = $${idx}`; params.push(pharmacy_id); idx++; }
    if (user_id) { whereClause += ` AND a.user_id = $${idx}`; params.push(user_id); idx++; }
    if (action) { whereClause += ` AND a.action ILIKE $${idx}`; params.push(`%${action}%`); idx++; }

    const result = await db.query(
      `SELECT a.*, u.first_name || ' ' || u.last_name as user_name, p.name as pharmacy_name
       FROM audit_logs a
       LEFT JOIN users u ON a.user_id = u.id
       LEFT JOIN pharmacies p ON a.pharmacy_id = p.id
       ${whereClause}
       ORDER BY a.created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, limit, offset]
    );

    res.json({ success: true, data: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to load audit logs' });
  }
});

export default router;
