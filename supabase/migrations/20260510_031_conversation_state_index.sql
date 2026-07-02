-- Migration 031: Partial index on conversations.state for active niche flow lookups
--
-- Fix 5 (Medium): The state JSONB column added in migration 025 has no index.
-- Any query that finds conversations with an active niche flow
-- (e.g. WHERE state->>'flow' IS NOT NULL) performs a full table scan.
-- At 10k+ users the conversations table is large and this becomes expensive.
--
-- This partial index only indexes rows that actually have an active flow,
-- keeping the index small while covering the exact access pattern used by:
--   - Cleanup jobs (detect stale flows older than N hours)
--   - Analytics (count conversations by flow type)
--   - Niche handlers (look up mid-flow conversations)

CREATE INDEX IF NOT EXISTS idx_conversations_active_flow
  ON conversations ((state->>'flow'))
  WHERE state->>'flow' IS NOT NULL;

COMMENT ON INDEX idx_conversations_active_flow IS
  'Partial index for conversations with an active niche flow. '
  'Covers cleanup jobs, analytics, and stale-flow detection. '
  'Only indexes non-NULL state->>flow rows to stay compact. Added in Fix 5 (migration 031).';
