import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import db from '../config/database';
import logger from '../utils/logger';

/**
 * Log every API request as an audit trail entry.
 */
export async function auditLog(req: Request, res: Response, next: NextFunction): Promise<void> {
  const originalSend = res.send;

  res.send = function (body: any): Response {
    // Log after response is sent
    if (req.user && ['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
      const auditEntry = {
        id: uuidv4(),
        pharmacy_id: req.user.pharmacyId,
        user_id: req.user.userId,
        action: `${req.method} ${req.path}`,
        resource_type: req.path.split('/')[2] || 'unknown',
        resource_id: req.params.id || null,
        details: { body: req.body, query: req.query },
        ip_address: req.ip || req.socket.remoteAddress || '',
        user_agent: req.headers['user-agent'] || '',
      };

      // Fire-and-forget audit log
      db.query(
        `INSERT INTO audit_logs (id, pharmacy_id, user_id, action, resource_type, resource_id, details, ip_address, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          auditEntry.id,
          auditEntry.pharmacy_id,
          auditEntry.user_id,
          auditEntry.action,
          auditEntry.resource_type,
          auditEntry.resource_id,
          JSON.stringify(auditEntry.details),
          auditEntry.ip_address,
          auditEntry.user_agent,
        ]
      ).catch((err: Error) => {
        logger.error('Failed to write audit log', err);
      });
    }

    return originalSend.call(this, body);
  };

  next();
}
