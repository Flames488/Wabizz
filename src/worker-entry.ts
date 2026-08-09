/**
 * worker-entry.ts — Cloudflare Workers entry point
 *
 * Exports THREE handlers required by the Workers runtime:
 *
 *   fetch()     — HTTP requests (webhook, admin, health, etc.)
 *                 Delegated to TanStack Start's server entry
 *
 *   queue()     — Cloudflare Queue consumer (WABIZZ_QUEUE + WABIZZ_DLQ)
 *                 Processes background jobs: WhatsApp sends, Paystack links,
 *                 reminders, log events. Uses processQueueBatch() from consumer.ts
 *
 *   scheduled() — Cron trigger (every 30 min)
 *                 Runs reminders, monitoring alerts, metrics pruning
 *
 * This file is the ONLY place where ctx.waitUntil() is used for logging flush.
 * All critical business logic runs in queue() — never in waitUntil().
 *
 * Wrangler registers this via "main" in wrangler.jsonc:
 *   "main": "src/worker-entry.ts"
 */

// Import TanStack Start's fetch handler
import startFetchHandler from "@tanstack/react-start/server-entry";

// Queue consumer
import { processQueueBatch } from "@/lib/server/worker/consumer";
import type { Job } from "@/lib/queue";

// Scheduled handler (same as api.public.scheduled.ts exports)
import scheduledHandler from "@/routes/api.public.scheduled";

// Async log flush — used ONLY for non-critical background flushing
import { flushLogs } from "@/lib/server-logger";

// ── PLACEHOLDER SENTINEL ────────────────────────────────────────────────────
// Values that indicate a secret has never been set.
const PLACEHOLDER_PATTERNS = [
  "REPLACE_ME",
  "REPLACE_AT_",
  "REPLACE_WITH_",
  "your-",
  "YOUR_",
  "<your",
  "change-this",
];
function isPlaceholder(val: string): boolean {
  return PLACEHOLDER_PATTERNS.some((p) => val.toUpperCase().includes(p.toUpperCase()));
}

// ── REQUIRED ENVIRONMENT VARIABLES ──────────────────────────────────────────
// All variables that MUST be set before the worker can serve any traffic.
const REQUIRED_SECRETS: Array<{ key: string; hint: string }> = [
  { key: "SUPABASE_URL", hint: "https://[project-ref].supabase.co" },
  {
    key: "SUPABASE_SERVICE_ROLE_KEY",
    hint: "eyJ... (from Supabase Dashboard → Settings → API → service_role key)",
  },
  {
    key: "SUPABASE_PUBLISHABLE_KEY",
    hint: "eyJ... (from Supabase Dashboard → Settings → API → anon/public key)",
  },
  {
    key: "GROQ_API_KEY",
    hint: "gsk_... (from https://console.groq.com/keys)",
  },
  {
    key: "TWILIO_ACCOUNT_SID",
    hint: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx (from https://console.twilio.com)",
  },
  { key: "TWILIO_AUTH_TOKEN", hint: "your_twilio_auth_token (from https://console.twilio.com)" },
  { key: "TWILIO_API_KEY_SID", hint: "SKxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx (Twilio API key SID)" },
  { key: "TWILIO_API_KEY_SECRET", hint: "your Twilio API key secret" },
  {
    key: "TWILIO_PHONE_NUMBER",
    hint: "whatsapp:+14155238886 or your approved Twilio WhatsApp sender",
  },
  {
    key: "WABIZZ_PAYSTACK_SECRET_KEY",
    hint: "sk_live_... (from https://dashboard.paystack.com/#/settings/developers)",
  },
  {
    key: "WABIZZ_PAYSTACK_PUBLIC_KEY",
    hint: "pk_live_... (from https://dashboard.paystack.com/#/settings/developers)",
  },
  { key: "CRON_SECRET", hint: "openssl rand -base64 48" },
  { key: "ADMIN_JWT_SECRET", hint: "openssl rand -base64 48" },
];

// ── STARTUP VALIDATION ───────────────────────────────────────────────────────
// Runs once per worker isolate startup — not on every request.
// Returns null if all secrets are configured, or an error string listing problems.
function validateStartupSecrets(env: Record<string, string>): string | null {
  const missing: string[] = [];
  const placeholder: string[] = [];

  for (const { key, hint } of REQUIRED_SECRETS) {
    const val = env[key] ?? "";
    if (!val) {
      missing.push(`  • ${key}  →  wrangler secret put ${key}  (format: ${hint})`);
    } else if (isPlaceholder(val)) {
      placeholder.push(
        `  • ${key} = "${val.slice(0, 20)}..."  →  wrangler secret put ${key}  (format: ${hint})`,
      );
    }
  }

  // Supabase JS must receive the HTTPS REST project URL. Direct PostgreSQL
  // pooler URLs belong in SUPABASE_DB_URL for backup/migration tooling.
  const supabaseUrl = env["SUPABASE_URL"] ?? "";
  if (supabaseUrl && !isPlaceholder(supabaseUrl) && !supabaseUrl.startsWith("https://")) {
    placeholder.push(
      `  - SUPABASE_URL must be the HTTPS Supabase project URL.\n` +
        `    Current value starts with: "${supabaseUrl.slice(0, 40)}..."\n` +
        `    Required format: https://[project-ref].supabase.co\n` +
        `    Fix: wrangler secret put SUPABASE_URL`,
    );
  }

  const adminJwtSecret = env["ADMIN_JWT_SECRET"] ?? "";
  if (adminJwtSecret && !isPlaceholder(adminJwtSecret) && adminJwtSecret.length < 64) {
    placeholder.push(
      `  - ADMIN_JWT_SECRET must be at least 64 random characters.\n` +
        `    Generate one with: openssl rand -base64 48\n` +
        `    Fix: wrangler secret put ADMIN_JWT_SECRET`,
    );
  }

  if (missing.length === 0 && placeholder.length === 0) return null;

  const sections: string[] = ["[WABIZZ STARTUP BLOCKED] — Secrets not configured for production."];
  if (missing.length > 0) {
    sections.push(
      `\nMISSING (${missing.length} secret${missing.length > 1 ? "s" : ""} not set):\n` +
        missing.join("\n"),
    );
  }
  if (placeholder.length > 0) {
    sections.push(
      `\nPLACEHOLDER (${placeholder.length} secret${placeholder.length > 1 ? "s" : ""} still contain template values):\n` +
        placeholder.join("\n"),
    );
  }
  sections.push(
    "\nAll secrets must be set via Wrangler before deploying:",
    "  wrangler secret put <SECRET_NAME>",
    "\nSee .env.example for format instructions on each secret.",
    "\nNever commit real secrets to .env — that file is for local development only.",
  );
  return sections.join("\n");
}

// ── Module-level validation cache ────────────────────────────────────────────
// Cloudflare Workers create a new isolate per deployment, but the same isolate
// handles many requests. We validate once per isolate lifetime and cache the
// result to avoid re-validating on every request.
let _validationResult: string | null | undefined = undefined;
let _validatedEnvHash: string = "";

function getEnvHash(env: Record<string, string>): string {
  // Quick identity check — only re-validate if env bindings change (they don't in practice)
  return REQUIRED_SECRETS.map((s) => (env[s.key] ?? "").slice(0, 8)).join("|");
}

function ensureSecretsValid(env: Record<string, string>): void {
  const hash = getEnvHash(env);
  if (_validatedEnvHash === hash && _validationResult !== undefined) {
    if (_validationResult) throw new Error(_validationResult);
    return;
  }
  _validatedEnvHash = hash;
  _validationResult = validateStartupSecrets(env);
  if (_validationResult) throw new Error(_validationResult);
}

export default {
  // ── HTTP handler ──────────────────────────────────────────────────────────
  async fetch(request: Request, env: unknown, ctx: ExecutionContext): Promise<Response> {
    // Validate all required secrets on first request per isolate.
    // Returns a structured 500 error listing every unset or placeholder secret
    // rather than throwing mid-request with a cryptic message.
    try {
      ensureSecretsValid(env as Record<string, string>);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // Log to Cloudflare's logpush so the error appears in the dashboard
      console.error(msg);
      return new Response(
        JSON.stringify({
          error: "startup_validation_failed",
          message:
            "Worker cannot serve requests until all required secrets are configured. Check server logs for details.",
          // Only expose detail in non-production (to help during staging setup)
          ...(((env as Record<string, string>).NODE_ENV ?? "production") !== "production"
            ? { detail: msg }
            : {}),
        }),
        { status: 503, headers: { "Content-Type": "application/json", "Retry-After": "60" } },
      );
    }

    // Flush pending log batch after response is sent — non-blocking
    const response = await (
      ((r: Request, e: unknown, c: ExecutionContext) => startFetchHandler.fetch(r, e, c)) as any
    )(request, env, ctx);
    ctx.waitUntil(flushLogs()); // waitUntil OK here — logging only, not business logic
    return response;
  },

  // ── Queue consumer ────────────────────────────────────────────────────────
  // Fix 10: Called by Cloudflare for each batch from any of the 8 partitioned
  // queues (wabizz-jobs-0 … wabizz-jobs-7). All partitions route to the same
  // processQueueBatch — partitioning is purely for tenant isolation at the
  // infrastructure level; job processing logic is identical across partitions.
  async queue(batch: MessageBatch<Job>, env: unknown, ctx: ExecutionContext): Promise<void> {
    await processQueueBatch(batch, env as Record<string, string | undefined>);
    ctx.waitUntil(flushLogs());
  },

  // ── Cron trigger ──────────────────────────────────────────────────────────
  async scheduled(event: ScheduledEvent, env: unknown, ctx: ExecutionContext): Promise<void> {
    await scheduledHandler.scheduled(event, env, ctx);
    ctx.waitUntil(flushLogs());
  },
};

// Export Durable Object classes so Wrangler can register them
export { RateLimiterDO } from "@/lib/rate-limiter-do";
// CircuitStateDO: stores cross-instance circuit breaker state (Fix: in-memory circuit breaker)
export { CircuitStateDO } from "@/lib/server/circuit-breaker/circuit-breaker-do";

// Export for testing
export { validateStartupSecrets, isPlaceholder, REQUIRED_SECRETS };
