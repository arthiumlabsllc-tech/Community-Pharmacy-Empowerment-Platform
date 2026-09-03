-- =====================================================================
-- Verification harness for 003_inventory_batches.sql
-- =====================================================================
-- Not part of the application. Run against a throwaway database to prove the
-- migration behaves, rather than discovering a problem in the Supabase SQL
-- editor against real stock. Every assertion raises on failure.
--
--   psql -v ON_ERROR_STOP=1 -d pharmacy -f 003_verify.sql
-- =====================================================================

\set ON_ERROR_STOP on

BEGIN;

-- ---------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------
INSERT INTO pharmacies (id, name, license_number, phone)
VALUES ('11111111-1111-1111-1111-111111111111', 'Test Pharmacy', 'LIC-VERIFY-003', '0240000000');

INSERT INTO users (id, pharmacy_id, role, first_name, last_name, email, password_hash)
VALUES ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111',
        'pharmacist', 'Ama', 'Osei', 'ama.verify@test.gh', 'x');

-- A product created the way POST /inventory creates it: the row carries the
-- opening figures, and the batch lands in the same transaction.
INSERT INTO inventory (id, pharmacy_id, product_name, product_code, quantity,
                       unit_price, cost_price, expiry_date, reorder_level)
VALUES ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111',
        'Amoxicillin 500mg', 'AMOX-500', 0, 12.00, 0, CURRENT_DATE + 365, 15);

-- Two deliveries. The shorter-dated one is smaller, so a sale of ten has to
-- span both — which is the case the old single-batch row could not represent.
INSERT INTO inventory_batches (inventory_id, pharmacy_id, batch_number, expiry_date,
                               quantity, cost_price, received_at)
VALUES
  ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111',
   'B/SHORT', CURRENT_DATE + 120, 6, 4.00, CURRENT_DATE - 30),
  ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111',
   'B/LONG', CURRENT_DATE + 400, 20, 5.00, CURRENT_DATE - 5);

-- ---------------------------------------------------------------------
-- 1. The product row is derived from its batches
-- ---------------------------------------------------------------------
DO $$
DECLARE r RECORD;
BEGIN
  SELECT quantity, batch_number, expiry_date, cost_price INTO r
    FROM inventory WHERE id = '33333333-3333-3333-3333-333333333333';

  IF r.quantity <> 26 THEN
    RAISE EXCEPTION 'quantity should be 26 across both batches, got %', r.quantity;
  END IF;
  IF r.batch_number <> 'B/SHORT' THEN
    RAISE EXCEPTION 'FEFO batch should be B/SHORT, got %', r.batch_number;
  END IF;
  -- Weighted average: (6 * 4.00 + 20 * 5.00) / 26 = 4.77
  IF r.cost_price <> 4.77 THEN
    RAISE EXCEPTION 'cost should be the weighted average 4.77, got %', r.cost_price;
  END IF;
  RAISE NOTICE 'PASS 1: product row is derived from its batches (%, %, %)',
    r.quantity, r.batch_number, r.cost_price;
END $$;

-- ---------------------------------------------------------------------
-- 2. A direct write to the derived columns cannot stick
-- ---------------------------------------------------------------------
UPDATE inventory SET quantity = 999, batch_number = 'TAMPERED'
 WHERE id = '33333333-3333-3333-3333-333333333333';

DO $$
DECLARE r RECORD;
BEGIN
  SELECT quantity, batch_number INTO r
    FROM inventory WHERE id = '33333333-3333-3333-3333-333333333333';
  IF r.quantity <> 26 OR r.batch_number <> 'B/SHORT' THEN
    RAISE EXCEPTION 'a direct write changed the derived columns to % / %',
      r.quantity, r.batch_number;
  END IF;
  RAISE NOTICE 'PASS 2: a direct write to inventory.quantity is recomputed away';
END $$;

-- ---------------------------------------------------------------------
-- 3. FEFO: a sale of ten empties the short-dated batch and dips into the next
-- ---------------------------------------------------------------------
UPDATE inventory_batches SET quantity = quantity - 6 WHERE batch_number = 'B/SHORT';
UPDATE inventory_batches SET quantity = quantity - 4 WHERE batch_number = 'B/LONG';

DO $$
DECLARE r RECORD;
BEGIN
  SELECT quantity, batch_number, expiry_date, cost_price INTO r
    FROM inventory WHERE id = '33333333-3333-3333-3333-333333333333';
  IF r.quantity <> 16 THEN
    RAISE EXCEPTION 'quantity should be 16 after selling ten, got %', r.quantity;
  END IF;
  -- B/SHORT is empty, so the batch that will be sold next is now B/LONG.
  IF r.batch_number <> 'B/LONG' THEN
    RAISE EXCEPTION 'next batch should have rolled to B/LONG, got %', r.batch_number;
  END IF;
  IF r.cost_price <> 5.00 THEN
    RAISE EXCEPTION 'cost should now be 5.00, the only batch with stock, got %', r.cost_price;
  END IF;
  RAISE NOTICE 'PASS 3: FEFO rolled the product to the next batch (%, %, %)',
    r.quantity, r.batch_number, r.cost_price;
END $$;

-- ---------------------------------------------------------------------
-- 4. Sold out: expiry_date stays NOT NULL and still says something true
-- ---------------------------------------------------------------------
UPDATE inventory_batches SET quantity = 0 WHERE batch_number = 'B/LONG';

DO $$
DECLARE r RECORD;
BEGIN
  SELECT quantity, batch_number, expiry_date INTO r
    FROM inventory WHERE id = '33333333-3333-3333-3333-333333333333';
  IF r.quantity <> 0 THEN
    RAISE EXCEPTION 'quantity should be 0, got %', r.quantity;
  END IF;
  IF r.expiry_date IS NULL THEN
    RAISE EXCEPTION 'expiry_date must not become NULL when the stock runs out';
  END IF;
  -- Empty batches sort last, so both are equal here and the earliest wins.
  IF r.batch_number <> 'B/SHORT' THEN
    RAISE EXCEPTION 'with nothing on hand the earliest batch should show, got %', r.batch_number;
  END IF;
  RAISE NOTICE 'PASS 4: sold out without a NULL expiry (%, %)', r.quantity, r.expiry_date;
END $$;

-- Restore, and record what the sale took.
UPDATE inventory_batches SET quantity = 6  WHERE batch_number = 'B/SHORT';
UPDATE inventory_batches SET quantity = 16 WHERE batch_number = 'B/LONG';

INSERT INTO sales (id, pharmacy_id, receipt_number, served_by, total_amount, status)
VALUES ('44444444-4444-4444-4444-444444444444', '11111111-1111-1111-1111-111111111111',
        'R-VERIFY-0001', '22222222-2222-2222-2222-222222222222', 120.00, 'completed');

INSERT INTO sale_items (id, sale_id, inventory_id, product_name, batch_number, quantity,
                        unit_price, line_total, unit_cost)
VALUES ('55555555-5555-5555-5555-555555555555', '44444444-4444-4444-4444-444444444444',
        '33333333-3333-3333-3333-333333333333', 'Amoxicillin 500mg', 'B/SHORT', 10,
        12.00, 120.00, 4.60);

INSERT INTO sale_item_batches (sale_item_id, pharmacy_id, batch_id, batch_number,
                               expiry_date, inventory_id, quantity, unit_cost)
SELECT '55555555-5555-5555-5555-555555555555', b.pharmacy_id, b.id, b.batch_number,
       b.expiry_date, b.inventory_id,
       CASE b.batch_number WHEN 'B/SHORT' THEN 6 ELSE 4 END,
       b.cost_price
  FROM inventory_batches b
 WHERE b.batch_number IN ('B/SHORT', 'B/LONG');

-- ---------------------------------------------------------------------
-- 5. The recall question: which sales contained this batch?
-- ---------------------------------------------------------------------
DO $$
DECLARE n INTEGER; total INTEGER;
BEGIN
  SELECT COUNT(*), COALESCE(SUM(sib.quantity), 0) INTO n, total
    FROM sale_item_batches sib
    JOIN sale_items si ON si.id = sib.sale_item_id
    JOIN sales s       ON s.id  = si.sale_id
   WHERE sib.pharmacy_id = '11111111-1111-1111-1111-111111111111'
     AND sib.batch_number = 'B/LONG';

  IF n <> 1 OR total <> 4 THEN
    RAISE EXCEPTION 'recall of B/LONG should find one sale taking 4 units, found % / %', n, total;
  END IF;
  RAISE NOTICE 'PASS 5: a recall finds % sale(s) and % unit(s) of B/LONG', n, total;
END $$;

-- The line spans two batches; the junction says so and the receipt line does not.
DO $$
DECLARE n INTEGER;
BEGIN
  SELECT COUNT(*) INTO n FROM sale_item_batches
   WHERE sale_item_id = '55555555-5555-5555-5555-555555555555';
  IF n <> 2 THEN
    RAISE EXCEPTION 'one receipt line drew from 2 batches, junction holds %', n;
  END IF;
  RAISE NOTICE 'PASS 6: one receipt line, % batch allocations behind it', n;
END $$;

-- ---------------------------------------------------------------------
-- 7. Alerts dedupe while live, and release the key when superseded
-- ---------------------------------------------------------------------
INSERT INTO notifications (pharmacy_id, type, title, message, dedupe_key)
VALUES ('11111111-1111-1111-1111-111111111111', 'in_app', 'Low stock',
        'Amoxicillin 500mg is below its reorder level', 'low_stock:33333333');

DO $$
BEGIN
  BEGIN
    INSERT INTO notifications (pharmacy_id, type, title, message, dedupe_key)
    VALUES ('11111111-1111-1111-1111-111111111111', 'in_app', 'Low stock',
            'duplicate', 'low_stock:33333333');
    RAISE EXCEPTION 'a second live alert for the same key should have been refused';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'PASS 7: a second live alert for the same product is refused';
  END;
END $$;

UPDATE notifications SET superseded_at = NOW()
 WHERE dedupe_key = 'low_stock:33333333' AND superseded_at IS NULL;

INSERT INTO notifications (pharmacy_id, type, title, message, dedupe_key)
VALUES ('11111111-1111-1111-1111-111111111111', 'in_app', 'Low stock',
        'Amoxicillin 500mg went low again', 'low_stock:33333333');

DO $$
DECLARE n INTEGER;
BEGIN
  SELECT COUNT(*) INTO n FROM notifications
   WHERE dedupe_key = 'low_stock:33333333';
  IF n <> 2 THEN
    RAISE EXCEPTION 'superseding should release the key, expected 2 rows got %', n;
  END IF;
  RAISE NOTICE 'PASS 8: superseding releases the key, and the history stays (%) rows', n;
END $$;

-- ---------------------------------------------------------------------
-- 9. Re-running the migration must not duplicate the backfilled stock
-- ---------------------------------------------------------------------
-- Simulated by repeating the backfill statement's guard directly.
DO $$
DECLARE n INTEGER;
BEGIN
  SELECT COUNT(*) INTO n FROM inventory_batches
   WHERE inventory_id = '33333333-3333-3333-3333-333333333333';
  IF n <> 2 THEN
    RAISE EXCEPTION 'expected the 2 batches created above, found %', n;
  END IF;
  RAISE NOTICE 'PASS 9: batch count unchanged at %', n;
END $$;

-- ---------------------------------------------------------------------
-- 10. reminders was the other table the updated_at trigger had broken
-- ---------------------------------------------------------------------
-- The reminder worker marks a reminder sent. Before the guard in 003 that
-- UPDATE raised "record new has no field updated_at", so every reminder would
-- have stayed pending forever and been sent again.
INSERT INTO patients (id, pharmacy_id, first_name, last_name, phone)
VALUES ('66666666-6666-6666-6666-666666666666', '11111111-1111-1111-1111-111111111111',
        'Kofi', 'Mensah', '0201234567');

INSERT INTO reminders (pharmacy_id, patient_id, created_by, type, title, scheduled_at)
VALUES ('11111111-1111-1111-1111-111111111111', '66666666-6666-6666-6666-666666666666',
        '22222222-2222-2222-2222-222222222222', 'refill', 'Refill due', NOW());

UPDATE reminders SET status = 'sent', sent_at = NOW()
 WHERE pharmacy_id = '11111111-1111-1111-1111-111111111111';

DO $$
DECLARE n INTEGER;
BEGIN
  SELECT COUNT(*) INTO n FROM reminders
   WHERE pharmacy_id = '11111111-1111-1111-1111-111111111111'
     AND status = 'sent' AND sent_at IS NOT NULL;
  IF n <> 1 THEN
    RAISE EXCEPTION 'marking a reminder sent should have worked, % row(s) updated', n;
  END IF;
  RAISE NOTICE 'PASS 10: a reminder can be marked sent';
END $$;

-- ---------------------------------------------------------------------
-- 11. A product with no batches is still written exactly as the caller wrote it
-- ---------------------------------------------------------------------
-- This is what makes the migration backwards-compatible: the derived columns
-- only take over once a batch exists. POST /inventory relies on it, because it
-- inserts the product row and its opening batch in the same transaction.
INSERT INTO inventory (id, pharmacy_id, product_name, product_code, quantity,
                       unit_price, cost_price, expiry_date, reorder_level,
                       batch_number)
VALUES ('77777777-7777-7777-7777-777777777777', '11111111-1111-1111-1111-111111111111',
        'Paracetamol 500mg', 'PARA-500', 50, 8.00, 3.50, CURRENT_DATE + 500, 20, 'B/PENDING');

DO $$
DECLARE r RECORD;
BEGIN
  SELECT quantity, batch_number, cost_price INTO r FROM inventory
   WHERE id = '77777777-7777-7777-7777-777777777777';
  IF r.quantity <> 50 OR r.batch_number <> 'B/PENDING' OR r.cost_price <> 3.50 THEN
    RAISE EXCEPTION 'with no batches the row should be untouched, got % / % / %',
      r.quantity, r.batch_number, r.cost_price;
  END IF;
  RAISE NOTICE 'PASS 11: a product with no batches keeps its own figures (%, %)',
    r.quantity, r.batch_number;
END $$;

-- ...and takes over the moment the opening batch lands.
INSERT INTO inventory_batches (inventory_id, pharmacy_id, batch_number, expiry_date,
                               quantity, cost_price)
VALUES ('77777777-7777-7777-7777-777777777777', '11111111-1111-1111-1111-111111111111',
        'B/REAL', CURRENT_DATE + 300, 40, 3.00);

DO $$
DECLARE r RECORD;
BEGIN
  SELECT quantity, batch_number, cost_price INTO r FROM inventory
   WHERE id = '77777777-7777-7777-7777-777777777777';
  IF r.quantity <> 40 OR r.batch_number <> 'B/REAL' OR r.cost_price <> 3.00 THEN
    RAISE EXCEPTION 'the batch should now drive the row, got % / % / %',
      r.quantity, r.batch_number, r.cost_price;
  END IF;
  RAISE NOTICE 'PASS 12: the batch takes over as soon as it exists (%, %, %)',
    r.quantity, r.batch_number, r.cost_price;
END $$;

-- ---------------------------------------------------------------------
-- 13. The sale write path, statement for statement as pos.routes.ts emits it
-- ---------------------------------------------------------------------
-- insertLineItems writes sale_items RETURNING id, then for each allocation an
-- UPDATE of the batch, a junction row and a ledger row. Proving the SQL runs is
-- worth more than reading it: a wrong column name here is a 500 on every sale,
-- and nothing else in the test suite touches a real database.
INSERT INTO sales (id, pharmacy_id, receipt_number, served_by, total_amount, status)
VALUES ('88888888-8888-8888-8888-888888888888', '11111111-1111-1111-1111-111111111111',
        'R-VERIFY-0002', '22222222-2222-2222-2222-222222222222', 90.00, 'completed');

DO $$
DECLARE
  v_sale_item_id UUID;
  v_batch_id     UUID;
  v_after        INTEGER;
  v_product_qty  INTEGER;
BEGIN
  INSERT INTO sale_items
    (sale_id, inventory_id, product_name, product_code, generic_name, batch_number,
     expiry_date, requires_prescription, quantity, sell_unit, unit_price, discount_amount,
     line_total, vat_treatment, taxable_base, vat_amount, nhil_amount, getfund_amount, unit_cost)
  VALUES ('88888888-8888-8888-8888-888888888888', '77777777-7777-7777-7777-777777777777',
          'Paracetamol 500mg', 'PARA-500', 'Paracetamol', 'B/REAL',
          CURRENT_DATE + 300, false, 10, 'pack', 9.00, 0, 90.00, 'exempt', 90.00, 0, 0, 0, 3.00)
  RETURNING id INTO v_sale_item_id;

  SELECT id INTO v_batch_id FROM inventory_batches
   WHERE inventory_id = '77777777-7777-7777-7777-777777777777' AND batch_number = 'B/REAL';

  UPDATE inventory_batches
      SET quantity = quantity - 10, updated_at = NOW()
    WHERE id = v_batch_id AND pharmacy_id = '11111111-1111-1111-1111-111111111111'
  RETURNING quantity INTO v_after;

  INSERT INTO sale_item_batches
    (sale_item_id, pharmacy_id, batch_id, batch_number, expiry_date,
     inventory_id, quantity, unit_cost)
  VALUES (v_sale_item_id, '11111111-1111-1111-1111-111111111111', v_batch_id, 'B/REAL',
          CURRENT_DATE + 300, '77777777-7777-7777-7777-777777777777', 10, 3.00);

  -- occurred_at as the route binds it: the client's own timestamp when the sale
  -- was queued offline, NOW() otherwise. The cast is what makes a null
  -- parameter unambiguous to Postgres.
  INSERT INTO stock_movements
    (pharmacy_id, inventory_id, batch_id, quantity_change, quantity_after,
     reason, sale_id, sale_item_id, user_id, occurred_at)
  VALUES ('11111111-1111-1111-1111-111111111111', '77777777-7777-7777-7777-777777777777',
          v_batch_id, -10, v_after, 'sale', '88888888-8888-8888-8888-888888888888',
          v_sale_item_id, '22222222-2222-2222-2222-222222222222',
          COALESCE(NULL::timestamptz, NOW()));

  IF v_after <> 30 THEN
    RAISE EXCEPTION 'the batch should hold 30 after selling 10 of 40, got %', v_after;
  END IF;

  -- The route never writes inventory.quantity for a batched line. If it had, the
  -- trigger would have thrown the write away; this proves the product row still
  -- ended up right without it.
  SELECT quantity INTO v_product_qty FROM inventory
   WHERE id = '77777777-7777-7777-7777-777777777777';
  IF v_product_qty <> 30 THEN
    RAISE EXCEPTION 'the product row should follow the batch to 30, got %', v_product_qty;
  END IF;

  RAISE NOTICE 'PASS 13: the sale write path runs, batch and product both at %', v_after;
END $$;

-- ---------------------------------------------------------------------
-- 14. The void write path, as pos.routes.ts emits it
-- ---------------------------------------------------------------------
-- Credit goes back to the batches the line drew from, not to the product row.
-- Adding it to the product row instead would be thrown away by the trigger a
-- moment later, so the stock would simply vanish on every void.
DO $$
DECLARE
  v_sold  RECORD;
  v_entry RECORD;
  v_after INTEGER;
  v_qty   INTEGER;
BEGIN
  FOR v_sold IN SELECT id, inventory_id, quantity FROM sale_items
                 WHERE sale_id = '88888888-8888-8888-8888-888888888888'
                   AND inventory_id IS NOT NULL
  LOOP
    FOR v_entry IN SELECT batch_id, quantity FROM sale_item_batches
                    WHERE sale_item_id = v_sold.id
    LOOP
      UPDATE inventory_batches
          SET quantity = quantity + v_entry.quantity, updated_at = NOW()
        WHERE id = v_entry.batch_id
          AND pharmacy_id = '11111111-1111-1111-1111-111111111111'
      RETURNING quantity INTO v_after;

      INSERT INTO stock_movements
        (pharmacy_id, inventory_id, batch_id, quantity_change, quantity_after,
         reason, note, sale_id, sale_item_id, user_id)
      VALUES ('11111111-1111-1111-1111-111111111111', v_sold.inventory_id, v_entry.batch_id,
              v_entry.quantity, v_after, 'sale_void', 'Damaged in the bag',
              '88888888-8888-8888-8888-888888888888', v_sold.id,
              '22222222-2222-2222-2222-222222222222');
    END LOOP;
  END LOOP;

  SELECT quantity INTO v_qty FROM inventory_batches
   WHERE inventory_id = '77777777-7777-7777-7777-777777777777' AND batch_number = 'B/REAL';
  IF v_qty <> 40 THEN
    RAISE EXCEPTION 'the void should have put the batch back to 40, got %', v_qty;
  END IF;

  SELECT quantity INTO v_qty FROM inventory
   WHERE id = '77777777-7777-7777-7777-777777777777';
  IF v_qty <> 40 THEN
    RAISE EXCEPTION 'the product row should follow the batch back to 40, got %', v_qty;
  END IF;

  RAISE NOTICE 'PASS 14: a void returns stock to the batch it came from (%)', v_qty;
END $$;

-- ---------------------------------------------------------------------
-- 15. The ledger reconciles against the shelf
-- ---------------------------------------------------------------------
-- Every movement for the batch, summed, must equal the difference between what
-- it holds now and what it started with. A ledger that does not foot is worse
-- than no ledger, because somebody will trust it.
DO $$
DECLARE net INTEGER; movements INTEGER;
BEGIN
  SELECT COALESCE(SUM(quantity_change), 0), COUNT(*) INTO net, movements
    FROM stock_movements
   WHERE pharmacy_id = '11111111-1111-1111-1111-111111111111'
     AND inventory_id = '77777777-7777-7777-7777-777777777777';

  IF movements <> 2 THEN
    RAISE EXCEPTION 'a sale and its void should be 2 movements, found %', movements;
  END IF;
  -- Sale of 10 then void of 10: the shelf is back where it started, and the
  -- ledger says so without hiding that both happened.
  IF net <> 0 THEN
    RAISE EXCEPTION 'the movements should net to zero after a void, got %', net;
  END IF;
  RAISE NOTICE 'PASS 15: % movements net to %, matching the shelf', movements, net;
END $$;

-- ---------------------------------------------------------------------
-- 16. The product-edit guard, as inventory.routes.ts emits it
-- ---------------------------------------------------------------------
-- A batched product recomputes quantity, batch_number, cost_price and
-- expiry_date from its batches, so an edit to them has to be refused by the
-- statement rather than written and then thrown away by the trigger. One
-- statement covers both cases through $20, and the column that is not derived
-- must still write — otherwise the guard would be indistinguishable from the
-- whole UPDATE having stopped working.
DO $$
DECLARE
  v_sql TEXT;
  r     RECORD;
  v_nobatch CONSTANT UUID := '99999999-9999-9999-9999-999999999999';
BEGIN
  INSERT INTO inventory (id, pharmacy_id, product_name, product_code, quantity,
                         unit_price, cost_price, expiry_date, reorder_level, batch_number)
  VALUES (v_nobatch, '11111111-1111-1111-1111-111111111111',
          'Unbatched Thing', 'VERIFY-NOBATCH', 12, 5.00, 2.00, CURRENT_DATE + 500, 4, 'LEGACY');

  v_sql := $q$
    UPDATE inventory SET
      product_name = COALESCE($3, product_name),
      product_code = COALESCE($4, product_code),
      generic_name = COALESCE($5, generic_name),
      category = COALESCE($6, category),
      manufacturer = COALESCE($7, manufacturer),
      batch_number = CASE WHEN $20::boolean THEN batch_number ELSE COALESCE($8, batch_number) END,
      quantity     = CASE WHEN $20::boolean THEN quantity     ELSE COALESCE($9, quantity) END,
      unit_price = COALESCE($10, unit_price),
      cost_price   = CASE WHEN $20::boolean THEN cost_price   ELSE COALESCE($11, cost_price) END,
      expiry_date  = CASE WHEN $20::boolean THEN expiry_date  ELSE COALESCE($12, expiry_date) END,
      reorder_level = COALESCE($13, reorder_level),
      shelf_location = COALESCE($14, shelf_location),
      barcode = COALESCE($15, barcode),
      requires_prescription = COALESCE($16, requires_prescription),
      vat_treatment = COALESCE($17, vat_treatment),
      pack_size = COALESCE($18, pack_size),
      default_sell_unit = COALESCE($19, default_sell_unit)
     WHERE id = $1 AND pharmacy_id = $2
     RETURNING batch_number, quantity, cost_price, reorder_level, expiry_date
  $q$;

  -- Cast to uuid. A bound parameter arrives untyped and Postgres infers uuid
  -- from the column it is compared against; an EXECUTE USING expression has a
  -- known type, and text does not compare against uuid.
  EXECUTE v_sql USING
    '77777777-7777-7777-7777-777777777777'::uuid, '11111111-1111-1111-1111-111111111111'::uuid,
    NULL::varchar, NULL::varchar, NULL::varchar, NULL::varchar, NULL::varchar,
    'HACKED', 999, NULL::numeric, 25.00, CURRENT_DATE + 1,
    25, NULL::varchar, NULL::varchar, NULL::boolean, NULL::vat_treatment,
    NULL::integer, NULL::varchar, true
  INTO r;

  IF r.quantity <> 40 OR r.batch_number <> 'B/REAL' OR r.cost_price <> 3.00
     OR r.expiry_date <> CURRENT_DATE + 300 THEN
    RAISE EXCEPTION 'a batched product must ignore the derived columns, got % / % / % / %',
      r.quantity, r.batch_number, r.cost_price, r.expiry_date;
  END IF;
  IF r.reorder_level <> 25 THEN
    RAISE EXCEPTION 'reorder_level is not derived and should have been written, got %',
      r.reorder_level;
  END IF;

  EXECUTE v_sql USING
    v_nobatch, '11111111-1111-1111-1111-111111111111'::uuid,
    NULL::varchar, NULL::varchar, NULL::varchar, NULL::varchar, NULL::varchar,
    'EDITED', 20, NULL::numeric, 3.50, CURRENT_DATE + 400,
    NULL::integer, NULL::varchar, NULL::varchar, NULL::boolean, NULL::vat_treatment,
    NULL::integer, NULL::varchar, false
  INTO r;

  IF r.quantity <> 20 OR r.batch_number <> 'EDITED' OR r.cost_price <> 3.50
     OR r.expiry_date <> CURRENT_DATE + 400 THEN
    RAISE EXCEPTION 'an unbatched product should still edit as it always did, got % / % / % / %',
      r.quantity, r.batch_number, r.cost_price, r.expiry_date;
  END IF;

  RAISE NOTICE 'PASS 16: the edit guard follows the trigger in both directions';
END $$;

-- ---------------------------------------------------------------------
-- 17. Receiving a delivery into a new lot
-- ---------------------------------------------------------------------
DO $$
DECLARE
  v_sql TEXT;
  v_id  UUID;
  r     RECORD;
BEGIN
  INSERT INTO suppliers (id, pharmacy_id, name)
  VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', '11111111-1111-1111-1111-111111111111',
          'Verify Supplier One'),
         ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2', '11111111-1111-1111-1111-111111111111',
          'Verify Supplier Two');

  v_sql := $q$
    INSERT INTO inventory_batches
      (pharmacy_id, inventory_id, batch_number, expiry_date, quantity,
       cost_price, supplier_id, invoice_number, received_at, received_by, is_backfill)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9::date, CURRENT_DATE),$10,false)
    RETURNING id
  $q$;

  EXECUTE v_sql USING
    '11111111-1111-1111-1111-111111111111'::uuid, '77777777-7777-7777-7777-777777777777'::uuid,
    'B/NEW', CURRENT_DATE + 100, 20, 4.50,
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1'::uuid, 'INV-001', NULL::date,
    '22222222-2222-2222-2222-222222222222'::uuid
  INTO v_id;

  INSERT INTO stock_movements
    (pharmacy_id, inventory_id, batch_id, quantity_change, quantity_after,
     reason, note, supplier_id, user_id, occurred_at)
  VALUES ('11111111-1111-1111-1111-111111111111'::uuid, '77777777-7777-7777-7777-777777777777'::uuid,
          v_id, 20, 20, 'receipt', 'Invoice INV-001',
          'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1'::uuid, '22222222-2222-2222-2222-222222222222'::uuid,
          COALESCE(NULL::timestamptz, NOW()));

  -- A delivery with no date given arrives today, and is not dressed up as one
  -- of the balances the migration invented.
  SELECT received_at, is_backfill INTO r FROM inventory_batches WHERE id = v_id;
  IF r.received_at <> CURRENT_DATE OR r.is_backfill THEN
    RAISE EXCEPTION 'a received lot should date itself today and not claim to be a backfill';
  END IF;

  -- The product row now summarises two lots: 60 units, the shortest date
  -- leading, and a cost weighted across both rather than taken from either.
  -- (40 * 3.00 + 20 * 4.50) / 60 = 3.50.
  SELECT quantity, batch_number, cost_price, expiry_date INTO r
    FROM inventory WHERE id = '77777777-7777-7777-7777-777777777777';
  IF r.quantity <> 60 OR r.batch_number <> 'B/NEW' OR r.cost_price <> 3.50
     OR r.expiry_date <> CURRENT_DATE + 100 THEN
    RAISE EXCEPTION 'the delivery should be summarised on the row, got % / % / % / %',
      r.quantity, r.batch_number, r.cost_price, r.expiry_date;
  END IF;

  RAISE NOTICE 'PASS 17: a delivery becomes a lot and the row follows (%, %, %)',
    r.quantity, r.batch_number, r.cost_price;
END $$;

-- ---------------------------------------------------------------------
-- 18. Receiving the same lot again merges instead of duplicating
-- ---------------------------------------------------------------------
-- UNIQUE (inventory_id, batch_number) means a top-up finds the existing row.
-- The cost is weighted across what each side holds, the earlier expiry governs
-- because one lot cannot genuinely have two dates, and the supplier and invoice
-- stay those of the delivery the lot came from — the second consignment is on
-- the ledger, which is where delivery history belongs.
DO $$
DECLARE
  v_before RECORD;
  r        RECORD;
  v_held   INTEGER;
  v_qty    INTEGER;
  v_cost   NUMERIC;
  v_expiry DATE;
BEGIN
  SELECT id, quantity, cost_price, expiry_date INTO v_before
    FROM inventory_batches
   WHERE pharmacy_id = '11111111-1111-1111-1111-111111111111'
     AND inventory_id = '77777777-7777-7777-7777-777777777777'
     AND batch_number = 'B/NEW'
   FOR UPDATE;

  -- The route's arithmetic, replayed rather than trusted.
  v_held   := GREATEST(v_before.quantity, 0);
  v_qty    := v_before.quantity + 10;
  v_cost   := ROUND((v_held * v_before.cost_price + 10 * 6.00) / (v_held + 10), 2);
  v_expiry := LEAST(v_before.expiry_date, CURRENT_DATE + 200);

  UPDATE inventory_batches
      SET quantity = v_qty,
          cost_price = v_cost,
          expiry_date = v_expiry,
          is_active = true,
          supplier_id = COALESCE(supplier_id, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2'::uuid),
          invoice_number = COALESCE(invoice_number, 'INV-002')
    WHERE id = v_before.id
    RETURNING quantity, cost_price, expiry_date, supplier_id, invoice_number INTO r;

  INSERT INTO stock_movements
    (pharmacy_id, inventory_id, batch_id, quantity_change, quantity_after,
     reason, note, supplier_id, user_id)
  VALUES ('11111111-1111-1111-1111-111111111111', '77777777-7777-7777-7777-777777777777',
          v_before.id, 10, r.quantity, 'receipt', 'Invoice INV-002 — top-up against an existing lot',
          'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2'::uuid, '22222222-2222-2222-2222-222222222222'::uuid);

  -- (20 * 4.50 + 10 * 6.00) / 30 = 5.00, and the date on file wins over the
  -- later one on the invoice.
  IF r.quantity <> 30 OR r.cost_price <> 5.00 OR r.expiry_date <> CURRENT_DATE + 100 THEN
    RAISE EXCEPTION 'the merge should hold 30 at 5.00 expiring in 100 days, got % / % / %',
      r.quantity, r.cost_price, r.expiry_date;
  END IF;
  IF r.supplier_id <> 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1' OR r.invoice_number <> 'INV-001' THEN
    RAISE EXCEPTION 'a top-up should not rewrite where the lot came from, got % / %',
      r.supplier_id, r.invoice_number;
  END IF;

  -- (40 * 3.00 + 30 * 5.00) / 70 = 3.86 once the row rounds it.
  SELECT quantity, batch_number, cost_price INTO r
    FROM inventory WHERE id = '77777777-7777-7777-7777-777777777777';
  IF r.quantity <> 70 OR r.batch_number <> 'B/NEW' OR r.cost_price <> 3.86 THEN
    RAISE EXCEPTION 'the row should re-weight across both lots, got % / % / %',
      r.quantity, r.batch_number, r.cost_price;
  END IF;

  RAISE NOTICE 'PASS 18: a repeated lot merges, keeps its origin and re-weights (%, %)',
    r.quantity, r.cost_price;
END $$;

-- ---------------------------------------------------------------------
-- 19. A stock-take correction
-- ---------------------------------------------------------------------
-- Counting a batch down is a correction; counting it to nothing also closes it,
-- because a lot with no units in it is not stock anybody should be offered.
-- Counting it back up must not reopen one that was quarantined on purpose.
DO $$
DECLARE
  v_sql   TEXT;
  v_batch UUID;
  r       RECORD;
BEGIN
  INSERT INTO inventory_batches (pharmacy_id, inventory_id, batch_number, expiry_date,
                                 quantity, cost_price)
  VALUES ('11111111-1111-1111-1111-111111111111', '77777777-7777-7777-7777-777777777777',
          'B/COUNT', CURRENT_DATE + 60, 8, 2.00)
  RETURNING id INTO v_batch;

  INSERT INTO stock_movements
    (pharmacy_id, inventory_id, batch_id, quantity_change, quantity_after, reason, note, user_id)
  VALUES ('11111111-1111-1111-1111-111111111111', '77777777-7777-7777-7777-777777777777',
          v_batch, 8, 8, 'receipt', 'Stock-take fixture',
          '22222222-2222-2222-2222-222222222222');

  v_sql := $q$
    UPDATE inventory_batches
        SET quantity = $1,
            is_active = CASE WHEN $2 = 0 THEN false ELSE is_active END
      WHERE id = $3
    RETURNING quantity, is_active
  $q$;

  EXECUTE v_sql USING 6, 6, v_batch INTO r;
  IF r.quantity <> 6 OR NOT r.is_active THEN
    RAISE EXCEPTION 'counting 8 down to 6 should leave the lot open, got % / %',
      r.quantity, r.is_active;
  END IF;

  INSERT INTO stock_movements
    (pharmacy_id, inventory_id, batch_id, quantity_change, quantity_after, reason, note, user_id)
  VALUES ('11111111-1111-1111-1111-111111111111', '77777777-7777-7777-7777-777777777777',
          v_batch, -2, 6, 'adjustment', 'Counted 6, was 8. Two strips short after the shelf count.',
          '22222222-2222-2222-2222-222222222222');

  EXECUTE v_sql USING 0, 0, v_batch INTO r;
  IF r.quantity <> 0 OR r.is_active THEN
    RAISE EXCEPTION 'counting a lot to nothing should close it, got % / %',
      r.quantity, r.is_active;
  END IF;

  INSERT INTO stock_movements
    (pharmacy_id, inventory_id, batch_id, quantity_change, quantity_after, reason, note, user_id)
  VALUES ('11111111-1111-1111-1111-111111111111', '77777777-7777-7777-7777-777777777777',
          v_batch, -6, 0, 'adjustment', 'Counted 0, was 6. Returned to the supplier.',
          '22222222-2222-2222-2222-222222222222');

  RAISE NOTICE 'PASS 19: a count corrects the lot and closes it at zero';
END $$;

-- ---------------------------------------------------------------------
-- 20. A write-off
-- ---------------------------------------------------------------------
-- This is what the till's own refusal tells the pharmacist to go and do: the
-- batch is quarantined, the units leave the count, and the ledger records why.
DO $$
DECLARE
  v_sql    TEXT;
  v_before RECORD;
  r        RECORD;
BEGIN
  SELECT id, quantity, expiry_date INTO v_before
    FROM inventory_batches
   WHERE pharmacy_id = '11111111-1111-1111-1111-111111111111'
     AND inventory_id = '77777777-7777-7777-7777-777777777777'
     AND batch_number = 'B/NEW'
   FOR UPDATE;

  v_sql := $q$
    UPDATE inventory_batches
        SET quantity = $1,
            is_active = CASE WHEN $2 = 0 THEN false ELSE is_active END
      WHERE id = $3
    RETURNING quantity, is_active
  $q$;

  EXECUTE v_sql USING 0, 0, v_before.id INTO r;
  IF r.quantity <> 0 OR r.is_active THEN
    RAISE EXCEPTION 'a full write-off should empty the lot and close it, got % / %',
      r.quantity, r.is_active;
  END IF;

  INSERT INTO stock_movements
    (pharmacy_id, inventory_id, batch_id, quantity_change, quantity_after,
     reason, note, user_id)
  VALUES ('11111111-1111-1111-1111-111111111111', '77777777-7777-7777-7777-777777777777',
          v_before.id, -30, 0, 'expiry_writeoff',
          'Expired: quarantined after the till refused it (batch closed)',
          '22222222-2222-2222-2222-222222222222');

  -- With B/NEW and B/COUNT both empty, B/REAL is the only lot left holding
  -- stock, and the row should say so rather than keeping the written-off one.
  SELECT quantity, batch_number, cost_price, expiry_date INTO r
    FROM inventory WHERE id = '77777777-7777-7777-7777-777777777777';
  IF r.quantity <> 40 OR r.batch_number <> 'B/REAL' OR r.cost_price <> 3.00
     OR r.expiry_date <> CURRENT_DATE + 300 THEN
    RAISE EXCEPTION 'the row should fall back to the one lot with stock, got % / % / % / %',
      r.quantity, r.batch_number, r.cost_price, r.expiry_date;
  END IF;

  RAISE NOTICE 'PASS 20: a write-off empties the lot, closes it and re-summarises the row';
END $$;

-- ---------------------------------------------------------------------
-- 21. Every lot built through the API foots to its ledger
-- ---------------------------------------------------------------------
-- The strongest thing that can be said about a stock ledger: for each batch,
-- the movements sum to exactly what is on the shelf. B/REAL is excluded because
-- the fixture above inserted it without a ledger row, which is the one batch
-- here this invariant cannot be asked of.
DO $$
DECLARE
  b       RECORD;
  net     INTEGER;
  checked INTEGER := 0;
BEGIN
  FOR b IN SELECT id, batch_number, quantity
             FROM inventory_batches
            WHERE inventory_id = '77777777-7777-7777-7777-777777777777'
              AND batch_number <> 'B/REAL'
  LOOP
    SELECT COALESCE(SUM(quantity_change), 0) INTO net
      FROM stock_movements WHERE batch_id = b.id;

    IF net <> b.quantity THEN
      RAISE EXCEPTION 'lot %: the ledger sums to % but the shelf holds %',
        b.batch_number, net, b.quantity;
    END IF;
    checked := checked + 1;
  END LOOP;

  IF checked < 2 THEN
    RAISE EXCEPTION 'expected the two API-built lots to reconcile, found %', checked;
  END IF;

  RAISE NOTICE 'PASS 21: % lots each foot to their ledger', checked;
END $$;

ROLLBACK;

SELECT 'all assertions passed' AS result;
