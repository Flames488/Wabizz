/**
 * sentry.ts — Lightweight Sentry integration
 *
 * Works in both Cloudflare Workers (no native modules) and Node/PM2.
 * Uses the Sentry HTTP envelope API directly — no SDK bundle needed.
 *
 * Why not @sentry/cloudflare?
 *   The full SDK adds ~80KB to the Worker bundle and requires build-time
 *   plugin config. This file gives you 95% of the value (error capture,
 *   context, release tagging) at zero bundle cost.
 *
 * Setup:
 *   1. Create a project at https://sentry.io
 *   2. Set SENTRY_DSN in your env/secrets (see .env.example)
 *   3. Optionally set SENTRY_ENVIRONMENT (defaults to NODE_ENV)
 *   4. Optionally set SENTRY_RELEASE (e.g. your git SHA from CI)
 *
 * Usage:
 *   import { captureException, captureMessage } from "@/lib/sentry";
 *   captureException(err, { source: "twilio-webhook", requestId });
 *   captureMessage("Payment webhook failed", "warning", { orderId });
 */

export type SentryLevel = "fatal" | "error" | "warning" | "info" | "debug";

export interface SentryContext {
  source?: string;
  requestId?: string;
  userId?: string;
  businessId?: string;
  [key: string]: unknown;
}

// ── DSN parser ────────────────────────────────────────────────────────────────

interface ParsedDsn {
  endpoint: string;
  publicKey: string;
  projectId: string;
}

function _parseDsn(dsn: string): ParsedDsn | null {
  try {
    const url = new URL(dsn);
    const publicKey = url.username;
    const projectId = url.pathname.replace(/^\//, "");
    const endpoint = `${url.protocol}//${url.host}/api/${projectId}/envelope/`;
    return { endpoint, publicKey, projectId };
  } catch {
    return null;
  }
}

// ── Envelope builder ──────────────────────────────────────────────────────────

function _buildEnvelope(dsn: ParsedDsn, eventId: string, payload: Record<string, unknown>): string {
  const header = JSON.stringify({
    event_id: eventId,
    sent_at: new Date().toISOString(),
    dsn: `https://${dsn.publicKey}@sentry.io/${dsn.projectId}`,
  });
  const itemHeader = JSON.stringify({ type: "event", length: JSON.stringify(payload).length });
  return `${header}\n${itemHeader}\n${JSON.stringify(payload)}`;
}

// ── Core send ─────────────────────────────────────────────────────────────────

async function _send(
  level: SentryLevel,
  eventType: "exception" | "message",
  messageOrError: string | Error,
  context: SentryContext = {},
): Promise<void> {
  const dsn = _getDsn();
  if (!dsn) return; // Sentry not configured — silently skip

  const eventId = crypto.randomUUID().replace(/-/g, "");
  const release = _getEnv("SENTRY_RELEASE");
  const environment = _getEnv("SENTRY_ENVIRONMENT") ?? _getEnv("NODE_ENV") ?? "production";

  const { source, requestId, userId, businessId, ...extra } = context;

  const payload: Record<string, unknown> = {
    event_id: eventId,
    timestamp: new Date().toISOString(),
    platform: "javascript",
    level,
    release: release ?? undefined,
    environment,
    tags: {
      ...(source ? { source } : {}),
      runtime: typeof EdgeRuntime !== "undefined" ? "cloudflare-workers" : "node",
    },
    extra: {
      ...extra,
      ...(requestId ? { request_id: requestId } : {}),
    },
    user: userId ? { id: userId, ...(businessId ? { business_id: businessId } : {}) } : undefined,
    request: requestId ? { headers: { "X-Request-Id": requestId } } : undefined,
  };

  if (eventType === "exception" && messageOrError instanceof Error) {
    payload.exception = {
      values: [
        {
          type: messageOrError.name ?? "Error",
          value: messageOrError.message,
          stacktrace: messageOrError.stack
            ? {
                frames: _parseStack(messageOrError.stack),
              }
            : undefined,
        },
      ],
    };
  } else {
    payload.message = {
      formatted: messageOrError instanceof Error ? messageOrError.message : messageOrError,
    };
  }

  try {
    const envelope = _buildEnvelope(dsn, eventId, payload);
    await fetch(dsn.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-sentry-envelope",
        "X-Sentry-Auth": `Sentry sentry_version=7, sentry_key=${dsn.publicKey}, sentry_client=wabizz/1.0`,
      },
      body: envelope,
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    // Never let Sentry failures affect the request path
  }
}

// ── Stack frame parser ────────────────────────────────────────────────────────

function _parseStack(
  stack: string,
): Array<{ filename: string; function: string; lineno?: number; colno?: number }> {
  return stack
    .split("\n")
    .slice(1)
    .map((line) => {
      const m = line.trim().match(/^at\s+(?:(.+?)\s+\()?(.+?)(?::(\d+))?(?::(\d+))?\)?$/);
      if (!m) return { filename: line, function: "<unknown>" };
      return {
        function: m[1] ?? "<anonymous>",
        filename: m[2] ?? "<unknown>",
        lineno: m[3] ? parseInt(m[3], 10) : undefined,
        colno: m[4] ? parseInt(m[4], 10) : undefined,
      };
    })
    .filter((f) => f.filename && !f.filename.includes("node_modules"))
    .reverse(); // Sentry expects innermost frame last
}

// ── Env helpers ───────────────────────────────────────────────────────────────

let _cachedDsn: ParsedDsn | null | undefined = undefined;

function _getDsn(): ParsedDsn | null {
  if (_cachedDsn !== undefined) return _cachedDsn;
  const raw = _getEnv("SENTRY_DSN");
  _cachedDsn = raw ? _parseDsn(raw) : null;
  if (!_cachedDsn && raw) {
    console.warn(
      "[sentry] SENTRY_DSN is set but could not be parsed. Errors will not be reported.",
    );
  }
  return _cachedDsn;
}

function _getEnv(key: string): string | undefined {
  if (typeof process !== "undefined" && process.env) return process.env[key];
  return undefined;
}

declare const EdgeRuntime: unknown;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Report an exception to Sentry. Fire-and-forget — never throws.
 *
 * @param err     The Error object to report
 * @param context Optional structured context (source, requestId, userId, etc.)
 */
export function captureException(err: unknown, context: SentryContext = {}): void {
  const error = err instanceof Error ? err : new Error(String(err));
  void _send("error", "exception", error, context);
}

/**
 * Report a fatal exception. Same as captureException but marked fatal in Sentry.
 */
export function captureFatal(err: unknown, context: SentryContext = {}): void {
  const error = err instanceof Error ? err : new Error(String(err));
  void _send("fatal", "exception", error, context);
}

/**
 * Report a message (non-exception) event to Sentry.
 *
 * @param message Human-readable message
 * @param level   Sentry severity level (default: "error")
 * @param context Optional structured context
 */
export function captureMessage(
  message: string,
  level: SentryLevel = "error",
  context: SentryContext = {},
): void {
  void _send(level, "message", message, context);
}

/**
 * Returns true if Sentry is configured and will actually send events.
 * Useful in health checks.
 */
export function isSentryConfigured(): boolean {
  return _getDsn() !== null;
}
