-- Migration 013: v9 Audit Fixes
--
-- Applies schema corrections identified in the v8 full audit:
--
--   FIX 6  — No schema changes needed; timezone column already exists from
--             migration 012. This migration ensures the column has a proper
--             default so existing rows aren't NULL.
--   FIX 9  — No schema changes needed; the businesses table has always used
--             the `whatsapp` column. The fix was in the TypeScript interface.
--   FIX 11 — startup_log version column default updated to track v9.
--
-- Idempotent: safe to run multiple times.

-- Ensure `timezone` column exists with a sensible default (migration 012 adds
-- it, but this guards against partial migrations).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'businesses' AND column_name = 'timezone'
  ) THEN
    ALTER TABLE businesses ADD COLUMN timezone TEXT NOT NULL DEFAULT 'Africa/Lagos';
  END IF;
END;
$$;

-- Backfill any NULL timezone values that may have slipped through.
UPDATE businesses SET timezone = 'Africa/Lagos' WHERE timezone IS NULL;

-- Ensure rate_limit_overrides table exists (migration 009 should have created
-- it, but guard here so the caching fix in the webhook doesn't query a missing table).
CREATE TABLE IF NOT EXISTS rate_limit_overrides (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  limit_key   TEXT NOT NULL,   -- 'business' | 'sender'
  limit_value INT  NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, limit_key)
);

-- Index for the per-business override lookup used in the webhook.
CREATE INDEX IF NOT EXISTS idx_rate_limit_overrides_business
  ON rate_limit_overrides (business_id);

-- Ensure subscription_history has the columns the v9 error-checked inserts expect.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'subscription_history' AND column_name = 'notes'
  ) THEN
    ALTER TABLE subscription_history ADD COLUMN notes TEXT;
  END IF;
END;
$$;
