import fs from 'fs';
import path from 'path';
import db from '../config/database';
import logger from '../utils/logger';

/**
 * Incremental migration runner.
 *
 * The previous version replayed database/init.sql every time, which fails as
 * soon as the tables already exist — so a deployed database could never be
 * evolved. This version:
 *
 *   1. bootstraps from init.sql only when the schema is actually empty
 *   2. then applies every database/migrations/*.sql file once, in filename
 *      order, recording each in schema_migrations
 *
 * Each file runs in its own transaction, so a half-applied migration rolls
 * back cleanly and can be retried after the error is fixed.
 */

const DATABASE_DIR = path.join(__dirname, '../../../database');
const MIGRATIONS_DIR = path.join(DATABASE_DIR, 'migrations');
const INIT_SQL = path.join(DATABASE_DIR, 'init.sql');
const BASELINE = '000_init.sql';

async function ensureLedger(): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function appliedMigrations(): Promise<Set<string>> {
  const result = await db.query('SELECT name FROM schema_migrations');
  return new Set(result.rows.map((row: { name: string }) => row.name));
}

/** True when nothing but the ledger exists, i.e. a brand new database. */
async function schemaIsEmpty(): Promise<boolean> {
  const result = await db.query(
    `SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'pharmacies' LIMIT 1`
  );
  return result.rows.length === 0;
}

async function runSqlFile(label: string, sql: string): Promise<void> {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query(
      'INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING',
      [label]
    );
    await client.query('COMMIT');
    logger.info(`Applied ${label}`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function listMigrationFiles(): string[] {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];

  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .sort();
}

async function migrate(): Promise<void> {
  logger.info('Running database migrations...');

  try {
    await ensureLedger();
    const applied = await appliedMigrations();

    if (!applied.has(BASELINE)) {
      if (await schemaIsEmpty()) {
        logger.info('Empty schema detected — bootstrapping from init.sql');
        await runSqlFile(BASELINE, fs.readFileSync(INIT_SQL, 'utf8'));
        applied.add(BASELINE);
      } else {
        // An existing database predating the ledger. Record the baseline
        // without replaying it, then let the incremental files catch it up.
        await db.query('INSERT INTO schema_migrations (name) VALUES ($1)', [BASELINE]);
        applied.add(BASELINE);
        logger.info('Existing schema detected — baseline recorded without replaying init.sql');
      }
    }

    const pending = listMigrationFiles().filter((file) => !applied.has(file));

    if (pending.length === 0) {
      logger.info('Database is up to date — no pending migrations');
      return;
    }

    for (const file of pending) {
      await runSqlFile(file, fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
    }

    logger.info(`Applied ${pending.length} migration(s)`);
  } catch (error) {
    logger.error('Migration failed', error);
    process.exit(1);
  } finally {
    await db.close();
  }
}

migrate();
