import db from '../config/database';
import logger from '../utils/logger';

async function reset(): Promise<void> {
  logger.info('Resetting database...');
  try {
    await db.query(`
      DROP TABLE IF EXISTS audit_logs, chat_messages, reminders, notifications,
      payments, subscriptions, screenings, consultations, reimbursements,
      nhis_claims, prescriptions, inventory, suppliers, patients, users,
      pharmacies, feature_flags, subscription_plans CASCADE;
    `);
    logger.info('All tables dropped. Run db:migrate to recreate.');
  } catch (error) {
    logger.error('Reset failed', error);
    process.exit(1);
  } finally {
    await db.close();
  }
}

reset();
