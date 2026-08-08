/**
 * src/lib/niche/food/food-intent-handler.ts
 *
 * Handles WhatsApp conversation logic for food ordering.
 * Called by niche-router.ts when the food_trader module is active.
 *
 * Returns a reply string if this handler owns the message, or null.
 */

import { logError, logInfo } from "@/lib/server-logger";
import { recordApiCall } from "@/lib/server/admin/metrics";
import { getConversationState, setConversationState } from "../niche-loader";
import { getMenu, formatMenuForWhatsApp, fuzzyMatchItem } from "./menu-service";
import {
  createOrder,
  getLatestOrder,
  cancelOrder,
  sendPaymentLink,
  updateOrderStatus,
  statusLabel,
} from "./order-service";
import type { FoodTraderNicheConfig } from "../types";
import type { FoodOrderConversationState, FoodOrderStep } from "../types";
import type { MenuItem, OrderItem, OrderStatus, ParseOrderResult } from "./types";

// ── Intent regexes ────────────────────────────────────────────────────────────

const INTENTS = {
  MENU: /\b(menu|what.*sell|what.*have|what.*food|show|list|items?|price list)\b/i,
  ORDER: /\b(order|want|give me|i'll have|i need|buy|get me|can i get)\b/i,
  STATUS: /\b(status|where.*order|track|my order|order status|when.*ready|when.*deliver)\b/i,
  CANCEL: /\b(cancel|cancel.*order|don't want)\b/i,
  DELIVERY_FAQ: /\b(deliver|delivery area|where.*deliver|do you deliver)\b/i,
  ITEM_PRICE: /\b(how much|price|cost)\b/i,
  GENERAL_FAQ: /\b(close|open|hours?|time|location|address)\b/i,
  OWNER_CMD: /^ORDER\s+#?([A-Z0-9-]+)\s+(PREPARING|READY|DELIVERED|PAID|CANCELLED)\s*$/i,
} as const;

// ── Exported handler ──────────────────────────────────────────────────────────

export interface FoodHandlerPayload {
  businessId: string;
  conversationId: string;
  customerPhone: string;
  customerName: string | null;
  message: string;
  foodConfig: FoodTraderNicheConfig;
  requestId: string;
}

/**
 * Main entry point called by niche-router.
 */
export async function handleFoodMessage(payload: FoodHandlerPayload): Promise<string | null> {
  const { conversationId, message, foodConfig, requestId } = payload;
  const start = Date.now();

  const rawState = await getConversationState(conversationId, requestId);
  const state = rawState as Partial<FoodOrderConversationState>;

  try {
    // ── Business owner status update command ───────────────────────────────
    const ownerCmd = message.match(INTENTS.OWNER_CMD);
    if (ownerCmd) {
      return handleOwnerCommand(ownerCmd[1], ownerCmd[2], requestId);
    }

    // ── Active order flow continuation ─────────────────────────────────────
    if (state.flow === "food_order") {
      return handleOrderFlow(payload, state as FoodOrderConversationState);
    }

    // ── Fresh intent detection ─────────────────────────────────────────────
    // BUG FIX: CANCEL and STATUS must both be checked before ORDER, and
    // CANCEL before STATUS. ORDER's pattern matches the bare word "order" —
    // present in "where is my order?" and "cancel my order" — so with ORDER
    // checked first it always won, silently swallowing status/cancel
    // requests into "show the menu, what would you like to order?" instead
    // of answering them. Likewise STATUS's "my order" alternative matches
    // "cancel my order", so CANCEL has to come first or it gets shadowed too.
    if (INTENTS.MENU.test(message)) {
      return showMenu(payload);
    }

    if (INTENTS.CANCEL.test(message)) {
      return handleCancelIntent(payload);
    }

    if (INTENTS.STATUS.test(message)) {
      return checkOrderStatus(payload);
    }

    if (INTENTS.ORDER.test(message)) {
      return handleOrderIntent(payload);
    }

    if (INTENTS.DELIVERY_FAQ.test(message)) {
      return deliveryFaq(foodConfig);
    }

    if (INTENTS.ITEM_PRICE.test(message)) {
      return handlePriceQuery(payload, message);
    }

    if (INTENTS.GENERAL_FAQ.test(message)) {
      return generalFaq(foodConfig);
    }

    void recordApiCall({ service: "food_niche", success: true, latencyMs: Date.now() - start });
    return null;
  } catch (err) {
    void recordApiCall({
      service: "food_niche",
      success: false,
      latencyMs: Date.now() - start,
      error: String(err).slice(0, 200),
    });
    await logError(
      "food-handler",
      "Unexpected error in food handler",
      { err: String(err) },
      requestId,
      "error",
    );
    // Don't surface internal errors to WhatsApp
    return null;
  }
}

// ── Intent handlers ───────────────────────────────────────────────────────────

async function showMenu(payload: FoodHandlerPayload): Promise<string> {
  const menu = await getMenu(payload.businessId);
  return formatMenuForWhatsApp(menu);
}

async function handleOrderIntent(payload: FoodHandlerPayload): Promise<string> {
  const { businessId, conversationId, message, requestId } = payload;

  const menu = await getMenu(businessId);

  if (menu.length === 0) {
    return "Sorry, our menu is currently empty. Please check back soon!";
  }

  // Try to parse items from the message directly
  const parsed = parseOrderFromMessage(message, menu);

  if (parsed.matched.length > 0) {
    return await startConfirmationStep(payload, parsed, menu);
  }

  // No items parsed — ask for their order
  await setConversationState(
    conversationId,
    { flow: "food_order", step: "awaiting_items" } as unknown as Record<string, unknown>,
    requestId,
  );

  return `Here's our menu:\n\n${formatMenuForWhatsApp(menu)}\n\nWhat would you like to order?`;
}

async function handleOrderFlow(
  payload: FoodHandlerPayload,
  state: FoodOrderConversationState,
): Promise<string> {
  const { businessId, conversationId, customerPhone, customerName, message, requestId } = payload;

  switch (state.step as FoodOrderStep) {
    case "awaiting_items": {
      const menu = await getMenu(businessId);
      const parsed = parseOrderFromMessage(message, menu);

      if (parsed.matched.length === 0) {
        const suggestions = menu
          .slice(0, 5)
          .map((i) => i.name)
          .join(", ");
        return `I couldn't match any items. Try saying e.g. "2 jollof rice". We have: ${suggestions}...`;
      }

      return startConfirmationStep(payload, parsed, menu);
    }

    case "awaiting_delivery_type": {
      if (/\bpick.?up\b/i.test(message) || /\bpickup\b/i.test(message)) {
        await setConversationState(
          conversationId,
          { ...state, step: "awaiting_confirmation", delivery_type: "pickup" } as unknown as Record<
            string,
            unknown
          >,
          requestId,
        );
        return buildConfirmationMessage(state, "pickup");
      }

      if (/\bdeliver/i.test(message)) {
        await setConversationState(
          conversationId,
          { ...state, step: "awaiting_address", delivery_type: "delivery" } as unknown as Record<
            string,
            unknown
          >,
          requestId,
        );
        return "What's your delivery address?";
      }

      return "Please say 'delivery' or 'pickup'.";
    }

    case "awaiting_address": {
      await setConversationState(
        conversationId,
        {
          ...state,
          step: "awaiting_confirmation",
          delivery_address: message.trim(),
        } as unknown as Record<string, unknown>,
        requestId,
      );
      return buildConfirmationMessage(state, "delivery", message.trim());
    }

    case "awaiting_confirmation": {
      if (/^\s*yes\b/i.test(message) || /^\s*confirm\b/i.test(message)) {
        return placeOrder(payload, state);
      }
      if (/^\s*no\b/i.test(message) || /^\s*cancel\b/i.test(message)) {
        await setConversationState(conversationId, {}, requestId);
        return "Order cancelled. Just say 'menu' to start again!";
      }
      return "Please reply YES to place your order or NO to cancel.";
    }

    default:
      await setConversationState(conversationId, {}, requestId);
      return null as unknown as string;
  }
}

async function startConfirmationStep(
  payload: FoodHandlerPayload,
  parsed: ParseOrderResult,
  menu: MenuItem[],
): Promise<string> {
  const { conversationId, requestId } = payload;
  const total = parsed.matched.reduce((s, i) => s + i.qty * i.unit_price, 0);

  const lines = parsed.matched.map(
    (i) =>
      `- ${i.qty}x ${i.name} @ ₦${i.unit_price.toLocaleString()} = ₦${(i.qty * i.unit_price).toLocaleString()}`,
  );

  const unmatchedNote =
    parsed.unmatched.length > 0
      ? `\n\n(I couldn't match: ${parsed.unmatched.join(", ")} — not on our menu)`
      : "";

  await setConversationState(
    conversationId,
    {
      flow: "food_order",
      step: "awaiting_delivery_type",
      pending_items: parsed.matched,
      total_amount: total,
    } as unknown as Record<string, unknown>,
    requestId,
  );

  return (
    `Here's your order:\n\n${lines.join("\n")}\n\n` +
    `Total: ₦${total.toLocaleString()}${unmatchedNote}\n\n` +
    `Delivery or pickup?`
  );
}

function buildConfirmationMessage(
  state: FoodOrderConversationState & { delivery_address?: string },
  deliveryType: "pickup" | "delivery",
  address?: string,
): string {
  const items = state.pending_items ?? [];
  const lines = items.map(
    (i) => `- ${i.qty}x ${i.name}: ₦${(i.qty * i.unit_price).toLocaleString()}`,
  );
  const total = items.reduce((s, i) => s + i.qty * i.unit_price, 0);
  const deliveryLine =
    deliveryType === "delivery" && address ? `\n📍 Delivery to: ${address}` : "\n🏪 Pickup";

  return (
    `Confirm your order:\n\n${lines.join("\n")}\n\n` +
    `Total: ₦${total.toLocaleString()}${deliveryLine}\n\n` +
    `Reply YES to place and get your payment link, or NO to cancel.`
  );
}

async function placeOrder(
  payload: FoodHandlerPayload,
  state: FoodOrderConversationState & { delivery_address?: string },
): Promise<string> {
  const { businessId, conversationId, customerPhone, customerName, requestId } = payload;

  const order = await createOrder({
    business_id: businessId,
    customer_phone: customerPhone,
    customer_name: customerName,
    items: state.pending_items ?? [],
    delivery_type: state.delivery_type ?? undefined,
    delivery_address: (state as unknown as { delivery_address?: string }).delivery_address,
  });

  if (!order) {
    return "Sorry, I couldn't place your order. Please try again or call us directly.";
  }

  // Clear conversation state
  await setConversationState(conversationId, {}, requestId);

  // Generate payment link
  const payLink = await sendPaymentLink(order, undefined, requestId);
  const payPart = payLink
    ? `\n\nPay here to confirm: ${payLink}`
    : "\n\nWe'll send your payment link shortly.";

  await logInfo("food-handler", "Food order placed", { orderId: order.id }, requestId);

  return (
    `Order placed! 🎉 Order ID: ${order.id.slice(0, 8).toUpperCase()}\n\n` +
    `Total: ₦${order.total_amount.toLocaleString()}${payPart}\n\n` +
    `We'll update you when your order is ready. Say "order status" any time to track it.`
  );
}

async function checkOrderStatus(payload: FoodHandlerPayload): Promise<string> {
  const { businessId, customerPhone } = payload;

  const order = await getLatestOrder(businessId, customerPhone);
  if (!order) {
    return "I couldn't find any recent orders for your number. Say 'menu' to place a new one!";
  }

  const date = new Date(order.created_at).toLocaleString("en-NG", {
    timeZone: "Africa/Lagos",
    dateStyle: "medium",
    timeStyle: "short",
  });

  return (
    `Your most recent order (${order.id.slice(0, 8).toUpperCase()}) placed on ${date}:\n\n` +
    `Status: ${statusLabel(order.status)} ✅\n` +
    `Total: ₦${order.total_amount.toLocaleString()}`
  );
}

async function handleCancelIntent(payload: FoodHandlerPayload): Promise<string> {
  const { businessId, customerPhone, requestId } = payload;

  const order = await getLatestOrder(businessId, customerPhone);
  if (!order) {
    return "No recent order found to cancel.";
  }

  const result = await cancelOrder(order.id, requestId);

  if (!result.success) {
    if (result.reason === "already_in_progress") {
      return "Sorry, your order is already being prepared and can no longer be cancelled. Please call us if there's an urgent issue.";
    }
    return "I couldn't cancel your order. Please call us directly.";
  }

  return "Your order has been cancelled. Sorry for any inconvenience!";
}

async function handleOwnerCommand(
  orderIdFragment: string,
  statusStr: string,
  requestId: string,
): Promise<string> {
  // Look up order by ID prefix
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin
    .from("food_orders")
    .select("id, customer_phone, status")
    .ilike("id", `${orderIdFragment.toLowerCase()}%`)
    .limit(1)
    .single();

  if (!data) {
    return `Order #${orderIdFragment} not found.`;
  }

  const newStatus = statusStr.toLowerCase() as OrderStatus;
  const ok = await updateOrderStatus(data.id, newStatus, requestId);

  if (!ok) {
    return `Couldn't update order to ${newStatus}. Current status may not allow this transition.`;
  }

  return `Order #${orderIdFragment.toUpperCase()} updated to: ${statusLabel(newStatus)}. Customer has been noted.`;
}

async function handlePriceQuery(payload: FoodHandlerPayload, message: string): Promise<string> {
  const menu = await getMenu(payload.businessId);
  const matched = fuzzyMatchItem(menu, message);

  if (matched) {
    return `${matched.name} is ₦${matched.price.toLocaleString()}.${matched.description ? ` (${matched.description})` : ""}`;
  }

  return `Here are our prices:\n\n${formatMenuForWhatsApp(menu)}`;
}

function deliveryFaq(config: FoodTraderNicheConfig): string {
  const areas =
    config.delivery_areas && config.delivery_areas.length > 0
      ? config.delivery_areas.join(", ")
      : "our local area";

  return `We deliver to: ${areas}. For areas not listed, please call us to confirm.`;
}

function generalFaq(config: FoodTraderNicheConfig): string {
  const phone = (config as unknown as { business_phone?: string }).business_phone;
  const phoneLine = phone ? `\nCall us: ${phone}` : "";
  return `For opening hours, location, and other enquiries, please contact ${config.business_name} directly.${phoneLine}`;
}

// ── Order parsing ─────────────────────────────────────────────────────────────

/**
 * Parses a natural-language order message into matched and unmatched items.
 *
 * Handles patterns like:
 *   "2 jollof rice and 1 fried chicken"
 *   "give me 3 peppersoup"
 *   "jollof rice x2"
 */
export function parseOrderFromMessage(message: string, menu: MenuItem[]): ParseOrderResult {
  const matched: OrderItem[] = [];
  const unmatched: string[] = [];

  // Normalise: lowercase, strip leading verbs
  const text = message
    .toLowerCase()
    .replace(/\b(give me|i want|order|get me|i'll have|i need|can i get)\b/g, " ")
    .trim();

  // Pattern: (qty) (item name) — handles "2 jollof rice", "jollof rice x2", "jollof rice 2"
  const patterns = [
    // "2 jollof rice" or "2x jollof rice"
    /(\d+)\s*x?\s+([a-z][a-z\s]*?)(?=\s+and\s+\d|\s+and\s+[a-z]|\s+,\s*\d|$)/g,
    // "jollof rice x2"
    /([a-z][a-z\s]+?)\s+x\s*(\d+)/g,
  ];

  let matched_something = false;

  for (const pattern of patterns) {
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(text)) !== null) {
      let qty: number;
      let itemName: string;

      if (pattern.source.startsWith("(\\d+)")) {
        qty = parseInt(m[1], 10);
        itemName = m[2].trim();
      } else {
        itemName = m[1].trim();
        qty = parseInt(m[2], 10);
      }

      if (!itemName || qty < 1 || qty > 99) continue;

      const item = fuzzyMatchItem(menu, itemName);
      if (item) {
        // Avoid duplicates
        const existing = matched.find((i) => i.menu_item_id === item.id);
        if (existing) {
          existing.qty += qty;
        } else {
          matched.push({
            menu_item_id: item.id,
            name: item.name,
            qty,
            unit_price: item.price,
          });
        }
        matched_something = true;
      } else {
        unmatched.push(itemName);
      }
    }
  }

  // Fallback: if no qty pattern matched, try item names only with qty=1
  if (!matched_something) {
    for (const item of menu) {
      const normalName = item.name.toLowerCase();
      if (text.includes(normalName)) {
        matched.push({
          menu_item_id: item.id,
          name: item.name,
          qty: 1,
          unit_price: item.price,
        });
      }
    }
  }

  return { matched, unmatched };
}
