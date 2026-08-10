/**
 * /admin — Wabizz Control Plane
 *
 * Log in via /auth (same email+password form as regular users — admin
 * credentials are checked first, then it falls back to Supabase).
 *
 * Tabs: Overview · Revenue · Users · Queue · Alerts · Logs · Health · Trace
 */

import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect, useCallback, useRef } from "react";
import {
  LayoutDashboard,
  Wallet,
  Users as UsersIcon,
  ListOrdered,
  Bell,
  ScrollText,
  HeartPulse,
  Radar,
  Sun,
  Moon,
  LogOut,
  RefreshCw,
  Building2,
  Sparkles,
  CalendarDays,
  Gem,
  TrendingUp,
  Zap,
  MessageCircle,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Info,
  ChevronDown,
  ChevronRight,
  Menu,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Sheet,
  SheetContent,
  SheetTrigger,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";

export const Route = createFileRoute("/admin/")({
  head: () => ({
    meta: [{ title: "Wabizz — Control Plane" }, { name: "robots", content: "noindex, nofollow" }],
  }),
  component: AdminPage,
});

// ── Types ──────────────────────────────────────────────────────────────────────
interface Overview {
  activeUsers: number;
  totalBusinesses: number;
  totalMessages: number;
  queueTotal: number;
  queueReady: number;
  queueDeferred: number;
  jobsFailed: number;
  dlqCount: number;
  recentErrors: number;
  failureRatePct: number;
  queueByType: Record<string, number>;
}
interface Revenue {
  totalAllTime: number;
  todayRevenue: number;
  monthRevenue: number;
  mrr: number;
  planBreakdown: Record<string, number>;
}
interface Users {
  totalBusinesses: number;
  activeSubs: number;
  trialSubs: number;
  cancelledThisMonth: number;
  newToday: number;
  newThisMonth: number;
  recentSignups: Array<{
    id: string;
    name: string;
    created_at: string;
    subscription_status: string;
  }>;
}
interface ApiHealth {
  successRate: number;
  avgLatencyMs: number;
  totalCalls: number;
  failureSpikes: Array<{ time: string; count: number }>;
}
interface MetricPoint {
  bucket_at: string;
  value: number;
}
interface DlqEntry {
  jobId: string;
  job: { type: string; createdAt: string; retryCount: number };
  failedAt: string;
  lastError: string;
  attempts: number;
}
interface LogEntry {
  id: string;
  source: string;
  message: string;
  level: string;
  context: Record<string, unknown>;
  occurred_at: string;
  request_id: string;
}
interface AlertEntry {
  id: string;
  severity: "info" | "warning" | "critical";
  type: string;
  title: string;
  body: string;
  aggregated_count: number;
  fired_at: string;
}
interface CircuitState {
  state: "CLOSED" | "OPEN" | "HALF_OPEN";
  failures: number;
}

// ── API ────────────────────────────────────────────────────────────────────────
async function api(path: string, token: string, opts?: RequestInit) {
  const r = await fetch(`/admin/api${path}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      "x-admin-token": token,
      ...(opts?.headers ?? {}),
    },
  });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}

// ── Format helpers ─────────────────────────────────────────────────────────────
const fmtNaira = (n: number) =>
  n >= 1_000_000
    ? `₦${(n / 1_000_000).toFixed(2)}M`
    : n >= 1000
      ? `₦${(n / 1000).toFixed(1)}K`
      : `₦${n.toLocaleString()}`;
const fmtNum = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1000
      ? `${(n / 1000).toFixed(1)}K`
      : n.toLocaleString();
const fmtTime = (s: string) =>
  new Date(s).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const fmtDate = (s: string) =>
  new Date(s).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

// Categorical chart colors — used for multi-series charts (plan breakdown) where
// each segment needs a distinct hue rather than a semantic meaning (good/bad/etc),
// so unlike the rest of the page these aren't Tailwind theme tokens.
const CHART_BLUE = "#3b82f6";
const CHART_VIOLET = "#8b5cf6";

// ── Sparkline ──────────────────────────────────────────────────────────────────
// Renders in `currentColor`, so the caller sets the color via a Tailwind
// text-color className on the wrapping element (e.g. "text-primary").
function Spark({ data, h = 40, w = 140 }: { data: MetricPoint[]; h?: number; w?: number }) {
  if (!data.length)
    return <span className="text-xs tracking-wide text-muted-foreground">No data</span>;
  const vals = data.map((d) => d.value);
  const max = Math.max(...vals, 1);
  const pts = vals
    .map((v, i) => `${(i / Math.max(vals.length - 1, 1)) * w},${h - (v / max) * (h - 6) - 3}`)
    .join(" ");
  const id = `spark${h}x${w}`;
  return (
    <svg width={w} height={h} style={{ display: "block", overflow: "visible" }}>
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.18" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <polyline points={pts + ` ${w},${h} 0,${h}`} fill={`url(#${id})`} stroke="none" />
      <polyline
        points={pts}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {vals.length > 0 &&
        (() => {
          const ly = h - (vals[vals.length - 1] / max) * (h - 6) - 3;
          return <circle cx={w} cy={ly} r="3" fill="currentColor" />;
        })()}
    </svg>
  );
}

// ── Donut chart ────────────────────────────────────────────────────────────────
function Donut({
  segments,
  size = 80,
}: {
  segments: Array<{ value: number; color: string; label: string }>;
  size?: number;
}) {
  const total = segments.reduce((s, x) => s + x.value, 0);
  if (total === 0)
    return (
      <div
        className="flex items-center justify-center rounded-full border-2 border-border text-xs text-muted-foreground"
        style={{ width: size, height: size }}
      >
        —
      </div>
    );
  const r = size / 2 - 8;
  const cx = size / 2;
  const cy = size / 2;
  let angle = -Math.PI / 2;
  const paths = segments
    .filter((s) => s.value > 0)
    .map((seg) => {
      const start = angle;
      const sweep = (seg.value / total) * 2 * Math.PI;
      angle += sweep;
      const x1 = cx + r * Math.cos(start);
      const y1 = cy + r * Math.sin(start);
      const x2 = cx + r * Math.cos(angle);
      const y2 = cy + r * Math.sin(angle);
      const large = sweep > Math.PI ? 1 : 0;
      return (
        <path
          key={seg.label}
          d={`M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`}
          fill={seg.color}
          opacity="0.9"
        />
      );
    });
  return (
    <svg width={size} height={size}>
      <circle cx={cx} cy={cy} r={r} style={{ fill: "var(--color-card)" }} />
      {paths}
      <circle cx={cx} cy={cy} r={r * 0.6} style={{ fill: "var(--color-card)" }} />
    </svg>
  );
}

// ── AdminPage ──────────────────────────────────────────────────────────────────
export default function AdminPage() {
  const [token, setToken] = useState<string | null>(() =>
    typeof window !== "undefined" ? sessionStorage.getItem("wb_tok") : null
  );
  const [theme, setTheme] = useState<"dark" | "light">(() =>
    typeof window !== "undefined" && localStorage.getItem("wb_admin_theme") === "dark"
      ? "dark"
      : "light",
  );
  const toggleTheme = () => {
    const next = theme === "light" ? "dark" : "light";
    setTheme(next);
    localStorage.setItem("wb_admin_theme", next);
  };
  type Tab = "overview" | "revenue" | "users" | "queue" | "alerts" | "logs" | "health" | "trace";
  const [tab, setTab] = useState<Tab>("overview");
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const [data, setData] = useState<{
    overview: Overview;
    revenue: Revenue;
    users: Users;
    apiHealth: { twilio: ApiHealth; paystack: ApiHealth };
    series: { jobsCreated: MetricPoint[]; jobsFailed: MetricPoint[] };
    circuits?: Record<string, CircuitState>;
  } | null>(null);
  const [queue, setQueue] = useState<{ dlqJobs: DlqEntry[]; stuckWebhooks: unknown[] } | null>(
    null,
  );
  const [alertHistory, setAlertHistory] = useState<AlertEntry[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [health, setHealth] = useState<{
    twilio: ApiHealth;
    paystack: ApiHealth;
    anthropic: ApiHealth;
    recentCalls: unknown[];
  } | null>(null);
  const [logFilter, setLogFilter] = useState({ level: "", source: "" });
  const [traceId, setTraceId] = useState("");
  const [traceResult, setTraceResult] = useState<null | {
    traceId: string;
    logs: unknown[];
    events: unknown[];
    dlqJobs: unknown[];
    webhooks: unknown[];
  }>(null);
  const [traceBusy, setTraceBusy] = useState(false);
  const [actionMsg, setActionMsg] = useState("");
  const [grantBusy, setGrantBusy] = useState<string | null>(null); // businessId being granted
  const [expandedLog, setExpandedLog] = useState<string | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  const refresh = useCallback(async () => {
    if (!token) return;
    try {
      if (tab === "overview" || tab === "revenue" || tab === "users") {
        const d = await api("/metrics", token);
        setData(d);
      } else if (tab === "queue") {
        const d = await api("/queue", token);
        setQueue(d);
      } else if (tab === "alerts") {
        const d = await api("/alerts", token);
        setAlertHistory(Array.isArray(d) ? d : []);
      } else if (tab === "logs") {
        const p = new URLSearchParams();
        if (logFilter.level) p.set("level", logFilter.level);
        if (logFilter.source) p.set("source", logFilter.source);
        setLogs((await api(`/logs?${p}`, token)) ?? []);
      } else if (tab === "health") {
        const d = await api("/api-health", token);
        setHealth(d);
      }
    } catch (e) {
      if (String(e).includes("401")) {
        sessionStorage.removeItem("wb_tok");
        setToken(null);
      }
    }
  }, [token, tab, logFilter]);

  useEffect(() => {
    if (!token) return;
    refresh();
    tickRef.current = setInterval(refresh, 9_000);
    return () => clearInterval(tickRef.current);
  }, [refresh, token]);

  async function dlqAction(jobId: string, action: "retry" | "ack") {
    try {
      await api(`/dlq/${jobId}/${action}`, token!, { method: "POST" });
      setActionMsg(`✓ ${action === "retry" ? "Requeued" : "Acknowledged"}`);
      void refresh();
    } catch (e) {
      setActionMsg(`✗ ${String(e)}`);
    }
    setTimeout(() => setActionMsg(""), 4000);
  }

  async function grantFree(businessId: string, businessName: string) {
    if (!token) return;
    const plan = window.prompt(`Grant free plan to "${businessName}"\nEnter plan: starter / growth / pro`, "pro");
    if (!plan || !["starter", "growth", "pro"].includes(plan)) return;
    setGrantBusy(businessId);
    try {
      await api(`/businesses/${businessId}/grant-free`, token, {
        method: "POST",
        body: JSON.stringify({ planId: plan }),
      });
      setActionMsg(`✓ Free ${plan} plan granted to ${businessName}`);
      void refresh();
    } catch (e) {
      setActionMsg(`✗ ${String(e)}`);
    } finally {
      setGrantBusy(null);
      setTimeout(() => setActionMsg(""), 5000);
    }
  }

  async function doTrace() {
    if (!traceId.trim() || !token) return;
    setTraceBusy(true);
    setTraceResult(null);
    try {
      setTraceResult(await api(`/trace/${encodeURIComponent(traceId.trim())}`, token));
    } catch {
      /* noop */
    } finally {
      setTraceBusy(false);
    }
  }

  // ── NO SESSION ──────────────────────────────────────────────────────────────
  // Admin login now happens on the main /auth page (same email+password form —
  // it tries the admin credentials first, then falls back to Supabase). This
  // page just gates on the token and bounces back to /auth if it's missing.
  if (!token) {
    if (typeof window !== "undefined") window.location.replace("/auth");
    return null;
  }

  const ov = data?.overview;
  const rev = data?.revenue;
  const usr = data?.users;

  const TABS: Array<{ id: Tab; label: string; icon: React.ElementType; badge?: number }> = [
    { id: "overview", label: "Overview", icon: LayoutDashboard },
    { id: "revenue", label: "Revenue", icon: Wallet },
    { id: "users", label: "Users", icon: UsersIcon },
    { id: "queue", label: "Queue", icon: ListOrdered, badge: ov?.dlqCount },
    {
      id: "alerts",
      label: "Alerts",
      icon: Bell,
      badge: alertHistory.filter((a) => a.severity === "critical").length || undefined,
    },
    { id: "logs", label: "Logs", icon: ScrollText },
    { id: "health", label: "Health", icon: HeartPulse },
    { id: "trace", label: "Trace", icon: Radar },
  ];

  // ── SHELL ───────────────────────────────────────────────────────────────────
  return (
    <div className={theme === "dark" ? "dark" : undefined}>
      <div className="min-h-screen bg-background text-sm text-foreground">
        {/* ── TOPBAR ── */}
        <nav className="sticky top-0 z-50 border-b border-border bg-surface/95 backdrop-blur supports-[backdrop-filter]:bg-surface/80">
          <div className="flex h-14 items-center gap-0.5 px-2.5 sm:gap-1 sm:px-6">
            {/* Mobile hamburger nav */}
            <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
              <SheetTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-9 w-9 flex-shrink-0 text-muted-foreground md:hidden"
                  aria-label="Open navigation menu"
                >
                  <Menu className="h-5 w-5" />
                </Button>
              </SheetTrigger>
              <SheetContent side="left" className="flex w-[280px] flex-col gap-0 p-0">
                <SheetHeader className="flex-shrink-0 space-y-0 border-b border-border px-5 py-4 text-left">
                  <div className="flex items-center gap-2.5">
                    <img
                      src="/wabizz-logo.png"
                      alt="Wabizz"
                      className="h-8 w-8 rounded-lg object-contain shadow-sm ring-1 ring-border"
                    />
                    <div className="min-w-0">
                      <SheetTitle className="text-sm font-semibold leading-tight tracking-tight text-foreground">
                        Wabizz
                      </SheetTitle>
                      <SheetDescription className="text-xs leading-tight text-muted-foreground">
                        Control plane
                      </SheetDescription>
                    </div>
                  </div>
                </SheetHeader>

                <nav className="flex-1 overflow-y-auto px-3 py-4">
                  <div className="mb-1.5 px-2.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Navigation
                  </div>
                  <div className="flex flex-col gap-0.5">
                    {TABS.map((t) => (
                      <button
                        key={t.id}
                        onClick={() => {
                          setTab(t.id);
                          setMobileNavOpen(false);
                        }}
                        className={cn(
                          "group relative flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
                          tab === t.id
                            ? "bg-primary/10 text-primary"
                            : "text-muted-foreground hover:bg-muted hover:text-foreground",
                        )}
                      >
                        {tab === t.id && (
                          <span className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-full bg-primary" />
                        )}
                        <t.icon
                          className={cn(
                            "h-4 w-4 flex-shrink-0 transition-colors",
                            tab === t.id ? "text-primary" : "text-muted-foreground group-hover:text-foreground",
                          )}
                        />
                        <span className="flex-1 text-left">{t.label}</span>
                        {!!t.badge && (
                          <Badge
                            variant="destructive"
                            className="h-4 min-w-4 justify-center rounded-full px-1 text-[10px] leading-none"
                          >
                            {t.badge}
                          </Badge>
                        )}
                      </button>
                    ))}
                  </div>
                </nav>

                <div className="flex-shrink-0 border-t border-border p-3">
                  <div className="mb-2 flex items-center justify-between rounded-lg bg-muted/50 px-3 py-2.5">
                    <div className="flex items-center gap-1.5">
                      <span className="relative flex h-2 w-2">
                        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
                        <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
                      </span>
                      <span className="text-xs font-medium text-foreground">Live</span>
                    </div>
                    <span className="text-xs text-muted-foreground">Updates every 9s</span>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full gap-1.5 text-xs text-muted-foreground"
                    onClick={() => {
                      sessionStorage.removeItem("wb_tok");
                      setToken(null);
                    }}
                  >
                    <LogOut className="h-3.5 w-3.5" />
                    Exit admin
                  </Button>
                </div>
              </SheetContent>
            </Sheet>

            <div className="mr-2 flex h-full flex-shrink-0 items-center gap-2 sm:mr-5 sm:gap-2.5 sm:border-r sm:border-border sm:pr-5">
              <img src="/wabizz-logo.png" alt="Wabizz" className="h-7 w-7 rounded-md object-contain" />
              <span className="hidden text-sm font-semibold tracking-tight text-foreground sm:inline">
                Wabizz
              </span>
              <span className="hidden text-xs text-muted-foreground sm:inline">admin</span>
            </div>

            {/* Desktop tabs */}
            <div className="hidden flex-1 items-center gap-1 overflow-x-auto md:flex">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  className={cn(
                    "relative flex h-14 items-center gap-1.5 whitespace-nowrap border-b-2 px-3.5 text-xs font-medium transition-colors",
                    tab === t.id
                      ? "border-primary text-primary"
                      : "border-transparent text-muted-foreground hover:text-foreground",
                  )}
                >
                  <t.icon className="h-3.5 w-3.5" />
                  {t.label}
                  {!!t.badge && (
                    <Badge
                      variant="destructive"
                      className="ml-0.5 h-4 min-w-4 justify-center rounded-full px-1 text-[10px] leading-none"
                    >
                      {t.badge}
                    </Badge>
                  )}
                </button>
              ))}
            </div>

            {/* Mobile: current tab label */}
            <div className="flex-1 truncate text-sm font-medium text-foreground/90 md:hidden">
              {TABS.find((t) => t.id === tab)?.label}
            </div>

            <div className="ml-auto flex flex-shrink-0 items-center gap-2 sm:gap-3">
              <div className="hidden items-center gap-1.5 sm:flex">
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
                </span>
                <span className="text-xs text-muted-foreground">Live</span>
              </div>
              {actionMsg && (
                <span
                  className={cn(
                    "hidden text-xs font-medium sm:inline",
                    actionMsg.startsWith("✓") ? "text-primary" : "text-destructive",
                  )}
                >
                  {actionMsg}
                </span>
              )}

              {/* Theme toggle */}
              <div className="flex items-center gap-1.5 sm:rounded-full sm:border sm:border-border sm:bg-background sm:px-2 sm:py-1">
                <Sun
                  className={cn(
                    "h-3.5 w-3.5 transition-colors",
                    theme === "light" ? "text-warning" : "text-muted-foreground/50",
                  )}
                />
                <Switch
                  checked={theme === "dark"}
                  onCheckedChange={toggleTheme}
                  aria-label="Toggle dark mode"
                />
                <Moon
                  className={cn(
                    "h-3.5 w-3.5 transition-colors",
                    theme === "dark" ? "text-primary" : "text-muted-foreground/50",
                  )}
                />
              </div>

              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-muted-foreground sm:hidden"
                aria-label="Exit"
                onClick={() => {
                  sessionStorage.removeItem("wb_tok");
                  setToken(null);
                }}
              >
                <LogOut className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="hidden h-8 gap-1.5 text-xs text-muted-foreground sm:flex"
                onClick={() => {
                  sessionStorage.removeItem("wb_tok");
                  setToken(null);
                }}
              >
                <LogOut className="h-3.5 w-3.5" />
                Exit
              </Button>
            </div>
          </div>
        </nav>

        {/* ── CONTENT ── */}
        <div className="mx-auto max-w-[1400px] px-3 py-5 sm:px-6 sm:py-7">
          {/* ════ OVERVIEW ════ */}
          {tab === "overview" && (
            <div>
              {ov && (ov.failureRatePct > 20 || ov.dlqCount > 10) && (
                <div className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3">
                  <AlertTriangle className="h-4 w-4 flex-shrink-0 text-destructive" />
                  <span className="font-semibold text-destructive">System degraded</span>
                  <span className="text-xs text-destructive">
                    Failure rate {ov.failureRatePct}% · DLQ {ov.dlqCount} jobs
                  </span>
                </div>
              )}

              <div className="mb-4 grid grid-cols-2 gap-3.5 lg:grid-cols-4">
                <HeroCard
                  label="Monthly recurring"
                  value={rev ? fmtNaira(rev.mrr) : "—"}
                  sub="active subscriptions"
                  color="text-primary"
                  icon={Wallet}
                  glow
                />
                <HeroCard
                  label="Total users"
                  value={usr ? fmtNum(usr.totalBusinesses) : "—"}
                  sub={usr ? `+${usr.newToday} today` : ""}
                  color="text-blue-500"
                  icon={Building2}
                />
                <HeroCard
                  label="Active now"
                  value={ov ? fmtNum(ov.activeUsers) : "—"}
                  sub="last 15 minutes"
                  color="text-violet-500"
                  icon={Zap}
                />
                <HeroCard
                  label="Messages sent"
                  value={ov ? fmtNum(ov.totalMessages) : "—"}
                  sub="all time"
                  color="text-warning"
                  icon={MessageCircle}
                />
              </div>

              <div className="mb-6 grid grid-cols-2 gap-3.5 lg:grid-cols-4">
                <StatCard label="Revenue today" value={rev ? fmtNaira(rev.todayRevenue) : "—"} color="text-primary" />
                <StatCard
                  label="Revenue this month"
                  value={rev ? fmtNaira(rev.monthRevenue) : "—"}
                  color="text-primary"
                />
                <StatCard
                  label="Paying users"
                  value={usr ? fmtNum(usr.activeSubs) : "—"}
                  color="text-blue-500"
                  sub={usr ? `${usr.trialSubs} on trial` : undefined}
                />
                <StatCard
                  label="Queue depth"
                  value={ov ? fmtNum(ov.queueTotal) : "—"}
                  color={ov && ov.queueTotal > 500 ? "text-destructive" : "text-warning"}
                />
              </div>

              <div className="mb-6 grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
                <ChartBox title="Jobs created (6h)">
                  <div className="text-primary">
                    <Spark data={data?.series.jobsCreated ?? []} h={56} w={260} />
                  </div>
                </ChartBox>
                <ChartBox title="Jobs failed (6h)">
                  <div className="text-destructive">
                    <Spark data={data?.series.jobsFailed ?? []} h={56} w={260} />
                  </div>
                </ChartBox>
                <ChartBox title="Plan breakdown">
                  {rev && (
                    <div className="flex items-center gap-4">
                      <Donut
                        size={72}
                        segments={[
                          { label: "Starter", value: rev.planBreakdown["starter"] ?? 0, color: CHART_BLUE },
                          { label: "Growth", value: rev.planBreakdown["growth"] ?? 0, color: "var(--color-primary)" },
                          { label: "Pro", value: rev.planBreakdown["pro"] ?? 0, color: CHART_VIOLET },
                        ]}
                      />
                      <div className="flex flex-col gap-1.5">
                        {[
                          ["Starter", CHART_BLUE],
                          ["Growth", "var(--color-primary)"],
                          ["Pro", CHART_VIOLET],
                        ].map(([plan, col]) => (
                          <div key={plan} className="flex items-center gap-1.5">
                            <div className="h-2 w-2 rounded-sm" style={{ background: col }} />
                            <span className="text-xs text-muted-foreground">{plan}</span>
                            <span className="ml-1 font-semibold text-foreground">
                              {rev.planBreakdown[(plan as string).toLowerCase()] ?? 0}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </ChartBox>
              </div>

              {data?.circuits && (
                <div className="mb-6">
                  <SectionLabel>Circuit breakers</SectionLabel>
                  <div className="flex flex-wrap gap-2.5">
                    {Object.entries(data.circuits).map(([svc, st]) => {
                      // Internal key/DB column is still "anthropic" (pre-dates the
                      // Groq migration) — display label only, history stays intact.
                      const label = svc === "anthropic" ? "groq" : svc;
                      return (
                        <Card
                          key={svc}
                          className={cn(
                            "flex min-w-[160px] flex-1 items-center gap-3 px-4 py-3",
                            st.state === "OPEN" && "border-destructive/40",
                            st.state === "HALF_OPEN" && "border-warning/40",
                          )}
                        >
                          <StatusDot
                            variant={st.state === "OPEN" ? "bad" : st.state === "HALF_OPEN" ? "warn" : "good"}
                            pulse={st.state === "OPEN"}
                          />
                          <div>
                            <div className="text-xs font-semibold uppercase tracking-wide text-foreground">
                              {label}
                            </div>
                            <div className="text-xs text-muted-foreground">
                              {st.state} · {st.failures} failures
                            </div>
                          </div>
                        </Card>
                      );
                    })}
                  </div>
                </div>
              )}

              <SectionLabel>External APIs (1h)</SectionLabel>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {(["twilio", "paystack"] as const).map((svc) => {
                  const h = data?.apiHealth[svc];
                  const ok = !h || h.successRate >= 95;
                  return (
                    <Card key={svc} className={cn("p-4", !ok && "border-destructive/30")}>
                      <div className="mb-3 flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <StatusDot variant={ok ? "good" : "bad"} pulse={!ok} />
                          <span className="text-xs font-semibold uppercase tracking-wide text-foreground">
                            {svc}
                          </span>
                        </div>
                        <span className={cn("text-xl font-bold", ok ? "text-primary" : "text-destructive")}>
                          {h ? `${h.successRate}%` : "—"}
                        </span>
                      </div>
                      <div className="flex gap-6">
                        <MiniStat label="Latency" value={h ? `${h.avgLatencyMs}ms` : "—"} alert={h && h.avgLatencyMs > 2000} />
                        <MiniStat label="Calls" value={h ? fmtNum(h.totalCalls) : "—"} />
                      </div>
                    </Card>
                  );
                })}
              </div>
            </div>
          )}

          {/* ════ REVENUE ════ */}
          {tab === "revenue" && (
            <div>
              <SectionLabel>Revenue overview</SectionLabel>
              <div className="mb-7 grid grid-cols-2 gap-3.5 lg:grid-cols-4">
                <HeroCard label="MRR" value={rev ? fmtNaira(rev.mrr) : "—"} sub="monthly recurring" color="text-primary" icon={TrendingUp} glow />
                <HeroCard label="All-time revenue" value={rev ? fmtNaira(rev.totalAllTime) : "—"} sub="from paid orders" color="text-blue-500" icon={Gem} />
                <HeroCard label="This month" value={rev ? fmtNaira(rev.monthRevenue) : "—"} sub="last 30 days" color="text-violet-500" icon={CalendarDays} />
                <HeroCard label="Today" value={rev ? fmtNaira(rev.todayRevenue) : "—"} sub="since midnight" color="text-warning" icon={Zap} />
              </div>

              <SectionLabel>Subscription breakdown</SectionLabel>
              <div className="mb-7 grid grid-cols-1 gap-3.5 lg:grid-cols-3">
                <Card className="flex items-center justify-center p-6 lg:col-span-1">
                  {rev && (
                    <Donut
                      size={130}
                      segments={[
                        { label: "Starter", value: rev.planBreakdown["starter"] ?? 0, color: CHART_BLUE },
                        { label: "Growth", value: rev.planBreakdown["growth"] ?? 0, color: "var(--color-primary)" },
                        { label: "Pro", value: rev.planBreakdown["pro"] ?? 0, color: CHART_VIOLET },
                      ]}
                    />
                  )}
                </Card>
                <Card className="p-6 lg:col-span-2">
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                    {[
                      { plan: "starter", label: "Starter", price: 5000, color: CHART_BLUE },
                      { plan: "growth", label: "Growth", price: 12000, color: "var(--color-primary)" },
                      { plan: "pro", label: "Pro", price: 25000, color: CHART_VIOLET },
                    ].map((p) => {
                      const count = rev?.planBreakdown[p.plan] ?? 0;
                      return (
                        <div key={p.plan} className="border-l-[3px] pl-3.5" style={{ borderColor: p.color }}>
                          <div className="mb-1.5 text-xs uppercase tracking-wide text-muted-foreground">{p.label}</div>
                          <div className="text-[28px] font-bold leading-none tracking-tight" style={{ color: p.color }}>
                            {count}
                          </div>
                          <div className="mt-1 text-xs text-muted-foreground">{fmtNaira(p.price)}/mo</div>
                          <div className="mt-1 text-xs font-semibold text-foreground">{fmtNaira(count * p.price)} MRR</div>
                        </div>
                      );
                    })}
                  </div>
                  <div className="mt-6 flex justify-between border-t border-border pt-4">
                    <span className="text-xs text-muted-foreground">Total MRR</span>
                    <span className="text-lg font-bold text-primary">{rev ? fmtNaira(rev.mrr) : "—"}</span>
                  </div>
                </Card>
              </div>

              <SectionLabel>Subscription health</SectionLabel>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <StatCard label="Paying" value={usr ? fmtNum(usr.activeSubs) : "—"} color="text-primary" />
                <StatCard label="On trial" value={usr ? fmtNum(usr.trialSubs) : "—"} color="text-warning" />
                <StatCard label="Churned (30d)" value={usr ? fmtNum(usr.cancelledThisMonth) : "—"} color="text-destructive" />
                <StatCard
                  label="Conv rate"
                  value={
                    usr && usr.activeSubs + usr.trialSubs > 0
                      ? `${Math.round((usr.activeSubs / (usr.activeSubs + usr.trialSubs)) * 100)}%`
                      : "—"
                  }
                  color="text-blue-500"
                />
              </div>
            </div>
          )}

          {/* ════ USERS ════ */}
          {tab === "users" && (
            <div>
              <SectionLabel>User overview</SectionLabel>
              <div className="mb-7 grid grid-cols-2 gap-3.5 lg:grid-cols-4">
                <HeroCard label="Total businesses" value={usr ? fmtNum(usr.totalBusinesses) : "—"} sub="all time" color="text-blue-500" icon={Building2} />
                <HeroCard
                  label="New today"
                  value={usr ? fmtNum(usr.newToday) : "—"}
                  sub="signups today"
                  color="text-primary"
                  icon={Sparkles}
                  glow={!!usr?.newToday}
                />
                <HeroCard label="New this month" value={usr ? fmtNum(usr.newThisMonth) : "—"} sub="last 30 days" color="text-violet-500" icon={CalendarDays} />
                <HeroCard label="Active now" value={ov ? fmtNum(ov.activeUsers) : "—"} sub="last 15 min" color="text-warning" icon={Zap} />
              </div>

              <div className="grid grid-cols-1 gap-3.5 lg:grid-cols-2">
                <Card className="p-6">
                  <div className="mb-4 text-xs uppercase tracking-wide text-muted-foreground">Account status</div>
                  {[
                    { label: "Active Subscriptions", value: usr?.activeSubs ?? 0, color: "text-primary" },
                    { label: "Free Trials", value: usr?.trialSubs ?? 0, color: "text-warning" },
                    { label: "Total Businesses", value: usr?.totalBusinesses ?? 0, color: "text-blue-500" },
                  ].map((row) => (
                    <div key={row.label} className="flex items-center justify-between border-b border-border py-3 last:border-0">
                      <span className="text-xs text-muted-foreground">{row.label}</span>
                      <span className={cn("text-base font-bold", row.color)}>{fmtNum(row.value)}</span>
                    </div>
                  ))}
                </Card>

                <Card className="p-6">
                  <div className="mb-4 text-xs uppercase tracking-wide text-muted-foreground">Recent signups</div>
                  {!usr?.recentSignups.length ? (
                    <Empty>No signups yet</Empty>
                  ) : (
                    usr.recentSignups.map((b) => (
                      <div key={b.id} className="flex items-center justify-between border-b border-border py-2.5 last:border-0">
                        <div className="flex items-center gap-2.5">
                          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-muted">
                            <Building2 className="h-3.5 w-3.5 text-muted-foreground" />
                          </div>
                          <div>
                            <div className="text-xs font-medium text-foreground">{b.name || "Unnamed"}</div>
                            <div className="text-xs text-muted-foreground">{fmtDate(b.created_at)}</div>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <SubBadge status={b.subscription_status} />
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-6 px-2 text-[10px]"
                            disabled={grantBusy === b.id}
                            onClick={() => grantFree(b.id, b.name || "Unnamed")}
                          >
                            {grantBusy === b.id ? "…" : "Grant free"}
                          </Button>
                        </div>
                      </div>
                    ))
                  )}
                </Card>
              </div>
            </div>
          )}

          {/* ════ QUEUE ════ */}
          {tab === "queue" && (
            <div>
              <div className="mb-5 flex items-center gap-3">
                <SectionLabel className="mb-0">Dead letter queue</SectionLabel>
                <CountBadge n={queue?.dlqJobs.length ?? 0} hot />
              </div>
              {!queue?.dlqJobs.length ? (
                <Empty icon={CheckCircle2}>No jobs in DLQ</Empty>
              ) : (
                <DataTable
                  cols={["Job ID", "Type", "Attempts", "Failed at", "Error", "Actions"]}
                  rows={(queue?.dlqJobs ?? []).map((j) => [
                    <Code key="id">{j.jobId.slice(0, 14)}…</Code>,
                    <Tag key="t" color="blue">{j.job.type}</Tag>,
                    <span key="a" className={j.attempts >= 5 ? "text-destructive" : "text-warning"}>
                      {j.attempts}/5
                    </span>,
                    <span key="f" className="text-xs text-muted-foreground">
                      {fmtDate(j.failedAt)} {fmtTime(j.failedAt)}
                    </span>,
                    <span
                      key="e"
                      className="block max-w-[240px] truncate text-destructive"
                      title={j.lastError}
                    >
                      {j.lastError.slice(0, 55)}
                    </span>,
                    <div key="ac" className="flex gap-1.5">
                      <Button size="sm" variant="outline" className="h-7 px-2 text-xs text-primary" onClick={() => dlqAction(j.jobId, "retry")}>
                        Retry
                      </Button>
                      <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => dlqAction(j.jobId, "ack")}>
                        Ack
                      </Button>
                    </div>,
                  ])}
                />
              )}

              <div className="mb-5 mt-8 flex items-center gap-3">
                <SectionLabel className="mb-0">Stuck webhooks</SectionLabel>
                <CountBadge n={queue?.stuckWebhooks.length ?? 0} />
              </div>
              {!queue?.stuckWebhooks.length ? (
                <Empty icon={CheckCircle2}>No stuck webhooks</Empty>
              ) : (
                <DataTable
                  cols={["Event ID", "Source", "Stuck since", "Error"]}
                  rows={(
                    queue?.stuckWebhooks as Array<{
                      event_id: string;
                      source: string;
                      received_at: string;
                      error_message: string;
                    }>
                  ).map((w) => [
                    <Code key="i">{w.event_id.slice(0, 16)}…</Code>,
                    <Tag key="s" color="blue">{w.source}</Tag>,
                    <span key="r" className="text-xs text-warning">
                      {fmtDate(w.received_at)} {fmtTime(w.received_at)}
                    </span>,
                    <span key="e" className="text-xs text-destructive">{w.error_message ?? "—"}</span>,
                  ])}
                />
              )}
            </div>
          )}

          {/* ════ ALERTS ════ */}
          {tab === "alerts" && (
            <div>
              <div className="mb-5 flex items-center gap-3">
                <SectionLabel className="mb-0">Alert history</SectionLabel>
                <Button size="sm" variant="outline" className="h-7 gap-1.5 text-xs text-primary" onClick={refresh}>
                  <RefreshCw className="h-3 w-3" />
                  Refresh
                </Button>
                <span className="ml-auto text-xs text-muted-foreground">
                  Aggregated · info 4h · warn 1h · crit 15m cooldown
                </span>
              </div>
              {!alertHistory.length ? (
                <Empty icon={CheckCircle2}>No alerts fired recently</Empty>
              ) : (
                <div className="flex flex-col gap-2">
                  {alertHistory.map((a) => (
                    <Card
                      key={a.id}
                      className={cn(
                        "border-l-[3px] p-4",
                        a.severity === "critical" && "border-l-destructive",
                        a.severity === "warning" && "border-l-warning",
                        a.severity === "info" && "border-l-blue-500",
                      )}
                    >
                      <div className="mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                        <SevBadge sev={a.severity} />
                        <span className="min-w-0 flex-1 font-semibold text-foreground">{a.title}</span>
                        {a.aggregated_count > 1 && (
                          <Badge variant="secondary" className="text-[10px]">
                            ×{a.aggregated_count}
                          </Badge>
                        )}
                        <span className="whitespace-nowrap text-xs text-muted-foreground">
                          {fmtDate(a.fired_at)} {fmtTime(a.fired_at)}
                        </span>
                      </div>
                      <div
                        className="text-xs text-muted-foreground sm:pl-[52px] [&_code]:rounded [&_code]:bg-muted [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono"
                        dangerouslySetInnerHTML={{ __html: a.body }}
                      />
                    </Card>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ════ LOGS ════ */}
          {tab === "logs" && (
            <div>
              <div className="mb-5 flex flex-wrap items-center gap-2.5">
                <SectionLabel className="mb-0">Error logs</SectionLabel>
                <select
                  value={logFilter.level}
                  onChange={(e) => setLogFilter((f) => ({ ...f, level: e.target.value }))}
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-xs shadow-sm outline-none focus-visible:ring-1 focus-visible:ring-ring sm:w-[130px]"
                >
                  <option value="">All levels</option>
                  <option value="warn">Warn</option>
                  <option value="error">Error</option>
                  <option value="fatal">Fatal</option>
                </select>
                <Input
                  placeholder="Filter source…"
                  value={logFilter.source}
                  onChange={(e) => setLogFilter((f) => ({ ...f, source: e.target.value }))}
                  className="h-9 w-full text-xs sm:w-[180px]"
                />
                <Button size="sm" variant="outline" className="h-9 gap-1.5 text-xs text-primary" onClick={refresh}>
                  <RefreshCw className="h-3 w-3" />
                  Refresh
                </Button>
              </div>
              {!logs.length ? (
                <Empty>No logs match filter</Empty>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {logs.map((log) => (
                    <Card
                      key={log.id}
                      onClick={() => setExpandedLog(expandedLog === log.id ? null : log.id)}
                      className={cn(
                        "cursor-pointer border-l-[3px] px-4 py-2.5",
                        log.level === "fatal" && "border-l-destructive",
                        log.level === "error" && "border-l-orange-500",
                        log.level === "warn" && "border-l-warning",
                      )}
                    >
                      <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
                        {expandedLog === log.id ? (
                          <ChevronDown className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                        )}
                        <LvlBadge lvl={log.level} />
                        <span className="min-w-[100px] text-xs font-medium text-blue-500 sm:min-w-[140px]">{log.source}</span>
                        <span className="min-w-0 flex-1 basis-full text-foreground sm:basis-auto">{log.message}</span>
                        <span className="ml-auto whitespace-nowrap text-xs text-muted-foreground">{fmtTime(log.occurred_at)}</span>
                      </div>
                      {expandedLog === log.id && log.context && Object.keys(log.context).length > 0 && (
                        <pre className="mt-2.5 max-h-[120px] overflow-auto rounded-md border border-border bg-muted p-2.5 font-mono text-xs text-foreground sm:ml-[104px]">
                          {JSON.stringify(log.context, null, 2)}
                        </pre>
                      )}
                    </Card>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ════ HEALTH ════ */}
          {tab === "health" && (
            <div>
              <SectionLabel>External API health (6h)</SectionLabel>
              <div className="mb-7 grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
                {(["twilio", "paystack", "anthropic"] as const).map((svc) => {
                  // Internal key/DB column is still "anthropic" (pre-dates the Groq
                  // migration) — display label only, so metrics history stays intact.
                  const label = svc === "anthropic" ? "groq" : svc;
                  const h = health?.[svc];
                  const ok = !h || h.successRate >= 95;
                  return (
                    <Card key={svc} className={cn("p-5", !ok && "border-destructive/40")}>
                      <div className="mb-3.5 flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <StatusDot variant={ok ? "good" : "bad"} pulse={!ok} />
                          <span className="text-xs font-semibold uppercase tracking-wide text-foreground">{label}</span>
                        </div>
                        <span className={cn("text-xl font-bold", ok ? "text-primary" : "text-destructive")}>
                          {h ? `${h.successRate}%` : "—"}
                        </span>
                      </div>
                      <div className="mb-3.5 flex gap-5">
                        <MiniStat label="Avg latency" value={h ? `${h.avgLatencyMs}ms` : "—"} alert={h && h.avgLatencyMs > 2000} />
                        <MiniStat label="Total calls" value={h ? fmtNum(h.totalCalls) : "—"} />
                      </div>
                      {h && h.failureSpikes.length > 0 && (
                        <div className="border-t border-border pt-2.5">
                          <div className="mb-1.5 text-xs text-destructive">Spikes</div>
                          {h.failureSpikes.slice(0, 3).map((s) => (
                            <div key={s.time} className="flex justify-between border-b border-border py-1 text-xs text-muted-foreground last:border-0">
                              <span>{fmtTime(s.time)}</span>
                              <span className="text-destructive">{s.count}×</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </Card>
                  );
                })}
              </div>
              <SectionLabel>Recent API calls</SectionLabel>
              {!health?.recentCalls.length ? (
                <Empty>No API calls recorded</Empty>
              ) : (
                <DataTable
                  cols={["Service", "Status", "Latency", "Code", "Time"]}
                  rows={(
                    health?.recentCalls as Array<{
                      service: string;
                      success: boolean;
                      latency_ms: number;
                      status_code: number;
                      occurred_at: string;
                    }>
                  )
                    .slice(0, 60)
                    .map((c) => [
                      <Tag key="s" color="blue">{c.service}</Tag>,
                      <span key="st" className={cn("font-semibold", c.success ? "text-primary" : "text-destructive")}>
                        {c.success ? "OK" : "Fail"}
                      </span>,
                      <span key="l" className={c.latency_ms > 2000 ? "text-destructive" : "text-muted-foreground"}>
                        {c.latency_ms ? `${c.latency_ms}ms` : "—"}
                      </span>,
                      <span key="c" className={c.status_code >= 400 ? "text-destructive" : "text-muted-foreground"}>
                        {c.status_code ?? "—"}
                      </span>,
                      <span key="t" className="text-xs text-muted-foreground">{fmtTime(c.occurred_at)}</span>,
                    ])}
                />
              )}
            </div>
          )}

          {/* ════ TRACE ════ */}
          {tab === "trace" && (
            <div>
              <SectionLabel>Request trace — end-to-end correlation</SectionLabel>
              <div className="mb-6 flex gap-2.5">
                <Input
                  placeholder="Paste traceId / requestId…"
                  value={traceId}
                  onChange={(e) => setTraceId(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && doTrace()}
                  className="flex-1"
                />
                <Button onClick={doTrace} disabled={traceBusy} className="gap-1.5">
                  <Radar className="h-4 w-4" />
                  {traceBusy ? "Searching…" : "Trace"}
                </Button>
              </div>
              {traceResult && (
                <div className="flex flex-col gap-5">
                  <div>
                    <SectionLabel>Events ({(traceResult.events as unknown[]).length})</SectionLabel>
                    {!(traceResult.events as unknown[]).length ? (
                      <Empty>No events</Empty>
                    ) : (
                      <DataTable
                        cols={["Type", "Severity", "Metadata", "Time"]}
                        rows={(
                          traceResult.events as Array<{
                            type: string;
                            severity: string;
                            metadata: Record<string, unknown>;
                            occurred_at: string;
                          }>
                        ).map((e) => [
                          <Tag key="t" color="blue">{e.type}</Tag>,
                          <SevBadge key="s" sev={e.severity as "info" | "warning" | "critical"} />,
                          <span key="m" className="text-xs text-muted-foreground">
                            {JSON.stringify(e.metadata).slice(0, 80)}
                          </span>,
                          <span key="ti" className="text-xs text-muted-foreground">{fmtTime(e.occurred_at)}</span>,
                        ])}
                      />
                    )}
                  </div>
                  <div>
                    <SectionLabel>Logs ({(traceResult.logs as unknown[]).length})</SectionLabel>
                    {!(traceResult.logs as unknown[]).length ? (
                      <Empty>No logs</Empty>
                    ) : (
                      <div className="flex flex-col gap-1.5">
                        {(
                          traceResult.logs as Array<{
                            id: string;
                            source: string;
                            message: string;
                            level: string;
                            occurred_at: string;
                          }>
                        ).map((l) => (
                          <Card
                            key={l.id}
                            className={cn(
                              "border-l-[3px] px-3.5 py-2.5",
                              l.level === "error" || l.level === "fatal" ? "border-l-destructive" : "border-l-warning",
                            )}
                          >
                            <div className="flex items-center gap-2.5">
                              <LvlBadge lvl={l.level} />
                              <span className="min-w-[130px] text-xs text-blue-500">{l.source}</span>
                              <span className="flex-1 text-foreground">{l.message}</span>
                              <span className="text-xs text-muted-foreground">{fmtTime(l.occurred_at)}</span>
                            </div>
                          </Card>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
              {!traceResult && !traceBusy && <Empty>Enter a traceId to see the full request timeline</Empty>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Micro components ───────────────────────────────────────────────────────────

function StatusDot({ variant, pulse }: { variant: "good" | "warn" | "bad"; pulse?: boolean }) {
  return (
    <span
      className={cn(
        "h-2 w-2 flex-shrink-0 rounded-full",
        variant === "good" && "bg-primary",
        variant === "warn" && "bg-warning",
        variant === "bad" && "bg-destructive",
        pulse && "animate-pulse",
      )}
    />
  );
}

function SectionLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <h3 className={cn("mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground", className)}>
      {children}
    </h3>
  );
}

function HeroCard({
  label,
  value,
  sub,
  color,
  icon: Icon,
  glow,
}: {
  label: string;
  value: string;
  sub?: string;
  color: string;
  icon: React.ElementType;
  glow?: boolean;
}) {
  return (
    <Card className={cn("p-5", glow && "border-primary/30 shadow-glow")}>
      <div className="mb-2.5 flex items-start justify-between">
        <span className="text-xs tracking-wide text-muted-foreground">{label}</span>
        <Icon className={cn("h-4 w-4", color)} />
      </div>
      <div className={cn("text-[28px] font-bold leading-none tracking-tight", color)}>{value}</div>
      {sub && <div className="mt-1.5 text-xs text-muted-foreground">{sub}</div>}
    </Card>
  );
}

function StatCard({
  label,
  value,
  color,
  sub,
}: {
  label: string;
  value: string;
  color: string;
  sub?: string;
}) {
  return (
    <Card className="p-4">
      <div className="mb-2 text-xs tracking-wide text-muted-foreground">{label}</div>
      <div className={cn("text-xl font-bold tracking-tight", color)}>{value}</div>
      {sub && <div className="mt-1 text-xs text-muted-foreground">{sub}</div>}
    </Card>
  );
}

function ChartBox({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card className="p-5">
      <div className="mb-3.5 text-xs tracking-wide text-muted-foreground">{title}</div>
      {children}
    </Card>
  );
}

function MiniStat({ label, value, alert: a }: { label: string; value: string; alert?: boolean }) {
  return (
    <div>
      <div className="text-[10px] tracking-wide text-muted-foreground">{label}</div>
      <div className={cn("mt-0.5 text-xs font-semibold", a ? "text-destructive" : "text-foreground")}>{value}</div>
    </div>
  );
}

function SubBadge({ status }: { status: string }) {
  const variant: Record<string, string> = {
    active: "text-primary border-primary/30 bg-primary/10",
    trialing: "text-warning border-warning/30 bg-warning/10",
    cancelled: "text-destructive border-destructive/30 bg-destructive/10",
    past_due: "text-destructive border-destructive/30 bg-destructive/10",
  };
  return (
    <span className={cn("rounded-md border px-2 py-0.5 text-[10px]", variant[status] ?? "text-muted-foreground border-border")}>
      {status}
    </span>
  );
}

function CountBadge({ n, hot }: { n: number; hot?: boolean }) {
  const cls = hot && n > 0 ? "text-destructive border-destructive/30 bg-destructive/10" : n > 0 ? "text-warning border-warning/30 bg-warning/10" : "text-primary border-primary/30 bg-primary/10";
  return <span className={cn("rounded-md border px-2.5 py-0.5 text-xs font-bold", cls)}>{n}</span>;
}

function Tag({ children, color }: { children: React.ReactNode; color: "blue" }) {
  return (
    <span
      className={cn(
        "inline-block rounded-md border px-2 py-0.5 text-[10px]",
        color === "blue" && "border-blue-500/30 bg-blue-500/10 text-blue-500",
      )}
    >
      {children}
    </span>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-violet-500">{children}</span>
  );
}

function SevBadge({ sev }: { sev: "info" | "warning" | "critical" }) {
  const m: Record<string, [React.ElementType, string]> = {
    info: [Info, "text-blue-500"],
    warning: [AlertTriangle, "text-warning"],
    critical: [XCircle, "text-destructive"],
  };
  const [Icon, color] = m[sev];
  return (
    <span className={cn("flex min-w-[76px] items-center gap-1 text-xs font-semibold", color)}>
      <Icon className="h-3 w-3" />
      {sev}
    </span>
  );
}

function LvlBadge({ lvl }: { lvl: string }) {
  const color = lvl === "fatal" ? "text-destructive" : lvl === "error" ? "text-orange-500" : "text-warning";
  return <span className={cn("min-w-[40px] text-[10px] font-bold uppercase tracking-wide", color)}>{lvl}</span>;
}

function Empty({ children, icon: Icon }: { children: React.ReactNode; icon?: React.ElementType }) {
  return (
    <div className="flex flex-col items-center gap-2 py-10 text-xs tracking-wide text-muted-foreground">
      {Icon && <Icon className="h-5 w-5" />}
      {children}
    </div>
  );
}

function DataTable({ cols, rows }: { cols: string[]; rows: React.ReactNode[][] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            {cols.map((c) => (
              <TableHead key={c} className="text-[10px] uppercase tracking-wide">
                {c}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, i) => (
            <TableRow key={i}>
              {row.map((cell, j) => (
                <TableCell key={j} className="align-middle">
                  {cell}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
