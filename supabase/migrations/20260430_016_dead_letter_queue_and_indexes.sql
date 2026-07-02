-- ============================================================================
-- Migration 016 — Dead Letter Queue + Critical DB Indexes
--
-- Addresses the following production hardening items:
--
--   1. dead_letter_jobs table — persistent store for queue jobs that have
--      exhausted all retry attempts. Prevents silent job loss. Enables manual
--      replay and audit trail.
--
--   2. messages table indexes — getMessageHistory is the most frequent query
--      in the system (runs on EVERY inbound message before the AI call).
--      The existing primary key covers id but not the (conversation_id, created_at)
--      lookup pattern used by ORDER BY created_at DESC LIMIT 20.
--
--   3. error_logs indexes — admin dashboard and DLQ review benefit from
--      fast source + level lookups.
--
--   4. notification_log indexes — dedup queries in reminders.ts do
--      .in("business_id", ids) + .eq("type", ...) — needs a composite index.
--
-- All DDL is idempotent (CREATE ... IF NOT EXISTS / DO $$ ... IF NOT EXISTS).
-- ============================================================================

-- ── 1. Dead Letter Queue table ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.dead_letter_jobs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id           text        NOT NULL,
  job_type         text        NOT NULL,
  payload          jsonb       NOT NULL,
  last_error       text        NOT NULL,
  attempts         int         NOT NULL DEFAULT 1,
  failed_at        timestamptz NOT NULL DEFAULT now(),
  request_id       text,
  status           text        NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'acknowledged', 'replayed')),
  acknowledged_at  timestamptz,
  replayed_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- Fast lookup: most recent failures first (dashboard view)
CREATE INDEX IF NOT EXISTS idx_dlq_failed_at
  ON public.dead_letter_jobs (failed_at DESC)
  WHERE status = 'pending';

-- Lookup by job_id for acknowledgement
CREATE INDEX IF NOT EXISTS idx_dlq_job_id
  ON public.dead_letter_jobs (job_id);

-- RLS: only service role can read/write (admin only)
ALTER TABLE public.dead_letter_jobs ENABLE ROW LEVEL SECURITY;

-- Service role bypass (used by supabaseAdmin)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'dead_letter_jobs' AND policyname = 'service_role_all'
  ) THEN
    CREATE POLICY service_role_all ON public.dead_letter_jobs
      FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;

-- ── 2. messages table — critical query optimization ───────────────────────────
--
-- getMessageHistory query pattern:
--   SELECT role, content FROM messages
--   WHERE conversation_id = $1
--   ORDER BY created_at DESC
--   LIMIT 20
--
-- Without this index, Postgres scans all messages in the table for each AI call.
-- At 10k messages this is fine. At 500k messages it's a disaster.

CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
  ON public.messages (conversation_id, created_at DESC);

-- Covering index: include role + content so Postgres can return data from the
-- index alone without touching the heap (index-only scan).
-- This makes getMessageHistory nearly free at any table size.
CREATE INDEX IF NOT EXISTS idx_messages_conversation_created_covering
  ON public.messages (conversation_id, created_at DESC)
  INCLUDE (role, content);

-- message_sid deduplication index (Twilio retry idempotency)
CREATE INDEX IF NOT EXISTS idx_messages_sid
  ON public.messages (message_sid)
  WHERE message_sid IS NOT NULL;

-- ── 3. error_logs indexes ─────────────────────────────────────────────────────
--
-- Admin log viewer queries: filter by source, level, date range

CREATE INDEX IF NOT EXISTS idx_error_logs_source_level
  ON public.error_logs (source, level, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_error_logs_occurred_at
  ON public.error_logs (occurred_at DESC);

-- ── 4. notification_log indexes ───────────────────────────────────────────────
--
-- reminders.ts dedup queries:
--   .eq("type", "trial_expiry_warning").in("business_id", ids).gt("sent_at", ...)

CREATE INDEX IF NOT EXISTS idx_notification_log_type_business_sent
  ON public.notification_log (type, business_id, sent_at DESC);

-- JSONB index for payment_reminder dedup:
--   .in("meta->>order_id", orderIds)
CREATE INDEX IF NOT EXISTS idx_notification_log_meta_order_id
  ON public.notification_log ((meta->>'order_id'))
  WHERE type = 'payment_reminder';

-- ── 5. orders table indexes ───────────────────────────────────────────────────
--
-- overdue payment reminders query:
--   .eq("status", "pending").lt("created_at", 30m ago).gt("created_at", 4h ago)

CREATE INDEX IF NOT EXISTS idx_orders_status_created
  ON public.orders (status, created_at DESC)
  WHERE status = 'pending';

-- paystack_reference lookup (webhook idempotency)
CREATE INDEX IF NOT EXISTS idx_orders_paystack_reference
  ON public.orders (paystack_reference)
  WHERE paystack_reference IS NOT NULL;

-- ── 6. webhook_events table — idempotent event processing ────────────────────
--
-- Stores every inbound Paystack / Twilio webhook event.
-- Prevents duplicate processing when providers retry on timeout or 5xx.
-- Enables manual event replay for failed events.

CREATE TABLE IF NOT EXISTS public.webhook_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        text        NOT NULL,  -- Paystack reference or Twilio MessageSid
  source          text        NOT NULL CHECK (source IN ('paystack', 'twilio')),
  status          text        NOT NULL DEFAULT 'processing'
    CHECK (status IN ('processing', 'processed', 'failed')),
  raw_body        text,                  -- original request body for replay
  request_id      text,
  error_message   text,                  -- populated on failure
  received_at     timestamptz NOT NULL DEFAULT now(),
  processed_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_webhook_event UNIQUE (event_id, source)
);

-- Fast lookup for idempotency check on every inbound webhook
CREATE INDEX IF NOT EXISTS idx_webhook_events_event_source
  ON public.webhook_events (event_id, source);

-- Cleanup query: find stale "processing" events (for alerting / recovery)
CREATE INDEX IF NOT EXISTS idx_webhook_events_status_received
  ON public.webhook_events (status, received_at DESC);

ALTER TABLE public.webhook_events ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'webhook_events' AND policyname = 'service_role_all'
  ) THEN
    CREATE POLICY service_role_all ON public.webhook_events
      FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;
