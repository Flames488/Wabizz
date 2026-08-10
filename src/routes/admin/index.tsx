/**
 * /admin — Wabizz Control Plane v3
 *
 * Log in via /auth (same email+password form as regular users — admin
 * credentials are checked first, then it falls back to Supabase).
 *
 * Tabs: OVERVIEW · REVENUE · USERS · QUEUE · ALERTS · LOGS · HEALTH · TRACE
 */

import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect, useCallback, useRef } from "react";

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

// ── Colours ────────────────────────────────────────────────────────────────────
// C's properties are mutated in place (never reassigned as a new object) when the
// theme toggles, so module-level consumers created once (Spark, btnS closures)
// keep reading live values. cardS/inp below bake values at call time via functions
// for the same reason — see toggleTheme() in AdminPage.
const DARK_THEME = {
  bg: "#060810",
  surface: "#0c1018",
  card: "#101520",
  border: "#1c2535",
  green: "#00e87a",
  greenDim: "#00b85e",
  greenGlow: "#00e87a22",
  red: "#ff3b52",
  yellow: "#f5c842",
  blue: "#4d9fff",
  purple: "#a78bfa",
  text: "#d4dae8",
  muted: "#4a5870",
  dim: "#1a2235",
};
const LIGHT_THEME = {
  bg: "#f7f8fa",
  surface: "#ffffff",
  card: "#ffffff",
  border: "#e2e5ea",
  green: "#16a34a",
  greenDim: "#15803d",
  greenGlow: "#16a34a22",
  red: "#dc2626",
  yellow: "#ca8a04",
  blue: "#2563eb",
  purple: "#7c3aed",
  text: "#1e2530",
  muted: "#6b7280",
  dim: "#e5e7eb",
};
const C = { ...DARK_THEME };

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

// ── Sparkline ──────────────────────────────────────────────────────────────────
function Spark({
  data,
  color = C.green,
  h = 40,
  w = 140,
}: {
  data: MetricPoint[];
  color?: string;
  h?: number;
  w?: number;
}) {
  if (!data.length) return <span style={{ color: C.muted, fontSize: 10 }}>NO DATA</span>;
  const vals = data.map((d) => d.value);
  const max = Math.max(...vals, 1);
  const pts = vals
    .map((v, i) => `${(i / Math.max(vals.length - 1, 1)) * w},${h - (v / max) * (h - 6) - 3}`)
    .join(" ");
  const id = `g${color.replace(/[^a-z0-9]/gi, "")}${h}`;
  return (
    <svg width={w} height={h} style={{ display: "block", overflow: "visible" }}>
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.2" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polyline points={pts + ` ${w},${h} 0,${h}`} fill={`url(#${id})`} stroke="none" />
      <polyline
        points={pts}
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {/* Last point dot */}
      {vals.length > 0 &&
        (() => {
          const lx = w;
          const ly = h - (vals[vals.length - 1] / max) * (h - 6) - 3;
          return <circle cx={lx} cy={ly} r="3" fill={color} />;
        })()}
    </svg>
  );
}

// ── DonutChart ─────────────────────────────────────────────────────────────────
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
        style={{
          width: size,
          height: size,
          borderRadius: "50%",
          border: `3px solid ${C.border}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <span style={{ color: C.muted, fontSize: 10 }}>—</span>
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
          opacity="0.85"
        />
      );
    });
  return (
    <svg width={size} height={size}>
      <circle cx={cx} cy={cy} r={r} fill={C.card} />
      {paths}
      <circle cx={cx} cy={cy} r={r * 0.6} fill={C.card} />
    </svg>
  );
}

// ── Shared styles ──────────────────────────────────────────────────────────────
// Functions (not plain objects) so they read C's current values at call time —
// a plain object would bake in whatever C held when the module first loaded.
const cardS = (): React.CSSProperties => ({
  background: C.card,
  border: `1px solid ${C.border}`,
  borderRadius: 10,
});
const inp = (): React.CSSProperties => ({
  background: C.surface,
  border: `1px solid ${C.border}`,
  borderRadius: 6,
  padding: "9px 13px",
  color: C.text,
  fontFamily: "inherit",
  fontSize: 12,
  outline: "none",
  width: "100%",
});
const btnS = (col: string): React.CSSProperties => ({
  background: "none",
  border: `1px solid ${col}44`,
  borderRadius: 6,
  padding: "6px 14px",
  color: col,
  cursor: "pointer",
  fontFamily: "inherit",
  fontSize: 11,
  letterSpacing: "0.8px",
  transition: "all 0.15s",
});

// ── AdminPage ──────────────────────────────────────────────────────────────────
export default function AdminPage() {
  const [token, setToken] = useState<string | null>(() =>
    typeof window !== "undefined" ? sessionStorage.getItem("wb_tok") : null
  );
  const [theme, setTheme] = useState<"dark" | "light">(() =>
    typeof window !== "undefined" && localStorage.getItem("wb_admin_theme") === "light"
      ? "light"
      : "dark",
  );
  // Mutate C's properties in place (not a reassignment) so every closure that
  // captured C at module load — Spark, Donut, cardS(), inp() — sees the new
  // palette without needing to be threaded through props.
  Object.assign(C, theme === "light" ? LIGHT_THEME : DARK_THEME);
  const toggleTheme = () => {
    const next = theme === "light" ? "dark" : "light";
    setTheme(next);
    localStorage.setItem("wb_admin_theme", next);
  };
  type Tab = "overview" | "revenue" | "users" | "queue" | "alerts" | "logs" | "health" | "trace";
  const [tab, setTab] = useState<Tab>("overview");

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
  const [pulse, setPulse] = useState(false);
  const tickRef = useRef<ReturnType<typeof setInterval>>();

  const refresh = useCallback(async () => {
    if (!token) return;
    setPulse(true);
    setTimeout(() => setPulse(false), 400);
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

  const TABS: Array<{ id: Tab; label: string; badge?: number }> = [
    { id: "overview", label: "OVERVIEW" },
    { id: "revenue", label: "REVENUE" },
    { id: "users", label: "USERS" },
    { id: "queue", label: "QUEUE", badge: ov?.dlqCount },
    {
      id: "alerts",
      label: "ALERTS",
      badge: alertHistory.filter((a) => a.severity === "critical").length || undefined,
    },
    { id: "logs", label: "LOGS" },
    { id: "health", label: "HEALTH" },
    { id: "trace", label: "TRACE" },
  ];

  // ── SHELL ───────────────────────────────────────────────────────────────────
  return (
    <div
      style={{
        minHeight: "100vh",
        background: C.bg,
        color: C.text,
        fontFamily: "'IBM Plex Mono','Courier New',monospace",
        fontSize: 12,
      }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&display=swap');
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 4px; height: 4px; }
        ::-webkit-scrollbar-thumb { background: ${C.dim}; border-radius: 2px; }
        input::placeholder, textarea::placeholder { color: ${C.muted}; }
        select option { background: ${C.surface}; }
        @keyframes fadeIn { from { opacity:0; transform:translateY(6px) } to { opacity:1; transform:none } }
        @keyframes pulseDot { 0%,100%{opacity:1}50%{opacity:0.3} }
      `}</style>

      {/* ── TOPBAR ── */}
      <nav
        style={{
          background: C.surface,
          borderBottom: `1px solid ${C.border}`,
          display: "flex",
          alignItems: "center",
          padding: "0 28px",
          height: 52,
          position: "sticky",
          top: 0,
          zIndex: 200,
          gap: 0,
        }}
      >
        {/* Logo */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            paddingRight: 28,
            borderRight: `1px solid ${C.border}`,
            marginRight: 20,
            height: "100%",
            flexShrink: 0,
          }}
        >
          <img
            src="/wabizz-logo.png"
            alt="Wabizz"
            style={{ width: 28, height: 28, borderRadius: 7, objectFit: "contain" }}
          />
          <span style={{ color: C.text, fontSize: 13, fontWeight: 700, letterSpacing: "-0.3px" }}>
            Wabizz
          </span>
          <span style={{ color: C.muted, fontSize: 10, marginLeft: 2 }}>admin</span>
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", overflowX: "auto", gap: 0 }}>
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              style={{
                background: "none",
                border: "none",
                padding: "0 18px",
                height: 52,
                color: tab === t.id ? C.green : C.muted,
                cursor: "pointer",
                fontFamily: "inherit",
                fontSize: 11,
                letterSpacing: "1px",
                borderBottom: `2px solid ${tab === t.id ? C.green : "transparent"}`,
                position: "relative",
                whiteSpace: "nowrap",
                transition: "color 0.15s",
              }}
            >
              {t.label}
              {t.badge ? (
                <span
                  style={{
                    position: "absolute",
                    top: 10,
                    right: 6,
                    background: C.red,
                    borderRadius: 10,
                    minWidth: 16,
                    height: 16,
                    fontSize: 9,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "#fff",
                    fontWeight: 700,
                    padding: "0 4px",
                  }}
                >
                  {t.badge}
                </span>
              ) : null}
            </button>
          ))}
        </div>

        {/* Right */}
        <div
          style={{
            marginLeft: "auto",
            display: "flex",
            alignItems: "center",
            gap: 16,
            flexShrink: 0,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <div
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: C.green,
                boxShadow: `0 0 8px ${C.green}`,
                animation: pulse ? "pulseDot 0.4s ease" : "none",
              }}
            />
            <span style={{ color: C.muted, fontSize: 10 }}>LIVE</span>
          </div>
          {actionMsg && (
            <span style={{ color: actionMsg.startsWith("✓") ? C.green : C.red, fontSize: 11 }}>
              {actionMsg}
            </span>
          )}
          <button
            onClick={toggleTheme}
            title={theme === "light" ? "Switch to dark background" : "Switch to white background"}
            style={{ ...btnS(C.muted), fontSize: 10 }}
          >
            {theme === "light" ? "🌙 DARK" : "☀️ WHITE"}
          </button>
          <button
            onClick={() => {
              sessionStorage.removeItem("wb_tok");
              setToken(null);
            }}
            style={{ ...btnS(C.muted), fontSize: 10 }}
          >
            EXIT
          </button>
        </div>
      </nav>

      {/* ── CONTENT ── */}
      <div style={{ padding: "28px 28px 60px", animation: "fadeIn 0.25s ease" }}>
        {/* ════ OVERVIEW ════ */}
        {tab === "overview" && (
          <div>
            {ov && (ov.failureRatePct > 20 || ov.dlqCount > 10) && (
              <div
                style={{
                  background: `${C.red}18`,
                  border: `1px solid ${C.red}33`,
                  borderRadius: 8,
                  padding: "12px 18px",
                  marginBottom: 24,
                  display: "flex",
                  gap: 12,
                  alignItems: "center",
                }}
              >
                <span style={{ color: C.red, fontSize: 16 }}>⚡</span>
                <span style={{ color: C.red, fontWeight: 700 }}>SYSTEM DEGRADED</span>
                <span style={{ color: C.red, fontSize: 11 }}>
                  Failure rate {ov.failureRatePct}% · DLQ {ov.dlqCount} jobs
                </span>
              </div>
            )}

            {/* Hero row — 4 big numbers */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(4,1fr)",
                gap: 14,
                marginBottom: 20,
              }}
            >
              <HeroCard
                label="MONTHLY RECURRING"
                value={rev ? fmtNaira(rev.mrr) : "—"}
                sub="active subscriptions"
                color={C.green}
                icon="💰"
                glow
              />
              <HeroCard
                label="TOTAL USERS"
                value={usr ? fmtNum(usr.totalBusinesses) : "—"}
                sub={usr ? `+${usr.newToday} today` : ""}
                color={C.blue}
                icon="🏢"
              />
              <HeroCard
                label="ACTIVE NOW"
                value={ov ? fmtNum(ov.activeUsers) : "—"}
                sub="last 15 minutes"
                color={C.purple}
                icon="⚡"
              />
              <HeroCard
                label="MESSAGES SENT"
                value={ov ? fmtNum(ov.totalMessages) : "—"}
                sub="all time"
                color={C.yellow}
                icon="💬"
              />
            </div>

            {/* Second row */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(4,1fr)",
                gap: 14,
                marginBottom: 24,
              }}
            >
              <StatCard
                label="REVENUE TODAY"
                value={rev ? fmtNaira(rev.todayRevenue) : "—"}
                color={C.green}
              />
              <StatCard
                label="REVENUE THIS MONTH"
                value={rev ? fmtNaira(rev.monthRevenue) : "—"}
                color={C.green}
              />
              <StatCard
                label="PAYING USERS"
                value={usr ? fmtNum(usr.activeSubs) : "—"}
                color={C.blue}
                sub={usr ? `${usr.trialSubs} on trial` : undefined}
              />
              <StatCard
                label="QUEUE DEPTH"
                value={ov ? fmtNum(ov.queueTotal) : "—"}
                color={ov && ov.queueTotal > 500 ? C.red : C.yellow}
                hot={ov && ov.queueTotal > 500}
              />
            </div>

            {/* Charts row */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr 1fr",
                gap: 14,
                marginBottom: 24,
              }}
            >
              <ChartBox title="JOBS CREATED (6H)" color={C.green}>
                <Spark data={data?.series.jobsCreated ?? []} color={C.green} h={56} w={260} />
              </ChartBox>
              <ChartBox title="JOBS FAILED (6H)" color={C.red}>
                <Spark data={data?.series.jobsFailed ?? []} color={C.red} h={56} w={260} />
              </ChartBox>
              <ChartBox title="PLAN BREAKDOWN" color={C.purple}>
                {rev && (
                  <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                    <Donut
                      size={72}
                      segments={[
                        {
                          label: "Starter",
                          value: rev.planBreakdown["starter"] ?? 0,
                          color: C.blue,
                        },
                        {
                          label: "Growth",
                          value: rev.planBreakdown["growth"] ?? 0,
                          color: C.green,
                        },
                        { label: "Pro", value: rev.planBreakdown["pro"] ?? 0, color: C.purple },
                      ]}
                    />
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {[
                        ["Starter", C.blue],
                        ["Growth", C.green],
                        ["Pro", C.purple],
                      ].map(([plan, col]) => (
                        <div key={plan} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <div
                            style={{
                              width: 8,
                              height: 8,
                              borderRadius: 2,
                              background: col as string,
                            }}
                          />
                          <span style={{ color: C.muted, fontSize: 10 }}>{plan}</span>
                          <span style={{ color: C.text, fontWeight: 600, marginLeft: 4 }}>
                            {rev.planBreakdown[(plan as string).toLowerCase()] ?? 0}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </ChartBox>
            </div>

            {/* Circuit breakers */}
            {data?.circuits && (
              <div style={{ marginBottom: 24 }}>
                <SectionLabel>CIRCUIT BREAKERS</SectionLabel>
                <div style={{ display: "flex", gap: 10 }}>
                  {Object.entries(data.circuits).map(([svc, st]) => (
                    <div
                      key={svc}
                      style={{
                        ...cardS(),
                        padding: "12px 20px",
                        display: "flex",
                        alignItems: "center",
                        gap: 12,
                        borderColor:
                          st.state === "OPEN"
                            ? `${C.red}44`
                            : st.state === "HALF_OPEN"
                              ? `${C.yellow}44`
                              : C.border,
                      }}
                    >
                      <Dot
                        color={
                          st.state === "OPEN"
                            ? C.red
                            : st.state === "HALF_OPEN"
                              ? C.yellow
                              : C.green
                        }
                        pulse={st.state === "OPEN"}
                      />
                      <div>
                        <div
                          style={{
                            color: C.text,
                            fontWeight: 600,
                            fontSize: 11,
                            letterSpacing: "1px",
                          }}
                        >
                          {svc.toUpperCase()}
                        </div>
                        <div style={{ color: C.muted, fontSize: 10 }}>
                          {st.state} · {st.failures} failures
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* API health */}
            <SectionLabel>EXTERNAL APIS (1H)</SectionLabel>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 12 }}>
              {(["twilio", "paystack"] as const).map((svc) => {
                const h = data?.apiHealth[svc];
                const ok = !h || h.successRate >= 95;
                return (
                  <div
                    key={svc}
                    style={{
                      ...cardS(),
                      padding: "16px 20px",
                      borderColor: ok ? C.border : `${C.red}33`,
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        marginBottom: 12,
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <Dot color={ok ? C.green : C.red} pulse={!ok} />
                        <span
                          style={{
                            color: C.text,
                            fontSize: 11,
                            fontWeight: 600,
                            letterSpacing: "1.5px",
                          }}
                        >
                          {svc.toUpperCase()}
                        </span>
                      </div>
                      <span style={{ color: ok ? C.green : C.red, fontSize: 22, fontWeight: 700 }}>
                        {h ? `${h.successRate}%` : "—"}
                      </span>
                    </div>
                    <div style={{ display: "flex", gap: 24 }}>
                      <MiniStat
                        label="LATENCY"
                        value={h ? `${h.avgLatencyMs}ms` : "—"}
                        alert={h && h.avgLatencyMs > 2000}
                      />
                      <MiniStat label="CALLS" value={h ? fmtNum(h.totalCalls) : "—"} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ════ REVENUE ════ */}
        {tab === "revenue" && (
          <div style={{ animation: "fadeIn 0.2s ease" }}>
            <SectionLabel>REVENUE OVERVIEW</SectionLabel>

            {/* Top revenue cards */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(4,1fr)",
                gap: 14,
                marginBottom: 28,
              }}
            >
              <HeroCard
                label="MRR"
                value={rev ? fmtNaira(rev.mrr) : "—"}
                sub="monthly recurring"
                color={C.green}
                icon="📈"
                glow
              />
              <HeroCard
                label="ALL-TIME REVENUE"
                value={rev ? fmtNaira(rev.totalAllTime) : "—"}
                sub="from paid orders"
                color={C.blue}
                icon="💎"
              />
              <HeroCard
                label="THIS MONTH"
                value={rev ? fmtNaira(rev.monthRevenue) : "—"}
                sub="last 30 days"
                color={C.purple}
                icon="📆"
              />
              <HeroCard
                label="TODAY"
                value={rev ? fmtNaira(rev.todayRevenue) : "—"}
                sub="since midnight"
                color={C.yellow}
                icon="⚡"
              />
            </div>

            {/* Plan breakdown + donut */}
            <SectionLabel>SUBSCRIPTION BREAKDOWN</SectionLabel>
            <div
              style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 14, marginBottom: 28 }}
            >
              <div
                style={{
                  ...cardS(),
                  padding: "24px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {rev && (
                  <Donut
                    size={130}
                    segments={[
                      { label: "Starter", value: rev.planBreakdown["starter"] ?? 0, color: C.blue },
                      { label: "Growth", value: rev.planBreakdown["growth"] ?? 0, color: C.green },
                      { label: "Pro", value: rev.planBreakdown["pro"] ?? 0, color: C.purple },
                    ]}
                  />
                )}
              </div>
              <div style={{ ...cardS(), padding: "24px" }}>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16 }}>
                  {[
                    { plan: "starter", label: "Starter", price: 5000, color: C.blue },
                    { plan: "growth", label: "Growth", price: 12000, color: C.green },
                    { plan: "pro", label: "Pro", price: 25000, color: C.purple },
                  ].map((p) => {
                    const count = rev?.planBreakdown[p.plan] ?? 0;
                    return (
                      <div
                        key={p.plan}
                        style={{ borderLeft: `3px solid ${p.color}`, paddingLeft: 14 }}
                      >
                        <div
                          style={{
                            color: C.muted,
                            fontSize: 10,
                            letterSpacing: "1px",
                            marginBottom: 6,
                          }}
                        >
                          {p.label.toUpperCase()}
                        </div>
                        <div
                          style={{
                            color: p.color,
                            fontSize: 28,
                            fontWeight: 700,
                            letterSpacing: "-1px",
                          }}
                        >
                          {count}
                        </div>
                        <div style={{ color: C.muted, fontSize: 10, marginTop: 4 }}>
                          {fmtNaira(p.price)}/mo
                        </div>
                        <div style={{ color: C.text, fontSize: 12, fontWeight: 600, marginTop: 4 }}>
                          {fmtNaira(count * p.price)} MRR
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div style={{ marginTop: 24, paddingTop: 18, borderTop: `1px solid ${C.border}` }}>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ color: C.muted, fontSize: 11 }}>TOTAL MRR</span>
                    <span style={{ color: C.green, fontSize: 18, fontWeight: 700 }}>
                      {rev ? fmtNaira(rev.mrr) : "—"}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {/* Subscription health */}
            <SectionLabel>SUBSCRIPTION HEALTH</SectionLabel>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12 }}>
              <StatCard label="PAYING" value={usr ? fmtNum(usr.activeSubs) : "—"} color={C.green} />
              <StatCard
                label="ON TRIAL"
                value={usr ? fmtNum(usr.trialSubs) : "—"}
                color={C.yellow}
              />
              <StatCard
                label="CHURNED (30D)"
                value={usr ? fmtNum(usr.cancelledThisMonth) : "—"}
                color={C.red}
              />
              <StatCard
                label="CONV RATE"
                value={
                  usr && usr.activeSubs + usr.trialSubs > 0
                    ? `${Math.round((usr.activeSubs / (usr.activeSubs + usr.trialSubs)) * 100)}%`
                    : "—"
                }
                color={C.blue}
              />
            </div>
          </div>
        )}

        {/* ════ USERS ════ */}
        {tab === "users" && (
          <div style={{ animation: "fadeIn 0.2s ease" }}>
            <SectionLabel>USER OVERVIEW</SectionLabel>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(4,1fr)",
                gap: 14,
                marginBottom: 28,
              }}
            >
              <HeroCard
                label="TOTAL BUSINESSES"
                value={usr ? fmtNum(usr.totalBusinesses) : "—"}
                sub="all time"
                color={C.blue}
                icon="🏢"
              />
              <HeroCard
                label="NEW TODAY"
                value={usr ? fmtNum(usr.newToday) : "—"}
                sub="signups today"
                color={C.green}
                icon="✨"
                glow={!!usr?.newToday}
              />
              <HeroCard
                label="NEW THIS MONTH"
                value={usr ? fmtNum(usr.newThisMonth) : "—"}
                sub="last 30 days"
                color={C.purple}
                icon="📆"
              />
              <HeroCard
                label="ACTIVE NOW"
                value={ov ? fmtNum(ov.activeUsers) : "—"}
                sub="last 15 min"
                color={C.yellow}
                icon="⚡"
              />
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
              {/* Growth stats */}
              <div style={{ ...cardS(), padding: "20px 24px" }}>
                <div
                  style={{ color: C.muted, fontSize: 10, letterSpacing: "1.5px", marginBottom: 18 }}
                >
                  ACCOUNT STATUS
                </div>
                {[
                  { label: "Active Subscriptions", value: usr?.activeSubs ?? 0, color: C.green },
                  { label: "Free Trials", value: usr?.trialSubs ?? 0, color: C.yellow },
                  { label: "Total Businesses", value: usr?.totalBusinesses ?? 0, color: C.blue },
                ].map((row) => (
                  <div
                    key={row.label}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      padding: "12px 0",
                      borderBottom: `1px solid ${C.border}`,
                    }}
                  >
                    <span style={{ color: C.muted, fontSize: 11 }}>{row.label}</span>
                    <span style={{ color: row.color, fontWeight: 700, fontSize: 16 }}>
                      {fmtNum(row.value)}
                    </span>
                  </div>
                ))}
              </div>

              {/* Recent signups */}
              <div style={{ ...cardS(), padding: "20px 24px" }}>
                <div
                  style={{ color: C.muted, fontSize: 10, letterSpacing: "1.5px", marginBottom: 18 }}
                >
                  RECENT SIGNUPS
                </div>
                {!usr?.recentSignups.length ? (
                  <Empty>No signups yet</Empty>
                ) : (
                  usr.recentSignups.map((b) => (
                    <div
                      key={b.id}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        padding: "10px 0",
                        borderBottom: `1px solid ${C.border}`,
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <div
                          style={{
                            width: 28,
                            height: 28,
                            borderRadius: 7,
                            background: C.dim,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontSize: 13,
                          }}
                        >
                          🏢
                        </div>
                        <div>
                          <div style={{ color: C.text, fontSize: 12, fontWeight: 500 }}>
                            {b.name || "Unnamed"}
                          </div>
                          <div style={{ color: C.muted, fontSize: 10 }}>
                            {fmtDate(b.created_at)}
                          </div>
                        </div>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <SubBadge status={b.subscription_status} />
                        <button
                          onClick={() => grantFree(b.id, b.name || "Unnamed")}
                          disabled={grantBusy === b.id}
                          style={{
                            background: "transparent",
                            border: `1px solid ${C.green}`,
                            color: C.green,
                            borderRadius: 4,
                            padding: "2px 8px",
                            fontSize: 10,
                            cursor: grantBusy === b.id ? "not-allowed" : "pointer",
                            opacity: grantBusy === b.id ? 0.5 : 1,
                            fontFamily: "inherit",
                            letterSpacing: "0.5px",
                          }}
                        >
                          {grantBusy === b.id ? "..." : "GRANT FREE"}
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}

        {/* ════ QUEUE ════ */}
        {tab === "queue" && (
          <div style={{ animation: "fadeIn 0.2s ease" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
              <SectionLabel style={{ marginBottom: 0 }}>DEAD LETTER QUEUE</SectionLabel>
              <CountBadge n={queue?.dlqJobs.length ?? 0} hot />
            </div>
            {!queue?.dlqJobs.length ? (
              <Empty>No jobs in DLQ ✓</Empty>
            ) : (
              <Grid
                cols={["JOB ID", "TYPE", "ATTEMPTS", "FAILED AT", "ERROR", "ACTIONS"]}
                rows={(queue?.dlqJobs ?? []).map((j) => [
                  <Code key="id">{j.jobId.slice(0, 14)}…</Code>,
                  <Tag key="t" color={C.blue}>
                    {j.job.type}
                  </Tag>,
                  <span key="a" style={{ color: j.attempts >= 5 ? C.red : C.yellow }}>
                    {j.attempts}/5
                  </span>,
                  <span key="f" style={{ color: C.muted, fontSize: 11 }}>
                    {fmtDate(j.failedAt)} {fmtTime(j.failedAt)}
                  </span>,
                  <span
                    key="e"
                    style={{
                      color: C.red,
                      maxWidth: 240,
                      display: "block",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    title={j.lastError}
                  >
                    {j.lastError.slice(0, 55)}
                  </span>,
                  <div key="ac" style={{ display: "flex", gap: 6 }}>
                    <button onClick={() => dlqAction(j.jobId, "retry")} style={btnS(C.green)}>
                      RETRY
                    </button>
                    <button onClick={() => dlqAction(j.jobId, "ack")} style={btnS(C.muted)}>
                      ACK
                    </button>
                  </div>,
                ])}
              />
            )}
            <div
              style={{
                marginTop: 32,
                display: "flex",
                alignItems: "center",
                gap: 12,
                marginBottom: 20,
              }}
            >
              <SectionLabel style={{ marginBottom: 0 }}>STUCK WEBHOOKS</SectionLabel>
              <CountBadge n={queue?.stuckWebhooks.length ?? 0} />
            </div>
            {!queue?.stuckWebhooks.length ? (
              <Empty>No stuck webhooks ✓</Empty>
            ) : (
              <Grid
                cols={["EVENT ID", "SOURCE", "STUCK SINCE", "ERROR"]}
                rows={(
                  queue?.stuckWebhooks as Array<{
                    event_id: string;
                    source: string;
                    received_at: string;
                    error_message: string;
                  }>
                ).map((w) => [
                  <Code key="i">{w.event_id.slice(0, 16)}…</Code>,
                  <Tag key="s" color={C.blue}>
                    {w.source}
                  </Tag>,
                  <span key="r" style={{ color: C.yellow, fontSize: 11 }}>
                    {fmtDate(w.received_at)} {fmtTime(w.received_at)}
                  </span>,
                  <span key="e" style={{ color: C.red, fontSize: 11 }}>
                    {w.error_message ?? "—"}
                  </span>,
                ])}
              />
            )}
          </div>
        )}

        {/* ════ ALERTS ════ */}
        {tab === "alerts" && (
          <div style={{ animation: "fadeIn 0.2s ease" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
              <SectionLabel style={{ marginBottom: 0 }}>ALERT HISTORY</SectionLabel>
              <button onClick={refresh} style={btnS(C.green)}>
                ↻ REFRESH
              </button>
              <span style={{ color: C.muted, fontSize: 10, marginLeft: "auto" }}>
                AGGREGATED · INFO 4H · WARN 1H · CRIT 15M COOLDOWN
              </span>
            </div>
            {!alertHistory.length ? (
              <Empty>No alerts fired recently ✓</Empty>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {alertHistory.map((a) => (
                  <div
                    key={a.id}
                    style={{
                      ...cardS(),
                      padding: "14px 18px",
                      borderLeft: `3px solid ${a.severity === "critical" ? C.red : a.severity === "warning" ? C.yellow : C.blue}`,
                    }}
                  >
                    <div
                      style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 6 }}
                    >
                      <SevBadge sev={a.severity} />
                      <span style={{ color: C.text, fontWeight: 600, flex: 1 }}>{a.title}</span>
                      {a.aggregated_count > 1 && (
                        <span
                          style={{
                            background: `${C.yellow}18`,
                            color: C.yellow,
                            border: `1px solid ${C.yellow}33`,
                            borderRadius: 4,
                            padding: "2px 8px",
                            fontSize: 10,
                          }}
                        >
                          ×{a.aggregated_count}
                        </span>
                      )}
                      <span style={{ color: C.muted, fontSize: 10, whiteSpace: "nowrap" }}>
                        {fmtDate(a.fired_at)} {fmtTime(a.fired_at)}
                      </span>
                    </div>
                    <div
                      style={{ color: C.muted, fontSize: 11, paddingLeft: 52 }}
                      dangerouslySetInnerHTML={{
                        __html: a.body
                          .replace(
                            /<code>/g,
                            "<span style='color:#a78bfa;background:#1a1230;padding:1px 6px;border-radius:3px'>",
                          )
                          .replace(/<\/code>/g, "</span>"),
                      }}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ════ LOGS ════ */}
        {tab === "logs" && (
          <div style={{ animation: "fadeIn 0.2s ease" }}>
            <div
              style={{
                display: "flex",
                gap: 10,
                alignItems: "center",
                marginBottom: 20,
                flexWrap: "wrap",
              }}
            >
              <SectionLabel style={{ marginBottom: 0 }}>ERROR LOGS</SectionLabel>
              <select
                value={logFilter.level}
                onChange={(e) => setLogFilter((f) => ({ ...f, level: e.target.value }))}
                style={{ ...inp(), width: 130 }}
              >
                <option value="">ALL LEVELS</option>
                <option value="warn">WARN</option>
                <option value="error">ERROR</option>
                <option value="fatal">FATAL</option>
              </select>
              <input
                placeholder="Filter source…"
                value={logFilter.source}
                onChange={(e) => setLogFilter((f) => ({ ...f, source: e.target.value }))}
                style={{ ...inp(), width: 180 }}
              />
              <button onClick={refresh} style={btnS(C.green)}>
                ↻ REFRESH
              </button>
            </div>
            {!logs.length ? (
              <Empty>No logs match filter</Empty>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {logs.map((log) => (
                  <div
                    key={log.id}
                    onClick={() => setExpandedLog(expandedLog === log.id ? null : log.id)}
                    style={{
                      ...cardS(),
                      padding: "11px 16px",
                      cursor: "pointer",
                      borderLeft: `3px solid ${log.level === "fatal" ? C.red : log.level === "error" ? "#f97316" : C.yellow}`,
                    }}
                  >
                    <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                      <LvlBadge lvl={log.level} />
                      <span style={{ color: C.blue, minWidth: 140, fontSize: 11, fontWeight: 500 }}>
                        {log.source}
                      </span>
                      <span style={{ color: C.text, flex: 1 }}>{log.message}</span>
                      <span style={{ color: C.muted, whiteSpace: "nowrap", fontSize: 10 }}>
                        {fmtTime(log.occurred_at)}
                      </span>
                    </div>
                    {expandedLog === log.id &&
                      log.context &&
                      Object.keys(log.context).length > 0 && (
                        <pre
                          style={{
                            marginTop: 10,
                            marginLeft: 104,
                            color: "#a78bfa",
                            fontSize: 11,
                            overflow: "auto",
                            maxHeight: 120,
                            background: "#0a0a14",
                            padding: 10,
                            borderRadius: 4,
                            border: `1px solid ${C.dim}`,
                          }}
                        >
                          {JSON.stringify(log.context, null, 2)}
                        </pre>
                      )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ════ HEALTH ════ */}
        {tab === "health" && (
          <div style={{ animation: "fadeIn 0.2s ease" }}>
            <SectionLabel>EXTERNAL API HEALTH (6H)</SectionLabel>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(3,1fr)",
                gap: 14,
                marginBottom: 28,
              }}
            >
              {(["twilio", "paystack", "anthropic"] as const).map((svc) => {
                const h = health?.[svc];
                const ok = !h || h.successRate >= 95;
                return (
                  <div
                    key={svc}
                    style={{
                      ...cardS(),
                      padding: "18px 22px",
                      borderColor: ok ? C.border : `${C.red}44`,
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        marginBottom: 14,
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <Dot color={ok ? C.green : C.red} pulse={!ok} />
                        <span
                          style={{
                            color: C.text,
                            fontSize: 11,
                            fontWeight: 600,
                            letterSpacing: "1.5px",
                          }}
                        >
                          {svc.toUpperCase()}
                        </span>
                      </div>
                      <span style={{ color: ok ? C.green : C.red, fontWeight: 700, fontSize: 22 }}>
                        {h ? `${h.successRate}%` : "—"}
                      </span>
                    </div>
                    <div
                      style={{
                        display: "flex",
                        gap: 20,
                        marginBottom: h?.failureSpikes.length ? 14 : 0,
                      }}
                    >
                      <MiniStat
                        label="AVG LATENCY"
                        value={h ? `${h.avgLatencyMs}ms` : "—"}
                        alert={h && h.avgLatencyMs > 2000}
                      />
                      <MiniStat label="TOTAL CALLS" value={h ? fmtNum(h.totalCalls) : "—"} />
                    </div>
                    {h && h.failureSpikes.length > 0 && (
                      <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 10 }}>
                        <div
                          style={{
                            color: C.red,
                            fontSize: 10,
                            letterSpacing: "1px",
                            marginBottom: 6,
                          }}
                        >
                          SPIKES
                        </div>
                        {h.failureSpikes.slice(0, 3).map((s) => (
                          <div
                            key={s.time}
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              color: C.muted,
                              fontSize: 11,
                              padding: "3px 0",
                              borderBottom: `1px solid ${C.dim}`,
                            }}
                          >
                            <span>{fmtTime(s.time)}</span>
                            <span style={{ color: C.red }}>{s.count}×</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <SectionLabel>RECENT API CALLS</SectionLabel>
            {!health?.recentCalls.length ? (
              <Empty>No API calls recorded</Empty>
            ) : (
              <Grid
                cols={["SERVICE", "STATUS", "LATENCY", "CODE", "TIME"]}
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
                    <Tag key="s" color={C.blue}>
                      {c.service}
                    </Tag>,
                    <span key="st" style={{ color: c.success ? C.green : C.red, fontWeight: 600 }}>
                      {c.success ? "OK" : "FAIL"}
                    </span>,
                    <span key="l" style={{ color: c.latency_ms > 2000 ? C.red : C.muted }}>
                      {c.latency_ms ? `${c.latency_ms}ms` : "—"}
                    </span>,
                    <span key="c" style={{ color: c.status_code >= 400 ? C.red : C.muted }}>
                      {c.status_code ?? "—"}
                    </span>,
                    <span key="t" style={{ color: C.muted, fontSize: 10 }}>
                      {fmtTime(c.occurred_at)}
                    </span>,
                  ])}
              />
            )}
          </div>
        )}

        {/* ════ TRACE ════ */}
        {tab === "trace" && (
          <div style={{ animation: "fadeIn 0.2s ease" }}>
            <SectionLabel>REQUEST TRACE — end-to-end correlation</SectionLabel>
            <div style={{ display: "flex", gap: 10, marginBottom: 24 }}>
              <input
                placeholder="Paste traceId / requestId…"
                value={traceId}
                onChange={(e) => setTraceId(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && doTrace()}
                style={{ ...inp(), flex: 1 }}
              />
              <button
                onClick={doTrace}
                disabled={traceBusy}
                style={{ ...btnS(C.green), padding: "8px 22px", letterSpacing: "1px" }}
              >
                {traceBusy ? "SEARCHING…" : "TRACE →"}
              </button>
            </div>
            {traceResult && (
              <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
                <div>
                  <SectionLabel>EVENTS ({(traceResult.events as unknown[]).length})</SectionLabel>
                  {!(traceResult.events as unknown[]).length ? (
                    <Empty>No events</Empty>
                  ) : (
                    <Grid
                      cols={["TYPE", "SEV", "METADATA", "TIME"]}
                      rows={(
                        traceResult.events as Array<{
                          type: string;
                          severity: string;
                          metadata: Record<string, unknown>;
                          occurred_at: string;
                        }>
                      ).map((e) => [
                        <Tag key="t" color={C.blue}>
                          {e.type}
                        </Tag>,
                        <SevBadge key="s" sev={e.severity as "info" | "warning" | "critical"} />,
                        <span key="m" style={{ color: C.muted, fontSize: 11 }}>
                          {JSON.stringify(e.metadata).slice(0, 80)}
                        </span>,
                        <span key="ti" style={{ color: C.muted, fontSize: 10 }}>
                          {fmtTime(e.occurred_at)}
                        </span>,
                      ])}
                    />
                  )}
                </div>
                <div>
                  <SectionLabel>LOGS ({(traceResult.logs as unknown[]).length})</SectionLabel>
                  {!(traceResult.logs as unknown[]).length ? (
                    <Empty>No logs</Empty>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                      {(
                        traceResult.logs as Array<{
                          id: string;
                          source: string;
                          message: string;
                          level: string;
                          occurred_at: string;
                        }>
                      ).map((l) => (
                        <div
                          key={l.id}
                          style={{
                            ...cardS(),
                            padding: "10px 14px",
                            borderLeft: `3px solid ${l.level === "error" || l.level === "fatal" ? C.red : C.yellow}`,
                          }}
                        >
                          <div style={{ display: "flex", gap: 10 }}>
                            <LvlBadge lvl={l.level} />
                            <span style={{ color: C.blue, fontSize: 11, minWidth: 130 }}>
                              {l.source}
                            </span>
                            <span style={{ color: C.text, flex: 1 }}>{l.message}</span>
                            <span style={{ color: C.muted, fontSize: 10 }}>
                              {fmtTime(l.occurred_at)}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
            {!traceResult && !traceBusy && (
              <Empty>Enter a traceId to see the full request timeline</Empty>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Micro components ───────────────────────────────────────────────────────────

function Dot({ color, pulse }: { color: string; pulse?: boolean }) {
  return (
    <div
      style={{
        width: 8,
        height: 8,
        borderRadius: "50%",
        background: color,
        boxShadow: `0 0 8px ${color}`,
        flexShrink: 0,
        animation: pulse ? "pulseDot 1.2s infinite" : undefined,
      }}
    />
  );
}

function SectionLabel({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <div
      style={{
        color: C.muted,
        fontSize: 10,
        letterSpacing: "2px",
        textTransform: "uppercase",
        marginBottom: 14,
        fontWeight: 600,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function HeroCard({
  label,
  value,
  sub,
  color,
  icon,
  glow,
}: {
  label: string;
  value: string;
  sub?: string;
  color: string;
  icon: string;
  glow?: boolean;
}) {
  return (
    <div
      style={{
        background: C.card,
        border: `1px solid ${glow ? `${color}33` : C.border}`,
        borderRadius: 10,
        padding: "20px 22px",
        position: "relative",
        overflow: "hidden",
      }}
    >
      {glow && (
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: 2,
            background: `linear-gradient(90deg,transparent,${color},transparent)`,
          }}
        />
      )}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          marginBottom: 10,
        }}
      >
        <span style={{ color: C.muted, fontSize: 10, letterSpacing: "1.5px" }}>{label}</span>
        <span style={{ fontSize: 18 }}>{icon}</span>
      </div>
      <div style={{ color, fontSize: 28, fontWeight: 700, letterSpacing: "-1.5px", lineHeight: 1 }}>
        {value}
      </div>
      {sub && <div style={{ color: C.muted, fontSize: 10, marginTop: 6 }}>{sub}</div>}
    </div>
  );
}

function StatCard({
  label,
  value,
  color,
  sub,
  hot,
}: {
  label: string;
  value: string;
  color: string;
  sub?: string;
  hot?: boolean | null;
}) {
  return (
    <div
      style={{
        background: C.card,
        border: `1px solid ${hot ? `${color}33` : C.border}`,
        borderRadius: 10,
        padding: "16px 18px",
      }}
    >
      <div style={{ color: C.muted, fontSize: 10, letterSpacing: "1.5px", marginBottom: 8 }}>
        {label}
      </div>
      <div style={{ color, fontSize: 22, fontWeight: 700, letterSpacing: "-0.5px" }}>{value}</div>
      {sub && <div style={{ color: C.muted, fontSize: 10, marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

function ChartBox({
  title,
  color,
  children,
}: {
  title: string;
  color: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ ...cardS(), padding: "18px 20px" }}>
      <div style={{ color: C.muted, fontSize: 10, letterSpacing: "1.5px", marginBottom: 14 }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function MiniStat({ label, value, alert: a }: { label: string; value: string; alert?: boolean }) {
  return (
    <div>
      <div style={{ color: C.muted, fontSize: 9, letterSpacing: "1px" }}>{label}</div>
      <div style={{ color: a ? C.red : C.text, fontWeight: 600, marginTop: 2, fontSize: 12 }}>
        {value}
      </div>
    </div>
  );
}

function SubBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    active: C.green,
    trialing: C.yellow,
    cancelled: C.red,
    past_due: C.red,
  };
  const c = map[status] ?? C.muted;
  return (
    <span
      style={{
        background: `${c}18`,
        color: c,
        border: `1px solid ${c}33`,
        borderRadius: 4,
        padding: "2px 9px",
        fontSize: 10,
        letterSpacing: "0.5px",
      }}
    >
      {status}
    </span>
  );
}

function CountBadge({ n, hot }: { n: number; hot?: boolean }) {
  const c = hot && n > 0 ? C.red : n > 0 ? C.yellow : C.green;
  return (
    <span
      style={{
        background: `${c}18`,
        color: c,
        border: `1px solid ${c}33`,
        borderRadius: 4,
        padding: "2px 10px",
        fontSize: 11,
        fontWeight: 700,
      }}
    >
      {n}
    </span>
  );
}

function Tag({ children, color }: { children: React.ReactNode; color: string }) {
  return (
    <span
      style={{
        background: `${color}15`,
        color,
        border: `1px solid ${color}33`,
        borderRadius: 4,
        padding: "2px 8px",
        fontSize: 10,
        letterSpacing: "0.3px",
        display: "inline-block",
      }}
    >
      {children}
    </span>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        fontFamily: "inherit",
        color: "#a78bfa",
        background: "#1a1230",
        padding: "2px 7px",
        borderRadius: 3,
        fontSize: 11,
      }}
    >
      {children}
    </span>
  );
}

function SevBadge({ sev }: { sev: "info" | "warning" | "critical" }) {
  const m: Record<string, [string, string]> = {
    info: ["ℹ", C.blue],
    warning: ["⚠", C.yellow],
    critical: ["✕", C.red],
  };
  const [icon, color] = m[sev];
  return (
    <span style={{ color, fontSize: 11, fontWeight: 700, minWidth: 52, letterSpacing: "0.5px" }}>
      {icon} {sev.toUpperCase()}
    </span>
  );
}

function LvlBadge({ lvl }: { lvl: string }) {
  const c = lvl === "fatal" ? C.red : lvl === "error" ? "#f97316" : C.yellow;
  return (
    <span style={{ color: c, fontSize: 10, fontWeight: 700, minWidth: 40, letterSpacing: "1px" }}>
      {lvl.toUpperCase()}
    </span>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        color: C.dim,
        padding: "36px 0",
        textAlign: "center",
        fontSize: 12,
        letterSpacing: "1px",
      }}
    >
      {children}
    </div>
  );
}

function Grid({ cols, rows }: { cols: string[]; rows: React.ReactNode[][] }) {
  return (
    <div style={{ overflowX: "auto", border: `1px solid ${C.border}`, borderRadius: 8 }}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ borderBottom: `1px solid ${C.border}` }}>
            {cols.map((c) => (
              <th
                key={c}
                style={{
                  color: C.muted,
                  fontSize: 9,
                  letterSpacing: "1.5px",
                  padding: "10px 14px",
                  textAlign: "left",
                  background: C.surface,
                  fontWeight: 600,
                }}
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr
              key={i}
              style={{
                borderBottom: `1px solid ${C.border}`,
                background: i % 2 === 0 ? C.card : C.surface,
              }}
            >
              {row.map((cell, j) => (
                <td key={j} style={{ padding: "11px 14px", verticalAlign: "middle" }}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
