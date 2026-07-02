-- Migration 026: Food trader menu items table

-- ── Table ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS menu_items (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  description  TEXT,
  price        NUMERIC(10, 2) NOT NULL CHECK (price >= 0),
  category     TEXT,
  is_available BOOLEAN DEFAULT true,
  image_url    TEXT,
  created_at   TIMESTAMPTZ DEFAULT now(),
  updated_at   TIMESTAMPTZ DEFAULT now()
);

-- ── Indexes ───────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_menu_items_business_id
  ON menu_items(business_id);

CREATE INDEX IF NOT EXISTS idx_menu_items_available
  ON menu_items(business_id, is_available)
  WHERE is_available = true;

CREATE INDEX IF NOT EXISTS idx_menu_items_category
  ON menu_items(business_id, category);

-- Full-text search index for fuzzy item name matching
CREATE INDEX IF NOT EXISTS idx_menu_items_name_trgm
  ON menu_items USING gin(name gin_trgm_ops);

-- Enable pg_trgm for fuzzy name matching if not already enabled
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ── Auto-update updated_at ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_menu_items_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_menu_items_updated_at ON menu_items;
CREATE TRIGGER trg_menu_items_updated_at
  BEFORE UPDATE ON menu_items
  FOR EACH ROW EXECUTE FUNCTION update_menu_items_updated_at();

-- ── Row-Level Security ────────────────────────────────────────────────────────
ALTER TABLE menu_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "menu_items_owner_select" ON menu_items
  FOR SELECT USING (
    business_id IN (
      SELECT id FROM businesses WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "menu_items_owner_insert" ON menu_items
  FOR INSERT WITH CHECK (
    business_id IN (
      SELECT id FROM businesses WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "menu_items_owner_update" ON menu_items
  FOR UPDATE USING (
    business_id IN (
      SELECT id FROM businesses WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "menu_items_owner_delete" ON menu_items
  FOR DELETE USING (
    business_id IN (
      SELECT id FROM businesses WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "menu_items_service_role" ON menu_items
  FOR ALL USING (auth.role() = 'service_role');
