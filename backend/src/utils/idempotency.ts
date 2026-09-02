import { PoolClient } from 'pg';
import { Request } from 'express';
import db from '../config/database';
import logger from './logger';

/**
 * Idempotent replay for writes that a disconnected client may send twice.
 *
 * The failure this protects against is not "the request never arrived". It is
 * "the request arrived, committed, and the response was lost on the way back"
 * — which is the common case on an intermittent mobile connection, where the
 * signal returns for a moment and drops again mid-response. A client that
 * retries on a timeout therefore cannot know whether the write happened, and
 * must assume it might have.
 *
 * The client generates a UUID per queued write and sends it as
 * `X-Client-Request-Id`. The first request is processed normally and its
 * response stored against the key; a repeat returns that stored response
 * verbatim. The client cannot distinguish a replay from the original, which is
 * the point — it records one patient, not two.
 *
 * Keys are scoped by pharmacy, so a key from one pharmacy can never replay
 * another's response even if the UUIDs somehow collided.
 */

export interface Replay {
  status: number;
  body: unknown;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Header wins over the body: a queued request carries both, and the header is
 *  the one the sync engine sets deliberately. */
export function readClientRequestId(req: Request): string | null {
  const header = req.header('X-Client-Request-Id');
  const candidate = header || (typeof req.body?.client_request_id === 'string' ? req.body.client_request_id : null);

  // Rejecting a malformed key rather than truncating or hashing it: a key the
  // server silently reinterpreted would not match on retry, and the duplicate
  // would appear with no explanation.
  if (!candidate || !UUID_PATTERN.test(candidate)) return null;
  return candidate.toLowerCase();
}

/**
 * Returns the stored response for a key already seen, or null on a first
 * attempt. Called before doing any work.
 */
export async function findReplay(pharmacyId: string, clientRequestId: string | null): Promise<Replay | null> {
  if (!clientRequestId) return null;

  try {
    const result = await db.query(
      `SELECT response_status, response_body FROM idempotency_keys
        WHERE pharmacy_id = $1 AND client_request_id = $2`,
      [pharmacyId, clientRequestId]
    );

    if (result.rows.length === 0) return null;
    return { status: result.rows[0].response_status, body: result.rows[0].response_body };
  } catch (error) {
    // A missing idempotency_keys table (migration not yet applied) must not
    // take the endpoint down — it just loses replay protection. Say so loudly
    // rather than failing quietly, because duplicates are the consequence.
    logger.error('Idempotency lookup failed — replaying without protection', error);
    return null;
  }
}

/**
 * Stores the response produced for a key. Pass the handler's PoolClient to
 * commit the record atomically with the write it describes; omit it to record
 * on the pool afterwards.
 *
 * ON CONFLICT DO NOTHING because two identical requests can be in flight at
 * once, and the first response is the one worth keeping.
 */
export async function recordReplay(params: {
  pharmacyId: string;
  clientRequestId: string | null;
  userId?: string | null;
  endpoint: string;
  status: number;
  body: unknown;
  client?: PoolClient;
}): Promise<void> {
  const { pharmacyId, clientRequestId, userId = null, endpoint, status, body, client } = params;
  if (!clientRequestId) return;

  const sql = `INSERT INTO idempotency_keys
                 (pharmacy_id, client_request_id, user_id, endpoint, response_status, response_body)
               VALUES ($1, $2, $3, $4, $5, $6::jsonb)
               ON CONFLICT (pharmacy_id, client_request_id) DO NOTHING`;
  const values = [pharmacyId, clientRequestId, userId, endpoint, status, JSON.stringify(body)];

  try {
    if (client) {
      await client.query(sql, values);
    } else {
      await db.query(sql, values);
    }
  } catch (error) {
    // Losing the record is not worth failing a write that already succeeded —
    // the pharmacy has its patient or its sale. It does mean a retry could
    // duplicate, so this is logged as an error rather than a warning.
    logger.error('Failed to record idempotency key — a retry may duplicate this write', {
      endpoint,
      clientRequestId,
      error,
    });
  }
}

/**
 * Drops keys old enough that no device can still be holding the request.
 * Intended for a maintenance job; exported so one can be wired to it.
 */
export async function pruneReplays(olderThanDays = 30): Promise<number> {
  const result = await db.query(
    `DELETE FROM idempotency_keys WHERE created_at < NOW() - ($1 || ' days')::interval`,
    [String(olderThanDays)]
  );
  return result.rowCount ?? 0;
}
