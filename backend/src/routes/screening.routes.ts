import { Router, Request, Response } from 'express';
import { param } from 'express-validator';
import db from '../config/database';
import { authenticate } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import { auditLog } from '../middleware/audit.middleware';
import logger from '../utils/logger';

const router = Router();
router.use(authenticate);
router.use(auditLog);

const SCREENING_TYPES = ['blood_pressure', 'blood_sugar', 'bmi', 'weight', 'temperature', 'heart_rate'];
const RISK_LEVELS = ['low', 'moderate', 'high', 'critical'];

// ============ LIST SCREENINGS (pharmacy-wide) ============
router.get('/', async (req: Request, res: Response) => {
  try {
    const pharmacyId = req.user!.pharmacyId;
    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const offset = (page - 1) * limit;
    const { type, risk_level, patient_id, search } = req.query;

    let whereClause = 'WHERE s.pharmacy_id = $1';
    const params: any[] = [pharmacyId];
    let idx = 2;

    if (type && SCREENING_TYPES.includes(type as string)) {
      whereClause += ` AND s.type = $${idx}`;
      params.push(type);
      idx++;
    }
    if (risk_level && RISK_LEVELS.includes(risk_level as string)) {
      whereClause += ` AND s.risk_level = $${idx}`;
      params.push(risk_level);
      idx++;
    }
    if (patient_id) {
      whereClause += ` AND s.patient_id = $${idx}`;
      params.push(patient_id);
      idx++;
    }
    if (search) {
      whereClause += ` AND (p.first_name ILIKE $${idx} OR p.last_name ILIKE $${idx})`;
      params.push(`%${search}%`);
      idx++;
    }

    const [countResult, dataResult] = await Promise.all([
      db.query(
        `SELECT COUNT(*) as total FROM screenings s JOIN patients p ON s.patient_id = p.id ${whereClause}`,
        params
      ),
      db.query(
        `SELECT s.*,
                p.first_name || ' ' || p.last_name as patient_name,
                p.phone as patient_phone,
                u.first_name || ' ' || u.last_name as recorded_by_name
         FROM screenings s
         JOIN patients p ON s.patient_id = p.id
         JOIN users u ON s.recorded_by = u.id
         ${whereClause}
         ORDER BY s.recorded_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
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
    logger.error('Failed to fetch screenings', error);
    res.status(500).json({ success: false, message: 'Failed to load screenings' });
  }
});

// ============ SCREENING SUMMARY STATS ============
router.get('/summary', async (req: Request, res: Response) => {
  try {
    const pharmacyId = req.user!.pharmacyId;

    const [totals, byRisk, thisWeek, referred, byType] = await Promise.all([
      db.query('SELECT COUNT(*)::int as count FROM screenings WHERE pharmacy_id = $1', [pharmacyId]),
      db.query(
        `SELECT risk_level, COUNT(*)::int as count FROM screenings
         WHERE pharmacy_id = $1 GROUP BY risk_level`,
        [pharmacyId]
      ),
      db.query(
        `SELECT COUNT(*)::int as count FROM screenings
         WHERE pharmacy_id = $1 AND recorded_at >= NOW() - INTERVAL '7 days'`,
        [pharmacyId]
      ),
      db.query(
        `SELECT COUNT(*)::int as count FROM screenings
         WHERE pharmacy_id = $1 AND referred_to_clinic = true`,
        [pharmacyId]
      ),
      db.query(
        `SELECT type, COUNT(*)::int as count FROM screenings
         WHERE pharmacy_id = $1 GROUP BY type ORDER BY count DESC`,
        [pharmacyId]
      ),
    ]);

    const riskCounts: Record<string, number> = { low: 0, moderate: 0, high: 0, critical: 0 };
    byRisk.rows.forEach((r: any) => { riskCounts[r.risk_level] = r.count; });

    res.json({
      success: true,
      data: {
        total: totals.rows[0].count,
        this_week: thisWeek.rows[0].count,
        referred_to_clinic: referred.rows[0].count,
        by_risk: riskCounts,
        high_risk: riskCounts.high + riskCounts.critical,
        by_type: byType.rows,
      },
    });
  } catch (error) {
    logger.error('Failed to compute screening summary', error);
    res.status(500).json({ success: false, message: 'Failed to load screening summary' });
  }
});

// ============ GET SINGLE SCREENING ============
router.get('/:id', validate([param('id').isUUID()]), async (req: Request, res: Response) => {
  try {
    const result = await db.query(
      `SELECT s.*, p.first_name || ' ' || p.last_name as patient_name
       FROM screenings s JOIN patients p ON s.patient_id = p.id
       WHERE s.id = $1 AND s.pharmacy_id = $2`,
      [req.params.id, req.user!.pharmacyId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Screening not found' });
    }
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to load screening' });
  }
});

// ============ RECORD SCREENING (without patient route prefix) ============
router.post(
  '/',
  async (req: Request, res: Response) => {
    try {
      const { patient_id, type, systolic, diastolic, value, unit, notes, referred_to_clinic, referral_clinic, referral_notes } = req.body;

      if (!patient_id || !type || value === undefined || !unit) {
        return res.status(400).json({
          success: false,
          message: 'patient_id, type, value and unit are required',
        });
      }
      if (!SCREENING_TYPES.includes(type)) {
        return res.status(400).json({ success: false, message: 'Invalid screening type' });
      }

      // Verify the patient belongs to this pharmacy
      const patient = await db.query(
        'SELECT id FROM patients WHERE id = $1 AND pharmacy_id = $2',
        [patient_id, req.user!.pharmacyId]
      );
      if (patient.rows.length === 0) {
        return res.status(404).json({ success: false, message: 'Patient not found' });
      }

      const numericValue = Number(value);
      let riskLevel = 'low';
      if (type === 'blood_pressure' && systolic && diastolic) {
        if (systolic >= 180 || diastolic >= 120) riskLevel = 'critical';
        else if (systolic >= 140 || diastolic >= 90) riskLevel = 'high';
        else if (systolic >= 130 || diastolic >= 80) riskLevel = 'moderate';
      } else if (type === 'blood_sugar') {
        if (numericValue >= 300) riskLevel = 'critical';
        else if (numericValue >= 200) riskLevel = 'high';
        else if (numericValue >= 140) riskLevel = 'moderate';
      } else if (type === 'bmi') {
        if (numericValue >= 40 || numericValue < 16) riskLevel = 'high';
        else if (numericValue >= 30 || numericValue < 18.5) riskLevel = 'moderate';
      } else if (type === 'temperature') {
        if (numericValue >= 38) riskLevel = 'high';
        else if (numericValue >= 37.3) riskLevel = 'moderate';
      } else if (type === 'heart_rate') {
        if (numericValue > 120 || numericValue < 50) riskLevel = 'high';
        else if (numericValue > 100 || numericValue < 60) riskLevel = 'moderate';
      }

      const result = await db.query(
        `INSERT INTO screenings (pharmacy_id, patient_id, recorded_by, type, systolic, diastolic,
          value, unit, risk_level, notes, referred_to_clinic, referral_clinic, referral_notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
        [req.user!.pharmacyId, patient_id, req.user!.userId, type,
         systolic || null, diastolic || null, numericValue, unit, riskLevel,
         notes || null, referred_to_clinic || false, referral_clinic || null, referral_notes || null]
      );

      res.status(201).json({ success: true, message: 'Screening recorded', data: result.rows[0] });
    } catch (error) {
      logger.error('Failed to record screening', error);
      res.status(500).json({ success: false, message: 'Failed to record screening' });
    }
  }
);

export default router;
