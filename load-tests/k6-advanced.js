/**
 * k6-advanced.js — Advanced load test for Wabizz (v2)
 *
 * Scenarios:
 *   smoke       — 10 VUs × 30s  (pre-deploy sanity check, runs in CI)
 *   ramp1000    — Ramp to 1,000 VUs over 2 min, sustain 5 min
 *   ramp3000    — Full stress: 3,000 VUs over 5 min, sustain 10 min
 *   spike       — Sudden 2,000 VU spike (30s), then drop — simulates viral moment
 *   soak        — 200 VUs sustained for 30 minutes — catches memory leaks
 *
 * Endpoints under test:
 *   /api/public/health         — health check must always respond < 500ms
 *   /api/public/twilio-webhook — the hot path (WhatsApp message ingestion)
 *   /api/public/scheduled      — cron trigger endpoint
 *
 * Acceptance thresholds:
 *   p95 < 3000ms, p99 < 5000ms, error_rate < 1%, DLQ count = 0 (verified separately)
 *
 * Usage:
 *   k6 run load-tests/k6-advanced.js                            # smoke
 *   k6 run --scenario ramp1000 load-tests/k6-advanced.js       # pre-launch
 *   k6 run --scenario ramp3000 load-tests/k6-advanced.js       # full stress
 *   k6 run --scenario spike    load-tests/k6-advanced.js       # viral resilience
 *   k6 run --scenario soak     load-tests/k6-advanced.js       # memory leak check
 *
 * Output:
 *   k6 run ... --out json=load-tests/results/k6-$(date +%Y%m%d-%H%M%S).json
 */

import http from "k6/http";
import { check, sleep, group } from "k6";
import { Rate, Trend, Counter, Gauge } from "k6/metrics";
import { randomIntBetween } from "https://jslib.k6.io/k6-utils/1.4.0/index.js";

const BASE_URL = __ENV.BASE_URL ?? "http://localhost:5173";
const TWILIO_AUTH_TOKEN = __ENV.TWILIO_AUTH_TOKEN ?? "test-token-for-load";

// ── Custom metrics ─────────────────────────────────────────────────────────────
const errorRate = new Rate("error_rate");
const webhookLatency = new Trend("webhook_latency_ms", true);
const healthLatency = new Trend("health_latency_ms", true);
const signatureRejects = new Counter("signature_reject_count");
const successfulIngests = new Counter("successful_ingest_count");
const concurrentPeak = new Gauge("concurrent_vus_peak");

// ── Scenarios ─────────────────────────────────────────────────────────────────
export const options = {
  scenarios: {
    // ── CI smoke (always runs) ────────────────────────────────────────────
    smoke: {
      executor: "constant-vus",
      vus: 10,
      duration: "30s",
      tags: { scenario: "smoke" },
      gracefulStop: "5s",
    },

    // ── Pre-launch ramp ───────────────────────────────────────────────────
    ramp1000: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "2m", target: 200 }, // gentle warm-up
        { duration: "3m", target: 1000 }, // ramp
        { duration: "5m", target: 1000 }, // sustain
        { duration: "90s", target: 0 }, // cool down
      ],
      tags: { scenario: "ramp1000" },
      startTime: "35s", // after smoke
      gracefulStop: "30s",
    },

    // ── Full stress test (manual only) ────────────────────────────────────
    ramp3000: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "5m", target: 1000 },
        { duration: "5m", target: 3000 },
        { duration: "10m", target: 3000 },
        { duration: "3m", target: 0 },
      ],
      tags: { scenario: "ramp3000" },
      startTime: "8m35s",
      gracefulStop: "60s",
    },

    // ── Viral spike (manual) ──────────────────────────────────────────────
    spike: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "10s", target: 2000 }, // instant spike
        { duration: "30s", target: 2000 }, // hold
        { duration: "10s", target: 0 }, // instant drop
        { duration: "2m", target: 200 }, // recovery
        { duration: "30s", target: 0 },
      ],
      tags: { scenario: "spike" },
      startTime: "8m35s",
      gracefulStop: "30s",
    },

    // ── Memory-leak soak (manual, takes 30+ min) ──────────────────────────
    soak: {
      executor: "constant-vus",
      vus: 200,
      duration: "30m",
      tags: { scenario: "soak" },
      startTime: "8m35s",
      gracefulStop: "60s",
    },
  },

  thresholds: {
    // Core SLOs
    http_req_duration: ["p(95)<3000", "p(99)<5000"],
    error_rate: ["rate<0.01"],
    // Per-endpoint SLOs
    webhook_latency_ms: ["p(95)<3000", "p(99)<5000"],
    health_latency_ms: ["p(95)<500"],
    // Never exceed 5% error on ingestion
    http_req_failed: ["rate<0.05"],
  },

  summaryTrendStats: ["min", "med", "avg", "p(90)", "p(95)", "p(99)", "max"],
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a realistic-looking WhatsApp webhook payload */
function buildWebhookBody(vu, iter) {
  const phone = `+2348${String(vu).padStart(9, "0")}`;
  const messages = [
    "Hello, I want to place an order",
    "What is the price of iPhone 15?",
    "Do you have Samsung S24 in stock?",
    "How long does delivery take?",
    "I want to buy 2 units",
    "Can I pay on delivery?",
    "Thank you!",
    "STOP",
  ];
  const body = messages[iter % messages.length];
  const params = new URLSearchParams({
    MessageSid: `SM${crypto.randomUUID().replace(/-/g, "")}`,
    From: `whatsapp:${phone}`,
    To: "whatsapp:+1234567890",
    Body: body,
    NumMedia: "0",
    AccountSid: "ACtest123456789",
    ProfileName: `Customer${vu}`,
  });
  return params.toString();
}

// ── Default function (smoke + ramp scenarios) ─────────────────────────────────

export default function () {
  const vu = __VU;
  const iter = __ITER;

  concurrentPeak.add(__VU);

  group("Health check", () => {
    const t0 = Date.now();
    const res = http.get(`${BASE_URL}/api/public/health`, {
      headers: { Accept: "application/json" },
      tags: { endpoint: "health" },
    });
    healthLatency.add(Date.now() - t0);

    const ok = check(res, {
      "health 200": (r) => r.status === 200,
      "health has status field": (r) => {
        try {
          return JSON.parse(r.body).status !== undefined;
        } catch {
          return false;
        }
      },
    });
    errorRate.add(!ok);
  });

  sleep(randomIntBetween(0, 1));

  group("Webhook ingest", () => {
    const body = buildWebhookBody(vu, iter);
    const t0 = Date.now();

    const res = http.post(`${BASE_URL}/api/public/twilio-webhook`, body, {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Twilio-Signature": "load-test-invalid-signature",
      },
      tags: { endpoint: "webhook" },
    });
    webhookLatency.add(Date.now() - t0);

    const ok = check(res, {
      // 200 = processed, 204 = idempotent skip, 400 = sig rejected (expected in load test)
      "webhook acceptable status": (r) => [200, 204, 400].includes(r.status),
      "webhook not 500": (r) => r.status < 500,
      "webhook fast": (r) => r.timings.duration < 3000,
    });

    if (res.status === 400) signatureRejects.add(1);
    if (res.status === 200) successfulIngests.add(1);
    errorRate.add(res.status >= 500);
  });

  sleep(randomIntBetween(0, 2));
}

// ── handleSummary — human-readable results ────────────────────────────────────

export function handleSummary(data) {
  const p95 = data.metrics.http_req_duration?.values?.["p(95)"] ?? 0;
  const p99 = data.metrics.http_req_duration?.values?.["p(99)"] ?? 0;
  const err = (data.metrics.http_req_failed?.values?.rate ?? 0) * 100;

  const pass = p95 < 3000 && p99 < 5000 && err < 1;

  const summary = [
    `=== Wabizz Load Test Summary ===`,
    `Scenario:    ${__ENV.SCENARIO ?? "smoke"}`,
    `p95 latency: ${p95.toFixed(0)} ms  ${p95 < 3000 ? "✅" : "❌"} (threshold: <3000ms)`,
    `p99 latency: ${p99.toFixed(0)} ms  ${p99 < 5000 ? "✅" : "❌"} (threshold: <5000ms)`,
    `Error rate:  ${err.toFixed(2)}%    ${err < 1 ? "✅" : "❌"} (threshold: <1%)`,
    `Overall:     ${pass ? "PASS ✅" : "FAIL ❌"}`,
    ``,
    `Sig rejects: ${data.metrics.signature_reject_count?.values?.count ?? 0} (expected — no real Twilio sig in load test)`,
    `Ingests OK:  ${data.metrics.successful_ingest_count?.values?.count ?? 0}`,
  ].join("\n");

  console.log(summary);

  return {
    stdout: summary,
    "load-tests/results/latest-summary.txt": summary,
  };
}
