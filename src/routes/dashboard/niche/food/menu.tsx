/**
 * src/routes/dashboard/niche/food/menu.tsx
 *
 * Menu items CRUD dashboard page.
 * Business owners can add, edit, toggle availability, and delete menu items.
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import {
  ChevronRight,
  Plus,
  Pencil,
  Trash2,
  ToggleLeft,
  ToggleRight,
  X,
  Check,
  UtensilsCrossed,
} from "lucide-react";
import { useRequireAuth } from "@/hooks/use-auth";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/dashboard/niche/food/menu")({
  component: MenuManagementPage,
});

interface MenuItemRow {
  id: string;
  name: string;
  description: string | null;
  price: number;
  category: string | null;
  is_available: boolean;
}

interface EditState {
  id: string | null; // null = new item
  name: string;
  description: string;
  price: string;
  category: string;
}

const BLANK_EDIT: EditState = { id: null, name: "", description: "", price: "", category: "" };

function MenuManagementPage() {
  const { session } = useRequireAuth();
  const [items, setItems] = useState<MenuItemRow[]>([]);
  const [businessId, setBusinessId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [edit, setEdit] = useState<EditState | null>(null);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      if (!session?.user.id) return;
      const { data: biz } = await supabase
        .from("businesses")
        .select("id")
        .eq("user_id", session.user.id)
        .single();

      if (!biz) {
        setLoading(false);
        return;
      }
      setBusinessId(biz.id);
      await fetchItems(biz.id);
      setLoading(false);
    }
    load();
  }, [session]);

  async function fetchItems(bizId: string) {
    const { data } = await supabase
      .from("menu_items")
      .select("id, name, description, price, category, is_available")
      .eq("business_id", bizId)
      .order("category", { ascending: true })
      .order("name", { ascending: true });

    setItems((data ?? []) as MenuItemRow[]);
  }

  async function saveItem() {
    if (!businessId || !edit) return;
    const price = parseFloat(edit.price);
    if (!edit.name.trim() || isNaN(price) || price < 0) {
      alert("Please enter a valid name and price.");
      return;
    }

    setSaving(true);

    if (edit.id) {
      // Update
      await supabase
        .from("menu_items")
        .update({
          name: edit.name.trim(),
          description: edit.description.trim() || null,
          price,
          category: edit.category.trim() || null,
        })
        .eq("id", edit.id)
        .eq("business_id", businessId);
    } else {
      // Insert
      await supabase.from("menu_items").insert({
        business_id: businessId,
        name: edit.name.trim(),
        description: edit.description.trim() || null,
        price,
        category: edit.category.trim() || null,
        is_available: true,
      });
    }

    await fetchItems(businessId);
    setEdit(null);
    setSaving(false);
  }

  async function toggleAvailability(item: MenuItemRow) {
    if (!businessId) return;
    await supabase
      .from("menu_items")
      .update({ is_available: !item.is_available })
      .eq("id", item.id)
      .eq("business_id", businessId);

    setItems((prev) =>
      prev.map((i) => (i.id === item.id ? { ...i, is_available: !i.is_available } : i)),
    );
  }

  async function deleteItem(itemId: string) {
    if (!businessId) return;
    if (!confirm("Delete this menu item? This cannot be undone.")) return;
    setDeletingId(itemId);
    await supabase.from("menu_items").delete().eq("id", itemId).eq("business_id", businessId);
    setItems((prev) => prev.filter((i) => i.id !== itemId));
    setDeletingId(null);
  }

  // Group by category
  const grouped = new Map<string, MenuItemRow[]>();
  for (const item of items) {
    const cat = item.category ?? "Uncategorised";
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat)!.push(item);
  }

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center text-muted-foreground">
        Loading menu...
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background px-4 py-8 max-w-2xl mx-auto">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-muted-foreground text-sm mb-6 flex-wrap">
        <Link to="/dashboard/niche" className="hover:text-foreground">
          Niche Modules
        </Link>
        <ChevronRight className="h-3 w-3" />
        <Link to="/dashboard/niche/food" className="hover:text-foreground">
          Food Trader
        </Link>
        <ChevronRight className="h-3 w-3" />
        <span className="text-foreground">Menu</span>
      </div>

      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="rounded-xl bg-orange-100 p-2 text-orange-600 dark:bg-orange-900/30 dark:text-orange-400">
            <UtensilsCrossed className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-foreground">Menu Items</h1>
            <p className="text-sm text-muted-foreground">
              {items.length} item{items.length !== 1 ? "s" : ""}
            </p>
          </div>
        </div>
        <button
          onClick={() => setEdit(BLANK_EDIT)}
          className="inline-flex items-center gap-2 rounded-xl bg-primary text-primary-foreground px-4 py-2 text-sm font-semibold shadow transition hover:opacity-90"
        >
          <Plus className="h-4 w-4" />
          Add Item
        </button>
      </div>

      {/* Edit / New form */}
      {edit !== null && (
        <div className="mb-6 rounded-2xl border border-border bg-card p-5 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold text-foreground">{edit.id ? "Edit Item" : "New Item"}</h2>
            <button
              onClick={() => setEdit(null)}
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">
                  Name *
                </label>
                <input
                  type="text"
                  value={edit.name}
                  onChange={(e) => setEdit((p) => p && { ...p, name: e.target.value })}
                  placeholder="Jollof Rice"
                  className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">
                  Price (₦) *
                </label>
                <input
                  type="number"
                  min="0"
                  step="50"
                  value={edit.price}
                  onChange={(e) => setEdit((p) => p && { ...p, price: e.target.value })}
                  placeholder="1500"
                  className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">
                Category
              </label>
              <input
                type="text"
                value={edit.category}
                onChange={(e) => setEdit((p) => p && { ...p, category: e.target.value })}
                placeholder="Rice, Soups, Proteins…"
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">
                Description (optional)
              </label>
              <input
                type="text"
                value={edit.description}
                onChange={(e) => setEdit((p) => p && { ...p, description: e.target.value })}
                placeholder="Short description"
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={() => setEdit(null)}
                className="rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-muted transition"
              >
                Cancel
              </button>
              <button
                onClick={saveItem}
                disabled={saving}
                className="inline-flex items-center gap-2 rounded-lg bg-primary text-primary-foreground px-4 py-2 text-sm font-semibold transition hover:opacity-90 disabled:opacity-50"
              >
                {saving ? (
                  <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                ) : (
                  <Check className="h-3.5 w-3.5" />
                )}
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Menu list */}
      {items.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center text-muted-foreground">
          <UtensilsCrossed className="h-10 w-10 mb-3 opacity-30" />
          <p className="font-medium">No menu items yet</p>
          <p className="text-sm mt-1">Add your first item to get started</p>
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          {Array.from(grouped.entries()).map(([category, catItems]) => (
            <div key={category}>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                {category}
              </h3>
              <div className="flex flex-col gap-2">
                {catItems.map((item) => (
                  <div
                    key={item.id}
                    className={`flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 transition ${
                      !item.is_available ? "opacity-50" : ""
                    }`}
                  >
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-foreground text-sm truncate">{item.name}</p>
                      {item.description && (
                        <p className="text-xs text-muted-foreground truncate">{item.description}</p>
                      )}
                    </div>
                    <span className="text-sm font-semibold text-foreground whitespace-nowrap">
                      ₦{item.price.toLocaleString()}
                    </span>

                    {/* Actions */}
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => toggleAvailability(item)}
                        title={item.is_available ? "Mark unavailable" : "Mark available"}
                        className="p-1.5 rounded-lg hover:bg-muted transition text-muted-foreground"
                      >
                        {item.is_available ? (
                          <ToggleRight className="h-4 w-4 text-green-500" />
                        ) : (
                          <ToggleLeft className="h-4 w-4" />
                        )}
                      </button>
                      <button
                        onClick={() =>
                          setEdit({
                            id: item.id,
                            name: item.name,
                            description: item.description ?? "",
                            price: String(item.price),
                            category: item.category ?? "",
                          })
                        }
                        className="p-1.5 rounded-lg hover:bg-muted transition text-muted-foreground"
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => deleteItem(item.id)}
                        disabled={deletingId === item.id}
                        className="p-1.5 rounded-lg hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-900/20 transition text-muted-foreground"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
