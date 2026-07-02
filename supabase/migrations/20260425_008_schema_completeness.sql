-- ============================================================================
-- Migration 008 — Schema completeness
--
-- Adds columns and tables that are referenced in application code but were
-- never formally added to the database via a migration:
--
--  1. conversations.last_message_content  — dashboard denormalized preview
--  2. conversations.last_message_role     — dashboard denormalized preview
--  3. businesses.whatsapp_number          — synced copy of businesses.whatsapp
--                                           used by reminders.ts (already
--                                           backfilled in migration 006 via
--                                           a trigger, but the column itself
--                                           may be missing on fresh installs
--                                           if 006 ran before this)
--  4. notification_log table              — payment/trial reminder dedup store
--                                           (referenced in reminders.ts but
--                                           never created by any prior migration)
--  5. error_logs table                    — server-logger.ts persists to this;
--                                           referenced in 001 but not always
--                                           present on fresh installs
-- ============================================================================

-- ── 1 & 2. conversations: denormalized last-message columns ─────────────────
ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS last_message_content text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS last_message_role     text DEFAULT NULL
    CHECK (last_message_role IN ('user', 'assistant'));

-- Backfill from messages table for existing rows
UPDATE public.conversations c
SET
  last_message_content = m.content,
  last_message_role    = m.role
FROM (
  SELECT DISTINCT ON (conversation_id)
    conversation_id,
    content,
    role
  FROM public.messages
  ORDER BY conversation_id, created_at DESC
) m
WHERE m.conversation_id = c.id
  AND c.last_message_content IS NULL;

-- ── 3. businesses: whatsapp_number column ────────────────────────────────────
ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS whatsapp_number text DEFAULT NULL;

-- Backfill from whatsapp column for any rows that don't have it yet
UPDATE public.businesses
SET whatsapp_number = whatsapp
WHERE whatsapp_number IS NULL;

-- Keep in sync via trigger (idempotent — recreate)
CREATE OR REPLACE FUNCTION public.sync_whatsapp_number()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.whatsapp_number = NEW.whatsapp;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS businesses_sync_whatsapp_number ON public.businesses;
CREATE TRIGGER businesses_sync_whatsapp_number
  BEFORE INSERT OR UPDATE OF whatsapp ON public.businesses
  FOR EACH ROW EXECUTE FUNCTION public.sync_whatsapp_number();

-- ── 4. notification_log — reminder dedup store ───────────────────────────────
CREATE TABLE IF NOT EXISTS public.notification_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  type        text NOT NULL,  -- 'trial_expiry_24h' | 'payment_reminder' | 'subscription_renewal'
  meta        jsonb NOT NULL DEFAULT '{}',
  sent_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notification_log_business_type_idx
  ON public.notification_log(business_id, type);

-- Partial index for payment_reminder dedup query (reminders.ts):
--   .eq("type", "payment_reminder").in("meta->>'order_id'", orderIds)
CREATE INDEX IF NOT EXISTS notification_log_payment_reminder_order_idx
  ON public.notification_log ((meta->>'order_id'))
  WHERE type = 'payment_reminder';

ALTER TABLE public.notification_log ENABLE ROW LEVEL SECURITY;

-- Service role only — reminders run server-side
-- No authenticated user policy needed; reads/writes go through supabaseAdmin

-- ── 5. error_logs — server-logger persistence target ─────────────────────────
CREATE TABLE IF NOT EXISTS public.error_logs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source      text NOT NULL,
  message     text NOT NULL,
  level       text NOT NULL DEFAULT 'error'
    CHECK (level IN ('debug', 'info', 'warn', 'error', 'fatal')),
  context     jsonb NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS error_logs_level_occurred_idx
  ON public.error_logs(level, occurred_at DESC);

CREATE INDEX IF NOT EXISTS error_logs_source_occurred_idx
  ON public.error_logs(source, occurred_at DESC);

ALTER TABLE public.error_logs ENABLE ROW LEVEL SECURITY;
-- No RLS policies — service role only. Dashboard reads should go through a
-- server function; never expose raw error logs to the browser client.
