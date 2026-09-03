-- =====================================================================
-- Verification harness for the stock alerts and the notification reader
-- =====================================================================
-- GENERATED FILE — DO NOT EDIT BY HAND.
--
-- Rendered from backend/src/utils/stock-alerts.ts (the writer) and
-- backend/src/utils/notification-queries.ts (the reader) by
-- backend/src/utils/stock-alert-verify-sql.ts, so the SQL below is the string
-- the API actually sends, with its parameters inlined as typed literals.
-- Editing it by hand changes nothing; editing a builder and not regenerating
-- fails backend/src/__tests__/stock-alerts.test.ts.
--
--   cd backend && npm run alerts:emit
--   psql -v ON_ERROR_STOP=1 -d pharmacy -f 005_stock_alerts_verify.sql
--
-- Only the SQL is under test here. The wording of each alert and the date
-- arithmetic that decides whether one is due are TypeScript, and they are
-- tested in jest.
-- =====================================================================

\set ON_ERROR_STOP on

BEGIN;


-- ---------------------------------------------------------------------
-- Whether the alert columns are installed
-- ---------------------------------------------------------------------
-- Read before anything is written, exactly as hasAlertDedupe does it.

-- The real question: are both columns 003 adds there to be written to?
CREATE TEMP VIEW probe_both AS

      SELECT COUNT(*)::int AS columns_found
        FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'notifications'
         AND column_name = ANY(ARRAY['dedupe_key'::text, 'superseded_at'::text]::text[]::text[]);


-- Asked about one real column.
CREATE TEMP VIEW probe_one AS

      SELECT COUNT(*)::int AS columns_found
        FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'notifications'
         AND column_name = ANY(ARRAY['dedupe_key'::text]::text[]::text[]);


-- Asked about one real column and one that does not exist. A migration
-- half-applied must not read as installed, and a name that matches nothing
-- must not raise.
CREATE TEMP VIEW probe_half AS

      SELECT COUNT(*)::int AS columns_found
        FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'notifications'
         AND column_name = ANY(ARRAY['dedupe_key'::text, 'no_such_column_005'::text]::text[]::text[]);


-- Asked about a column that does not exist at all, which is the control
-- that makes the three counts above mean something.
CREATE TEMP VIEW probe_absent AS

      SELECT COUNT(*)::int AS columns_found
        FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'notifications'
         AND column_name = ANY(ARRAY['no_such_column_005'::text]::text[]::text[]);


DO $$
DECLARE v NUMERIC;
BEGIN
  SELECT (MAX(columns_found))::numeric INTO v FROM probe_both;
  IF v IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'probe_both: the probe finds both columns 003 adds, in the schema the module writes to — expected 2, got %',
      COALESCE(v::text, 'NULL');
  END IF;
  RAISE NOTICE 'PASS 1: the probe finds both columns 003 adds, in the schema the module writes to (%)', v;
END $$;


DO $$
DECLARE v NUMERIC;
BEGIN
  SELECT (MAX(columns_found))::numeric INTO v FROM probe_one;
  IF v IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'probe_one: and counts the columns rather than detecting any — expected 1, got %',
      COALESCE(v::text, 'NULL');
  END IF;
  RAISE NOTICE 'PASS 2: and counts the columns rather than detecting any (%)', v;
END $$;


DO $$
DECLARE v NUMERIC;
BEGIN
  SELECT (MAX(columns_found))::numeric INTO v FROM probe_half;
  IF v IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'probe_half: a column that does not exist is not counted, so a half-applied 003 reads as missing — expected 1, got %',
      COALESCE(v::text, 'NULL');
  END IF;
  RAISE NOTICE 'PASS 3: a column that does not exist is not counted, so a half-applied 003 reads as missing (%)', v;
END $$;


DO $$
DECLARE v NUMERIC;
BEGIN
  SELECT (MAX(columns_found))::numeric INTO v FROM probe_absent;
  IF v IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'probe_absent: and the count can be zero, so the assertion above is not satisfied by anything — expected 0, got %',
      COALESCE(v::text, 'NULL');
  END IF;
  RAISE NOTICE 'PASS 4: and the count can be zero, so the assertion above is not satisfied by anything (%)', v;
END $$;


-- ---------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------
INSERT INTO pharmacies (id, name, license_number, phone)
VALUES
  ('11111111-1111-1111-1111-111111111112'::uuid, 'Alert Test Pharmacy', 'LIC-VERIFY-005', '0240000005'),
  ('11111111-1111-1111-1111-111111111113'::uuid, 'Alert Test Pharmacy Ashaiman', 'LIC-VERIFY-006', '0240000006');

-- No batches for any of these, on purpose: the derived-stock trigger returns a
-- product unchanged when it has none, so the quantities below are exactly what
-- the classifier reads. Batch arithmetic is 003_verify.sql's subject.
--
-- The shelf, one product per branch of classifyStock:
--   AL-240    Artemether/Lumefantrine 20/120
--             below its reorder level with the expiry far off — one low-stock alert and nothing else
--   INS-100   Insulin Glargine 100IU/mL
--             at zero — out of stock, and the early return means no expiry alert is stacked on it
--   ORS-CH    ORS Sachets (children's)
--             below zero, which is a stock-take rather than an order — and an apostrophe to escape
--   TET-250   Tetracycline 250mg
--             past its date but above its reorder level — expired only, never also expiring
--   OXY-10    Oxytocin 10IU/mL
--             well stocked but 45 days from its date — expiring, with no order implied
--   ADR-1     Adrenaline 1mg/mL
--             low AND 80 days out — two alerts for one product, because they are two different jobs
--   PAR-500   Paracetamol 500mg
--             stocked and far from its date — the product that must never appear in the bell
--   OLD-1     Withdrawn Product
--             retired — raises nothing, which is how deactivating a product clears its alerts
INSERT INTO inventory (id, pharmacy_id, product_name, product_code, quantity,
                       unit_price, cost_price, expiry_date, reorder_level,
                       batch_number, is_active)
VALUES
  ('a1000000-0000-0000-0000-000000000001'::uuid,
   '11111111-1111-1111-1111-111111111112'::uuid,
   'Artemether/Lumefantrine 20/120'::text,
   'AL-240'::text,
   5, 32.5, 0,
   '2027-01-10'::date,
   15,
   'AL-2401'::text,
   true),
  ('a1000000-0000-0000-0000-000000000002'::uuid,
   '11111111-1111-1111-1111-111111111112'::uuid,
   'Insulin Glargine 100IU/mL'::text,
   'INS-100'::text,
   0, 210, 0,
   '2027-01-10'::date,
   10,
   'INS-88'::text,
   true),
  ('a1000000-0000-0000-0000-000000000003'::uuid,
   '11111111-1111-1111-1111-111111111112'::uuid,
   'ORS Sachets (children''s)'::text,
   'ORS-CH'::text,
   -3, 4.5, 0,
   '2027-08-01'::date,
   20,
   NULL,
   true),
  ('a1000000-0000-0000-0000-000000000004'::uuid,
   '11111111-1111-1111-1111-111111111112'::uuid,
   'Tetracycline 250mg'::text,
   'TET-250'::text,
   4, 8, 0,
   '2026-02-20'::date,
   2,
   'TET-11'::text,
   true),
  ('a1000000-0000-0000-0000-000000000005'::uuid,
   '11111111-1111-1111-1111-111111111112'::uuid,
   'Oxytocin 10IU/mL'::text,
   'OXY-10'::text,
   30, 45, 0,
   '2026-04-15'::date,
   10,
   'OXY-3'::text,
   true),
  ('a1000000-0000-0000-0000-000000000006'::uuid,
   '11111111-1111-1111-1111-111111111112'::uuid,
   'Adrenaline 1mg/mL'::text,
   'ADR-1'::text,
   3, 15.75, 0,
   '2026-05-20'::date,
   10,
   'ADR-7'::text,
   true),
  ('a1000000-0000-0000-0000-000000000007'::uuid,
   '11111111-1111-1111-1111-111111111112'::uuid,
   'Paracetamol 500mg'::text,
   'PAR-500'::text,
   100, 9, 0,
   '2027-06-01'::date,
   10,
   'PAR-500'::text,
   true),
  ('a1000000-0000-0000-0000-000000000008'::uuid,
   '11111111-1111-1111-1111-111111111112'::uuid,
   'Withdrawn Product'::text,
   'OLD-1'::text,
   0, 6, 0,
   '2026-01-01'::date,
   10,
   'OLD-1'::text,
   false);


-- ---------------------------------------------------------------------
-- Writing them
-- ---------------------------------------------------------------------
-- One statement for the whole shelf, which is what the first refresh after the
-- migration looks like: every product already below its reorder level at once.
--
-- These two assertions are the reason the file exists. ON CONFLICT against a
-- partial index has to name the index predicate verbatim, and getting it wrong
-- is not a wrong answer but an error — raised on somebody's sale. If the first
-- of these runs at all, the inference matched.
--
-- What the classifier derived from that shelf:
--   low_stock:a1000000-0000-0000-0000-000000000001  (Low stock)
--   out_of_stock:a1000000-0000-0000-0000-000000000002  (Out of stock)
--   out_of_stock:a1000000-0000-0000-0000-000000000003  (Out of stock)
--   expired_stock:a1000000-0000-0000-0000-000000000004  (Expired stock)
--   expiring:a1000000-0000-0000-0000-000000000005  (Expiring soon)
--   low_stock:a1000000-0000-0000-0000-000000000006  (Low stock)
--   expiring:a1000000-0000-0000-0000-000000000006  (Expiring soon)

DO $$
DECLARE n INTEGER;
BEGIN

      INSERT INTO notifications
        (pharmacy_id, type, title, message, channel, status, dedupe_key, metadata)
      VALUES
        ('11111111-1111-1111-1111-111111111112'::uuid, 'in_app', 'Low stock'::text, 'Artemether/Lumefantrine 20/120 fell to 5 — its reorder level is 15.'::text, 'in_app', 'pending', 'low_stock:a1000000-0000-0000-0000-000000000001'::text, '{"inventory_id":"a1000000-0000-0000-0000-000000000001","product_name":"Artemether/Lumefantrine 20/120","quantity":5,"reorder_level":15,"batch_number":"AL-2401","expiry_date":"2027-01-10","days_to_expiry":315,"href":"/inventory"}'::jsonb::jsonb),
        ('11111111-1111-1111-1111-111111111112'::uuid, 'in_app', 'Out of stock'::text, 'Insulin Glargine 100IU/mL is out of stock. Its reorder level is 10.'::text, 'in_app', 'pending', 'out_of_stock:a1000000-0000-0000-0000-000000000002'::text, '{"inventory_id":"a1000000-0000-0000-0000-000000000002","product_name":"Insulin Glargine 100IU/mL","quantity":0,"reorder_level":10,"batch_number":"INS-88","expiry_date":"2027-01-10","days_to_expiry":315,"href":"/inventory"}'::jsonb::jsonb),
        ('11111111-1111-1111-1111-111111111112'::uuid, 'in_app', 'Out of stock'::text, 'ORS Sachets (children''s) is 3 unit(s) below zero — more was sold than was recorded as received. There is nothing to sell and the count needs a stock-take.'::text, 'in_app', 'pending', 'out_of_stock:a1000000-0000-0000-0000-000000000003'::text, '{"inventory_id":"a1000000-0000-0000-0000-000000000003","product_name":"ORS Sachets (children''s)","quantity":-3,"reorder_level":20,"batch_number":null,"expiry_date":"2027-08-01","days_to_expiry":518,"href":"/inventory"}'::jsonb::jsonb),
        ('11111111-1111-1111-1111-111111111112'::uuid, 'in_app', 'Expired stock'::text, 'Tetracycline 250mg has 4 unit(s) dated 2026-02-20, which has passed (lot TET-11). It cannot be sold — quarantine it and record a write-off.'::text, 'in_app', 'pending', 'expired_stock:a1000000-0000-0000-0000-000000000004'::text, '{"inventory_id":"a1000000-0000-0000-0000-000000000004","product_name":"Tetracycline 250mg","quantity":4,"reorder_level":2,"batch_number":"TET-11","expiry_date":"2026-02-20","days_to_expiry":-9,"href":"/inventory"}'::jsonb::jsonb),
        ('11111111-1111-1111-1111-111111111112'::uuid, 'in_app', 'Expiring soon'::text, 'Oxytocin 10IU/mL expires on 2026-04-15 (lot OXY-3), in 45 days. 30 unit(s) on hand.'::text, 'in_app', 'pending', 'expiring:a1000000-0000-0000-0000-000000000005'::text, '{"inventory_id":"a1000000-0000-0000-0000-000000000005","product_name":"Oxytocin 10IU/mL","quantity":30,"reorder_level":10,"batch_number":"OXY-3","expiry_date":"2026-04-15","days_to_expiry":45,"href":"/inventory"}'::jsonb::jsonb),
        ('11111111-1111-1111-1111-111111111112'::uuid, 'in_app', 'Low stock'::text, 'Adrenaline 1mg/mL fell to 3 — its reorder level is 10.'::text, 'in_app', 'pending', 'low_stock:a1000000-0000-0000-0000-000000000006'::text, '{"inventory_id":"a1000000-0000-0000-0000-000000000006","product_name":"Adrenaline 1mg/mL","quantity":3,"reorder_level":10,"batch_number":"ADR-7","expiry_date":"2026-05-20","days_to_expiry":80,"href":"/inventory"}'::jsonb::jsonb),
        ('11111111-1111-1111-1111-111111111112'::uuid, 'in_app', 'Expiring soon'::text, 'Adrenaline 1mg/mL expires on 2026-05-20 (lot ADR-7), in 80 days. 3 unit(s) on hand.'::text, 'in_app', 'pending', 'expiring:a1000000-0000-0000-0000-000000000006'::text, '{"inventory_id":"a1000000-0000-0000-0000-000000000006","product_name":"Adrenaline 1mg/mL","quantity":3,"reorder_level":10,"batch_number":"ADR-7","expiry_date":"2026-05-20","days_to_expiry":80,"href":"/inventory"}'::jsonb::jsonb)
      ON CONFLICT (pharmacy_id, dedupe_key)
        WHERE dedupe_key IS NOT NULL AND superseded_at IS NULL
      DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 7 THEN
    RAISE EXCEPTION 'the first refresh writes one notification per condition — expected 7 row(s) affected, got %', n;
  END IF;
  RAISE NOTICE 'PASS 5: the first refresh writes one notification per condition (%)', n;
END $$;


DO $$
DECLARE n INTEGER;
BEGIN

      INSERT INTO notifications
        (pharmacy_id, type, title, message, channel, status, dedupe_key, metadata)
      VALUES
        ('11111111-1111-1111-1111-111111111112'::uuid, 'in_app', 'Low stock'::text, 'Artemether/Lumefantrine 20/120 fell to 5 — its reorder level is 15.'::text, 'in_app', 'pending', 'low_stock:a1000000-0000-0000-0000-000000000001'::text, '{"inventory_id":"a1000000-0000-0000-0000-000000000001","product_name":"Artemether/Lumefantrine 20/120","quantity":5,"reorder_level":15,"batch_number":"AL-2401","expiry_date":"2027-01-10","days_to_expiry":315,"href":"/inventory"}'::jsonb::jsonb),
        ('11111111-1111-1111-1111-111111111112'::uuid, 'in_app', 'Out of stock'::text, 'Insulin Glargine 100IU/mL is out of stock. Its reorder level is 10.'::text, 'in_app', 'pending', 'out_of_stock:a1000000-0000-0000-0000-000000000002'::text, '{"inventory_id":"a1000000-0000-0000-0000-000000000002","product_name":"Insulin Glargine 100IU/mL","quantity":0,"reorder_level":10,"batch_number":"INS-88","expiry_date":"2027-01-10","days_to_expiry":315,"href":"/inventory"}'::jsonb::jsonb),
        ('11111111-1111-1111-1111-111111111112'::uuid, 'in_app', 'Out of stock'::text, 'ORS Sachets (children''s) is 3 unit(s) below zero — more was sold than was recorded as received. There is nothing to sell and the count needs a stock-take.'::text, 'in_app', 'pending', 'out_of_stock:a1000000-0000-0000-0000-000000000003'::text, '{"inventory_id":"a1000000-0000-0000-0000-000000000003","product_name":"ORS Sachets (children''s)","quantity":-3,"reorder_level":20,"batch_number":null,"expiry_date":"2027-08-01","days_to_expiry":518,"href":"/inventory"}'::jsonb::jsonb),
        ('11111111-1111-1111-1111-111111111112'::uuid, 'in_app', 'Expired stock'::text, 'Tetracycline 250mg has 4 unit(s) dated 2026-02-20, which has passed (lot TET-11). It cannot be sold — quarantine it and record a write-off.'::text, 'in_app', 'pending', 'expired_stock:a1000000-0000-0000-0000-000000000004'::text, '{"inventory_id":"a1000000-0000-0000-0000-000000000004","product_name":"Tetracycline 250mg","quantity":4,"reorder_level":2,"batch_number":"TET-11","expiry_date":"2026-02-20","days_to_expiry":-9,"href":"/inventory"}'::jsonb::jsonb),
        ('11111111-1111-1111-1111-111111111112'::uuid, 'in_app', 'Expiring soon'::text, 'Oxytocin 10IU/mL expires on 2026-04-15 (lot OXY-3), in 45 days. 30 unit(s) on hand.'::text, 'in_app', 'pending', 'expiring:a1000000-0000-0000-0000-000000000005'::text, '{"inventory_id":"a1000000-0000-0000-0000-000000000005","product_name":"Oxytocin 10IU/mL","quantity":30,"reorder_level":10,"batch_number":"OXY-3","expiry_date":"2026-04-15","days_to_expiry":45,"href":"/inventory"}'::jsonb::jsonb),
        ('11111111-1111-1111-1111-111111111112'::uuid, 'in_app', 'Low stock'::text, 'Adrenaline 1mg/mL fell to 3 — its reorder level is 10.'::text, 'in_app', 'pending', 'low_stock:a1000000-0000-0000-0000-000000000006'::text, '{"inventory_id":"a1000000-0000-0000-0000-000000000006","product_name":"Adrenaline 1mg/mL","quantity":3,"reorder_level":10,"batch_number":"ADR-7","expiry_date":"2026-05-20","days_to_expiry":80,"href":"/inventory"}'::jsonb::jsonb),
        ('11111111-1111-1111-1111-111111111112'::uuid, 'in_app', 'Expiring soon'::text, 'Adrenaline 1mg/mL expires on 2026-05-20 (lot ADR-7), in 80 days. 3 unit(s) on hand.'::text, 'in_app', 'pending', 'expiring:a1000000-0000-0000-0000-000000000006'::text, '{"inventory_id":"a1000000-0000-0000-0000-000000000006","product_name":"Adrenaline 1mg/mL","quantity":3,"reorder_level":10,"batch_number":"ADR-7","expiry_date":"2026-05-20","days_to_expiry":80,"href":"/inventory"}'::jsonb::jsonb)
      ON CONFLICT (pharmacy_id, dedupe_key)
        WHERE dedupe_key IS NOT NULL AND superseded_at IS NULL
      DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN
    RAISE EXCEPTION 'a second till raising the same alerts writes nothing instead of failing — expected 0 row(s) affected, got %', n;
  END IF;
  RAISE NOTICE 'PASS 6: a second till raising the same alerts writes nothing instead of failing (%)', n;
END $$;


-- ---------------------------------------------------------------------
-- Reading them back
-- ---------------------------------------------------------------------
-- Views rather than inline subqueries, so a failure names the read it was on.

-- Every live stock alert for the pharmacy, with no narrowing at all. This
-- is what the bell reads when it opens.
CREATE TEMP VIEW live_all AS

      SELECT id, dedupe_key, title, message, metadata, created_at, read_at
        FROM notifications
       WHERE pharmacy_id = '11111111-1111-1111-1111-111111111112'::uuid
         AND superseded_at IS NULL
         AND dedupe_key IS NOT NULL
         AND split_part(dedupe_key, ':', 1) = ANY(ARRAY['out_of_stock'::text, 'low_stock'::text, 'expired_stock'::text, 'expiring'::text]::text[]::text[])
         AND (cardinality(ARRAY[]::text[]::text[]) = 0 OR split_part(dedupe_key, ':', 2) = ANY(ARRAY[]::text[]::text[]));


-- Narrowed to one product, which is what a refresh after one sale reads.
CREATE TEMP VIEW live_one_product AS

      SELECT id, dedupe_key, title, message, metadata, created_at, read_at
        FROM notifications
       WHERE pharmacy_id = '11111111-1111-1111-1111-111111111112'::uuid
         AND superseded_at IS NULL
         AND dedupe_key IS NOT NULL
         AND split_part(dedupe_key, ':', 1) = ANY(ARRAY['out_of_stock'::text, 'low_stock'::text, 'expired_stock'::text, 'expiring'::text]::text[]::text[])
         AND (cardinality(ARRAY['a1000000-0000-0000-0000-000000000006'::text]::text[]::text[]) = 0 OR split_part(dedupe_key, ':', 2) = ANY(ARRAY['a1000000-0000-0000-0000-000000000006'::text]::text[]::text[]));


-- Narrowed to one kind. This is the scoping that keeps a stock refresh from
-- superseding a claim or appointment notification sharing the table.
CREATE TEMP VIEW live_expiring_only AS

      SELECT id, dedupe_key, title, message, metadata, created_at, read_at
        FROM notifications
       WHERE pharmacy_id = '11111111-1111-1111-1111-111111111112'::uuid
         AND superseded_at IS NULL
         AND dedupe_key IS NOT NULL
         AND split_part(dedupe_key, ':', 1) = ANY(ARRAY['expiring'::text]::text[]::text[])
         AND (cardinality(ARRAY[]::text[]::text[]) = 0 OR split_part(dedupe_key, ':', 2) = ANY(ARRAY[]::text[]::text[]));


-- The shelf itself. An empty scope has to mean every product, not none.
CREATE TEMP VIEW stock_all AS

      SELECT id, product_name, quantity, reorder_level, batch_number, is_active,
             to_char(expiry_date, 'YYYY-MM-DD') AS expiry_date
        FROM inventory
       WHERE pharmacy_id = '11111111-1111-1111-1111-111111111112'::uuid
         AND (cardinality(ARRAY[]::uuid[]::uuid[]) = 0 OR id = ANY(ARRAY[]::uuid[]::uuid[]));


-- The same read narrowed to two products.
CREATE TEMP VIEW stock_two AS

      SELECT id, product_name, quantity, reorder_level, batch_number, is_active,
             to_char(expiry_date, 'YYYY-MM-DD') AS expiry_date
        FROM inventory
       WHERE pharmacy_id = '11111111-1111-1111-1111-111111111112'::uuid
         AND (cardinality(ARRAY['a1000000-0000-0000-0000-000000000001'::uuid, 'a1000000-0000-0000-0000-000000000007'::uuid]::uuid[]::uuid[]) = 0 OR id = ANY(ARRAY['a1000000-0000-0000-0000-000000000001'::uuid, 'a1000000-0000-0000-0000-000000000007'::uuid]::uuid[]::uuid[]));


-- One alert's whole history, superseded rows included. Deliberately not filtered
-- on superseded_at: keeping the row is the point of superseding rather than
-- deleting, and a view that hid them could not show it.
CREATE TEMP VIEW history_of_low_stock AS
SELECT id, superseded_at, created_at
  FROM notifications
 WHERE pharmacy_id = '11111111-1111-1111-1111-111111111112'::uuid
   AND dedupe_key = 'low_stock:a1000000-0000-0000-0000-000000000001'::text;


-- ---------------------------------------------------------------------
-- Assertions
-- ---------------------------------------------------------------------

DO $$
DECLARE n INTEGER;
BEGIN
  SELECT COUNT(*)::int INTO n FROM live_all;
  IF n <> 7 THEN
    RAISE EXCEPTION 'live_all: all seven conditions are live — expected 7 row(s), got %', n;
  END IF;
  RAISE NOTICE 'PASS 7: all seven conditions are live (%)', n;
END $$;


DO $$
DECLARE n INTEGER;
BEGIN
  SELECT COUNT(*)::int INTO n FROM live_one_product;
  IF n <> 2 THEN
    RAISE EXCEPTION 'live_one_product: one product can carry a low-stock and an expiry alert at the same time — expected 2 row(s), got %', n;
  END IF;
  RAISE NOTICE 'PASS 8: one product can carry a low-stock and an expiry alert at the same time (%)', n;
END $$;


DO $$
DECLARE n INTEGER;
BEGIN
  SELECT COUNT(*)::int INTO n FROM live_expiring_only;
  IF n <> 2 THEN
    RAISE EXCEPTION 'live_expiring_only: and only the expiry kind is read back — expected 2 row(s), got %', n;
  END IF;
  RAISE NOTICE 'PASS 9: and only the expiry kind is read back (%)', n;
END $$;


DO $$
DECLARE v TEXT;
BEGIN
  SELECT (MAX(message) FILTER (WHERE dedupe_key = 'out_of_stock:a1000000-0000-0000-0000-000000000003'::text))::text INTO v FROM live_all;
  IF v IS DISTINCT FROM 'ORS Sachets (children''s) is 3 unit(s) below zero — more was sold than was recorded as received. There is nothing to sell and the count needs a stock-take.' THEN
    RAISE EXCEPTION 'live_all: a message with an apostrophe and an em-dash comes back as it was written — expected ORS Sachets (children''s) is 3 unit(s) below zero — more was sold than was recorded as received. There is nothing to sell and the count needs a stock-take., got %',
      COALESCE(v, 'NULL');
  END IF;
  RAISE NOTICE 'PASS 10: a message with an apostrophe and an em-dash comes back as it was written (%)', v;
END $$;


DO $$
DECLARE v TEXT;
BEGIN
  SELECT (MAX(metadata->>'product_name') FILTER (WHERE dedupe_key = 'out_of_stock:a1000000-0000-0000-0000-000000000003'::text))::text INTO v FROM live_all;
  IF v IS DISTINCT FROM 'ORS Sachets (children''s)' THEN
    RAISE EXCEPTION 'live_all: and the jsonb document round-trips the same apostrophe — expected ORS Sachets (children''s), got %',
      COALESCE(v, 'NULL');
  END IF;
  RAISE NOTICE 'PASS 11: and the jsonb document round-trips the same apostrophe (%)', v;
END $$;


DO $$
DECLARE v NUMERIC;
BEGIN
  SELECT (MAX((metadata->>'days_to_expiry')::int) FILTER (WHERE dedupe_key = 'expiring:a1000000-0000-0000-0000-000000000005'::text))::numeric INTO v FROM live_all;
  IF v IS DISTINCT FROM 45 THEN
    RAISE EXCEPTION 'live_all: the metadata says how long there is, so the bell does not have to work it out — expected 45, got %',
      COALESCE(v::text, 'NULL');
  END IF;
  RAISE NOTICE 'PASS 12: the metadata says how long there is, so the bell does not have to work it out (%)', v;
END $$;


DO $$
DECLARE v NUMERIC;
BEGIN
  SELECT (COUNT(*) FILTER (WHERE split_part(dedupe_key, ':', 2) = 'a1000000-0000-0000-0000-000000000008'::text))::numeric INTO v FROM live_all;
  IF v IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'live_all: a retired product raises nothing — expected 0, got %',
      COALESCE(v::text, 'NULL');
  END IF;
  RAISE NOTICE 'PASS 13: a retired product raises nothing (%)', v;
END $$;


DO $$
DECLARE v NUMERIC;
BEGIN
  SELECT (COUNT(*) FILTER (WHERE split_part(dedupe_key, ':', 2) = 'a1000000-0000-0000-0000-000000000007'::text))::numeric INTO v FROM live_all;
  IF v IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'live_all: and neither does one that is stocked and far from its date — expected 0, got %',
      COALESCE(v::text, 'NULL');
  END IF;
  RAISE NOTICE 'PASS 14: and neither does one that is stocked and far from its date (%)', v;
END $$;


DO $$
DECLARE n INTEGER;
BEGIN
  SELECT COUNT(*)::int INTO n FROM stock_all;
  IF n <> 8 THEN
    RAISE EXCEPTION 'stock_all: the shelf read returns every product — expected 8 row(s), got %', n;
  END IF;
  RAISE NOTICE 'PASS 15: the shelf read returns every product (%)', n;
END $$;


DO $$
DECLARE n INTEGER;
BEGIN
  SELECT COUNT(*)::int INTO n FROM stock_two;
  IF n <> 2 THEN
    RAISE EXCEPTION 'stock_two: and narrows to the two it was asked for — expected 2 row(s), got %', n;
  END IF;
  RAISE NOTICE 'PASS 16: and narrows to the two it was asked for (%)', n;
END $$;


DO $$
DECLARE v NUMERIC;
BEGIN
  SELECT (SUM(quantity))::numeric INTO v FROM stock_two;
  IF v IS DISTINCT FROM 105 THEN
    RAISE EXCEPTION 'stock_two: with the quantities as they were inserted — expected 105, got %',
      COALESCE(v::text, 'NULL');
  END IF;
  RAISE NOTICE 'PASS 17: with the quantities as they were inserted (%)', v;
END $$;


DO $$
DECLARE v TEXT;
BEGIN
  SELECT (MAX(expiry_date))::text INTO v FROM stock_two;
  IF v IS DISTINCT FROM '2027-06-01' THEN
    RAISE EXCEPTION 'stock_two: and the expiry as the ISO text the classifier reads, not as a timestamp — expected 2027-06-01, got %',
      COALESCE(v, 'NULL');
  END IF;
  RAISE NOTICE 'PASS 18: and the expiry as the ISO text the classifier reads, not as a timestamp (%)', v;
END $$;


INSERT INTO notifications (pharmacy_id, type, title, message, channel, status, dedupe_key)
VALUES ('11111111-1111-1111-1111-111111111112'::uuid, 'in_app', 'Claim rejected',
        'NHIS claim 4471 was rejected: diagnosis code missing.', 'in_app', 'pending',
        'claim_rejected:a1000000-0000-0000-0000-000000000099'::text);


DO $$
DECLARE n INTEGER;
BEGIN
  SELECT COUNT(*)::int INTO n FROM live_all;
  IF n <> 7 THEN
    RAISE EXCEPTION 'live_all: a claim notification is not a stock alert, so the refresh cannot see or touch it — expected 7 row(s), got %', n;
  END IF;
  RAISE NOTICE 'PASS 19: a claim notification is not a stock alert, so the refresh cannot see or touch it (%)', n;
END $$;


DO $$
DECLARE n INTEGER;
BEGIN

      UPDATE notifications
         SET superseded_at = NOW()
       WHERE pharmacy_id = '11111111-1111-1111-1111-111111111112'::uuid
         AND superseded_at IS NULL
         AND id = ANY(ARRAY[(SELECT id FROM notifications
             WHERE pharmacy_id = '11111111-1111-1111-1111-111111111112'::uuid
               AND dedupe_key = 'low_stock:a1000000-0000-0000-0000-000000000001'::text
               AND superseded_at IS NULL)]::uuid[]::uuid[]);
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'when the stock arrives the live alert is superseded — expected 1 row(s) affected, got %', n;
  END IF;
  RAISE NOTICE 'PASS 20: when the stock arrives the live alert is superseded (%)', n;
END $$;


DO $$
DECLARE n INTEGER;
BEGIN
  SELECT COUNT(*)::int INTO n FROM live_all;
  IF n <> 6 THEN
    RAISE EXCEPTION 'live_all: and stops being read back as live — expected 6 row(s), got %', n;
  END IF;
  RAISE NOTICE 'PASS 21: and stops being read back as live (%)', n;
END $$;


DO $$
DECLARE n INTEGER;
BEGIN
  SELECT COUNT(*)::int INTO n FROM history_of_low_stock;
  IF n <> 1 THEN
    RAISE EXCEPTION 'history_of_low_stock: but the row is kept, so there is a record that it happened — expected 1 row(s), got %', n;
  END IF;
  RAISE NOTICE 'PASS 22: but the row is kept, so there is a record that it happened (%)', n;
END $$;


DO $$
DECLARE n INTEGER;
BEGIN

      UPDATE notifications
         SET superseded_at = NOW()
       WHERE pharmacy_id = '11111111-1111-1111-1111-111111111112'::uuid
         AND superseded_at IS NULL
         AND id = ANY(ARRAY[(SELECT id FROM notifications
             WHERE pharmacy_id = '11111111-1111-1111-1111-111111111112'::uuid
               AND dedupe_key = 'low_stock:a1000000-0000-0000-0000-000000000001'::text
               AND superseded_at IS NULL)]::uuid[]::uuid[]);
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN
    RAISE EXCEPTION 'and an alert already released is not released twice — expected 0 row(s) affected, got %', n;
  END IF;
  RAISE NOTICE 'PASS 23: and an alert already released is not released twice (%)', n;
END $$;


DO $$
DECLARE n INTEGER;
BEGIN

      INSERT INTO notifications
        (pharmacy_id, type, title, message, channel, status, dedupe_key, metadata)
      VALUES
        ('11111111-1111-1111-1111-111111111112'::uuid, 'in_app', 'Low stock'::text, 'Artemether/Lumefantrine 20/120 fell to 5 — its reorder level is 15.'::text, 'in_app', 'pending', 'low_stock:a1000000-0000-0000-0000-000000000001'::text, '{"inventory_id":"a1000000-0000-0000-0000-000000000001","product_name":"Artemether/Lumefantrine 20/120","quantity":5,"reorder_level":15,"batch_number":"AL-2401","expiry_date":"2027-01-10","days_to_expiry":315,"href":"/inventory"}'::jsonb::jsonb)
      ON CONFLICT (pharmacy_id, dedupe_key)
        WHERE dedupe_key IS NOT NULL AND superseded_at IS NULL
      DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'so when the product goes low again the pharmacist is told again — expected 1 row(s) affected, got %', n;
  END IF;
  RAISE NOTICE 'PASS 24: so when the product goes low again the pharmacist is told again (%)', n;
END $$;


DO $$
DECLARE n INTEGER;
BEGIN
  SELECT COUNT(*)::int INTO n FROM live_all;
  IF n <> 7 THEN
    RAISE EXCEPTION 'live_all: and the count is back to where it was — expected 7 row(s), got %', n;
  END IF;
  RAISE NOTICE 'PASS 25: and the count is back to where it was (%)', n;
END $$;


DO $$
DECLARE n INTEGER;
BEGIN
  SELECT COUNT(*)::int INTO n FROM history_of_low_stock;
  IF n <> 2 THEN
    RAISE EXCEPTION 'history_of_low_stock: with the cleared one still beside the new one, which is the record of how often it happens — expected 2 row(s), got %', n;
  END IF;
  RAISE NOTICE 'PASS 26: with the cleared one still beside the new one, which is the record of how often it happens (%)', n;
END $$;


DO $$
DECLARE n INTEGER;
BEGIN

      INSERT INTO notifications
        (pharmacy_id, type, title, message, channel, status, dedupe_key, metadata)
      VALUES
        ('11111111-1111-1111-1111-111111111113'::uuid, 'in_app', 'Low stock'::text, 'Artemether/Lumefantrine 20/120 fell to 5 — its reorder level is 15.'::text, 'in_app', 'pending', 'low_stock:a1000000-0000-0000-0000-000000000001'::text, '{"inventory_id":"a1000000-0000-0000-0000-000000000001","product_name":"Artemether/Lumefantrine 20/120","quantity":5,"reorder_level":15,"batch_number":"AL-2401","expiry_date":"2027-01-10","days_to_expiry":315,"href":"/inventory"}'::jsonb::jsonb)
      ON CONFLICT (pharmacy_id, dedupe_key)
        WHERE dedupe_key IS NOT NULL AND superseded_at IS NULL
      DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'the dedupe is per pharmacy, so a second branch can be low on the same thing — expected 1 row(s) affected, got %', n;
  END IF;
  RAISE NOTICE 'PASS 27: the dedupe is per pharmacy, so a second branch can be low on the same thing (%)', n;
END $$;


DO $$
DECLARE n INTEGER;
BEGIN
  SELECT COUNT(*)::int INTO n FROM live_all;
  IF n <> 7 THEN
    RAISE EXCEPTION 'live_all: and the sister branch reading its own alert leaves this one alone — expected 7 row(s), got %', n;
  END IF;
  RAISE NOTICE 'PASS 28: and the sister branch reading its own alert leaves this one alone (%)', n;
END $$;


-- ---------------------------------------------------------------------
-- Reading them back for the bell
-- ---------------------------------------------------------------------
-- notification-queries.ts. The filters here cannot fail loudly: an inverted
-- unread test is a bell that is always full or always empty, and a LIMIT that
-- did not apply is only a slow dropdown.

-- Every live stock alert, which is what the bell lists.
CREATE TEMP VIEW feed_stock AS

      SELECT id, type, title, message, metadata, dedupe_key,
             split_part(dedupe_key, ':', 1) AS dedupe_kind,
             status, created_at, read_at
        FROM notifications
       WHERE pharmacy_id = '11111111-1111-1111-1111-111111111112'::uuid
         AND superseded_at IS NULL
         AND (NOT 'false'::boolean::boolean OR read_at IS NULL)
         AND (cardinality(ARRAY['out_of_stock'::text, 'low_stock'::text, 'expired_stock'::text, 'expiring'::text]::text[]::text[]) = 0
         OR split_part(dedupe_key, ':', 1) = ANY(ARRAY['out_of_stock'::text, 'low_stock'::text, 'expired_stock'::text, 'expiring'::text]::text[]::text[]))
       ORDER BY created_at DESC, id DESC
       LIMIT 20;


-- No kind filter at all, so a notification this module does not own is
-- included rather than quietly dropped.
CREATE TEMP VIEW feed_everything AS

      SELECT id, type, title, message, metadata, dedupe_key,
             split_part(dedupe_key, ':', 1) AS dedupe_kind,
             status, created_at, read_at
        FROM notifications
       WHERE pharmacy_id = '11111111-1111-1111-1111-111111111112'::uuid
         AND superseded_at IS NULL
         AND (NOT 'false'::boolean::boolean OR read_at IS NULL)
         AND (cardinality(ARRAY[]::text[]::text[]) = 0
         OR split_part(dedupe_key, ':', 1) = ANY(ARRAY[]::text[]::text[]))
       ORDER BY created_at DESC, id DESC
       LIMIT 20;


-- Narrowed to one kind.
CREATE TEMP VIEW feed_low_stock AS

      SELECT id, type, title, message, metadata, dedupe_key,
             split_part(dedupe_key, ':', 1) AS dedupe_kind,
             status, created_at, read_at
        FROM notifications
       WHERE pharmacy_id = '11111111-1111-1111-1111-111111111112'::uuid
         AND superseded_at IS NULL
         AND (NOT 'false'::boolean::boolean OR read_at IS NULL)
         AND (cardinality(ARRAY['low_stock'::text]::text[]::text[]) = 0
         OR split_part(dedupe_key, ':', 1) = ANY(ARRAY['low_stock'::text]::text[]::text[]))
       ORDER BY created_at DESC, id DESC
       LIMIT 20;


-- Narrowed to another, which overlaps the first on one product.
CREATE TEMP VIEW feed_expiring AS

      SELECT id, type, title, message, metadata, dedupe_key,
             split_part(dedupe_key, ':', 1) AS dedupe_kind,
             status, created_at, read_at
        FROM notifications
       WHERE pharmacy_id = '11111111-1111-1111-1111-111111111112'::uuid
         AND superseded_at IS NULL
         AND (NOT 'false'::boolean::boolean OR read_at IS NULL)
         AND (cardinality(ARRAY['expiring'::text]::text[]::text[]) = 0
         OR split_part(dedupe_key, ':', 1) = ANY(ARRAY['expiring'::text]::text[]::text[]))
       ORDER BY created_at DESC, id DESC
       LIMIT 20;


-- Asked for a kind this module does not write. A reader hardcoded to the four
-- stock kinds would return nothing here and the claim feature would have to
-- duplicate the query.
CREATE TEMP VIEW feed_claim AS

      SELECT id, type, title, message, metadata, dedupe_key,
             split_part(dedupe_key, ':', 1) AS dedupe_kind,
             status, created_at, read_at
        FROM notifications
       WHERE pharmacy_id = '11111111-1111-1111-1111-111111111112'::uuid
         AND superseded_at IS NULL
         AND (NOT 'false'::boolean::boolean OR read_at IS NULL)
         AND (cardinality(ARRAY['claim_rejected'::text]::text[]::text[]) = 0
         OR split_part(dedupe_key, ':', 1) = ANY(ARRAY['claim_rejected'::text]::text[]::text[]))
       ORDER BY created_at DESC, id DESC
       LIMIT 20;


-- The same read with a limit smaller than the answer.
CREATE TEMP VIEW feed_limited AS

      SELECT id, type, title, message, metadata, dedupe_key,
             split_part(dedupe_key, ':', 1) AS dedupe_kind,
             status, created_at, read_at
        FROM notifications
       WHERE pharmacy_id = '11111111-1111-1111-1111-111111111112'::uuid
         AND superseded_at IS NULL
         AND (NOT 'false'::boolean::boolean OR read_at IS NULL)
         AND (cardinality(ARRAY['out_of_stock'::text, 'low_stock'::text, 'expired_stock'::text, 'expiring'::text]::text[]::text[]) = 0
         OR split_part(dedupe_key, ':', 1) = ANY(ARRAY['out_of_stock'::text, 'low_stock'::text, 'expired_stock'::text, 'expiring'::text]::text[]::text[]))
       ORDER BY created_at DESC, id DESC
       LIMIT 3;


-- Unread only. Read before and after the badge is cleared.
CREATE TEMP VIEW feed_unread_low AS

      SELECT id, type, title, message, metadata, dedupe_key,
             split_part(dedupe_key, ':', 1) AS dedupe_kind,
             status, created_at, read_at
        FROM notifications
       WHERE pharmacy_id = '11111111-1111-1111-1111-111111111112'::uuid
         AND superseded_at IS NULL
         AND (NOT 'true'::boolean::boolean OR read_at IS NULL)
         AND (cardinality(ARRAY['low_stock'::text]::text[]::text[]) = 0
         OR split_part(dedupe_key, ':', 1) = ANY(ARRAY['low_stock'::text]::text[]::text[]))
       ORDER BY created_at DESC, id DESC
       LIMIT 20;


-- The badge in its own query, because the list above is limited and the
-- badge must not be.
CREATE TEMP VIEW counts_all AS

      SELECT COUNT(*)::int AS live,
             COUNT(*) FILTER (WHERE read_at IS NULL)::int AS unread
        FROM notifications
       WHERE pharmacy_id = '11111111-1111-1111-1111-111111111112'::uuid
         AND superseded_at IS NULL
         AND (cardinality(ARRAY[]::text[]::text[]) = 0
         OR split_part(dedupe_key, ':', 1) = ANY(ARRAY[]::text[]::text[]));


DO $$
DECLARE n INTEGER;
BEGIN
  SELECT COUNT(*)::int INTO n FROM feed_stock;
  IF n <> 7 THEN
    RAISE EXCEPTION 'feed_stock: the bell reads back exactly the alerts the writer wrote — expected 7 row(s), got %', n;
  END IF;
  RAISE NOTICE 'PASS 29: the bell reads back exactly the alerts the writer wrote (%)', n;
END $$;


DO $$
DECLARE n INTEGER;
BEGIN
  SELECT COUNT(*)::int INTO n FROM feed_everything;
  IF n <> 8 THEN
    RAISE EXCEPTION 'feed_everything: and with no kind filter another feature''s live notification is included — expected 8 row(s), got %', n;
  END IF;
  RAISE NOTICE 'PASS 30: and with no kind filter another feature''s live notification is included (%)', n;
END $$;


DO $$
DECLARE n INTEGER;
BEGIN
  SELECT COUNT(*)::int INTO n FROM feed_low_stock;
  IF n <> 2 THEN
    RAISE EXCEPTION 'feed_low_stock: narrowing to one kind returns only it — expected 2 row(s), got %', n;
  END IF;
  RAISE NOTICE 'PASS 31: narrowing to one kind returns only it (%)', n;
END $$;


DO $$
DECLARE n INTEGER;
BEGIN
  SELECT COUNT(*)::int INTO n FROM feed_expiring;
  IF n <> 2 THEN
    RAISE EXCEPTION 'feed_expiring: and to another, which is a different set overlapping on one product — expected 2 row(s), got %', n;
  END IF;
  RAISE NOTICE 'PASS 32: and to another, which is a different set overlapping on one product (%)', n;
END $$;


DO $$
DECLARE n INTEGER;
BEGIN
  SELECT COUNT(*)::int INTO n FROM feed_claim;
  IF n <> 1 THEN
    RAISE EXCEPTION 'feed_claim: a kind this module does not own can still be asked for — expected 1 row(s), got %', n;
  END IF;
  RAISE NOTICE 'PASS 33: a kind this module does not own can still be asked for (%)', n;
END $$;


DO $$
DECLARE n INTEGER;
BEGIN
  SELECT COUNT(*)::int INTO n FROM feed_limited;
  IF n <> 3 THEN
    RAISE EXCEPTION 'feed_limited: the limit applies, so a long-neglected bell is not a slow one — expected 3 row(s), got %', n;
  END IF;
  RAISE NOTICE 'PASS 34: the limit applies, so a long-neglected bell is not a slow one (%)', n;
END $$;


DO $$
DECLARE v NUMERIC;
BEGIN
  SELECT (MAX(live))::numeric INTO v FROM counts_all;
  IF v IS DISTINCT FROM 8 THEN
    RAISE EXCEPTION 'counts_all: and the count ignores the limit, so the badge says eight while the list shows three — expected 8, got %',
      COALESCE(v::text, 'NULL');
  END IF;
  RAISE NOTICE 'PASS 35: and the count ignores the limit, so the badge says eight while the list shows three (%)', v;
END $$;


DO $$
DECLARE v NUMERIC;
BEGIN
  SELECT (MAX(unread))::numeric INTO v FROM counts_all;
  IF v IS DISTINCT FROM 8 THEN
    RAISE EXCEPTION 'counts_all: none of them having been opened yet — expected 8, got %',
      COALESCE(v::text, 'NULL');
  END IF;
  RAISE NOTICE 'PASS 36: none of them having been opened yet (%)', v;
END $$;


DO $$
DECLARE n INTEGER;
BEGIN
  SELECT COUNT(*)::int INTO n FROM feed_unread_low;
  IF n <> 2 THEN
    RAISE EXCEPTION 'feed_unread_low: and an unread-only read of one kind returns that kind until it is cleared — expected 2 row(s), got %', n;
  END IF;
  RAISE NOTICE 'PASS 37: and an unread-only read of one kind returns that kind until it is cleared (%)', n;
END $$;


DO $$
DECLARE v TEXT;
BEGIN
  SELECT (MAX(dedupe_kind) FILTER (WHERE dedupe_key = 'low_stock:a1000000-0000-0000-0000-000000000001'::text))::text INTO v FROM feed_stock;
  IF v IS DISTINCT FROM 'low_stock' THEN
    RAISE EXCEPTION 'feed_stock: the kind is derived in SQL, so the writer''s key and the reader''s label cannot disagree — expected low_stock, got %',
      COALESCE(v, 'NULL');
  END IF;
  RAISE NOTICE 'PASS 38: the kind is derived in SQL, so the writer''s key and the reader''s label cannot disagree (%)', v;
END $$;


DO $$
DECLARE n INTEGER;
BEGIN

      UPDATE notifications
         SET read_at = NOW()
       WHERE pharmacy_id = '11111111-1111-1111-1111-111111111112'::uuid
         AND superseded_at IS NULL
         AND read_at IS NULL
         AND (cardinality(ARRAY[]::uuid[]::uuid[]) = 0 OR id = ANY(ARRAY[]::uuid[]::uuid[]))
         AND (cardinality(ARRAY['low_stock'::text]::text[]::text[]) = 0
         OR split_part(dedupe_key, ':', 1) = ANY(ARRAY['low_stock'::text]::text[]::text[]));
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 2 THEN
    RAISE EXCEPTION 'clearing one kind stamps only that kind — expected 2 row(s) affected, got %', n;
  END IF;
  RAISE NOTICE 'PASS 39: clearing one kind stamps only that kind (%)', n;
END $$;


DO $$
DECLARE v NUMERIC;
BEGIN
  SELECT (MAX(unread))::numeric INTO v FROM counts_all;
  IF v IS DISTINCT FROM 6 THEN
    RAISE EXCEPTION 'counts_all: and the unread count falls by the same number — expected 6, got %',
      COALESCE(v::text, 'NULL');
  END IF;
  RAISE NOTICE 'PASS 40: and the unread count falls by the same number (%)', v;
END $$;


DO $$
DECLARE n INTEGER;
BEGIN
  SELECT COUNT(*)::int INTO n FROM feed_unread_low;
  IF n <> 0 THEN
    RAISE EXCEPTION 'feed_unread_low: so an unread-only read of that kind is now empty — expected 0 row(s), got %', n;
  END IF;
  RAISE NOTICE 'PASS 41: so an unread-only read of that kind is now empty (%)', n;
END $$;


DO $$
DECLARE n INTEGER;
BEGIN

      UPDATE notifications
         SET read_at = NOW()
       WHERE pharmacy_id = '11111111-1111-1111-1111-111111111112'::uuid
         AND superseded_at IS NULL
         AND read_at IS NULL
         AND (cardinality(ARRAY[]::uuid[]::uuid[]) = 0 OR id = ANY(ARRAY[]::uuid[]::uuid[]))
         AND (cardinality(ARRAY['low_stock'::text]::text[]::text[]) = 0
         OR split_part(dedupe_key, ':', 1) = ANY(ARRAY['low_stock'::text]::text[]::text[]));
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN
    RAISE EXCEPTION 'already-read alerts are not stamped again, so read_at stays the moment it was first seen — expected 0 row(s) affected, got %', n;
  END IF;
  RAISE NOTICE 'PASS 42: already-read alerts are not stamped again, so read_at stays the moment it was first seen (%)', n;
END $$;


DO $$
DECLARE n INTEGER;
BEGIN

      UPDATE notifications
         SET read_at = NOW()
       WHERE pharmacy_id = '11111111-1111-1111-1111-111111111112'::uuid
         AND superseded_at IS NULL
         AND read_at IS NULL
         AND (cardinality(ARRAY[(SELECT id FROM notifications
             WHERE pharmacy_id = '11111111-1111-1111-1111-111111111112'::uuid
               AND dedupe_key = 'out_of_stock:a1000000-0000-0000-0000-000000000002'::text
               AND superseded_at IS NULL)]::uuid[]::uuid[]) = 0 OR id = ANY(ARRAY[(SELECT id FROM notifications
             WHERE pharmacy_id = '11111111-1111-1111-1111-111111111112'::uuid
               AND dedupe_key = 'out_of_stock:a1000000-0000-0000-0000-000000000002'::text
               AND superseded_at IS NULL)]::uuid[]::uuid[]))
         AND (cardinality(ARRAY[]::text[]::text[]) = 0
         OR split_part(dedupe_key, ':', 1) = ANY(ARRAY[]::text[]::text[]));
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'and a single alert can be cleared on its own, which is what clicking it does — expected 1 row(s) affected, got %', n;
  END IF;
  RAISE NOTICE 'PASS 43: and a single alert can be cleared on its own, which is what clicking it does (%)', n;
END $$;


DO $$
DECLARE v NUMERIC;
BEGIN
  SELECT (MAX(unread))::numeric INTO v FROM counts_all;
  IF v IS DISTINCT FROM 5 THEN
    RAISE EXCEPTION 'counts_all: taking the unread count down with it — expected 5, got %',
      COALESCE(v::text, 'NULL');
  END IF;
  RAISE NOTICE 'PASS 44: taking the unread count down with it (%)', v;
END $$;


DO $$
DECLARE n INTEGER;
BEGIN
  SELECT COUNT(*)::int INTO n FROM feed_stock;
  IF n <> 7 THEN
    RAISE EXCEPTION 'feed_stock: but clearing an alert does not remove it — it is live until the stock arrives — expected 7 row(s), got %', n;
  END IF;
  RAISE NOTICE 'PASS 45: but clearing an alert does not remove it — it is live until the stock arrives (%)', n;
END $$;


ROLLBACK;

SELECT 'all stock-alert assertions passed' AS result;
