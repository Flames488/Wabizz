# Wabizz On-Call Runbook

> **Audience:** Engineers responding to PagerDuty / Telegram / Slack alerts at any hour.
> Keep this doc open when an alert fires. Every section maps 1:1 to a named alert.

---

## 1. DLQ Alert — Job Exhausted All Retries

**Alert fires when:** A job reaches `max_retries = 5` and is moved to `WABIZZ_DLQ`.
You will receive a Telegram + Slack message with the job type and last error.

### Step 1 — Find the failed job

```sql
-- In Supabase SQL editor
SELECT id, job_type, payload, last_error, failed_at, retry_count
FROM dead_letter_jobs
ORDER BY failed_at DESC
LIMIT 20;
```

Key columns:

- `job_type` — what kind of job failed (`send_whatsapp`, `retry_claude_reply`, etc.)
- `last_error` — the exception message from the final attempt
- `payload` — the full job payload (check `businessId` to identify which tenant)
- `retry_count` — always 5 for DLQ entries

### Step 2 — Diagnose by `last_error` value

| `last_error` contains           | Root cause                                             | Action                                                                                                                    |
| ------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `429` / `rate limit`            | Groq rate limit exhausted                              | Check Groq usage dashboard → [console.groq.com](https://console.groq.com) → request increase if persistent               |
| `ECONNREFUSED` / `fetch failed` | External service unreachable (Twilio, Paystack, Vitar) | Check circuit breaker status (section 2), check service status pages                                                      |
| `timeout` / `AbortError`        | Service responded too slowly                           | Usually transient — replay the job                                                                                        |
| `Invalid signature`             | Webhook replay with wrong credentials                  | Investigate for replay attack; do NOT re-enqueue                                                                          |
| `business not found`            | Tenant deleted their account mid-flight                | Safe to discard                                                                                                           |
| `23505` / `duplicate key`       | Idempotency collision — job already processed          | Safe to discard                                                                                                           |

### Step 3 — Manual replay

Replay a single job via the admin panel:

1. Go to `/admin/dead-letter-queue`
2. Find the job by ID
3. Click **Replay** — this re-enqueues with a fresh retry counter

Or replay directly from SQL (sets retry_count = 0 and re-enqueues):

```sql
-- Re-enqueue a specific DLQ job
SELECT replay_dlq_job('job-uuid-here');
```

### Step 4 — Bulk replay after an outage

After an external service recovers (e.g., Twilio was down for 30 min):

```sql
-- Replay all DLQ jobs of a given type from the last 2 hours
SELECT replay_dlq_job(id)
FROM dead_letter_jobs
WHERE job_type = 'send_whatsapp'
  AND failed_at > now() - interval '2 hours';
```

### Step 5 — Escalation

If the same job type keeps DLQ-ing after replay:

1. Check circuit breaker state (section 2 below)
2. Check external service status pages (section 3, 5)
3. Page the on-call lead if > 50 jobs in DLQ within 1 hour

---

## 2. Circuit Breaker Open

**Alert fires when:** A circuit breaker trips OPEN after 3 consecutive failures.
The alert names which service tripped: `twilio`, `paystack`, `anthropic`, or `vitar`.

### What a tripped circuit means

The circuit breaker stops all calls to the failing service for **30 seconds** (60 seconds for `vitar`). After the timeout, one probe request is sent. If it succeeds, the circuit closes. If it fails, the timer resets.

During this window:

- WhatsApp sends → queued in WABIZZ_QUEUE, retried automatically
- Paystack links → not sent; customer gets a "payment link coming shortly" message
- AI replies → `retry_claude_reply` job enqueued
- Vitar bookings → customer gets the "booking system temporarily unavailable" message

### Check which circuits are open

```sql
-- Supabase: circuit state is stored in circuit_state table
SELECT service, state, failure_count, last_failure_at, next_probe_at
FROM circuit_state
WHERE state != 'CLOSED'
ORDER BY last_failure_at DESC;
```

### Check external status pages

| Service    | Status page                                              |
| ---------- | -------------------------------------------------------- |
| Twilio     | [status.twilio.com](https://status.twilio.com)           |
| Paystack   | [status.paystack.com](https://status.paystack.com)       |
| Groq       | [groqstatus.com](https://groqstatus.com)                 |
| Supabase   | [status.supabase.com](https://status.supabase.com)       |
| Cloudflare | [cloudflarestatus.com](https://www.cloudflarestatus.com) |

### Force-reset a circuit for testing

```sql
-- Reset a specific circuit to CLOSED (use with caution in production)
UPDATE circuit_state
SET state = 'CLOSED', failure_count = 0, next_probe_at = null
WHERE service = 'twilio';  -- or 'paystack', 'anthropic', 'vitar'
```

> ⚠️ Only force-reset after confirming the external service is healthy. A premature reset will immediately re-trip the circuit if the service is still down.

### Expected auto-recovery timeline

| Circuit     | Opens after | Auto-probe after | Normal recovery                            |
| ----------- | ----------- | ---------------- | ------------------------------------------ |
| `twilio`    | 3 failures  | 30s              | 1–2 minutes after Twilio recovers          |
| `paystack`  | 3 failures  | 30s              | 1–2 minutes after Paystack recovers        |
| `anthropic` | 3 failures  | 30s              | 1–2 minutes after rate limit resets        |
| `vitar`     | 3 failures  | 60s              | 2–3 minutes after Vitar container restarts |

---

## 3. Vitar Down

**Alert fires when:** The Vitar circuit breaker trips OPEN and stays open for > 2 minutes,
or when a Vitar health check endpoint returns non-200.

### Step 1 — SSH into the VPS

```bash
ssh deploy@your-vps-ip
cd /opt/vitar
```

### Step 2 — Check container health

```bash
# See all container statuses
docker compose ps

# Look for containers with status != "healthy" or "Up"
# Common states: "Restarting", "Exit 1", "unhealthy"
```

### Step 3 — Check recent logs

```bash
# API container logs (last 100 lines)
docker compose logs --tail=100 api

# If using named replicas (scale config):
docker compose logs --tail=100 api_1
docker compose logs --tail=50 api_2 api_3

# Database logs
docker compose logs --tail=50 db
```

### Step 4 — Restart the API

```bash
# Restart API only (leaves DB + Redis running)
docker compose restart api

# If using scale config:
docker compose restart api_1 api_2 api_3
docker compose restart nginx   # Required after restarting replicas
```

### Step 5 — Verify recovery

```bash
# Health check should return 200
curl -s https://your-vitar-domain/api/v1/health | jq .

# Expected: { "status": "healthy", "db": "ok", "redis": "ok" }
```

### Step 6 — Confirm circuit breaker auto-recovers

After Vitar is back up, the circuit breaker will probe it within 60 seconds.
Check Supabase to confirm it closes:

```sql
SELECT service, state, last_failure_at
FROM circuit_state
WHERE service = 'vitar';
-- state should change from 'OPEN' to 'CLOSED' within ~60s
```

---

## 4. Groq Rate Limit (429)

**Alert fires when:** The `anthropic` circuit breaker trips OR when `retry_claude_reply`
jobs appear in the DLQ in volume. (Breaker/queue names predate the Groq migration —
they still refer to the AI reply path, now backed by Groq.)

### Step 1 — Check current usage

Go to [console.groq.com](https://console.groq.com) → **Usage** tab.
Look for spikes in requests per minute on `llama-3.3-70b-versatile`.

### Step 2 — What the system does automatically

When a 429 is received on the webhook path:

1. The customer receives: _"We're experiencing high demand right now — we'll reply to you in a moment! ⏳"_
2. A `retry_claude_reply` job is enqueued with exponential backoff
3. The `anthropic` circuit breaker trips after 3 consecutive 429s
4. All subsequent AI calls fail instantly (no timeout wait) until the circuit probes

The `retry_claude_reply` job re-runs the full AI flow. By the time it fires
(Cloudflare Queue backoff: 1s → 2s → 5s → 10s → 30s), the rate limit window
(typically 60 seconds) will have reset.

### Step 3 — Request a rate limit increase

If 429s are persistent (> 5 minutes):

1. Go to [console.groq.com/settings/limits](https://console.groq.com/settings/limits)
2. Request a higher tier / limit increase, or contact Groq support
3. Include: current RPM, target RPM, and use case (WhatsApp AI automation)

### Step 4 — Emergency: switch to a lower/faster model

If rate limits are causing sustained customer impact:

```bash
# In wrangler secret or .env — temporarily switch model
wrangler secret put GROQ_MODEL
# Enter an alternate Groq-hosted model, e.g. llama-3.1-8b-instant
```

Alternatively, reduce `max_tokens` from 1024 to 512 in `buildAiDeps` to lower
per-request token cost until the limit increase is approved.

---

## 5. Supabase Connection Exhaustion

**Alert fires when:** All Supabase requests begin returning errors, Cloudflare Worker
logs show `remaining connection slots are reserved`, or the health check returns 503.

### Symptoms

- All API endpoints returning 500 or 503
- Supabase dashboard shows connection count at max (Pro plan: 200 direct connections)
- Worker logs: `remaining connection slots are reserved for non-replication superuser connections`

### Step 1 — Verify the Supabase project URL is set

```bash
# Check what SUPABASE_URL is currently set to in Wrangler
wrangler secret list
# Then verify it is an HTTPS project URL such as https://project-ref.supabase.co
```

If the value is a PostgreSQL connection string, move it to `SUPABASE_DB_URL` for database tooling and set `SUPABASE_URL` to the HTTPS project URL.

```bash
# Fix: set the HTTPS project URL
wrangler secret put SUPABASE_URL
# Paste: https://[project-ref].supabase.co
```

### Step 2 — Emergency fix: restart Workers deployment

Redeploying the Worker resets all connection state:

```bash
wrangler deploy
```

This causes a brief cold-start gap (~2s) but resets any leaked connections.

### Step 3 — Check pool status in Supabase dashboard

Go to [app.supabase.com](https://app.supabase.com) → your project → **Database** → **Connections**.

Look at:

- **Active connections** — should be < 80% of your plan limit
- **Idle connections** — high idle count means connections aren't being released

### Step 4 — Upgrade Supabase plan if needed

| Plan | Max direct connections | Pooler connections        |
| ---- | ---------------------- | ------------------------- |
| Free | 20                     | Not available             |
| Pro  | 200                    | Thousands (via pgbouncer) |
| Team | 200                    | Thousands                 |

At high traffic levels, use Supabase client APIs through the HTTPS project URL
and keep direct PostgreSQL access restricted to operational tooling.

---

## Quick Reference

| Alert                          | First action                                 | Expected resolution |
| ------------------------------ | -------------------------------------------- | ------------------- |
| DLQ job                        | Check `last_error` → replay if safe          | < 5 min             |
| Circuit OPEN (Twilio/Paystack) | Check status page → wait for auto-recovery   | 1–5 min             |
| Circuit OPEN (Groq)            | Check usage dashboard → retry jobs auto-fire | 1–2 min             |
| Vitar down                     | SSH → `docker compose restart api`           | 2–5 min             |
| 429 sustained                  | Request rate limit increase                  | 1–2 business days   |
| Bad Supabase URL               | Set HTTPS project URL → `wrangler deploy`    | < 2 min             |
