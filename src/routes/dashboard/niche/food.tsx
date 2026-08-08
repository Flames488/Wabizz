/**
 * src/routes/dashboard/niche/food.tsx
 *
 * Food trader module settings page.
 *
 * FIX: import server function that writes via supabaseAdmin + invalidates cache.
 * Previously handleSave() wrote directly to Supabase from the browser, bypassing
 * saveFoodTraderConfig() and leaving the 1-hour niche config cache stale after
 * save. A business owner updating order cutoff or delivery areas would see no
 * effect on WhatsApp replies for up to 1 hour.
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import {
  UtensilsCrossed,
  ChevronRight,
  Save,
  Plus,
  X,
  ClipboardList,
  LayoutList,
} from "lucide-react";
import { useRequireAuth } from "@/hooks/use-auth";
import { supabase } from "@/integrations/supabase/client";
import { saveFoodTraderConfig } from "@/lib/niche/niche.functions";

export const Route = createFileRoute("/dashboard/niche/food")({
  component: FoodSettingsPage,
});

interface FoodConfig {
  business_name: string;
  order_cutoff: string;
  delivery_areas: string[];
  business_phone: string;
}

const DEFAULT_CONFIG: FoodConfig = {
  business_name: "",
  order_cutoff: "21:00",
  delivery_areas: [],
  business_phone: "",
};

function FoodSettingsPage() {
  const { session } = useRequireAuth();
  const [config, setConfig] = useState<FoodConfig>(DEFAULT_CONFIG);
  const [newArea, setNewArea] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [businessId, setBusinessId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      if (!session?.user.id) return;

      const { data: biz } = await supabase
        .from("businesses")
        .select("id")
        .eq("owner_id", session.user.id)
        .single();

      if (!biz) {
        setLoading(false);
        return;
      }
      setBusinessId(biz.id);

      const { data: row } = await supabase
        .from("business_niche_configs")
        .select("config")
        .eq("business_id", biz.id)
        .eq("niche", "food_trader")
        .single();

      if (row?.config) {
        setConfig({ ...DEFAULT_CONFIG, ...(row.config as Partial<FoodConfig>) });
      }
      setLoading(false);
    }
    load();
  }, [session]);

  async function handleSave() {
    if (!businessId) return;
    setSaving(true);
    setError(null);

    try {
      // Use server function — writes via supabaseAdmin and invalidates the
      // niche config cache so the next WhatsApp message picks up the new config.
      await saveFoodTraderConfig({
        data: {
          business_id: businessId,
          business_name: config.business_name,
          order_cutoff: config.order_cutoff,
          delivery_areas: config.delivery_areas,
          business_phone: config.business_phone,
        },
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError("Save failed. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  function addArea() {
    const a = newArea.trim();
    if (!a || config.delivery_areas.includes(a)) return;
    setConfig((p) => ({ ...p, delivery_areas: [...p.delivery_areas, a] }));
    setNewArea("");
  }

  function removeArea(a: string) {
    setConfig((p) => ({ ...p, delivery_areas: p.delivery_areas.filter((x) => x !== a) }));
  }

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center text-muted-foreground">
        Loading settings...
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background px-4 py-8 max-w-2xl mx-auto">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-muted-foreground text-sm mb-6">
        <Link to="/dashboard/niche" className="hover:text-foreground">
          Niche Modules
        </Link>
        <ChevronRight className="h-3 w-3" />
        <span className="text-foreground">Food Trader Settings</span>
      </div>

      <div className="flex items-center gap-3 mb-6">
        <div className="rounded-xl bg-orange-100 p-2 text-orange-600 dark:bg-orange-900/30 dark:text-orange-400">
          <UtensilsCrossed className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-foreground">Food Trader Settings</h1>
          <p className="text-sm text-muted-foreground">
            Configure your WhatsApp food ordering system
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-5">
        {error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {/* Business Name */}
        <Field
          label="Business Name"
          hint="How customers will see your business name in WhatsApp messages"
        >
          <input
            type="text"
            value={config.business_name}
            onChange={(e) => setConfig((p) => ({ ...p, business_name: e.target.value }))}
            placeholder="Mama Ngozi Kitchen"
            className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </Field>

        {/* Order Cutoff */}
        <Field label="Order Cutoff Time" hint="Customers cannot place orders after this time">
          <input
            type="time"
            value={config.order_cutoff}
            onChange={(e) => setConfig((p) => ({ ...p, order_cutoff: e.target.value }))}
            className="rounded-lg border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </Field>

        {/* Business Phone */}
        <Field label="Business Phone (optional)" hint="Shown to customers as fallback contact">
          <input
            type="tel"
            value={config.business_phone}
            onChange={(e) => setConfig((p) => ({ ...p, business_phone: e.target.value }))}
            placeholder="+2348012345678"
            className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </Field>

        {/* Delivery Areas */}
        <Field label="Delivery Areas" hint="Areas you deliver to — shown to customers who ask">
          <div className="flex flex-wrap gap-2 mb-2">
            {config.delivery_areas.map((a) => (
              <span
                key={a}
                className="inline-flex items-center gap-1 rounded-full bg-muted px-3 py-1 text-sm"
              >
                {a}
                <button
                  onClick={() => removeArea(a)}
                  className="text-muted-foreground hover:text-destructive ml-1"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
            {config.delivery_areas.length === 0 && (
              <span className="text-xs text-muted-foreground">No areas added yet</span>
            )}
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              value={newArea}
              onChange={(e) => setNewArea(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addArea()}
              placeholder="e.g. Lekki"
              className="flex-1 rounded-lg border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <button
              onClick={addArea}
              className="inline-flex items-center gap-1 rounded-lg bg-muted px-3 py-2 text-sm font-medium hover:bg-accent"
            >
              <Plus className="h-4 w-4" />
              Add
            </button>
          </div>
        </Field>

        {/* Save */}
        <button
          onClick={handleSave}
          disabled={saving}
          className="inline-flex items-center justify-center gap-2 rounded-xl bg-primary text-primary-foreground px-5 py-3 font-semibold shadow transition hover:opacity-90 disabled:opacity-50"
        >
          {saving ? (
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
          ) : saved ? (
            "Saved!"
          ) : (
            <>
              <Save className="h-4 w-4" />
              Save Settings
            </>
          )}
        </button>

        {/* Quick links */}
        <div className="mt-2 flex gap-3">
          <Link
            to="/dashboard/niche/food/menu"
            className="flex-1 flex items-center justify-center gap-2 rounded-xl border border-border bg-card px-4 py-3 text-sm font-medium text-foreground hover:bg-accent transition"
          >
            <LayoutList className="h-4 w-4 text-orange-500" />
            Manage Menu
          </Link>
          <Link
            to="/dashboard/niche/food/orders"
            className="flex-1 flex items-center justify-center gap-2 rounded-xl border border-border bg-card px-4 py-3 text-sm font-medium text-foreground hover:bg-accent transition"
          >
            <ClipboardList className="h-4 w-4 text-orange-500" />
            View Orders
          </Link>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-foreground mb-1">{label}</label>
      {hint && <p className="text-xs text-muted-foreground mb-2">{hint}</p>}
      {children}
    </div>
  );
}
