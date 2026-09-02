import express, { Application, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import config from './config';
import logger from './utils/logger';
import redis from './config/redis';
import { query as dbQuery } from './config/database';

// Route imports
import authRoutes from './routes/auth.routes';
import pharmacyRoutes from './routes/pharmacy.routes';
import inventoryRoutes from './routes/inventory.routes';
import patientRoutes from './routes/patient.routes';
import nhisRoutes from './routes/nhis.routes';
import consultationRoutes from './routes/consultation.routes';
import subscriptionRoutes from './routes/subscription.routes';
import adminRoutes from './routes/admin.routes';
import uploadRoutes from './routes/upload.routes';

// Initialize Express app
const app: Application = express();

// ============ SECURITY MIDDLEWARE ============
app.use(helmet({
  contentSecurityPolicy: config.env === 'production' ? undefined : false,
}));

// CORS configuration
app.use(cors({
  origin: config.cors.origin,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.maxRequests,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many requests. Please try again later.',
  },
});
app.use(limiter);

// ============ PARSING MIDDLEWARE ============
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(compression());

// ============ LOGGING ============
if (config.env !== 'test') {
  app.use(morgan('combined', {
    stream: { write: (message: string) => logger.info(message.trim()) },
  }));
}

// ============ STATIC FILES ============
app.use('/uploads', express.static('uploads'));

// ============ HEALTH CHECK ============
app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    uptime: process.uptime(),
  });
});

// ============ DB DIAGNOSTICS (temporary - remove after debugging) ============
app.get('/debug/db', async (_req: Request, res: Response) => {
  const maskUrl = (url: string) => url.replace(/:[^:@/]+@/, ':****@');
  try {
    const conn = await dbQuery('SELECT NOW() as now, current_database() as db');
    const tables = await dbQuery(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' LIMIT 30`
    );
    let userCount = 'n/a';
    let demoUser = 'n/a';
    try {
      const uc = await dbQuery('SELECT COUNT(*)::int as count FROM users');
      userCount = uc.rows[0].count;
      const du = await dbQuery('SELECT email, role, is_active FROM users WHERE email = $1', ['demo@pharmacy.com']);
      demoUser = du.rows.length > 0 ? du.rows[0] : 'NOT FOUND';
    } catch (e: any) {
      demoUser = `users table error: ${e.message}`;
    }
    res.json({
      connected: true,
      database: conn.rows[0].db,
      serverTime: conn.rows[0].now,
      tables: tables.rows.map((r: any) => r.table_name),
      userCount,
      demoUser,
    });
  } catch (error: any) {
    res.json({
      connected: false,
      error: error.message,
      code: error.code,
      errno: error.errno,
      databaseUrl: maskUrl(config.database.url),
      poolConfig: {
        ssl: !config.database.url.includes('localhost'),
        poolSize: config.database.poolSize,
      },
    });
  }
});

// ============ API ROUTES ============
const api = express.Router();
api.use('/auth', authRoutes);
api.use('/pharmacies', pharmacyRoutes);
api.use('/inventory', inventoryRoutes);
api.use('/patients', patientRoutes);
api.use('/nhis', nhisRoutes);
api.use('/consultations', consultationRoutes);
api.use('/subscriptions', subscriptionRoutes);
api.use('/admin', adminRoutes);
api.use('/upload', uploadRoutes);

app.use(config.apiPrefix, api);

// ============ 404 HANDLER ============
app.use((_req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    message: 'Endpoint not found',
  });
});

// ============ ERROR HANDLER ============
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  logger.error('Unhandled error', {
    message: err.message,
    stack: err.stack,
    statusCode: err.statusCode || err.status || 500,
  });

  const statusCode = err.statusCode || err.status || 500;
  const message = config.env === 'production'
    ? 'An unexpected error occurred'
    : err.message;

  res.status(statusCode).json({
    success: false,
    message,
    ...(config.env !== 'production' && { stack: err.stack }),
  });
});

// ============ START SERVER ============
const startServer = async () => {
  try {
    // Connect Redis (optional â€” server starts without it)
    try {
      await redis.connect();
      logger.info('Redis connection established');
    } catch (redisError) {
      logger.warn('Redis connection failed â€” running without cache. Set REDIS_URL to enable caching.');
    }

    app.listen(config.port, () => {
      logger.info(`ðŸ¥ Pharmacy Empowerment Platform API`);
      logger.info(`   Environment: ${config.env}`);
      logger.info(`   Server running on port ${config.port}`);
      logger.info(`   API prefix: ${config.apiPrefix}`);
    });
  } catch (error) {
    logger.error('Failed to start server', error);
    process.exit(1);
  }
};

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received. Shutting down gracefully...');
  try { redis.disconnect(); } catch { /* ignore */ }
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received. Shutting down...');
  try { redis.disconnect(); } catch { /* ignore */ }
  process.exit(0);
});

startServer();

export default app;
