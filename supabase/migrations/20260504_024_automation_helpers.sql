-- Migration 024: Automation rule match counter + contact auto-upsert safety
--
-- Fixes:
--   1. add_tags column upsert for automation tag actions uses array_cat
--      to merge tags rather than overwriting them.
--   2. increment_automation_match_count() DB function for safe counter increment.
--   3. Index on contacts.phone for fast opt-out lookups from automation.
--   4. created_at index on campaign_contacts for fast batch offset queries.

-- ── increment_automation_match_count ─────────────────────────────────────────

CREATE OR REPLACE FUNCTION increment_automation_match_count(p_rule_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE automation_rules SET match_count = match_count + 1 WHERE id = p_rule_id;
END; $$;

-- ── merge_contact_tags ────────────────────────────────────────────────────────
-- Merges incoming tags with existing tags (deduped). Used by automation tag action.

CREATE OR REPLACE FUNCTION merge_contact_tags(
  p_business_id UUID,
  p_phone       TEXT,
  p_add_tags    TEXT[]
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE contacts
  SET tags = ARRAY(
    SELECT DISTINCT unnest(tags || p_add_tags)
  )
  WHERE business_id = p_business_id AND phone = p_phone;
END; $$;

-- ── Additional indexes ────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS contacts_phone_idx
  ON contacts (phone);

CREATE INDEX IF NOT EXISTS contacts_business_opted_out_idx
  ON contacts (business_id, opted_out, phone);

CREATE INDEX IF NOT EXISTS cc_batch_idx
  ON campaign_contacts (campaign_id, status, id);

-- ── View: campaign_summary (for admin dashboard) ──────────────────────────────

CREATE OR REPLACE VIEW campaign_summary AS
SELECT
  c.id,
  c.business_id,
  c.name,
  c.status,
  c.total_contacts,
  c.sent_count,
  c.failed_count,
  c.pending_count,
  c.launched_at,
  c.completed_at,
  ROUND(
    CASE WHEN c.total_contacts > 0
    THEN (c.sent_count::NUMERIC / c.total_contacts::NUMERIC) * 100
    ELSE 0 END,
    1
  ) AS success_rate_pct,
  c.created_at
FROM campaigns c;
