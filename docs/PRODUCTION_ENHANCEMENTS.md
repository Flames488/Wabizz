# Production Enhancements — v2

This document records the hardening changes applied on top of `wabizz-launch-ready`
to produce the final production build.

## Changes by file

### `src/lib/sentry.ts`

Already present in launch-ready. No changes.

### `src/lib/server/error-handler.ts`

- `WabizzError` instances now forwarded to Sentry as messages at `"warning"` level
  via `captureMessage()`. You can now track validation/auth error patterns in your
  Sentry dashboard without polluting the exceptions feed.
- `userId` and `businessId` extracted from error context and passed to Sentry
  so you can filter errors by tenant.

### `src/lib/server/circuit-breaker/circuit-breaker.ts`

- Circuit OPEN events captured in Sentry as `"warning"` messages — gives you a
  timestamped outage history in Sentry for every Twilio/Paystack/Anthropic trip.
- Circuit recovery (HALF_OPEN → CLOSED) captured as `"info"` message.
- `getCircuitStates()` now returns `openedAt` ISO timestamp so the health endpoint
  shows exactly when each circuit tripped.

### `src/lib/server-logger.ts`

- `logError` / `logWarn` / `logInfo` / `logFatal` return `void` (not `Promise<void>`).
  Previous callers were incorrectly `await`-ing these functions.
- `logError()` now forwards to Sentry via `captureMessage()` at `"error"` level,
  so your error rate is visible in Sentry dashboards.
- `logFatal()` passes full structured context to `captureFatal()` — not just the message.
- `_sendFatalAlerts` is now truly fire-and-forget (void, never awaited).

### `src/routes/api.public.health.ts`

- Sentry configuration status added to deep health check as `checks.sentry`.
  Returns `"warn"` (not `"fail"`) if Sentry DSN is not configured, so the
  health endpoint stays green but you're alerted to the gap.
- `circuits` response now includes `openedAt` timestamp per service.
- Version bumped to `"15"`.

### `src/lib/rate-limiter.ts`

- Rate limit blocks now recorded to `rate_limit_events` table (migration 021/022)
  for analytics. Recording is fire-and-forget — never blocks the request path.
- Sustained abuse detection: if the same key is blocked 10+ times in a window,
  a Sentry `"warning"` message fires. You get notified of attack patterns without
  needing to scan logs.
- `checkRateLimit()` and `checkIpRateLimit()` accept an `endpoint` label for
  richer analytics in the `rate_limit_abuse_summary` view.

### `.env.example`

- Fixed key name: `WABIZZ_PAYSTACK_SECRET_KEY`
  (was inconsistent with `scripts/audit-env.ts` which validated `WABIZZ_PAYSTACK_SECRET_KEY`).

### `supabase/migrations/20260504_022_production_enhancements.sql`

- Added `idx_rate_limit_events_ip_occurred` index for IP-based abuse queries.
- Added `rate_limit_abuse_summary` view — top offending IPs in last 24h at a glance.
- Added `circuit_events` table — persistent, queryable history of circuit breaker
  OPEN/CLOSE events. Complements the in-memory state with a record that survives
  worker restarts and spans multiple instances.
- All DDL is idempotent (`IF NOT EXISTS` / `OR REPLACE`).

## Score delta

| Dimension            | Before                          | After                                                     |
| -------------------- | ------------------------------- | --------------------------------------------------------- |
| Error observability  | Sentry captures exceptions only | Sentry captures exceptions + domain errors + error rate   |
| Circuit breaker      | In-memory state only            | In-memory state + Sentry timeline + persistent DB history |
| Rate limit analytics | Table exists, no recording      | Table populated + abuse detection                         |
| Health endpoint      | No Sentry check                 | Sentry config surfaced                                    |
| Env config           | Key name mismatch               | Consistent across all files                               |
