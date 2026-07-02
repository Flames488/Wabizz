/**
 * src/lib/niche/food/types.ts
 *
 * TypeScript types for the food trader niche module.
 */

// ── Menu ──────────────────────────────────────────────────────────────────────

export interface MenuItem {
  id: string;
  business_id: string;
  name: string;
  description: string | null;
  price: number;
  category: string | null;
  is_available: boolean;
  image_url: string | null;
  created_at: string;
  updated_at: string;
}

// ── Order ─────────────────────────────────────────────────────────────────────

export type OrderStatus = "pending" | "paid" | "preparing" | "ready" | "delivered" | "cancelled";

export type DeliveryType = "pickup" | "delivery";
export type PaymentStatus = "unpaid" | "paid";

export interface OrderItem {
  menu_item_id: string;
  name: string;
  qty: number;
  unit_price: number;
}

export interface FoodOrder {
  id: string;
  business_id: string;
  customer_phone: string;
  customer_name: string | null;
  items: OrderItem[];
  total_amount: number;
  status: OrderStatus;
  delivery_type: DeliveryType | null;
  delivery_address: string | null;
  paystack_ref: string | null;
  payment_status: PaymentStatus;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

// ── Menu parsing ──────────────────────────────────────────────────────────────

/** Parsed item from a natural-language order message */
export interface ParsedOrderItem {
  menu_item_id: string;
  name: string;
  qty: number;
  unit_price: number;
}

/** Result of parseOrderFromMessage */
export interface ParseOrderResult {
  matched: ParsedOrderItem[];
  /** Items the customer mentioned that we couldn't match */
  unmatched: string[];
}
