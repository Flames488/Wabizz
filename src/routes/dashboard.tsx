import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import {
  MessageCircle,
  TrendingUp,
  ShoppingBag,
  Wallet,
  Settings2,
  CheckCircle2,
  AlertCircle,
  Package,
  Sparkles,
  Clock,
  LogOut,
  Loader2,
  Lock,
  CreditCard,
  X,
  AlertTriangle,
  Users,
  Megaphone,
  Zap,
  Layers,
} from "lucide-react";
import { useRequireAuth } from "@/hooks/use-auth";
import { useAuthedServerFn } from "@/lib/authed-fn";
import { getDashboard } from "@/lib/dashboard.functions";
import {
  getMySubscription,
  initSubscriptionCheckout,
  cancelTrial,
} from "@/lib/subscription.functions";
import { PLANS, type PlanId } from "@/lib/plan";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

export const Route = createFileRoute("/dashboard")({
  head: () => ({
    meta: [
      { title: "Dashboard — Wabizz AI" },
      { name: "description", content: "Your live AI assistant overview and conversations." },
    ],
  }),
  component: Dashboard,
});

type Sub = {
  plan_id: PlanId;
  status: "trial" | "active" | "expired" | "cancelled";
  trial_ends_at: string | null;
  current_period_end: string | null;
};

const statusStyles: Record<string, string> = {
  handled: "bg-muted text-muted-foreground",
  needs_you: "bg-warning/15 text-warning-foreground border border-warning/30",
  order_placed: "bg-success/15 text-success border border-success/30",
};
const statusIcon: Record<string, typeof CheckCircle2> = {
  handled: CheckCircle2,
  needs_you: AlertCircle,
  order_placed: Package,
};
const statusLabel: Record<string, string> = {
  handled: "Handled",
  needs_you: "Needs You",
  order_placed: "Order Placed",
};

/** Live countdown: returns { days, hours, minutes, seconds } until a future date */
function useCountdown(targetIso: string | null) {
  const calcRemaining = () => {
    if (!targetIso) return null;
    const diff = new Date(targetIso).getTime() - Date.now();
    if (diff <= 0) return { days: 0, hours: 0, minutes: 0, seconds: 0, expired: true };
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((diff % (1000 * 60)) / 1000);
    return { days, hours, minutes, seconds, expired: false };
  };

  const [remaining, setRemaining] = useState(calcRemaining);

  useEffect(() => {
    if (!targetIso) return;
    const id = setInterval(() => setRemaining(calcRemaining()), 1000);
    return () => clearInterval(id);
  }, [targetIso]);

  return remaining;
}

function Dashboard() {
  const navigate = useNavigate();
  const { session, loading: authLoading } = useRequireAuth();
  const callDash = useAuthedServerFn(getDashboard);
  const callSub = useAuthedServerFn(getMySubscription);
  const callInit = useAuthedServerFn(initSubscriptionCheckout);
  const callCancelTrial = useAuthedServerFn(cancelTrial);

  const [name, setName] = useState("Your Business");
  const [sub, setSub] = useState<Sub | null>(null);
  const [trialExpired, setTrialExpired] = useState(false);
  const [upgrading, setUpgrading] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [stats, setStats] = useState({ conversationsToday: 0, ordersToday: 0, revenueToday: 0 });
  const [conversations, setConversations] = useState<
    Array<{
      id: string;
      customer_name: string | null;
      customer_number: string;
      last_message: string | null;
      last_message_at: string;
      status: string;
    }>
  >([]);
  const [hydrating, setHydrating] = useState(true);
  // 24-hour reminder banner (shown when <= 24h left on trial)
  const [showReminderBanner, setShowReminderBanner] = useState(false);
  const reminderDismissed = useRef(false);

  useEffect(() => {
    if (!session) return;
    Promise.all([callDash(), callSub()])
      .then(([dash, subRes]) => {
        if (!dash.businessName) {
          navigate({ to: "/onboarding" });
          return;
        }
        setName(dash.businessName);
        setStats(dash.stats);
        setConversations(dash.conversations);
        const s = subRes.subscription as Sub | null;
        if (!s) {
          navigate({ to: "/pricing" });
          return;
        }
        const expired =
          (s.status === "trial" && s.trial_ends_at && new Date(s.trial_ends_at) < new Date()) ||
          s.status === "expired";
        setTrialExpired(!!expired);
        setSub(s);

        // Show 24h reminder banner if within the last day of trial
        if (s.status === "trial" && s.trial_ends_at && !expired) {
          const msLeft = new Date(s.trial_ends_at).getTime() - Date.now();
          const hoursLeft = msLeft / (1000 * 60 * 60);
          if (hoursLeft <= 24 && !reminderDismissed.current) {
            setShowReminderBanner(true);
          }
        }

        setHydrating(false);
      })
      .catch(() => {
        toast.error("Couldn't load dashboard. Check your connection and refresh.");
        setHydrating(false);
      });
  }, [session, callDash, callSub, navigate]);

  const upgradeNow = async () => {
    if (!sub) return;
    setUpgrading(true);
    try {
      const res = await callInit({ data: { planId: sub.plan_id } });
      if (!res.ok || !res.url) {
        toast.error(res.error ?? "Couldn't open Paystack");
        setUpgrading(false);
        return;
      }
      window.location.href = res.url;
    } catch {
      toast.error("Couldn't reach Paystack. Try again.");
      setUpgrading(false);
    }
  };

  const handleCancelTrial = async () => {
    setCancelling(true);
    const res = await callCancelTrial();
    setCancelling(false);
    if (!res.ok) {
      toast.error(res.error ?? "Couldn't cancel trial");
      return;
    }
    toast.success("Trial cancelled. You can restart anytime from Pricing.");
    navigate({ to: "/pricing" });
  };

  const plan = sub ? PLANS[sub.plan_id] : null;
  const countdown = useCountdown(sub?.status === "trial" ? (sub.trial_ends_at ?? null) : null);

  const daysLeft =
    sub?.status === "trial" && sub.trial_ends_at
      ? Math.max(
          0,
          Math.ceil((new Date(sub.trial_ends_at).getTime() - Date.now()) / (1000 * 60 * 60 * 24)),
        )
      : 0;

  const signOut = async () => {
    await supabase.auth.signOut();
    navigate({ to: "/auth" });
  };

  if (authLoading || hydrating) {
    return (
      <div className="min-h-screen bg-surface flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  const stat = [
    { label: "Conversations Today", value: String(stats.conversationsToday), icon: MessageCircle },
    { label: "Orders Received", value: String(stats.ordersToday), icon: ShoppingBag },
    { label: "Revenue Today", value: `₦${stats.revenueToday.toLocaleString()}`, icon: Wallet },
  ];

  return (
    <div className="min-h-screen bg-surface pb-28">
      <header className="bg-card border-b border-border/60 sticky top-0 z-10 backdrop-blur-md bg-card/90">
        <div className="mx-auto max-w-3xl px-5 py-4 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">Welcome back</p>
            <h1 className="text-lg font-bold tracking-tight truncate">{name}</h1>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {plan && (
              <Link
                to="/pricing"
                className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 border border-primary/30 px-3 py-1.5 text-xs font-semibold text-primary hover:bg-primary/15 transition-smooth"
              >
                {plan.name} Plan ✓
              </Link>
            )}
            <div className="inline-flex items-center gap-2 rounded-full bg-success/15 border border-success/30 px-3 py-1.5">
              <span className="relative flex h-2 w-2">
                <span className="animate-pulse-soft absolute inline-flex h-full w-full rounded-full bg-success opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-success" />
              </span>
              <span className="text-xs font-semibold text-success">AI is Live</span>
            </div>
            <button
              onClick={signOut}
              className="h-8 w-8 rounded-full flex items-center justify-center hover:bg-muted transition-smooth"
              aria-label="Sign out"
            >
              <LogOut className="h-4 w-4 text-muted-foreground" />
            </button>
          </div>
        </div>

        {/* ── TRIAL COUNTDOWN BAR ── */}
        {sub?.status === "trial" && !trialExpired && countdown && (
          <div className="bg-warning/10 border-t border-warning/30">
            <div className="mx-auto max-w-3xl px-5 py-2.5 flex items-center justify-between gap-3 text-xs">
              <div className="flex items-center gap-2 text-warning-foreground">
                <Clock className="h-3.5 w-3.5 shrink-0" />
                <span className="font-medium">
                  Trial ends in{" "}
                  {countdown.days > 0 ? (
                    <>
                      <strong>{countdown.days}d</strong>{" "}
                      <strong>{String(countdown.hours).padStart(2, "0")}h</strong>{" "}
                      <strong>{String(countdown.minutes).padStart(2, "0")}m</strong>{" "}
                      <strong>{String(countdown.seconds).padStart(2, "0")}s</strong>
                    </>
                  ) : (
                    <>
                      <strong>{String(countdown.hours).padStart(2, "0")}h</strong>{" "}
                      <strong>{String(countdown.minutes).padStart(2, "0")}m</strong>{" "}
                      <strong>{String(countdown.seconds).padStart(2, "0")}s</strong>
                    </>
                  )}{" "}
                  — upgrade to keep access
                </span>
              </div>
              <Link to="/pricing" className="font-semibold text-primary hover:underline shrink-0">
                Upgrade
              </Link>
            </div>
          </div>
        )}
      </header>

      {/* ── 24-HOUR REMINDER BANNER ── */}
      {showReminderBanner && (
        <div className="sticky top-0 z-20 bg-amber-50 border-b border-amber-200 animate-fade-in">
          <div className="mx-auto max-w-3xl px-5 py-3 flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-amber-900">
                ⚡ Less than 24 hours left on your free trial!
              </p>
              <p className="text-xs text-amber-700 mt-0.5">
                Your AI will stop replying to customers when the trial ends. Add your card now to
                keep it running — no interruption, no missed sales.
              </p>
              <Link
                to="/pricing"
                className="inline-block mt-2 text-xs font-semibold text-amber-900 underline underline-offset-2"
              >
                Add card & continue →
              </Link>
            </div>
            <button
              onClick={() => {
                reminderDismissed.current = true;
                setShowReminderBanner(false);
              }}
              className="h-6 w-6 shrink-0 flex items-center justify-center rounded-full hover:bg-amber-200 transition-smooth"
              aria-label="Dismiss"
            >
              <X className="h-3.5 w-3.5 text-amber-700" />
            </button>
          </div>
        </div>
      )}

      <main className="mx-auto max-w-3xl px-5 py-6 space-y-6 animate-fade-in">
        <div className="px-1">
          <h2 className="text-xl font-bold tracking-tight">Today at {name}</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Here's how your AI is performing right now.
          </p>
        </div>

        <section className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {stat.map((s) => (
            <div
              key={s.label}
              className="bg-gradient-card rounded-2xl p-5 border border-border/50 shadow-sm transition-smooth hover:shadow-md"
            >
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs font-medium text-muted-foreground">{s.label}</span>
                <div className="h-8 w-8 rounded-lg bg-primary/10 flex items-center justify-center">
                  <s.icon className="h-4 w-4 text-primary" />
                </div>
              </div>
              <div className="text-2xl font-bold tracking-tight">{s.value}</div>
              <div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                <TrendingUp className="h-3 w-3" />
                Live data
              </div>
            </div>
          ))}
        </section>

        <section>
          <div className="flex items-center justify-between mb-3 px-1">
            <h2 className="text-sm font-semibold">Recent conversations</h2>
            <span className="text-xs text-muted-foreground">Live feed</span>
          </div>
          <div className="bg-card rounded-2xl border border-border/50 overflow-hidden shadow-sm">
            {conversations.length === 0 && (
              <div className="p-8 text-center text-sm text-muted-foreground">
                No conversations yet. Connect WhatsApp in Settings to start receiving messages.
              </div>
            )}
            {conversations.map((c, i) => {
              const Icon = statusIcon[c.status] ?? CheckCircle2;
              const initials = (c.customer_name ?? c.customer_number)
                .split(/\s+/)
                .map((s) => s[0])
                .join("")
                .slice(0, 2)
                .toUpperCase();
              const timeAgo = formatTimeAgo(c.last_message_at);
              return (
                <Link
                  key={c.id}
                  to="/conversation/$id"
                  params={{ id: c.id }}
                  className={`flex items-start gap-3 p-4 transition-smooth hover:bg-muted/50 active:bg-muted/70 ${
                    i !== conversations.length - 1 ? "border-b border-border/50" : ""
                  } ${c.status === "needs_you" ? "bg-warning/5 hover:bg-warning/10" : ""}`}
                >
                  <div className="h-10 w-10 rounded-full bg-gradient-primary flex items-center justify-center text-primary-foreground font-semibold text-sm shrink-0">
                    {initials}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-sm truncate">
                        {c.customer_name ?? c.customer_number}
                      </span>
                      <span className="text-xs text-muted-foreground shrink-0">{timeAgo}</span>
                    </div>
                    <p className="text-xs text-muted-foreground/80 truncate">{c.customer_number}</p>
                    <p className="text-sm text-muted-foreground truncate mt-0.5">
                      {c.last_message ?? "—"}
                    </p>
                    <div
                      className={`inline-flex items-center gap-1 mt-2 px-2 py-0.5 rounded-full text-[11px] font-medium ${
                        statusStyles[c.status] ?? statusStyles.handled
                      }`}
                    >
                      <Icon className="h-3 w-3" />
                      {statusLabel[c.status] ?? c.status}
                    </div>
                  </div>
                  <div className="shrink-0 self-center text-muted-foreground/40">
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      className="h-4 w-4"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                    </svg>
                  </div>
                </Link>
              );
            })}
          </div>
        </section>
      </main>

      <div className="fixed bottom-6 right-6 flex flex-col items-end gap-3">
        <Link
          to="/contacts"
          className="inline-flex items-center gap-2 rounded-full bg-card text-foreground border border-border px-4 py-3 font-semibold shadow-elegant transition-spring hover:scale-105 active:scale-95"
        >
          <Users className="h-4 w-4 text-primary" />
          Contacts
        </Link>
        <Link
          to="/campaigns"
          className="inline-flex items-center gap-2 rounded-full bg-card text-foreground border border-border px-4 py-3 font-semibold shadow-elegant transition-spring hover:scale-105 active:scale-95"
        >
          <Megaphone className="h-4 w-4 text-primary" />
          Campaigns
        </Link>
        <Link
          to="/automation"
          className="inline-flex items-center gap-2 rounded-full bg-card text-foreground border border-border px-4 py-3 font-semibold shadow-elegant transition-spring hover:scale-105 active:scale-95"
        >
          <Zap className="h-4 w-4 text-primary" />
          Automation
        </Link>
        <Link
          to="/dashboard/niche"
          className="inline-flex items-center gap-2 rounded-full bg-card text-foreground border border-border px-4 py-3 font-semibold shadow-elegant transition-spring hover:scale-105 active:scale-95"
        >
          <Layers className="h-4 w-4 text-primary" />
          Niche Modules
        </Link>
        <Link
          to="/simulator"
          className="inline-flex items-center gap-2 rounded-full bg-card text-foreground border border-border px-4 py-3 font-semibold shadow-elegant transition-spring hover:scale-105 active:scale-95"
        >
          <Sparkles className="h-4 w-4 text-primary" />
          Test AI
        </Link>
        <Link
          to="/settings"
          className="inline-flex items-center gap-2 rounded-full bg-gradient-primary text-primary-foreground px-5 py-3.5 font-semibold shadow-float transition-spring hover:scale-105 active:scale-95"
        >
          <Settings2 className="h-5 w-5" />
          Train My AI
        </Link>
      </div>

      {/* ── TRIAL EXPIRED LOCK OVERLAY (with Cancel Trial option) ── */}
      {trialExpired && sub && (
        <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-md flex items-center justify-center p-5 animate-fade-in">
          <div className="bg-card border border-border/60 rounded-3xl shadow-float max-w-md w-full p-7 text-center">
            <div className="mx-auto h-14 w-14 rounded-2xl bg-primary/10 flex items-center justify-center mb-4">
              <Lock className="h-7 w-7 text-primary" />
            </div>
            <h2 className="text-xl font-bold tracking-tight">Your free trial has ended</h2>
            <p className="text-sm text-muted-foreground mt-2">
              Add your card to keep {PLANS[sub.plan_id].name} active and don't miss any customer
              messages. ₦{PLANS[sub.plan_id].amountNaira.toLocaleString()}/month, cancel anytime.
            </p>
            <Button
              onClick={upgradeNow}
              variant="hero"
              size="lg"
              className="w-full mt-5"
              disabled={upgrading || cancelling}
            >
              {upgrading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Opening Paystack...
                </>
              ) : (
                <>
                  <CreditCard className="h-4 w-4" />
                  Add card & continue
                </>
              )}
            </Button>
            <Link
              to="/pricing"
              className="block text-xs text-muted-foreground hover:text-foreground mt-4"
            >
              Change plan instead
            </Link>
            {/* Cancel trial option */}
            <button
              onClick={handleCancelTrial}
              disabled={cancelling || upgrading}
              className="block w-full text-xs text-muted-foreground hover:text-destructive mt-2 disabled:opacity-50 transition-colors"
            >
              {cancelling ? (
                <span className="flex items-center justify-center gap-1">
                  <Loader2 className="h-3 w-3 animate-spin" /> Cancelling...
                </span>
              ) : (
                "Cancel trial & go back to plans"
              )}
            </button>
            <button
              onClick={signOut}
              className="block w-full text-xs text-muted-foreground hover:text-foreground mt-2"
            >
              Sign out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function formatTimeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
