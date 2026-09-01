import { Router, Request, Response } from 'express';
import { body, param } from 'express-validator';
import { v4 as uuidv4 } from 'uuid';
import db from '../config/database';
import { authenticate, authorize } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import { auditLog } from '../middleware/audit.middleware';
import { UserRole, ClaimStatus } from '../types';
import logger from '../utils/logger';
import config from '../config';

const router = Router();
router.use(authenticate);
router.use(auditLog);

// ============ CHECK NHIS ELIGIBILITY ============
router.post(
  '/check-eligibility',
  validate([body('nhis_number').trim().notEmpty().withMessage('NHIS number is required')]),
  async (req: Request, res: Response) => {
    try {
      const { nhis_number } = req.body;

      // Check local patient database first
      const localPatient = await db.query(
        'SELECT * FROM patients WHERE nhis_number = $1 AND pharmacy_id = $2',
        [nhis_number, req.user!.pharmacyId]
      );

      // In production, this would call the NHIS API
      // For now, we simulate the eligibility check
      const eligibilityResponse = {
        eligible: true,
        nhis_number,
        member_name: localPatient.rows[0]
          ? `${localPatient.rows[0].first_name} ${localPatient.rows[0].last_name}`
          : 'Unknown',
        scheme_type: 'NHIS',
        expiry_date: '2026-12-31',
        coverage_level: 'basic',
        patient_found: localPatient.rows.length > 0,
        patient_id: localPatient.rows[0]?.id || null,
      };

      // TODO: Replace with actual NHIS API call
      // const nhisResponse = await nhisService.checkEligibility(nhis_number);

      res.json({ success: true, data: eligibilityResponse });
    } catch (error) {
      logger.error('NHIS eligibility check failed', error);
      res.status(500).json({ success: false, message: 'Failed to verify NHIS eligibility' });
    }
  }
);

// ============ SUBMIT CLAIM ============
router.post(
  '/submit-claim',
  validate([
    body('patient_id').isUUID().withMessage('Valid patient ID is required'),
    body('diagnosis_codes').isArray({ min: 1 }).withMessage('At least one diagnosis code is required'),
    body('medications').isArray({ min: 1 }).withMessage('At least one medication is required'),
    body('total_amount').isFloat({ min: 0.01 }).withMessage('Total amount must be positive'),
  ]),
  async (req: Request, res: Response) => {
    try {
      const { patient_id, prescription_id, diagnosis_codes, medications, total_amount, patient_copay } = req.body;
      const id = uuidv4();
      const claimNumber = `CLM-${Date.now()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;

      const result = await db.query(
        `INSERT INTO nhis_claims (id, pharmacy_id, patient_id, prescription_id, claim_number,
          diagnosis_codes, medication_details, total_amount, patient_copay, status, submitted_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
         RETURNING *`,
        [id, req.user!.pharmacyId, patient_id, prescription_id || null, claimNumber,
         diagnosis_codes, JSON.stringify(medications), total_amount, patient_copay || 0,
         ClaimStatus.SUBMITTED]
      );

      // TODO: In production, submit to NHIS API asynchronously via Bull queue
      // await claimQueue.add('submit', { claimId: id });

      res.status(201).json({
        success: true,
        message: 'Claim submitted successfully',
        data: result.rows[0],
      });
    } catch (error) {
      logger.error('Failed to submit claim', error);
      res.status(500).json({ success: false, message: 'Failed to submit claim' });
    }
  }
);

// ============ LIST CLAIMS ============
router.get('/claims', async (req: Request, res: Response) => {
  try {
    const pharmacyId = req.user!.pharmacyId;
    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const offset = (page - 1) * limit;
    const { status, from, to } = req.query;

    let whereClause = 'WHERE c.pharmacy_id = $1';
    const params: any[] = [pharmacyId];
    let idx = 2;

    if (status) {
      whereClause += ` AND c.status = $${idx}`;
      params.push(status);
      idx++;
    }
    if (from) {
      whereClause += ` AND c.submitted_at >= $${idx}`;
      params.push(from);
      idx++;
    }
    if (to) {
      whereClause += ` AND c.submitted_at <= $${idx}`;
      params.push(to);
      idx++;
    }

    const [countResult, dataResult] = await Promise.all([
      db.query(`SELECT COUNT(*) as total FROM nhis_claims c ${whereClause}`, params),
      db.query(
        `SELECT c.*, p.first_name || ' ' || p.last_name as patient_name, p.nhis_number
         FROM nhis_claims c
         JOIN patients p ON c.patient_id = p.id
         ${whereClause}
         ORDER BY c.created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
        [...params, limit, offset]
      ),
    ]);

    const total = parseInt(countResult.rows[0].total, 10);

    // Summary stats
    const statsResult = await db.query(
      `SELECT status, COUNT(*) as count, COALESCE(SUM(total_amount), 0) as amount
       FROM nhis_claims WHERE pharmacy_id = $1 GROUP BY status`,
      [pharmacyId]
    );

    res.json({
      success: true,
      data: dataResult.rows,
      summary: statsResult.rows,
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    logger.error('Failed to fetch claims', error);
    res.status(500).json({ success: false, message: 'Failed to load claims' });
  }
});

// ============ GET CLAIM ============
router.get('/claims/:id', validate([param('id').isUUID()]), async (req: Request, res: Response) => {
  try {
    const result = await db.query(
      `SELECT c.*, p.first_name || ' ' || p.last_name as patient_name, p.nhis_number
       FROM nhis_claims c
       JOIN patients p ON c.patient_id = p.id
       WHERE c.id = $1 AND c.pharmacy_id = $2`,
      [req.params.id, req.user!.pharmacyId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Claim not found' });
    }
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to load claim' });
  }
});

// ============ UPDATE CLAIM (resubmit / edit draft) ============
router.put('/claims/:id', validate([param('id').isUUID()]), async (req: Request, res: Response) => {
  try {
    const { diagnosis_codes, medications, total_amount, patient_copay, status } = req.body;

    const result = await db.query(
      `UPDATE nhis_claims SET
        diagnosis_codes = COALESCE($3, diagnosis_codes),
        medication_details = COALESCE($4, medication_details),
        total_amount = COALESCE($5, total_amount),
        patient_copay = COALESCE($6, patient_copay),
        status = COALESCE($7, status),
        rejection_reason = CASE WHEN $7 = 'resubmitted' THEN NULL ELSE rejection_reason END,
        submitted_at = CASE WHEN $7 IN ('submitted', 'resubmitted') THEN NOW() ELSE submitted_at END
       WHERE id = $1 AND pharmacy_id = $2
       RETURNING *`,
      [req.params.id, req.user!.pharmacyId, diagnosis_codes, medications ? JSON.stringify(medications) : null,
       total_amount, patient_copay, status]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Claim not found' });
    }

    res.json({ success: true, message: 'Claim updated', data: result.rows[0] });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to update claim' });
  }
});

// ============ REIMBURSEMENTS ============
router.get('/reimbursements', async (req: Request, res: Response) => {
  try {
    const result = await db.query(
      `SELECT r.*, c.claim_number, c.total_amount as claim_amount,
              p.first_name || ' ' || p.last_name as patient_name
       FROM reimbursements r
       LEFT JOIN nhis_claims c ON r.claim_id = c.id
       LEFT JOIN patients p ON c.patient_id = p.id
       WHERE r.pharmacy_id = $1
       ORDER BY r.received_at DESC LIMIT 100`,
      [req.user!.pharmacyId]
    );

    const summary = await db.query(
      `SELECT COALESCE(SUM(amount), 0) as total_received,
              COUNT(*) as total_payments
       FROM reimbursements WHERE pharmacy_id = $1`,
      [req.user!.pharmacyId]
    );

    res.json({
      success: true,
      data: result.rows,
      summary: summary.rows[0],
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to load reimbursements' });
  }
});

export default router;
