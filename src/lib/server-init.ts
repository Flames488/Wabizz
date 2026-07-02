/**
 * server-init.ts — Server bootstrap module  (v2)
 *
 * Imported at the top of any server-side entry point (route handlers,
 * server functions) to ensure process-level setup runs exactly once
 * before any request is handled.
 *
 * What it does:
 *  1. Validates all required environment variables — refuses to start if any are missing.
 *  2. Registers SIGTERM / SIGINT graceful shutdown handlers.
 *  3. Catches uncaught exceptions and unhandled rejections.
 *  4. Warns about optional but recommended variables (Slack, cron secret, etc.).
 *  5. Logs startup info with runtime and version.
 *
 * Usage — add to the top of any server route module or server function file:
 *   import "@/lib/server-init";
 *
 * It is safe to import multiple times — registration is idempotent.
 *
 * For Cloudflare Workers deployments:
 *   Signal handling is a no-op in Workers (Workers have no process signals).
 *   Env var validation still runs, but process.exit() is unavailable —
 *   the Worker will throw and be restarted by the runtime.
 */

import { registerGracefulShutdown } from "@/lib/graceful-shutdown";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

// ── Required env vars — app refuses to start without these ───────────────────

const REQUIRED_ENV_VARS = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_PUBLISHABLE_KEY",
  "TWILIO_AUTH_TOKEN",
  // FIX BUG 4: TWILIO_ACCOUNT_SID, TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET are
  // all required by sendTwilioWhatsapp(). Without them, every outbound reply
  // is silently dropped. The server would start, accept messages, and fail to
  // reply to every customer — with no startup warning.
  "TWILIO_ACCOUNT_SID",
  "TWILIO_API_KEY_SID",
  "TWILIO_API_KEY_SECRET",
  "TWILIO_PHONE_NUMBER",
  "ANTHROPIC_API_KEY",
  "WABIZZ_PAYSTACK_SECRET_KEY",
  "WABIZZ_PAYSTACK_PUBLIC_KEY",
  "APP_URL",
] as const;

// ── Optional but strongly recommended ────────────────────────────────────────

const RECOMMENDED_ENV_VARS = [
  "SLACK_ALERT_WEBHOOK_URL",
  "CRON_SECRET",
  "HEALTH_CHECK_SECRET",
  // SCALE FIX: Upstash Redis is required for correct shared rate-limiting and cache
  // invalidation when running in Node/PM2 cluster mode (multiple workers per server).
  // Without it, each PM2 worker has its own isolated in-process state:
  //   - Rate limits multiply by worker count (500 req/min limit → 500 × nCPUs effective)
  //   - Cache invalidation in one worker is invisible to other workers
  // Cloudflare Workers deployments are immune (KV is inherently shared).
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
] as const;

// ── Idempotency guard ─────────────────────────────────────────────────────────

let _initialised = false;

function _init(): void {
  if (_initialised) return;
  _initialised = true;

  // ── 1. Validate required env vars ────────────────────────────────────────

  if (typeof process !== "undefined") {
    const missing = REQUIRED_ENV_VARS.filter((k) => !process.env[k]);

    if (missing.length > 0) {
      const msg = JSON.stringify({
        level: "fatal",
        source: "server-init",
        message: "Missing required environment variables — refusing to start",
        missing,
        timestamp: new Date().toISOString(),
      });
      console.error(msg);

      // In Node / Bun: hard exit so PM2/Docker restarts with a clear error.
      // In Cloudflare Workers (no process.exit): throw so the Worker is restarted.
      if (typeof process.exit === "function") {
        process.exit(1);
      } else {
        throw new Error(`Missing env vars: ${missing.join(", ")}`);
      }
    }

    if (
      (process.env.ADMIN_JWT_SECRET?.length ?? 0) > 0 &&
      process.env.ADMIN_JWT_SECRET!.length < 64
    ) {
      const msg = JSON.stringify({
        level: "fatal",
        source: "server-init",
        message: "ADMIN_JWT_SECRET must be at least 64 random characters",
        hint: "Generate with: openssl rand -hex 32",
        timestamp: new Date().toISOString(),
      });
      console.error(msg);
      if (typeof process.exit === "function") {
        process.exit(1);
      } else {
        throw new Error("ADMIN_JWT_SECRET must be at least 64 random characters");
      }
    }

    // ── 2. Warn about missing optional vars ─────────────────────────────────

    const missingOptional = RECOMMENDED_ENV_VARS.filter((k) => !process.env[k]);
    if (missingOptional.length > 0) {
      console.warn(
        JSON.stringify({
          level: "warn",
          source: "server-init",
          message: "Optional environment variables not set — some features will be degraded",
          missing: missingOptional,
          hint: {
            SLACK_ALERT_WEBHOOK_URL: "Fatal errors won't be Slacked to your team",
            CRON_SECRET: "Manual cron trigger is unprotected",
            HEALTH_CHECK_SECRET: "Deep health check is publicly accessible",
          },
          timestamp: new Date().toISOString(),
        }),
      );
    }

    // ── 3. Warn if KV/Queue bindings are missing (Workers only) ─────────────

    const kvBindings = [
      [
        "RATE_LIMIT_KV",
        "Rate limiting falls back to Durable Objects (fine if RATE_LIMIT_DO is bound)",
      ],
      ["CACHE_KV", "Caching is in-process only (not shared across Workers)"],
      [
        "WABIZZ_QUEUE",
        "Job queue is unavailable — jobs will execute synchronously (dev mode only)",
      ],
    ] as const;

    for (const [binding, warning] of kvBindings) {
      if (typeof (globalThis as Record<string, unknown>)[binding] === "undefined") {
        if (
          typeof Bun === "undefined" &&
          typeof (globalThis as Record<string, unknown>).process === "undefined"
        ) {
          console.warn(
            JSON.stringify({
              level: "warn",
              source: "server-init",
              message: `Binding ${binding} not found — ${warning}`,
              binding,
              timestamp: new Date().toISOString(),
            }),
          );
        }
      }
    }
  }

  // ── 3b. Warn loudly if running in PM2 cluster mode without Upstash Redis ──
  //
  // PM2 cluster mode forks N processes (one per CPU core). Each process has its
  // own in-process Map for rate-limiting and caching. Without Upstash Redis:
  //   • Rate limits are per-process — a 500 req/min cap becomes 500 × N_WORKERS
  //   • Cache invalidation is per-process — one worker cannot bust another's cache
  //
  // This only applies to Node / Bun / Docker deployments.
  // Cloudflare Workers use KV (shared by definition) — this check is skipped there.
  if (
    typeof process !== "undefined" &&
    typeof (globalThis as Record<string, unknown>).RATE_LIMIT_KV === "undefined"
  ) {
    const hasUpstash =
      !!process.env.UPSTASH_REDIS_REST_URL && !!process.env.UPSTASH_REDIS_REST_TOKEN;

    if (!hasUpstash) {
      console.warn(
        JSON.stringify({
          level: "warn",
          source: "server-init",
          message:
            "UPSTASH_REDIS_REST_URL is not set. Running without shared Redis. " +
            "In PM2 cluster mode this means rate limits and cache are per-process, not shared. " +
            "Set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN for correct multi-worker behaviour.",
          timestamp: new Date().toISOString(),
          action: "Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN environment variables.",
        }),
      );
    }
  }

  // ── 4. Register graceful shutdown (Node / Bun only) ──────────────────────

  if (typeof process !== "undefined" && typeof process.on === "function") {
    registerGracefulShutdown({
      timeoutMs: 10_000, // 10s drain window — matches Kubernetes default
    });
  }

  // ── 5. Startup log ───────────────────────────────────────────────────────

  if (typeof process !== "undefined") {
    const runtime = typeof Bun !== "undefined" ? `Bun ${Bun.version}` : `Node ${process.version}`;

    const startupPayload = {
      level: "info",
      source: "server-init",
      message: "Wabizz server initialised",
      timestamp: new Date().toISOString(),
      runtime,
      env: process.env.NODE_ENV ?? "unknown",
      version: "13",
    };

    console.log(JSON.stringify(startupPayload));

    // Persist boot record to startup_log table (migration 009).
    // Fire-and-forget — never block startup on a DB write.
    void supabaseAdmin
      .from("startup_log")
      .insert({
        version: "13",
        runtime,
        env: process.env.NODE_ENV ?? "unknown",
        started_at: new Date().toISOString(),
      })
      .then(({ error }) => {
        if (error) {
          console.warn(
            JSON.stringify({
              level: "warn",
              source: "server-init",
              message: "startup_log insert failed (non-fatal)",
              error: error.message,
              timestamp: new Date().toISOString(),
            }),
          );
        }
      });
  }
}

// Run on import
_init();

// Declare Bun global to prevent TS errors in Node-typed environments
declare const Bun: { version: string } | undefined;
