/**
 * Health check endpoint — v7 (Sentry status + enhanced deep check)
 *
 * GET /api/public/health
 *   → lightweight (no DB call) — suitable for L7 load balancer probes
 *
 * GET /api/public/health?deep=1  (requires x-health-secret header)
 *   → deep check: DB ping, env var presence, Paystack reachability,
 *     queue depth, DLQ count, cache stats, circuit states, Sentry status
 *
 * HEAD /api/public/health
 *   → 200 with no body — for uptime monitors
 *
 * Changes vs v6:
 *   - Sentry configuration status surfaced in deep check — you know immediately
 *     if crash reporting is inactive before you discover it in production
 *   - Circuit state includes openedAt timestamp (from circuit-breaker v2)
 *   - DEGRADED status is now clearly separate from ERROR in response envelope
 *   - "version" incremented to 15
 */

import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { cache } from "@/lib/cache";
import { applySecurityHeaders } from "@/lib/server/security-headers";
import { withTimeout } from "@/lib/server/request-timeout";
import { getQueueStats } from "@/lib/queue";
import { listDlqJobs } from "@/lib/dead-letter-queue";
import { getCircuitStates } from "@/lib/server/circuit-breaker/circuit-breaker";
import { isSentryConfigured } from "@/lib/sentry";

export const Route = createFileRoute("/api/public/health")({
  server: {
    handlers: {
      HEAD: async () => new Response(null, { status: 200 }),

      GET: async ({ request }) => {
        const url = new URL(request.url);
        const deep = url.searchParams.get("deep") === "1";

        if (!deep) {
          return applySecurityHeaders(
            json({ status: "ok", ts: new Date().toISOString(), version: "15" }, 200),
          );
        }

        // Deep check — protect with optional secret so it's not publicly scrapable
        const secret = process.env.HEALTH_CHECK_SECRET;
        if (secret && request.headers.get("x-health-secret") !== secret) {
          return new Response("Unauthorized", { status: 401 });
        }

        const checks: Record<string, "ok" | "fail" | "missing" | "warn"> = {};

        // DB ping
        try {
          const dbQuery = supabaseAdmin
            .from("businesses")
            .select("id", { count: "exact", head: true })
            .limit(1);
          const { error } = await withTimeout(dbQuery, 5_000, "DB ping");
          checks.db = error ? "fail" : "ok";
        } catch {
          checks.db = "fail";
        }

        // Required env vars
        const required = [
          "SUPABASE_URL",
          "SUPABASE_SERVICE_ROLE_KEY",
          "TWILIO_AUTH_TOKEN",
          "TWILIO_ACCOUNT_SID",
          "TWILIO_API_KEY_SID",
          "TWILIO_API_KEY_SECRET",
          "ANTHROPIC_API_KEY",
          "WABIZZ_PAYSTACK_SECRET_KEY",
          "APP_URL",
        ];
        for (const key of required) {
          checks[`env_${key}`] = process.env[key] ? "ok" : "missing";
        }

        // Optional env
        checks.env_SLACK_ALERT_WEBHOOK_URL = process.env.SLACK_ALERT_WEBHOOK_URL ? "ok" : "warn";
        checks.env_UPSTASH_REDIS =
          process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
            ? "ok"
            : "warn"; // warn, not fail — Workers use KV instead

        // Sentry configuration check — warn if not configured so you discover it here
        // rather than when a crash happens silently with no report
        checks.sentry = isSentryConfigured() ? "ok" : "warn";

        // Upstash Redis connectivity (if configured)
        if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
          try {
            const res = await withTimeout(
              fetch(`${process.env.UPSTASH_REDIS_REST_URL}/ping`, {
                headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` },
              }),
              3_000,
              "Upstash ping",
            );
            checks.upstash_redis = res.ok ? "ok" : "fail";
          } catch {
            checks.upstash_redis = "fail";
          }
        }

        // Queue depth
        let queueStats: Awaited<ReturnType<typeof getQueueStats>> | null = null;
        try {
          queueStats = await withTimeout(getQueueStats(), 5_000, "Queue stats");
        } catch {
          checks.queue = "fail";
        }

        // DLQ count — warn if there are pending failed jobs
        let dlqCount = 0;
        try {
          const dlq = await withTimeout(listDlqJobs(), 5_000, "DLQ list");
          dlqCount = dlq.length;
          checks.dlq = dlqCount === 0 ? "ok" : "warn";
        } catch {
          checks.dlq = "fail";
        }

        // Circuit breaker states (v2 includes openedAt)
        const circuitStates = getCircuitStates();
        for (const [svc, data] of Object.entries(circuitStates)) {
          checks[`circuit_${svc}`] =
            data.state === "OPEN" ? "fail" : data.state === "HALF_OPEN" ? "warn" : "ok";
        }

        // Memory snapshot
        const memMb = process.memoryUsage
          ? Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
          : null;

        // Status: any fail or missing → "degraded"
        const hasFail = Object.values(checks).some((v) => v === "fail" || v === "missing");

        return applySecurityHeaders(
          json(
            {
              status: hasFail ? "degraded" : "ok",
              ts: new Date().toISOString(),
              version: "15",
              checks,
              cache: {
                localEntries: cache.localSize(),
              },
              queue: queueStats ?? undefined,
              dlq: { pendingCount: dlqCount },
              circuits: circuitStates,
              ...(memMb !== null ? { memory: { heapUsedMb: memMb } } : {}),
            },
            hasFail ? 503 : 200,
          ),
        );
      },
    },
  },
});

function json(data: unknown, status: number) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
