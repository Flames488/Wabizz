/**
 * event-pipeline.ts — Unified Event System (Section 1 of Mandate)
 *
 * Every significant action in Wabizz flows through emitEvent().
 * One call automatically triggers ALL of:
 *   1. Structured JSON logging (stdout → Cloudflare logs / Logflare)
 *   2. Supabase metrics increment (5-min bucket)
 *   3. Alert dispatch (via alert-engine.ts — severity-aware, deduplicated)
 *   4. Logflare structured ingest
 *
 * This eliminates silent failures. If it happened, it was logged, metered,
 * and — if serious enough — you were alerted. No exceptions.
 *
 * Every event carries a traceId for end-to-end correlation:
 *   request → enqueue → consumer → external API → response
 *   All share the same traceId. Debugging becomes: grep traceId.
 *
 * Event catalogue:
 *   JOB_ENQUEUED       job queued for processing
 *   JOB_PROCESSED      job completed successfully
 *   JOB_FAILED         job failed (one attempt)
 *   JOB_DLQ            job moved to dead-letter queue
 *   JOB_DUPLICATE      idempotency key already seen — skipped
 *   WEBHOOK_RECEIVED   inbound Twilio/Paystack webhook
 *   WEBHOOK_DUPLICATE  duplicate webhook blocked
 *   API_CALL_SUCCESS   external API call succeeded
 *   API_CALL_FAILED    external API call failed
 *   CIRCUIT_OPEN       circuit breaker tripped
 *   CIRCUIT_CLOSED     circuit breaker recovered
 *   RATE_LIMITED       request rate-limited
 *   ALERT_FIRED        alert dispatched
 *   SYSTEM_DEGRADED    auto-remediation triggered
 *
 * Usage:
 *   import { emitEvent } from "@/lib/server/event-pipeline";
 *
 *   emitEvent({
 *     type: "JOB_FAILED",
 *     severity: "critical",
 *     traceId: job.requestId,
 *     userId: job.payload.businessId,
 *     metadata: { jobId: job.id, jobType: job.type, error },
 *   });
 */

import { increment } from "@/lib/server/admin/metrics";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { alert } from "@/lib/server/alerts/alert-engine";
import type { AlertSeverity } from "@/lib/server/alerts/alert-engine";

// ── Event type catalogue ──────────────────────────────────────────────────────

export type EventType =
  | "JOB_ENQUEUED"
  | "JOB_PROCESSED"
  | "JOB_FAILED"
  | "JOB_DLQ"
  | "JOB_DUPLICATE"
  | "WEBHOOK_RECEIVED"
  | "WEBHOOK_DUPLICATE"
  | "WEBHOOK_STALL"
  | "API_CALL_SUCCESS"
  | "API_CALL_FAILED"
  | "CIRCUIT_OPEN"
  | "CIRCUIT_HALF_OPEN"
  | "CIRCUIT_CLOSED"
  | "RATE_LIMITED"
  | "ALERT_FIRED"
  | "SYSTEM_DEGRADED"
  | "QUEUE_BACKLOG"
  | "DLQ_GROWTH";

export interface SystemEvent {
  type: EventType;
  severity: AlertSeverity;
  /** Correlation ID — propagate from HTTP request through queue into consumer */
  traceId: string;
  /** Business/user ID for tenant-level tracing */
  userId?: string;
  /** Free-form metadata — job IDs, error messages, latencies etc. */
  metadata?: Record<string, unknown>;
}

// ── Metric name mapping ───────────────────────────────────────────────────────

const EVENT_TO_METRIC: Partial<Record<EventType, string>> = {
  JOB_ENQUEUED: "jobs_created",
  JOB_PROCESSED: "jobs_processed",
  JOB_FAILED: "jobs_failed",
  JOB_DLQ: "jobs_dlq",
  JOB_DUPLICATE: "jobs_deduplicated",
  WEBHOOK_RECEIVED: "webhook_received",
  WEBHOOK_DUPLICATE: "webhook_duplicate",
  API_CALL_SUCCESS: "api_calls_success",
  API_CALL_FAILED: "api_calls_failed",
  RATE_LIMITED: "rate_limited",
};

// ── Alert trigger rules ───────────────────────────────────────────────────────

interface AlertRule {
  title: (e: SystemEvent) => string;
  body: (e: SystemEvent) => string;
  autoRemediate?: boolean;
}

const ALERT_RULES: Partial<Record<EventType, AlertRule>> = {
  JOB_DLQ: {
    title: (e) => `Job moved to DLQ: ${String(e.metadata?.jobType ?? "unknown")}`,
    body: (e) =>
      `Job <code>${String(e.metadata?.jobId ?? "").slice(0, 12)}</code> exhausted all retries.\nError: <code>${String(e.metadata?.error ?? "").slice(0, 200)}</code>`,
    autoRemediate: true,
  },
  JOB_FAILED: {
    title: (e) =>
      `Job failed (attempt ${String(e.metadata?.attempt ?? "?")}): ${String(e.metadata?.jobType ?? "")}`,
    body: (e) => `Error: <code>${String(e.metadata?.error ?? "").slice(0, 300)}</code>`,
  },
  API_CALL_FAILED: {
    title: (e) => `${String(e.metadata?.service ?? "API")} call failed`,
    body: (e) =>
      `Status: ${String(e.metadata?.statusCode ?? "unknown")} — ${String(e.metadata?.error ?? "").slice(0, 200)}`,
  },
  CIRCUIT_OPEN: {
    title: (e) => `Circuit OPEN: ${String(e.metadata?.service ?? "unknown")}`,
    body: (e) =>
      `${String(e.metadata?.failures ?? 0)} failures triggered circuit breaker.\nRequests failing fast. Auto-recovery in 30s.`,
    autoRemediate: true,
  },
  WEBHOOK_STALL: {
    title: (e) => `${String(e.metadata?.count ?? 0)} webhook(s) stalled`,
    body: (e) => `Webhooks stuck in "processing" > 5 min. Auto-remediation running.`,
    autoRemediate: true,
  },
  QUEUE_BACKLOG: {
    title: (e) => `Queue backlog: ${String(e.metadata?.total ?? 0)} jobs`,
    body: (e) => `Queue depth exceeded threshold. ${String(e.metadata?.ready ?? 0)} ready.`,
    autoRemediate: true,
  },
  DLQ_GROWTH: {
    title: (e) => `DLQ growing: ${String(e.metadata?.current ?? 0)} pending`,
    body: (e) =>
      `DLQ grew from ${String(e.metadata?.previous ?? 0)} → ${String(e.metadata?.current ?? 0)} jobs.`,
    autoRemediate: true,
  },
  SYSTEM_DEGRADED: {
    title: (e) => `System degraded: ${String(e.metadata?.reason ?? "unknown")}`,
    body: (e) => `Auto-remediation triggered. Check admin dashboard.`,
    autoRemediate: true,
  },
};

// ── Logflare forwarder ────────────────────────────────────────────────────────

const _logflareBuffer: SystemEvent[] = [];
let _logflareTimer: ReturnType<typeof setTimeout> | null = null;

function _scheduleLogflareFlush(): void {
  if (_logflareTimer || _logflareBuffer.length === 0) return;
  _logflareTimer = setTimeout(() => {
    _logflareTimer = null;
    const url = _getLogflareUrl();
    if (!url) {
      _logflareBuffer.length = 0;
      return;
    }
    const batch = _logflareBuffer.splice(0, 100);
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        batch.map((e) => ({
          log_entry: e.type,
          metadata: { ...e.metadata, traceId: e.traceId, userId: e.userId, severity: e.severity },
          timestamp: new Date().toISOString(),
        })),
      ),
      signal: AbortSignal.timeout(5_000),
    }).catch(() => undefined);
  }, 1_500);
}

function _getLogflareUrl(): string | null {
  const key = typeof process !== "undefined" ? process.env.LOGFLARE_SOURCE_KEY : undefined;
  return key ? `https://api.logflare.app/logs?source=${key}` : null;
}

// ── Public: emitEvent ─────────────────────────────────────────────────────────

/**
 * Emit a system event through the unified pipeline.
 *
 * This is the ONLY way to record significant system activity.
 * All logging, metrics, and alerting flows through here.
 * Always fire-and-forget: void emitEvent({...})
 */
export function emitEvent(event: SystemEvent): void {
  // ── 1. Structured stdout (zero latency, captured by Cloudflare logs) ──────
  const logLevel =
    event.severity === "critical" ? "error" : event.severity === "warning" ? "warn" : "info";
  const logFn =
    logLevel === "error" ? console.error : logLevel === "warn" ? console.warn : console.log;
  logFn(
    JSON.stringify({
      event: event.type,
      severity: event.severity,
      traceId: event.traceId,
      userId: event.userId,
      timestamp: new Date().toISOString(),
      ...event.metadata,
    }),
  );

  // ── 2. Metrics increment (async, batched) ─────────────────────────────────
  const metricName = EVENT_TO_METRIC[event.type];
  if (metricName) {
    void increment(
      metricName as Parameters<typeof increment>[0],
      1,
      String(event.metadata?.jobType ?? event.metadata?.service ?? event.type),
    );
  }

  // ── 3. Logflare ingest (async, batched, fire-and-forget) ──────────────────
  _logflareBuffer.push(event);
  _scheduleLogflareFlush();

  // ── 4. Persist warning/critical events to system_events table ───────────
  if (event.severity !== "info") {
    // Fire-and-forget — never block the caller
    void supabaseAdmin
      .from("system_events")
      .insert({
        type: event.type,
        severity: event.severity,
        trace_id: event.traceId,
        user_id: event.userId ?? null,
        metadata: event.metadata ?? {},
        occurred_at: new Date().toISOString(),
      })
      .catch(() => undefined); // DB write failure never surfaces to caller
  }

  // ── 5. Alert dispatch (severity-gated, deduplicated) ─────────────────────
  const rule = ALERT_RULES[event.type];
  if (rule && (event.severity === "critical" || event.severity === "warning")) {
    void alert({
      severity: event.severity,
      type: _eventTypeToAlertType(event.type),
      title: rule.title(event),
      body: rule.body(event),
      context: { traceId: event.traceId, userId: event.userId, ...event.metadata },
      autoRemediate: rule.autoRemediate ?? false,
      dedupKey: `${event.type}:${event.metadata?.service ?? event.metadata?.jobType ?? ""}`,
    });
  }
}

function _eventTypeToAlertType(t: EventType) {
  const map: Partial<Record<EventType, import("@/lib/server/alerts/alert-engine").AlertType>> = {
    JOB_DLQ: "dlq_job",
    JOB_FAILED: "failure_rate",
    API_CALL_FAILED: "api_down",
    CIRCUIT_OPEN: "circuit_open",
    WEBHOOK_STALL: "webhook_stall",
    QUEUE_BACKLOG: "queue_backlog",
    DLQ_GROWTH: "dlq_growth",
    SYSTEM_DEGRADED: "failure_rate",
  };
  return map[t] ?? ("custom" as import("@/lib/server/alerts/alert-engine").AlertType);
}

// ── Convenience builders ──────────────────────────────────────────────────────

export const events = {
  jobEnqueued: (traceId: string, jobId: string, jobType: string, userId?: string) =>
    emitEvent({
      type: "JOB_ENQUEUED",
      severity: "info",
      traceId,
      userId,
      metadata: { jobId, jobType },
    }),

  jobProcessed: (traceId: string, jobId: string, jobType: string, latencyMs: number) =>
    emitEvent({
      type: "JOB_PROCESSED",
      severity: "info",
      traceId,
      metadata: { jobId, jobType, latencyMs },
    }),

  jobFailed: (traceId: string, jobId: string, jobType: string, attempt: number, error: string) =>
    emitEvent({
      type: "JOB_FAILED",
      severity: attempt >= 4 ? "critical" : "warning",
      traceId,
      metadata: { jobId, jobType, attempt, error },
    }),

  jobDlq: (traceId: string, jobId: string, jobType: string, error: string) =>
    emitEvent({
      type: "JOB_DLQ",
      severity: "critical",
      traceId,
      metadata: { jobId, jobType, error },
    }),

  jobDuplicate: (traceId: string, idempotencyKey: string, jobType: string) =>
    emitEvent({
      type: "JOB_DUPLICATE",
      severity: "info",
      traceId,
      metadata: { idempotencyKey, jobType },
    }),

  webhookReceived: (traceId: string, source: string) =>
    emitEvent({ type: "WEBHOOK_RECEIVED", severity: "info", traceId, metadata: { source } }),

  webhookDuplicate: (traceId: string, eventId: string, source: string) =>
    emitEvent({
      type: "WEBHOOK_DUPLICATE",
      severity: "info",
      traceId,
      metadata: { eventId, source },
    }),

  apiSuccess: (traceId: string, service: string, latencyMs: number) =>
    emitEvent({
      type: "API_CALL_SUCCESS",
      severity: "info",
      traceId,
      metadata: { service, latencyMs },
    }),

  apiFailed: (traceId: string, service: string, statusCode: number | undefined, error: string) =>
    emitEvent({
      type: "API_CALL_FAILED",
      severity: "warning",
      traceId,
      metadata: { service, statusCode, error },
    }),

  circuitOpen: (service: string, failures: number) =>
    emitEvent({
      type: "CIRCUIT_OPEN",
      severity: "critical",
      traceId: "circuit-breaker",
      metadata: { service, failures },
    }),

  circuitClosed: (service: string) =>
    emitEvent({
      type: "CIRCUIT_CLOSED",
      severity: "info",
      traceId: "circuit-breaker",
      metadata: { service },
    }),

  rateLimited: (traceId: string, key: string, ip: string) =>
    emitEvent({ type: "RATE_LIMITED", severity: "info", traceId, metadata: { key, ip } }),

  queueBacklog: (total: number, ready: number) =>
    emitEvent({
      type: "QUEUE_BACKLOG",
      severity: total > 1000 ? "critical" : "warning",
      traceId: "cron",
      metadata: { total, ready },
    }),

  dlqGrowth: (current: number, previous: number) =>
    emitEvent({
      type: "DLQ_GROWTH",
      severity: current > 20 ? "critical" : "warning",
      traceId: "cron",
      metadata: { current, previous, delta: current - previous },
    }),
};
