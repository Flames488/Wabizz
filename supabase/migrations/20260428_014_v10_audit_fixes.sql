-- ============================================================================
-- Migration 014 — v10 Audit Fixes
--
-- Fixes applied:
--
--   MISSING 2 — startup_log auto-prune (table grew unboundedly since migration 009).
--               error_logs and notification_log both had prune jobs; startup_log was
--               documented as "prune old startup entries" but no job was ever created.
--
--   MISSING 3 — Vault key lookup alerts: no schema change needed — the alert is
--               now emitted by getWhatsAppApiKey() / getPaystackSecretKey() in
--               keys.functions.ts when Vault returns null.
--
--   BUG 6     — Add UNIQUE constraint name comment on conversations so future
--               developers know the onConflict target for payment-link upserts.
--               (The constraint was created in migration 001 — this is documentation only.)
--
-- Idempotent: safe to run multiple times.
-- ============================================================================

-- ── MISSING 2: startup_log auto-prune ────────────────────────────────────────
-- Keep only 90 days of startup history. On a system with rolling deploys or
-- frequent restarts, the table would otherwise grow without bound.
-- Requires pg_cron (available on Supabase Pro). Idempotent via cron.schedule().
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_extension WHERE extname = 'pg_cron'
  ) THEN
    PERFORM cron.schedule(
      'prune-startup-log',
      '30 3 * * *',   -- 03:30 UTC daily (offset from error_logs at 03:00)
      $$DELETE FROM public.startup_log WHERE started_at < NOW() - INTERVAL '90 days';$$
    );
  END IF;
END;
$$;

-- ── BUG 6 documentation: conversations unique constraint ─────────────────────
-- The UNIQUE index on (business_id, customer_number) was created in migration 001.
-- The payment-link.functions.ts upsert targets this constraint via:
--   .upsert(..., { onConflict: "business_id,customer_number" })
-- No schema change needed — this comment exists so future migrations
-- can reference the constraint by name if it ever needs to be renamed.
COMMENT ON INDEX conversations_business_customer_idx IS
  'Unique constraint used by payment-link conversation upsert (onConflict target). '
  'Do not drop or rename without updating payment-link.functions.ts.';

-- ── Ensure timezone field default is propagated to all existing businesses ────
-- Migration 012 added the column with DEFAULT ''Africa/Lagos''.
-- Migration 013 backfilled NULL values. This is a final safety net.
UPDATE public.businesses
  SET timezone = 'Africa/Lagos'
WHERE timezone IS NULL OR timezone = '';
