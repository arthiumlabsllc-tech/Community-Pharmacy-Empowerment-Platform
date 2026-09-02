import { Router, Request, Response } from 'express';
import { body } from 'express-validator';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import config from '../config';
import db from '../config/database';
import { cacheSet, cacheDel } from '../config/redis';
import { authenticate } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import { JwtPayload, UserRole, SubscriptionTier, SubscriptionStatus } from '../types';
import logger from '../utils/logger';

const router = Router();

// ============ REGISTER ============
router.post(
  '/register',
  validate([
    body('email').isEmail().normalizeEmail().withMessage('A valid email address is required'),
    body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
    body('first_name').trim().notEmpty().withMessage('First name is required'),
    body('last_name').trim().notEmpty().withMessage('Last name is required'),
    body('phone').trim().notEmpty().withMessage('Phone number is required'),
    body('pharmacy_name').trim().notEmpty().withMessage('Pharmacy name is required'),
    body('license_number').trim().notEmpty().withMessage('License number is required'),
    body('location').trim().notEmpty().withMessage('Location is required'),
  ]),
  async (req: Request, res: Response) => {
    try {
      const {
        email, password, first_name, last_name, phone,
        pharmacy_name, license_number, location, region, district, gps_address,
      } = req.body;

      // Check if email already exists
      const existingUser = await db.query('SELECT id FROM users WHERE email = $1', [email]);
      if (existingUser.rows.length > 0) {
        return res.status(409).json({
          success: false,
          message: 'An account with this email already exists',
        });
      }

      // Check if license number already registered
      const existingPharmacy = await db.query('SELECT id FROM pharmacies WHERE license_number = $1', [license_number]);
      if (existingPharmacy.rows.length > 0) {
        return res.status(409).json({
          success: false,
          message: 'This license number is already registered',
        });
      }

      const password_hash = await bcrypt.hash(password, 12);
      const userId = uuidv4();
      const pharmacyId = uuidv4();
      const subscriptionId = uuidv4();

      // Create pharmacy, user, and trial subscription in a transaction
      await db.transaction(async (client) => {
        await client.query(
          `INSERT INTO pharmacies (id, name, license_number, location, region, district, gps_address, phone, email, owner_id, subscription_tier)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [pharmacyId, pharmacy_name, license_number, location, region || null, district || null, gps_address || null, phone, email, userId, 'free']
        );

        await client.query(
          `INSERT INTO users (id, pharmacy_id, role, first_name, last_name, email, phone, password_hash)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [userId, pharmacyId, UserRole.PHARMACY_OWNER, first_name, last_name, email, phone, password_hash]
        );

        // Create 30-day free trial subscription
        const trialEnd = new Date();
        trialEnd.setDate(trialEnd.getDate() + 30);

        await client.query(
          `INSERT INTO subscriptions (id, pharmacy_id, tier, status, start_date, trial_ends_at, monthly_amount, currency)
           VALUES ($1, $2, $3, $4, CURRENT_DATE, $5, 0, 'GHS')`,
          [subscriptionId, pharmacyId, SubscriptionTier.PREMIUM, SubscriptionStatus.TRIAL, trialEnd]
        );
      });

      // Generate tokens
      const payload: JwtPayload = {
        userId,
        pharmacyId,
        role: UserRole.PHARMACY_OWNER,
        email,
      };

      const accessToken = jwt.sign(payload, config.jwt.secret, { expiresIn: config.jwt.expiresIn } as jwt.SignOptions);
      const refreshToken = jwt.sign(payload, config.jwt.refreshSecret, { expiresIn: config.jwt.refreshExpiresIn } as jwt.SignOptions);

      // Store refresh token
      await db.query('UPDATE users SET refresh_token = $1 WHERE id = $2', [refreshToken, userId]);

      logger.info(`New pharmacy registered: ${pharmacy_name} (${pharmacyId})`);

      res.status(201).json({
        success: true,
        message: 'Registration successful! Your 30-day free trial has started.',
        data: {
          accessToken,
          refreshToken,
          user: { id: userId, first_name, last_name, email, phone, role: UserRole.PHARMACY_OWNER },
          pharmacy: { id: pharmacyId, name: pharmacy_name, license_number, location, subscription_tier: 'premium_trial' },
        },
      });
    } catch (error: any) {
      logger.error('Registration failed', error);
      res.status(500).json({ success: false, message: 'Registration failed. Please try again.' });
    }
  }
);

// ============ LOGIN ============
router.post(
  '/login',
  validate([
    body('email').isEmail().normalizeEmail().withMessage('A valid email address is required'),
    body('password').notEmpty().withMessage('Password is required'),
  ]),
  async (req: Request, res: Response) => {
    try {
      const { email, password } = req.body;

      // Find user with pharmacy info
      const result = await db.query(
        `SELECT u.*, p.name as pharmacy_name, p.subscription_tier
         FROM users u
         JOIN pharmacies p ON u.pharmacy_id = p.id
         WHERE u.email = $1 AND u.is_active = true`,
        [email]
      );

      if (result.rows.length === 0) {
        return res.status(401).json({
          success: false,
          message: 'Invalid email or password',
        });
      }

      const user = result.rows[0];

      const isValidPassword = await bcrypt.compare(password, user.password_hash);
      if (!isValidPassword) {
        return res.status(401).json({
          success: false,
          message: 'Invalid email or password',
        });
      }

      // Generate tokens
      const payload: JwtPayload = {
        userId: user.id,
        pharmacyId: user.pharmacy_id,
        role: user.role,
        email: user.email,
      };

      const accessToken = jwt.sign(payload, config.jwt.secret, { expiresIn: config.jwt.expiresIn } as jwt.SignOptions);
      const refreshToken = jwt.sign(payload, config.jwt.refreshSecret, { expiresIn: config.jwt.refreshExpiresIn } as jwt.SignOptions);

      // Update last login and store refresh token
      await db.query(
        'UPDATE users SET refresh_token = $1, last_login_at = NOW() WHERE id = $2',
        [refreshToken, user.id]
      );

      // Cache user session
      await cacheSet(`session:${user.id}`, { pharmacyId: user.pharmacy_id, role: user.role }, 900);

      res.json({
        success: true,
        message: 'Login successful',
        data: {
          accessToken,
          refreshToken,
          user: {
            id: user.id,
            first_name: user.first_name,
            last_name: user.last_name,
            email: user.email,
            phone: user.phone,
            role: user.role,
            avatar_url: user.avatar_url,
            preferred_language: user.preferred_language,
          },
          pharmacy: {
            id: user.pharmacy_id,
            name: user.pharmacy_name,
            subscription_tier: user.subscription_tier,
          },
        },
      });
    } catch (error: any) {
      logger.error('Login failed', error);
      res.status(500).json({ success: false, message: 'Login failed. Please try again.' });
    }
  }
);

// ============ REFRESH TOKEN ============
router.post('/refresh', async (req: Request, res: Response) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      return res.status(400).json({ success: false, message: 'Refresh token is required' });
    }

    const payload = jwt.verify(refreshToken, config.jwt.refreshSecret) as JwtPayload;

    // Verify refresh token matches stored token
    const result = await db.query('SELECT id, refresh_token FROM users WHERE id = $1', [payload.userId]);
    if (result.rows.length === 0 || result.rows[0].refresh_token !== refreshToken) {
      return res.status(401).json({ success: false, message: 'Invalid refresh token' });
    }

    // Generate new tokens (rotation)
    const newPayload: JwtPayload = { ...payload };
    const newAccessToken = jwt.sign(newPayload, config.jwt.secret, { expiresIn: config.jwt.expiresIn } as jwt.SignOptions);
    const newRefreshToken = jwt.sign(newPayload, config.jwt.refreshSecret, { expiresIn: config.jwt.refreshExpiresIn } as jwt.SignOptions);

    await db.query('UPDATE users SET refresh_token = $1 WHERE id = $2', [newRefreshToken, payload.userId]);

    res.json({
      success: true,
      data: { accessToken: newAccessToken, refreshToken: newRefreshToken },
    });
  } catch (error: any) {
    res.status(401).json({ success: false, message: 'Invalid or expired refresh token' });
  }
});

// ============ LOGOUT ============
router.post('/logout', authenticate, async (req: Request, res: Response) => {
  try {
    if (req.user) {
      await db.query('UPDATE users SET refresh_token = NULL WHERE id = $1', [req.user.userId]);
      await cacheDel(`session:${req.user.userId}`);
    }
    res.json({ success: true, message: 'Logged out successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Logout failed' });
  }
});

// ============ CHANGE PASSWORD ============
router.put(
  '/change-password',
  authenticate,
  validate([
    body('current_password').notEmpty().withMessage('Current password is required'),
    body('new_password').isLength({ min: 8 }).withMessage('New password must be at least 8 characters'),
  ]),
  async (req: Request, res: Response) => {
    try {
      const { current_password, new_password } = req.body;

      const result = await db.query('SELECT password_hash FROM users WHERE id = $1', [req.user!.userId]);
      if (result.rows.length === 0) {
        return res.status(404).json({ success: false, message: 'User not found' });
      }

      const isValid = await bcrypt.compare(current_password, result.rows[0].password_hash);
      if (!isValid) {
        return res.status(401).json({ success: false, message: 'Current password is incorrect' });
      }

      const newHash = await bcrypt.hash(new_password, 12);
      await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, req.user!.userId]);

      res.json({ success: true, message: 'Password changed successfully' });
    } catch (error) {
      res.status(500).json({ success: false, message: 'Failed to change password' });
    }
  }
);

// ============ UPDATE OWN PROFILE ============
router.put(
  '/profile',
  authenticate,
  validate([
    body('first_name').optional().trim().notEmpty().withMessage('First name cannot be empty'),
    body('last_name').optional().trim().notEmpty().withMessage('Last name cannot be empty'),
    body('phone').optional().trim().notEmpty().withMessage('Phone cannot be empty'),
    body('preferred_language').optional().isIn(['en', 'tw', 'ee']).withMessage('Language must be en, tw or ee'),
  ]),
  async (req: Request, res: Response) => {
    try {
      const { first_name, last_name, phone, preferred_language, avatar_url } = req.body;

      const result = await db.query(
        `UPDATE users SET
          first_name = COALESCE($2, first_name),
          last_name = COALESCE($3, last_name),
          phone = COALESCE($4, phone),
          preferred_language = COALESCE($5, preferred_language),
          avatar_url = COALESCE($6, avatar_url)
         WHERE id = $1
         RETURNING id, first_name, last_name, email, phone, role, avatar_url, preferred_language`,
        [req.user!.userId, first_name, last_name, phone, preferred_language, avatar_url]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ success: false, message: 'User not found' });
      }

      res.json({ success: true, message: 'Profile updated', data: result.rows[0] });
    } catch (error) {
      logger.error('Failed to update profile', error);
      res.status(500).json({ success: false, message: 'Failed to update profile' });
    }
  }
);

// ============ ME (Current User Profile) ============
router.get('/me', authenticate, async (req: Request, res: Response) => {
  try {
    const result = await db.query(
      `SELECT u.id, u.first_name, u.last_name, u.email, u.phone, u.role, u.avatar_url,
              u.preferred_language, u.mfa_enabled, u.last_login_at, u.created_at,
              p.id as pharmacy_id, p.name as pharmacy_name, p.subscription_tier
       FROM users u
       JOIN pharmacies p ON u.pharmacy_id = p.id
       WHERE u.id = $1`,
      [req.user!.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const user = result.rows[0];
    res.json({
      success: true,
      data: {
        id: user.id,
        first_name: user.first_name,
        last_name: user.last_name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        avatar_url: user.avatar_url,
        preferred_language: user.preferred_language,
        mfa_enabled: user.mfa_enabled,
        last_login_at: user.last_login_at,
        pharmacy: {
          id: user.pharmacy_id,
          name: user.pharmacy_name,
          subscription_tier: user.subscription_tier,
        },
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch profile' });
  }
});

export default router;
