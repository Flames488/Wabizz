-- Migration 027: Food trader orders table

-- ── Table ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS food_orders (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id      UUID NOT NULL REFERENCES businesses(id),
  customer_phone   TEXT NOT NULL,
  customer_name    TEXT,
  -- items: [{menu_item_id, name, qty, unit_price}]
  items            JSONB NOT NULL DEFAULT '[]',
  total_amount     NUMERIC(10, 2) NOT NULL CHECK (total_amount >= 0),
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'paid', 'preparing', 'ready', 'delivered', 'cancelled')),
  delivery_type    TEXT CHECK (delivery_type IN ('pickup', 'delivery')),
  delivery_address TEXT,
  paystack_ref     TEXT,
  payment_status   TEXT NOT NULL DEFAULT 'unpaid'
                   CHECK (payment_status IN ('unpaid', 'paid')),
  notes            TEXT,
  created_at       TIMESTAMPTZ DEFAULT now(),
  updated_at       TIMESTAMPTZ DEFAULT now()
);

-- ── Indexes ───────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_food_orders_business_id
  ON food_orders(business_id);

CREATE INDEX IF NOT EXISTS idx_food_orders_customer_phone
  ON food_orders(business_id, customer_phone);

CREATE INDEX IF NOT EXISTS idx_food_orders_status
  ON food_orders(business_id, status);

CREATE INDEX IF NOT EXISTS idx_food_orders_paystack_ref
  ON food_orders(paystack_ref)
  WHERE paystack_ref IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_food_orders_created_at
  ON food_orders(business_id, created_at DESC);

-- ── Auto-update updated_at ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_food_orders_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_food_orders_updated_at ON food_orders;
CREATE TRIGGER trg_food_orders_updated_at
  BEFORE UPDATE ON food_orders
  FOR EACH ROW EXECUTE FUNCTION update_food_orders_updated_at();

-- ── Row-Level Security ────────────────────────────────────────────────────────
ALTER TABLE food_orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "food_orders_owner_select" ON food_orders
  FOR SELECT USING (
    business_id IN (
      SELECT id FROM businesses WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "food_orders_owner_insert" ON food_orders
  FOR INSERT WITH CHECK (
    business_id IN (
      SELECT id FROM businesses WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "food_orders_owner_update" ON food_orders
  FOR UPDATE USING (
    business_id IN (
      SELECT id FROM businesses WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "food_orders_service_role" ON food_orders
  FOR ALL USING (auth.role() = 'service_role');
