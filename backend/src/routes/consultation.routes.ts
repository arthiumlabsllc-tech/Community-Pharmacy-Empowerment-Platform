import { Router, Request, Response } from 'express';
import { body, param } from 'express-validator';
import { v4 as uuidv4 } from 'uuid';
import db from '../config/database';
import { authenticate, authorize } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import { auditLog } from '../middleware/audit.middleware';
import { UserRole, ConsultationType, ConsultationStatus } from '../types';
import logger from '../utils/logger';

const router = Router();
router.use(authenticate);
router.use(auditLog);

// ============ LIST CONSULTATIONS ============
router.get('/', async (req: Request, res: Response) => {
  try {
    const pharmacyId = req.user!.pharmacyId;
    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const offset = (page - 1) * limit;
    const { status, type, pharmacist_id } = req.query;

    let whereClause = 'WHERE c.pharmacy_id = $1';
    const params: any[] = [pharmacyId];
    let idx = 2;

    if (status) { whereClause += ` AND c.status = $${idx}`; params.push(status); idx++; }
    if (type) { whereClause += ` AND c.type = $${idx}`; params.push(type); idx++; }
    if (pharmacist_id) { whereClause += ` AND c.pharmacist_id = $${idx}`; params.push(pharmacist_id); idx++; }

    const [countResult, dataResult] = await Promise.all([
      db.query(`SELECT COUNT(*) as total FROM consultations c ${whereClause}`, params),
      db.query(
        `SELECT c.*, 
                p.first_name || ' ' || p.last_name as patient_name,
                u.first_name || ' ' || u.last_name as pharmacist_name
         FROM consultations c
         JOIN patients p ON c.patient_id = p.id
         JOIN users u ON c.pharmacist_id = u.id
         ${whereClause}
         ORDER BY c.scheduled_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
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
    logger.error('Failed to fetch consultations', error);
    res.status(500).json({ success: false, message: 'Failed to load consultations' });
  }
});

// ============ CONSULTATION SUMMARY ============
// Registered before any parametric route so "summary" is never treated as an :id.
router.get('/summary', async (req: Request, res: Response) => {
  try {
    const pharmacyId = req.user!.pharmacyId;

    const [byStatus, byType, today, upcoming] = await Promise.all([
      db.query(
        `SELECT status, COUNT(*)::int as count
         FROM consultations WHERE pharmacy_id = $1
         GROUP BY status`,
        [pharmacyId]
      ),
      db.query(
        `SELECT type, COUNT(*)::int as count
         FROM consultations WHERE pharmacy_id = $1
         GROUP BY type`,
        [pharmacyId]
      ),
      db.query(
        `SELECT COUNT(*)::int as total
         FROM consultations
         WHERE pharmacy_id = $1 AND scheduled_at::date = CURRENT_DATE`,
        [pharmacyId]
      ),
      db.query(
        `SELECT COUNT(*)::int as total
         FROM consultations
         WHERE pharmacy_id = $1 AND status = 'scheduled' AND scheduled_at >= NOW()`,
        [pharmacyId]
      ),
    ]);

    const counts: Record<string, number> = { scheduled: 0, in_progress: 0, completed: 0, cancelled: 0, no_show: 0 };
    byStatus.rows.forEach((row) => { counts[row.status] = row.count; });

    res.json({
      success: true,
      data: {
        total: byStatus.rows.reduce((sum, row) => sum + row.count, 0),
        today: today.rows[0].total,
        upcoming: upcoming.rows[0].total,
        by_status: counts,
        by_type: byType.rows,
      },
    });
  } catch (error) {
    logger.error('Failed to fetch consultation summary', error);
    res.status(500).json({ success: false, message: 'Failed to load consultation summary' });
  }
});

// ============ CREATE CONSULTATION ============
router.post(
  '/',
  validate([
    body('patient_id').isUUID().withMessage('Valid patient ID is required'),
    body('type').isIn(['in_person', 'video', 'chat', 'phone']),
    body('scheduled_at').isISO8601().withMessage('Valid scheduled time is required'),
    body('reason').trim().notEmpty().withMessage('Reason is required'),
  ]),
  async (req: Request, res: Response) => {
    try {
      const { patient_id, type, scheduled_at, reason, notes, follow_up_date } = req.body;
      const id = uuidv4();

      const result = await db.query(
        `INSERT INTO consultations (id, pharmacy_id, patient_id, pharmacist_id, type, scheduled_at, reason, notes, follow_up_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [id, req.user!.pharmacyId, patient_id, req.user!.userId, type, scheduled_at, reason, notes || null, follow_up_date || null]
      );

      res.status(201).json({ success: true, message: 'Consultation scheduled', data: result.rows[0] });
    } catch (error) {
      logger.error('Failed to create consultation', error);
      res.status(500).json({ success: false, message: 'Failed to schedule consultation' });
    }
  }
);

// ============ UPDATE CONSULTATION ============
router.put('/:id', validate([param('id').isUUID()]), async (req: Request, res: Response) => {
  try {
    const { status, notes, started_at, ended_at, prescription_ids, follow_up_date } = req.body;

    const result = await db.query(
      `UPDATE consultations SET
        status = COALESCE($3, status),
        notes = COALESCE($4, notes),
        started_at = COALESCE($5, started_at),
        ended_at = COALESCE($6, ended_at),
        prescription_ids = COALESCE($7, prescription_ids),
        follow_up_date = COALESCE($8, follow_up_date)
       WHERE id = $1 AND pharmacy_id = $2
       RETURNING *`,
      [req.params.id, req.user!.pharmacyId, status, notes, started_at, ended_at, prescription_ids, follow_up_date]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Consultation not found' });
    }

    res.json({ success: true, message: 'Consultation updated', data: result.rows[0] });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to update consultation' });
  }
});

// ============ START VIDEO CALL ============
router.post('/:id/video', validate([param('id').isUUID()]), async (req: Request, res: Response) => {
  try {
    const roomId = `consult-${req.params.id}-${Date.now()}`;

    // Update consultation with video room ID
    await db.query(
      `UPDATE consultations SET video_room_id = $1, status = 'in_progress', started_at = NOW()
       WHERE id = $2 AND pharmacy_id = $3`,
      [roomId, req.params.id, req.user!.pharmacyId]
    );

    // In production, create Twilio/Daily.co room and return token
    res.json({
      success: true,
      message: 'Video consultation started',
      data: {
        room_id: roomId,
        // token: videoService.generateToken(roomId, req.user!.userId),
        join_url: `/consultations/${req.params.id}/video/${roomId}`,
      },
    });
  } catch (error) {
    logger.error('Failed to start video consultation', error);
    res.status(500).json({ success: false, message: 'Failed to start video call' });
  }
});

// ============ CHAT MESSAGES ============
router.get('/:id/chat', validate([param('id').isUUID()]), async (req: Request, res: Response) => {
  try {
    const result = await db.query(
      `SELECT cm.*, u.first_name || ' ' || u.last_name as sender_name
       FROM chat_messages cm
       JOIN users u ON cm.sender_id = u.id
       WHERE cm.consultation_id = $1
       ORDER BY cm.created_at ASC`,
      [req.params.id]
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to load chat messages' });
  }
});

// ============ SEND CHAT MESSAGE ============
router.post(
  '/:id/chat',
  validate([param('id').isUUID(), body('message').trim().notEmpty()]),
  async (req: Request, res: Response) => {
    try {
      const { message, attachment_url } = req.body;
      const id = uuidv4();

      const result = await db.query(
        `INSERT INTO chat_messages (id, consultation_id, sender_id, sender_type, message, attachment_url)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [id, req.params.id, req.user!.userId, 'pharmacist', message, attachment_url || null]
      );

      res.status(201).json({ success: true, data: result.rows[0] });
    } catch (error) {
      res.status(500).json({ success: false, message: 'Failed to send message' });
    }
  }
);

export default router;
