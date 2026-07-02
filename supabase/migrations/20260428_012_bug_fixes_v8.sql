-- ============================================================================
-- Migration 012 — Bug Fixes v8
--
-- 1. Bug 4: Add `timezone` column to businesses (default Africa/Lagos).
--    Allows non-Nigerian businesses to have correct business-hours enforcement.
--
-- 2. Wire notification_log auto-prune (pg_cron, mirrors error_logs prune from 009).
--    Prevents unbounded table growth in production.
--
-- 3. Wire error_logs auto-prune (was commented out in migration 009).
--    Enable here unconditionally so ops don't need to remember to uncomment.
-- ============================================================================

-- ── 1. Business timezone support ──────────────────────────────────────────────
ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT 'Africa/Lagos';

COMMENT ON COLUMN public.businesses.timezone IS
  'IANA timezone name (e.g. Africa/Lagos, Europe/London). '
  'Used by isWithinBusinessHours() on the server. '
  'Defaults to Africa/Lagos for Nigeria-based businesses.';

-- ── 2. error_logs auto-prune via pg_cron ─────────────────────────────────────
-- Requires pg_cron extension (available on Supabase Pro).
-- Deletes error_log rows older than 90 days, daily at 03:00 UTC.
-- Idempotent: cron.schedule() replaces an existing job with the same name.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_extension WHERE extname = 'pg_cron'
  ) THEN
    PERFORM cron.schedule(
      'prune-error-logs',
      '0 3 * * *',
      $$DELETE FROM public.error_logs WHERE occurred_at < NOW() - INTERVAL '90 days';$$
    );
  END IF;
END;
$$;

-- ── 3. notification_log auto-prune via pg_cron ───────────────────────────────
-- Keeps only 90 days of notification history, matching error_logs retention.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_extension WHERE extname = 'pg_cron'
  ) THEN
    PERFORM cron.schedule(
      'prune-notification-log',
      '15 3 * * *',
      $$DELETE FROM public.notification_log WHERE created_at < NOW() - INTERVAL '90 days';$$
    );
  END IF;
END;
$$;
