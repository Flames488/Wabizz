-- ============================================================================
-- Migration 009 — Ops improvements
--
-- 1. startup_log table — records every server boot (env, version, runtime).
--    Useful for auditing deployments and correlating errors to a specific
--    deploy without requiring external APM tooling.
--
-- 2. rate_limit_overrides table — allows per-business rate limit tuning
--    without a code deploy. e.g. bump a high-volume clinic's limit to 500/min.
--
-- 3. error_logs: add index on occurred_at DESC for dashboard queries.
--    (The composite index in migration 008 is good for source+level lookups;
--     this single-column index speeds up "most recent N errors" queries.)
-- ============================================================================

-- ── 1. startup_log ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.startup_log (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version    text NOT NULL,
  runtime    text NOT NULL,
  env        text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.startup_log ENABLE ROW LEVEL SECURITY;
-- Service role only — startup writes go through supabaseAdmin

-- Prune old startup entries automatically (keep last 90 days)
CREATE INDEX IF NOT EXISTS startup_log_started_at_idx
  ON public.startup_log(started_at DESC);

-- ── 2. rate_limit_overrides ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.rate_limit_overrides (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  limit_key   text NOT NULL,   -- e.g. 'sender', 'business', 'ip'
  limit_value integer NOT NULL CHECK (limit_value > 0),
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, limit_key)
);

ALTER TABLE public.rate_limit_overrides ENABLE ROW LEVEL SECURITY;
-- Business owners can view their own overrides; admin sets them server-side
CREATE POLICY "owner_select_rate_limit_overrides" ON public.rate_limit_overrides
  FOR SELECT USING (
    business_id IN (
      SELECT id FROM public.businesses WHERE owner_id = auth.uid()
    )
  );

-- ── 3. error_logs: fast recency index ────────────────────────────────────────
CREATE INDEX IF NOT EXISTS error_logs_occurred_at_idx
  ON public.error_logs(occurred_at DESC);

-- Auto-prune error_logs older than 90 days (prevents unbounded table growth).
-- Requires pg_cron extension (available in Supabase Pro).
-- Uncomment if pg_cron is enabled on your project:
--
-- SELECT cron.schedule(
--   'prune-error-logs',
--   '0 3 * * *',   -- 3 AM UTC daily
--   $$
--     DELETE FROM public.error_logs
--     WHERE occurred_at < NOW() - INTERVAL '90 days';
--   $$
-- );
