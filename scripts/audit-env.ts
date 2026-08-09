#!/usr/bin/env node
// =============================================================================
// audit-env.ts — Environment Variable Audit
//
// Run before deploying to production to verify all required secrets are set,
// no dev-only values are leaking into production, and no debug logging is on.
//
// Usage:
//   npx tsx scripts/audit-env.ts
//   # or add to package.json:
//   # "audit:env": "tsx scripts/audit-env.ts"
//
// Exit codes:
//   0 — All checks passed
//   1 — One or more REQUIRED variables are missing or invalid
// =============================================================================

const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

let errors = 0;
let warnings = 0;

function fail(msg: string) {
  console.error(`${RED}  ✗ FAIL${RESET}  ${msg}`);
  errors++;
}

function warn(msg: string) {
  console.warn(`${YELLOW}  ⚠ WARN${RESET}  ${msg}`);
  warnings++;
}

function ok(msg: string) {
  console.log(`${GREEN}  ✓ OK  ${RESET}  ${msg}`);
}

function check(label: string) {
  console.log(`\n${BOLD}${label}${RESET}`);
}

const env = process.env;
const isProd = env.NODE_ENV === "production";

// ── 1. Required secrets ───────────────────────────────────────────────────────

check("1. Required secrets");

const required: [string, string][] = [
  ["SUPABASE_URL", "Supabase project URL"],
  ["SUPABASE_PUBLISHABLE_KEY", "Supabase anon key"],
  ["SUPABASE_SERVICE_ROLE_KEY", "Supabase service role key (SERVER ONLY)"],
  ["GROQ_API_KEY", "Groq API key for AI features"],
  ["TWILIO_ACCOUNT_SID", "Twilio account SID"],
  ["TWILIO_AUTH_TOKEN", "Twilio auth token"],
  ["WABIZZ_PAYSTACK_SECRET_KEY", "Paystack secret key"],
  ["APP_URL", "Production app URL"],
  ["ADMIN_JWT_SECRET", "Admin dashboard JWT secret"],
  ["CRON_SECRET", "Scheduled job protection secret"],
];

for (const [key, label] of required) {
  const val = env[key];
  if (!val) {
    fail(`${key} is not set — ${label}`);
  } else if (val.includes("your-") || val.includes("change-this") || val.includes("...")) {
    fail(`${key} looks like a placeholder value, not a real secret`);
  } else {
    ok(`${key} is set (${val.length} chars)`);
  }
}

// ── 2. Recommended secrets ───────────────────────────────────────────────────

check("2. Recommended secrets (warnings only)");

const recommended: [string, string][] = [
  ["SENTRY_DSN", "Sentry error reporting — auto-collects crashes"],
  ["SLACK_ALERT_WEBHOOK_URL", "Slack alerts for fatal errors"],
  ["TELEGRAM_BOT_TOKEN", "Telegram alerts"],
  ["UPSTASH_REDIS_REST_URL", "Required for rate limiting in Node/PM2 cluster mode"],
  ["HEALTH_CHECK_SECRET", "Protects the deep health check endpoint"],
];

for (const [key, label] of recommended) {
  const val = env[key];
  if (!val) {
    warn(`${key} is not set — ${label}`);
  } else {
    ok(`${key} is set`);
  }
}

// ── 3. Production safety checks ───────────────────────────────────────────────

check("3. Production safety");

if (!env.NODE_ENV) {
  warn("NODE_ENV is not set — defaulting to development behaviour");
} else if (isProd) {
  ok(`NODE_ENV=${env.NODE_ENV}`);
} else {
  warn(`NODE_ENV=${env.NODE_ENV} — are you sure this is a production deploy?`);
}

if (env.LOG_LEVEL === "debug" && isProd) {
  warn(
    "LOG_LEVEL=debug in production — this will log sensitive request data. Set to 'warn' or 'error'.",
  );
} else {
  ok(`LOG_LEVEL=${env.LOG_LEVEL ?? "not set (defaults to warn)"}`);
}

if (env.ADMIN_JWT_SECRET && env.ADMIN_JWT_SECRET.length < 64) {
  fail(
    "ADMIN_JWT_SECRET is too short (minimum 64 characters). Generate with: openssl rand -hex 32",
  );
}

if (env.CRON_SECRET && env.CRON_SECRET.length < 16) {
  fail("CRON_SECRET is too short (minimum 16 characters). Generate with: openssl rand -hex 32");
}

// ── 4. Secret format checks ───────────────────────────────────────────────────

check("4. Secret format validation");

const supabaseUrl = env.SUPABASE_URL ?? "";
if (supabaseUrl && !supabaseUrl.startsWith("https://")) {
  fail("SUPABASE_URL must start with https://");
} else if (supabaseUrl) {
  ok("SUPABASE_URL format looks correct");
}

const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const anonKey = env.SUPABASE_PUBLISHABLE_KEY ?? "";
if (serviceKey && anonKey && serviceKey === anonKey) {
  fail(
    "SUPABASE_SERVICE_ROLE_KEY and SUPABASE_PUBLISHABLE_KEY are the same — they must be different",
  );
}

const paystackKey = env.WABIZZ_PAYSTACK_SECRET_KEY ?? "";
if (paystackKey && !paystackKey.startsWith("sk_live_") && !paystackKey.startsWith("sk_test_")) {
  warn(
    "WABIZZ_PAYSTACK_SECRET_KEY doesn't look like a Paystack secret key (expected sk_live_ or sk_test_)",
  );
} else if (paystackKey.startsWith("sk_test_") && isProd) {
  fail("WABIZZ_PAYSTACK_SECRET_KEY is a TEST key but NODE_ENV=production — use your live key");
} else if (paystackKey.startsWith("sk_live_")) {
  ok("WABIZZ_PAYSTACK_SECRET_KEY is a live key ✓");
}

const sentryDsn = env.SENTRY_DSN ?? "";
if (sentryDsn && !sentryDsn.startsWith("https://")) {
  fail("SENTRY_DSN format is invalid — expected https://key@host/project-id");
} else if (sentryDsn) {
  ok("SENTRY_DSN format looks correct");
}

const groqKey = env.GROQ_API_KEY ?? "";
if (groqKey && !groqKey.startsWith("gsk_")) {
  warn("GROQ_API_KEY doesn't look like a Groq key (expected gsk_...)");
}

// ── 5. App URL check ──────────────────────────────────────────────────────────

check("5. App URL");

const appUrl = env.APP_URL ?? "";
if (appUrl && !appUrl.startsWith("https://") && isProd) {
  fail("APP_URL must use HTTPS in production");
} else if (appUrl) {
  ok(`APP_URL=${appUrl}`);
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log("\n" + "─".repeat(60));
if (errors === 0 && warnings === 0) {
  console.log(`${GREEN}${BOLD}✓ All checks passed. Ready for production.${RESET}`);
} else if (errors === 0) {
  console.log(`${YELLOW}${BOLD}⚠ ${warnings} warning(s). Review before deploying.${RESET}`);
} else {
  console.log(
    `${RED}${BOLD}✗ ${errors} error(s), ${warnings} warning(s). Fix errors before deploying.${RESET}`,
  );
  process.exit(1);
}
