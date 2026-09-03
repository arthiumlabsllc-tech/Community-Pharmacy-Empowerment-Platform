import fs from 'fs';
import path from 'path';
import {
  buildRecallBatchQuery,
  buildRecallExposureQuery,
  type RecallFilter,
} from './recall-queries';
import { inlineParams } from './sql-literal';
import { Harness } from './verify-harness';

/**
 * Renders database/tests/004_recall_verify.sql.
 *
 * The recall query is a hundred lines of CTE with seven positional parameters
 * and two UNION'd sources. Copying it into a .sql file by hand would prove that
 * *the copy* runs, and the copy would silently stop being the query the first
 * time the builder changed — which is the exact failure this harness exists to
 * prevent, since a recall that errors is noticed but a recall that quietly
 * returns half the patients is not.
 *
 * So the file is generated: the SQL in it is the string `buildRecallExposureQuery`
 * actually returns, with the parameters inlined as typed literals so psql can run
 * it without a driver. `src/__tests__/recall-sql.test.ts` re-renders on every
 * run and fails when the committed file is stale, so changing the builder
 * without regenerating is a broken build rather than a stale test.
 *
 *   cd backend && npm run recall:emit
 */

/**
 * Resolved from __dirname rather than the working directory, so it lands in the
 * same place whether this runs from src under ts-node, from dist after a build,
 * or from jest with a different working directory.
 */
export const RECALL_VERIFY_PATH = path.resolve(
  __dirname,
  '../../../database/tests/004_recall_verify.sql'
);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PHARMACY = '11111111-1111-1111-1111-111111111111';
const PHARMACIST = '22222222-2222-2222-2222-222222222222';
const PATIENT = '66666666-6666-6666-6666-666666666666';
const AMOX = '33333333-3333-3333-3333-333333333333';
const PARA = '77777777-7777-7777-7777-777777777777';
const SUPPLIER = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1';

const BATCH_AMOX_RECALL = 'b0000000-0000-0000-0000-0000000000a1';
const BATCH_AMOX_OTHER = 'b0000000-0000-0000-0000-0000000000a2';
const BATCH_PARA_RECALL = 'b0000000-0000-0000-0000-0000000000b1';

/** Deliberately reused across two products: lot numbers are unique per medicine,
 *  not per pharmacy, and a recall that ignored that would phone the wrong people. */
const LOT = 'B/RECALL';

const FIXTURES = `
-- ---------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------
INSERT INTO pharmacies (id, name, license_number, phone)
VALUES ('${PHARMACY}', 'Recall Test Pharmacy', 'LIC-VERIFY-004', '0240000004');

INSERT INTO users (id, pharmacy_id, role, first_name, last_name, email, password_hash)
VALUES ('${PHARMACIST}', '${PHARMACY}', 'pharmacist', 'Ama', 'Osei',
        'ama.recall@test.gh', 'x');

INSERT INTO patients (id, pharmacy_id, first_name, last_name, phone, alternate_phone)
VALUES ('${PATIENT}', '${PHARMACY}', 'Efua', 'Boateng', '0241111111', '0241111112');

INSERT INTO suppliers (id, pharmacy_id, name)
VALUES ('${SUPPLIER}', '${PHARMACY}', 'Recall Supplier');

INSERT INTO inventory (id, pharmacy_id, product_name, product_code, quantity,
                       unit_price, cost_price, expiry_date, reorder_level)
VALUES
  ('${AMOX}', '${PHARMACY}', 'Amoxicillin 500mg', 'AMOX-500', 0, 12.00, 0,
   CURRENT_DATE + 365, 15),
  ('${PARA}', '${PHARMACY}', 'Paracetamol 500mg', 'PARA-500', 0, 9.00, 0,
   CURRENT_DATE + 365, 20);

INSERT INTO inventory_batches (id, pharmacy_id, inventory_id, batch_number, expiry_date,
                               quantity, cost_price, supplier_id, invoice_number,
                               received_at)
VALUES
  ('${BATCH_AMOX_RECALL}', '${PHARMACY}', '${AMOX}', '${LOT}', CURRENT_DATE + 100,
   12, 4.00, '${SUPPLIER}', 'INV-A1', CURRENT_DATE - 40),
  ('${BATCH_AMOX_OTHER}', '${PHARMACY}', '${AMOX}', 'B/OTHER', CURRENT_DATE + 200,
   5, 5.00, '${SUPPLIER}', 'INV-A2', CURRENT_DATE - 10),
  ('${BATCH_PARA_RECALL}', '${PHARMACY}', '${PARA}', '${LOT}', CURRENT_DATE + 150,
   8, 2.00, '${SUPPLIER}', 'INV-P1', CURRENT_DATE - 20);

-- Sales made since batch tracking: sale_item_batches names the lot each line
-- drew from. S1 spans two lots and carries the joined label the receipt prints,
-- which must not be mistaken for a lot number of its own. S5 is the exception,
-- inserted with the others but given no junction rows below.
INSERT INTO sales (id, pharmacy_id, receipt_number, served_by, total_amount, status,
                   patient_id, customer_name, customer_phone)
VALUES
  ('c0000000-0000-0000-0000-000000000001', '${PHARMACY}', 'R-REC-0001', '${PHARMACIST}',
   60.00, 'completed', '${PATIENT}', NULL, NULL),
  ('c0000000-0000-0000-0000-000000000003', '${PHARMACY}', 'R-REC-0003', '${PHARMACIST}',
   12.00, 'completed', NULL, NULL, NULL),
  ('c0000000-0000-0000-0000-000000000004', '${PHARMACY}', 'R-REC-0004', '${PHARMACIST}',
   24.00, 'voided', '${PATIENT}', NULL, NULL),
  ('c0000000-0000-0000-0000-000000000005', '${PHARMACY}', 'R-REC-0005', '${PHARMACIST}',
   72.00, 'completed', '${PATIENT}', NULL, NULL),
  ('c0000000-0000-0000-0000-000000000006', '${PHARMACY}', 'R-REC-0006', '${PHARMACIST}',
   27.00, 'completed', NULL, 'Yaw Adjei', '0243333333');

-- S2 was rung up during an outage. client_recorded_at is three days ago and
-- created_at is today, so a window that used created_at would put this sale in
-- the wrong week and a recall bounded by "last month" would miss it.
INSERT INTO sales (id, pharmacy_id, receipt_number, served_by, total_amount, status,
                   patient_id, customer_name, customer_phone, recorded_offline,
                   client_recorded_at, created_at)
VALUES ('c0000000-0000-0000-0000-000000000002', '${PHARMACY}', 'R-REC-0002', '${PHARMACIST}',
        48.00, 'completed', NULL, 'Kofi Mensah', '0242222222', true,
        NOW() - INTERVAL '3 days', NOW());

UPDATE sales SET voided_at = NOW(), void_reason = 'Customer returned it'
 WHERE id = 'c0000000-0000-0000-0000-000000000004';

INSERT INTO sale_items (id, sale_id, inventory_id, product_name, product_code,
                        batch_number, expiry_date, quantity, sell_unit, unit_price,
                        line_total, unit_cost)
VALUES
  ('d0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001',
   '${AMOX}', 'Amoxicillin 500mg', 'AMOX-500', '${LOT}+B/OTHER', CURRENT_DATE + 100,
   5, 'pack', 12.00, 60.00, 4.40),
  ('d0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000002',
   '${AMOX}', 'Amoxicillin 500mg', 'AMOX-500', '${LOT}', CURRENT_DATE + 100,
   4, 'pack', 12.00, 48.00, 4.00),
  ('d0000000-0000-0000-0000-000000000003', 'c0000000-0000-0000-0000-000000000003',
   '${AMOX}', 'Amoxicillin 500mg', 'AMOX-500', '${LOT}', CURRENT_DATE + 100,
   1, 'pack', 12.00, 12.00, 4.00),
  ('d0000000-0000-0000-0000-000000000004', 'c0000000-0000-0000-0000-000000000004',
   '${AMOX}', 'Amoxicillin 500mg', 'AMOX-500', '${LOT}', CURRENT_DATE + 100,
   2, 'pack', 12.00, 24.00, 4.00),
  -- No junction rows: a sale from before batch tracking existed. The line's own
  -- snapshot of the product's lot is the only handle there is, and it is the
  -- oldest stock in the building — the stock a recall is most likely to be about.
  ('d0000000-0000-0000-0000-000000000005', 'c0000000-0000-0000-0000-000000000005',
   '${AMOX}', 'Amoxicillin 500mg', 'AMOX-500', '${LOT}', CURRENT_DATE + 100,
   6, 'pack', 12.00, 72.00, 4.00),
  ('d0000000-0000-0000-0000-000000000006', 'c0000000-0000-0000-0000-000000000006',
   '${PARA}', 'Paracetamol 500mg', 'PARA-500', '${LOT}', CURRENT_DATE + 150,
   3, 'pack', 9.00, 27.00, 2.00);

INSERT INTO sale_item_batches (sale_item_id, pharmacy_id, batch_id, batch_number,
                               expiry_date, inventory_id, quantity, unit_cost)
VALUES
  ('d0000000-0000-0000-0000-000000000001', '${PHARMACY}', '${BATCH_AMOX_RECALL}',
   '${LOT}', CURRENT_DATE + 100, '${AMOX}', 3, 4.00),
  ('d0000000-0000-0000-0000-000000000001', '${PHARMACY}', '${BATCH_AMOX_OTHER}',
   'B/OTHER', CURRENT_DATE + 200, '${AMOX}', 2, 5.00),
  ('d0000000-0000-0000-0000-000000000002', '${PHARMACY}', '${BATCH_AMOX_RECALL}',
   '${LOT}', CURRENT_DATE + 100, '${AMOX}', 4, 4.00),
  ('d0000000-0000-0000-0000-000000000003', '${PHARMACY}', '${BATCH_AMOX_RECALL}',
   '${LOT}', CURRENT_DATE + 100, '${AMOX}', 1, 4.00),
  ('d0000000-0000-0000-0000-000000000004', '${PHARMACY}', '${BATCH_AMOX_RECALL}',
   '${LOT}', CURRENT_DATE + 100, '${AMOX}', 2, 4.00),
  ('d0000000-0000-0000-0000-000000000006', '${PHARMACY}', '${BATCH_PARA_RECALL}',
   '${LOT}', CURRENT_DATE + 150, '${PARA}', 3, 2.00);
`;

// ---------------------------------------------------------------------------
// Parameter inlining
// ---------------------------------------------------------------------------

/** The types node-postgres leaves to inference, declared so psql can run the
 *  same text without a driver. A bare literal would arrive as text, and text
 *  does not compare against uuid. */
const BATCH_QUERY_TYPES = ['uuid', 'text', 'uuid', 'text'];
const EXPOSURE_QUERY_TYPES = ['uuid', 'text', 'uuid', 'text', 'date', 'date', 'integer'];

/**
 * The date window has to be relative to the run — "the ten days before today" —
 * and there is no way to say that through the builder: `isoDateOrNull` accepts
 * an ISO date or nothing, so a placeholder string arrives as NULL and switches
 * the window off, which would leave the assertion passing against a query that
 * filtered nothing. Baking in today's real date is worse, because the generated
 * file would then differ every day and the staleness test would fail on the
 * second one.
 *
 * So the builder is called with two sentinels that are valid ISO dates, and the
 * literals it emits are swapped for expressions relative to CURRENT_DATE. The
 * sentinels are chosen to be dates no fixture could ever carry.
 */
const WINDOW_FROM_SENTINEL = '1970-01-01';
const WINDOW_TO_SENTINEL = '1970-01-02';
const WINDOW_FROM_SQL = '(CURRENT_DATE - 10)';
const WINDOW_TO_SQL = '(CURRENT_DATE - 1)';

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function view(name: string, filter: RecallFilter, limit: number, comment: string): string {
  const query = buildRecallExposureQuery(filter, limit);
  return `
-- ${comment}
CREATE TEMP VIEW ${name} AS
${inlineParams(query, EXPOSURE_QUERY_TYPES)};
`;
}

function batchView(name: string, filter: RecallFilter, comment: string): string {
  const query = buildRecallBatchQuery(filter);
  return `
-- ${comment}
CREATE TEMP VIEW ${name} AS
${inlineParams(query, BATCH_QUERY_TYPES)};
`;
}

export function renderRecallVerifySql(): string {
  const h = new Harness();

  const lotOnly: RecallFilter = { pharmacyId: PHARMACY, batchNumber: LOT };
  const lotAndProduct: RecallFilter = {
    pharmacyId: PHARMACY,
    batchNumber: LOT,
    inventoryId: AMOX,
  };
  const lotMessy: RecallFilter = {
    pharmacyId: PHARMACY,
    batchNumber: `  ${LOT.toLowerCase()}  `,
  };
  const productOnly: RecallFilter = { pharmacyId: PHARMACY, inventoryId: AMOX };
  const productNameOnly: RecallFilter = { pharmacyId: PHARMACY, productName: 'amox' };
  const lotAndProductName: RecallFilter = {
    pharmacyId: PHARMACY,
    batchNumber: LOT,
    productName: 'amox',
  };

  const sections: string[] = [];

  sections.push(`-- =====================================================================
-- Verification harness for the recall traceability queries
-- =====================================================================
-- GENERATED FILE — DO NOT EDIT BY HAND.
--
-- Rendered from backend/src/utils/recall-queries.ts by
-- backend/src/utils/recall-verify-sql.ts, so the SQL below is the string the
-- API actually sends, with its parameters inlined as typed literals. Editing it
-- by hand changes nothing; editing the builder and not regenerating fails
-- backend/src/__tests__/recall-sql.test.ts.
--
--   cd backend && npm run recall:emit
--   psql -v ON_ERROR_STOP=1 -d pharmacy -f 004_recall_verify.sql
-- =====================================================================

\\set ON_ERROR_STOP on

BEGIN;
${FIXTURES}`);

  sections.push(`
-- ---------------------------------------------------------------------
-- The views under test
-- ---------------------------------------------------------------------
-- Each is one call to the builder, so what runs here and what the route sends
-- are the same text.
`);

  sections.push(
    view(
      'recall_by_lot',
      lotOnly,
      501,
      'The lot on its own: both medicines that carry it, both sources of truth.'
    )
  );
  sections.push(
    view(
      'recall_by_lot_and_product',
      lotAndProduct,
      501,
      'The lot narrowed to one medicine. Lot numbers repeat across products, so\n-- this is the difference between a recall and a panic.'
    )
  );
  sections.push(
    view(
      'recall_lot_messy',
      lotMessy,
      501,
      'The same lot as read off a fax: lower case and padded with spaces.'
    )
  );
  sections.push(
    view(
      'recall_by_product',
      productOnly,
      501,
      'No lot named at all — every sale of the product, from either source.'
    )
  );
  sections.push(
    view(
      'recall_by_product_name',
      productNameOnly,
      501,
      'A product name before it has been matched to an inventory row.'
    )
  );
  sections.push(
    view(
      'recall_lot_and_product_name',
      lotAndProductName,
      501,
      'Both, which is how a recall notice usually arrives.'
    )
  );
  sections.push(
    view(
      'recall_offline_window',
      {
        pharmacyId: PHARMACY,
        batchNumber: LOT,
        from: WINDOW_FROM_SENTINEL,
        to: WINDOW_TO_SENTINEL,
      },
      501,
      'The ten days before today, which excludes today. Only the outage sale\n-- falls inside it, and only when the window reads client_recorded_at.'
    )
  );
  sections.push(
    view('recall_truncated', lotOnly, 4, 'One more than the caller asked for, so a full\n-- list is distinguishable from a shortened one.')
  );

  sections.push(
    batchView(
      'batches_by_lot',
      lotOnly,
      'What is still on the shelf for that lot — the quarantine half of the answer.'
    )
  );
  sections.push(
    batchView(
      'batches_by_lot_and_product',
      lotAndProduct,
      'Narrowed to the medicine the recall names.'
    )
  );
  sections.push(
    batchView(
      'batches_by_product_name',
      productNameOnly,
      'Every lot of a product, when the recall has not named one.'
    )
  );

  sections.push(`
-- ---------------------------------------------------------------------
-- Assertions
-- ---------------------------------------------------------------------`);

  // 6 rows: five from the ledger, one from a receipt line with no ledger behind it.
  sections.push(h.expectRows('recall_by_lot', 6, 'the lot on its own reaches every sale of it'));
  sections.push(
    h.expectNumber(
      'recall_by_lot',
      `COUNT(*) FILTER (WHERE provenance = 'batch_ledger')`,
      5,
      'five lines are traced to a batch'
    )
  );
  sections.push(
    h.expectNumber(
      'recall_by_lot',
      `COUNT(*) FILTER (WHERE provenance = 'product_row')`,
      1,
      'the pre-tracking sale is found rather than dropped'
    )
  );

  // Narrowing to the medicine must drop the paracetamol sale, which carries the
  // same lot number. Lot numbers repeat across products; a recall that ignored
  // that would phone everybody who ever bought paracetamol.
  sections.push(
    h.expectRows('recall_by_lot_and_product', 5, 'narrowing to the medicine drops the other one')
  );
  sections.push(
    h.expectNumber(
      'recall_by_lot_and_product',
      `COUNT(*) FILTER (WHERE inventory_id = '${PARA}'::uuid)`,
      0,
      'no paracetamol line survives an amoxicillin recall'
    )
  );

  sections.push(
    h.expectRows('recall_lot_messy', 6, 'a lot number is matched ignoring case and padding')
  );
  sections.push(
    h.expectRows('recall_lot_and_product_name', 5, 'a name narrows exactly as an id does')
  );

  // Product-only: S1 contributes two ledger rows, one per lot it drew from.
  sections.push(
    h.expectRows('recall_by_product', 6, 'every sale of the product, whichever lot it took')
  );
  sections.push(
    h.expectNumber(
      'recall_by_product',
      `COUNT(*) FILTER (WHERE matched_batch_number = 'B/OTHER')`,
      1,
      'the second lot of a two-lot line is counted separately'
    )
  );
  sections.push(
    h.expectNumber('recall_by_product', `COUNT(DISTINCT sale_id)`, 5, 'a line spanning two lots is still one sale')
  );
  sections.push(
    h.expectNumber(
      'recall_by_product',
      `COUNT(*) FILTER (WHERE provenance = 'product_row')`,
      1,
      'the pre-tracking sale is reached by product as well as by lot'
    )
  );

  sections.push(
    h.expectRows('recall_by_product_name', 6, 'a product name alone finds the same sales')
  );

  // Nothing is counted twice: the ledger arm and the snapshot arm are exclusive,
  // because the snapshot arm only reads lines with no ledger row behind them.
  sections.push(
    h.expectNumber(
      'recall_by_lot',
      `COALESCE(SUM(quantity) FILTER (WHERE NOT voided), 0)`,
      17,
      'units dispensed add up across both sources without doubling'
    )
  );
  sections.push(
    h.expectNumber('recall_by_lot', `COUNT(*) FILTER (WHERE voided)`, 1, 'a returned sale is still listed')
  );
  sections.push(
    h.expectNumber(
      'recall_by_lot',
      `COALESCE(SUM(quantity) FILTER (WHERE voided), 0)`,
      2,
      'and its units are counted as returned, not dispensed'
    )
  );

  // Reachability: the number that decides whether phone calls close the recall,
  // or whether it needs a notice in the window and a call to the supplier.
  const contact = `NULLIF(TRIM(COALESCE(patient_phone, patient_alternate_phone, customer_phone)), '')`;
  sections.push(
    h.expectNumber(
      'recall_by_lot',
      `COUNT(*) FILTER (WHERE NOT voided AND ${contact} IS NOT NULL)`,
      4,
      'four sales can be phoned'
    )
  );
  sections.push(
    h.expectNumber(
      'recall_by_lot',
      `COUNT(*) FILTER (WHERE NOT voided AND ${contact} IS NULL)`,
      1,
      'and one walk-in cannot be, which the recall has to admit'
    )
  );
  sections.push(
    h.expectNumber(
      'recall_by_lot',
      `COUNT(DISTINCT ${contact}) FILTER (WHERE NOT voided)`,
      3,
      'one patient buying the lot twice is one call, not two'
    )
  );

  // The window runs from ten days ago to yesterday, so it excludes today. The
  // offline sale happened three days ago and synced today: read the time it
  // happened and it is the only row in range, read created_at and the view is
  // empty. That is the whole difference between the two, and it is the
  // difference between a recall that finds an outage's sales and one that does
  // not.
  sections.push(
    h.expectRows('recall_offline_window', 1, 'a window over the outage days finds the sale made during it')
  );
  sections.push(
    h.expectText(
      'recall_offline_window',
      `MAX(receipt_number)`,
      'R-REC-0002',
      'and the one it finds is the offline sale, dated by client_recorded_at'
    )
  );
  sections.push(
    h.expectNumber(
      'recall_offline_window',
      `COUNT(*) FILTER (WHERE recorded_offline)`,
      1,
      'the sale is flagged as having been recorded offline'
    )
  );

  // The route asks for limit + 1 and reports `truncated` when it gets it, so a
  // shortened list says so instead of looking complete.
  sections.push(h.expectRows('recall_truncated', 4, 'the limit is applied, so a cut list is detectable'));

  // The quarantine half of the answer: what to take off the shelf today.
  sections.push(h.expectRows('batches_by_lot', 2, 'two lots on the shelf carry that number'));
  sections.push(
    h.expectNumber('batches_by_lot', `COALESCE(SUM(quantity), 0)`, 20, 'and 20 units of it are still in the building')
  );
  sections.push(
    h.expectRows('batches_by_lot_and_product', 1, 'one medicine, one lot to quarantine')
  );
  sections.push(
    h.expectNumber('batches_by_lot_and_product', `MAX(quantity)`, 12, 'holding the 12 units of amoxicillin')
  );
  sections.push(
    h.expectText(
      'batches_by_lot_and_product',
      `MAX(supplier_name)`,
      'Recall Supplier',
      'with the supplier named, so somebody can be called about it'
    )
  );
  sections.push(
    h.expectText(
      'batches_by_lot_and_product',
      `MAX(invoice_number)`,
      'INV-A1',
      'and the invoice that proves where it came from'
    )
  );
  sections.push(h.expectRows('batches_by_product_name', 2, 'a product name lists every lot of it'));

  sections.push(`
ROLLBACK;

SELECT 'all recall assertions passed' AS result;
`);

  // split/join rather than a regex, so nothing here has to be escaped and a
  // sentinel that never appeared would be visible as an unchanged file.
  const rendered = sections.join('\n');
  const from = rendered.split(`'${WINDOW_FROM_SENTINEL}'::date`).join(WINDOW_FROM_SQL);
  const substituted = from.split(`'${WINDOW_TO_SENTINEL}'::date`).join(WINDOW_TO_SQL);

  if (substituted.includes(WINDOW_FROM_SENTINEL) || substituted.includes(WINDOW_TO_SENTINEL)) {
    throw new Error('a window sentinel survived substitution; the date window would test nothing');
  }
  return substituted;
}

export function writeRecallVerifySql(target: string = RECALL_VERIFY_PATH): string {
  const sql = renderRecallVerifySql();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, sql, 'utf8');
  return sql;
}
