/**
 * src/lib/niche/food/order-service.ts
 *
 * Order creation, retrieval, status management, and Paystack payment link
 * generation for the food trader niche module.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { logError, logInfo } from "@/lib/server-logger";
import type { FoodOrder, OrderItem, OrderStatus } from "./types";
/**
 * Server-side Paystack initialization using the Wabizz platform secret key.
 * Calls Paystack's /transaction/initialize endpoint directly.
 */
async function initPaystackTransaction(opts: {
  amount: number; // in kobo
  email: string;
  reference: string;
  metadata: Record<string, unknown>;
}): Promise<string | null> {
  const secretKey =
    (typeof process !== "undefined" ? process.env.WABIZZ_PAYSTACK_SECRET_KEY : undefined) ??
    (typeof globalThis !== "undefined"
      ? ((globalThis as Record<string, unknown>).WABIZZ_PAYSTACK_SECRET_KEY as string)
      : undefined);

  if (!secretKey) return null;

  try {
    const resp = await fetch("https://api.paystack.co/transaction/initialize", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(opts),
    });
    const json = (await resp.json()) as { status: boolean; data?: { authorization_url: string } };
    return json?.data?.authorization_url ?? null;
  } catch {
    return null;
  }
}

// ── Create ────────────────────────────────────────────────────────────────────

export interface CreateOrderInput {
  business_id: string;
  customer_phone: string;
  customer_name: string | null;
  items: OrderItem[];
  delivery_type?: "pickup" | "delivery";
  delivery_address?: string;
  notes?: string;
}

/**
 * Persists a new food order to the database.
 * total_amount is computed from items to prevent tampering.
 */
export async function createOrder(input: CreateOrderInput): Promise<FoodOrder | null> {
  const total = input.items.reduce((sum, i) => sum + i.qty * i.unit_price, 0);

  const { data, error } = await supabaseAdmin
    .from("food_orders")
    .insert({
      business_id: input.business_id,
      customer_phone: input.customer_phone,
      customer_name: input.customer_name,
      items: input.items,
      total_amount: total,
      delivery_type: input.delivery_type ?? null,
      delivery_address: input.delivery_address ?? null,
      notes: input.notes ?? null,
    })
    .select()
    .single();

  if (error) {
    await logError("order-service", "createOrder failed", { error: error.message });
    return null;
  }

  await logInfo("order-service", "Order created", {
    orderId: data.id,
    total,
    businessId: input.business_id,
  });

  return data as FoodOrder;
}

// ── Read ──────────────────────────────────────────────────────────────────────

/**
 * Returns the most recent order for a customer phone number.
 */
export async function getLatestOrder(
  businessId: string,
  customerPhone: string,
): Promise<FoodOrder | null> {
  const { data, error } = await supabaseAdmin
    .from("food_orders")
    .select("*")
    .eq("business_id", businessId)
    .eq("customer_phone", customerPhone)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (error || !data) return null;
  return data as FoodOrder;
}

/**
 * Returns an order by its UUID.
 */
export async function getOrderById(orderId: string): Promise<FoodOrder | null> {
  const { data, error } = await supabaseAdmin
    .from("food_orders")
    .select("*")
    .eq("id", orderId)
    .single();

  if (error || !data) return null;
  return data as FoodOrder;
}

/**
 * Returns all active orders for a business, paginated.
 * Used by the dashboard orders board.
 */
export async function getActiveOrders(businessId: string, limit = 50): Promise<FoodOrder[]> {
  const { data, error } = await supabaseAdmin
    .from("food_orders")
    .select("*")
    .eq("business_id", businessId)
    .not("status", "in", '("delivered","cancelled")')
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    await logError("order-service", "getActiveOrders failed", { error: error.message });
    return [];
  }

  return (data ?? []) as FoodOrder[];
}

// ── Update ────────────────────────────────────────────────────────────────────

/**
 * Updates an order's status.  Validates that the status transition is legal.
 *
 * Allowed transitions:
 *   pending → paid | cancelled
 *   paid → preparing | cancelled
 *   preparing → ready
 *   ready → delivered
 */
export async function updateOrderStatus(
  orderId: string,
  newStatus: OrderStatus,
  requestId = "order-service",
): Promise<boolean> {
  const order = await getOrderById(orderId);
  if (!order) {
    await logError("order-service", "updateOrderStatus: order not found", { orderId }, requestId);
    return false;
  }

  if (!isValidTransition(order.status, newStatus)) {
    await logError(
      "order-service",
      "updateOrderStatus: invalid transition",
      { from: order.status, to: newStatus },
      requestId,
      "warn",
    );
    return false;
  }

  const { error } = await supabaseAdmin
    .from("food_orders")
    .update({ status: newStatus })
    .eq("id", orderId);

  if (error) {
    await logError(
      "order-service",
      "updateOrderStatus failed",
      { error: error.message },
      requestId,
    );
    return false;
  }

  await logInfo(
    "order-service",
    "Order status updated",
    { orderId, from: order.status, to: newStatus },
    requestId,
  );
  return true;
}

/**
 * Marks an order as paid (called from the Paystack webhook handler).
 */
export async function markOrderPaid(
  paystackRef: string,
  requestId = "order-service",
): Promise<FoodOrder | null> {
  const { data, error } = await supabaseAdmin
    .from("food_orders")
    .update({ payment_status: "paid", status: "paid" })
    .eq("paystack_ref", paystackRef)
    .select()
    .single();

  if (error || !data) {
    await logError(
      "order-service",
      "markOrderPaid failed",
      { paystackRef, error: error?.message },
      requestId,
    );
    return null;
  }

  await logInfo(
    "order-service",
    "Order paid via Paystack",
    { orderId: data.id, paystackRef },
    requestId,
  );
  return data as FoodOrder;
}

/**
 * Cancels an order if it hasn't moved past the 'paid' stage.
 * Returns false if the order is already in progress (preparing or later).
 */
export async function cancelOrder(
  orderId: string,
  requestId = "order-service",
): Promise<{ success: boolean; reason?: string }> {
  const order = await getOrderById(orderId);
  if (!order) return { success: false, reason: "order_not_found" };

  if (["preparing", "ready", "delivered"].includes(order.status)) {
    return { success: false, reason: "already_in_progress" };
  }

  if (order.status === "cancelled") {
    return { success: false, reason: "already_cancelled" };
  }

  const { error } = await supabaseAdmin
    .from("food_orders")
    .update({ status: "cancelled" })
    .eq("id", orderId);

  if (error) {
    await logError("order-service", "cancelOrder failed", { error: error.message }, requestId);
    return { success: false, reason: "db_error" };
  }

  return { success: true };
}

// ── Payment link ──────────────────────────────────────────────────────────────

/**
 * Creates a Paystack payment link for a food order and stores the reference.
 * Uses the existing Wabizz Paystack helper.
 */
export async function sendPaymentLink(
  order: FoodOrder,
  customerEmail?: string,
  requestId = "order-service",
): Promise<string | null> {
  try {
    const ref = `food-${order.id.slice(0, 8)}-${Date.now()}`;

    const link = await initPaystackTransaction({
      amount: Math.round(order.total_amount * 100), // Paystack uses kobo
      email: customerEmail ?? `${order.customer_phone.replace("+", "")}@wabizz.app`,
      reference: ref,
      metadata: {
        order_id: order.id,
        business_id: order.business_id,
        type: "food_order",
        customer_phone: order.customer_phone,
      },
    });

    if (link) {
      // Store the reference for webhook reconciliation
      await supabaseAdmin.from("food_orders").update({ paystack_ref: ref }).eq("id", order.id);
    }

    return link;
  } catch (err) {
    await logError(
      "order-service",
      "sendPaymentLink failed",
      { orderId: order.id, err: String(err) },
      requestId,
    );
    return null;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isValidTransition(from: OrderStatus, to: OrderStatus): boolean {
  const transitions: Record<OrderStatus, OrderStatus[]> = {
    pending: ["paid", "cancelled"],
    paid: ["preparing", "cancelled"],
    preparing: ["ready"],
    ready: ["delivered"],
    delivered: [],
    cancelled: [],
  };
  return transitions[from]?.includes(to) ?? false;
}

/** Human-readable status label for WhatsApp replies */
export function statusLabel(status: OrderStatus): string {
  const labels: Record<OrderStatus, string> = {
    pending: "received — waiting for payment",
    paid: "paid — getting ready",
    preparing: "being prepared in the kitchen",
    ready: "ready for pickup/delivery",
    delivered: "delivered",
    cancelled: "cancelled",
  };
  return labels[status] ?? status;
}
