-- Migration: 20260428_011_conversation_detail_and_limits.sql
--
-- Supports:
--   1. Conversation detail view — ensure messages are queryable by conversation_id + created_at
--   2. Monthly conversation count for plan limit enforcement
--   3. needs_you notification dedup (optional notification_log entry)

-- Index for fast message thread fetch (conversation detail page)
create index if not exists idx_messages_conversation_created
  on messages (conversation_id, created_at asc);

-- Index for fast monthly conversation count per business
create index if not exists idx_conversations_business_created
  on conversations (business_id, created_at desc);

-- Ensure the status column supports all values used by the handler
-- (open, needs_you, handled, awaiting_payment, payment_confirmation_pending, order_placed, cancelled)
-- No enum change needed — status is already a text column.

-- Add a composite index to speed up the dashboard query
create index if not exists idx_conversations_business_last_message
  on conversations (business_id, last_message_at desc);
