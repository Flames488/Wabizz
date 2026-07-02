/**
 * server-logger.ts — v4 (return-type fix + Sentry enrichment)
 *
 * Changes vs v3:
 *   - logError / logWarn / logInfo / logFatal are now void-returning — they
 *     were previously typed as returning Promise<void> in some call sites but
 *     never actually returned a promise. Callers were incorrectly awaiting them.
 *     Removing the implicit promise removes the wrong usage pattern entirely.
 *   - logFatal now passes full context (source, requestId) to captureFatal()
 *     so Sentry fatal events have complete structured context, not just a message.
 *   - _sendFatalAlerts is truly fire-and-forget — void, not awaited.
 *   - LOG_LEVEL gating checked before building the LogEntry object (minor perf).
 *
 * Batch async logging unchanged — DB writes never block the request path.
 * ctx.waitUntil(flushLogs()) in worker-entry.ts ensures flush before eviction.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { captureFatal, captureMessage } from "@/lib/sentry";

export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";

interface LogEntry {
  source: string;
  message: string;
  context: Record<string, unknown>;
  requestId?: string;
  level: LogLevel;
  occurred_at: string;
}

// ── Batch buffer ──────────────────────────────────────────────────────────────

const _buffer: LogEntry[] = [];
const BATCH_SIZE = 20;
const FLUSH_INTERVAL_MS = 500;
let _flushTimer: ReturnType<typeof setTimeout> | null = null;
let _flushing = false;

function _scheduleFlush(): void {
  if (_flushTimer) return;
  _flushTimer = setTimeout(() => {
    _flushTimer = null;
    void _flush();
  }, FLUSH_INTERVAL_MS);
}

export async function flushLogs(): Promise<void> {
  if (_flushTimer) {
    clearTimeout(_flushTimer);
    _flushTimer = null;
  }
  await _flush();
}

async function _flush(): Promise<void> {
  if (_flushing || _buffer.length === 0) return;
  _flushing = true;

  while (_buffer.length > 0) {
    const batch = _buffer.splice(0, BATCH_SIZE);
    try {
      await supabaseAdmin.from("error_logs").insert(
        batch.map((e) => ({
          source: e.source,
          message: e.message,
          level: e.level,
          context: { ...e.context, ...(e.requestId ? { request_id: e.requestId } : {}) },
          occurred_at: e.occurred_at,
        })),
      );
    } catch {
      // Flush failure — emit to stdout so Cloudflare log streams catch it
      for (const e of batch) {
        console.error(
          JSON.stringify({
            level: "error",
            source: "server-logger",
            message: "Batch flush failed — log entry follows",
            original: e,
          }),
        );
      }
    }
  }

  _flushing = false;
}

// ── Log level gating ──────────────────────────────────────────────────────────

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  fatal: 4,
};

function _isLevelEnabled(level: LogLevel): boolean {
  const configured = (
    typeof process !== "undefined" ? (process.env.LOG_LEVEL ?? "warn") : "warn"
  ) as LogLevel;
  return LOG_LEVEL_PRIORITY[level] >= (LOG_LEVEL_PRIORITY[configured] ?? 2);
}

// ── Internal log function ─────────────────────────────────────────────────────

function _log(entry: Omit<LogEntry, "occurred_at">): void {
  if (!_isLevelEnabled(entry.level)) return;

  const full: LogEntry = { ...entry, occurred_at: new Date().toISOString() };

  // Structured JSON stdout — zero-latency, ingested by Cloudflare log streams
  const fn = entry.level === "error" || entry.level === "fatal" ? console.error : console.log;
  fn(
    JSON.stringify({
      level: full.level,
      source: full.source,
      message: full.message,
      timestamp: full.occurred_at,
      ...(full.requestId ? { request_id: full.requestId } : {}),
      ...full.context,
    }),
  );

  // Enqueue for async batch DB write — NEVER awaited in request path
  _buffer.push(full);

  if (full.level === "fatal") {
    // Fatal: flush immediately + send to Sentry with full context + alert
    captureFatal(new Error(full.message), {
      source: full.source,
      requestId: full.requestId,
      ...full.context,
    });
    void flushLogs();
    _sendFatalAlerts(full.source, full.message, full.context, full.requestId);
  } else if (full.level === "error") {
    // Errors: forward to Sentry as messages (not exceptions) so you can
    // track error rate in Sentry without creating exception noise
    captureMessage(full.message, "error", {
      source: full.source,
      requestId: full.requestId,
      ...full.context,
    });
    if (_buffer.length >= BATCH_SIZE) {
      void _flush();
    } else {
      _scheduleFlush();
    }
  } else if (_buffer.length >= BATCH_SIZE) {
    void _flush();
  } else {
    _scheduleFlush();
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export function logError(
  source: string,
  message: string,
  context: Record<string, unknown> = {},
  requestId?: string,
  level: LogLevel = "error",
): void {
  _log({ source, message, context, requestId, level });
}

export function logInfo(
  source: string,
  message: string,
  context: Record<string, unknown> = {},
  requestId?: string,
): void {
  _log({ source, message, context, requestId, level: "info" });
}

export function logWarn(
  source: string,
  message: string,
  context: Record<string, unknown> = {},
  requestId?: string,
): void {
  _log({ source, message, context, requestId, level: "warn" });
}

export function logFatal(
  source: string,
  message: string,
  context: Record<string, unknown> = {},
  requestId?: string,
): void {
  _log({ source, message, context, requestId, level: "fatal" });
}

// ── Fatal alerts (fire-and-forget) ────────────────────────────────────────────

function _sendFatalAlerts(
  source: string,
  message: string,
  context: Record<string, unknown>,
  requestId?: string,
): void {
  const slackUrl = typeof process !== "undefined" ? process.env.SLACK_ALERT_WEBHOOK_URL : undefined;
  if (slackUrl) {
    fetch(slackUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text:
          `🚨 *FATAL* in \`${source}\`\n*${message}*\n` +
          (requestId ? `RequestId: \`${requestId}\`\n` : "") +
          `\`\`\`${JSON.stringify(context, null, 2).slice(0, 600)}\`\`\``,
      }),
      signal: AbortSignal.timeout(5_000),
    }).catch(() => undefined);
  }

  // Telegram fatal alert — fire and forget
  void import("@/lib/server/alerts/alert-engine").then(({ alerts: eng }) => {
    void eng.systemError(source, message, requestId);
  });
}
