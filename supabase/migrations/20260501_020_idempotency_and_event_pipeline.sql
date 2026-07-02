-- ============================================================================
-- Migration 020 — Idempotency Keys + Event Pipeline Tables
--
-- 1. idempotency_keys: strict dedup for queue jobs
--    Prevents double payments, duplicate messages, duplicate reminders.
--    Keys expire after 24h and are pruned by the scheduled cron.
--
-- 2. system_events: optional persistent event log for debugging
--    The event pipeline emits to stdout + Logflare + metrics.
--    This table stores critical events (warning/critical severity only)
--    for admin dashboard replay and root-cause analysis.
-- ============================================================================

-- ── 1. idempotency_keys ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.idempotency_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key          text        NOT NULL UNIQUE,
  status       text        NOT NULL DEFAULT 'processing'
    CHECK (status IN ('processing', 'success', 'failed')),
  trace_id     text,
  expires_at   timestamptz NOT NULL,
  completed_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Cleanup query: find expired keys
CREATE INDEX IF NOT EXISTS idx_idempotency_expires
  ON public.idempotency_keys (expires_at)
  WHERE status = 'processing';

-- Fast dedup lookup
CREATE INDEX IF NOT EXISTS idx_idempotency_key_status
  ON public.idempotency_keys (key, status);

ALTER TABLE public.idempotency_keys ENABLE ROW LEVEL SECURITY;
CREATE POLICY idempotency_service_role ON public.idempotency_keys
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── 2. system_events (critical/warning events only) ───────────────────────────
-- Full event stream goes to stdout + Logflare.
-- Only warning/critical events are written here for admin visibility.

CREATE TABLE IF NOT EXISTS public.system_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type       text        NOT NULL,
  severity   text        NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  trace_id   text,
  user_id    text,
  metadata   jsonb       NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_system_events_occurred
  ON public.system_events (occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_system_events_severity
  ON public.system_events (severity, occurred_at DESC)
  WHERE severity IN ('warning', 'critical');

CREATE INDEX IF NOT EXISTS idx_system_events_trace
  ON public.system_events (trace_id)
  WHERE trace_id IS NOT NULL;

ALTER TABLE public.system_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY system_events_service_role ON public.system_events
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Auto-prune system_events older than 14 days (called from scheduled cron)
-- The actual DELETE runs in code (pruneOldMetrics handles this table too).
