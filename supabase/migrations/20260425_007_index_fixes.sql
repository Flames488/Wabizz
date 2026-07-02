-- ============================================================================
-- Index fixes
--
-- 1. messages: replace ASC index with DESC to match getMessageHistory query
--    (ORDER BY created_at DESC LIMIT 20).  A DESC index lets Postgres scan
--    forward instead of backward, turning a full reverse-scan into a fast
--    index-only scan on high-volume conversations.
--
-- 2. notification_log: add a composite index on (type, meta->>'order_id') for
--    the payment_reminder dedup query that filters by type AND order_id in meta.
--    The existing GIN index covers ad-hoc jsonb contains queries but does not
--    help the equality lookup on a specific key used in the dedup path.
-- ============================================================================

-- ── 1. Fix messages history index ────────────────────────────────────────────
-- Drop the old ASC index and recreate as DESC.
-- CREATE INDEX IF NOT EXISTS is not available for index direction changes,
-- so we drop-then-create (both ops are fast on an empty-ish index in dev;
-- on production run this in a maintenance window or use CONCURRENTLY).

DROP INDEX IF EXISTS public.messages_conversation_created_idx;

CREATE INDEX CONCURRENTLY IF NOT EXISTS messages_conversation_created_desc_idx
  ON public.messages(conversation_id, created_at DESC);

-- ── 2. notification_log: targeted index for payment_reminder dedup ───────────
-- The query in reminders.ts does:
--   .eq("type", "payment_reminder")
--   .in("meta->>order_id", orderIds)
-- A partial index on type + the extracted text key is the most efficient plan.

CREATE INDEX IF NOT EXISTS notification_log_payment_reminder_order_idx
  ON public.notification_log ((meta->>'order_id'))
  WHERE type = 'payment_reminder';
