/**
 * request-timeout.ts — Request Timeout & Retry Logic
 *
 * Provides:
 *  1. withTimeout()       — wraps any async op with an AbortSignal deadline
 *  2. fetchWithRetry()    — fetch wrapper with exponential backoff + jitter
 *  3. withRequestTimeout() — wraps a full request handler with a timeout guard
 *
 * Why this matters:
 *  - Without timeouts, a hung external API call (Twilio, Paystack, Anthropic)
 *    ties up a Worker thread indefinitely.
 *  - Cloudflare Workers have a 30s CPU limit — unguarded fetches can exhaust it.
 *  - Retry logic with backoff prevents thundering herd on transient failures.
 *
 * Usage:
 *   // Simple timeout
 *   const result = await withTimeout(fetchSomething(), 5_000, "Paystack API");
 *
 *   // Fetch with retries
 *   const resp = await fetchWithRetry("https://api.paystack.co/...", options, {
 *     retries: 3,
 *     timeoutMs: 8_000,
 *   });
 *
 *   // Wrap an entire route handler
 *   GET: async ({ request }) =>
 *     withRequestTimeout(request, 25_000, () => handleGetRequest(request))
 */

import { logWarn } from "@/lib/server-logger";

// ── withTimeout ───────────────────────────────────────────────────────────────

export class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms}ms`);
    this.name = "TimeoutError";
  }
}

/**
 * Race a promise against a timeout.
 * Throws TimeoutError if the promise doesn't resolve within `ms` milliseconds.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label = "Operation"): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ── fetchWithRetry ────────────────────────────────────────────────────────────

export interface RetryOptions {
  /** Number of additional attempts after the first. Default: 2 */
  retries?: number;
  /** Per-attempt timeout in ms. Default: 10 000 */
  timeoutMs?: number;
  /** Base backoff ms (exponential: base * 2^attempt + jitter). Default: 500 */
  baseBackoffMs?: number;
  /** Only retry on these HTTP status codes. Default: [429, 500, 502, 503, 504] */
  retryStatuses?: number[];
  /** Optional label for logging */
  label?: string;
}

/**
 * Fetch wrapper with:
 *  - Per-attempt AbortSignal timeout
 *  - Exponential backoff with ±20% jitter
 *  - Configurable retry status codes
 *  - Warning log on each retry
 */
export async function fetchWithRetry(
  url: string,
  options: RequestInit = {},
  retryOpts: RetryOptions = {},
): Promise<Response> {
  const {
    retries = 2,
    timeoutMs = 10_000,
    baseBackoffMs = 500,
    retryStatuses = [429, 500, 502, 503, 504],
    label = url,
  } = retryOpts;

  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const resp = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timer);

      // If the response is not a retriable status, return it immediately
      // (success or a client error like 400/401 — don't retry those).
      if (!retryStatuses.includes(resp.status)) {
        return resp;
      }

      // Retriable status — set lastError and fall through to backoff/retry.
      lastError = new Error(`HTTP ${resp.status}`);
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
    }

    if (attempt < retries) {
      const jitter = Math.random() * 0.4 - 0.2; // ±20%
      const backoff = Math.round(baseBackoffMs * Math.pow(2, attempt) * (1 + jitter));
      await logWarn(
        "fetchWithRetry",
        `Attempt ${attempt + 1} failed for ${label}, retrying in ${backoff}ms`,
        {
          attempt,
          error: String(lastError),
        },
      );
      await _sleep(backoff);
    }
  }

  throw lastError;
}

// ── withRequestTimeout ────────────────────────────────────────────────────────

/**
 * Wrap a route handler with a hard request timeout.
 * Returns 503 if the handler doesn't respond in time.
 *
 * Use `timeoutMs` slightly below the platform limit
 * (e.g. 25 000 for Cloudflare Workers which has a 30s wall-clock cap).
 */
export async function withRequestTimeout(
  request: Request,
  timeoutMs: number,
  handler: () => Promise<Response>,
): Promise<Response> {
  try {
    return await withTimeout(
      handler(),
      timeoutMs,
      `${request.method} ${new URL(request.url).pathname}`,
    );
  } catch (err) {
    if (err instanceof TimeoutError) {
      // Use logWarn (non-fatal — timeout is recoverable, client gets 503 + Retry-After)
      // logWarn is synchronous-safe here; we don't await to avoid delaying the 503 response.
      void logWarn("request-timeout", err.message, {
        url: request.url,
        method: request.method,
      });
      return new Response(
        JSON.stringify({ ok: false, error: "Request timed out. Please try again." }),
        {
          status: 503,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": "5",
          },
        },
      );
    }
    throw err;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
