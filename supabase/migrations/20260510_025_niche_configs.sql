-- Migration 025: Niche module configuration table
-- Adds per-business niche module registry (hospital, food_trader)
-- API keys are stored in Supabase Vault — never in plain columns.

-- ── Table ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS business_niche_configs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  niche         TEXT NOT NULL CHECK (niche IN ('hospital', 'food_trader')),
  config        JSONB NOT NULL DEFAULT '{}',
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now(),
  UNIQUE(business_id, niche)
);

-- ── Indexes ───────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_business_niche_configs_business_id
  ON business_niche_configs(business_id);

CREATE INDEX IF NOT EXISTS idx_business_niche_configs_active
  ON business_niche_configs(business_id, is_active)
  WHERE is_active = true;

-- ── Auto-update updated_at ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_business_niche_configs_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_business_niche_configs_updated_at ON business_niche_configs;
CREATE TRIGGER trg_business_niche_configs_updated_at
  BEFORE UPDATE ON business_niche_configs
  FOR EACH ROW EXECUTE FUNCTION update_business_niche_configs_updated_at();

-- ── Row-Level Security ────────────────────────────────────────────────────────
ALTER TABLE business_niche_configs ENABLE ROW LEVEL SECURITY;

-- Businesses can only read/write their own niche configs
CREATE POLICY "niche_configs_owner_select" ON business_niche_configs
  FOR SELECT USING (
    business_id IN (
      SELECT id FROM businesses WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "niche_configs_owner_insert" ON business_niche_configs
  FOR INSERT WITH CHECK (
    business_id IN (
      SELECT id FROM businesses WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "niche_configs_owner_update" ON business_niche_configs
  FOR UPDATE USING (
    business_id IN (
      SELECT id FROM businesses WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "niche_configs_owner_delete" ON business_niche_configs
  FOR DELETE USING (
    business_id IN (
      SELECT id FROM businesses WHERE user_id = auth.uid()
    )
  );

-- Service role bypasses RLS for server-side reads
CREATE POLICY "niche_configs_service_role" ON business_niche_configs
  FOR ALL USING (auth.role() = 'service_role');

-- ── Conversation state column (multi-turn flows) ───────────────────────────────
-- Add state JSONB to conversations if it doesn't already exist.
-- Stores booking flow state: { flow, step, doctor_id, slots_shown, ... }
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS state JSONB DEFAULT '{}';

COMMENT ON COLUMN conversations.state IS
  'Niche module multi-turn conversation state. Keys: flow, step, and flow-specific data.';
