# Wabizz v5 — Audit Fixes Applied

This document summarises every change made in response to the v5 production audit.

---

## Fix 1 — Circuit breaker state persisted to Durable Object (was: in-memory only)

**Problem:** `circuit-breaker.ts` stored state in a `Map<ServiceName, CircuitData>`.
When Cloudflare evicted a Worker instance or routed a request to a new one, that
instance started with all circuits `CLOSED` and would re-probe a down service
immediately — wasting one outbound call and potentially cascading if many instances
reset simultaneously.

**Fix:**

- **New file:** `src/lib/server/circuit-breaker/circuit-breaker-do.ts` —
  `CircuitStateDO` Durable Object class. One DO instance per service name
  (`"twilio"`, `"paystack"`, `"anthropic"`). State stored in DO storage and
  survives instance eviction.
- **Updated:** `src/lib/server/circuit-breaker/circuit-breaker.ts` (v3) —
  `circuitBreaker()` now reads/writes state via the DO before each call.
  An in-memory cache prevents an extra DO round-trip per outbound API call.
  Falls back to pure in-memory if `CIRCUIT_STATE_DO` binding is absent (local dev).
- **Updated:** `wrangler.jsonc` — added `CIRCUIT_STATE_DO` binding + `v2` migration.
- **Updated:** `src/worker-entry.ts` — exports `CircuitStateDO` so Wrangler can register it.
- `getCircuitStates()` now returns a `backend` field (`"durable-object"` or `"in-memory"`)
  in the health endpoint output so you can see which path is active.

**Deploy action required:**

```
wrangler deploy
```

The `v2` migration tag registers `CircuitStateDO` automatically on first deploy.

---

## Fix 2 — Worker test coverage for campaign-processor and automation-processor

**Problem:** 6 test suites covered the frontend, error handling, idempotency,
resilience, security, cache, and webhooks — but the two worker-specific paths
(`handleSendCampaignBatch` and `handleSendAutomationStep`) had zero test coverage.

**Fix:**

- **New file:** `src/__tests__/campaign-processor.test.ts` — 15 test cases covering:
  - `handleSendCampaignBatch`: happy path, campaign not found, non-running status,
    no contacts in batch, no API key, 360dialog failure, idempotency skip,
    campaign completion, merge tag rendering, rate-limit delay
  - `handleSendAutomationStep`: happy path (send + tags + match count), no API key,
    idempotency skip, send failure, no addTags, contact not found, merge tag rendering

All external dependencies (Supabase, 360dialog, API key vault, circuit breaker,
idempotency, event pipeline) are fully mocked — no network calls.

---

## Fix 3 — Supabase project URL check automated

**Problem:** The app previously confused Supabase app-client URLs with direct PostgreSQL URLs and
cannot enforce it. It's easy to forget to update `SUPABASE_URL` in Cloudflare
secrets to the pooler host/port (6543), causing connection exhaustion under load.

**Fix:**

- **New file:** `scripts/pre-launch-check.ts` — Runs 6 pre-launch checks:
  1. `SUPABASE_URL` uses the HTTPS project URL — **critical**
  2. Migrations 023 and 024 are present — **critical**
  3. Load test scripts (k6 + Artillery) are present — warning
  4. wrangler.jsonc has no placeholder KV namespace IDs — **critical**
  5. `CircuitStateDO` exported from `worker-entry.ts` — **critical**
  6. wrangler.jsonc has `CircuitStateDO` DO binding + v2 migration — **critical**

  Run before every deploy:

  ```bash
  bun run pre-launch
  ```

  Exit code 0 = green. Exit code 1 = critical failure, do NOT deploy.

- **Updated:** `package.json` — added `pre-launch`, `load-test:smoke`,
  `load-test:ramp1000`, `load-test:artillery` npm scripts.

---

## Fix 4 — k6 and Artillery load tests wired into CI/CD

**Problem:** `load-tests/k6-webhook.js` and `load-tests/artillery-config.yml`
existed but were never triggered by the CI pipeline. Load tests were manual-only.

**Fix:**

- **Updated:** `.github/workflows/ci-cd.yml` — added:
  - `workflow_dispatch` trigger for manual full load test runs
  - **Job 8 — `load-test-staging`:** Artillery smoke (30s × 50 arrivals/s) runs
    automatically after every `develop` branch staging deploy. Fails CI if
    p95 > 3000ms or error rate > 1%.
  - **Job 9 — `load-test-full`:** Full k6 ramp1000 + Artillery scenario, triggered
    manually via `workflow_dispatch` before merging a release to `main`.
    Uploads results as a 30-day artifact. Notifies Slack on completion.

- **Added:** `load-tests/results/` directory with `.gitkeep` (results excluded via `.gitignore`).

---

## Summary — deploy checklist

Before going live:

1. `bun run pre-launch` — verify all 6 checks pass
2. Set `SUPABASE_URL` to the HTTPS project URL and keep PostgreSQL URLs in `SUPABASE_DB_URL`
3. `supabase db push` — apply migrations 023 and 024
4. `wrangler deploy` — registers `CircuitStateDO` (v2 migration) automatically
5. Run `bun run load-test:smoke` against staging manually once
6. Merge develop → main → automatic production deploy + smoke test with auto-rollback

---

## Fix 5 — Playwright E2E scaffold (closes the 5-point E2E gap)

**Problem:** No browser-level tests existed. The auth → onboarding → send-campaign
flow could not be verified end-to-end in CI. This was the largest gap in the 91-point
audit score (roughly 5 points).

**Fix:**

- **New file:** `playwright.config.ts` — configures Chromium as primary project,
  shared auth state via `storageState`, and optional dev-server auto-start.
- **New directory:** `e2e/tests/`
  - `auth.setup.ts` — signs up/in once, saves cookies to `e2e/.auth/user.json`
  - `auth.spec.ts` — unauthenticated redirect, invalid login, sign-out
  - `onboarding.spec.ts` — business profile form fill + submit
  - `campaigns.spec.ts` — new campaign dialog → create → list → launch button
- **New file:** `e2e/README.md` — local setup and CI integration instructions.
- **Updated:** `package.json` — added `e2e`, `e2e:ui`, `e2e:headed`, `e2e:install` scripts
  and `@playwright/test` devDependency.
- **Updated:** `.gitignore` — excludes `e2e/.auth/user.json` and `playwright-report/`.
- **Updated:** `.github/workflows/ci-cd.yml` — added `e2e` job that runs after
  `deploy-staging` on every `develop` push (Chromium only, uploads HTML report as artifact).
- **Updated:** `scripts/pre-launch-check.ts` — Check 7 warns if Playwright config or
  spec files are missing.

**Run locally:**

```bash
bunx playwright install --with-deps chromium
bunx playwright test --ui
```

**Deploy action required:** None — E2E runs automatically in CI after next `develop` push.
