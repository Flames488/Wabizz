-- Migration 023: Campaigns & Contacts
-- Adds the autonomous campaign engine tables.
--
-- Tables added:
--   contacts            — per-business contact list (phone, name, tags, opt-out)
--   campaigns           — campaign definitions (name, template, schedule, status)
--   campaign_contacts   — per-campaign per-contact delivery tracking
--   automation_rules    — if/then automation triggers (keyword replies, event hooks)
--
-- All tables have RLS. Businesses can only see their own rows.
-- Service-role key bypasses RLS for queue worker operations.

-- ── contacts ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS contacts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  phone           TEXT NOT NULL,
  name            TEXT,
  tags            TEXT[]   DEFAULT '{}',
  opted_out       BOOLEAN  NOT NULL DEFAULT FALSE,
  opted_out_at    TIMESTAMPTZ,
  source          TEXT     DEFAULT 'manual',   -- 'manual' | 'import' | 'chat'
  last_messaged_at TIMESTAMPTZ,
  metadata        JSONB    DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Prevent duplicate phone per business
  UNIQUE (business_id, phone)
);

CREATE INDEX IF NOT EXISTS contacts_business_id_idx     ON contacts (business_id);
CREATE INDEX IF NOT EXISTS contacts_business_phone_idx  ON contacts (business_id, phone);
CREATE INDEX IF NOT EXISTS contacts_tags_idx            ON contacts USING GIN (tags);
CREATE INDEX IF NOT EXISTS contacts_opted_out_idx       ON contacts (business_id, opted_out);

-- auto-update updated_at
CREATE OR REPLACE FUNCTION set_contacts_updated_at()
  RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS contacts_updated_at ON contacts;
CREATE TRIGGER contacts_updated_at
  BEFORE UPDATE ON contacts
  FOR EACH ROW EXECUTE PROCEDURE set_contacts_updated_at();

-- RLS
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;

CREATE POLICY contacts_select ON contacts FOR SELECT
  USING (business_id IN (
    SELECT id FROM businesses WHERE owner_id = auth.uid()
  ));

CREATE POLICY contacts_insert ON contacts FOR INSERT
  WITH CHECK (business_id IN (
    SELECT id FROM businesses WHERE owner_id = auth.uid()
  ));

CREATE POLICY contacts_update ON contacts FOR UPDATE
  USING (business_id IN (
    SELECT id FROM businesses WHERE owner_id = auth.uid()
  ));

CREATE POLICY contacts_delete ON contacts FOR DELETE
  USING (business_id IN (
    SELECT id FROM businesses WHERE owner_id = auth.uid()
  ));


-- ── campaigns ─────────────────────────────────────────────────────────────────

CREATE TYPE campaign_status AS ENUM (
  'draft', 'scheduled', 'running', 'paused', 'completed', 'failed', 'cancelled'
);

CREATE TABLE IF NOT EXISTS campaigns (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id       UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  status            campaign_status NOT NULL DEFAULT 'draft',

  -- Message content
  message_template  TEXT NOT NULL,                        -- plain text, supports {{name}} merge tag
  media_url         TEXT,                                 -- optional image/doc attachment URL

  -- Targeting: array of contact IDs. NULL = all non-opted-out contacts.
  target_contact_ids UUID[],
  target_tags        TEXT[],                              -- filter by tags (OR logic)
  estimated_reach    INTEGER DEFAULT 0,

  -- Scheduling
  scheduled_at       TIMESTAMPTZ,                         -- NULL = send immediately on launch
  timezone           TEXT DEFAULT 'Africa/Lagos',
  send_window_start  TIME DEFAULT '08:00',                -- local time window start
  send_window_end    TIME DEFAULT '20:00',                -- local time window end

  -- Rate control
  batch_size         INTEGER NOT NULL DEFAULT 100,        -- contacts per queue batch
  messages_per_min   INTEGER NOT NULL DEFAULT 60,         -- rate limit for this campaign

  -- Execution tracking
  launched_at        TIMESTAMPTZ,
  completed_at       TIMESTAMPTZ,
  paused_at          TIMESTAMPTZ,
  total_contacts     INTEGER DEFAULT 0,
  sent_count         INTEGER DEFAULT 0,
  failed_count       INTEGER DEFAULT 0,
  pending_count      INTEGER DEFAULT 0,
  last_error         TEXT,

  -- Audit
  created_by         UUID REFERENCES auth.users(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS campaigns_business_id_idx  ON campaigns (business_id);
CREATE INDEX IF NOT EXISTS campaigns_status_idx       ON campaigns (status);
CREATE INDEX IF NOT EXISTS campaigns_scheduled_at_idx ON campaigns (scheduled_at) WHERE scheduled_at IS NOT NULL;

CREATE OR REPLACE FUNCTION set_campaigns_updated_at()
  RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS campaigns_updated_at ON campaigns;
CREATE TRIGGER campaigns_updated_at
  BEFORE UPDATE ON campaigns
  FOR EACH ROW EXECUTE PROCEDURE set_campaigns_updated_at();

-- RLS
ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;

CREATE POLICY campaigns_select ON campaigns FOR SELECT
  USING (business_id IN (
    SELECT id FROM businesses WHERE owner_id = auth.uid()
  ));

CREATE POLICY campaigns_insert ON campaigns FOR INSERT
  WITH CHECK (business_id IN (
    SELECT id FROM businesses WHERE owner_id = auth.uid()
  ));

CREATE POLICY campaigns_update ON campaigns FOR UPDATE
  USING (business_id IN (
    SELECT id FROM businesses WHERE owner_id = auth.uid()
  ));

CREATE POLICY campaigns_delete ON campaigns FOR DELETE
  USING (business_id IN (
    SELECT id FROM businesses WHERE owner_id = auth.uid()
  ));


-- ── campaign_contacts ─────────────────────────────────────────────────────────

CREATE TYPE campaign_contact_status AS ENUM (
  'pending', 'queued', 'sent', 'failed', 'skipped'
);

CREATE TABLE IF NOT EXISTS campaign_contacts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id  UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  contact_id   UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  phone        TEXT NOT NULL,                          -- denormalised for fast queue processing
  name         TEXT,
  status       campaign_contact_status NOT NULL DEFAULT 'pending',
  queued_at    TIMESTAMPTZ,
  sent_at      TIMESTAMPTZ,
  failed_at    TIMESTAMPTZ,
  error        TEXT,
  message_sid  TEXT,                                   -- 360dialog message ID on success

  UNIQUE (campaign_id, contact_id)
);

CREATE INDEX IF NOT EXISTS cc_campaign_id_idx ON campaign_contacts (campaign_id);
CREATE INDEX IF NOT EXISTS cc_status_idx      ON campaign_contacts (campaign_id, status);
CREATE INDEX IF NOT EXISTS cc_contact_id_idx  ON campaign_contacts (contact_id);

-- RLS: inherit via campaign_id
ALTER TABLE campaign_contacts ENABLE ROW LEVEL SECURITY;

CREATE POLICY cc_select ON campaign_contacts FOR SELECT
  USING (campaign_id IN (
    SELECT id FROM campaigns WHERE business_id IN (
      SELECT id FROM businesses WHERE owner_id = auth.uid()
    )
  ));

CREATE POLICY cc_all ON campaign_contacts FOR ALL
  USING (campaign_id IN (
    SELECT id FROM campaigns WHERE business_id IN (
      SELECT id FROM businesses WHERE owner_id = auth.uid()
    )
  ));


-- ── automation_rules ─────────────────────────────────────────────────────────
-- Keyword-based auto-reply rules. Matched in twilio-handler.ts inbound flow.

CREATE TABLE IF NOT EXISTS automation_rules (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  priority      INTEGER NOT NULL DEFAULT 0,           -- higher = matched first

  -- Trigger
  trigger_type  TEXT NOT NULL DEFAULT 'keyword',      -- 'keyword' | 'no_reply' | 'opt_out'
  keywords      TEXT[]  DEFAULT '{}',                 -- case-insensitive match (any keyword)
  match_mode    TEXT    DEFAULT 'contains',           -- 'exact' | 'contains' | 'starts_with'

  -- Action
  action_type   TEXT NOT NULL DEFAULT 'reply',        -- 'reply' | 'tag' | 'opt_out' | 'campaign'
  reply_template TEXT,                                -- supports {{name}}, {{business_name}}
  add_tags      TEXT[]  DEFAULT '{}',
  campaign_id   UUID REFERENCES campaigns(id),        -- for action_type='campaign'

  -- Stats
  match_count   INTEGER DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ar_business_id_idx  ON automation_rules (business_id, is_active);
CREATE INDEX IF NOT EXISTS ar_keywords_idx     ON automation_rules USING GIN (keywords);

ALTER TABLE automation_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY ar_business ON automation_rules FOR ALL
  USING (business_id IN (
    SELECT id FROM businesses WHERE owner_id = auth.uid()
  ));


-- ── DB function: increment campaign counters atomically ────────────────────────

CREATE OR REPLACE FUNCTION increment_campaign_counter(
  p_campaign_id   UUID,
  p_sent_delta    INTEGER DEFAULT 0,
  p_failed_delta  INTEGER DEFAULT 0,
  p_pending_delta INTEGER DEFAULT 0
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE campaigns SET
    sent_count    = sent_count    + p_sent_delta,
    failed_count  = failed_count  + p_failed_delta,
    pending_count = GREATEST(0, pending_count + p_pending_delta),
    updated_at    = NOW()
  WHERE id = p_campaign_id;
END; $$;


-- ── DB function: bulk-populate campaign_contacts from contacts table ───────────

CREATE OR REPLACE FUNCTION populate_campaign_contacts(p_campaign_id UUID)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_campaign  campaigns%ROWTYPE;
  v_count     INTEGER;
BEGIN
  SELECT * INTO v_campaign FROM campaigns WHERE id = p_campaign_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Campaign not found'; END IF;

  -- Insert matching contacts, skip opted-out, skip duplicates
  INSERT INTO campaign_contacts (campaign_id, contact_id, phone, name, status)
  SELECT
    p_campaign_id,
    c.id,
    c.phone,
    c.name,
    'pending'::campaign_contact_status
  FROM contacts c
  WHERE c.business_id = v_campaign.business_id
    AND c.opted_out = FALSE
    -- If target_contact_ids is set, filter to those contacts
    AND (v_campaign.target_contact_ids IS NULL
         OR c.id = ANY(v_campaign.target_contact_ids))
    -- If target_tags is set, contacts must have at least one matching tag
    AND (v_campaign.target_tags IS NULL
         OR c.tags && v_campaign.target_tags)
  ON CONFLICT (campaign_id, contact_id) DO NOTHING;

  GET DIAGNOSTICS v_count = ROW_COUNT;

  -- Update campaign totals
  UPDATE campaigns SET
    total_contacts = v_count,
    pending_count  = v_count,
    updated_at     = NOW()
  WHERE id = p_campaign_id;

  RETURN v_count;
END; $$;
