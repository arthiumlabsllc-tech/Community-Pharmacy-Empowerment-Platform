-- =====================================================================
-- Migration 002: offline write replay
-- =====================================================================
-- Safe to re-run: every statement is guarded with IF NOT EXISTS.
--
-- Apply with:
--   npm run db:migrate
-- or paste into the Supabase SQL editor.
-- =====================================================================

-- ============ IDEMPOTENCY KEYS ============
-- A queued write can reach the server more than once. The realistic failure
-- is not "the request never arrived" but "it arrived, was committed, and the
-- response was lost before the phone recorded it" — the signal comes back for
-- a second on a 3G connection and drops again. Replaying that request without
-- a key creates a second patient, a second stock row or a second sale.
--
-- Each offline-capable endpoint therefore stores the response it produced for
-- a client-supplied key, and replays that stored response verbatim on a
-- repeat, so the client cannot tell the difference between the first attempt
-- and the retry — which is exactly the point.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  pharmacy_id UUID NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
  client_request_id UUID NOT NULL,
  -- Who made the original request, so a replay can be refused if that user
  -- has since been deactivated.
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  endpoint VARCHAR(200) NOT NULL,
  response_status INTEGER NOT NULL,
  response_body JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Scoped per pharmacy: two unrelated pharmacies must never be able to
  -- collide on a key, and neither should be able to read the other's replay.
  PRIMARY KEY (pharmacy_id, client_request_id)
);

-- A key only has to outlive the window in which a device might still be
-- holding the request offline. 30 days is far longer than any realistic
-- outage and keeps the table from growing without bound.
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_created ON idempotency_keys(created_at);

-- ============ SALES: OFFLINE PROVENANCE ============
-- A sale recorded during an outage is real, but it arrived late and its
-- totals were provisional until the server priced it. Both facts belong on
-- the row: the receipt should be able to say it was written offline, and the
-- pharmacy should be able to see how much turnover went through an outage.
ALTER TABLE sales
  ADD COLUMN IF NOT EXISTS recorded_offline BOOLEAN NOT NULL DEFAULT false;

-- The time the cashier actually completed the sale, not the time it synced.
-- Without this, a till that goes down at 17:00 and reconnects the next
-- morning moves a whole evening's takings into the wrong day on the daily
-- sales report.
ALTER TABLE sales
  ADD COLUMN IF NOT EXISTS client_recorded_at TIMESTAMPTZ;

-- The total the till showed the customer before the server priced the basket.
-- Kept so a disagreement between the two is visible instead of silent: the
-- server figure in total_amount is authoritative, and if it differs the
-- pharmacy needs to know that a customer was charged something else.
ALTER TABLE sales
  ADD COLUMN IF NOT EXISTS client_quoted_total DECIMAL(12,2);
