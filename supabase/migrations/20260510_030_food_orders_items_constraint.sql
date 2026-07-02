-- Migration 030: Add DB-level CHECK constraint to food_orders.items JSONB column
--
-- Fix 4 (High): Without schema validation, a malformed insert (wrong keys,
-- negative qty, missing unit_price) is stored silently and breaks the orders
-- dashboard when it tries to render order line items.
--
-- This constraint enforces that items is always a JSON array where every
-- element has: menu_item_id (string), name (string), qty > 0, unit_price >= 0.
-- Silently invalid inserts now fail fast at the DB layer with a clear error.

ALTER TABLE food_orders
  ADD CONSTRAINT chk_food_orders_items_structure
  CHECK (
    jsonb_typeof(items) = 'array'
    AND (
      -- Allow empty cart (items = '[]') — total_amount check handles the zero case
      jsonb_array_length(items) = 0
      OR (
        SELECT bool_and(
          (elem->>'menu_item_id') IS NOT NULL
          AND (elem->>'name') IS NOT NULL
          AND (elem->>'qty') IS NOT NULL
          AND (elem->>'unit_price') IS NOT NULL
          AND (elem->>'qty')::numeric > 0
          AND (elem->>'unit_price')::numeric >= 0
        )
        FROM jsonb_array_elements(items) AS elem
      )
    )
  );

COMMENT ON CONSTRAINT chk_food_orders_items_structure ON food_orders IS
  'Enforces minimum structure on items JSONB array: each element must have '
  'menu_item_id, name, qty > 0, and unit_price >= 0. Prevents silent corruption '
  'of the orders dashboard. Added in Fix 4 (migration 030).';
