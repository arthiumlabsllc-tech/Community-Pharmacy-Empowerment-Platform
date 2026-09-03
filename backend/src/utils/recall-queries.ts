import { saleTime } from './sale-time';

/**
 * Recall traceability queries.
 *
 * A recall is the one stock question with a deadline and a regulator attached:
 * the FDA or a supplier names a lot, and the pharmacy has to produce every
 * person who was sold it. An answer that is quietly incomplete is worse than no
 * answer, because it is acted on — the pharmacy believes it has contacted
 * everybody.
 *
 * So the query reads from two places and says which one each row came from:
 *
 *   `batch_ledger` — sale_item_batches, written at the point of sale since
 *                    migration 003. Exact: it names the lot this line drew
 *                    from, and how many units of it.
 *
 *   `product_row`  — sale_items.batch_number on a line with no ledger behind
 *                    it. That is every sale made before batch tracking existed.
 *                    It names the lot the product was showing at the time, not
 *                    the lot this particular line took, so it is a lead rather
 *                    than a certainty — and it is the oldest stock the pharmacy
 *                    holds, which is the stock most likely to be being recalled.
 *
 * Dropping the second source would produce a clean, confident list that missed
 * all of the pharmacy's history. Reporting it with a lower confidence is the
 * honest version of the same answer.
 *
 * Extracted from the route for the reason pos-queries.ts gives: a hand-assembled
 * WHERE clause with positional placeholders is easy to get wrong in a way
 * TypeScript cannot see, and it fails at runtime against a real database.
 */

export interface BuiltQuery {
  text: string;
  params: unknown[];
}

export interface RecallFilter {
  pharmacyId: string;
  /** The lot named on the recall notice. Matched case- and space-insensitively. */
  batchNumber?: string | null;
  /** Restrict to one product, when the recall names the medicine as well. */
  inventoryId?: string | null;
  /** Free-text product name, for a recall that has not been matched to a row yet. */
  productName?: string | null;
  /** 'YYYY-MM-DD'. Both ends are inclusive. */
  from?: string | null;
  to?: string | null;
  limit?: number;
}

/**
 * A ceiling, not a default. A recall that touches more sales than this is
 * reported as truncated rather than quietly shortened — the caller is told to
 * narrow the window, and the list they were given says it is not the whole
 * answer.
 */
export const RECALL_LIMIT_MAX = 2000;
export const RECALL_LIMIT_DEFAULT = 500;

export function clampRecallLimit(value: unknown): number {
  const parsed = parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return RECALL_LIMIT_DEFAULT;
  return Math.min(parsed, RECALL_LIMIT_MAX);
}

function trimToNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

function isoDateOrNull(value: unknown): string | null {
  const text = trimToNull(value);
  if (!text) return null;
  // Accepted as YYYY-MM-DD or as a full ISO timestamp, and reduced to the date
  // part. A datetime compared against a DATE column is how a window quietly
  // loses its last day.
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : null;
}

/**
 * Every batch the recall could be about, with what is still on the shelf.
 *
 * Separate from the exposure query because the two answers are used for
 * different things: this one says what to quarantine today, that one says who
 * to contact. A recall that only produced a patient list would leave the
 * remaining stock on the shelf being sold.
 */
export function buildRecallBatchQuery(filter: RecallFilter): BuiltQuery {
  const batchNumber = trimToNull(filter.batchNumber);
  const inventoryId = trimToNull(filter.inventoryId);
  const productName = trimToNull(filter.productName);

  if (!batchNumber && !inventoryId && !productName) {
    throw new Error('A recall has to name a lot, a product or both');
  }

  return {
    text: `
      SELECT b.id,
             b.inventory_id,
             b.batch_number,
             to_char(b.expiry_date, 'YYYY-MM-DD') AS expiry_date,
             b.quantity,
             b.cost_price,
             to_char(b.received_at, 'YYYY-MM-DD') AS received_at,
             b.invoice_number,
             b.is_active,
             b.is_backfill,
             i.product_name,
             i.product_code,
             i.generic_name,
             i.manufacturer,
             i.is_active AS product_is_active,
             s.name AS supplier_name
        FROM inventory_batches b
        JOIN inventory i ON i.id = b.inventory_id
        LEFT JOIN suppliers s ON s.id = b.supplier_id
       WHERE b.pharmacy_id = $1
         AND ($2::text IS NULL OR UPPER(TRIM(b.batch_number)) = UPPER(TRIM($2::text)))
         AND ($3::uuid IS NULL OR b.inventory_id = $3::uuid)
         AND ($4::text IS NULL OR i.product_name ILIKE '%' || $4::text || '%')
       ORDER BY i.product_name, b.expiry_date ASC, b.received_at ASC`,
    params: [filter.pharmacyId, batchNumber, inventoryId, productName],
  };
}

/**
 * Every sale that dispensed the recalled stock.
 *
 * `limit` is applied as given; the caller passes one more than it wants so it
 * can tell a full list from a truncated one.
 */
export function buildRecallExposureQuery(filter: RecallFilter, limit: number): BuiltQuery {
  const batchNumber = trimToNull(filter.batchNumber);
  const inventoryId = trimToNull(filter.inventoryId);
  const productName = trimToNull(filter.productName);
  const from = isoDateOrNull(filter.from);
  const to = isoDateOrNull(filter.to);

  if (!batchNumber && !inventoryId && !productName) {
    throw new Error('A recall has to name a lot, a product or both');
  }

  const soldAt = saleTime('s');

  return {
    text: `
      WITH candidates AS (
        SELECT b.id, b.inventory_id
          FROM inventory_batches b
          JOIN inventory i ON i.id = b.inventory_id
         WHERE b.pharmacy_id = $1
           AND ($2::text IS NULL OR UPPER(TRIM(b.batch_number)) = UPPER(TRIM($2::text)))
           AND ($3::uuid IS NULL OR b.inventory_id = $3::uuid)
           AND ($4::text IS NULL OR i.product_name ILIKE '%' || $4::text || '%')
      ),

      -- Sales made since batch tracking: exact, per line, per lot.
      ledgered AS (
        SELECT sib.sale_item_id,
               sib.batch_id,
               sib.batch_number,
               sib.expiry_date,
               sib.inventory_id,
               sib.quantity,
               sib.unit_cost,
               'batch_ledger'::text AS provenance
          FROM sale_item_batches sib
         WHERE sib.pharmacy_id = $1
           AND (
                 sib.batch_id IN (SELECT id FROM candidates)
                 -- The junction keeps its own snapshot of the lot, so a batch
                 -- row that has since gone still traces. Narrowed to the same
                 -- product as the rest of the search, or a lot number reused
                 -- across two medicines would widen the recall beyond what was
                 -- asked for.
              OR (
                   UPPER(TRIM(sib.batch_number)) = UPPER(TRIM($2::text))
                   AND ($3::uuid IS NULL OR sib.inventory_id = $3::uuid)
                   AND ($4::text IS NULL
                        OR sib.inventory_id IN (SELECT inventory_id FROM candidates))
                 )
           )
      ),

      -- Sales made before it: the line's own snapshot of the product's lot is
      -- all there is. Excluded where a ledger row exists, so nothing is counted
      -- twice.
      snapshot_only AS (
        SELECT si.id AS sale_item_id,
               NULL::uuid AS batch_id,
               si.batch_number,
               si.expiry_date,
               si.inventory_id,
               si.quantity,
               si.unit_cost,
               'product_row'::text AS provenance
          FROM sale_items si
          JOIN sales s2 ON s2.id = si.sale_id AND s2.pharmacy_id = $1
         WHERE NOT EXISTS (
                 SELECT 1 FROM sale_item_batches sib WHERE sib.sale_item_id = si.id
               )
           AND ($3::uuid IS NULL OR si.inventory_id = $3::uuid)
           AND ($4::text IS NULL OR si.product_name ILIKE '%' || $4::text || '%')
           AND (
                 ($2::text IS NOT NULL
                  AND UPPER(TRIM(si.batch_number)) = UPPER(TRIM($2::text)))
                 -- With no lot named there is nothing to match a snapshot
                 -- against, so the product is the handle.
              OR ($2::text IS NULL AND ($3::uuid IS NOT NULL OR $4::text IS NOT NULL))
               )
      ),

      exposure AS (
        SELECT sale_item_id, batch_id, batch_number, expiry_date, inventory_id,
               quantity, unit_cost, provenance
          FROM ledgered
        UNION ALL
        SELECT sale_item_id, batch_id, batch_number, expiry_date, inventory_id,
               quantity, unit_cost, provenance
          FROM snapshot_only
      )

      SELECT e.provenance,
             e.batch_id,
             e.batch_number AS matched_batch_number,
             to_char(e.expiry_date, 'YYYY-MM-DD') AS expiry_date,
             e.quantity,
             e.unit_cost,
             e.inventory_id,
             si.product_name,
             si.product_code,
             si.generic_name,
             si.sell_unit,
             si.requires_prescription,
             s.id AS sale_id,
             s.receipt_number,
             s.status AS sale_status,
             s.voided_at IS NOT NULL AS voided,
             s.recorded_offline,
             ${soldAt} AS sold_at,
             s.customer_name,
             s.customer_phone,
             p.id AS patient_id,
             p.first_name AS patient_first_name,
             p.last_name AS patient_last_name,
             p.phone AS patient_phone,
             p.alternate_phone AS patient_alternate_phone,
             p.nhis_number AS patient_nhis_number,
             u.id AS served_by_id,
             u.first_name AS served_by_first_name,
             u.last_name AS served_by_last_name
        FROM exposure e
        JOIN sale_items si ON si.id = e.sale_item_id
        JOIN sales s ON s.id = si.sale_id
        LEFT JOIN patients p ON p.id = s.patient_id
        LEFT JOIN users u ON u.id = s.served_by
       WHERE s.pharmacy_id = $1
         AND ($5::date IS NULL OR (${soldAt})::date >= $5::date)
         AND ($6::date IS NULL OR (${soldAt})::date <= $6::date)
       ORDER BY ${soldAt} DESC, s.receipt_number ASC
       LIMIT $7`,
    params: [filter.pharmacyId, batchNumber, inventoryId, productName, from, to, limit],
  };
}

/** One row of the exposure query, as node-postgres hands it over. */
export interface RecallExposureRow {
  provenance: 'batch_ledger' | 'product_row';
  batch_id: string | null;
  matched_batch_number: string | null;
  expiry_date: string | null;
  quantity: number;
  unit_cost: string | number;
  inventory_id: string | null;
  product_name: string;
  product_code: string | null;
  generic_name: string | null;
  sell_unit: string;
  requires_prescription: boolean;
  sale_id: string;
  receipt_number: string;
  sale_status: string;
  voided: boolean;
  recorded_offline: boolean;
  sold_at: Date | string;
  customer_name: string | null;
  customer_phone: string | null;
  patient_id: string | null;
  patient_first_name: string | null;
  patient_last_name: string | null;
  patient_phone: string | null;
  patient_alternate_phone: string | null;
  patient_nhis_number: string | null;
  served_by_id: string | null;
  served_by_first_name: string | null;
  served_by_last_name: string | null;
}

/**
 * The best telephone number for a row, or null when there is none.
 *
 * A patient record beats the name and number keyed at the till, because the
 * record is what the pharmacy checks. A walk-in cash sale with neither is
 * genuinely untraceable, and counting it as reachable would be the one way to
 * make a recall look finished when it is not.
 */
export function recallContact(row: {
  patient_phone: string | null;
  patient_alternate_phone: string | null;
  customer_phone: string | null;
}): { phone: string | null; source: 'patient' | 'customer' | null } {
  const patientPhone = trimToNull(row.patient_phone);
  if (patientPhone) return { phone: patientPhone, source: 'patient' };

  const alternate = trimToNull(row.patient_alternate_phone);
  if (alternate) return { phone: alternate, source: 'patient' };

  const customerPhone = trimToNull(row.customer_phone);
  if (customerPhone) return { phone: customerPhone, source: 'customer' };

  return { phone: null, source: null };
}

/**
 * How many units of a lot reached people who cannot be phoned.
 *
 * Reported alongside the reachable count rather than folded into it. This is
 * the number that decides whether a recall needs a notice in the window and a
 * call to the supplier, or whether a round of phone calls closes it.
 */
export interface RecallReach {
  reachableUnits: number;
  unreachableUnits: number;
  reachableSales: number;
  unreachableSales: number;
  /** Distinct phone numbers, so one patient buying the lot twice is one call. */
  distinctContacts: number;
}

export function summariseReach(
  rows: Array<{
    quantity: number;
    voided: boolean;
    patient_phone: string | null;
    patient_alternate_phone: string | null;
    customer_phone: string | null;
  }>
): RecallReach {
  const contacts = new Set<string>();
  const summary: RecallReach = {
    reachableUnits: 0,
    unreachableUnits: 0,
    reachableSales: 0,
    unreachableSales: 0,
    distinctContacts: 0,
  };

  for (const row of rows) {
    // A voided sale came back. It is still listed — the patient may have been
    // given a replacement from the same lot, and they were exposed either way —
    // but it is not counted as stock that is out there.
    if (row.voided) continue;

    const units = Number(row.quantity) || 0;
    const { phone } = recallContact(row);

    if (phone) {
      contacts.add(phone);
      summary.reachableUnits += units;
      summary.reachableSales += 1;
    } else {
      summary.unreachableUnits += units;
      summary.unreachableSales += 1;
    }
  }

  summary.distinctContacts = contacts.size;
  return summary;
}
