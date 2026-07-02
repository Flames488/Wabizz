# Wabizz Load Tests

## Tools

| Tool      | File                   | Use                                               |
| --------- | ---------------------- | ------------------------------------------------- |
| k6        | `k6-webhook.js`        | Detailed latency/error metrics, custom thresholds |
| Artillery | `artillery-config.yml` | CI pipeline integration, quick YAML-driven runs   |

## Acceptance Criteria (Fix 10)

| Metric            | Target                |
| ----------------- | --------------------- |
| p95 response time | < 3,000ms             |
| p99 response time | < 5,000ms             |
| Error rate        | < 1%                  |
| Job loss          | 0 (DLQ count stays 0) |
| System crash      | None                  |

## Running k6

```bash
npm install -g k6

# Smoke test (10 VUs × 30s)
k6 run --scenario smoke \
  --env BASE_URL=https://your-app.workers.dev \
  load-tests/k6-webhook.js

# 1,000 user ramp
k6 run --scenario ramp1000 \
  --env BASE_URL=https://your-app.workers.dev \
  load-tests/k6-webhook.js

# 3,000 user stress test
k6 run --scenario ramp3000 \
  --env BASE_URL=https://your-app.workers.dev \
  load-tests/k6-webhook.js
```

## Running Artillery

```bash
npm install -g artillery artillery-plugin-expect

# Full scenario (warm-up → 1k → 3k)
artillery run \
  --env target=https://your-app.workers.dev \
  load-tests/artillery-config.yml

# Quick smoke (override phases via env)
artillery quick --count 100 --num 10 \
  https://your-app.workers.dev/api/public/health
```

## Before Running

1. Deploy to a **staging** Cloudflare Worker (never load test production)
2. Disable Twilio signature verification in staging (`TWILIO_AUTH_TOKEN=test`)
3. Set up a separate Supabase project for staging
4. Monitor the admin dashboard at `/admin` while the test runs
5. After each test: check DLQ count at `/api/public/health?deep=1`

## Interpreting Results

- **p95 > 3s**: Worker is CPU-bound or Supabase queries are slow → check DB indexes, run `EXPLAIN ANALYZE`
- **Error rate > 1%**: Check circuit breaker states, Twilio/Paystack rate limits
- **DLQ growing**: Consumer worker is overwhelmed → check Cloudflare Queue consumer concurrency settings
- **Webhook stall alerts**: Worker crashed mid-processing → check worker logs in Cloudflare dashboard
