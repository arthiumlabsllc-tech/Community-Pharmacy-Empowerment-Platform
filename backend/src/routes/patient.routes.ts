import { Router, Request, Response } from 'express';
import { body, param } from 'express-validator';
import { v4 as uuidv4 } from 'uuid';
import db from '../config/database';
import { authenticate, authorize } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import { auditLog } from '../middleware/audit.middleware';
import { UserRole, RiskLevel } from '../types';
import logger from '../utils/logger';

const router = Router();
router.use(authenticate);
router.use(auditLog);

// ============ LIST PATIENTS ============
router.get('/', async (req: Request, res: Response) => {
  try {
    const pharmacyId = req.user!.pharmacyId;
    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const offset = (page - 1) * limit;
    const { search, condition } = req.query;

    let whereClause = 'WHERE pharmacy_id = $1 AND is_active = true';
    const params: any[] = [pharmacyId];
    let idx = 2;

    if (search) {
      whereClause += ` AND (first_name ILIKE $${idx} OR last_name ILIKE $${idx} OR nhis_number ILIKE $${idx} OR phone ILIKE $${idx})`;
      params.push(`%${search}%`);
      idx++;
    }

    if (condition) {
      whereClause += ` AND $${idx} = ANY(chronic_conditions)`;
      params.push(condition);
      idx++;
    }

    const [countResult, dataResult] = await Promise.all([
      db.query(`SELECT COUNT(*) as total FROM patients ${whereClause}`, params),
      db.query(
        `SELECT * FROM patients ${whereClause} ORDER BY created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
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
    logger.error('Failed to fetch patients', error);
    res.status(500).json({ success: false, message: 'Failed to load patients' });
  }
});

// ============ GET PATIENT ============
router.get('/:id', validate([param('id').isUUID()]), async (req: Request, res: Response) => {
  try {
    const result = await db.query(
      'SELECT * FROM patients WHERE id = $1 AND pharmacy_id = $2',
      [req.params.id, req.user!.pharmacyId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Patient not found' });
    }
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to load patient' });
  }
});

// ============ CREATE PATIENT ============
router.post(
  '/',
  validate([
    body('first_name').trim().notEmpty().withMessage('First name is required'),
    body('last_name').trim().notEmpty().withMessage('Last name is required'),
    body('phone').trim().notEmpty().withMessage('Phone number is required'),
  ]),
  async (req: Request, res: Response) => {
    try {
      const {
        first_name, last_name, nhis_number, date_of_birth, gender, phone,
        alternate_phone, address, region, district, emergency_contact_name,
        emergency_contact_phone, allergies, chronic_conditions, blood_type, notes,
      } = req.body;

      const id = uuidv4();
      const result = await db.query(
        `INSERT INTO patients (id, pharmacy_id, nhis_number, first_name, last_name, date_of_birth,
          gender, phone, alternate_phone, address, region, district, emergency_contact_name,
          emergency_contact_phone, allergies, chronic_conditions, blood_type, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
         RETURNING *`,
        [id, req.user!.pharmacyId, nhis_number || null, first_name, last_name,
         date_of_birth || null, gender || 'other', phone, alternate_phone || null,
         address || null, region || null, district || null, emergency_contact_name || null,
         emergency_contact_phone || null, allergies || [], chronic_conditions || [],
         blood_type || null, notes || null]
      );

      res.status(201).json({ success: true, message: 'Patient registered', data: result.rows[0] });
    } catch (error) {
      logger.error('Failed to create patient', error);
      res.status(500).json({ success: false, message: 'Failed to register patient' });
    }
  }
);

// ============ UPDATE PATIENT ============
router.put('/:id', validate([param('id').isUUID()]), async (req: Request, res: Response) => {
  try {
    const fields = req.body;
    const allowedFields = [
      'first_name', 'last_name', 'nhis_number', 'date_of_birth', 'gender', 'phone',
      'alternate_phone', 'address', 'region', 'district', 'emergency_contact_name',
      'emergency_contact_phone', 'allergies', 'chronic_conditions', 'blood_type', 'notes',
    ];

    const updates: string[] = [];
    const params: any[] = [req.params.id, req.user!.pharmacyId];
    let idx = 3;

    for (const field of allowedFields) {
      if (fields[field] !== undefined) {
        updates.push(`${field} = $${idx}`);
        params.push(fields[field]);
        idx++;
      }
    }

    if (updates.length === 0) {
      return res.status(400).json({ success: false, message: 'No fields to update' });
    }

    const result = await db.query(
      `UPDATE patients SET ${updates.join(', ')} WHERE id = $1 AND pharmacy_id = $2 RETURNING *`,
      params
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Patient not found' });
    }

    res.json({ success: true, message: 'Patient updated', data: result.rows[0] });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to update patient' });
  }
});

// ============ PATIENT OVERVIEW ============
// Everything the patient profile page needs in a single round trip.
router.get('/:id/overview', validate([param('id').isUUID()]), async (req: Request, res: Response) => {
  try {
    const pharmacyId = req.user!.pharmacyId;
    const patientId = req.params.id;

    const patientResult = await db.query(
      'SELECT * FROM patients WHERE id = $1 AND pharmacy_id = $2',
      [patientId, pharmacyId]
    );
    if (patientResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Patient not found' });
    }

    const [prescriptions, screenings, claims, consultations, reminders] = await Promise.all([
      db.query(
        `SELECT * FROM prescriptions
         WHERE patient_id = $1 AND pharmacy_id = $2
         ORDER BY issue_date DESC LIMIT 50`,
        [patientId, pharmacyId]
      ),
      db.query(
        `SELECT s.*, u.first_name || ' ' || u.last_name as recorded_by_name
         FROM screenings s
         JOIN users u ON s.recorded_by = u.id
         WHERE s.patient_id = $1 AND s.pharmacy_id = $2
         ORDER BY s.recorded_at DESC LIMIT 50`,
        [patientId, pharmacyId]
      ),
      db.query(
        `SELECT id, claim_number, status, total_amount, nhis_approved_amount,
                patient_copay, rejection_reason, submitted_at, approved_at, paid_at, created_at
         FROM nhis_claims
         WHERE patient_id = $1 AND pharmacy_id = $2
         ORDER BY created_at DESC LIMIT 50`,
        [patientId, pharmacyId]
      ),
      db.query(
        `SELECT c.*, u.first_name || ' ' || u.last_name as pharmacist_name
         FROM consultations c
         JOIN users u ON c.pharmacist_id = u.id
         WHERE c.patient_id = $1 AND c.pharmacy_id = $2
         ORDER BY c.scheduled_at DESC LIMIT 50`,
        [patientId, pharmacyId]
      ),
      db.query(
        `SELECT id, type, title, message, scheduled_at, sent_at, status, recurrence, is_active
         FROM reminders
         WHERE patient_id = $1 AND pharmacy_id = $2 AND is_active = true
         ORDER BY scheduled_at DESC LIMIT 50`,
        [patientId, pharmacyId]
      ),
    ]);

    const prescriptionRows = prescriptions.rows;
    const filled = prescriptionRows.filter((row: any) => row.status === 'filled').length;
    const pendingReminders = reminders.rows.filter((row: any) => row.status === 'pending').length;

    res.json({
      success: true,
      data: {
        patient: patientResult.rows[0],
        prescriptions: prescriptionRows,
        screenings: screenings.rows,
        claims: claims.rows,
        consultations: consultations.rows,
        reminders: reminders.rows,
        stats: {
          prescriptions_total: prescriptionRows.length,
          prescriptions_filled: filled,
          screenings_total: screenings.rows.length,
          claims_total: claims.rows.length,
          reminders_pending: pendingReminders,
          last_visit: lastAttendedVisit(consultations.rows),
        },
      },
    });
  } catch (error) {
    logger.error('Failed to load patient overview', error);
    res.status(500).json({ success: false, message: 'Failed to load patient overview' });
  }
});

/** Most recent completed or in-progress consultation, used as the patient's "last visit". */
function lastAttendedVisit(rows: any[]): string | null {
  const attended = rows.find((row) => row.status === 'completed' || row.status === 'in_progress');
  return attended ? attended.scheduled_at : null;
}

// ============ PATIENT PRESCRIPTIONS ============
router.get('/:id/prescriptions', validate([param('id').isUUID()]), async (req: Request, res: Response) => {
  try {
    const result = await db.query(
      `SELECT * FROM prescriptions WHERE patient_id = $1 AND pharmacy_id = $2 ORDER BY issue_date DESC`,
      [req.params.id, req.user!.pharmacyId]
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to load prescriptions' });
  }
});

// ============ PATIENT SCREENINGS ============
router.get('/:id/screenings', validate([param('id').isUUID()]), async (req: Request, res: Response) => {
  try {
    const result = await db.query(
      `SELECT s.*, u.first_name || ' ' || u.last_name as recorded_by_name
       FROM screenings s
       JOIN users u ON s.recorded_by = u.id
       WHERE s.patient_id = $1 AND s.pharmacy_id = $2
       ORDER BY s.recorded_at DESC`,
      [req.params.id, req.user!.pharmacyId]
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to load screenings' });
  }
});

// ============ RECORD SCREENING ============
router.post(
  '/:id/screenings',
  validate([
    param('id').isUUID(),
    body('type').isIn(['blood_pressure', 'blood_sugar', 'bmi', 'weight', 'temperature', 'heart_rate']),
    body('value').isFloat({ min: 0 }),
    body('unit').trim().notEmpty(),
  ]),
  async (req: Request, res: Response) => {
    try {
      const { type, systolic, diastolic, value, unit, notes, referred_to_clinic, referral_clinic, referral_notes } = req.body;

      // Calculate risk level based on screening type and values
      let riskLevel: RiskLevel = RiskLevel.LOW;
      if (type === 'blood_pressure' && systolic && diastolic) {
        if (systolic >= 180 || diastolic >= 120) riskLevel = RiskLevel.CRITICAL;
        else if (systolic >= 140 || diastolic >= 90) riskLevel = RiskLevel.HIGH;
        else if (systolic >= 130 || diastolic >= 80) riskLevel = RiskLevel.MODERATE;
      } else if (type === 'blood_sugar') {
        if (value >= 300) riskLevel = RiskLevel.CRITICAL;
        else if (value >= 200) riskLevel = RiskLevel.HIGH;
        else if (value >= 140) riskLevel = RiskLevel.MODERATE;
      } else if (type === 'bmi') {
        if (value >= 40 || value < 16) riskLevel = RiskLevel.HIGH;
        else if (value >= 30 || value < 18.5) riskLevel = RiskLevel.MODERATE;
      }

      const id = uuidv4();
      const result = await db.query(
        `INSERT INTO screenings (id, pharmacy_id, patient_id, recorded_by, type, systolic, diastolic,
          value, unit, risk_level, notes, referred_to_clinic, referral_clinic, referral_notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         RETURNING *`,
        [id, req.user!.pharmacyId, req.params.id, req.user!.userId, type,
         systolic || null, diastolic || null, value, unit, riskLevel,
         notes || null, referred_to_clinic || false, referral_clinic || null, referral_notes || null]
      );

      res.status(201).json({ success: true, message: 'Screening recorded', data: result.rows[0] });
    } catch (error) {
      logger.error('Failed to record screening', error);
      res.status(500).json({ success: false, message: 'Failed to record screening' });
    }
  }
);

// ============ CREATE REMINDER ============
router.post(
  '/:id/reminders',
  validate([
    param('id').isUUID(),
    body('title').trim().notEmpty(),
    body('scheduled_at').isISO8601(),
    body('type').trim().notEmpty(),
  ]),
  async (req: Request, res: Response) => {
    try {
      const { type, title, message, scheduled_at, recurrence } = req.body;
      const id = uuidv4();

      const result = await db.query(
        `INSERT INTO reminders (id, pharmacy_id, patient_id, created_by, type, title, message, scheduled_at, recurrence)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [id, req.user!.pharmacyId, req.params.id, req.user!.userId, type, title, message || null, scheduled_at, recurrence || null]
      );

      res.status(201).json({ success: true, message: 'Reminder created', data: result.rows[0] });
    } catch (error) {
      res.status(500).json({ success: false, message: 'Failed to create reminder' });
    }
  }
);

export default router;
