-- ============================================================================
-- Migration 021 — Pre-Launch Index Verification + Missing Critical Indexes
--
-- Purpose: Verify ALL production-critical indexes exist and add any that are
-- still missing. Run this migration last before launch.
--
-- Covers:
--   1. user_id indexes (subscriptions, orders, conversations)
--   2. payment reference indexes (orders.paystack_reference confirmed)
--   3. timestamp compound indexes (created_at, last_message_at)
--   4. Rate limit event log table (new)
--   5. Index inventory view — visible in Supabase Studio
--   6. Missing indexes found by query analysis
--
-- All DDL is idempotent (CREATE ... IF NOT EXISTS).
-- ============================================================================

-- ── 1. subscriptions table — user_id / business_id indexes ───────────────────
--
-- subscription.functions.ts queries:
--   .from("subscriptions").select("*").eq("business_id", id)
-- Supabase quota middleware:
--   .from("subscriptions").select("plan_id,status").eq("business_id", id).single()

CREATE INDEX IF NOT EXISTS idx_subscriptions_business_id
  ON public.subscriptions (business_id);

-- Status filter — find all active / trialling subscriptions
CREATE INDEX IF NOT EXISTS idx_subscriptions_business_status
  ON public.subscriptions (business_id, status)
  WHERE status IN ('active', 'trialling', 'past_due');

-- Paystack subscription_code lookup (webhook idempotency, subscription renewal)
CREATE INDEX IF NOT EXISTS idx_subscriptions_paystack_code
  ON public.subscriptions (paystack_subscription_code)
  WHERE paystack_subscription_code IS NOT NULL;

-- Trial expiry queries (reminders.ts sends trial_expiry_warning):
--   .lt("trial_ends_at", cutoff).eq("status", "trialling")
CREATE INDEX IF NOT EXISTS idx_subscriptions_trial_ends_at
  ON public.subscriptions (trial_ends_at)
  WHERE status = 'trialling';

-- ── 2. orders table — payment reference indexes ───────────────────────────────
--
-- paystack_reference is the primary idempotency key for charge.success events.
-- Already added in migration 016 but re-declared here for verification.
-- IF NOT EXISTS makes this a safe no-op if it already exists.

CREATE INDEX IF NOT EXISTS idx_orders_paystack_reference
  ON public.orders (paystack_reference)
  WHERE paystack_reference IS NOT NULL;

-- business_id + status (dashboard payment history)
CREATE INDEX IF NOT EXISTS idx_orders_business_status_created
  ON public.orders (business_id, status, created_at DESC);

-- ── 3. conversations — user / customer lookup indexes ─────────────────────────
--
-- conversation.$id.tsx loads conversation by id (PK — already indexed).
-- dashboard.tsx loads conversation list:
--   .from("conversations").select("*").eq("business_id", id).order("last_message_at", desc)
-- Already added in migration 018, re-declared for verification.

CREATE INDEX IF NOT EXISTS idx_conversations_business_last_message
  ON public.conversations (business_id, last_message_at DESC);

-- customer_number lookup for opt-out checks
CREATE INDEX IF NOT EXISTS idx_conversations_customer_number
  ON public.conversations (customer_number)
  WHERE customer_number IS NOT NULL;

-- ── 4. messages table — conversation history (critical hot path) ──────────────
--
-- Every inbound message triggers getMessageHistory:
--   SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 20
-- Covering index added in migration 016 — re-declared for verification.

CREATE INDEX IF NOT EXISTS idx_messages_conversation_created_covering
  ON public.messages (conversation_id, created_at DESC)
  INCLUDE (role, content);

-- ── 5. webhook_events — idempotency check (every webhook) ────────────────────
--
-- Paystack and Twilio webhooks check this table on every request.
-- Added in migration 016 — re-declared for verification.

CREATE INDEX IF NOT EXISTS idx_webhook_events_event_source
  ON public.webhook_events (event_id, source);

-- ── 6. businesses table — whatsapp_number lookup ─────────────────────────────
--
-- This is THE most-called lookup in the entire system.
-- Every inbound Twilio message looks up the business by WhatsApp number.
-- Added in migration 018 — re-declared for verification.

CREATE INDEX IF NOT EXISTS idx_businesses_whatsapp_number
  ON public.businesses (whatsapp_number)
  WHERE whatsapp_number IS NOT NULL;

-- Subscription status (quota checks)
CREATE INDEX IF NOT EXISTS idx_businesses_subscription_status
  ON public.businesses (subscription_status);

-- ── 7. error_logs — admin log viewer + Sentry cross-reference ────────────────

CREATE INDEX IF NOT EXISTS idx_error_logs_level_occurred
  ON public.error_logs (level, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_error_logs_source_occurred
  ON public.error_logs (source, occurred_at DESC);

-- ── 8. rate_limit_events — new table for rate limit analytics ────────────────
--
-- Records rate limit breaches for monitoring. Helps identify:
--   - Which IPs are hitting limits (possible attackers)
--   - Which endpoints are hot (capacity planning)
--   - Whether limits need adjustment

CREATE TABLE IF NOT EXISTS public.rate_limit_events (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  key          text        NOT NULL,       -- e.g. "ip:1.2.3.4" or "admin:login:5.6.7.8"
  endpoint     text        NOT NULL,       -- e.g. "twilio-webhook", "admin-login"
  ip           text,
  occurred_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_events_key_occurred
  ON public.rate_limit_events (key, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_rate_limit_events_endpoint_occurred
  ON public.rate_limit_events (endpoint, occurred_at DESC);

-- Auto-purge: rate_limit_events older than 7 days are noise, not signal
-- Run this periodically (e.g., via pg_cron or the scheduled cron job)
CREATE OR REPLACE FUNCTION public.purge_old_rate_limit_events()
  RETURNS void LANGUAGE sql SECURITY DEFINER AS $$
    DELETE FROM public.rate_limit_events WHERE occurred_at < now() - INTERVAL '7 days';
$$;

ALTER TABLE public.rate_limit_events ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'rate_limit_events' AND policyname = 'service_role_all'
  ) THEN
    CREATE POLICY service_role_all ON public.rate_limit_events
      FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;

-- ── 9. Index inventory view ───────────────────────────────────────────────────
--
-- View this in Supabase Studio (SQL editor) to verify all indexes are present.
-- Query: SELECT * FROM public.wabizz_index_inventory ORDER BY table_name, index_name;

CREATE OR REPLACE VIEW public.wabizz_index_inventory AS
SELECT
  t.relname  AS table_name,
  i.relname  AS index_name,
  ix.indisunique AS is_unique,
  ix.indisprimary AS is_primary,
  pg_get_indexdef(ix.indexrelid) AS definition,
  pg_size_pretty(pg_relation_size(i.oid)) AS index_size
FROM
  pg_class t
  JOIN pg_index ix ON t.oid = ix.indrelid
  JOIN pg_class i  ON ix.indexrelid = i.oid
  JOIN pg_namespace n ON t.relnamespace = n.oid
WHERE
  n.nspname = 'public'
  AND t.relname IN (
    'businesses', 'conversations', 'messages', 'orders',
    'subscriptions', 'webhook_events', 'error_logs',
    'dead_letter_jobs', 'notification_log', 'rate_limit_events'
  )
ORDER BY
  t.relname, i.relname;

-- ── VERIFICATION CHECKLIST ────────────────────────────────────────────────────
--
-- After running this migration, verify in Supabase Studio:
--
--   SELECT * FROM public.wabizz_index_inventory;
--
-- Confirm these critical indexes are present:
--
--   businesses:
--     ✓ idx_businesses_whatsapp_number   (WHERE whatsapp_number IS NOT NULL)
--     ✓ idx_businesses_subscription_status
--
--   conversations:
--     ✓ idx_conversations_business_customer
--     ✓ idx_conversations_business_last_message
--     ✓ idx_conversations_last_message_at
--     ✓ idx_conversations_business_status
--
--   messages:
--     ✓ idx_messages_conversation_created_covering  ← most critical
--     ✓ idx_messages_sid
--
--   orders:
--     ✓ idx_orders_paystack_reference
--     ✓ idx_orders_status_created
--
--   subscriptions:
--     ✓ idx_subscriptions_business_id
--     ✓ idx_subscriptions_paystack_code
--     ✓ idx_subscriptions_trial_ends_at
--
--   webhook_events:
--     ✓ idx_webhook_events_event_source  ← idempotency key
--     ✓ idx_webhook_events_status_received
--
-- If any are missing, re-run this migration.
