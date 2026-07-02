import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Check, ArrowLeft, Sparkles, Loader2, CheckCircle2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { type PlanId } from "@/lib/plan";
import { useRequireAuth } from "@/hooks/use-auth";
import { useAuthedServerFn } from "@/lib/authed-fn";
import {
  initSubscriptionCheckout,
  startTrial,
  checkExistingTrial,
} from "@/lib/subscription.functions";

export const Route = createFileRoute("/pricing")({
  head: () => ({
    meta: [
      { title: "Choose Your Plan — Wabizz AI" },
      {
        name: "description",
        content:
          "Pick a Wabizz AI plan that fits your business. Starter, Growth, or Pro — built for Nigerian businesses.",
      },
    ],
  }),
  component: Pricing,
});

type PlanCard = {
  id: PlanId;
  name: string;
  price: string;
  tagline: string;
  features: string[];
  highlight?: boolean;
  badge?: string;
};

const plans: PlanCard[] = [
  {
    id: "starter",
    name: "Starter",
    price: "₦5,000",
    tagline: "For new businesses testing the waters.",
    features: ["100 AI conversations/month", "Payment link generation", "1 WhatsApp number"],
  },
  {
    id: "growth",
    name: "Growth",
    price: "₦12,000",
    tagline: "Most loved by busy Nigerian sellers.",
    highlight: true,
    badge: "Most popular",
    features: [
      "500 AI conversations/month",
      "Everything in Starter",
      "Pidgin language support",
      "Priority support",
    ],
  },
  {
    id: "pro",
    name: "Pro",
    price: "₦25,000",
    tagline: "For shops scaling on WhatsApp.",
    features: [
      "Unlimited conversations",
      "Everything in Growth",
      "Multiple WhatsApp numbers",
      "Monthly business report",
    ],
  },
];

function Pricing() {
  const navigate = useNavigate();
  const { session, loading: authLoading } = useRequireAuth();
  const [loadingId, setLoadingId] = useState<PlanId | "trial" | null>(null);
  const [trialAlreadyStarted, setTrialAlreadyStarted] = useState(false);
  const [checkingTrial, setCheckingTrial] = useState(true);

  const callInit = useAuthedServerFn(initSubscriptionCheckout);
  const callTrial = useAuthedServerFn(startTrial);
  const callCheck = useAuthedServerFn(checkExistingTrial);

  // On mount, check if trial already exists to disable the button
  useEffect(() => {
    if (!session) return;
    callCheck().then((res) => {
      if (res.hasTrial || res.hasActive) setTrialAlreadyStarted(true);
      setCheckingTrial(false);
    });
  }, [session, callCheck]);

  const startFreeTrial = async () => {
    if (trialAlreadyStarted) return;
    setLoadingId("trial");
    const res = await callTrial({ data: { planId: "growth" } });
    setLoadingId(null);
    if (!res.ok) {
      toast.error(res.error ?? "Couldn't start trial");
      if (res.error?.includes("business")) navigate({ to: "/onboarding" });
      return;
    }
    setTrialAlreadyStarted(true);
    toast.success("Your 30-day free trial has started 🎉");
    navigate({ to: "/dashboard" });
  };

  const choose = async (planId: PlanId) => {
    setLoadingId(planId);
    try {
      const res = await callInit({ data: { planId } });
      if (!res.ok || !res.url) {
        toast.error(res.error ?? "Couldn't start checkout");
        if (res.error?.includes("business") || res.error?.includes("email"))
          navigate({ to: "/onboarding" });
        setLoadingId(null);
        return;
      }
      window.location.href = res.url;
    } catch (e) {
      // Client-side network error — surface to user via toast only
      toast.error("Couldn't reach Paystack. Try again.");
      setLoadingId(null);
    }
  };

  if (authLoading) {
    return (
      <div className="min-h-screen bg-gradient-hero flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  const trialButtonDisabled = loadingId !== null || trialAlreadyStarted || checkingTrial;

  return (
    <div className="min-h-screen bg-gradient-hero pb-16">
      <header className="mx-auto max-w-5xl px-5 py-5 flex items-center gap-3">
        <Link
          to="/onboarding"
          className="h-9 w-9 rounded-full flex items-center justify-center hover:bg-card/60 transition-smooth"
        >
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <span className="font-bold tracking-tight">Wabizz AI</span>
      </header>

      <main className="mx-auto max-w-5xl px-5 pt-4 animate-fade-in">
        <div className="text-center max-w-2xl mx-auto mb-10">
          <div className="inline-flex items-center gap-2 rounded-full bg-accent px-3 py-1 text-xs font-medium text-accent-foreground mb-4">
            <Sparkles className="h-3.5 w-3.5" />
            One last step
          </div>
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight leading-tight">
            Choose Your Plan
          </h1>
          <p className="mt-3 text-muted-foreground">
            Cancel anytime. Switch plans whenever your business grows.
          </p>
        </div>

        {/* ── FREE TRIAL SECTION ── */}
        <section className="mb-10 animate-slide-up">
          <div className="relative overflow-hidden rounded-3xl bg-gradient-primary p-6 sm:p-8 shadow-glow">
            <div className="absolute inset-0 opacity-20 pointer-events-none bg-[radial-gradient(circle_at_top_right,white,transparent_60%)]" />
            <div className="relative flex flex-col sm:flex-row sm:items-center gap-5 sm:gap-8">
              <div className="flex-1 text-primary-foreground">
                <div className="inline-flex items-center gap-2 rounded-full bg-white/15 backdrop-blur px-3 py-1 text-[11px] font-semibold mb-3">
                  <Sparkles className="h-3.5 w-3.5" />
                  Free trial · No card required
                </div>
                <h2 className="text-2xl sm:text-3xl font-bold tracking-tight">
                  30-day free trial — no card required
                </h2>
                <p className="mt-2 text-sm sm:text-base text-primary-foreground/90">
                  Test Wabizz on the Growth plan for a full 30 days. Add your card only when you're
                  ready to keep going.
                </p>
                {trialAlreadyStarted && (
                  <div className="mt-3 inline-flex items-center gap-2 rounded-full bg-white/20 px-3 py-1.5 text-sm font-medium">
                    <CheckCircle2 className="h-4 w-4" />
                    Trial is active — go to your dashboard!
                  </div>
                )}
              </div>
              <div className="flex flex-col items-start sm:items-center gap-3 shrink-0">
                <Button
                  onClick={startFreeTrial}
                  size="lg"
                  variant="secondary"
                  className="sm:min-w-[200px] font-semibold disabled:opacity-60"
                  disabled={trialButtonDisabled}
                >
                  {loadingId === "trial" ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Starting...
                    </>
                  ) : trialAlreadyStarted ? (
                    <>
                      <CheckCircle2 className="h-4 w-4" />
                      Trial Active ✓
                    </>
                  ) : checkingTrial ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Checking...
                    </>
                  ) : (
                    "Start Free Trial"
                  )}
                </Button>
                {trialAlreadyStarted && (
                  <Link
                    to="/dashboard"
                    className="text-xs text-primary-foreground/80 hover:text-primary-foreground underline underline-offset-2"
                  >
                    Go to dashboard →
                  </Link>
                )}
              </div>
            </div>
          </div>
          <p className="text-center text-xs text-muted-foreground mt-3">
            Or pick a paid plan below to skip the trial.
          </p>
        </section>

        {/* ── PAID PLANS SECTION ── */}
        <div className="mb-4 px-1">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-widest">
            Paid Plans
          </h2>
        </div>
        <section className="grid grid-cols-1 md:grid-cols-3 gap-5">
          {plans.map((p) => (
            <div
              key={p.id}
              className={`relative bg-card rounded-3xl p-6 border shadow-sm flex flex-col animate-slide-up ${
                p.highlight
                  ? "border-primary/60 shadow-glow md:scale-[1.03] md:-my-2"
                  : "border-border/50"
              }`}
            >
              {p.badge && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                  <span className="bg-gradient-primary text-primary-foreground text-[11px] font-semibold px-3 py-1 rounded-full shadow-sm whitespace-nowrap">
                    {p.badge}
                  </span>
                </div>
              )}

              <h3 className="text-lg font-bold tracking-tight">{p.name}</h3>
              <p className="text-xs text-muted-foreground mt-0.5">{p.tagline}</p>

              <div className="mt-4 flex items-baseline gap-1">
                <span className="text-3xl font-bold tracking-tight">{p.price}</span>
                <span className="text-sm text-muted-foreground">/month</span>
              </div>

              <ul className="mt-5 space-y-2.5 flex-1">
                {p.features.map((f) => (
                  <li key={f} className="flex items-start gap-2 text-sm">
                    <span
                      className={`mt-0.5 h-4 w-4 rounded-full flex items-center justify-center shrink-0 ${
                        p.highlight
                          ? "bg-primary text-primary-foreground"
                          : "bg-primary/10 text-primary"
                      }`}
                    >
                      <Check className="h-3 w-3" strokeWidth={3} />
                    </span>
                    <span className="text-foreground/90">{f}</span>
                  </li>
                ))}
              </ul>

              <Button
                onClick={() => choose(p.id)}
                variant={p.highlight ? "hero" : "outline"}
                size="lg"
                className="w-full mt-6"
                disabled={loadingId !== null}
              >
                {loadingId === p.id ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Opening Paystack...
                  </>
                ) : (
                  "Get Started"
                )}
              </Button>
            </div>
          ))}
        </section>

        <p className="text-center text-xs text-muted-foreground mt-8">
          Prices in Naira. VAT included. You can change or cancel your plan anytime.
        </p>
      </main>
    </div>
  );
}
