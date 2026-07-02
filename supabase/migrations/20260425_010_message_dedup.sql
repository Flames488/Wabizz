-- ============================================================================
-- Migration 010 — Message deduplication via Twilio MessageSid
--
-- Twilio retries webhooks if a 200 response isn't received within 15 seconds.
-- Without dedup, a retry inserts the customer's message twice, causing the AI
-- to see a duplicate and potentially reply twice.
--
-- Fix: Add message_sid column with a unique constraint on messages table.
-- The webhook handler uses ON CONFLICT DO NOTHING to make inserts idempotent.
-- ============================================================================

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS message_sid text DEFAULT NULL;

-- Unique index: one row per Twilio MessageSid (allows NULL for non-Twilio messages)
CREATE UNIQUE INDEX IF NOT EXISTS messages_message_sid_unique_idx
  ON public.messages(message_sid)
  WHERE message_sid IS NOT NULL;
