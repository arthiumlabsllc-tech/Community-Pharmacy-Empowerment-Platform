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
import { describeRates, resolveTaxRates, round2, type TaxRates } from '../utils/ghana-tax';
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

// ============ VAT SETTINGS (Act 1151) ============
// Read/write of pharmacies.settings.tax only. Going through jsonb_set rather
// than replacing the whole settings object keeps any other configuration the
// pharmacy has stored from being wiped by a tax-only save.
router.get('/tax-settings', async (req: Request, res: Response) => {
  try {
    const result = await db.query('SELECT settings FROM pharmacies WHERE id = $1', [
      req.user!.pharmacyId,
    ]);
    const tax = result.rows[0]?.settings?.tax || {};
    const rates = resolveTaxRates(tax.rates);

    res.json({
      success: true,
      data: {
        vat_registered: tax.vat_registered !== false,
        pricing_mode: tax.pricing_mode === 'exclusive' ? 'exclusive' : 'inclusive',
        rates,
        rate_labels: describeRates(rates),
        effective_standard_rate: round2(
          (rates.vat + rates.nhil + rates.getfund) * 100
        ),
        registration_threshold_ghs: 750000,
      },
    });
  } catch (error) {
    logger.error('Failed to load tax settings', error);
    res.status(500).json({ success: false, message: 'Failed to load tax settings' });
  }
});

router.put(
  '/tax-settings',
  authorize(UserRole.PHARMACY_OWNER),
  validate([
    body('vat_registered').optional().isBoolean().withMessage('vat_registered must be true or false'),
    body('pricing_mode').optional().isIn(['inclusive', 'exclusive'])
      .withMessage('pricing_mode must be inclusive or exclusive'),
    body('rates.vat').optional().isFloat({ min: 0, max: 0.5 }).withMessage('VAT rate must be between 0 and 0.5'),
    body('rates.nhil').optional().isFloat({ min: 0, max: 0.5 }).withMessage('NHIL rate must be between 0 and 0.5'),
    body('rates.getfund').optional().isFloat({ min: 0, max: 0.5 })
      .withMessage('GETFund levy must be between 0 and 0.5'),
  ]),
  async (req: Request, res: Response) => {
    try {
      const { vat_registered, pricing_mode, rates } = req.body;

      const next: {
        vat_registered: boolean;
        pricing_mode: 'inclusive' | 'exclusive';
        rates?: Partial<TaxRates>;
        updated_at: string;
      } = {
        // Stored explicitly, including the values that match the defaults, so
        // a later change to the statutory rate cannot silently rewrite what
        // this pharmacy agreed to.
        vat_registered: vat_registered === undefined ? true : vat_registered === true,
        pricing_mode: pricing_mode === 'exclusive' ? 'exclusive' : 'inclusive',
        updated_at: new Date().toISOString(),
      };
      if (rates && typeof rates === 'object') next.rates = rates as Partial<TaxRates>;

      const result = await db.query(
        `UPDATE pharmacies SET
           settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{tax}', $2::jsonb, true),
           updated_at = NOW()
         WHERE id = $1
         RETURNING settings`,
        [req.user!.pharmacyId, JSON.stringify(next)]
      );

      await cacheDel(`pharmacy:${req.user!.pharmacyId}`);

      const applied = resolveTaxRates(next.rates);
      res.json({
        success: true,
        message: next.vat_registered
          ? 'Tax settings saved'
          : 'Tax settings saved — this pharmacy is now marked as NOT VAT registered, so no VAT, NHIL or GETFund levy will be charged',
        data: {
          tax: result.rows[0].settings.tax,
          effective_rates: applied,
          rate_labels: describeRates(applied),
        },
      });
    } catch (error) {
      logger.error('Failed to update tax settings', error);
      res.status(500).json({ success: false, message: 'Failed to update tax settings' });
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
    // Bounded below by today. "Expiring soon" used to be every row whose date
    // had already passed as well, so a shelf full of stock that expired last
    // year counted towards the same number as one that goes off next month —
    // and the figure below feeds the performance score, where expired stock was
    // being read as merely urgent.
    const expiringSoon = await db.query(
      `SELECT COUNT(*) as count FROM inventory
       WHERE pharmacy_id = $1 AND expiry_date >= CURRENT_DATE
         AND expiry_date <= CURRENT_DATE + INTERVAL '90 days' AND is_active = true`,
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
          COUNT(*) FILTER (WHERE expiry_date >= CURRENT_DATE
                            AND expiry_date <= CURRENT_DATE + INTERVAL '30 days') as expiring
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

// ============ RECENT ACTIVITY FEED ============
// Merges the pharmacy's own records into a single timeline. Scoped to the
// authenticated user's pharmacy, so it is safe for all staff roles.
router.get('/activity', async (req: Request, res: Response) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit as string, 10) || 10, 1), 50);

    const result = await db.query(
      `SELECT kind, title, detail, at FROM (
         SELECT 'patient'::text AS kind,
                'New patient registered'::text AS title,
                p.first_name || ' ' || p.last_name AS detail,
                p.created_at AS at
         FROM patients p
         WHERE p.pharmacy_id = $1

         UNION ALL
         SELECT 'screening', 'Health screening recorded',
                p.first_name || ' ' || p.last_name || ' - ' || replace(s.type::text, '_', ' ') ||
                  ' (' || s.risk_level::text || ' risk)',
                s.recorded_at
         FROM screenings s JOIN patients p ON p.id = s.patient_id
         WHERE s.pharmacy_id = $1

         UNION ALL
         SELECT 'claim', 'NHIS claim ' || c.status::text,
                COALESCE(c.claim_number, 'unnumbered') || ' - ' || p.first_name || ' ' || p.last_name ||
                  ' - GHS ' || ROUND(c.total_amount, 2)::text,
                COALESCE(c.updated_at, c.created_at)
         FROM nhis_claims c JOIN patients p ON p.id = c.patient_id
         WHERE c.pharmacy_id = $1

         UNION ALL
         SELECT 'consultation', 'Consultation ' || c.status::text,
                p.first_name || ' ' || p.last_name || ' - ' || replace(c.type::text, '_', ' '),
                COALESCE(c.updated_at, c.created_at)
         FROM consultations c JOIN patients p ON p.id = c.patient_id
         WHERE c.pharmacy_id = $1

         UNION ALL
         SELECT 'prescription', 'Prescription ' || pr.status::text,
                p.first_name || ' ' || p.last_name ||
                  COALESCE(' - ' || pr.diagnosis, ''),
                COALESCE(pr.filled_date, pr.updated_at, pr.created_at)
         FROM prescriptions pr JOIN patients p ON p.id = pr.patient_id
         WHERE pr.pharmacy_id = $1
       ) activity
       ORDER BY at DESC NULLS LAST
       LIMIT $2`,
      [req.user!.pharmacyId, limit]
    );

    res.json({ success: true, data: result.rows });
  } catch (error) {
    logger.error('Failed to fetch pharmacy activity', error);
    res.status(500).json({ success: false, message: 'Failed to load recent activity' });
  }
});

// ============ LIST PHARMACY STAFF ============
// Readable by the owner and pharmacists only — cashier-level staff must not be
// able to enumerate their colleagues' contact details.
router.get('/staff', authorize(UserRole.PHARMACY_OWNER, UserRole.PHARMACIST), async (req: Request, res: Response) => {
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

// ============ UPDATE STAFF MEMBER (role / active status) ============
router.put(
  '/staff/:id',
  authorize(UserRole.PHARMACY_OWNER),
  validate([
    body('role').optional().isIn(['pharmacist', 'staff']).withMessage('Role must be pharmacist or staff'),
    body('is_active').optional().isBoolean().withMessage('is_active must be a boolean'),
  ]),
  async (req: Request, res: Response) => {
    try {
      const { role, is_active, phone, first_name, last_name } = req.body;

      // Prevent an owner from demoting or deactivating their own account
      if (req.params.id === req.user!.userId && (role || is_active === false)) {
        return res.status(400).json({
          success: false,
          message: 'You cannot change your own role or deactivate your own account',
        });
      }

      const result = await db.query(
        `UPDATE users SET
          role = COALESCE($3, role),
          is_active = COALESCE($4, is_active),
          phone = COALESCE($5, phone),
          first_name = COALESCE($6, first_name),
          last_name = COALESCE($7, last_name)
         WHERE id = $1 AND pharmacy_id = $2
         RETURNING id, first_name, last_name, email, phone, role, is_active, last_login_at`,
        [req.params.id, req.user!.pharmacyId, role, is_active, phone, first_name, last_name]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ success: false, message: 'Staff member not found' });
      }

      res.json({ success: true, message: 'Staff member updated', data: result.rows[0] });
    } catch (error) {
      logger.error('Failed to update staff member', error);
      res.status(500).json({ success: false, message: 'Failed to update staff member' });
    }
  }
);

// ============ STAFF PERFORMANCE SUMMARY ============
router.get('/staff-performance', authorize(UserRole.PHARMACY_OWNER, UserRole.PHARMACIST), async (req: Request, res: Response) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.period as string, 10) || 30, 1), 365);

    const result = await db.query(
      `SELECT u.id, u.first_name, u.last_name, u.role, u.is_active,
              COUNT(DISTINCT pr.id)::int as prescriptions_filled,
              COUNT(DISTINCT s.id)::int as screenings_recorded,
              COUNT(DISTINCT c.id)::int as consultations_held
       FROM users u
       LEFT JOIN prescriptions pr ON pr.filled_by = u.id
         AND pr.filled_date >= NOW() - ($1 || ' days')::interval
       LEFT JOIN screenings s ON s.recorded_by = u.id
         AND s.recorded_at >= NOW() - ($1 || ' days')::interval
       LEFT JOIN consultations c ON c.pharmacist_id = u.id
         AND c.scheduled_at >= NOW() - ($1 || ' days')::interval
       WHERE u.pharmacy_id = $2
       GROUP BY u.id, u.first_name, u.last_name, u.role, u.is_active
       ORDER BY prescriptions_filled DESC, screenings_recorded DESC`,
      [String(days), req.user!.pharmacyId]
    );

    res.json({ success: true, data: result.rows, period_days: days });
  } catch (error) {
    logger.error('Failed to load staff performance', error);
    res.status(500).json({ success: false, message: 'Failed to load staff performance' });
  }
});

export default router;
