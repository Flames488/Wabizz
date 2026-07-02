import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Sparkles, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useRequireAuth } from "@/hooks/use-auth";
import { useAuthedServerFn } from "@/lib/authed-fn";
import { getMyBusiness, upsertMyBusiness } from "@/lib/business.functions";

export const Route = createFileRoute("/onboarding")({
  head: () => ({
    meta: [
      { title: "Wabizz AI — Your WhatsApp Business Assistant" },
      {
        name: "description",
        content:
          "Activate your AI WhatsApp assistant in minutes. Built for Nigerian small businesses.",
      },
    ],
  }),
  component: Onboarding,
});

// ── Nigerian phone helpers ─────────────────────────────────────────────────────
const NG_PREFIX_RE = /^(070|080|081|090|091)\d{8}$/;
const NG_INTL_PREFIX_RE = /^\+234(70|80|81|90|91)\d{8}$/;

/**
 * Returns true if the input looks like a valid Nigerian number in either format:
 *   local:  080XXXXXXXX  (11 digits starting with 070/080/081/090/091)
 *   E.164:  +23480XXXXXXXX
 */
function isValidNigerianPhone(raw: string): boolean {
  const v = raw.replace(/[\s-]/g, "");
  return NG_PREFIX_RE.test(v) || NG_INTL_PREFIX_RE.test(v);
}

/**
 * Normalize any valid Nigerian number to E.164 (+234XXXXXXXXXX).
 * Local format: strip leading 0, prepend +234.
 */
function normalizeToE164(raw: string): string {
  const v = raw.replace(/[\s-]/g, "");
  if (v.startsWith("+234")) return v;
  // local format — strip leading 0
  return "+234" + v.slice(1);
}

function Onboarding() {
  const navigate = useNavigate();
  const { session, loading: authLoading } = useRequireAuth();
  const callGet = useAuthedServerFn(getMyBusiness);
  const callUpsert = useAuthedServerFn(upsertMyBusiness);

  const [submitting, setSubmitting] = useState(false);
  const [hydrating, setHydrating] = useState(true);
  const [businessName, setBusinessName] = useState("");
  const [businessType, setBusinessType] = useState("Fashion");
  const [email, setEmail] = useState("");
  const [whatsapp, setWhatsapp] = useState("");
  const [openTime, setOpenTime] = useState("09:00");
  const [closeTime, setCloseTime] = useState("20:00");
  const [productsList, setProductsList] = useState("");

  useEffect(() => {
    if (!session) return;
    setEmail(session.user.email ?? "");
    callGet().then((res) => {
      if (res.business) {
        setBusinessName(res.business.name);
        setBusinessType(res.business.type);
        setEmail(res.business.email || session.user.email || "");
        setWhatsapp(res.business.whatsapp);
        setOpenTime(res.business.open_time);
        setCloseTime(res.business.close_time);
        setProductsList(res.business.products_list);
      }
      setHydrating(false);
    });
  }, [session, callGet]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!businessName.trim()) return toast.error("Oga, please enter your business name first 😄");
    if (!businessType) return toast.error("Abeg, tell us what you sell 🛍️");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))
      return toast.error("Oga, drop a valid email so we can send your receipts 📧");

    if (!isValidNigerianPhone(whatsapp))
      return toast.error(
        "Enter a valid Nigerian WhatsApp number — e.g. 08012345678 or +2348012345678 📱",
      );

    if (!openTime || !closeTime || openTime === closeTime)
      return toast.error("Set proper open and close times ⏰");
    if (!productsList.trim() || productsList.trim().length < 5)
      return toast.error("Add at least one product so your AI knows what to sell 🧺");

    setSubmitting(true);
    try {
      const res = await callUpsert({
        data: {
          name: businessName.trim(),
          type: businessType,
          email: email.trim(),
          whatsapp: normalizeToE164(whatsapp.trim()),
          open_time: openTime,
          close_time: closeTime,
          products_list: productsList.trim(),
          tone: "Friendly",
          custom_message: "",
        },
      });
      if (res.error) {
        toast.error(res.error);
        return;
      }
      toast.success(`Welcome ${businessName.trim()}! Your AI is warming up 🚀`);
      setTimeout(() => navigate({ to: "/pricing" }), 500);
    } finally {
      setSubmitting(false);
    }
  };

  if (authLoading || hydrating) {
    return (
      <div className="min-h-screen bg-gradient-hero flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-hero">
      <div className="mx-auto max-w-xl px-5 py-10 sm:py-16 animate-fade-in">
        <div className="flex items-center gap-3 mb-10">
          <img src="/wabizz-logo.png" alt="Wabizz logo" className="h-11 w-auto" />
        </div>

        <div className="mb-8 animate-slide-up">
          <div className="inline-flex items-center gap-2 rounded-full bg-accent px-3 py-1 text-xs font-medium text-accent-foreground mb-4">
            <Sparkles className="h-3.5 w-3.5" />
            Setup in under 2 minutes
          </div>
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight leading-tight">
            Let's get your AI ready to sell.
          </h1>
          <p className="mt-3 text-muted-foreground text-base">
            Tell us about your business. Your assistant will handle WhatsApp orders, answer
            customers, and never sleep — even at 2am.
          </p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="bg-card rounded-3xl p-6 sm:p-8 shadow-elegant border border-border/50 space-y-5 animate-slide-up"
        >
          <div className="space-y-2">
            <Label htmlFor="name">Business name</Label>
            <Input
              id="name"
              placeholder="e.g. Mama Nkechi Fashion"
              value={businessName}
              onChange={(e) => setBusinessName(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="type">What do you sell?</Label>
            <Select value={businessType} onValueChange={setBusinessType}>
              <SelectTrigger id="type">
                <SelectValue placeholder="Choose a category" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="Fashion">Fashion</SelectItem>
                <SelectItem value="Food & Drinks">Food & Drinks</SelectItem>
                <SelectItem value="Clinic / Health">Clinic / Health</SelectItem>
                <SelectItem value="Services">Services</SelectItem>
                <SelectItem value="Electronics">Electronics</SelectItem>
                <SelectItem value="Other">Other</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="email">Email address</Label>
            <Input
              id="email"
              type="email"
              placeholder="you@yourbusiness.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              We'll send your subscription receipts here.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="whatsapp">WhatsApp number</Label>
            <Input
              id="whatsapp"
              type="tel"
              placeholder="08012345678 or +2348012345678"
              value={whatsapp}
              onChange={(e) => setWhatsapp(e.target.value)}
              inputMode="tel"
            />
            <p className="text-xs text-muted-foreground">
              Nigerian number — local (080…) or international (+234 80…) format accepted.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="open">Opens at</Label>
              <Input
                id="open"
                type="time"
                value={openTime}
                onChange={(e) => setOpenTime(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="close">Closes at</Label>
              <Input
                id="close"
                type="time"
                value={closeTime}
                onChange={(e) => setCloseTime(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="products">Your products & prices</Label>
            <Textarea
              id="products"
              placeholder={"Ankara gown – ₦15,000\nSenator wear – ₦25,000\nAso-ebi – ₦12,000"}
              rows={5}
              value={productsList}
              onChange={(e) => setProductsList(e.target.value)}
              className="resize-none font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">
              One item per line. Don't worry, you can edit anytime.
            </p>
          </div>

          <Button type="submit" variant="hero" size="xl" className="w-full" disabled={submitting}>
            {submitting ? "Activating..." : "Activate My AI Assistant"}
          </Button>
          <p className="text-center text-xs text-muted-foreground">
            No card needed. Start with a 30-day free trial.
          </p>
        </form>
      </div>
    </div>
  );
}
