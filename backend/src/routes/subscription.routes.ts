import { Router, Request, Response } from 'express';
import { body } from 'express-validator';
import { v4 as uuidv4 } from 'uuid';
import db from '../config/database';
import { authenticate, authorize } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import { UserRole, SubscriptionTier, SubscriptionStatus } from '../types';
import logger from '../utils/logger';
import config from '../config';

const router = Router();

// ============ GET PLANS (Public) ============
router.get('/plans', async (_req: Request, res: Response) => {
  try {
    const result = await db.query(
      'SELECT * FROM subscription_plans WHERE is_active = true ORDER BY monthly_price ASC'
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to load plans' });
  }
});

// ============ GET SUBSCRIPTION STATUS ============
router.get('/status', authenticate, async (req: Request, res: Response) => {
  try {
    const result = await db.query(
      `SELECT s.*, p.tier as plan_tier, p.features as plan_features, p.name as plan_name
       FROM subscriptions s
       JOIN subscription_plans p ON s.tier = p.tier
       WHERE s.pharmacy_id = $1
       ORDER BY s.created_at DESC LIMIT 1`,
      [req.user!.pharmacyId]
    );

    if (result.rows.length === 0) {
      return res.json({
        success: true,
        data: { tier: 'free', status: 'active', features: ['inventory_basic', 'patients_basic', 'dashboard'] },
      });
    }

    const sub = result.rows[0];
    res.json({
      success: true,
      data: {
        id: sub.id,
        tier: sub.tier,
        status: sub.status,
        start_date: sub.start_date,
        end_date: sub.end_date,
        trial_ends_at: sub.trial_ends_at,
        monthly_amount: sub.monthly_amount,
        currency: sub.currency,
        next_billing_at: sub.next_billing_at,
        features: sub.plan_features,
        plan_name: sub.plan_name,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to load subscription' });
  }
});

// ============ ACTIVATE SUBSCRIPTION ============
router.post(
  '/activate',
  authenticate,
  authorize(UserRole.PHARMACY_OWNER),
  validate([body('tier').isIn(['premium', 'enterprise']).withMessage('Valid tier is required')]),
  async (req: Request, res: Response) => {
    try {
      const { tier, payment_method, payment_reference } = req.body;

      // Get plan pricing
      const planResult = await db.query('SELECT * FROM subscription_plans WHERE tier = $1', [tier]);
      if (planResult.rows.length === 0) {
        return res.status(404).json({ success: false, message: 'Plan not found' });
      }
      const plan = planResult.rows[0];

      // Deactivate current subscription
      await db.query(
        `UPDATE subscriptions SET status = 'cancelled', end_date = CURRENT_DATE
         WHERE pharmacy_id = $1 AND status IN ('active', 'trial')`,
        [req.user!.pharmacyId]
      );

      // Create new subscription
      const id = uuidv4();
      const nextBilling = new Date();
      nextBilling.setMonth(nextBilling.getMonth() + 1);

      const result = await db.query(
        `INSERT INTO subscriptions (id, pharmacy_id, tier, status, start_date, monthly_amount,
          currency, payment_method, payment_reference, next_billing_at, features)
         VALUES ($1, $2, $3, $4, CURRENT_DATE, $5, $6, $7, $8, $9, $10)
         RETURNING *`,
        [id, req.user!.pharmacyId, tier, SubscriptionStatus.ACTIVE, plan.monthly_price,
         plan.currency, payment_method || null, payment_reference || null, nextBilling, plan.features]
      );

      // Update pharmacy tier
      await db.query('UPDATE pharmacies SET subscription_tier = $1 WHERE id = $2', [tier, req.user!.pharmacyId]);

      res.status(201).json({
        success: true,
        message: `Subscription activated: ${plan.name} plan`,
        data: result.rows[0],
      });
    } catch (error) {
      logger.error('Failed to activate subscription', error);
      res.status(500).json({ success: false, message: 'Failed to activate subscription' });
    }
  }
);

// ============ PROCESS PAYMENT ============
router.post(
  '/payment',
  authenticate,
  authorize(UserRole.PHARMACY_OWNER),
  validate([
    body('amount').isFloat({ min: 0.01 }),
    body('method').isIn(['momo', 'paystack', 'stripe', 'bank_transfer']),
  ]),
  async (req: Request, res: Response) => {
    try {
      const { amount, method, reference, metadata } = req.body;
      const id = uuidv4();
      const payRef = reference || `PAY-${Date.now()}`;

      // No payment gateway is connected yet, so the payment is recorded as
      // pending rather than pretending the money was collected.
      const result = await db.query(
        `INSERT INTO payments (id, pharmacy_id, subscription_id, amount, currency, method, reference, status, metadata)
         VALUES ($1, $2, (SELECT id FROM subscriptions WHERE pharmacy_id = $2 ORDER BY created_at DESC LIMIT 1),
                 $3, 'GHS', $4, $5, 'pending', $6)
         RETURNING *`,
        [id, req.user!.pharmacyId, amount, method, payRef, metadata || {}]
      );

      // Update subscription billing
      await db.query(
        `UPDATE subscriptions SET last_payment_at = NOW(), next_billing_at = NOW() + INTERVAL '30 days'
         WHERE pharmacy_id = $1 AND status = 'active'`,
        [req.user!.pharmacyId]
      );

      res.status(201).json({
        success: true,
        message: 'Payment recorded as pending. It will be marked completed once a payment gateway confirms it.',
        data: result.rows[0],
      });
    } catch (error) {
      logger.error('Payment processing failed', error);
      res.status(500).json({ success: false, message: 'Payment processing failed' });
    }
  }
);

// ============ CANCEL SUBSCRIPTION ============
router.post(
  '/cancel',
  authenticate,
  authorize(UserRole.PHARMACY_OWNER),
  async (req: Request, res: Response) => {
    try {
      await db.query(
        `UPDATE subscriptions SET status = 'cancelled', end_date = CURRENT_DATE
         WHERE pharmacy_id = $1 AND status IN ('active', 'trial')`,
        [req.user!.pharmacyId]
      );

      await db.query(
        "UPDATE pharmacies SET subscription_tier = 'free' WHERE id = $1",
        [req.user!.pharmacyId]
      );

      res.json({ success: true, message: 'Subscription cancelled. Your account has been downgraded to the free plan.' });
    } catch (error) {
      logger.error('Failed to cancel subscription', error);
      res.status(500).json({ success: false, message: 'Failed to cancel subscription' });
    }
  }
);

export default router;
