import { QueryResult } from 'pg';
import logger from './logger';
import { toIsoDate, type BatchRow } from './fefo';

/**
 * Reading and writing the batch tables.
 *
 * Everything here works against a caller-owned transaction. None of it starts
 * one, because the point of a batch operation is that it lands or does not land
 * together with the sale, the delivery or the stock-take that caused it. The
 * read-only helpers accept either a pool or a transaction client, so a page
 * listing batches does not have to open a transaction to do it.
 */

/** Anything that can run a query: the pool, or a client inside a transaction. */
export interface Queryable {
  query(text: string, params?: any[]): Promise<QueryResult>;
}

/**
 * Whether batch tracking is installed at all.
 *
 * Migration 003 adds the tables. A pharmacy that has applied 001 and 002 but
 * not that one keeps working: stock is read from and written to the product row
 * exactly as before, because the derived-stock trigger leaves a product with no
 * batches alone. What it loses is FEFO rotation and the recall trail, so the
 * first time that is noticed it is logged rather than passed over.
 *
 * Only a positive answer is remembered. A table that exists is not going to
 * disappear, and caching the negative would mean applying the migration needs a
 * restart to take effect.
 *
 * Probed with to_regclass rather than by catching the error, because a failed
 * statement aborts a Postgres transaction and every query after it fails too.
 */
let batchTablesPresent: boolean | null = null;

export async function hasBatchTables(client: Queryable): Promise<boolean> {
  if (batchTablesPresent) return true;

  const result = await client.query(
    `SELECT to_regclass('public.inventory_batches') IS NOT NULL
        AND to_regclass('public.sale_item_batches') IS NOT NULL
        AND to_regclass('public.stock_movements') IS NOT NULL AS present`
  );
  batchTablesPresent = Boolean(result.rows[0]?.present);

  if (!batchTablesPresent) {
    logger.warn(
      'Batch tracking is not installed. Run database/migrations/003_inventory_batches.sql. ' +
        'Falling back to one stock figure per product, so there is no FEFO rotation, ' +
        'no batch costing and no way to answer a recall.'
    );
  }

  return batchTablesPresent;
}

/** Test hook: forgets the probe so a suite can change the schema underneath it. */
export function resetBatchTablesProbe(): void {
  batchTablesPresent = null;
}

/**
 * Loads every batch for a set of products, grouped by product id.
 *
 * Inactive and empty batches are included on purpose: the allocator decides
 * what is usable and reports what is not, and a sale recorded during an outage
 * needs the empty ones as somewhere to hang units that have physically gone.
 */
export async function loadBatches(
  client: Queryable,
  pharmacyId: string,
  inventoryIds: string[],
  lock = false
): Promise<Map<string, BatchRow[]>> {
  const grouped = new Map<string, BatchRow[]>();
  if (inventoryIds.length === 0) return grouped;
  if (!(await hasBatchTables(client))) return grouped;

  const result = await client.query(
    `SELECT id, inventory_id, batch_number, expiry_date, quantity, cost_price,
            received_at, is_active
       FROM inventory_batches
      WHERE pharmacy_id = $1 AND inventory_id = ANY($2::uuid[])
      ORDER BY inventory_id, expiry_date ASC, received_at ASC
      ${lock ? 'FOR UPDATE' : ''}`,
    [pharmacyId, inventoryIds]
  );

  for (const row of result.rows) {
    const batch: BatchRow = {
      id: row.id,
      batchNumber: String(row.batch_number),
      // Converted at the boundary. A DATE column arrives from node-postgres as
      // a JavaScript Date at local midnight, and comparing that against an ISO
      // string is how an expiry date moves by a day.
      expiryDate: toIsoDate(row.expiry_date),
      quantity: Number(row.quantity) || 0,
      unitCost: Number(row.cost_price) || 0,
      receivedAt: toIsoDate(row.received_at),
      isActive: row.is_active !== false,
    };

    const existing = grouped.get(row.inventory_id);
    if (existing) existing.push(batch);
    else grouped.set(row.inventory_id, [batch]);
  }

  return grouped;
}

/** The reasons stock_movements accepts. Mirrors the CHECK in migration 003. */
export type MovementReason =
  | 'receipt'
  | 'opening_balance'
  | 'sale'
  | 'sale_void'
  | 'adjustment'
  | 'expiry_writeoff'
  | 'damage_writeoff'
  | 'recall'
  | 'transfer_in'
  | 'transfer_out';

export interface Movement {
  pharmacyId: string;
  inventoryId: string;
  batchId: string | null;
  /** Positive is stock arriving, negative is stock leaving. Never zero. */
  quantityChange: number;
  /** What the batch held afterwards. Taken from the UPDATE, never computed here. */
  quantityAfter: number;
  reason: MovementReason;
  note?: string | null;
  saleId?: string | null;
  saleItemId?: string | null;
  supplierId?: string | null;
  userId?: string | null;
  /**
   * When it really happened. A sale queued offline arrives late, and the
   * movement belongs to the moment the goods left, not the moment the sync ran.
   */
  occurredAt?: string | null;
}

/**
 * Writes one row of the stock ledger.
 *
 * The ledger is the only record of *why* a count changed. The batch says what
 * is on the shelf now; this says every step that got it there, which is what a
 * stock-take discrepancy, an insurer or the FDA asks for.
 */
export async function recordMovement(client: Queryable, movement: Movement): Promise<void> {
  if (!Number.isFinite(movement.quantityChange) || movement.quantityChange === 0) {
    // A zero movement would be a row saying nothing happened. The CHECK
    // constraint would refuse it anyway; refusing here says why.
    throw new Error('A stock movement has to change the count by something');
  }

  await client.query(
    `INSERT INTO stock_movements
       (pharmacy_id, inventory_id, batch_id, quantity_change, quantity_after,
        reason, note, sale_id, sale_item_id, supplier_id, user_id, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,COALESCE($12::timestamptz, NOW()))`,
    [
      movement.pharmacyId,
      movement.inventoryId,
      movement.batchId,
      movement.quantityChange,
      movement.quantityAfter,
      movement.reason,
      movement.note ?? null,
      movement.saleId ?? null,
      movement.saleItemId ?? null,
      movement.supplierId ?? null,
      movement.userId ?? null,
      movement.occurredAt ?? null,
    ]
  );
}

/**
 * How many batches a product is being tracked by.
 *
 * Decides whether the caller writes stock figures to the product row or to its
 * batches. Getting it the wrong way round is not an error so much as a silent
 * one: with batches present the derived-stock trigger recomputes the product
 * row a moment later, so a direct write to `inventory.quantity` simply does not
 * happen.
 */
export async function countBatches(
  client: Queryable,
  pharmacyId: string,
  inventoryId: string
): Promise<number> {
  if (!(await hasBatchTables(client))) return 0;

  const result = await client.query(
    `SELECT COUNT(*)::int AS n FROM inventory_batches
      WHERE pharmacy_id = $1 AND inventory_id = $2`,
    [pharmacyId, inventoryId]
  );
  return Number(result.rows[0]?.n ?? 0);
}
