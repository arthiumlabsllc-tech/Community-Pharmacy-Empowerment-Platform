import { Router, Request, Response } from 'express';
import { body } from 'express-validator';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import db from '../config/database';
import { cacheGet, cacheSet, cacheDel } from '../config/redis';
import { authenticate } from '../middleware/auth.middleware';
import { authorize } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import { auditLog } from '../middleware/audit.middleware';
import { UserRole } from '../types';
import logger from '../utils/logger';

const router = Router();

// All pharmacy routes require authentication
router.use(authenticate);
router.use(auditLog);

// ============ GET PHARMACY PROFILE ============
router.get('/profile', async (req: Request, res: Response) => {
  try {
    const cacheKey = `pharmacy:${req.user!.pharmacyId}`;
    const cached = await cacheGet(cacheKey);
    if (cached) {
      return res.json({ success: true, data: cached });
    }

    const result = await db.query(
      `SELECT p.*, 
              (SELECT COUNT(*) FROM users u WHERE u.pharmacy_id = p.id AND u.is_active = true) as staff_count,
              (SELECT COUNT(*) FROM patients pat WHERE pat.pharmacy_id = p.id AND pat.is_active = true) as patient_count,
              (SELECT COUNT(*) FROM inventory i WHERE i.pharmacy_id = p.id AND i.is_active = true) as inventory_count
       FROM pharmacies p WHERE p.id = $1`,
      [req.user!.pharmacyId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Pharmacy not found' });
    }

    const pharmacy = result.rows[0];
    await cacheSet(cacheKey, pharmacy, 300); // 5 min cache

    res.json({ success: true, data: pharmacy });
  } catch (error) {
    logger.error('Failed to fetch pharmacy profile', error);
    res.status(500).json({ success: false, message: 'Failed to load pharmacy profile' });
  }
});

// ============ UPDATE PHARMACY PROFILE ============
router.put(
  '/profile',
  authorize(UserRole.PHARMACY_OWNER, UserRole.PHARMACIST),
  validate([
    body('name').optional().trim().notEmpty(),
    body('phone').optional().trim().notEmpty(),
  ]),
  async (req: Request, res: Response) => {
    try {
      const { name, phone, email, location, region, district, gps_address, settings } = req.body;

      const result = await db.query(
        `UPDATE pharmacies SET
          name = COALESCE($2, name),
          phone = COALESCE($3, phone),
          email = COALESCE($4, email),
          location = COALESCE($5, location),
          region = COALESCE($6, region),
          district = COALESCE($7, district),
          gps_address = COALESCE($8, gps_address),
          settings = COALESCE($9, settings)
         WHERE id = $1
         RETURNING *`,
        [req.user!.pharmacyId, name, phone, email, location, region, district, gps_address, settings]
      );

      await cacheDel(`pharmacy:${req.user!.pharmacyId}`);

      res.json({ success: true, message: 'Pharmacy profile updated', data: result.rows[0] });
    } catch (error) {
      logger.error('Failed to update pharmacy profile', error);
      res.status(500).json({ success: false, message: 'Failed to update pharmacy profile' });
    }
  }
);

// ============ PHARMACY ANALYTICS ============
router.get('/analytics', async (req: Request, res: Response) => {
  try {
    const pharmacyId = req.user!.pharmacyId;
    const { period = '30' } = req.query;
    const days = parseInt(period as string, 10);

    // Run analytics queries in parallel
    const [
      salesData,
      prescriptionData,
      claimData,
      patientGrowth,
      topMedications,
      revenueByCategory,
    ] = await Promise.all([
      // Daily sales for the period
      db.query(
        `SELECT DATE(pr.filled_date) as date, COUNT(*) as count,
                SUM((pr.medication_details->0->>'quantity')::int * (pr.medication_details->0->>'unit_price')::numeric) as revenue
         FROM prescriptions pr
         WHERE pr.pharmacy_id = $1 AND pr.filled_date >= NOW() - INTERVAL '${days} days'
         GROUP BY DATE(pr.filled_date) ORDER BY date`,
        [pharmacyId]
      ),
      // Prescription stats
      db.query(
        `SELECT status, COUNT(*) as count
         FROM prescriptions WHERE pharmacy_id = $1
         GROUP BY status`,
        [pharmacyId]
      ),
      // NHIS claim stats
      db.query(
        `SELECT status, COUNT(*) as count, COALESCE(SUM(total_amount), 0) as total_amount
         FROM nhis_claims WHERE pharmacy_id = $1
         GROUP BY status`,
        [pharmacyId]
      ),
      // Patient growth
      db.query(
        `SELECT DATE(created_at) as date, COUNT(*) as new_patients
         FROM patients
         WHERE pharmacy_id = $1 AND created_at >= NOW() - INTERVAL '${days} days'
         GROUP BY DATE(created_at) ORDER BY date`,
        [pharmacyId]
      ),
      // Top medications (from inventory)
      db.query(
        `SELECT product_name, category, quantity, unit_price
         FROM inventory
         WHERE pharmacy_id = $1 AND is_active = true
         ORDER BY quantity DESC LIMIT 10`,
        [pharmacyId]
      ),
      // Revenue by category
      db.query(
        `SELECT category, COUNT(*) as item_count, SUM(quantity * unit_price) as total_value
         FROM inventory
         WHERE pharmacy_id = $1 AND is_active = true
         GROUP BY category ORDER BY total_value DESC`,
        [pharmacyId]
      ),
    ]);

    // Calculate summary metrics
    const totalPatients = await db.query(
      'SELECT COUNT(*) as count FROM patients WHERE pharmacy_id = $1 AND is_active = true',
      [pharmacyId]
    );
    const totalInventory = await db.query(
      'SELECT COUNT(*) as count, SUM(quantity) as total_units FROM inventory WHERE pharmacy_id = $1 AND is_active = true',
      [pharmacyId]
    );
    const lowStock = await db.query(
      'SELECT COUNT(*) as count FROM inventory WHERE pharmacy_id = $1 AND quantity <= reorder_level AND is_active = true',
      [pharmacyId]
    );
    const expiringSoon = await db.query(
      `SELECT COUNT(*) as count FROM inventory
       WHERE pharmacy_id = $1 AND expiry_date <= CURRENT_DATE + INTERVAL '90 days' AND is_active = true`,
      [pharmacyId]
    );

    res.json({
      success: true,
      data: {
        summary: {
          totalPatients: parseInt(totalPatients.rows[0].count, 10),
          totalInventoryItems: parseInt(totalInventory.rows[0].count, 10),
          totalInventoryUnits: parseInt(totalInventory.rows[0].total_units || '0', 10),
          lowStockItems: parseInt(lowStock.rows[0].count, 10),
          expiringSoonItems: parseInt(expiringSoon.rows[0].count, 10),
        },
        sales: salesData.rows,
        prescriptions: prescriptionData.rows,
        claims: claimData.rows,
        patientGrowth: patientGrowth.rows,
        topMedications: topMedications.rows,
        revenueByCategory: revenueByCategory.rows,
      },
    });
  } catch (error) {
    logger.error('Failed to fetch analytics', error);
    res.status(500).json({ success: false, message: 'Failed to load analytics' });
  }
});

// ============ PERFORMANCE SCORE ============
router.get('/performance-score', async (req: Request, res: Response) => {
  try {
    const pharmacyId = req.user!.pharmacyId;

    // Calculate composite performance score (0-100)
    const [claimStats, inventoryHealth, patientEngagement, screeningCount] = await Promise.all([
      db.query(
        `SELECT
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE status = 'approved') as approved,
          COUNT(*) FILTER (WHERE status = 'rejected') as rejected
         FROM nhis_claims WHERE pharmacy_id = $1 AND submitted_at >= NOW() - INTERVAL '90 days'`,
        [pharmacyId]
      ),
      db.query(
        `SELECT
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE quantity <= reorder_level) as low_stock,
          COUNT(*) FILTER (WHERE expiry_date <= CURRENT_DATE + INTERVAL '30 days') as expiring
         FROM inventory WHERE pharmacy_id = $1 AND is_active = true`,
        [pharmacyId]
      ),
      db.query(
        `SELECT COUNT(DISTINCT patient_id) as active_patients
         FROM prescriptions
         WHERE pharmacy_id = $1 AND filled_date >= NOW() - INTERVAL '30 days'`,
        [pharmacyId]
      ),
      db.query(
        `SELECT COUNT(*) as screenings
         FROM screenings
         WHERE pharmacy_id = $1 AND recorded_at >= NOW() - INTERVAL '30 days'`,
        [pharmacyId]
      ),
    ]);

    // Score calculation
    let claimApprovalScore = 0;
    if (parseInt(claimStats.rows[0].total) > 0) {
      claimApprovalScore = (parseInt(claimStats.rows[0].approved) / parseInt(claimStats.rows[0].total)) * 100;
    }

    let inventoryScore = 100;
    if (parseInt(inventoryHealth.rows[0].total) > 0) {
      const lowStockPenalty = (parseInt(inventoryHealth.rows[0].low_stock) / parseInt(inventoryHealth.rows[0].total)) * 50;
      const expiringPenalty = (parseInt(inventoryHealth.rows[0].expiring) / parseInt(inventoryHealth.rows[0].total)) * 50;
      inventoryScore = Math.max(0, 100 - lowStockPenalty - expiringPenalty);
    }

    const engagementScore = Math.min(100, parseInt(patientEngagement.rows[0].active_patients) * 2);
    const screeningScore = Math.min(100, parseInt(screeningCount.rows[0].screenings) * 5);

    const overallScore = Math.round(
      claimApprovalScore * 0.3 +
      inventoryScore * 0.25 +
      engagementScore * 0.25 +
      screeningScore * 0.2
    );

    res.json({
      success: true,
      data: {
        overall_score: overallScore,
        breakdown: {
          claim_approval: { score: Math.round(claimApprovalScore), weight: 30 },
          inventory_health: { score: Math.round(inventoryScore), weight: 25 },
          patient_engagement: { score: Math.round(engagementScore), weight: 25 },
          health_screenings: { score: Math.round(screeningScore), weight: 20 },
        },
        rating: overallScore >= 80 ? 'excellent' : overallScore >= 60 ? 'good' : overallScore >= 40 ? 'fair' : 'needs_improvement',
      },
    });
  } catch (error) {
    logger.error('Failed to calculate performance score', error);
    res.status(500).json({ success: false, message: 'Failed to calculate performance score' });
  }
});

// ============ LIST PHARMACY STAFF ============
router.get('/staff', async (req: Request, res: Response) => {
  try {
    const result = await db.query(
      `SELECT id, first_name, last_name, email, phone, role, avatar_url, is_active, last_login_at, created_at
       FROM users WHERE pharmacy_id = $1 ORDER BY created_at DESC`,
      [req.user!.pharmacyId]
    );

    res.json({ success: true, data: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to load staff' });
  }
});

// ============ ADD STAFF MEMBER ============
router.post(
  '/staff',
  authorize(UserRole.PHARMACY_OWNER),
  validate([
    body('email').isEmail().withMessage('Valid email is required'),
    body('first_name').trim().notEmpty(),
    body('last_name').trim().notEmpty(),
    body('role').isIn(['pharmacist', 'staff']).withMessage('Role must be pharmacist or staff'),
  ]),
  async (req: Request, res: Response) => {
    try {
      const { email, first_name, last_name, phone, role } = req.body;
      const id = uuidv4();

      // Generate a temporary password
      const tempPassword = uuidv4().substring(0, 8);
      const password_hash = await bcrypt.hash(tempPassword, 12);

      await db.query(
        `INSERT INTO users (id, pharmacy_id, role, first_name, last_name, email, phone, password_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, req.user!.pharmacyId, role, first_name, last_name, email, phone || null, password_hash]
      );

      res.status(201).json({
        success: true,
        message: `Staff member added. Temporary password: ${tempPassword}`,
        data: { id, first_name, last_name, email, role, temp_password: tempPassword },
      });
    } catch (error: any) {
      if (error.code === '23505') {
        return res.status(409).json({ success: false, message: 'A user with this email already exists' });
      }
      res.status(500).json({ success: false, message: 'Failed to add staff member' });
    }
  }
);

export default router;
