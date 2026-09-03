-- =====================================================================
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

\set ON_ERROR_STOP on

BEGIN;

-- ---------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------
INSERT INTO pharmacies (id, name, license_number, phone)
VALUES ('11111111-1111-1111-1111-111111111111', 'Recall Test Pharmacy', 'LIC-VERIFY-004', '0240000004');

INSERT INTO users (id, pharmacy_id, role, first_name, last_name, email, password_hash)
VALUES ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'pharmacist', 'Ama', 'Osei',
        'ama.recall@test.gh', 'x');

INSERT INTO patients (id, pharmacy_id, first_name, last_name, phone, alternate_phone)
VALUES ('66666666-6666-6666-6666-666666666666', '11111111-1111-1111-1111-111111111111', 'Efua', 'Boateng', '0241111111', '0241111112');

INSERT INTO suppliers (id, pharmacy_id, name)
VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', '11111111-1111-1111-1111-111111111111', 'Recall Supplier');

INSERT INTO inventory (id, pharmacy_id, product_name, product_code, quantity,
                       unit_price, cost_price, expiry_date, reorder_level)
VALUES
  ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 'Amoxicillin 500mg', 'AMOX-500', 0, 12.00, 0,
   CURRENT_DATE + 365, 15),
  ('77777777-7777-7777-7777-777777777777', '11111111-1111-1111-1111-111111111111', 'Paracetamol 500mg', 'PARA-500', 0, 9.00, 0,
   CURRENT_DATE + 365, 20);

INSERT INTO inventory_batches (id, pharmacy_id, inventory_id, batch_number, expiry_date,
                               quantity, cost_price, supplier_id, invoice_number,
                               received_at)
VALUES
  ('b0000000-0000-0000-0000-0000000000a1', '11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', 'B/RECALL', CURRENT_DATE + 100,
   12, 4.00, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', 'INV-A1', CURRENT_DATE - 40),
  ('b0000000-0000-0000-0000-0000000000a2', '11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', 'B/OTHER', CURRENT_DATE + 200,
   5, 5.00, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', 'INV-A2', CURRENT_DATE - 10),
  ('b0000000-0000-0000-0000-0000000000b1', '11111111-1111-1111-1111-111111111111', '77777777-7777-7777-7777-777777777777', 'B/RECALL', CURRENT_DATE + 150,
   8, 2.00, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', 'INV-P1', CURRENT_DATE - 20);

-- Sales made since batch tracking: sale_item_batches names the lot each line
-- drew from. S1 spans two lots and carries the joined label the receipt prints,
-- which must not be mistaken for a lot number of its own. S5 is the exception,
-- inserted with the others but given no junction rows below.
INSERT INTO sales (id, pharmacy_id, receipt_number, served_by, total_amount, status,
                   patient_id, customer_name, customer_phone)
VALUES
  ('c0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'R-REC-0001', '22222222-2222-2222-2222-222222222222',
   60.00, 'completed', '66666666-6666-6666-6666-666666666666', NULL, NULL),
  ('c0000000-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', 'R-REC-0003', '22222222-2222-2222-2222-222222222222',
   12.00, 'completed', NULL, NULL, NULL),
  ('c0000000-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111111', 'R-REC-0004', '22222222-2222-2222-2222-222222222222',
   24.00, 'voided', '66666666-6666-6666-6666-666666666666', NULL, NULL),
  ('c0000000-0000-0000-0000-000000000005', '11111111-1111-1111-1111-111111111111', 'R-REC-0005', '22222222-2222-2222-2222-222222222222',
   72.00, 'completed', '66666666-6666-6666-6666-666666666666', NULL, NULL),
  ('c0000000-0000-0000-0000-000000000006', '11111111-1111-1111-1111-111111111111', 'R-REC-0006', '22222222-2222-2222-2222-222222222222',
   27.00, 'completed', NULL, 'Yaw Adjei', '0243333333');

-- S2 was rung up during an outage. client_recorded_at is three days ago and
-- created_at is today, so a window that used created_at would put this sale in
-- the wrong week and a recall bounded by "last month" would miss it.
INSERT INTO sales (id, pharmacy_id, receipt_number, served_by, total_amount, status,
                   patient_id, customer_name, customer_phone, recorded_offline,
                   client_recorded_at, created_at)
VALUES ('c0000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'R-REC-0002', '22222222-2222-2222-2222-222222222222',
        48.00, 'completed', NULL, 'Kofi Mensah', '0242222222', true,
        NOW() - INTERVAL '3 days', NOW());

UPDATE sales SET voided_at = NOW(), void_reason = 'Customer returned it'
 WHERE id = 'c0000000-0000-0000-0000-000000000004';

INSERT INTO sale_items (id, sale_id, inventory_id, product_name, product_code,
                        batch_number, expiry_date, quantity, sell_unit, unit_price,
                        line_total, unit_cost)
VALUES
  ('d0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001',
   '33333333-3333-3333-3333-333333333333', 'Amoxicillin 500mg', 'AMOX-500', 'B/RECALL+B/OTHER', CURRENT_DATE + 100,
   5, 'pack', 12.00, 60.00, 4.40),
  ('d0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000002',
   '33333333-3333-3333-3333-333333333333', 'Amoxicillin 500mg', 'AMOX-500', 'B/RECALL', CURRENT_DATE + 100,
   4, 'pack', 12.00, 48.00, 4.00),
  ('d0000000-0000-0000-0000-000000000003', 'c0000000-0000-0000-0000-000000000003',
   '33333333-3333-3333-3333-333333333333', 'Amoxicillin 500mg', 'AMOX-500', 'B/RECALL', CURRENT_DATE + 100,
   1, 'pack', 12.00, 12.00, 4.00),
  ('d0000000-0000-0000-0000-000000000004', 'c0000000-0000-0000-0000-000000000004',
   '33333333-3333-3333-3333-333333333333', 'Amoxicillin 500mg', 'AMOX-500', 'B/RECALL', CURRENT_DATE + 100,
   2, 'pack', 12.00, 24.00, 4.00),
  -- No junction rows: a sale from before batch tracking existed. The line's own
  -- snapshot of the product's lot is the only handle there is, and it is the
  -- oldest stock in the building — the stock a recall is most likely to be about.
  ('d0000000-0000-0000-0000-000000000005', 'c0000000-0000-0000-0000-000000000005',
   '33333333-3333-3333-3333-333333333333', 'Amoxicillin 500mg', 'AMOX-500', 'B/RECALL', CURRENT_DATE + 100,
   6, 'pack', 12.00, 72.00, 4.00),
  ('d0000000-0000-0000-0000-000000000006', 'c0000000-0000-0000-0000-000000000006',
   '77777777-7777-7777-7777-777777777777', 'Paracetamol 500mg', 'PARA-500', 'B/RECALL', CURRENT_DATE + 150,
   3, 'pack', 9.00, 27.00, 2.00);

INSERT INTO sale_item_batches (sale_item_id, pharmacy_id, batch_id, batch_number,
                               expiry_date, inventory_id, quantity, unit_cost)
VALUES
  ('d0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'b0000000-0000-0000-0000-0000000000a1',
   'B/RECALL', CURRENT_DATE + 100, '33333333-3333-3333-3333-333333333333', 3, 4.00),
  ('d0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'b0000000-0000-0000-0000-0000000000a2',
   'B/OTHER', CURRENT_DATE + 200, '33333333-3333-3333-3333-333333333333', 2, 5.00),
  ('d0000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'b0000000-0000-0000-0000-0000000000a1',
   'B/RECALL', CURRENT_DATE + 100, '33333333-3333-3333-3333-333333333333', 4, 4.00),
  ('d0000000-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', 'b0000000-0000-0000-0000-0000000000a1',
   'B/RECALL', CURRENT_DATE + 100, '33333333-3333-3333-3333-333333333333', 1, 4.00),
  ('d0000000-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111111', 'b0000000-0000-0000-0000-0000000000a1',
   'B/RECALL', CURRENT_DATE + 100, '33333333-3333-3333-3333-333333333333', 2, 4.00),
  ('d0000000-0000-0000-0000-000000000006', '11111111-1111-1111-1111-111111111111', 'b0000000-0000-0000-0000-0000000000b1',
   'B/RECALL', CURRENT_DATE + 150, '77777777-7777-7777-7777-777777777777', 3, 2.00);


-- ---------------------------------------------------------------------
-- The views under test
-- ---------------------------------------------------------------------
-- Each is one call to the builder, so what runs here and what the route sends
-- are the same text.


-- The lot on its own: both medicines that carry it, both sources of truth.
CREATE TEMP VIEW recall_by_lot AS

      WITH candidates AS (
        SELECT b.id, b.inventory_id
          FROM inventory_batches b
          JOIN inventory i ON i.id = b.inventory_id
         WHERE b.pharmacy_id = '11111111-1111-1111-1111-111111111111'::uuid
           AND ('B/RECALL'::text::text IS NULL OR UPPER(TRIM(b.batch_number)) = UPPER(TRIM('B/RECALL'::text::text)))
           AND (NULL::uuid IS NULL OR b.inventory_id = NULL::uuid)
           AND (NULL::text IS NULL OR i.product_name ILIKE '%' || NULL::text || '%')
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
         WHERE sib.pharmacy_id = '11111111-1111-1111-1111-111111111111'::uuid
           AND (
                 sib.batch_id IN (SELECT id FROM candidates)
                 -- The junction keeps its own snapshot of the lot, so a batch
                 -- row that has since gone still traces. Narrowed to the same
                 -- product as the rest of the search, or a lot number reused
                 -- across two medicines would widen the recall beyond what was
                 -- asked for.
              OR (
                   UPPER(TRIM(sib.batch_number)) = UPPER(TRIM('B/RECALL'::text::text))
                   AND (NULL::uuid IS NULL OR sib.inventory_id = NULL::uuid)
                   AND (NULL::text IS NULL
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
          JOIN sales s2 ON s2.id = si.sale_id AND s2.pharmacy_id = '11111111-1111-1111-1111-111111111111'::uuid
         WHERE NOT EXISTS (
                 SELECT 1 FROM sale_item_batches sib WHERE sib.sale_item_id = si.id
               )
           AND (NULL::uuid IS NULL OR si.inventory_id = NULL::uuid)
           AND (NULL::text IS NULL OR si.product_name ILIKE '%' || NULL::text || '%')
           AND (
                 ('B/RECALL'::text::text IS NOT NULL
                  AND UPPER(TRIM(si.batch_number)) = UPPER(TRIM('B/RECALL'::text::text)))
                 -- With no lot named there is nothing to match a snapshot
                 -- against, so the product is the handle.
              OR ('B/RECALL'::text::text IS NULL AND (NULL::uuid IS NOT NULL OR NULL::text IS NOT NULL))
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
             COALESCE(s.client_recorded_at, s.created_at) AS sold_at,
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
       WHERE s.pharmacy_id = '11111111-1111-1111-1111-111111111111'::uuid
         AND (NULL::date IS NULL OR (COALESCE(s.client_recorded_at, s.created_at))::date >= NULL::date)
         AND (NULL::date IS NULL OR (COALESCE(s.client_recorded_at, s.created_at))::date <= NULL::date)
       ORDER BY COALESCE(s.client_recorded_at, s.created_at) DESC, s.receipt_number ASC
       LIMIT 501;


-- The lot narrowed to one medicine. Lot numbers repeat across products, so
-- this is the difference between a recall and a panic.
CREATE TEMP VIEW recall_by_lot_and_product AS

      WITH candidates AS (
        SELECT b.id, b.inventory_id
          FROM inventory_batches b
          JOIN inventory i ON i.id = b.inventory_id
         WHERE b.pharmacy_id = '11111111-1111-1111-1111-111111111111'::uuid
           AND ('B/RECALL'::text::text IS NULL OR UPPER(TRIM(b.batch_number)) = UPPER(TRIM('B/RECALL'::text::text)))
           AND ('33333333-3333-3333-3333-333333333333'::uuid::uuid IS NULL OR b.inventory_id = '33333333-3333-3333-3333-333333333333'::uuid::uuid)
           AND (NULL::text IS NULL OR i.product_name ILIKE '%' || NULL::text || '%')
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
         WHERE sib.pharmacy_id = '11111111-1111-1111-1111-111111111111'::uuid
           AND (
                 sib.batch_id IN (SELECT id FROM candidates)
                 -- The junction keeps its own snapshot of the lot, so a batch
                 -- row that has since gone still traces. Narrowed to the same
                 -- product as the rest of the search, or a lot number reused
                 -- across two medicines would widen the recall beyond what was
                 -- asked for.
              OR (
                   UPPER(TRIM(sib.batch_number)) = UPPER(TRIM('B/RECALL'::text::text))
                   AND ('33333333-3333-3333-3333-333333333333'::uuid::uuid IS NULL OR sib.inventory_id = '33333333-3333-3333-3333-333333333333'::uuid::uuid)
                   AND (NULL::text IS NULL
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
          JOIN sales s2 ON s2.id = si.sale_id AND s2.pharmacy_id = '11111111-1111-1111-1111-111111111111'::uuid
         WHERE NOT EXISTS (
                 SELECT 1 FROM sale_item_batches sib WHERE sib.sale_item_id = si.id
               )
           AND ('33333333-3333-3333-3333-333333333333'::uuid::uuid IS NULL OR si.inventory_id = '33333333-3333-3333-3333-333333333333'::uuid::uuid)
           AND (NULL::text IS NULL OR si.product_name ILIKE '%' || NULL::text || '%')
           AND (
                 ('B/RECALL'::text::text IS NOT NULL
                  AND UPPER(TRIM(si.batch_number)) = UPPER(TRIM('B/RECALL'::text::text)))
                 -- With no lot named there is nothing to match a snapshot
                 -- against, so the product is the handle.
              OR ('B/RECALL'::text::text IS NULL AND ('33333333-3333-3333-3333-333333333333'::uuid::uuid IS NOT NULL OR NULL::text IS NOT NULL))
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
             COALESCE(s.client_recorded_at, s.created_at) AS sold_at,
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
       WHERE s.pharmacy_id = '11111111-1111-1111-1111-111111111111'::uuid
         AND (NULL::date IS NULL OR (COALESCE(s.client_recorded_at, s.created_at))::date >= NULL::date)
         AND (NULL::date IS NULL OR (COALESCE(s.client_recorded_at, s.created_at))::date <= NULL::date)
       ORDER BY COALESCE(s.client_recorded_at, s.created_at) DESC, s.receipt_number ASC
       LIMIT 501;


-- The same lot as read off a fax: lower case and padded with spaces.
CREATE TEMP VIEW recall_lot_messy AS

      WITH candidates AS (
        SELECT b.id, b.inventory_id
          FROM inventory_batches b
          JOIN inventory i ON i.id = b.inventory_id
         WHERE b.pharmacy_id = '11111111-1111-1111-1111-111111111111'::uuid
           AND ('b/recall'::text::text IS NULL OR UPPER(TRIM(b.batch_number)) = UPPER(TRIM('b/recall'::text::text)))
           AND (NULL::uuid IS NULL OR b.inventory_id = NULL::uuid)
           AND (NULL::text IS NULL OR i.product_name ILIKE '%' || NULL::text || '%')
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
         WHERE sib.pharmacy_id = '11111111-1111-1111-1111-111111111111'::uuid
           AND (
                 sib.batch_id IN (SELECT id FROM candidates)
                 -- The junction keeps its own snapshot of the lot, so a batch
                 -- row that has since gone still traces. Narrowed to the same
                 -- product as the rest of the search, or a lot number reused
                 -- across two medicines would widen the recall beyond what was
                 -- asked for.
              OR (
                   UPPER(TRIM(sib.batch_number)) = UPPER(TRIM('b/recall'::text::text))
                   AND (NULL::uuid IS NULL OR sib.inventory_id = NULL::uuid)
                   AND (NULL::text IS NULL
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
          JOIN sales s2 ON s2.id = si.sale_id AND s2.pharmacy_id = '11111111-1111-1111-1111-111111111111'::uuid
         WHERE NOT EXISTS (
                 SELECT 1 FROM sale_item_batches sib WHERE sib.sale_item_id = si.id
               )
           AND (NULL::uuid IS NULL OR si.inventory_id = NULL::uuid)
           AND (NULL::text IS NULL OR si.product_name ILIKE '%' || NULL::text || '%')
           AND (
                 ('b/recall'::text::text IS NOT NULL
                  AND UPPER(TRIM(si.batch_number)) = UPPER(TRIM('b/recall'::text::text)))
                 -- With no lot named there is nothing to match a snapshot
                 -- against, so the product is the handle.
              OR ('b/recall'::text::text IS NULL AND (NULL::uuid IS NOT NULL OR NULL::text IS NOT NULL))
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
             COALESCE(s.client_recorded_at, s.created_at) AS sold_at,
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
       WHERE s.pharmacy_id = '11111111-1111-1111-1111-111111111111'::uuid
         AND (NULL::date IS NULL OR (COALESCE(s.client_recorded_at, s.created_at))::date >= NULL::date)
         AND (NULL::date IS NULL OR (COALESCE(s.client_recorded_at, s.created_at))::date <= NULL::date)
       ORDER BY COALESCE(s.client_recorded_at, s.created_at) DESC, s.receipt_number ASC
       LIMIT 501;


-- No lot named at all — every sale of the product, from either source.
CREATE TEMP VIEW recall_by_product AS

      WITH candidates AS (
        SELECT b.id, b.inventory_id
          FROM inventory_batches b
          JOIN inventory i ON i.id = b.inventory_id
         WHERE b.pharmacy_id = '11111111-1111-1111-1111-111111111111'::uuid
           AND (NULL::text IS NULL OR UPPER(TRIM(b.batch_number)) = UPPER(TRIM(NULL::text)))
           AND ('33333333-3333-3333-3333-333333333333'::uuid::uuid IS NULL OR b.inventory_id = '33333333-3333-3333-3333-333333333333'::uuid::uuid)
           AND (NULL::text IS NULL OR i.product_name ILIKE '%' || NULL::text || '%')
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
         WHERE sib.pharmacy_id = '11111111-1111-1111-1111-111111111111'::uuid
           AND (
                 sib.batch_id IN (SELECT id FROM candidates)
                 -- The junction keeps its own snapshot of the lot, so a batch
                 -- row that has since gone still traces. Narrowed to the same
                 -- product as the rest of the search, or a lot number reused
                 -- across two medicines would widen the recall beyond what was
                 -- asked for.
              OR (
                   UPPER(TRIM(sib.batch_number)) = UPPER(TRIM(NULL::text))
                   AND ('33333333-3333-3333-3333-333333333333'::uuid::uuid IS NULL OR sib.inventory_id = '33333333-3333-3333-3333-333333333333'::uuid::uuid)
                   AND (NULL::text IS NULL
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
          JOIN sales s2 ON s2.id = si.sale_id AND s2.pharmacy_id = '11111111-1111-1111-1111-111111111111'::uuid
         WHERE NOT EXISTS (
                 SELECT 1 FROM sale_item_batches sib WHERE sib.sale_item_id = si.id
               )
           AND ('33333333-3333-3333-3333-333333333333'::uuid::uuid IS NULL OR si.inventory_id = '33333333-3333-3333-3333-333333333333'::uuid::uuid)
           AND (NULL::text IS NULL OR si.product_name ILIKE '%' || NULL::text || '%')
           AND (
                 (NULL::text IS NOT NULL
                  AND UPPER(TRIM(si.batch_number)) = UPPER(TRIM(NULL::text)))
                 -- With no lot named there is nothing to match a snapshot
                 -- against, so the product is the handle.
              OR (NULL::text IS NULL AND ('33333333-3333-3333-3333-333333333333'::uuid::uuid IS NOT NULL OR NULL::text IS NOT NULL))
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
             COALESCE(s.client_recorded_at, s.created_at) AS sold_at,
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
       WHERE s.pharmacy_id = '11111111-1111-1111-1111-111111111111'::uuid
         AND (NULL::date IS NULL OR (COALESCE(s.client_recorded_at, s.created_at))::date >= NULL::date)
         AND (NULL::date IS NULL OR (COALESCE(s.client_recorded_at, s.created_at))::date <= NULL::date)
       ORDER BY COALESCE(s.client_recorded_at, s.created_at) DESC, s.receipt_number ASC
       LIMIT 501;


-- A product name before it has been matched to an inventory row.
CREATE TEMP VIEW recall_by_product_name AS

      WITH candidates AS (
        SELECT b.id, b.inventory_id
          FROM inventory_batches b
          JOIN inventory i ON i.id = b.inventory_id
         WHERE b.pharmacy_id = '11111111-1111-1111-1111-111111111111'::uuid
           AND (NULL::text IS NULL OR UPPER(TRIM(b.batch_number)) = UPPER(TRIM(NULL::text)))
           AND (NULL::uuid IS NULL OR b.inventory_id = NULL::uuid)
           AND ('amox'::text::text IS NULL OR i.product_name ILIKE '%' || 'amox'::text::text || '%')
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
         WHERE sib.pharmacy_id = '11111111-1111-1111-1111-111111111111'::uuid
           AND (
                 sib.batch_id IN (SELECT id FROM candidates)
                 -- The junction keeps its own snapshot of the lot, so a batch
                 -- row that has since gone still traces. Narrowed to the same
                 -- product as the rest of the search, or a lot number reused
                 -- across two medicines would widen the recall beyond what was
                 -- asked for.
              OR (
                   UPPER(TRIM(sib.batch_number)) = UPPER(TRIM(NULL::text))
                   AND (NULL::uuid IS NULL OR sib.inventory_id = NULL::uuid)
                   AND ('amox'::text::text IS NULL
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
          JOIN sales s2 ON s2.id = si.sale_id AND s2.pharmacy_id = '11111111-1111-1111-1111-111111111111'::uuid
         WHERE NOT EXISTS (
                 SELECT 1 FROM sale_item_batches sib WHERE sib.sale_item_id = si.id
               )
           AND (NULL::uuid IS NULL OR si.inventory_id = NULL::uuid)
           AND ('amox'::text::text IS NULL OR si.product_name ILIKE '%' || 'amox'::text::text || '%')
           AND (
                 (NULL::text IS NOT NULL
                  AND UPPER(TRIM(si.batch_number)) = UPPER(TRIM(NULL::text)))
                 -- With no lot named there is nothing to match a snapshot
                 -- against, so the product is the handle.
              OR (NULL::text IS NULL AND (NULL::uuid IS NOT NULL OR 'amox'::text::text IS NOT NULL))
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
             COALESCE(s.client_recorded_at, s.created_at) AS sold_at,
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
       WHERE s.pharmacy_id = '11111111-1111-1111-1111-111111111111'::uuid
         AND (NULL::date IS NULL OR (COALESCE(s.client_recorded_at, s.created_at))::date >= NULL::date)
         AND (NULL::date IS NULL OR (COALESCE(s.client_recorded_at, s.created_at))::date <= NULL::date)
       ORDER BY COALESCE(s.client_recorded_at, s.created_at) DESC, s.receipt_number ASC
       LIMIT 501;


-- Both, which is how a recall notice usually arrives.
CREATE TEMP VIEW recall_lot_and_product_name AS

      WITH candidates AS (
        SELECT b.id, b.inventory_id
          FROM inventory_batches b
          JOIN inventory i ON i.id = b.inventory_id
         WHERE b.pharmacy_id = '11111111-1111-1111-1111-111111111111'::uuid
           AND ('B/RECALL'::text::text IS NULL OR UPPER(TRIM(b.batch_number)) = UPPER(TRIM('B/RECALL'::text::text)))
           AND (NULL::uuid IS NULL OR b.inventory_id = NULL::uuid)
           AND ('amox'::text::text IS NULL OR i.product_name ILIKE '%' || 'amox'::text::text || '%')
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
         WHERE sib.pharmacy_id = '11111111-1111-1111-1111-111111111111'::uuid
           AND (
                 sib.batch_id IN (SELECT id FROM candidates)
                 -- The junction keeps its own snapshot of the lot, so a batch
                 -- row that has since gone still traces. Narrowed to the same
                 -- product as the rest of the search, or a lot number reused
                 -- across two medicines would widen the recall beyond what was
                 -- asked for.
              OR (
                   UPPER(TRIM(sib.batch_number)) = UPPER(TRIM('B/RECALL'::text::text))
                   AND (NULL::uuid IS NULL OR sib.inventory_id = NULL::uuid)
                   AND ('amox'::text::text IS NULL
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
          JOIN sales s2 ON s2.id = si.sale_id AND s2.pharmacy_id = '11111111-1111-1111-1111-111111111111'::uuid
         WHERE NOT EXISTS (
                 SELECT 1 FROM sale_item_batches sib WHERE sib.sale_item_id = si.id
               )
           AND (NULL::uuid IS NULL OR si.inventory_id = NULL::uuid)
           AND ('amox'::text::text IS NULL OR si.product_name ILIKE '%' || 'amox'::text::text || '%')
           AND (
                 ('B/RECALL'::text::text IS NOT NULL
                  AND UPPER(TRIM(si.batch_number)) = UPPER(TRIM('B/RECALL'::text::text)))
                 -- With no lot named there is nothing to match a snapshot
                 -- against, so the product is the handle.
              OR ('B/RECALL'::text::text IS NULL AND (NULL::uuid IS NOT NULL OR 'amox'::text::text IS NOT NULL))
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
             COALESCE(s.client_recorded_at, s.created_at) AS sold_at,
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
       WHERE s.pharmacy_id = '11111111-1111-1111-1111-111111111111'::uuid
         AND (NULL::date IS NULL OR (COALESCE(s.client_recorded_at, s.created_at))::date >= NULL::date)
         AND (NULL::date IS NULL OR (COALESCE(s.client_recorded_at, s.created_at))::date <= NULL::date)
       ORDER BY COALESCE(s.client_recorded_at, s.created_at) DESC, s.receipt_number ASC
       LIMIT 501;


-- The ten days before today, which excludes today. Only the outage sale
-- falls inside it, and only when the window reads client_recorded_at.
CREATE TEMP VIEW recall_offline_window AS

      WITH candidates AS (
        SELECT b.id, b.inventory_id
          FROM inventory_batches b
          JOIN inventory i ON i.id = b.inventory_id
         WHERE b.pharmacy_id = '11111111-1111-1111-1111-111111111111'::uuid
           AND ('B/RECALL'::text::text IS NULL OR UPPER(TRIM(b.batch_number)) = UPPER(TRIM('B/RECALL'::text::text)))
           AND (NULL::uuid IS NULL OR b.inventory_id = NULL::uuid)
           AND (NULL::text IS NULL OR i.product_name ILIKE '%' || NULL::text || '%')
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
         WHERE sib.pharmacy_id = '11111111-1111-1111-1111-111111111111'::uuid
           AND (
                 sib.batch_id IN (SELECT id FROM candidates)
                 -- The junction keeps its own snapshot of the lot, so a batch
                 -- row that has since gone still traces. Narrowed to the same
                 -- product as the rest of the search, or a lot number reused
                 -- across two medicines would widen the recall beyond what was
                 -- asked for.
              OR (
                   UPPER(TRIM(sib.batch_number)) = UPPER(TRIM('B/RECALL'::text::text))
                   AND (NULL::uuid IS NULL OR sib.inventory_id = NULL::uuid)
                   AND (NULL::text IS NULL
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
          JOIN sales s2 ON s2.id = si.sale_id AND s2.pharmacy_id = '11111111-1111-1111-1111-111111111111'::uuid
         WHERE NOT EXISTS (
                 SELECT 1 FROM sale_item_batches sib WHERE sib.sale_item_id = si.id
               )
           AND (NULL::uuid IS NULL OR si.inventory_id = NULL::uuid)
           AND (NULL::text IS NULL OR si.product_name ILIKE '%' || NULL::text || '%')
           AND (
                 ('B/RECALL'::text::text IS NOT NULL
                  AND UPPER(TRIM(si.batch_number)) = UPPER(TRIM('B/RECALL'::text::text)))
                 -- With no lot named there is nothing to match a snapshot
                 -- against, so the product is the handle.
              OR ('B/RECALL'::text::text IS NULL AND (NULL::uuid IS NOT NULL OR NULL::text IS NOT NULL))
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
             COALESCE(s.client_recorded_at, s.created_at) AS sold_at,
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
       WHERE s.pharmacy_id = '11111111-1111-1111-1111-111111111111'::uuid
         AND ((CURRENT_DATE - 10)::date IS NULL OR (COALESCE(s.client_recorded_at, s.created_at))::date >= (CURRENT_DATE - 10)::date)
         AND ((CURRENT_DATE - 1)::date IS NULL OR (COALESCE(s.client_recorded_at, s.created_at))::date <= (CURRENT_DATE - 1)::date)
       ORDER BY COALESCE(s.client_recorded_at, s.created_at) DESC, s.receipt_number ASC
       LIMIT 501;


-- One more than the caller asked for, so a full
-- list is distinguishable from a shortened one.
CREATE TEMP VIEW recall_truncated AS

      WITH candidates AS (
        SELECT b.id, b.inventory_id
          FROM inventory_batches b
          JOIN inventory i ON i.id = b.inventory_id
         WHERE b.pharmacy_id = '11111111-1111-1111-1111-111111111111'::uuid
           AND ('B/RECALL'::text::text IS NULL OR UPPER(TRIM(b.batch_number)) = UPPER(TRIM('B/RECALL'::text::text)))
           AND (NULL::uuid IS NULL OR b.inventory_id = NULL::uuid)
           AND (NULL::text IS NULL OR i.product_name ILIKE '%' || NULL::text || '%')
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
         WHERE sib.pharmacy_id = '11111111-1111-1111-1111-111111111111'::uuid
           AND (
                 sib.batch_id IN (SELECT id FROM candidates)
                 -- The junction keeps its own snapshot of the lot, so a batch
                 -- row that has since gone still traces. Narrowed to the same
                 -- product as the rest of the search, or a lot number reused
                 -- across two medicines would widen the recall beyond what was
                 -- asked for.
              OR (
                   UPPER(TRIM(sib.batch_number)) = UPPER(TRIM('B/RECALL'::text::text))
                   AND (NULL::uuid IS NULL OR sib.inventory_id = NULL::uuid)
                   AND (NULL::text IS NULL
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
          JOIN sales s2 ON s2.id = si.sale_id AND s2.pharmacy_id = '11111111-1111-1111-1111-111111111111'::uuid
         WHERE NOT EXISTS (
                 SELECT 1 FROM sale_item_batches sib WHERE sib.sale_item_id = si.id
               )
           AND (NULL::uuid IS NULL OR si.inventory_id = NULL::uuid)
           AND (NULL::text IS NULL OR si.product_name ILIKE '%' || NULL::text || '%')
           AND (
                 ('B/RECALL'::text::text IS NOT NULL
                  AND UPPER(TRIM(si.batch_number)) = UPPER(TRIM('B/RECALL'::text::text)))
                 -- With no lot named there is nothing to match a snapshot
                 -- against, so the product is the handle.
              OR ('B/RECALL'::text::text IS NULL AND (NULL::uuid IS NOT NULL OR NULL::text IS NOT NULL))
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
             COALESCE(s.client_recorded_at, s.created_at) AS sold_at,
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
       WHERE s.pharmacy_id = '11111111-1111-1111-1111-111111111111'::uuid
         AND (NULL::date IS NULL OR (COALESCE(s.client_recorded_at, s.created_at))::date >= NULL::date)
         AND (NULL::date IS NULL OR (COALESCE(s.client_recorded_at, s.created_at))::date <= NULL::date)
       ORDER BY COALESCE(s.client_recorded_at, s.created_at) DESC, s.receipt_number ASC
       LIMIT 4;


-- What is still on the shelf for that lot — the quarantine half of the answer.
CREATE TEMP VIEW batches_by_lot AS

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
       WHERE b.pharmacy_id = '11111111-1111-1111-1111-111111111111'::uuid
         AND ('B/RECALL'::text::text IS NULL OR UPPER(TRIM(b.batch_number)) = UPPER(TRIM('B/RECALL'::text::text)))
         AND (NULL::uuid IS NULL OR b.inventory_id = NULL::uuid)
         AND (NULL::text IS NULL OR i.product_name ILIKE '%' || NULL::text || '%')
       ORDER BY i.product_name, b.expiry_date ASC, b.received_at ASC;


-- Narrowed to the medicine the recall names.
CREATE TEMP VIEW batches_by_lot_and_product AS

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
       WHERE b.pharmacy_id = '11111111-1111-1111-1111-111111111111'::uuid
         AND ('B/RECALL'::text::text IS NULL OR UPPER(TRIM(b.batch_number)) = UPPER(TRIM('B/RECALL'::text::text)))
         AND ('33333333-3333-3333-3333-333333333333'::uuid::uuid IS NULL OR b.inventory_id = '33333333-3333-3333-3333-333333333333'::uuid::uuid)
         AND (NULL::text IS NULL OR i.product_name ILIKE '%' || NULL::text || '%')
       ORDER BY i.product_name, b.expiry_date ASC, b.received_at ASC;


-- Every lot of a product, when the recall has not named one.
CREATE TEMP VIEW batches_by_product_name AS

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
       WHERE b.pharmacy_id = '11111111-1111-1111-1111-111111111111'::uuid
         AND (NULL::text IS NULL OR UPPER(TRIM(b.batch_number)) = UPPER(TRIM(NULL::text)))
         AND (NULL::uuid IS NULL OR b.inventory_id = NULL::uuid)
         AND ('amox'::text::text IS NULL OR i.product_name ILIKE '%' || 'amox'::text::text || '%')
       ORDER BY i.product_name, b.expiry_date ASC, b.received_at ASC;


-- ---------------------------------------------------------------------
-- Assertions
-- ---------------------------------------------------------------------

DO $$
DECLARE n INTEGER;
BEGIN
  SELECT COUNT(*)::int INTO n FROM recall_by_lot;
  IF n <> 6 THEN
    RAISE EXCEPTION 'recall_by_lot: the lot on its own reaches every sale of it — expected 6 row(s), got %', n;
  END IF;
  RAISE NOTICE 'PASS 1: the lot on its own reaches every sale of it (%)', n;
END $$;


DO $$
DECLARE v NUMERIC;
BEGIN
  SELECT (COUNT(*) FILTER (WHERE provenance = 'batch_ledger'))::numeric INTO v FROM recall_by_lot;
  IF v IS DISTINCT FROM 5 THEN
    RAISE EXCEPTION 'recall_by_lot: five lines are traced to a batch — expected 5, got %',
      COALESCE(v::text, 'NULL');
  END IF;
  RAISE NOTICE 'PASS 2: five lines are traced to a batch (%)', v;
END $$;


DO $$
DECLARE v NUMERIC;
BEGIN
  SELECT (COUNT(*) FILTER (WHERE provenance = 'product_row'))::numeric INTO v FROM recall_by_lot;
  IF v IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'recall_by_lot: the pre-tracking sale is found rather than dropped — expected 1, got %',
      COALESCE(v::text, 'NULL');
  END IF;
  RAISE NOTICE 'PASS 3: the pre-tracking sale is found rather than dropped (%)', v;
END $$;


DO $$
DECLARE n INTEGER;
BEGIN
  SELECT COUNT(*)::int INTO n FROM recall_by_lot_and_product;
  IF n <> 5 THEN
    RAISE EXCEPTION 'recall_by_lot_and_product: narrowing to the medicine drops the other one — expected 5 row(s), got %', n;
  END IF;
  RAISE NOTICE 'PASS 4: narrowing to the medicine drops the other one (%)', n;
END $$;


DO $$
DECLARE v NUMERIC;
BEGIN
  SELECT (COUNT(*) FILTER (WHERE inventory_id = '77777777-7777-7777-7777-777777777777'::uuid))::numeric INTO v FROM recall_by_lot_and_product;
  IF v IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'recall_by_lot_and_product: no paracetamol line survives an amoxicillin recall — expected 0, got %',
      COALESCE(v::text, 'NULL');
  END IF;
  RAISE NOTICE 'PASS 5: no paracetamol line survives an amoxicillin recall (%)', v;
END $$;


DO $$
DECLARE n INTEGER;
BEGIN
  SELECT COUNT(*)::int INTO n FROM recall_lot_messy;
  IF n <> 6 THEN
    RAISE EXCEPTION 'recall_lot_messy: a lot number is matched ignoring case and padding — expected 6 row(s), got %', n;
  END IF;
  RAISE NOTICE 'PASS 6: a lot number is matched ignoring case and padding (%)', n;
END $$;


DO $$
DECLARE n INTEGER;
BEGIN
  SELECT COUNT(*)::int INTO n FROM recall_lot_and_product_name;
  IF n <> 5 THEN
    RAISE EXCEPTION 'recall_lot_and_product_name: a name narrows exactly as an id does — expected 5 row(s), got %', n;
  END IF;
  RAISE NOTICE 'PASS 7: a name narrows exactly as an id does (%)', n;
END $$;


DO $$
DECLARE n INTEGER;
BEGIN
  SELECT COUNT(*)::int INTO n FROM recall_by_product;
  IF n <> 6 THEN
    RAISE EXCEPTION 'recall_by_product: every sale of the product, whichever lot it took — expected 6 row(s), got %', n;
  END IF;
  RAISE NOTICE 'PASS 8: every sale of the product, whichever lot it took (%)', n;
END $$;


DO $$
DECLARE v NUMERIC;
BEGIN
  SELECT (COUNT(*) FILTER (WHERE matched_batch_number = 'B/OTHER'))::numeric INTO v FROM recall_by_product;
  IF v IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'recall_by_product: the second lot of a two-lot line is counted separately — expected 1, got %',
      COALESCE(v::text, 'NULL');
  END IF;
  RAISE NOTICE 'PASS 9: the second lot of a two-lot line is counted separately (%)', v;
END $$;


DO $$
DECLARE v NUMERIC;
BEGIN
  SELECT (COUNT(DISTINCT sale_id))::numeric INTO v FROM recall_by_product;
  IF v IS DISTINCT FROM 5 THEN
    RAISE EXCEPTION 'recall_by_product: a line spanning two lots is still one sale — expected 5, got %',
      COALESCE(v::text, 'NULL');
  END IF;
  RAISE NOTICE 'PASS 10: a line spanning two lots is still one sale (%)', v;
END $$;


DO $$
DECLARE v NUMERIC;
BEGIN
  SELECT (COUNT(*) FILTER (WHERE provenance = 'product_row'))::numeric INTO v FROM recall_by_product;
  IF v IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'recall_by_product: the pre-tracking sale is reached by product as well as by lot — expected 1, got %',
      COALESCE(v::text, 'NULL');
  END IF;
  RAISE NOTICE 'PASS 11: the pre-tracking sale is reached by product as well as by lot (%)', v;
END $$;


DO $$
DECLARE n INTEGER;
BEGIN
  SELECT COUNT(*)::int INTO n FROM recall_by_product_name;
  IF n <> 6 THEN
    RAISE EXCEPTION 'recall_by_product_name: a product name alone finds the same sales — expected 6 row(s), got %', n;
  END IF;
  RAISE NOTICE 'PASS 12: a product name alone finds the same sales (%)', n;
END $$;


DO $$
DECLARE v NUMERIC;
BEGIN
  SELECT (COALESCE(SUM(quantity) FILTER (WHERE NOT voided), 0))::numeric INTO v FROM recall_by_lot;
  IF v IS DISTINCT FROM 17 THEN
    RAISE EXCEPTION 'recall_by_lot: units dispensed add up across both sources without doubling — expected 17, got %',
      COALESCE(v::text, 'NULL');
  END IF;
  RAISE NOTICE 'PASS 13: units dispensed add up across both sources without doubling (%)', v;
END $$;


DO $$
DECLARE v NUMERIC;
BEGIN
  SELECT (COUNT(*) FILTER (WHERE voided))::numeric INTO v FROM recall_by_lot;
  IF v IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'recall_by_lot: a returned sale is still listed — expected 1, got %',
      COALESCE(v::text, 'NULL');
  END IF;
  RAISE NOTICE 'PASS 14: a returned sale is still listed (%)', v;
END $$;


DO $$
DECLARE v NUMERIC;
BEGIN
  SELECT (COALESCE(SUM(quantity) FILTER (WHERE voided), 0))::numeric INTO v FROM recall_by_lot;
  IF v IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'recall_by_lot: and its units are counted as returned, not dispensed — expected 2, got %',
      COALESCE(v::text, 'NULL');
  END IF;
  RAISE NOTICE 'PASS 15: and its units are counted as returned, not dispensed (%)', v;
END $$;


DO $$
DECLARE v NUMERIC;
BEGIN
  SELECT (COUNT(*) FILTER (WHERE NOT voided AND NULLIF(TRIM(COALESCE(patient_phone, patient_alternate_phone, customer_phone)), '') IS NOT NULL))::numeric INTO v FROM recall_by_lot;
  IF v IS DISTINCT FROM 4 THEN
    RAISE EXCEPTION 'recall_by_lot: four sales can be phoned — expected 4, got %',
      COALESCE(v::text, 'NULL');
  END IF;
  RAISE NOTICE 'PASS 16: four sales can be phoned (%)', v;
END $$;


DO $$
DECLARE v NUMERIC;
BEGIN
  SELECT (COUNT(*) FILTER (WHERE NOT voided AND NULLIF(TRIM(COALESCE(patient_phone, patient_alternate_phone, customer_phone)), '') IS NULL))::numeric INTO v FROM recall_by_lot;
  IF v IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'recall_by_lot: and one walk-in cannot be, which the recall has to admit — expected 1, got %',
      COALESCE(v::text, 'NULL');
  END IF;
  RAISE NOTICE 'PASS 17: and one walk-in cannot be, which the recall has to admit (%)', v;
END $$;


DO $$
DECLARE v NUMERIC;
BEGIN
  SELECT (COUNT(DISTINCT NULLIF(TRIM(COALESCE(patient_phone, patient_alternate_phone, customer_phone)), '')) FILTER (WHERE NOT voided))::numeric INTO v FROM recall_by_lot;
  IF v IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'recall_by_lot: one patient buying the lot twice is one call, not two — expected 3, got %',
      COALESCE(v::text, 'NULL');
  END IF;
  RAISE NOTICE 'PASS 18: one patient buying the lot twice is one call, not two (%)', v;
END $$;


DO $$
DECLARE n INTEGER;
BEGIN
  SELECT COUNT(*)::int INTO n FROM recall_offline_window;
  IF n <> 1 THEN
    RAISE EXCEPTION 'recall_offline_window: a window over the outage days finds the sale made during it — expected 1 row(s), got %', n;
  END IF;
  RAISE NOTICE 'PASS 19: a window over the outage days finds the sale made during it (%)', n;
END $$;


DO $$
DECLARE v TEXT;
BEGIN
  SELECT (MAX(receipt_number))::text INTO v FROM recall_offline_window;
  IF v IS DISTINCT FROM 'R-REC-0002' THEN
    RAISE EXCEPTION 'recall_offline_window: and the one it finds is the offline sale, dated by client_recorded_at — expected R-REC-0002, got %',
      COALESCE(v, 'NULL');
  END IF;
  RAISE NOTICE 'PASS 20: and the one it finds is the offline sale, dated by client_recorded_at (%)', v;
END $$;


DO $$
DECLARE v NUMERIC;
BEGIN
  SELECT (COUNT(*) FILTER (WHERE recorded_offline))::numeric INTO v FROM recall_offline_window;
  IF v IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'recall_offline_window: the sale is flagged as having been recorded offline — expected 1, got %',
      COALESCE(v::text, 'NULL');
  END IF;
  RAISE NOTICE 'PASS 21: the sale is flagged as having been recorded offline (%)', v;
END $$;


DO $$
DECLARE n INTEGER;
BEGIN
  SELECT COUNT(*)::int INTO n FROM recall_truncated;
  IF n <> 4 THEN
    RAISE EXCEPTION 'recall_truncated: the limit is applied, so a cut list is detectable — expected 4 row(s), got %', n;
  END IF;
  RAISE NOTICE 'PASS 22: the limit is applied, so a cut list is detectable (%)', n;
END $$;


DO $$
DECLARE n INTEGER;
BEGIN
  SELECT COUNT(*)::int INTO n FROM batches_by_lot;
  IF n <> 2 THEN
    RAISE EXCEPTION 'batches_by_lot: two lots on the shelf carry that number — expected 2 row(s), got %', n;
  END IF;
  RAISE NOTICE 'PASS 23: two lots on the shelf carry that number (%)', n;
END $$;


DO $$
DECLARE v NUMERIC;
BEGIN
  SELECT (COALESCE(SUM(quantity), 0))::numeric INTO v FROM batches_by_lot;
  IF v IS DISTINCT FROM 20 THEN
    RAISE EXCEPTION 'batches_by_lot: and 20 units of it are still in the building — expected 20, got %',
      COALESCE(v::text, 'NULL');
  END IF;
  RAISE NOTICE 'PASS 24: and 20 units of it are still in the building (%)', v;
END $$;


DO $$
DECLARE n INTEGER;
BEGIN
  SELECT COUNT(*)::int INTO n FROM batches_by_lot_and_product;
  IF n <> 1 THEN
    RAISE EXCEPTION 'batches_by_lot_and_product: one medicine, one lot to quarantine — expected 1 row(s), got %', n;
  END IF;
  RAISE NOTICE 'PASS 25: one medicine, one lot to quarantine (%)', n;
END $$;


DO $$
DECLARE v NUMERIC;
BEGIN
  SELECT (MAX(quantity))::numeric INTO v FROM batches_by_lot_and_product;
  IF v IS DISTINCT FROM 12 THEN
    RAISE EXCEPTION 'batches_by_lot_and_product: holding the 12 units of amoxicillin — expected 12, got %',
      COALESCE(v::text, 'NULL');
  END IF;
  RAISE NOTICE 'PASS 26: holding the 12 units of amoxicillin (%)', v;
END $$;


DO $$
DECLARE v TEXT;
BEGIN
  SELECT (MAX(supplier_name))::text INTO v FROM batches_by_lot_and_product;
  IF v IS DISTINCT FROM 'Recall Supplier' THEN
    RAISE EXCEPTION 'batches_by_lot_and_product: with the supplier named, so somebody can be called about it — expected Recall Supplier, got %',
      COALESCE(v, 'NULL');
  END IF;
  RAISE NOTICE 'PASS 27: with the supplier named, so somebody can be called about it (%)', v;
END $$;


DO $$
DECLARE v TEXT;
BEGIN
  SELECT (MAX(invoice_number))::text INTO v FROM batches_by_lot_and_product;
  IF v IS DISTINCT FROM 'INV-A1' THEN
    RAISE EXCEPTION 'batches_by_lot_and_product: and the invoice that proves where it came from — expected INV-A1, got %',
      COALESCE(v, 'NULL');
  END IF;
  RAISE NOTICE 'PASS 28: and the invoice that proves where it came from (%)', v;
END $$;


DO $$
DECLARE n INTEGER;
BEGIN
  SELECT COUNT(*)::int INTO n FROM batches_by_product_name;
  IF n <> 2 THEN
    RAISE EXCEPTION 'batches_by_product_name: a product name lists every lot of it — expected 2 row(s), got %', n;
  END IF;
  RAISE NOTICE 'PASS 29: a product name lists every lot of it (%)', n;
END $$;


ROLLBACK;

SELECT 'all recall assertions passed' AS result;
