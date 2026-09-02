-- Community Pharmacy Empowerment Platform
-- Database Schema for PostgreSQL 15+

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- ============ ENUMS ============
CREATE TYPE user_role AS ENUM ('super_admin', 'pharmacy_owner', 'pharmacist', 'staff');
CREATE TYPE subscription_tier AS ENUM ('free', 'premium', 'enterprise');
CREATE TYPE subscription_status AS ENUM ('active', 'trial', 'expired', 'cancelled', 'past_due');
CREATE TYPE claim_status AS ENUM ('draft', 'pending', 'submitted', 'approved', 'rejected', 'paid', 'resubmitted');
CREATE TYPE prescription_status AS ENUM ('pending', 'filled', 'partially_filled', 'cancelled', 'expired');
CREATE TYPE consultation_type AS ENUM ('in_person', 'video', 'chat', 'phone');
CREATE TYPE consultation_status AS ENUM ('scheduled', 'in_progress', 'completed', 'cancelled', 'no_show');
CREATE TYPE screening_type AS ENUM ('blood_pressure', 'blood_sugar', 'bmi', 'weight', 'temperature', 'heart_rate');
CREATE TYPE notification_type AS ENUM ('sms', 'email', 'whatsapp', 'in_app', 'push');
CREATE TYPE risk_level AS ENUM ('low', 'moderate', 'high', 'critical');
CREATE TYPE notification_status AS ENUM ('pending', 'sent', 'delivered', 'failed');
CREATE TYPE gender AS ENUM ('male', 'female', 'other');

-- Point of sale
CREATE TYPE sale_status AS ENUM ('pending', 'completed', 'voided', 'refunded', 'partially_refunded');
CREATE TYPE sale_payment_method AS ENUM ('cash', 'momo', 'card', 'bank_transfer', 'nhis', 'credit');
CREATE TYPE sale_payment_status AS ENUM ('pending', 'authorised', 'completed', 'failed', 'refunded');

-- Ghana VAT treatment under the Value Added Tax Act, 2025 (Act 1151):
--   standard   -> 15% VAT + 2.5% NHIL + 2.5% GETFund levy, all on the same base
--   exempt     -> First Schedule supplies; no VAT, NHIL or GETFund levy
--   zero_rated -> Second Schedule supplies; taxable at 0%
CREATE TYPE vat_treatment AS ENUM ('standard', 'exempt', 'zero_rated');

-- ============ PHARMACIES ============
CREATE TABLE pharmacies (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  license_number VARCHAR(100) UNIQUE NOT NULL,
  location VARCHAR(500),
  region VARCHAR(100),
  district VARCHAR(100),
  gps_address VARCHAR(100),
  phone VARCHAR(20) NOT NULL,
  email VARCHAR(255),
  owner_id UUID,
  subscription_tier subscription_tier DEFAULT 'free',
  logo_url TEXT,
  is_active BOOLEAN DEFAULT true,
  settings JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_pharmacies_license ON pharmacies(license_number);
CREATE INDEX idx_pharmacies_region ON pharmacies(region);
CREATE INDEX idx_pharmacies_active ON pharmacies(is_active);

-- ============ USERS ============
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  pharmacy_id UUID REFERENCES pharmacies(id) ON DELETE CASCADE,
  role user_role NOT NULL DEFAULT 'staff',
  first_name VARCHAR(100) NOT NULL,
  last_name VARCHAR(100) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  phone VARCHAR(20),
  password_hash VARCHAR(255) NOT NULL,
  avatar_url TEXT,
  is_active BOOLEAN DEFAULT true,
  last_login_at TIMESTAMPTZ,
  refresh_token TEXT,
  mfa_enabled BOOLEAN DEFAULT false,
  mfa_secret TEXT,
  preferred_language VARCHAR(10) DEFAULT 'en',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add foreign key to pharmacies table
ALTER TABLE pharmacies ADD CONSTRAINT fk_pharmacies_owner FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX idx_users_pharmacy ON users(pharmacy_id);
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_role ON users(role);
CREATE INDEX idx_users_active ON users(is_active);

-- ============ PATIENTS ============
CREATE TABLE patients (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  pharmacy_id UUID NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
  nhis_number VARCHAR(50),
  first_name VARCHAR(100) NOT NULL,
  last_name VARCHAR(100) NOT NULL,
  date_of_birth DATE,
  gender gender DEFAULT 'other',
  phone VARCHAR(20) NOT NULL,
  alternate_phone VARCHAR(20),
  address TEXT,
  region VARCHAR(100),
  district VARCHAR(100),
  emergency_contact_name VARCHAR(200),
  emergency_contact_phone VARCHAR(20),
  allergies TEXT[] DEFAULT '{}',
  chronic_conditions TEXT[] DEFAULT '{}',
  blood_type VARCHAR(5),
  notes TEXT,
  is_active BOOLEAN DEFAULT true,
  photo_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_patients_pharmacy ON patients(pharmacy_id);
CREATE INDEX idx_patients_nhis ON patients(nhis_number);
CREATE INDEX idx_patients_name ON patients(first_name, last_name);
CREATE INDEX idx_patients_phone ON patients(phone);
CREATE INDEX idx_patients_search ON patients USING gin(first_name gin_trgm_ops, last_name gin_trgm_ops);

-- ============ INVENTORY ============
CREATE TABLE inventory (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  pharmacy_id UUID NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
  product_name VARCHAR(255) NOT NULL,
  product_code VARCHAR(100) NOT NULL,
  generic_name VARCHAR(255),
  category VARCHAR(100),
  manufacturer VARCHAR(255),
  batch_number VARCHAR(100),
  quantity INTEGER NOT NULL DEFAULT 0,
  unit_price DECIMAL(10,2) NOT NULL DEFAULT 0,
  cost_price DECIMAL(10,2) NOT NULL DEFAULT 0,
  expiry_date DATE NOT NULL,
  reorder_level INTEGER NOT NULL DEFAULT 10,
  shelf_location VARCHAR(50),
  barcode VARCHAR(100),
  requires_prescription BOOLEAN DEFAULT false,
  -- Act 1151 exempts pharmaceuticals supplied in Ghana, confined to essential
  -- drugs in Chapter 30 of the 2022 Harmonised System. Toiletries, cosmetics
  -- and devices sold by the same pharmacy are standard-rated and must be
  -- classified as such.
  vat_treatment vat_treatment NOT NULL DEFAULT 'exempt',
  -- One inventory record can be a strip of 10 tablets sold per tablet or per strip.
  pack_size INTEGER NOT NULL DEFAULT 1,
  default_sell_unit VARCHAR(20) NOT NULL DEFAULT 'pack',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(pharmacy_id, product_code)
);

CREATE INDEX idx_inventory_pharmacy ON inventory(pharmacy_id);
CREATE INDEX idx_inventory_expiry ON inventory(expiry_date);
CREATE INDEX idx_inventory_category ON inventory(category);
CREATE INDEX idx_inventory_low_stock ON inventory(pharmacy_id) WHERE quantity <= reorder_level;

-- ============ SUPPLIERS ============
CREATE TABLE suppliers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  pharmacy_id UUID NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  contact_person VARCHAR(200),
  phone VARCHAR(20),
  email VARCHAR(255),
  address TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_suppliers_pharmacy ON suppliers(pharmacy_id);

-- ============ PRESCRIPTIONS ============
CREATE TABLE prescriptions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  pharmacy_id UUID NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
  patient_id UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  prescriber_name VARCHAR(200),
  prescriber_facility VARCHAR(200),
  medication_details JSONB NOT NULL DEFAULT '[]',
  diagnosis TEXT,
  notes TEXT,
  image_url TEXT,
  status prescription_status DEFAULT 'pending',
  issue_date DATE NOT NULL DEFAULT CURRENT_DATE,
  filled_date TIMESTAMPTZ,
  filled_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_prescriptions_pharmacy ON prescriptions(pharmacy_id);
CREATE INDEX idx_prescriptions_patient ON prescriptions(patient_id);
CREATE INDEX idx_prescriptions_status ON prescriptions(status);
CREATE INDEX idx_prescriptions_date ON prescriptions(issue_date);

-- ============ NHIS CLAIMS ============
CREATE TABLE nhis_claims (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  pharmacy_id UUID NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
  patient_id UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  prescription_id UUID REFERENCES prescriptions(id) ON DELETE SET NULL,
  claim_number VARCHAR(100),
  diagnosis_codes TEXT[] DEFAULT '{}',
  medication_details JSONB NOT NULL DEFAULT '[]',
  total_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
  nhis_approved_amount DECIMAL(10,2),
  patient_copay DECIMAL(10,2) DEFAULT 0,
  status claim_status DEFAULT 'draft',
  rejection_reason TEXT,
  submitted_at TIMESTAMPTZ,
  approved_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  nhis_reference VARCHAR(100),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_claims_pharmacy ON nhis_claims(pharmacy_id);
CREATE INDEX idx_claims_patient ON nhis_claims(patient_id);
CREATE INDEX idx_claims_status ON nhis_claims(status);
CREATE INDEX idx_claims_submitted ON nhis_claims(submitted_at);

-- ============ REIMBURSEMENTS ============
CREATE TABLE reimbursements (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  pharmacy_id UUID NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
  claim_id UUID REFERENCES nhis_claims(id) ON DELETE SET NULL,
  amount DECIMAL(10,2) NOT NULL,
  payment_method VARCHAR(50),
  payment_reference VARCHAR(100),
  received_at TIMESTAMPTZ DEFAULT NOW(),
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_reimbursements_pharmacy ON reimbursements(pharmacy_id);

-- ============ CONSULTATIONS ============
CREATE TABLE consultations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  pharmacy_id UUID NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
  patient_id UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  pharmacist_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type consultation_type NOT NULL DEFAULT 'in_person',
  status consultation_status DEFAULT 'scheduled',
  scheduled_at TIMESTAMPTZ NOT NULL,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  reason TEXT NOT NULL,
  notes TEXT,
  prescription_ids UUID[] DEFAULT '{}',
  follow_up_date DATE,
  video_room_id VARCHAR(100),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_consultations_pharmacy ON consultations(pharmacy_id);
CREATE INDEX idx_consultations_patient ON consultations(patient_id);
CREATE INDEX idx_consultations_pharmacist ON consultations(pharmacist_id);
CREATE INDEX idx_consultations_scheduled ON consultations(scheduled_at);
CREATE INDEX idx_consultations_status ON consultations(status);

-- ============ CHAT MESSAGES ============
CREATE TABLE chat_messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  consultation_id UUID NOT NULL REFERENCES consultations(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender_type VARCHAR(20) NOT NULL DEFAULT 'pharmacist',
  message TEXT NOT NULL,
  attachment_url TEXT,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_chat_consultation ON chat_messages(consultation_id);

-- ============ HEALTH SCREENINGS ============
CREATE TABLE screenings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  pharmacy_id UUID NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
  patient_id UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  recorded_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type screening_type NOT NULL,
  systolic INTEGER,
  diastolic INTEGER,
  value DECIMAL(10,2) NOT NULL,
  unit VARCHAR(20) NOT NULL,
  risk_level risk_level DEFAULT 'low',
  notes TEXT,
  referred_to_clinic BOOLEAN DEFAULT false,
  referral_clinic VARCHAR(255),
  referral_notes TEXT,
  recorded_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_screenings_pharmacy ON screenings(pharmacy_id);
CREATE INDEX idx_screenings_patient ON screenings(patient_id);
CREATE INDEX idx_screenings_type ON screenings(type);
CREATE INDEX idx_screenings_risk ON screenings(risk_level);
CREATE INDEX idx_screenings_date ON screenings(recorded_at);

-- ============ SUBSCRIPTIONS ============
CREATE TABLE subscriptions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  pharmacy_id UUID NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
  tier subscription_tier NOT NULL DEFAULT 'free',
  status subscription_status DEFAULT 'trial',
  start_date DATE NOT NULL DEFAULT CURRENT_DATE,
  end_date DATE,
  trial_ends_at TIMESTAMPTZ,
  monthly_amount DECIMAL(10,2) DEFAULT 0,
  currency VARCHAR(3) DEFAULT 'GHS',
  payment_method VARCHAR(50),
  payment_reference VARCHAR(100),
  last_payment_at TIMESTAMPTZ,
  next_billing_at TIMESTAMPTZ,
  features JSONB DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_subscriptions_pharmacy ON subscriptions(pharmacy_id);
CREATE INDEX idx_subscriptions_status ON subscriptions(status);

-- ============ PAYMENTS ============
CREATE TABLE payments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  pharmacy_id UUID NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
  subscription_id UUID REFERENCES subscriptions(id) ON DELETE SET NULL,
  amount DECIMAL(10,2) NOT NULL,
  currency VARCHAR(3) DEFAULT 'GHS',
  method VARCHAR(50) NOT NULL,
  reference VARCHAR(100) UNIQUE,
  status VARCHAR(20) DEFAULT 'pending',
  metadata JSONB DEFAULT '{}',
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_payments_pharmacy ON payments(pharmacy_id);
CREATE INDEX idx_payments_status ON payments(status);

-- ============ POINT OF SALE ============
-- `payments` above is for pharmacy subscription billing. Counter sales use
-- sales / sale_items / sale_payments so a receipt stays auditable.

CREATE TABLE sales (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  pharmacy_id UUID NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
  receipt_number VARCHAR(50) NOT NULL,

  -- A sale may be a walk-in with no patient record at all
  patient_id UUID REFERENCES patients(id) ON DELETE SET NULL,
  customer_name VARCHAR(200),
  customer_phone VARCHAR(20),

  served_by UUID NOT NULL REFERENCES users(id),
  -- Pharmacist sign-off, required when the basket holds prescription items
  approved_by UUID REFERENCES users(id),

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

  -- 'inclusive' = stored unit prices already contain the 20% and the POS backs
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

CREATE INDEX idx_sales_pharmacy ON sales(pharmacy_id);
CREATE INDEX idx_sales_created ON sales(pharmacy_id, created_at DESC);
CREATE INDEX idx_sales_status ON sales(pharmacy_id, status);
CREATE INDEX idx_sales_patient ON sales(patient_id);
CREATE INDEX idx_sales_served_by ON sales(served_by);
CREATE INDEX idx_sales_completed ON sales(pharmacy_id, completed_at DESC) WHERE status = 'completed';

CREATE TABLE sale_items (
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

CREATE INDEX idx_sale_items_sale ON sale_items(sale_id);
CREATE INDEX idx_sale_items_inventory ON sale_items(inventory_id);
CREATE INDEX idx_sale_items_product ON sale_items(product_name);

-- One row per tender, so a basket can be part cash / part MoMo.
CREATE TABLE sale_payments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  sale_id UUID NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  pharmacy_id UUID NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,

  method sale_payment_method NOT NULL,
  amount DECIMAL(12,2) NOT NULL CHECK (amount > 0),
  status sale_payment_status NOT NULL DEFAULT 'completed',

  momo_network VARCHAR(20),
  momo_number VARCHAR(20),
  reference VARCHAR(100),
  gateway VARCHAR(30),
  gateway_response JSONB NOT NULL DEFAULT '{}',

  received_by UUID REFERENCES users(id),
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sale_payments_sale ON sale_payments(sale_id);
CREATE INDEX idx_sale_payments_pharmacy ON sale_payments(pharmacy_id, created_at DESC);
CREATE INDEX idx_sale_payments_method ON sale_payments(pharmacy_id, method);
CREATE INDEX idx_sale_payments_reference ON sale_payments(reference);

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_sales_updated_at BEFORE UPDATE ON sales
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ============ NOTIFICATIONS ============
CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  pharmacy_id UUID NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
  patient_id UUID REFERENCES patients(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  type notification_type NOT NULL,
  title VARCHAR(255) NOT NULL,
  message TEXT NOT NULL,
  channel VARCHAR(50) DEFAULT 'in_app',
  status notification_status DEFAULT 'pending',
  sent_at TIMESTAMPTZ,
  read_at TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_notifications_pharmacy ON notifications(pharmacy_id);
CREATE INDEX idx_notifications_user ON notifications(user_id);
CREATE INDEX idx_notifications_status ON notifications(status);
CREATE INDEX idx_notifications_created ON notifications(created_at DESC);

-- ============ REMINDERS ============
CREATE TABLE reminders (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  pharmacy_id UUID NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
  patient_id UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL,
  title VARCHAR(255) NOT NULL,
  message TEXT,
  scheduled_at TIMESTAMPTZ NOT NULL,
  sent_at TIMESTAMPTZ,
  status VARCHAR(20) DEFAULT 'pending',
  recurrence VARCHAR(20),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_reminders_pharmacy ON reminders(pharmacy_id);
CREATE INDEX idx_reminders_patient ON reminders(patient_id);
CREATE INDEX idx_reminders_scheduled ON reminders(scheduled_at);

-- ============ AUDIT LOGS ============
CREATE TABLE audit_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  pharmacy_id UUID NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action VARCHAR(255) NOT NULL,
  resource_type VARCHAR(100),
  resource_id VARCHAR(100),
  details JSONB DEFAULT '{}',
  ip_address VARCHAR(45),
  user_agent TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_audit_pharmacy ON audit_logs(pharmacy_id);
CREATE INDEX idx_audit_user ON audit_logs(user_id);
CREATE INDEX idx_audit_action ON audit_logs(action);
CREATE INDEX idx_audit_created ON audit_logs(created_at DESC);

-- ============ FEATURE FLAGS ============
CREATE TABLE feature_flags (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(100) UNIQUE NOT NULL,
  description TEXT,
  is_enabled BOOLEAN DEFAULT false,
  rollout_percentage INTEGER DEFAULT 0,
  pharmacy_ids UUID[] DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============ SUBSCRIPTION PLANS ============
CREATE TABLE subscription_plans (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tier subscription_tier UNIQUE NOT NULL,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  monthly_price DECIMAL(10,2) NOT NULL,
  annual_price DECIMAL(10,2),
  currency VARCHAR(3) DEFAULT 'GHS',
  features JSONB NOT NULL DEFAULT '[]',
  max_users INTEGER DEFAULT 1,
  max_patients INTEGER,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seed subscription plans
INSERT INTO subscription_plans (tier, name, description, monthly_price, annual_price, features, max_users, max_patients) VALUES
('free', 'Starter', 'Basic inventory and patient management', 0, 0, '["inventory_basic", "patients_basic", "dashboard"]'::jsonb, 2, 100),
('premium', 'Professional', 'Full features including NHIS integration and analytics', 99.00, 990.00, '["inventory_full", "patients_full", "nhis_claims", "analytics", "sms_reminders", "screenings"]'::jsonb, 10, 5000),
('enterprise', 'Enterprise', 'Multi-branch with advanced reporting and API access', 299.00, 2990.00, '["inventory_full", "patients_full", "nhis_claims", "analytics_advanced", "sms_reminders", "screenings", "consultations", "api_access", "multi_branch"]'::jsonb, 50, NULL);

-- ============ UPDATED_AT TRIGGER ============
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply updated_at trigger to all tables with updated_at
DO $$
DECLARE
  t TEXT;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY[
      'pharmacies', 'users', 'patients', 'inventory', 'prescriptions',
      'nhis_claims', 'consultations', 'subscriptions', 'notifications',
      'feature_flags', 'reminders'
    ])
  LOOP
    EXECUTE format('CREATE TRIGGER set_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION update_updated_at()', t);
  END LOOP;
END;
$$;
