/**
 * src/routes/dashboard/niche/index.tsx
 *
 * Niche Module Management page.
 * Lets business owners enable/disable the Hospital and Food Trader modules.
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import {
  Stethoscope,
  UtensilsCrossed,
  ChevronRight,
  CheckCircle2,
  Circle,
  Layers,
} from "lucide-react";
import { useRequireAuth } from "@/hooks/use-auth";
// FIX: import server function that writes via supabaseAdmin + invalidates cache.
// Previously toggleNiche() wrote directly to Supabase from the browser, bypassing
// setNicheActive() and leaving the niche config cache stale for up to 1 hour after
// a toggle.  A business owner enabling a module would see no effect until cache expiry.
import { toggleNicheActive } from "@/lib/niche/niche.functions";

export const Route = createFileRoute("/dashboard/niche/")({
  component: NicheIndexPage,
});

interface NicheCard {
  key: "hospital" | "food_trader";
  title: string;
  description: string;
  icon: React.ReactNode;
  href: string;
  color: string;
}

const NICHE_CARDS: NicheCard[] = [
  {
    key: "hospital",
    title: "Hospital & Clinic",
    description:
      "Let patients book, cancel, and check appointments via WhatsApp. Integrates with Vitar for real-time doctor availability.",
    icon: <Stethoscope className="h-6 w-6" />,
    href: "/dashboard/niche/hospital",
    color: "text-blue-500",
  },
  {
    key: "food_trader",
    title: "Food Trader",
    description:
      "Accept food orders over WhatsApp. Manage your menu, track orders, and collect payments automatically.",
    icon: <UtensilsCrossed className="h-6 w-6" />,
    href: "/dashboard/niche/food",
    color: "text-orange-500",
  },
];

function NicheIndexPage() {
  const { session } = useRequireAuth();
  const [activeNiches, setActiveNiches] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});

  async function toggleNiche(key: "hospital" | "food_trader", current: boolean) {
    setLoading((p) => ({ ...p, [key]: true }));
    try {
      // FIX: call server function instead of supabase.from().upsert() directly.
      // Server function calls setNicheActive() which invalidates the niche config
      // cache — without this the webhook handler would treat the module as
      // still-active/still-inactive for up to 1 hour after toggling.
      const result = await toggleNicheActive({ data: { niche: key, is_active: !current } });
      if (result.success) {
        setActiveNiches((p) => ({ ...p, [key]: !current }));
      } else {
        alert(result.error ?? "Failed to update module status. Please try again.");
      }
    } finally {
      setLoading((p) => ({ ...p, [key]: false }));
    }
  }

  return (
    <div className="min-h-screen bg-background px-4 py-8 max-w-3xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-2 text-muted-foreground text-sm mb-2">
          <Layers className="h-4 w-4" />
          <span>Dashboard</span>
          <ChevronRight className="h-3 w-3" />
          <span>Niche Modules</span>
        </div>
        <h1 className="text-2xl font-bold text-foreground">Niche Modules</h1>
        <p className="text-muted-foreground mt-1">
          Extend Wabizz with industry-specific automation for your business type.
        </p>
      </div>

      {/* Module cards */}
      <div className="flex flex-col gap-4">
        {NICHE_CARDS.map((card) => {
          const isActive = activeNiches[card.key] ?? false;
          const isLoading = loading[card.key] ?? false;

          return (
            <div
              key={card.key}
              className="rounded-2xl border border-border bg-card p-5 shadow-sm transition-all"
            >
              <div className="flex items-start gap-4">
                {/* Icon */}
                <div className={`mt-0.5 rounded-xl bg-muted p-2 ${card.color}`}>{card.icon}</div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <h2 className="font-semibold text-foreground">{card.title}</h2>
                    {isActive && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700 dark:bg-green-900/30 dark:text-green-400">
                        <CheckCircle2 className="h-3 w-3" />
                        Active
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground">{card.description}</p>

                  <div className="flex items-center gap-3 mt-4">
                    {/* Toggle */}
                    <button
                      onClick={() => toggleNiche(card.key, isActive)}
                      disabled={isLoading}
                      className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-medium transition-colors
                        ${
                          isActive
                            ? "bg-muted text-muted-foreground hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/20"
                            : "bg-primary text-primary-foreground hover:opacity-90"
                        } disabled:opacity-50`}
                    >
                      {isLoading ? (
                        <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                      ) : isActive ? (
                        <Circle className="h-3.5 w-3.5" />
                      ) : (
                        <CheckCircle2 className="h-3.5 w-3.5" />
                      )}
                      {isActive ? "Disable" : "Enable"}
                    </button>

                    {/* Settings link */}
                    <Link
                      to={card.href}
                      className="inline-flex items-center gap-1 text-sm text-primary font-medium hover:underline"
                    >
                      Configure
                      <ChevronRight className="h-3.5 w-3.5" />
                    </Link>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Info box */}
      <div className="mt-8 rounded-xl bg-muted/60 border border-border p-4 text-sm text-muted-foreground">
        <strong className="text-foreground">How it works:</strong> When a module is enabled, Wabizz
        automatically detects relevant customer messages and handles them with the appropriate flow.
        Your existing AI assistant continues to handle all other conversations.
      </div>
    </div>
  );
}
