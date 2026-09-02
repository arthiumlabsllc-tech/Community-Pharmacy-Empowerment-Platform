import { Pool, PoolClient, QueryResult } from 'pg';
import config from '../config';
import logger from '../utils/logger';

const isLocalDb = config.database.url.includes('localhost') || config.database.url.includes('127.0.0.1');

const pool = new Pool({
  connectionString: config.database.url,
  max: config.database.poolSize,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
  // Cloud databases (Supabase, Render, etc.) require SSL
  ssl: isLocalDb ? undefined : { rejectUnauthorized: false },
});

pool.on('error', (err) => {
  logger.error('Unexpected database pool error', err);
  process.exit(-1);
});

pool.on('connect', () => {
  logger.info('Database pool connected');
});

/**
 * Execute a SQL query with optional parameters.
 */
export async function query(text: string, params?: any[]): Promise<QueryResult> {
  const start = Date.now();
  const result = await pool.query(text, params);
  const duration = Date.now() - start;
  logger.debug(`Query executed in ${duration}ms: ${text.substring(0, 80)}...`);
  return result;
}

/**
 * Acquire a client from the pool for transactions.
 */
export async function getClient(): Promise<PoolClient> {
  const client = await pool.connect();
  return client;
}

/**
 * Execute a function within a database transaction.
 */
export async function transaction<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Gracefully close the pool.
 */
export async function close(): Promise<void> {
  await pool.end();
  logger.info('Database pool closed');
}

export default { query, getClient, transaction, close, pool };
