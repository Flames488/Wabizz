/**
 * src/__tests__/niche/food-handler.test.ts
 *
 * Unit tests for the food trader intent handler, menu service, and order service.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/server-logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: vi.fn(), rpc: vi.fn() },
}));

vi.mock("@/lib/niche/niche-loader", () => ({
  getConversationState: vi.fn().mockResolvedValue({}),
  setConversationState: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/niche/food/menu-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/niche/food/menu-service")>();
  return {
    ...actual,
    getMenu: vi.fn(),
  };
});

vi.mock("@/lib/niche/food/order-service", () => ({
  createOrder: vi.fn(),
  getLatestOrder: vi.fn(),
  cancelOrder: vi.fn(),
  sendPaymentLink: vi.fn(),
  updateOrderStatus: vi.fn(),
  statusLabel: (s: string) => s,
}));

import { handleFoodMessage, parseOrderFromMessage } from "@/lib/niche/food/food-intent-handler";
import { getMenu, fuzzyMatchItem, formatMenuForWhatsApp } from "@/lib/niche/food/menu-service";
import { getLatestOrder, cancelOrder } from "@/lib/niche/food/order-service";
import type { MenuItem } from "@/lib/niche/food/types";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const MENU: MenuItem[] = [
  {
    id: "m1",
    business_id: "b1",
    name: "Jollof Rice",
    description: "Smoky party rice",
    price: 1500,
    category: "Rice",
    is_available: true,
    image_url: null,
    created_at: "",
    updated_at: "",
  },
  {
    id: "m2",
    business_id: "b1",
    name: "Fried Rice",
    description: null,
    price: 1500,
    category: "Rice",
    is_available: true,
    image_url: null,
    created_at: "",
    updated_at: "",
  },
  {
    id: "m3",
    business_id: "b1",
    name: "Fried Chicken",
    description: "2 pieces",
    price: 2000,
    category: "Proteins",
    is_available: true,
    image_url: null,
    created_at: "",
    updated_at: "",
  },
  {
    id: "m4",
    business_id: "b1",
    name: "Peppersoup",
    description: "Catfish",
    price: 2500,
    category: "Soups",
    is_available: true,
    image_url: null,
    created_at: "",
    updated_at: "",
  },
];

const FOOD_CONFIG = {
  business_name: "Mama Ngozi Kitchen",
  order_cutoff: "21:00",
  delivery_areas: ["Lekki", "Victoria Island"],
};

const BASE_PAYLOAD = {
  businessId: "b1",
  conversationId: "conv-1",
  customerPhone: "+2348012345678",
  customerName: "Tunde Adeyemi",
  foodConfig: FOOD_CONFIG,
  requestId: "req-1",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getMenu).mockResolvedValue(MENU);
});

// ── parseOrderFromMessage ─────────────────────────────────────────────────────

describe("parseOrderFromMessage", () => {
  it("parses '2 jollof rice and 1 fried chicken'", () => {
    const result = parseOrderFromMessage("2 jollof rice and 1 fried chicken", MENU);
    expect(result.matched).toHaveLength(2);
    const jollof = result.matched.find((i) => i.menu_item_id === "m1");
    const chicken = result.matched.find((i) => i.menu_item_id === "m3");
    expect(jollof?.qty).toBe(2);
    expect(chicken?.qty).toBe(1);
  });

  it("parses 'jollof rice x2'", () => {
    const result = parseOrderFromMessage("jollof rice x2", MENU);
    expect(result.matched.some((i) => i.menu_item_id === "m1" && i.qty === 2)).toBe(true);
  });

  it("falls back to qty=1 for simple item name match", () => {
    const result = parseOrderFromMessage("i want peppersoup", MENU);
    expect(result.matched.some((i) => i.menu_item_id === "m4")).toBe(true);
  });

  it("records unmatched items", () => {
    const result = parseOrderFromMessage("2 jollof rice and 3 egusi soup", MENU);
    expect(result.unmatched).toContain("egusi soup");
  });

  it("returns empty matched for completely unrecognised message", () => {
    const result = parseOrderFromMessage("hello how are you", MENU);
    // No structured order pattern
    expect(result.matched.length).toBe(0);
  });
});

// ── fuzzyMatchItem ────────────────────────────────────────────────────────────

describe("fuzzyMatchItem", () => {
  it("exact match takes priority", () => {
    expect(fuzzyMatchItem(MENU, "Jollof Rice")?.id).toBe("m1");
  });

  it("case-insensitive match", () => {
    expect(fuzzyMatchItem(MENU, "jollof rice")?.id).toBe("m1");
  });

  it("partial contains match", () => {
    expect(fuzzyMatchItem(MENU, "jollof")?.id).toBe("m1");
  });

  it("returns null for unknown item", () => {
    expect(fuzzyMatchItem(MENU, "egusi")).toBeNull();
  });
});

// ── formatMenuForWhatsApp ─────────────────────────────────────────────────────

describe("formatMenuForWhatsApp", () => {
  it("includes all item names and prices", () => {
    const output = formatMenuForWhatsApp(MENU);
    expect(output).toContain("Jollof Rice");
    expect(output).toContain("₦1,500");
    expect(output).toContain("Fried Chicken");
    expect(output).toContain("₦2,000");
  });

  it("groups items by category", () => {
    const output = formatMenuForWhatsApp(MENU);
    expect(output).toContain("--- Rice ---");
    expect(output).toContain("--- Proteins ---");
    expect(output).toContain("--- Soups ---");
  });

  it("returns friendly message for empty menu", () => {
    const output = formatMenuForWhatsApp([]);
    expect(output).toContain("empty");
  });
});

// ── handleFoodMessage — intent routing ────────────────────────────────────────

describe("handleFoodMessage — intent routing", () => {
  it("returns menu text for 'show menu'", async () => {
    const reply = await handleFoodMessage({ ...BASE_PAYLOAD, message: "show menu" });
    expect(reply).toContain("Jollof Rice");
    expect(getMenu).toHaveBeenCalledWith("b1");
  });

  it("returns menu text for 'what do you have?'", async () => {
    const reply = await handleFoodMessage({ ...BASE_PAYLOAD, message: "what do you have?" });
    expect(reply).not.toBeNull();
    expect(reply).toContain("Jollof Rice");
  });

  it("returns delivery areas for delivery FAQ", async () => {
    const reply = await handleFoodMessage({ ...BASE_PAYLOAD, message: "do you deliver to Lekki?" });
    expect(reply).toContain("Lekki");
    expect(reply).toContain("Victoria Island");
  });

  it("returns null for generic unrelated message", async () => {
    const reply = await handleFoodMessage({ ...BASE_PAYLOAD, message: "hello there" });
    expect(reply).toBeNull();
  });

  it("returns order status for 'where is my order'", async () => {
    vi.mocked(getLatestOrder).mockResolvedValue({
      id: "order-abc-123",
      business_id: "b1",
      customer_phone: "+2348012345678",
      customer_name: "Tunde",
      items: [],
      total_amount: 3000,
      status: "preparing",
      delivery_type: "delivery",
      delivery_address: "5 Admiralty Way, Lekki",
      paystack_ref: null,
      payment_status: "paid",
      notes: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const reply = await handleFoodMessage({ ...BASE_PAYLOAD, message: "where is my order?" });
    expect(reply).toContain("order-ab"); // first 8 chars of ID
    expect(reply).toContain("preparing");
  });

  it("handles cancel order when order is cancellable", async () => {
    vi.mocked(getLatestOrder).mockResolvedValue({
      id: "order-xyz",
      business_id: "b1",
      customer_phone: "+2348012345678",
      customer_name: "Tunde",
      items: [],
      total_amount: 1500,
      status: "pending",
      delivery_type: null,
      delivery_address: null,
      paystack_ref: null,
      payment_status: "unpaid",
      notes: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    vi.mocked(cancelOrder).mockResolvedValue({ success: true });

    const reply = await handleFoodMessage({ ...BASE_PAYLOAD, message: "cancel my order" });
    expect(reply).toContain("cancelled");
  });

  it("handles cancel when order already in progress", async () => {
    vi.mocked(getLatestOrder).mockResolvedValue({
      id: "order-xyz",
      business_id: "b1",
      customer_phone: "+2348012345678",
      customer_name: null,
      items: [],
      total_amount: 1500,
      status: "preparing",
      delivery_type: null,
      delivery_address: null,
      paystack_ref: null,
      payment_status: "paid",
      notes: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    vi.mocked(cancelOrder).mockResolvedValue({ success: false, reason: "already_in_progress" });

    const reply = await handleFoodMessage({ ...BASE_PAYLOAD, message: "cancel" });
    expect(reply).toContain("already being prepared");
  });
});
