/**
 * metrics.ts — Central metrics pipeline for Wabizz
 *
 * Tracks:
 *   jobs_created, jobs_processed, jobs_failed, jobs_retried
 *   api_calls_success, api_calls_failed
 *   queue_latency (ms)
 *
 * Storage: Supabase metrics table with 5-minute bucket granularity.
 * Rows older than 7 days are pruned by the scheduled cron.
 *
 * All writes are fire-and-forget — never block the main request path.
 * Failures are logged to stdout only (never throw).
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";

export type MetricName =
  | "jobs_created"
  | "jobs_processed"
  | "jobs_failed"
  | "jobs_retried"
  | "api_calls_success"
  | "api_calls_failed"
  | "queue_latency_ms"
  | "webhook_received"
  | "webhook_duplicate"
  | "messages_sent";

/** Floor a date to the nearest 5-minute bucket */
function _bucket(date = new Date()): string {
  const ms = date.getTime();
  const bucketMs = Math.floor(ms / (5 * 60 * 1000)) * (5 * 60 * 1000);
  return new Date(bucketMs).toISOString();
}

/**
 * Increment a metric counter by `delta` in the current 5-minute bucket.
 * Uses UPSERT so concurrent increments don't create duplicate rows.
 */
export async function increment(metric: MetricName, delta = 1, source?: string): Promise<void> {
  const bucket_at = _bucket();
  try {
    await supabaseAdmin.rpc("increment_metric", {
      p_metric: metric,
      p_delta: delta,
      p_bucket_at: bucket_at,
      p_source: source ?? null,
    });
  } catch {
    // Fallback: plain upsert if RPC doesn't exist yet
    try {
      await supabaseAdmin
        .from("metrics")
        .upsert(
          { metric, value: delta, bucket_at, source: source ?? null },
          { onConflict: "metric,bucket_at,source", ignoreDuplicates: false },
        );
    } catch (e) {
      console.warn("[metrics] increment failed:", String(e));
    }
  }
}

/**
 * Record an external API call outcome (success/fail + latency).
 * Written to api_health_log for the health dashboard chart.
 */
export async function recordApiCall(args: {
  service: "twilio" | "paystack" | "anthropic" | "360dialog" | "meta_whatsapp" | "vitar" | "food_niche";
  success: boolean;
  latencyMs: number;
  statusCode?: number;
  error?: string;
}): Promise<void> {
  try {
    await supabaseAdmin.from("api_health_log").insert({
      service: args.service,
      success: args.success,
      latency_ms: args.latencyMs,
      status_code: args.statusCode,
      error: args.error?.slice(0, 500),
      occurred_at: new Date().toISOString(),
    });
  } catch (e) {
    console.warn("[metrics] recordApiCall failed:", String(e));
  }
  // Also bump the aggregate counter
  void increment(args.success ? "api_calls_success" : "api_calls_failed", 1, args.service);
}

/**
 * Fetch metrics for the dashboard chart (last N hours, by 5-min bucket).
 */
export async function getMetricSeries(
  metric: MetricName,
  hoursBack = 6,
  source?: string,
): Promise<Array<{ bucket_at: string; value: number }>> {
  const since = new Date(Date.now() - hoursBack * 3600 * 1000).toISOString();
  let query = supabaseAdmin
    .from("metrics")
    .select("bucket_at, value")
    .eq("metric", metric)
    .gt("bucket_at", since)
    .order("bucket_at", { ascending: true });

  if (source) query = query.eq("source", source);

  const { data } = await query;
  return (data ?? []) as Array<{ bucket_at: string; value: number }>;
}

/**
 * Get aggregated API health stats for the last N hours.
 */
export async function getApiHealthStats(
  service: "twilio" | "paystack" | "anthropic" | "vitar" | "food_niche",
  hoursBack = 6,
): Promise<{
  successRate: number;
  avgLatencyMs: number;
  totalCalls: number;
  failureSpikes: Array<{ time: string; count: number }>;
}> {
  const since = new Date(Date.now() - hoursBack * 3600 * 1000).toISOString();
  const { data } = await supabaseAdmin
    .from("api_health_log")
    .select("success, latency_ms, occurred_at")
    .eq("service", service)
    .gt("occurred_at", since);

  const rows = data ?? [];
  if (rows.length === 0)
    return { successRate: 100, avgLatencyMs: 0, totalCalls: 0, failureSpikes: [] };

  const successes = rows.filter((r: { success: boolean }) => r.success).length;
  const latencies = rows
    .filter((r: { latency_ms: number | null }) => r.latency_ms != null)
    .map((r: { latency_ms: number }) => r.latency_ms);
  const avgLatencyMs = latencies.length
    ? Math.round(latencies.reduce((a: number, b: number) => a + b, 0) / latencies.length)
    : 0;

  // Failure spikes: count failures per 5-min bucket
  const spikeBuckets = new Map<string, number>();
  for (const row of rows.filter((r: { success: boolean }) => !r.success) as {
    occurred_at: string;
  }[]) {
    const b = _bucket(new Date(row.occurred_at));
    spikeBuckets.set(b, (spikeBuckets.get(b) ?? 0) + 1);
  }
  const failureSpikes = Array.from(spikeBuckets.entries())
    .filter(([, count]) => count >= 2)
    .map(([time, count]) => ({ time, count }))
    .sort((a, b) => b.time.localeCompare(a.time))
    .slice(0, 10);

  return {
    successRate: Math.round((successes / rows.length) * 100),
    avgLatencyMs,
    totalCalls: rows.length,
    failureSpikes,
  };
}

/**
 * Prune stale data — call from scheduled cron.
 * Removes metrics + api_health_log rows older than 7 days.
 */
export async function pruneOldMetrics(): Promise<void> {
  const cutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  await Promise.allSettled([
    supabaseAdmin.from("metrics").delete().lt("bucket_at", cutoff),
    supabaseAdmin.from("api_health_log").delete().lt("occurred_at", cutoff),
    supabaseAdmin
      .from("admin_actions_log")
      .delete()
      .lt(
        "occurred_at",
        new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString(), // 30 days for audit log
      ),
  ]);
}
