-- ============================================================================
-- Migration 015 — v11 Audit Fixes
--
-- Addresses issues found during the v10 audit pass:
--
--   FIX 1  — Index on whatsapp_config.business_number for fast number→business
--             lookups. The webhook does this on every inbound message; without
--             an index it does a full table scan as business count grows.
--
--   FIX 2  — Partial index on conversations(business_id, created_at) for the
--             monthly count query used by plan limit enforcement. Previously
--             used the generic conversations_business_idx which doesn't filter
--             by created_at range efficiently.
--
--   FIX 3  — Add `plan_count` cache key namespace comment (documentation only;
--             the actual key is ephemeral in Redis/KV — no schema change needed).
--
-- Idempotent: uses CREATE INDEX IF NOT EXISTS.
-- ============================================================================

-- FIX 1: index for whatsapp number → business_id lookup
-- Used by: twilio-webhook.ts on every inbound message
CREATE INDEX IF NOT EXISTS idx_whatsapp_config_business_number
  ON public.whatsapp_config (business_number);

-- Also index without + prefix variant (some carriers strip it)
CREATE INDEX IF NOT EXISTS idx_whatsapp_config_business_number_stripped
  ON public.whatsapp_config ((REPLACE(business_number, '+', '')));

-- FIX 2: index for monthly conversation count (plan limit enforcement)
-- Used by: twilio-webhook getPlanAndMonthlyCount — COUNT(*) per business per month
CREATE INDEX IF NOT EXISTS idx_conversations_business_created
  ON public.conversations (business_id, created_at DESC);

-- FIX 3: ensure subscriptions index covers the plan_id lookup
-- getPlanAndMonthlyCount does: ORDER BY created_at DESC LIMIT 1 WHERE business_id = ?
-- The existing idx_subscriptions_business_id covers this, but add plan_id for index-only scan
CREATE INDEX IF NOT EXISTS idx_subscriptions_business_plan
  ON public.subscriptions (business_id, created_at DESC)
  INCLUDE (plan_id);
