import { Router, Request, Response } from 'express';
import { body, param, query } from 'express-validator';
import db from '../config/database';
import { authenticate, authorize } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import { auditLog } from '../middleware/audit.middleware';
import { UserRole } from '../types';
import logger from '../utils/logger';
import {
  hasAlertDedupe,
  refreshStockAlerts,
  StockAlertsUnavailable,
  type RefreshResult,
} from '../utils/stock-alerts';
import {
  buildMarkReadQuery,
  buildNotificationCountQuery,
  buildNotificationFeedQuery,
  clampFeedLimit,
  stockAlertKinds,
  toCounts,
  type FeedRow,
} from '../utils/notification-queries';

const router = Router();

router.use(authenticate);

// No file-level auditLog, which is what every other route file does. The reason
// is POST /refresh below: the bell calls it whenever it opens, so auditing it
// would make "the pharmacist looked at the bell" the most common entry in a
// table meant to say who changed what. Clearing alerts is audited individually.

/**
 * What the reader needs that the writer's own database does not have.
 *
 * The feed filters on `superseded_at` and on the dedupe key's first segment, so
 * it needs migration 003 exactly as the writer does. Without it the honest
 * answer is not an error and not an empty list — it is "there is nothing
 * persisted to read yet", which the bell turns into the live inventory read it
 * already does. That is why this is `supported: false` on a 200 rather than a
 * 501: the request was reasonable, the answer is that nothing has been recorded,
 * and the caller can do something useful with that.
 */
const ALERTS_NEED_003 =
  'Persisted stock alerts are not installed on this database. ' +
  'Run database/migrations/003_inventory_batches.sql, which adds the dedupe key and ' +
  'superseded_at to notifications. Until then there is no history of a shortage to read, ' +
  'so the bell derives its list from current stock instead.';

/** Every kind the writer can raise. Anything else is a caller's typo. */
const KNOWN_KINDS = stockAlertKinds();

/**
 * Splits `?kinds=a,b` into a list.
 *
 * Unknown kinds are rejected rather than ignored, and this is the one validation
 * in the file worth the trouble: a bell asking for `low-stock` with a hyphen
 * instead of `low_stock` would match nothing at all, return an empty list on a
 * 200, and look exactly like a pharmacy with no problems. The frontend already
 * uses hyphenated names internally for its own grouping, so the mistake is not
 * hypothetical.
 */
function parseKinds(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  const parts = (Array.isArray(value) ? value : String(value).split(','))
    .map((part) => String(part).trim())
    .filter((part) => part !== '');

  const unknown = parts.filter((part) => !KNOWN_KINDS.includes(part));
  if (unknown.length > 0) {
    throw Object.assign(
      new Error(
        `Unknown alert kind(s): ${unknown.join(', ')}. Accepted: ${KNOWN_KINDS.join(', ')}.`
      ),
      { statusCode: 400 }
    );
  }
  return parts;
}

/** `?unread=true` or `?unread=1`. Anything else reads as "show everything". */
function parseUnread(value: unknown): boolean {
  return value === true || value === 'true' || value === '1';
}

// ============ THE BELL'S LIST ============

/**
 * Live notifications for this pharmacy, newest first.
 *
 * Superseded rows are never returned: an alert whose condition has cleared is
 * history, and showing it in the bell would be showing a shortage that has
 * already been delivered. It stays in the table, which is what makes the next
 * one answerable.
 */
router.get(
  '/',
  validate([
    query('kinds')
      .optional()
      .isString()
      .withMessage('kinds must be a comma-separated list'),
    query('unread')
      .optional()
      .isIn(['true', 'false', '1', '0'])
      .withMessage('unread must be true or false'),
    query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('limit must be between 1 and 100'),
  ]),
  async (req: Request, res: Response) => {
    try {
      const pharmacyId = req.user!.pharmacyId;

      if (!(await hasAlertDedupe(db))) {
        res.json({
          success: true,
          supported: false,
          message: ALERTS_NEED_003,
          data: [] as FeedRow[],
          counts: { live: 0, unread: 0 },
        });
        return;
      }

      const kinds = parseKinds(req.query.kinds);
      const unread = parseUnread(req.query.unread);
      const limit = clampFeedLimit(req.query.limit);

      const feed = buildNotificationFeedQuery(pharmacyId, { kinds, unread, limit });
      const counts = buildNotificationCountQuery(pharmacyId, kinds);

      // One round trip each rather than one after the other: the bell renders
      // both, so neither is useful without the other.
      const [feedResult, countResult] = await Promise.all([
        db.query(feed.text, feed.params),
        db.query(counts.text, counts.params),
      ]);

      res.json({
        success: true,
        supported: true,
        data: feedResult.rows as FeedRow[],
        counts: toCounts(countResult.rows[0] ?? {}),
        filters: { kinds, unread, limit },
      });
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode;
      if (statusCode === 400) {
        res.status(400).json({ success: false, message: (error as Error).message });
        return;
      }
      logger.error('Failed to read notifications', error);
      res.status(500).json({ success: false, message: 'Failed to read notifications' });
    }
  }
);

// ============ RECOMPUTING FROM THE SHELF ============

/**
 * Re-derives every stock alert for the pharmacy.
 *
 * The nine mutation sites keep alerts current for the products they touch. What
 * they cannot catch is a product that became a problem because time passed: an
 * expiry that crossed into the 90-day window overnight, with no sale, no
 * delivery and no edit to prompt a refresh. Opening the bell is the natural
 * moment to close that gap.
 *
 * Whole-pharmacy, so it reads every product — which is why the caller should not
 * do it on every dropdown open. Once a session, or once when the pharmacy
 * changes, is enough; the dedupe means calling it twice writes nothing the
 * second time, but it still costs the scan.
 *
 * 501 rather than `supported: false` here, unlike the read above: this is an
 * explicit request to write, and answering it with a 200 would say the refresh
 * happened.
 */
router.post('/refresh', async (req: Request, res: Response) => {
  try {
    const pharmacyId = req.user!.pharmacyId;
    let result: RefreshResult;

    try {
      result = await refreshStockAlerts(db, pharmacyId, {});
    } catch (error) {
      if (error instanceof StockAlertsUnavailable) {
        res.status(501).json({ success: false, message: ALERTS_NEED_003 });
        return;
      }
      throw error;
    }

    res.json({ success: true, data: result });
  } catch (error) {
    logger.error('Failed to refresh stock alerts', error);
    res.status(500).json({ success: false, message: 'Failed to refresh the stock alerts' });
  }
});

// ============ CLEARING THE BADGE ============

/**
 * Marks notifications read.
 *
 * Owner and pharmacist only. `read_at` is one column on a pharmacy-wide row, not
 * per user, so anybody who can set it can hide an alert from everybody else —
 * and a cashier clearing the badge at the end of a shift would leave the
 * pharmacist with no sign that anything had run out. Seeing alerts is not
 * restricted; clearing them is.
 */
router.post(
  '/read',
  authorize(UserRole.PHARMACY_OWNER, UserRole.PHARMACIST),
  auditLog,
  validate([
    body('ids').optional().isArray().withMessage('ids must be a list of notification ids'),
    body('ids.*').optional().isUUID().withMessage('each id must be a valid notification id'),
    body('kinds').optional().isArray().withMessage('kinds must be a list'),
  ]),
  async (req: Request, res: Response) => {
    try {
      const pharmacyId = req.user!.pharmacyId;
      const ids = Array.isArray(req.body?.ids) ? (req.body.ids as string[]) : [];
      const kinds = parseKinds(
        Array.isArray(req.body?.kinds) ? req.body.kinds.join(',') : req.body?.kinds
      );

      const markRead = buildMarkReadQuery(pharmacyId, { ids, kinds });
      const result = await db.query(markRead.text, markRead.params);

      res.json({
        success: true,
        message:
          result.rowCount === 0
            ? 'Nothing to mark as read'
            : `Marked ${result.rowCount} notification(s) as read`,
        data: { marked: result.rowCount ?? 0 },
      });
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode;
      if (statusCode === 400) {
        res.status(400).json({ success: false, message: (error as Error).message });
        return;
      }
      logger.error('Failed to mark notifications read', error);
      res.status(500).json({ success: false, message: 'Failed to mark notifications as read' });
    }
  }
);

/**
 * One notification, for clicking a single alert in the list.
 *
 * Scoped to the pharmacy in the WHERE clause rather than checked afterwards, so
 * an id from another branch matches no rows and answers "not found" — the same
 * answer as an id that does not exist, because the difference is not something
 * to tell a caller who is guessing ids.
 */
router.post(
  '/:id/read',
  authorize(UserRole.PHARMACY_OWNER, UserRole.PHARMACIST),
  auditLog,
  validate([param('id').isUUID().withMessage('id must be a valid notification id')]),
  async (req: Request, res: Response) => {
    try {
      const pharmacyId = req.user!.pharmacyId;
      const markRead = buildMarkReadQuery(pharmacyId, { ids: [req.params.id] });
      const result = await db.query(markRead.text, markRead.params);

      if ((result.rowCount ?? 0) === 0) {
        res.status(404).json({
          success: false,
          message: 'No unread notification with that id',
        });
        return;
      }

      res.json({ success: true, message: 'Marked as read', data: { marked: 1 } });
    } catch (error) {
      logger.error('Failed to mark notification read', error);
      res.status(500).json({ success: false, message: 'Failed to mark the notification as read' });
    }
  }
);

export default router;
