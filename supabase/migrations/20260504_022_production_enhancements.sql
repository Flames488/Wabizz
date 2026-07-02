-- ============================================================================
-- Migration 022 — Production Enhancements
--
-- Covers:
--   1. rate_limit_events ip index (supports abuse investigation by IP)
--   2. rate_limit_abuse_summary view — top offenders at a glance
--   3. sentry_check column in health_snapshots (future use)
--   4. circuit_events table — persistent record of circuit breaker trips
--      (complements the in-memory circuit state with a queryable history)
--
-- All DDL is idempotent (IF NOT EXISTS / OR REPLACE).
-- ============================================================================

-- ── 1. Additional ip index on rate_limit_events ───────────────────────────────
-- migration 021 created the table; add IP-specific index for abuse queries

CREATE INDEX IF NOT EXISTS idx_rate_limit_events_ip_occurred
  ON public.rate_limit_events (ip, occurred_at DESC)
  WHERE ip IS NOT NULL;

-- ── 2. Rate limit abuse summary view ─────────────────────────────────────────
-- Answers: "who are the top rate-limited IPs in the last 24h?"

CREATE OR REPLACE VIEW public.rate_limit_abuse_summary AS
SELECT
  ip,
  endpoint,
  COUNT(*)                        AS block_count,
  MIN(occurred_at)                AS first_seen,
  MAX(occurred_at)                AS last_seen
FROM public.rate_limit_events
WHERE occurred_at > now() - INTERVAL '24 hours'
  AND ip IS NOT NULL
GROUP BY ip, endpoint
ORDER BY block_count DESC;

-- ── 3. circuit_events table — persistent circuit breaker history ──────────────
--
-- The circuit breaker state is in-memory; this table gives you a queryable
-- history of every OPEN/CLOSE event across all worker instances.
-- Written to by the circuit-breaker module on state transitions.

CREATE TABLE IF NOT EXISTS public.circuit_events (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  service     text        NOT NULL,               -- "twilio" | "paystack" | "anthropic"
  event       text        NOT NULL,               -- "OPEN" | "CLOSED" | "HALF_OPEN"
  failures    integer     NOT NULL DEFAULT 0,
  message     text,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_circuit_events_service_occurred
  ON public.circuit_events (service, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_circuit_events_event_occurred
  ON public.circuit_events (event, occurred_at DESC);

ALTER TABLE public.circuit_events ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'circuit_events' AND policyname = 'service_role_all'
  ) THEN
    CREATE POLICY service_role_all ON public.circuit_events
      FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Auto-purge circuit_events older than 30 days
CREATE OR REPLACE FUNCTION public.purge_old_circuit_events()
  RETURNS void LANGUAGE sql SECURITY DEFINER AS $$
    DELETE FROM public.circuit_events WHERE occurred_at < now() - INTERVAL '30 days';
$$;

-- ── 4. Verification ──────────────────────────────────────────────────────────
--
-- After running this migration, verify in Supabase Studio:
--
--   SELECT * FROM public.wabizz_index_inventory
--   WHERE table_name IN ('rate_limit_events', 'circuit_events');
--
-- Expected:
--   rate_limit_events: idx_rate_limit_events_key_occurred
--                      idx_rate_limit_events_endpoint_occurred
--                      idx_rate_limit_events_ip_occurred
--   circuit_events:    idx_circuit_events_service_occurred
--                      idx_circuit_events_event_occurred
