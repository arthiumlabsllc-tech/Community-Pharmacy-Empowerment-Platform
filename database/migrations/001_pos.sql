-- =====================================================================
-- Migration 001: Point of Sale, payments and Ghana VAT (Act 1151)
-- =====================================================================
-- Safe to re-run: every statement is guarded with IF NOT EXISTS / DO blocks.
--
-- Apply with:
--   psql "$DATABASE_URL" -f database/migrations/001_pos.sql
-- or paste into the Supabase SQL editor.
-- =====================================================================

-- ============ ENUMS ============
DO $$ BEGIN
  CREATE TYPE sale_status AS ENUM ('pending', 'completed', 'voided', 'refunded', 'partially_refunded');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE sale_payment_method AS ENUM ('cash', 'momo', 'card', 'bank_transfer', 'nhis', 'credit');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE sale_payment_status AS ENUM ('pending', 'authorised', 'completed', 'failed', 'refunded');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Ghana VAT treatment per the Value Added Tax Act, 2025 (Act 1151):
--   standard   -> 15% VAT + 2.5% NHIL + 2.5% GETFund levy, all on the same base
--   exempt     -> First Schedule supplies; no VAT, NHIL or GETFund levy is charged
--   zero_rated -> Second Schedule supplies; taxable at 0%, input tax stays creditable
DO $$ BEGIN
  CREATE TYPE vat_treatment AS ENUM ('standard', 'exempt', 'zero_rated');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============ INVENTORY: TAX + SELLING UNIT ============
-- Existing stock is assumed exempt because a pharmacy's inventory is
-- predominantly HS Chapter 30 pharmaceuticals, which Act 1151 exempts.
-- Non-drug lines (toiletries, cosmetics, devices) must be reclassified to
-- 'standard' in the inventory form or they will be sold without VAT.
ALTER TABLE inventory
  ADD COLUMN IF NOT EXISTS vat_treatment vat_treatment NOT NULL DEFAULT 'exempt';

-- Selling unit support: a strip of 10 paracetamol tablets is one inventory
-- record but can be sold per tablet or per strip.
ALTER TABLE inventory
  ADD COLUMN IF NOT EXISTS pack_size INTEGER NOT NULL DEFAULT 1;
ALTER TABLE inventory
  ADD COLUMN IF NOT EXISTS default_sell_unit VARCHAR(20) NOT NULL DEFAULT 'pack';

-- ============ SALES ============
CREATE TABLE IF NOT EXISTS sales (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  pharmacy_id UUID NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,

  -- Human-readable receipt number, unique per pharmacy
  receipt_number VARCHAR(50) NOT NULL,

  -- A sale may be a walk-in with no patient record at all
  patient_id UUID REFERENCES patients(id) ON DELETE SET NULL,
  customer_name VARCHAR(200),
  customer_phone VARCHAR(20),

  served_by UUID NOT NULL REFERENCES users(id),
  -- Pharmacist sign-off, required when the basket contains prescription items
  approved_by UUID REFERENCES users(id),

  -- Money. All tax figures are computed server-side and stored for audit.
  subtotal DECIMAL(12,2) NOT NULL DEFAULT 0,
  discount_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
  discount_reason VARCHAR(255),
  taxable_base DECIMAL(12,2) NOT NULL DEFAULT 0,
  exempt_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
  vat_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
  nhil_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
  getfund_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
  total_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
  amount_paid DECIMAL(12,2) NOT NULL DEFAULT 0,
  change_due DECIMAL(12,2) NOT NULL DEFAULT 0,
  currency VARCHAR(3) NOT NULL DEFAULT 'GHS',

  -- 'inclusive' = stored unit prices already contain the 20%; the POS backs
  -- the tax out. 'exclusive' = tax is added on top. Ghanaian retail shelf
  -- prices are tax-inclusive, so that is the default.
  pricing_mode VARCHAR(10) NOT NULL DEFAULT 'inclusive',
  -- Snapshot of the rates actually applied, so an old receipt still reads
  -- correctly if the law changes again.
  tax_rates JSONB NOT NULL DEFAULT '{}',

  status sale_status NOT NULL DEFAULT 'pending',
  note TEXT,

  prescription_id UUID REFERENCES prescriptions(id) ON DELETE SET NULL,
  nhis_claim_id UUID REFERENCES nhis_claims(id) ON DELETE SET NULL,

  -- Offline-first: the client generates this before it knows whether the
  -- network is up, which makes a replayed sync a no-op instead of a duplicate.
  client_sale_id UUID,

  completed_at TIMESTAMPTZ,
  voided_at TIMESTAMPTZ,
  void_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_sales_receipt UNIQUE (pharmacy_id, receipt_number),
  CONSTRAINT uq_sales_client_id UNIQUE (pharmacy_id, client_sale_id),
  CONSTRAINT chk_sales_totals CHECK (total_amount >= 0 AND amount_paid >= 0)
);

CREATE INDEX IF NOT EXISTS idx_sales_pharmacy ON sales(pharmacy_id);
CREATE INDEX IF NOT EXISTS idx_sales_created ON sales(pharmacy_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sales_status ON sales(pharmacy_id, status);
CREATE INDEX IF NOT EXISTS idx_sales_patient ON sales(patient_id);
CREATE INDEX IF NOT EXISTS idx_sales_served_by ON sales(served_by);
CREATE INDEX IF NOT EXISTS idx_sales_completed ON sales(pharmacy_id, completed_at DESC)
  WHERE status = 'completed';

-- ============ SALE ITEMS ============
CREATE TABLE IF NOT EXISTS sale_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  sale_id UUID NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  inventory_id UUID REFERENCES inventory(id) ON DELETE SET NULL,

  -- Snapshots: the product can be renamed, repriced or deleted later and the
  -- receipt must still say exactly what was sold.
  product_name VARCHAR(255) NOT NULL,
  product_code VARCHAR(100),
  generic_name VARCHAR(255),
  batch_number VARCHAR(100),
  expiry_date DATE,
  requires_prescription BOOLEAN NOT NULL DEFAULT false,

  quantity INTEGER NOT NULL CHECK (quantity > 0),
  sell_unit VARCHAR(20) NOT NULL DEFAULT 'pack',
  unit_price DECIMAL(10,2) NOT NULL,
  discount_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
  line_total DECIMAL(12,2) NOT NULL,

  vat_treatment vat_treatment NOT NULL DEFAULT 'exempt',
  taxable_base DECIMAL(12,2) NOT NULL DEFAULT 0,
  vat_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
  nhil_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
  getfund_amount DECIMAL(10,2) NOT NULL DEFAULT 0,

  -- Cost at the moment of sale, so product profitability can be reported
  -- without depending on today's cost_price.
  unit_cost DECIMAL(10,2) NOT NULL DEFAULT 0,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id);
CREATE INDEX IF NOT EXISTS idx_sale_items_inventory ON sale_items(inventory_id);
CREATE INDEX IF NOT EXISTS idx_sale_items_product ON sale_items(product_name);

-- ============ SALE PAYMENTS (split payments) ============
CREATE TABLE IF NOT EXISTS sale_payments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  sale_id UUID NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  pharmacy_id UUID NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,

  method sale_payment_method NOT NULL,
  amount DECIMAL(12,2) NOT NULL CHECK (amount > 0),
  status sale_payment_status NOT NULL DEFAULT 'completed',

  -- MoMo / card details
  momo_network VARCHAR(20),
  momo_number VARCHAR(20),
  reference VARCHAR(100),
  gateway VARCHAR(30),
  gateway_response JSONB NOT NULL DEFAULT '{}',

  received_by UUID REFERENCES users(id),
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sale_payments_sale ON sale_payments(sale_id);
CREATE INDEX IF NOT EXISTS idx_sale_payments_pharmacy ON sale_payments(pharmacy_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sale_payments_method ON sale_payments(pharmacy_id, method);
CREATE INDEX IF NOT EXISTS idx_sale_payments_reference ON sale_payments(reference);

-- ============ updated_at TRIGGER ============
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  CREATE TRIGGER trg_sales_updated_at BEFORE UPDATE ON sales
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
