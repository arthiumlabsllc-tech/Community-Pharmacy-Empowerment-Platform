-- =====================================================================
-- Migration 003: batch-level inventory, FEFO and stock traceability
-- =====================================================================
-- Safe to re-run: tables and indexes are guarded with IF NOT EXISTS, the
-- backfill skips products that already have a batch, and the functions are
-- CREATE OR REPLACE.
--
-- Apply with:
--   npm run db:migrate
-- or paste into the Supabase SQL editor.
--
-- ---------------------------------------------------------------------
-- What was wrong
-- ---------------------------------------------------------------------
-- `inventory` held one batch_number, one expiry_date, one quantity and one
-- cost_price per product, with UNIQUE(pharmacy_id, product_code). A pharmacy
-- holding two deliveries of the same medicine therefore had to invent a second
-- product code for the second batch, and everything downstream paid for it:
--
--   * Reorder level is per row, so the same product either raised two alerts
--     or none, depending how the stock happened to be split.
--   * The till showed "Amoxicillin 500mg" twice and the cashier had to know
--     which one to pick — the opposite of First-Expiry-First-Out, which needs
--     the shortest-dated stock to go first without anybody thinking about it.
--   * Profitability was split across two rows for one product.
--   * A recall could not be answered. "Which customers got batch B/4471?" is
--     the question the Pharmacy Council asks, and a product row that has been
--     overwritten by the next delivery cannot answer it.
--
-- ---------------------------------------------------------------------
-- What this does
-- ---------------------------------------------------------------------
-- `inventory_batches` becomes the record of what is physically on the shelf:
-- one row per delivery, carrying its own batch number, expiry, quantity and
-- cost. `inventory` remains the product: name, code, category, price, VAT
-- treatment, pack size and reorder level.
--
-- The four columns on `inventory` that describe stock (quantity, batch_number,
-- expiry_date, cost_price) are NOT dropped, because thirty-odd queries, the
-- offline catalogue and every report read them. Instead they become derived:
-- a BEFORE trigger recomputes them from the batches on every write to either
-- table, so there is exactly one writer and no way for the two to disagree.
--
-- A product with no batches at all is left exactly as it was written. That is
-- what makes this migration backwards-compatible: until an opening batch
-- exists, `inventory` behaves as it always did.
-- =====================================================================

-- ============ BATCHES ============
CREATE TABLE IF NOT EXISTS inventory_batches (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  pharmacy_id UUID NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
  inventory_id UUID NOT NULL REFERENCES inventory(id) ON DELETE CASCADE,

  -- The lot number printed on the pack. Required, because it is the handle a
  -- recall works from: without it a batch is just a quantity and cannot be
  -- traced back to a supplier or forward to a patient.
  batch_number VARCHAR(100) NOT NULL,
  expiry_date DATE NOT NULL,

  -- Deliberately no CHECK (quantity >= 0). A sale recorded during an outage
  -- is exempt from the stock guard for the same reason it always was: the
  -- goods have physically left the shelf, possibly from a second till that
  -- was also disconnected. Refusing to record it loses a real sale, so the
  -- count is allowed to go negative and the shortfall is reported for a
  -- stock-take. A negative here is the honest statement, not an error.
  quantity INTEGER NOT NULL DEFAULT 0,

  -- What this delivery cost. It varies batch to batch and it is the figure a
  -- stock valuation and a margin mean anything against.
  cost_price DECIMAL(10,2) NOT NULL DEFAULT 0,

  -- There is deliberately no unit_price here. A pharmacy has one shelf price
  -- per product; letting a delivery reprice it would mean the same box costs
  -- a different amount depending on which batch the allocator happened to
  -- pick, and a receipt nobody can explain.
  supplier_id UUID REFERENCES suppliers(id) ON DELETE SET NULL,
  invoice_number VARCHAR(100),

  -- When the goods arrived, which can be backdated for a delivery entered
  -- late. Distinct from created_at, which is when this row was written, and
  -- the tie-break FEFO uses when two batches expire on the same day.
  received_at DATE NOT NULL DEFAULT CURRENT_DATE,
  received_by UUID REFERENCES users(id) ON DELETE SET NULL,

  -- True for the rows this migration created from the old single-batch
  -- columns. They are an opening balance, not a recorded delivery, and the
  -- UI says so rather than implying somebody received stock they did not.
  is_backfill BOOLEAN NOT NULL DEFAULT false,

  -- False once the batch is finished, quarantined or written off. Kept rather
  -- than deleted: a batch that was sold must stay queryable for a recall.
  is_active BOOLEAN NOT NULL DEFAULT true,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- One lot number per product. Re-receiving the same lot tops it up rather
  -- than creating a second row that looks like a separate delivery.
  UNIQUE (inventory_id, batch_number)
);

-- FEFO reads: the batches of one product that still have stock, shortest date
-- first. This is the query the till runs on every sale.
CREATE INDEX IF NOT EXISTS idx_inventory_batches_fefo
  ON inventory_batches (inventory_id, expiry_date, received_at)
  WHERE quantity > 0 AND is_active;

CREATE INDEX IF NOT EXISTS idx_inventory_batches_pharmacy
  ON inventory_batches (pharmacy_id);

-- Recall: every batch of a product across the whole pharmacy, and every
-- batch expiring in a window regardless of product.
CREATE INDEX IF NOT EXISTS idx_inventory_batches_expiry
  ON inventory_batches (pharmacy_id, expiry_date);
CREATE INDEX IF NOT EXISTS idx_inventory_batches_number
  ON inventory_batches (pharmacy_id, batch_number);

-- ============ BACKFILL ============
-- One opening batch per existing product row, carrying the figures that were
-- previously the only ones available. Skips any product that already has a
-- batch, so re-running this migration does not duplicate stock.
INSERT INTO inventory_batches (
  pharmacy_id, inventory_id, batch_number, expiry_date, quantity, cost_price,
  received_at, is_backfill
)
SELECT
  i.pharmacy_id,
  i.id,
  -- A row with no lot number still needs one to be a batch. 'OPENING' says
  -- plainly that this is a migrated balance rather than a traced delivery.
  COALESCE(NULLIF(TRIM(i.batch_number), ''), 'OPENING'),
  i.expiry_date,
  i.quantity,
  i.cost_price,
  CURRENT_DATE,
  true
FROM inventory i
WHERE NOT EXISTS (
  SELECT 1 FROM inventory_batches b WHERE b.inventory_id = i.id
);

-- ============ DERIVED STOCK ON inventory ============
CREATE OR REPLACE FUNCTION inventory_stock_from_batches() RETURNS TRIGGER AS $$
DECLARE
  v_batch_count INTEGER;
  v_quantity    INTEGER;
  v_batch       VARCHAR(100);
  v_expiry      DATE;
  v_cost        DECIMAL(10,2);
BEGIN
  SELECT COUNT(*)::int, COALESCE(SUM(quantity), 0)::int
    INTO v_batch_count, v_quantity
    FROM inventory_batches
   WHERE inventory_id = NEW.id;

  -- Nothing to derive from yet. A product being created takes its opening
  -- batch in the same transaction, and until that lands there is no batch
  -- truth to overwrite what the caller wrote. This is also what keeps the
  -- migration safe for any write path that has not been converted yet.
  IF v_batch_count = 0 THEN
    RETURN NEW;
  END IF;

  -- The batch that will be sold next: shortest expiry among those with stock,
  -- oldest delivery first when two share a date. Batches with nothing left are
  -- sorted last rather than excluded, so expiry_date stays NOT NULL and still
  -- says something true about the product when it has sold out.
  SELECT batch_number, expiry_date
    INTO v_batch, v_expiry
    FROM inventory_batches
   WHERE inventory_id = NEW.id
   ORDER BY (quantity <= 0) ASC, expiry_date ASC, received_at ASC
   LIMIT 1;

  -- Weighted average of what is actually on the shelf, because that is what a
  -- stock valuation means. Falling back to the newest batch's cost when
  -- nothing is left keeps a figure worth editing instead of zeroing it.
  SELECT COALESCE(SUM(quantity * cost_price) / NULLIF(SUM(quantity), 0), 0)::decimal(10,2)
    INTO v_cost
    FROM inventory_batches
   WHERE inventory_id = NEW.id AND quantity > 0;

  IF v_cost IS NULL OR v_cost = 0 THEN
    SELECT cost_price INTO v_cost
      FROM inventory_batches
     WHERE inventory_id = NEW.id
     ORDER BY received_at DESC, created_at DESC
     LIMIT 1;
  END IF;

  NEW.quantity     := v_quantity;
  NEW.batch_number := v_batch;
  NEW.expiry_date  := v_expiry;
  NEW.cost_price   := COALESCE(v_cost, 0);

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_inventory_stock_from_batches ON inventory;
CREATE TRIGGER trg_inventory_stock_from_batches
  BEFORE INSERT OR UPDATE ON inventory
  FOR EACH ROW EXECUTE FUNCTION inventory_stock_from_batches();

-- The other half: a batch change has to reach the product row, or the derived
-- columns would only refresh the next time somebody happened to edit the
-- product. Touching updated_at is enough, because the BEFORE trigger above
-- recomputes the stock columns on any write.
CREATE OR REPLACE FUNCTION inventory_batches_refresh_product() RETURNS TRIGGER AS $$
DECLARE
  v_inventory_id UUID;
BEGIN
  v_inventory_id := COALESCE(NEW.inventory_id, OLD.inventory_id);

  UPDATE inventory
     SET updated_at = NOW()
   WHERE id = v_inventory_id;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_inventory_batches_refresh_product ON inventory_batches;
CREATE TRIGGER trg_inventory_batches_refresh_product
  AFTER INSERT OR UPDATE OR DELETE ON inventory_batches
  FOR EACH ROW EXECUTE FUNCTION inventory_batches_refresh_product();

CREATE OR REPLACE FUNCTION inventory_batches_touch_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_inventory_batches_updated_at ON inventory_batches;
CREATE TRIGGER trg_inventory_batches_updated_at
  BEFORE UPDATE ON inventory_batches
  FOR EACH ROW EXECUTE FUNCTION inventory_batches_touch_updated_at();

-- ============ WHICH BATCHES A SALE TOOK ============
-- A receipt line stays one row: a customer buying ten Amoxicillin sees one
-- line and is charged one tax figure. But those ten may have come six from
-- one batch and four from the next, and a recall needs to know that.
--
-- This table is the authoritative record of what left the shelf. The
-- batch_number and expiry_date snapshotted on sale_items are the primary
-- batch — the earliest-expiring one — which is exact whenever a line is
-- covered by a single batch and is a summary whenever it is not.
CREATE TABLE IF NOT EXISTS sale_item_batches (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  sale_item_id UUID NOT NULL REFERENCES sale_items(id) ON DELETE CASCADE,
  pharmacy_id UUID NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,

  -- SET NULL rather than CASCADE: the batch row can be retired, but the fact
  -- that this sale took from it must survive, which is what the snapshots
  -- beside it are for.
  batch_id UUID REFERENCES inventory_batches(id) ON DELETE SET NULL,
  batch_number VARCHAR(100) NOT NULL,
  expiry_date DATE,
  inventory_id UUID REFERENCES inventory(id) ON DELETE SET NULL,

  -- Always positive. This is a fact about what the sale took, not a ledger of
  -- stock movements: a void does not change which batches the customer's ten
  -- units came from, it changes whether those units are back on the shelf, and
  -- that belongs in stock_movements with reason 'sale_void'.
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_cost DECIMAL(10,2) NOT NULL DEFAULT 0,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sale_item_batches_item ON sale_item_batches(sale_item_id);
-- The recall query: every sale that touched this batch.
CREATE INDEX IF NOT EXISTS idx_sale_item_batches_batch ON sale_item_batches(batch_id);
CREATE INDEX IF NOT EXISTS idx_sale_item_batches_pharmacy
  ON sale_item_batches(pharmacy_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sale_item_batches_number
  ON sale_item_batches(pharmacy_id, batch_number);

-- ============ STOCK MOVEMENT LEDGER ============
-- Every change to a batch, with a reason and a person attached. An adjustment
-- without one is the kind of silent edit that turns into a stock count nobody
-- can explain three months later, and it is the first thing a regulator asks
-- for.
CREATE TABLE IF NOT EXISTS stock_movements (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  pharmacy_id UUID NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
  inventory_id UUID NOT NULL REFERENCES inventory(id) ON DELETE CASCADE,
  batch_id UUID REFERENCES inventory_batches(id) ON DELETE SET NULL,

  -- Positive is stock arriving, negative is stock leaving.
  quantity_change INTEGER NOT NULL CHECK (quantity_change <> 0),
  quantity_after INTEGER NOT NULL,

  -- A plain string rather than an enum: the set of reasons a pharmacy gives
  -- grows, and adding an enum value is a migration where adding a reason is
  -- not. The CHECK keeps the ones that matter from being misspelled.
  reason VARCHAR(30) NOT NULL CHECK (reason IN (
    'receipt', 'opening_balance', 'sale', 'sale_void', 'adjustment',
    'expiry_writeoff', 'damage_writeoff', 'recall', 'transfer_in', 'transfer_out'
  )),

  -- Free text for the adjustment a reason cannot describe. Required by the
  -- API for 'adjustment' and the write-offs, where the reason alone is not
  -- an explanation.
  note TEXT,

  sale_id UUID REFERENCES sales(id) ON DELETE SET NULL,
  sale_item_id UUID REFERENCES sale_items(id) ON DELETE SET NULL,
  supplier_id UUID REFERENCES suppliers(id) ON DELETE SET NULL,

  -- Who did it. SET NULL keeps the movement when a staff member is removed,
  -- because the ledger is the point.
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,

  -- A sale queued offline arrives late, and the movement belongs to the
  -- moment the goods left, not the moment the sync ran.
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stock_movements_product
  ON stock_movements(pharmacy_id, inventory_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_movements_batch
  ON stock_movements(batch_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_movements_sale ON stock_movements(sale_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_reason
  ON stock_movements(pharmacy_id, reason, occurred_at DESC);

-- ============ A TRIGGER THAT MADE TWO TABLES UNUPDATABLE ============
-- init.sql attaches `set_updated_at` to a list it describes in its own comment
-- as "all tables with updated_at". Two of them — notifications and reminders —
-- have no such column, so `NEW.updated_at = NOW()` raises
--
--   ERROR: record "new" has no field "updated_at"
--
-- and EVERY update against those two tables fails. Nothing has hit it yet
-- because no code updates either of them, which is exactly why it survived. This
-- migration is the first to need to: superseding an alert is an UPDATE on
-- notifications, and the reminder worker that follows is an UPDATE on reminders.
--
-- Guarded rather than detaching the trigger from those two tables. Building the
-- row as jsonb on every update is not free, but it is a few microseconds against
-- a network round trip, and in exchange a table added to that list later
-- without the column degrades to doing nothing instead of becoming unupdatable.
CREATE OR REPLACE FUNCTION update_updated_at() RETURNS TRIGGER AS $$
BEGIN
  -- jsonb_exists rather than the `?` operator: the same function, but that
  -- character is a bind placeholder in enough drivers and editors that a
  -- migration meant to be pasted into one should not depend on it.
  IF jsonb_exists(to_jsonb(NEW), 'updated_at') THEN
    NEW.updated_at = NOW();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============ ALERTS THAT CAN BE DEDUPED ============
-- The notification bell used to re-derive its alerts from /inventory/low-stock
-- on every open. That is live, but it has no history and no idea what is new:
-- a product that has been below its reorder level for a month is reported as
-- an alert forever, so it stops being read.
--
-- A dedupe key lets the alert writer raise one live notification per product
-- per condition, and supersede it when the condition clears, so the next time
-- it happens the pharmacist is told again.
ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS dedupe_key VARCHAR(200);

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ;

-- One live alert per key. Superseding a row releases the key rather than
-- deleting the notification, so the history stays and a fresh alert can be
-- raised when the product goes low again.
CREATE UNIQUE INDEX IF NOT EXISTS uq_notifications_live_dedupe
  ON notifications (pharmacy_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL AND superseded_at IS NULL;

-- Unread-first ordering for the bell.
CREATE INDEX IF NOT EXISTS idx_notifications_unread
  ON notifications (pharmacy_id, created_at DESC)
  WHERE read_at IS NULL AND superseded_at IS NULL;
