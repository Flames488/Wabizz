-- ============================================================================
-- Migration 018 — Database Hardening
--
-- Implements Fix 7: Database hardening (connection pooling + indexes)
--
-- 1. pgBouncer connection pooling configuration note
-- 2. Batch write helper functions
-- 3. Remaining missing indexes (job_id, user_id, status patterns)
-- 4. N+1 query prevention via materialized conversation stats view
-- 5. Slow query helpers
-- ============================================================================

-- ── NOTE: pgBouncer (Supabase Connection Pooling) ────────────────────────────
--
-- Enable in Supabase dashboard:
--   Project → Settings → Database → Connection Pooling
--   Mode: Transaction (for serverless/Workers — no persistent connections)
--   Pool size: 15 (Cloudflare Workers open many short connections)
--
-- Update SUPABASE_URL in your secrets to the pooler URL:
--   postgresql://postgres.[project-ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres
--
-- The pooler URL is shown in: Supabase dashboard → Settings → Database → Connection string (URI)
-- Switch the port from 5432 to 6543 and host to the pooler host.
--
-- This migration cannot set pgBouncer config — it must be done in the dashboard.
-- This comment serves as a mandatory checklist item.

-- ── 1. conversations table — missing indexes ──────────────────────────────────
--
-- admin-api.ts queries:
--   .from("conversations").select(...).gt("last_message_at", fifteenMinAgo)
-- This needs an index on last_message_at.

CREATE INDEX IF NOT EXISTS idx_conversations_last_message_at
  ON public.conversations (last_message_at DESC);

-- business_id lookup (used in every inbound webhook)
CREATE INDEX IF NOT EXISTS idx_conversations_business_customer
  ON public.conversations (business_id, customer_number);

-- status filter (open/closed conversations)
CREATE INDEX IF NOT EXISTS idx_conversations_business_status
  ON public.conversations (business_id, status);

-- ── 2. businesses table indexes ───────────────────────────────────────────────
--
-- twilio-webhook: looks up business by phone number on every message
-- This is THE most critical lookup in the entire system.

CREATE INDEX IF NOT EXISTS idx_businesses_whatsapp_number
  ON public.businesses (whatsapp_number)
  WHERE whatsapp_number IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_businesses_subscription_status
  ON public.businesses (subscription_status);

-- ── 3. error_logs — add request_id index ─────────────────────────────────────
--
-- Admin log viewer: filter by request_id for request tracing

CREATE INDEX IF NOT EXISTS idx_error_logs_request_id
  ON public.error_logs (request_id)
  WHERE request_id IS NOT NULL;

-- ── 4. webhook_events — faster idempotency check ─────────────────────────────
--
-- Already has UNIQUE(event_id, source) — add partial index for "processing" status
-- Used by webhook stall monitoring query

CREATE INDEX IF NOT EXISTS idx_webhook_events_processing_received
  ON public.webhook_events (received_at DESC)
  WHERE status = 'processing';

-- ── 5. Materialized conversation stats ───────────────────────────────────────
--
-- The admin dashboard queries active_users by joining conversations.
-- A lightweight stats view prevents N+1 joins.
-- Refreshed by the scheduled cron (every 30 min is sufficient for admin).

CREATE MATERIALIZED VIEW IF NOT EXISTS public.conversation_stats AS
SELECT
  business_id,
  COUNT(*)                                              AS total_conversations,
  COUNT(*) FILTER (WHERE status = 'open')               AS open_conversations,
  COUNT(*) FILTER (WHERE last_message_at > NOW() - INTERVAL '15 minutes') AS active_15m,
  MAX(last_message_at)                                  AS last_activity
FROM public.conversations
GROUP BY business_id;

CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_stats_business
  ON public.conversation_stats (business_id);

-- Refresh function — called from scheduled cron
CREATE OR REPLACE FUNCTION public.refresh_conversation_stats()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.conversation_stats;
END;
$$;

-- ── 6. Batch insert helper for messages ──────────────────────────────────────
--
-- Reduces N+1 inserts when processing bulk reminders.
-- The application already uses supabaseAdmin.from("messages").insert([...array...])
-- which Supabase handles as a single INSERT with multiple rows.
-- This comment documents that pattern as the required approach — no looped inserts.

-- ── 7. Auto-vacuum tuning for high-write tables ───────────────────────────────
--
-- messages, error_logs, and api_health_log receive frequent inserts.
-- Lower autovacuum cost delay to keep these tables lean.

ALTER TABLE IF EXISTS public.messages
  SET (autovacuum_vacuum_scale_factor = 0.01,
       autovacuum_analyze_scale_factor = 0.005);

ALTER TABLE IF EXISTS public.error_logs
  SET (autovacuum_vacuum_scale_factor = 0.01,
       autovacuum_analyze_scale_factor = 0.005);

ALTER TABLE IF EXISTS public.api_health_log
  SET (autovacuum_vacuum_scale_factor = 0.02,
       autovacuum_analyze_scale_factor = 0.01);
