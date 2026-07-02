-- Migration 019 — Alert History + System Status tables
-- Supports the unified alert engine

CREATE TABLE IF NOT EXISTS public.alert_history (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  severity         text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  type             text NOT NULL,
  title            text NOT NULL,
  body             text NOT NULL,
  context          jsonb NOT NULL DEFAULT '{}',
  aggregated_count int  NOT NULL DEFAULT 1,
  fired_at         timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_alert_history_fired_at
  ON public.alert_history (fired_at DESC);
CREATE INDEX IF NOT EXISTS idx_alert_history_severity
  ON public.alert_history (severity, fired_at DESC);

ALTER TABLE public.alert_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY alert_history_service_role ON public.alert_history
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- system_status: key-value store for auto-remediation flags
CREATE TABLE IF NOT EXISTS public.system_status (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.system_status ENABLE ROW LEVEL SECURITY;
CREATE POLICY system_status_service_role ON public.system_status
  FOR ALL TO service_role USING (true) WITH CHECK (true);
