/**
 * api.public.scheduled.ts
 *
 * Cloudflare Workers Cron Trigger handler.
 *
 * Registered in wrangler.jsonc:
 *   "triggers": { "crons": ["*\/30 * * * *"] }
 *
 * Fires every 30 minutes. Each run:
 *   - Trial / payment / renewal reminders (deduped via notification_log)
 *   - Webhook stall check + alert
 *   - Error rate check + alert
 *   - Queue backlog check + Telegram alert
 *   - DLQ growth tracking + Telegram alert
 *   - Metrics + api_health_log pruning (rows > 7 days)
 *   - Idempotency key pruning (expired rows removed from Supabase)
 */

import { runScheduledReminders } from "@/lib/server/reminders";
import { logError, logInfo } from "@/lib/server-logger";
import { applySecurityHeaders } from "@/lib/server/security-headers";
import { alertWebhookStall, checkErrorRate } from "@/lib/alerting";
import { getQueueStats } from "@/lib/queue";
import { listDlqJobs } from "@/lib/dead-letter-queue";
import { alerts } from "@/lib/server/alerts/alert-engine";
import { pruneOldMetrics } from "@/lib/server/admin/metrics";
import { seedAdminUser } from "@/lib/server/admin/admin-auth";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { events } from "@/lib/server/event-pipeline";
import { pruneIdempotencyKeys } from "@/lib/server/idempotency";

const DLQ_COUNT_KV_KEY = "scheduled:last_dlq_count";

type EnvWithCacheKv = {
  CACHE_KV?: KVNamespace;
};

// Track DLQ count between runs (in-memory; resets on worker restart — acceptable)
let _lastDlqCount = 0;

async function readLastDlqCount(env?: unknown): Promise<number | null> {
  const kv = (env as EnvWithCacheKv | undefined)?.CACHE_KV;
  if (!kv) return _lastDlqCount;

  const stored = await kv.get(DLQ_COUNT_KV_KEY);
  if (stored === null) return null;

  const count = Number(stored);
  return Number.isFinite(count) ? count : null;
}

async function writeLastDlqCount(count: number, env?: unknown): Promise<void> {
  _lastDlqCount = count;
  const kv = (env as EnvWithCacheKv | undefined)?.CACHE_KV;
  if (kv) await kv.put(DLQ_COUNT_KV_KEY, String(count));
}

async function runMonitoring(env?: unknown): Promise<void> {
  const [queueStats, dlqJobs] = await Promise.all([
    getQueueStats().catch(() => null),
    listDlqJobs().catch(() => []),
  ]);

  if (queueStats) {
    if (queueStats.total > 500) void alerts.queueBacklog(queueStats.total, queueStats.ready);
    events.queueBacklog(queueStats.total, queueStats.ready);
  }

  const currentDlq = dlqJobs.length;
  const previousDlq = await readLastDlqCount(env);
  if (previousDlq !== null && currentDlq > previousDlq + 2) {
    void alerts.dlqGrowth(currentDlq, previousDlq);
    events.dlqGrowth(currentDlq, previousDlq);
  }
  await writeLastDlqCount(currentDlq, env);

  // Refresh materialized conversation stats view
  try {
    await supabaseAdmin.rpc("refresh_conversation_stats");
  } catch {
    /* non-critical */
  }
}

// Cloudflare Workers scheduled event export
export default {
  async scheduled(_event: ScheduledEvent, env: unknown, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      Promise.allSettled([
        runScheduledReminders().catch((e) =>
          logError("scheduled", "Unhandled error in scheduled run", { error: String(e) }),
        ),
        alertWebhookStall().catch(() => undefined),
        checkErrorRate().catch(() => undefined),
        runMonitoring(env).catch(() => undefined),
        pruneOldMetrics().catch(() => undefined),
        pruneIdempotencyKeys().catch(() => undefined),
        seedAdminUser().catch(() => undefined), // idempotent — no-op after first run
      ]),
    );
  },
};

import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/scheduled")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = process.env.CRON_SECRET;
        const provided = request.headers.get("x-cron-secret");

        if (!secret || secret !== provided) {
          return new Response("Unauthorized", { status: 401 });
        }

        const requestId = crypto.randomUUID();
        await logInfo("scheduled", "Manual cron trigger", {}, requestId);

        const start = Date.now();
        // FIX: pruneIdempotencyKeys added — was missing from manual POST handler,
        // causing idempotency table to grow unbounded when triggered manually.
        const results = await Promise.allSettled([
          runScheduledReminders(),
          alertWebhookStall(),
          checkErrorRate(),
          runMonitoring(),
          pruneOldMetrics(),
          pruneIdempotencyKeys(),
        ]);

        const failures = results.filter((result) => result.status === "rejected");
        if (failures.length > 0) {
          await logError(
            "scheduled",
            "Manual cron completed with errors",
            {
              ms: Date.now() - start,
              failures: failures.map((failure) => String(failure.reason)),
            },
            requestId,
          );
        } else {
          await logInfo("scheduled", "Manual cron complete", { ms: Date.now() - start }, requestId);
        }

        return applySecurityHeaders(
          new Response(JSON.stringify({ status: failures.length > 0 ? "partial" : "ok", requestId }), {
            status: failures.length > 0 ? 207 : 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      },
    },
  },
});
