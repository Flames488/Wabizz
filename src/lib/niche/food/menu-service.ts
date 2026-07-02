/**
 * src/lib/niche/food/menu-service.ts
 *
 * Menu CRUD and lookup functions for the food trader niche module.
 * All database operations use supabaseAdmin (service role) to bypass RLS
 * in the webhook flow.  Dashboard mutations use the authenticated client.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { logError } from "@/lib/server-logger";
import type { MenuItem } from "./types";

// ── Read ──────────────────────────────────────────────────────────────────────

/**
 * Returns all available menu items for a business, ordered by category then name.
 *
 * @param businessId - UUID of the business
 */
export async function getMenu(businessId: string): Promise<MenuItem[]> {
  const { data, error } = await supabaseAdmin
    .from("menu_items")
    .select("*")
    .eq("business_id", businessId)
    .eq("is_available", true)
    .order("category", { ascending: true })
    .order("name", { ascending: true });

  if (error) {
    await logError("menu-service", "getMenu failed", { businessId, error: error.message });
    return [];
  }

  return (data ?? []) as MenuItem[];
}

/**
 * Finds a single menu item by its UUID.
 */
export async function getMenuItemById(
  businessId: string,
  itemId: string,
): Promise<MenuItem | null> {
  const { data, error } = await supabaseAdmin
    .from("menu_items")
    .select("*")
    .eq("business_id", businessId)
    .eq("id", itemId)
    .single();

  if (error || !data) return null;
  return data as MenuItem;
}

/**
 * Formats a menu as a WhatsApp-friendly numbered list, grouped by category.
 *
 * Example output:
 *   🍽 Our Menu
 *   --- Rice Dishes ---
 *   1. Jollof Rice — ₦1,500
 *   2. Fried Rice — ₦1,500
 */
export function formatMenuForWhatsApp(items: MenuItem[]): string {
  if (items.length === 0) {
    return "Sorry, our menu is currently empty. Please call us to find out what's available.";
  }

  const grouped = new Map<string, MenuItem[]>();

  for (const item of items) {
    const cat = item.category ?? "Menu";
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat)!.push(item);
  }

  const lines: string[] = ["🍽 Our Menu\n"];
  let index = 1;

  for (const [category, catItems] of grouped) {
    lines.push(`--- ${category} ---`);
    for (const item of catItems) {
      const desc = item.description ? ` (${item.description})` : "";
      lines.push(`${index}. ${item.name}${desc} — ₦${item.price.toLocaleString()}`);
      index++;
    }
    lines.push("");
  }

  lines.push("Reply with what you'd like to order, e.g. '2 jollof rice and 1 fried chicken'");

  return lines.join("\n").trim();
}

// ── Write (dashboard mutations) ───────────────────────────────────────────────

export interface CreateMenuItemInput {
  business_id: string;
  name: string;
  description?: string;
  price: number;
  category?: string;
  is_available?: boolean;
  image_url?: string;
}

/**
 * Creates a new menu item.  Used by the dashboard.
 */
export async function createMenuItem(input: CreateMenuItemInput): Promise<MenuItem | null> {
  const { data, error } = await supabaseAdmin.from("menu_items").insert(input).select().single();

  if (error) {
    await logError("menu-service", "createMenuItem failed", { error: error.message });
    return null;
  }

  return data as MenuItem;
}

/**
 * Updates an existing menu item.
 */
export async function updateMenuItem(
  businessId: string,
  itemId: string,
  patch: Partial<Omit<MenuItem, "id" | "business_id" | "created_at" | "updated_at">>,
): Promise<MenuItem | null> {
  const { data, error } = await supabaseAdmin
    .from("menu_items")
    .update(patch)
    .eq("id", itemId)
    .eq("business_id", businessId)
    .select()
    .single();

  if (error) {
    await logError("menu-service", "updateMenuItem failed", { error: error.message });
    return null;
  }

  return data as MenuItem;
}

/**
 * Soft-deletes a menu item by setting is_available = false.
 * Hard delete is available for permanent removal.
 */
export async function deleteMenuItem(
  businessId: string,
  itemId: string,
  hardDelete = false,
): Promise<boolean> {
  if (hardDelete) {
    const { error } = await supabaseAdmin
      .from("menu_items")
      .delete()
      .eq("id", itemId)
      .eq("business_id", businessId);

    return !error;
  }

  const { error } = await supabaseAdmin
    .from("menu_items")
    .update({ is_available: false })
    .eq("id", itemId)
    .eq("business_id", businessId);

  return !error;
}

// ── Fuzzy matching ────────────────────────────────────────────────────────────

/**
 * Attempts to match a free-text item name to an entry in the menu.
 * Uses a simple normalised-string containment check.
 * Returns the best-matching MenuItem or null.
 */
export function fuzzyMatchItem(menu: MenuItem[], query: string): MenuItem | null {
  const normalise = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .trim();

  const q = normalise(query);
  if (!q) return null;

  // Exact match first
  const exact = menu.find((item) => normalise(item.name) === q);
  if (exact) return exact;

  // Starts-with
  const startsWith = menu.find((item) => normalise(item.name).startsWith(q));
  if (startsWith) return startsWith;

  // Contains
  const contains = menu.find((item) => normalise(item.name).includes(q));
  if (contains) return contains;

  // Query contains item name (user typed more words than the item name)
  const reverse = menu.find((item) => q.includes(normalise(item.name)));
  if (reverse) return reverse;

  return null;
}
