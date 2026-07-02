-- ============================================================================
-- Migration 017 — Admin System + Metrics Pipeline
--
-- 1. admin_users table — hardened credential store for control plane access
-- 2. admin_actions_log — audit trail for every admin action
-- 3. metrics table — time-series counters for jobs, API calls, queue latency
-- 4. api_health_log — tracks external API (Twilio, Paystack) call outcomes
-- ============================================================================

-- ── 1. admin_users ────────────────────────────────────────────────────────────
-- Separate from Supabase auth — admin auth is stateless JWT with bcrypt password.
-- Credentials never touch the client; all validation is server-side.

CREATE TABLE IF NOT EXISTS public.admin_users (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username     text NOT NULL UNIQUE,
  -- bcrypt hash of password — NEVER store plaintext
  password_hash text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_login   timestamptz
);

-- Seed Emmanuel / Flames (password hash generated at startup if table is empty)
-- The actual bcrypt hash is inserted by the server-init bootstrap, not here,
-- because migrations run before the app boots and bcrypt requires Node.
-- See: src/lib/server/admin/admin-auth.ts → seedAdminUser()

ALTER TABLE public.admin_users ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_users_service_role ON public.admin_users
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── 2. admin_actions_log ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.admin_actions_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id    uuid REFERENCES public.admin_users(id),
  action      text NOT NULL,  -- e.g. "retry_job", "delete_job", "ack_dlq"
  target_id   text,           -- job_id, log_id, etc.
  details     jsonb,
  ip          text,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_actions_occurred
  ON public.admin_actions_log (occurred_at DESC);

ALTER TABLE public.admin_actions_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_actions_service_role ON public.admin_actions_log
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── 3. metrics ────────────────────────────────────────────────────────────────
-- Rolling 5-minute bucket counters. Each row = one metric in one 5-min window.
-- Old rows are pruned by a cron after 7 days.

CREATE TABLE IF NOT EXISTS public.metrics (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  metric       text        NOT NULL,  -- e.g. "jobs_created", "api_calls_success"
  value        numeric     NOT NULL DEFAULT 0,
  bucket_at    timestamptz NOT NULL,  -- floored to 5-min boundary
  source       text,                  -- e.g. "queue", "twilio", "paystack"
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_metric_bucket UNIQUE (metric, bucket_at, source)
);

CREATE INDEX IF NOT EXISTS idx_metrics_metric_bucket
  ON public.metrics (metric, bucket_at DESC);

ALTER TABLE public.metrics ENABLE ROW LEVEL SECURITY;
CREATE POLICY metrics_service_role ON public.metrics
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── 4. api_health_log ─────────────────────────────────────────────────────────
-- One row per external API call outcome. Used for success rate + latency charts.

CREATE TABLE IF NOT EXISTS public.api_health_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service      text        NOT NULL,  -- "twilio" | "paystack" | "anthropic"
  success      boolean     NOT NULL,
  latency_ms   int,
  status_code  int,
  error        text,
  occurred_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_api_health_service_occurred
  ON public.api_health_log (service, occurred_at DESC);

-- Prune rows older than 7 days (called from scheduled cron)
-- The actual DELETE is done in code to avoid pg_cron dependency.

ALTER TABLE public.api_health_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY api_health_service_role ON public.api_health_log
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── 5. increment_metric RPC ───────────────────────────────────────────────────
-- Atomic upsert for metrics counter — called from metrics.ts increment().
-- Uses INSERT ... ON CONFLICT DO UPDATE to avoid race conditions.

CREATE OR REPLACE FUNCTION public.increment_metric(
  p_metric   text,
  p_delta    numeric,
  p_bucket_at timestamptz,
  p_source   text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO public.metrics (metric, value, bucket_at, source)
  VALUES (p_metric, p_delta, p_bucket_at, p_source)
  ON CONFLICT (metric, bucket_at, source)
  DO UPDATE SET value = metrics.value + EXCLUDED.value;
END;
$$;
