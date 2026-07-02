import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  ArrowLeft,
  Plus,
  Trash2,
  Landmark,
  Check,
  ShieldCheck,
  MessageCircle,
  Loader2,
  History,
  Clock,
  Zap,
  XCircle,
  RefreshCw,
  AlertCircle,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { useRequireAuth } from "@/hooks/use-auth";
import { useAuthedServerFn } from "@/lib/authed-fn";
import { getMyBusiness, updateMyBusiness } from "@/lib/business.functions";
import {
  getPaystackStatus,
  savePaystackKeys,
} from "@/lib/keys.functions";
import {
  connectMetaWhatsApp,
  getMetaConnectionStatus,
  disconnectMetaWhatsApp,
} from "@/lib/meta-connect.functions";
import { getSubscriptionHistory } from "@/lib/subscription.functions";
import { PLANS, type PlanId } from "@/lib/plan";

type Tone = "Professional" | "Friendly" | "Pidgin";
type Product = { id: number; name: string; price: string };

type HistoryEntry = {
  id: string;
  event_type: string;
  plan_id: string;
  notes: string | null;
  created_at: string;
};

type CurrentSub = {
  status: string;
  plan_id: PlanId;
  trial_ends_at: string | null;
  current_period_end: string | null;
  created_at: string;
};

type MetaConnectionStatus = {
  businessNumber: string | null;
  phoneNumberId: string | null;
  wabaId: string | null;
  businessManagerId: string | null;
  connectedVia: string | null;
  coexistenceEnabled: boolean;
  coexistenceEligible: boolean;
  connectedAt: string | null;
};

// ── Nigerian phone helpers ─────────────────────────────────────────────────────
const NG_LOCAL_RE = /^(070|080|081|090|091)\d{8}$/;
const NG_INTL_RE = /^\+234(70|80|81|90|91)\d{8}$/;

function isValidNigerianPhone(raw: string): boolean {
  const v = raw.replace(/[\s-]/g, "");
  return NG_LOCAL_RE.test(v) || NG_INTL_RE.test(v);
}

function normalizeToE164(raw: string): string {
  const v = raw.replace(/[\s-]/g, "");
  if (v.startsWith("+234")) return v;
  return "+234" + v.slice(1);
}

// ── Nigerian banks ─────────────────────────────────────────────────────────────
const NIGERIAN_BANKS = [
  "OPay",
  "Moniepoint",
  "Kuda Bank",
  "PalmPay",
  "UBA",
  "GTBank",
  "First Bank",
  "Zenith Bank",
  "Access Bank",
  "Providus Bank",
  "Wema Bank",
  "Stanbic IBTC",
  "Fidelity Bank",
  "Sterling Bank",
  "Union Bank",
  "Polaris Bank",
  "Keystone Bank",
  "Ecobank",
  "Heritage Bank",
  "Jaiz Bank",
];

function parseProducts(text: string): Product[] {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.map((line, i) => {
    const m = line.match(/^(.+?)[\s–\-—:]+₦?\s*([\d,]+)/);
    if (m) return { id: i + 1, name: m[1].trim(), price: m[2].replace(/,/g, "") };
    return { id: i + 1, name: line, price: "" };
  });
}
function serializeProducts(products: Product[]): string {
  return products
    .filter((p) => p.name.trim())
    .map((p) => (p.price ? `${p.name} – ₦${Number(p.price).toLocaleString()}` : p.name))
    .join("\n");
}

const eventMeta: Record<string, { label: string; icon: typeof Zap; color: string }> = {
  trial_started: { label: "Trial Started", icon: Zap, color: "text-primary" },
  trial_cancelled: { label: "Trial Cancelled", icon: XCircle, color: "text-destructive" },
  trial_expired: { label: "Trial Expired", icon: AlertCircle, color: "text-warning-foreground" },
  plan_activated: { label: "Plan Activated", icon: Check, color: "text-success" },
  plan_renewed: { label: "Plan Renewed", icon: RefreshCw, color: "text-success" },
  plan_cancelled: { label: "Plan Cancelled", icon: XCircle, color: "text-destructive" },
};

function useCountdown(targetIso: string | null) {
  const calc = () => {
    if (!targetIso) return null;
    const diff = new Date(targetIso).getTime() - Date.now();
    if (diff <= 0) return null;
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((diff % (1000 * 60)) / 1000);
    return { days, hours, minutes, seconds };
  };
  const [t, setT] = useState(calc);
  useEffect(() => {
    if (!targetIso) return;
    const id = setInterval(() => setT(calc()), 1000);
    return () => clearInterval(id);
  }, [targetIso]);
  return t;
}

export const Route = createFileRoute("/settings")({
  head: () => ({
    meta: [
      { title: "Train My AI — Wabizz AI" },
      {
        name: "description",
        content: "Customize your AI assistant's products, tone, and replies.",
      },
    ],
  }),
  component: SettingsPage,
});

function SettingsPage() {
  const navigate = useNavigate();
  const { session, loading: authLoading } = useRequireAuth();
  const callBiz = useAuthedServerFn(getMyBusiness);
  const callUpdate = useAuthedServerFn(updateMyBusiness);
  const callPS = useAuthedServerFn(getPaystackStatus);
  const callSavePS = useAuthedServerFn(savePaystackKeys);
  const callGetMeta = useAuthedServerFn(getMetaConnectionStatus);
  const callConnectMeta = useAuthedServerFn(connectMetaWhatsApp);
  const callDisconnectMeta = useAuthedServerFn(disconnectMetaWhatsApp);
  const callHistory = useAuthedServerFn(getSubscriptionHistory);

  const [hydrating, setHydrating] = useState(true);
  const [products, setProducts] = useState<Product[]>([]);
  const [tone, setTone] = useState<Tone>("Friendly");
  const [customMessage, setCustomMessage] = useState("");
  const [timezone, setTimezone] = useState("Africa/Lagos");
  const [saved, setSaved] = useState(false);

  // Bank transfer state (replaces Paystack)
  const [bankConnected, setBankConnected] = useState(false);
  const [bankOpen, setBankOpen] = useState(false);
  const [bankName, setBankName] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [accountName, setAccountName] = useState("");

  // WhatsApp / Meta state
  const [waConnected, setWaConnected] = useState(false);
  const [waNumber, setWaNumber] = useState<string | null>(null);
  const [waStatus, setWaStatus] = useState<MetaConnectionStatus | null>(null);
  const [waConnecting, setWaConnecting] = useState(false);
  const [waError, setWaError] = useState<string | null>(null);

  const [subHistory, setSubHistory] = useState<HistoryEntry[]>([]);
  const [currentSub, setCurrentSub] = useState<CurrentSub | null>(null);

  const countdown = useCountdown(
    currentSub?.status === "trial" ? (currentSub.trial_ends_at ?? null) : null,
  );

  useEffect(() => {
    if (!session) return;
    Promise.all([callBiz(), callPS(), callGetMeta(), callHistory()])
      .then(([biz, ps, wa, hist]) => {
        if (!biz.business) {
          navigate({ to: "/onboarding" });
          return;
        }
        setProducts(parseProducts(biz.business.products_list));
        setTone(biz.business.tone as Tone);
        setCustomMessage(biz.business.custom_message ?? "");
        setTimezone((biz.business as { timezone?: string }).timezone ?? "Africa/Lagos");

        // Load bank transfer info from Paystack status (reusing existing storage)
        // Bank details are stored as public_key = "BANK:bankName|accountNumber|accountName"
        if (ps.connected && ps.publicKey?.startsWith("BANK:")) {
          const parts = ps.publicKey.replace("BANK:", "").split("|");
          setBankName(parts[0] ?? "");
          setAccountNumber(parts[1] ?? "");
          setAccountName(parts[2] ?? "");
          setBankConnected(true);
        }

        setWaConnected(wa.connected);
        setWaNumber(wa.phoneNumber ?? null);
        setWaStatus((wa.status ?? null) as MetaConnectionStatus | null);
        setSubHistory((hist.history ?? []) as HistoryEntry[]);
        setCurrentSub((hist.currentSub ?? null) as CurrentSub | null);
        setHydrating(false);
      })
      .catch(() => {
        toast.error("Couldn't load settings. Check your connection and refresh.");
        setHydrating(false);
      });
  }, [session, callBiz, callPS, callGetMeta, callHistory, navigate]);

  const handleSaveBankTransfer = async () => {
    if (!bankName) return toast.error("Please select your bank 😄");
    const acctNum = accountNumber.trim();
    if (!/^\d{10}$/.test(acctNum))
      return toast.error("Account number must be exactly 10 digits (NUBAN) 😄");
    if (!accountName.trim())
      return toast.error("Please enter your account name 😄");

    // Store bank details encoded in the public_key field using a BANK: prefix.
    // This reuses the existing paystack_keys table without schema changes.
    const encodedPublicKey = `BANK:${bankName}|${acctNum}|${accountName.trim()}`;
    // Use a placeholder secret key (bank transfer doesn't need one)
    const res = await callSavePS({
      data: { publicKey: encodedPublicKey, secretKey: "sk_bank_transfer_placeholder" },
    });
    if (!res.ok) return toast.error(res.error ?? "Couldn't save bank details");
    setBankConnected(true);
    setBankOpen(false);
    toast.success("Bank transfer details saved 🎉");
  };

  /** Called by the Facebook SDK after Embedded Signup completes */
  const handleMetaSignupComplete = async (response: {
    accessToken: string;
    phoneNumberId?: string;
    wabaId?: string;
  }) => {
    setWaConnecting(true);
    setWaError(null);
    try {
      const res = await callConnectMeta({
        data: {
          shortLivedToken: response.accessToken,
          phoneNumberId: response.phoneNumberId,
          wabaId: response.wabaId,
        },
      });
      if (!res.ok) {
        setWaError(res.error ?? "Connection failed. Please try again.");
        return;
      }
      setWaConnected(true);
      setWaNumber(res.phoneNumber);
      toast.success("WhatsApp Business connected! 🎉");
    } catch (err) {
      setWaError(`Unexpected error: ${String(err)}`);
    } finally {
      setWaConnecting(false);
    }
  };

  const handleDisconnectWhatsApp = async () => {
    const res = await callDisconnectMeta();
    if (!res.ok) return toast.error(res.error ?? "Couldn't disconnect");
    setWaConnected(false);
    setWaNumber(null);
    toast.success("WhatsApp disconnected.");
  };

  /** Launch the Facebook Embedded Signup popup */
  const launchFacebookSignup = () => {
    setWaError(null);
    const FB = (window as unknown as {
      FB?: {
        login: (
          cb: (resp: { authResponse?: { accessToken: string } }) => void,
          opts: object,
        ) => void;
      };
    }).FB;

    if (!FB) {
      setWaError("Facebook SDK not loaded. Please refresh the page and try again.");
      return;
    }

    // BUG 1+2 FIX:
    // 1. FB.login needs config_id + response_type:"token" for Embedded Signup.
    //    Without config_id the user sees standard OAuth, not the WhatsApp
    //    Business selector.
    // 2. The FB.login callback does NOT return phoneNumberId or wabaId.
    //    Those come from Meta's WA_EMBEDDED_SIGNUP postMessage event.
    //    We listen for it before calling FB.login and clean up after.

    const sessionData = { phoneNumberId: "", wabaId: "" };

    const onMessage = (e: MessageEvent) => {
      if (
        e.origin !== "https://www.facebook.com" &&
        e.origin !== "https://web.facebook.com"
      )
        return;
      try {
        const d = JSON.parse(e.data as string) as {
          type?: string;
          data?: { phone_number_id?: string; waba_id?: string };
        };
        if (d.type === "WA_EMBEDDED_SIGNUP" && d.data) {
          sessionData.phoneNumberId = d.data.phone_number_id ?? "";
          sessionData.wabaId = d.data.waba_id ?? "";
        }
      } catch {
        /* non-JSON messages from other origins — ignore */
      }
    };

    window.addEventListener("message", onMessage);

    const configId = (
      import.meta as unknown as { env: Record<string, string> }
    ).env.VITE_META_CONFIG_ID ?? "";

    FB.login(
      (response) => {
        window.removeEventListener("message", onMessage);
        if (response.authResponse?.accessToken) {
          void handleMetaSignupComplete({
            accessToken: response.authResponse.accessToken,
            phoneNumberId: sessionData.phoneNumberId || undefined,
            wabaId: sessionData.wabaId || undefined,
          });
        } else {
          setWaError("Facebook login was cancelled or failed. Please try again.");
        }
      },
      {
        config_id: configId,
        response_type: "token",
        override_default_response_type: true,
        extras: {
          sessionInfoVersion: 2,
          setup: {},
        },
      },
    );
  };

  const addProduct = () => setProducts((p) => [...p, { id: Date.now(), name: "", price: "" }]);
  const removeProduct = (id: number) => setProducts((p) => p.filter((x) => x.id !== id));
  const updateProduct = (id: number, field: "name" | "price", value: string) =>
    setProducts((p) => p.map((x) => (x.id === id ? { ...x, [field]: value } : x)));

  const handleSave = async () => {
    const res = await callUpdate({
      data: {
        products_list: serializeProducts(products),
        tone,
        custom_message: customMessage.trim(),
        timezone,
      },
    });
    if (res.error) return toast.error(res.error);
    setSaved(true);
    toast.success("Your AI is updated!");
    setTimeout(() => navigate({ to: "/dashboard" }), 600);
  };

  const tones: Tone[] = ["Professional", "Friendly", "Pidgin"];

  if (authLoading || hydrating) {
    return (
      <div className="min-h-screen bg-surface flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-surface pb-32">
      <header className="bg-card border-b border-border/60 sticky top-0 z-10 backdrop-blur-md bg-card/90">
        <div className="mx-auto max-w-2xl px-5 py-4 flex items-center gap-3">
          <Link
            to="/dashboard"
            className="h-9 w-9 rounded-full flex items-center justify-center hover:bg-muted transition-smooth"
          >
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <div>
            <h1 className="text-lg font-bold tracking-tight">Train My AI</h1>
            <p className="text-xs text-muted-foreground">Make it sound just like you</p>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-2xl px-5 py-6 space-y-6 animate-fade-in">
        {/* Products */}
        <section className="bg-card rounded-2xl p-5 sm:p-6 border border-border/50 shadow-sm">
          <div className="mb-4">
            <h2 className="text-base font-semibold">Products & prices</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Your AI quotes from this list — keep it fresh.
            </p>
          </div>
          <div className="space-y-2.5">
            {products.map((p) => (
              <div key={p.id} className="flex gap-2 items-center animate-slide-up">
                <Input
                  placeholder="Product name"
                  value={p.name}
                  onChange={(e) => updateProduct(p.id, "name", e.target.value)}
                  className="flex-1"
                />
                <div className="relative w-32">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                    ₦
                  </span>
                  <Input
                    placeholder="0"
                    value={p.price}
                    onChange={(e) => updateProduct(p.id, "price", e.target.value)}
                    className="pl-7"
                    inputMode="numeric"
                  />
                </div>
                <button
                  onClick={() => removeProduct(p.id)}
                  className="h-10 w-10 shrink-0 rounded-lg flex items-center justify-center text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-smooth"
                  aria-label="Remove"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
          <Button onClick={addProduct} variant="outline" className="w-full mt-4 border-dashed">
            <Plus className="h-4 w-4" />
            Add product
          </Button>
        </section>

        {/* Custom message */}
        <section className="bg-card rounded-2xl p-5 sm:p-6 border border-border/50 shadow-sm space-y-3">
          <div>
            <h2 className="text-base font-semibold">Custom message</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Is there anything your AI should always say?
            </p>
          </div>
          <Textarea
            placeholder="E.g. Delivery is free for orders above ₦20,000."
            rows={3}
            value={customMessage}
            onChange={(e) => setCustomMessage(e.target.value)}
            className="resize-none"
          />
        </section>

        {/* Timezone */}
        <section className="bg-card rounded-2xl p-5 sm:p-6 border border-border/50 shadow-sm">
          <div className="mb-4">
            <h2 className="text-base font-semibold">Business timezone</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Used to enforce your opening hours correctly for customers in different regions.
            </p>
          </div>
          <select
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
          >
            <optgroup label="Africa">
              <option value="Africa/Lagos">Africa/Lagos (WAT, UTC+1) — Nigeria, West Africa</option>
              <option value="Africa/Accra">Africa/Accra (GMT, UTC+0) — Ghana</option>
              <option value="Africa/Nairobi">
                Africa/Nairobi (EAT, UTC+3) — Kenya, East Africa
              </option>
              <option value="Africa/Johannesburg">
                Africa/Johannesburg (SAST, UTC+2) — South Africa
              </option>
              <option value="Africa/Cairo">Africa/Cairo (EET, UTC+2) — Egypt</option>
            </optgroup>
            <optgroup label="Europe">
              <option value="Europe/London">Europe/London (GMT/BST)</option>
              <option value="Europe/Paris">Europe/Paris (CET/CEST)</option>
              <option value="Europe/Berlin">Europe/Berlin (CET/CEST)</option>
            </optgroup>
            <optgroup label="Americas">
              <option value="America/New_York">America/New_York (ET)</option>
              <option value="America/Chicago">America/Chicago (CT)</option>
              <option value="America/Los_Angeles">America/Los_Angeles (PT)</option>
              <option value="America/Sao_Paulo">America/Sao_Paulo (BRT)</option>
            </optgroup>
            <optgroup label="Asia / Pacific">
              <option value="Asia/Dubai">Asia/Dubai (GST, UTC+4)</option>
              <option value="Asia/Kolkata">Asia/Kolkata (IST, UTC+5:30)</option>
              <option value="Asia/Singapore">Asia/Singapore (SGT, UTC+8)</option>
              <option value="Asia/Tokyo">Asia/Tokyo (JST, UTC+9)</option>
              <option value="Australia/Sydney">Australia/Sydney (AEST/AEDT)</option>
            </optgroup>
          </select>
        </section>

        {/* Tone */}
        <section className="bg-card rounded-2xl p-5 sm:p-6 border border-border/50 shadow-sm">
          <div className="mb-4">
            <h2 className="text-base font-semibold">Tone of voice</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              How should your AI talk to customers?
            </p>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {tones.map((t) => (
              <button
                key={t}
                onClick={() => setTone(t)}
                className={`relative py-3 px-2 rounded-xl text-sm font-medium transition-spring border-2 ${
                  tone === t
                    ? "border-primary bg-primary/10 text-primary shadow-sm"
                    : "border-border bg-background text-foreground hover:border-primary/40"
                }`}
              >
                {tone === t && (
                  <Check className="absolute top-1.5 right-1.5 h-3.5 w-3.5 text-primary" />
                )}
                {t}
              </button>
            ))}
          </div>
        </section>

        {/* Bank Transfer (replaces Paystack) */}
        <section className="bg-card rounded-2xl p-5 sm:p-6 border border-border/50 shadow-sm">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3 min-w-0">
              <div className="h-11 w-11 rounded-xl bg-accent flex items-center justify-center shrink-0">
                <Landmark className="h-5 w-5 text-primary" />
              </div>
              <div className="min-w-0">
                <h2 className="text-base font-semibold truncate">
                  {bankConnected ? "Bank Transfer" : "Set Up Bank Transfer"}
                </h2>
                {bankConnected ? (
                  <div className="flex flex-col gap-0.5 mt-1">
                    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-success bg-success/10 px-2 py-0.5 rounded-full self-start">
                      <ShieldCheck className="h-3 w-3" />
                      Bank details saved ✓
                    </span>
                    <span className="text-[11px] text-muted-foreground truncate">
                      {bankName} · {accountNumber}
                    </span>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground truncate">
                    Let your AI send customers your account details at checkout.
                  </p>
                )}
              </div>
            </div>
            <Button
              variant={bankConnected ? "ghost" : "outline"}
              size="sm"
              onClick={() => setBankOpen(true)}
            >
              {bankConnected ? "Edit" : "Set Up"}
            </Button>
          </div>
        </section>

        {/* WhatsApp — Meta Embedded Signup */}
        <section className="bg-card rounded-2xl p-5 sm:p-6 border border-border/50 shadow-sm space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3 min-w-0">
              <div className="h-11 w-11 rounded-xl bg-success/15 flex items-center justify-center shrink-0">
                <MessageCircle className="h-5 w-5 text-success" />
              </div>
              <div className="min-w-0">
                <h2 className="text-base font-semibold truncate">
                  {waConnected ? "WhatsApp Business" : "Connect WhatsApp"}
                </h2>
                {waConnected ? (
                  <div className="flex flex-col gap-1 mt-1">
                    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-success bg-success/10 px-2 py-0.5 rounded-full self-start">
                      <ShieldCheck className="h-3 w-3" />
                      WhatsApp Connected ✓
                    </span>
                    {waNumber && (
                      <span className="text-[11px] text-muted-foreground truncate">{waNumber}</span>
                    )}
                    {/* Coexistence status badge */}
                    {waStatus?.coexistenceEnabled ? (
                      <span className="inline-flex items-center gap-1 text-[10px] font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full self-start">
                        Coexistence ON — App + AI active simultaneously
                      </span>
                    ) : waStatus?.coexistenceEligible === false ? (
                      <span className="inline-flex items-center gap-1 text-[10px] font-medium text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full self-start">
                        ⚠ Coexistence unavailable for your number
                      </span>
                    ) : null}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground truncate">
                    Let your AI reply to real customers on WhatsApp.
                  </p>
                )}
              </div>
            </div>
            {waConnected && (
              <Button variant="ghost" size="sm" onClick={handleDisconnectWhatsApp}>
                Disconnect
              </Button>
            )}
          </div>

          {/* Nigerian / unsupported number coexistence warning — shown when connected */}
          {waConnected && waStatus?.coexistenceEligible === false && (
            <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-xs text-amber-800 space-y-1">
              <p className="font-semibold">⚠️ WhatsApp Coexistence not available for your number</p>
              <p className="leading-relaxed">
                Meta does not currently support Coexistence for Nigerian (+234) numbers. This means
                you cannot use the WhatsApp Business App on this number at the same time as Wabizz.
                The AI will handle all incoming messages. Meta is expanding Coexistence support —
                you'll be able to enable it here once your country is included.
              </p>
            </div>
          )}

          {!waConnected && (
            <div className="rounded-xl bg-muted/60 border border-border/60 p-4 space-y-3">
              <div className="space-y-1">
                <p className="text-sm font-semibold">Connect in seconds via Facebook</p>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Click the button below to open a secure Facebook popup. Log in with your Facebook
                  account, select your WhatsApp Business number, and approve access. That's it —
                  no API keys to copy, no technical setup.
                </p>
              </div>
              <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                <span className="flex items-center gap-1">
                  <ShieldCheck className="h-3 w-3 text-success" />
                  Facebook-verified & secure
                </span>
                <span className="flex items-center gap-1">
                  <Check className="h-3 w-3 text-success" />
                  Takes less than 2 minutes
                </span>
                <span className="flex items-center gap-1">
                  <Check className="h-3 w-3 text-success" />
                  No credit card needed
                </span>
              </div>
              {waError && (
                <p className="text-xs text-destructive bg-destructive/10 rounded-lg px-3 py-2">
                  {waError}
                </p>
              )}
              <Button
                variant="hero"
                onClick={launchFacebookSignup}
                disabled={waConnecting}
                className="w-full sm:w-auto"
              >
                {waConnecting ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Connecting…
                  </>
                ) : (
                  <>
                    <MessageCircle className="h-4 w-4" />
                    Connect WhatsApp via Facebook
                  </>
                )}
              </Button>
              <p className="text-[11px] text-muted-foreground">
                The popup is opened by Facebook directly — Wabizz never sees your Facebook
                password. We only receive a secure token to send messages on your behalf.
              </p>
            </div>
          )}
        </section>

        {/* Subscription History */}
        <section className="bg-card rounded-2xl p-5 sm:p-6 border border-border/50 shadow-sm">
          <div className="flex items-center gap-2 mb-5">
            <History className="h-5 w-5 text-primary" />
            <div>
              <h2 className="text-base font-semibold">Subscription History</h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                Your trial dates, plan changes, and renewal records.
              </p>
            </div>
          </div>

          {currentSub && (
            <div className="mb-5 rounded-xl bg-primary/5 border border-primary/20 p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold text-primary uppercase tracking-wide mb-1">
                    Current Plan
                  </p>
                  <p className="text-base font-bold">
                    {PLANS[currentSub.plan_id]?.name ?? currentSub.plan_id}
                    {" · "}
                    <span
                      className={`text-sm font-medium ${
                        currentSub.status === "active"
                          ? "text-success"
                          : currentSub.status === "trial"
                            ? "text-warning-foreground"
                            : "text-muted-foreground"
                      }`}
                    >
                      {currentSub.status.charAt(0).toUpperCase() + currentSub.status.slice(1)}
                    </span>
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Started:{" "}
                    {new Date(currentSub.created_at).toLocaleDateString("en-NG", {
                      year: "numeric",
                      month: "short",
                      day: "numeric",
                    })}
                  </p>
                  {currentSub.trial_ends_at && (
                    <p className="text-xs text-muted-foreground">
                      Trial ends:{" "}
                      {new Date(currentSub.trial_ends_at).toLocaleDateString("en-NG", {
                        year: "numeric",
                        month: "short",
                        day: "numeric",
                      })}
                    </p>
                  )}
                  {currentSub.current_period_end && (
                    <p className="text-xs text-muted-foreground">
                      Renews:{" "}
                      {new Date(currentSub.current_period_end).toLocaleDateString("en-NG", {
                        year: "numeric",
                        month: "short",
                        day: "numeric",
                      })}
                    </p>
                  )}
                </div>

                {currentSub.status === "trial" && countdown && (
                  <div className="shrink-0 text-right">
                    <p className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide mb-1 flex items-center gap-1 justify-end">
                      <Clock className="h-3 w-3" />
                      Trial ends in
                    </p>
                    <div className="flex items-center gap-1 font-mono font-bold text-sm text-primary">
                      {countdown.days > 0 && (
                        <span className="rounded bg-primary/10 px-1.5 py-0.5">
                          {countdown.days}d
                        </span>
                      )}
                      <span className="rounded bg-primary/10 px-1.5 py-0.5">
                        {String(countdown.hours).padStart(2, "0")}h
                      </span>
                      <span className="rounded bg-primary/10 px-1.5 py-0.5">
                        {String(countdown.minutes).padStart(2, "0")}m
                      </span>
                      <span className="rounded bg-primary/10 px-1.5 py-0.5">
                        {String(countdown.seconds).padStart(2, "0")}s
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {subHistory.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">
              No subscription history yet. Start your free trial to see events here.
            </p>
          ) : (
            <div className="relative pl-5 space-y-0">
              <div className="absolute left-[9px] top-2 bottom-2 w-px bg-border/60" />
              {subHistory.map((entry, i) => {
                const meta = eventMeta[entry.event_type] ?? {
                  label: entry.event_type,
                  icon: History,
                  color: "text-muted-foreground",
                };
                const Icon = meta.icon;
                return (
                  <div key={entry.id} className={`relative flex gap-3 ${i > 0 ? "pt-4" : ""}`}>
                    <div
                      className={`absolute -left-5 top-0.5 h-5 w-5 rounded-full bg-card border-2 border-border flex items-center justify-center ${meta.color}`}
                    >
                      <Icon className="h-2.5 w-2.5" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2">
                        <p className={`text-sm font-semibold ${meta.color}`}>{meta.label}</p>
                        <p className="text-[11px] text-muted-foreground shrink-0">
                          {new Date(entry.created_at).toLocaleDateString("en-NG", {
                            month: "short",
                            day: "numeric",
                            year: "numeric",
                          })}
                        </p>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {PLANS[entry.plan_id as PlanId]?.name ?? entry.plan_id} plan
                      </p>
                      {entry.notes && (
                        <p className="text-xs text-muted-foreground/70 mt-0.5 truncate">
                          {entry.notes}
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </main>

      {/* Bank Transfer Dialog */}
      <Dialog open={bankOpen} onOpenChange={setBankOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Bank Transfer Details</DialogTitle>
            <DialogDescription>
              Your AI will share these details with customers when they're ready to pay.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="bank-name">Bank name</Label>
              <Select value={bankName} onValueChange={setBankName}>
                <SelectTrigger id="bank-name">
                  <SelectValue placeholder="Select your bank" />
                </SelectTrigger>
                <SelectContent>
                  {NIGERIAN_BANKS.map((bank) => (
                    <SelectItem key={bank} value={bank}>
                      {bank}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="account-number">Account number</Label>
              <Input
                id="account-number"
                placeholder="0123456789"
                value={accountNumber}
                onChange={(e) => setAccountNumber(e.target.value.replace(/\D/g, "").slice(0, 10))}
                inputMode="numeric"
                maxLength={10}
                autoComplete="off"
              />
              <p className="text-xs text-muted-foreground">10-digit NUBAN account number.</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="account-name">Account name</Label>
              <Input
                id="account-name"
                placeholder="e.g. Mama Nkechi Fashion"
                value={accountName}
                onChange={(e) => setAccountName(e.target.value)}
                autoComplete="off"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setBankOpen(false)}>
              Cancel
            </Button>
            <Button variant="hero" onClick={handleSaveBankTransfer}>
              Save details
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* WhatsApp connection handled inline via Embedded Signup — no dialog needed */}

      <div className="fixed bottom-0 left-0 right-0 bg-card/95 backdrop-blur-md border-t border-border/60 p-4">
        <div className="mx-auto max-w-2xl">
          <Button onClick={handleSave} variant="hero" size="xl" className="w-full" disabled={saved}>
            {saved ? (
              <>
                <Check className="h-5 w-5" />
                Saved!
              </>
            ) : (
              "Save Changes"
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
