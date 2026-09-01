import fs from 'fs';
import path from 'path';
import db from '../config/database';
import logger from '../utils/logger';

async function migrate(): Promise<void> {
  logger.info('Running database migrations...');

  try {
    const sqlPath = path.join(__dirname, '../../../database/init.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');

    await db.query(sql);
    logger.info('Database migrations completed successfully');
  } catch (error) {
    logger.error('Migration failed', error);
    process.exit(1);
  } finally {
    await db.close();
  }
}

migrate();
