# Wabizz — WhatsApp AI Automation Platform for Nigerian Businesses

Wabizz is an AI-powered business automation platform that helps Nigerian businesses automate their daily operations — responding to customers, managing orders, collecting payments — all through WhatsApp. Businesses onboard in minutes, connect their Paystack and Twilio accounts, and immediately start handling customer conversations and orders automatically with zero manual effort.

**Stack:** TanStack Start · Bun · Supabase · Cloudflare Workers · Paystack · Twilio / 360dialog · Groq

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Prerequisites](#prerequisites)
3. [Local Development](#local-development)
4. [Environment Variables](#environment-variables)
5. [Database Migrations](#database-migrations)
6. [Deploying to Cloudflare Workers](#deploying-to-cloudflare-workers)
7. [Deploying to VPS / Docker + PM2](#deploying-to-vps--docker--pm2)
8. [Scheduled Jobs (Cron)](#scheduled-jobs-cron)
9. [Health Checks & Monitoring](#health-checks--monitoring)
10. [Manual Cron Trigger](#manual-cron-trigger)
11. [Troubleshooting](#troubleshooting)

---

## Architecture Overview

```
WhatsApp User
     │ (SMS/WhatsApp)
     ▼
Twilio / 360dialog
     │ (webhook POST)
     ▼
Wabizz Server (TanStack Start / Cloudflare Workers)
     ├── Rate limiter (KV or Upstash Redis)
     ├── Twilio signature verification (HMAC)
     ├── Groq (AI intent + reply)
     ├── Paystack (payment links)
     └── Supabase (DB + auth + Vault)
```

**Deployment targets:**

- **Cloudflare Workers** (recommended) — serverless, auto-scales globally, KV for shared state
- **Node/PM2 on VPS** — single-region, cluster mode, Upstash Redis for shared state
- **Docker + Nginx** — same as PM2 but containerised

---

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.0
- [Supabase CLI](https://supabase.com/docs/guides/cli) ≥ 1.0
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) ≥ 3.0 (for Workers deploys)
- Cloudflare account (free tier is fine)
- Supabase project (free tier is fine)
- Twilio account with WhatsApp sandbox or verified number
- Paystack account (NGN)
- Groq API key

---

## Local Development

```bash
# 1. Clone and install
git clone https://github.com/your-org/wabizz.git
cd wabizz
bun install

# 2. Copy env template
cp .env.example .env.local

# 3. Fill in your .env.local (see Environment Variables section below)

# 4. Run Supabase locally
supabase start
supabase db push   # applies all migrations

# 5. Start the dev server
bun run dev
```

The app will be available at http://localhost:3000.

**Note:** In local dev, KV bindings (rate limiter, cache, queue) are unavailable and fall back to in-memory. This is fine for development — just don't test rate limiting locally.

---

## Environment Variables

Copy `.env.example` to `.env.local` and fill in every value. Required variables:

| Variable                        | Description                      | Where to get it                             |
| ------------------------------- | -------------------------------- | ------------------------------------------- |
| `SUPABASE_URL`                  | Supabase project URL             | Supabase dashboard → Project Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY`     | Service role key (server-only)   | Supabase dashboard → Project Settings → API |
| `SUPABASE_PUBLISHABLE_KEY`      | Anon key (browser-safe)          | Supabase dashboard → Project Settings → API |
| `VITE_SUPABASE_URL`             | Same as SUPABASE_URL             | —                                           |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Same as SUPABASE_PUBLISHABLE_KEY | —                                           |
| `GROQ_API_KEY`                  | Groq API key                     | console.groq.com/keys                       |
| `TWILIO_ACCOUNT_SID`            | Twilio account SID               | console.twilio.com                          |
| `TWILIO_AUTH_TOKEN`             | Twilio auth token                | console.twilio.com                          |
| `WABIZZ_PAYSTACK_SECRET_KEY`    | Wabizz's own Paystack SK         | dashboard.paystack.com → Developers         |
| `APP_URL`                       | Public URL of this app           | Your domain / workers.dev subdomain         |

Optional (recommended):

| Variable                   | Description                         | Impact if missing                           |
| -------------------------- | ----------------------------------- | ------------------------------------------- |
| `SLACK_ALERT_WEBHOOK_URL`  | Slack webhook for fatal errors      | Fatal errors only in logs, not Slacked      |
| `CRON_SECRET`              | Protects manual cron trigger        | Anyone can trigger reminders                |
| `HEALTH_CHECK_SECRET`      | Protects deep health check          | DB ping exposed publicly                    |
| `UPSTASH_REDIS_REST_URL`   | Upstash Redis URL (Node/PM2 only)   | Rate limits are per-process in cluster mode |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis token (Node/PM2 only) | Cache invalidation doesn't cross workers    |

---

## Database Migrations

Migrations live in `supabase/migrations/` and must be applied in filename order.

```bash
# Apply all pending migrations to your Supabase project
supabase db push

# Check migration status
supabase db status

# Reset local DB and replay all migrations (destructive — local only)
supabase db reset
```

**Migration history:**

- `001` — Error logs + Vault setup
- `002` — Production hardening v2
- `003` — Bug fixes v3
- `004`, `005` — Chain continuity placeholders (no schema changes)
- `006` — v5 bug fixes
- `007` — Index fixes
- `008` — Schema completeness (notification_log, last_message_content, error_logs)
- `009` — Ops improvements (startup_log, rate_limit_overrides, error_logs pruning)

---

## Deploying to Cloudflare Workers

### First deploy

```bash
# 1. Create KV namespaces
wrangler kv namespace create RATE_LIMIT_KV
wrangler kv namespace create CACHE_KV
wrangler kv namespace create QUEUE_KV

# 2. Copy the printed IDs into wrangler.jsonc (replace the REPLACE_WITH_... placeholders)

# 3. Set secrets
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
wrangler secret put SUPABASE_PUBLISHABLE_KEY
wrangler secret put GROQ_API_KEY
wrangler secret put TWILIO_ACCOUNT_SID
wrangler secret put TWILIO_AUTH_TOKEN
wrangler secret put WABIZZ_PAYSTACK_SECRET_KEY
wrangler secret put APP_URL
wrangler secret put SLACK_ALERT_WEBHOOK_URL   # optional
wrangler secret put CRON_SECRET               # optional
wrangler secret put HEALTH_CHECK_SECRET       # optional

# 4. Build and deploy
#    On first deploy, Wrangler will prompt you to apply the RateLimiterDO migration.
#    Accept it. This is a one-time step that registers the Durable Object class.
#    All subsequent deploys are normal — do NOT remove the migration entry in wrangler.jsonc.
bun run build
wrangler deploy
```

### Subsequent deploys

```bash
bun run build && wrangler deploy
```

### Set up Twilio webhook

After deploying, configure Twilio to send WhatsApp messages to:

```
POST https://your-app.workers.dev/api/public/twilio-webhook
```

---

## Deploying to VPS / Docker + PM2

### With Docker Compose

```bash
# 1. Copy .env.example to .env and fill in all values
cp .env.example .env

# 2. Start the app (without nginx)
docker compose up -d

# 3. With nginx reverse proxy (requires nginx/ssl/cert.pem and nginx/ssl/key.pem)
docker compose --profile with-nginx up -d
```

### With PM2 directly

```bash
# Install pm2 globally (one-time)
npm install -g pm2

# Build the app
bun install --frozen-lockfile
bun run build

# Run the automated setup script — handles log rotation, startup hook,
# and uptime monitor registration in one command.
APP_URL=https://your-domain.com \
BETTERUPTIME_API_KEY=your_key \      # from betterstack.com (free)
HEALTH_CHECK_SECRET=your_secret \   # must match your .env
bun run setup:server

# View logs
pm2 logs wabizz
pm2 monit
```

The `setup:server` script (`scripts/setup-server.sh`) handles everything that was previously manual:

- Creates `logs/` directory
- Installs and configures `pm2-logrotate` (50 MB cap, 14-day retention, gzip)
- Runs `pm2 startup` and applies the system service hook automatically
- Starts the app, saves the process list
- Registers an uptime monitor via Better Uptime or UptimeRobot API

If you prefer to run without the script:

```bash
# Manual steps (not recommended)
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 50M
pm2 set pm2-logrotate:retain 14
pm2 set pm2-logrotate:compress true
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup  # follow the printed command
```

### Upstash Redis (required for PM2 cluster mode)

PM2 runs multiple worker processes. Without Redis, rate limiting and cache are per-process (broken). Set these two env vars to enable shared state:

1. Create a free Redis database at [console.upstash.com](https://console.upstash.com)
2. Copy the REST URL and token
3. Add to your server env:
   ```
   UPSTASH_REDIS_REST_URL=https://...upstash.io
   UPSTASH_REDIS_REST_TOKEN=...
   ```

---

## Scheduled Jobs (Cron)

Reminders run daily at **07:00 UTC (08:00 WAT)**:

- Trial expiry warnings (24h before trial ends)
- Overdue payment reminders (orders unpaid > 30 min)
- Subscription renewal reminders (3 days before period end)

**On Cloudflare Workers:** configured automatically via `wrangler.jsonc` → `triggers.crons`.

**On VPS/PM2:** Set up a system cron to hit the manual trigger endpoint:

```bash
# /etc/cron.d/wabizz
0 7 * * * root curl -s -X POST https://your-app.com/api/public/scheduled \
  -H "x-cron-secret: YOUR_CRON_SECRET" \
  -H "Content-Type: application/json"
```

---

## Health Checks & Monitoring

### Shallow health check (for load balancers)

```
GET /api/public/health
→ 200 { status: "ok", ts: "...", version: "13" }
```

No DB call. Safe to poll every 10 seconds.

### Deep health check (for dashboards)

```
GET /api/public/health?deep=1
Header: x-health-secret: YOUR_HEALTH_CHECK_SECRET
→ 200 { status: "ok", checks: { db: "ok", env_*: "ok", ... }, memory: { heapUsedMb: 42 } }
→ 503 { status: "degraded", checks: { db: "fail", ... } }
```

Makes a DB ping. Run at most every 60 seconds.

**Recommended uptime monitors:**

- [Better Uptime](https://betterstack.com/uptime) — ping `/api/public/health` every 1 min
- [UptimeRobot](https://uptimerobot.com) — free tier, 5-min intervals

---

## Manual Cron Trigger

Useful for testing reminders or triggering a run outside the schedule:

```bash
curl -X POST https://your-app.com/api/public/scheduled \
  -H "x-cron-secret: YOUR_CRON_SECRET"
```

Returns `202 Accepted` immediately and runs the job in the background.

---

## Troubleshooting

**App won't start — "Missing required environment variables"**
→ Check that all `REQUIRED_ENV_VARS` in `server-init.ts` are set in your environment.

**Twilio webhook returns 401**
→ The `x-twilio-signature` header is failing verification. Common causes:

- `TWILIO_AUTH_TOKEN` doesn't match the account the message came from
- The `APP_URL` is wrong (webhook URL mismatch)
- Request is going through a proxy that changes the URL

**Paystack webhook returns 401**
→ `WABIZZ_PAYSTACK_SECRET_KEY` doesn't match what's configured in Paystack dashboard.

**Rate limiting not working in PM2 cluster mode**
→ `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are not set. Each worker has its own rate limit counter.

**High memory usage**
→ PM2 will restart the worker at 512MB (`max_memory_restart`). Check `pm2 logs wabizz` for memory pressure warnings. Increase the limit in `ecosystem.config.cjs` if legitimate.

**`supabase db push` fails with migration gap error**
→ Migrations 004 and 005 are placeholders. Run `supabase db push --include-all` or apply them manually.

---

## Pre-Launch Checklist

Run `bun run pre-launch` before every production deployment. It validates secrets, KV bindings, migration presence, and Supabase URL format automatically. In addition, verify the following manually:

**Groq API rate limits**

Check your **rate limit tier** on the Groq console before going live with more than 3,000 daily active users. At 10k DAU × 10 messages/day = 100k Groq API calls/day, default limits will throttle your platform and cause the dead-letter queue to fill up.

To request a higher tier: https://console.groq.com/settings/limits — or contact Groq support with your expected daily token volume.

**Rate limit alerting**

Monitor the `retry_claude_reply` queue in Supabase. If more than 50 jobs accumulate in the dead-letter queue within one hour, that is the signal that Groq rate limits are being sustained — scale down traffic or escalate your tier before more users are affected. The existing cron job in `src/routes/api.public.scheduled.ts` already logs DLQ depth; wire it to your alerting channel (Telegram, PagerDuty, etc.).

**Supabase project URL**

Confirm `SUPABASE_URL` is the HTTPS project URL (`https://[project-ref].supabase.co`). PostgreSQL connection strings belong in `SUPABASE_DB_URL` for backup and migration tooling only.

**Twilio / Paystack webhooks**

Ensure webhook URLs in both Twilio Console and Paystack Dashboard point to your production domain, not a dev tunnel. Staging and production must use separate Twilio and Paystack credentials.
