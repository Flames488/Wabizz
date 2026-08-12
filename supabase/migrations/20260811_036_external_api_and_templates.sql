-- ============================================================================
-- Migration 036 — External send API, reply-forwarding, and WhatsApp templates
--
-- Adds the schema needed for third-party integrations (e.g. Vitar) to:
--   1. Send messages through a business via a Bearer-token API key
--      (businesses.external_api_key_hash — SHA-256 hash, never the raw key)
--   2. Have inbound replies from contacts they messaged forwarded to their
--      own webhook (businesses.reply_webhook_url / reply_webhook_secret,
--      contacts.source = 'api' marks which contacts came in this way)
--   3. Send approved WhatsApp templates for cold first-contact
--      (new message_templates table tracks submission -> Meta review -> send)
--
-- Nothing here auto-enables anything — external_api_enabled defaults FALSE
-- and no business has a webhook URL configured until explicitly set.
-- ============================================================================

-- ── External send API ───────────────────────────────────────────────────────

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS external_api_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS external_api_key_hash TEXT,
  ADD COLUMN IF NOT EXISTS external_api_key_label TEXT,
  ADD COLUMN IF NOT EXISTS external_api_key_created_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS external_api_key_last_used_at TIMESTAMPTZ;

-- Fast lookup by key hash on every /api/send request. Partial index since most
-- businesses will never have external API access.
CREATE UNIQUE INDEX IF NOT EXISTS businesses_external_api_key_hash_idx
  ON businesses (external_api_key_hash)
  WHERE external_api_key_hash IS NOT NULL;

-- ── Reply forwarding ─────────────────────────────────────────────────────────

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS reply_webhook_url TEXT,
  ADD COLUMN IF NOT EXISTS reply_webhook_secret TEXT;

COMMENT ON COLUMN businesses.reply_webhook_url IS
  'If set, inbound replies from contacts with source=''api'' are forwarded here as POST {phone, message_text, received_at} with header X-Wabizz-Webhook-Secret.';

-- ── WhatsApp message templates ──────────────────────────────────────────────
-- Tracks templates submitted to Meta for approval. A template must reach
-- status='approved' before it can be used for cold first-contact sends.

CREATE TABLE IF NOT EXISTS message_templates (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,          -- Meta template name (lowercase, underscores)
  language        TEXT NOT NULL DEFAULT 'en',
  category        TEXT NOT NULL DEFAULT 'UTILITY' CHECK (category IN ('UTILITY', 'MARKETING', 'AUTHENTICATION')),
  components      JSONB NOT NULL DEFAULT '[]',  -- Meta template component definitions (body/header/buttons)
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'disabled')),
  meta_template_id TEXT,                  -- Meta's ID for this template, once submitted
  rejection_reason TEXT,
  submitted_at    TIMESTAMPTZ,
  reviewed_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (business_id, name, language)
);

CREATE INDEX IF NOT EXISTS message_templates_business_id_idx ON message_templates (business_id);
CREATE INDEX IF NOT EXISTS message_templates_status_idx ON message_templates (business_id, status);

CREATE OR REPLACE FUNCTION set_message_templates_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS message_templates_updated_at ON message_templates;
CREATE TRIGGER message_templates_updated_at
  BEFORE UPDATE ON message_templates
  FOR EACH ROW EXECUTE PROCEDURE set_message_templates_updated_at();

ALTER TABLE message_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY message_templates_select ON message_templates FOR SELECT
  USING (EXISTS (SELECT 1 FROM businesses b WHERE b.id = message_templates.business_id AND b.owner_id = auth.uid()));

CREATE POLICY message_templates_all ON message_templates FOR ALL
  USING (EXISTS (SELECT 1 FROM businesses b WHERE b.id = message_templates.business_id AND b.owner_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM businesses b WHERE b.id = message_templates.business_id AND b.owner_id = auth.uid()));
