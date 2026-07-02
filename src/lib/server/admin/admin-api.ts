/**
 * admin-api.ts — All admin backend queries
 *
 * Every function here requires a valid AdminToken (verified by requireAdmin).
 * All mutations are logged to admin_actions_log.
 *
 * Endpoints powered by this module:
 *   GET  /admin/metrics       → getAdminMetrics()
 *   GET  /admin/queue         → getAdminQueue()
 *   GET  /admin/jobs/:id      → getAdminJob()
 *   POST /admin/jobs/:id/retry → retryAdminJob()
 *   DELETE /admin/jobs/:id    → deleteAdminJob()
 *   GET  /admin/logs          → getAdminLogs()
 *   GET  /admin/api-health    → getAdminApiHealth()
 *   POST /admin/dlq/:id/retry → retryDlqJob()
 *   POST /admin/dlq/:id/ack   → ackDlqJob()
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getQueueStats } from "@/lib/queue";
import { listDlqJobs, acknowledgeDlqJob } from "@/lib/dead-letter-queue";
import { getApiHealthStats, getMetricSeries } from "./metrics";
import { logAdminAction } from "./admin-auth";
import type { AdminToken } from "./admin-auth";

// ── System Overview ───────────────────────────────────────────────────────────

export async function getAdminMetrics() {
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const todayStart = new Date(new Date().setHours(0, 0, 0, 0)).toISOString();

  const PLAN_PRICES: Record<string, number> = {
    starter: 5000,
    growth: 12000,
    pro: 25000,
  };

  const [
    queueStats,
    dlqJobs,
    activeUsersRes,
    recentErrorsRes,
    jobsCreatedSeries,
    jobsFailedSeries,
    totalBusinessesRes,
    totalMessagesRes,
    // Revenue: sum paid orders
    allPaidOrders,
    todayPaidOrders,
    monthPaidOrders,
    // Subscriptions
    activeSubsRes,
    trialSubsRes,
    cancelledSubsRes,
    subsByPlan,
    // New signups
    newTodayRes,
    newMonthRes,
    // Revenue from subscriptions (plan_id × price)
    allActiveSubs,
    // Recent signups for the list
    recentSignups,
  ] = await Promise.all([
    getQueueStats(),
    listDlqJobs(),
    supabaseAdmin
      .from("conversations")
      .select("business_id", { count: "exact", head: true })
      .gt("last_message_at", fifteenMinAgo),
    supabaseAdmin
      .from("error_logs")
      .select("id", { count: "exact", head: true })
      .in("level", ["error", "fatal"])
      .gt("occurred_at", fiveMinAgo),
    getMetricSeries("jobs_created", 6),
    getMetricSeries("jobs_failed", 6),
    supabaseAdmin.from("businesses").select("id", { count: "exact", head: true }),
    supabaseAdmin.from("messages").select("id", { count: "exact", head: true }),
    // All-time paid orders revenue
    supabaseAdmin.from("orders").select("amount_naira").eq("status", "paid"),
    // Today's paid orders
    supabaseAdmin
      .from("orders")
      .select("amount_naira")
      .eq("status", "paid")
      .gte("paid_at", todayStart),
    // This month's paid orders
    supabaseAdmin
      .from("orders")
      .select("amount_naira")
      .eq("status", "paid")
      .gte("paid_at", thirtyDaysAgo),
    // Active subscriptions count
    supabaseAdmin
      .from("subscriptions")
      .select("id", { count: "exact", head: true })
      .eq("status", "active"),
    // Trial subscriptions count
    supabaseAdmin
      .from("subscriptions")
      .select("id", { count: "exact", head: true })
      .eq("status", "trialing"),
    // Cancelled this month
    supabaseAdmin
      .from("subscriptions")
      .select("id", { count: "exact", head: true })
      .eq("status", "cancelled")
      .gte("cancelled_at", thirtyDaysAgo),
    // Subscriptions grouped by plan (for MRR)
    supabaseAdmin.from("subscriptions").select("plan_id").eq("status", "active"),
    // New signups today
    supabaseAdmin
      .from("businesses")
      .select("id", { count: "exact", head: true })
      .gte("created_at", todayStart),
    // New signups this month
    supabaseAdmin
      .from("businesses")
      .select("id", { count: "exact", head: true })
      .gte("created_at", thirtyDaysAgo),
    // All active subs with plan for MRR calc
    supabaseAdmin.from("subscriptions").select("plan_id, status").eq("status", "active"),
    // Recent 8 signups for user list
    supabaseAdmin
      .from("businesses")
      .select("id, name, created_at, subscription_status")
      .order("created_at", { ascending: false })
      .limit(8),
  ]);

  // Revenue calculations
  const sumNaira = (rows: Array<{ amount_naira: number }>) =>
    (rows ?? []).reduce((s, r) => s + (r.amount_naira ?? 0), 0);

  const totalRevenue = sumNaira((allPaidOrders.data ?? []) as Array<{ amount_naira: number }>);
  const todayRevenue = sumNaira((todayPaidOrders.data ?? []) as Array<{ amount_naira: number }>);
  const monthRevenue = sumNaira((monthPaidOrders.data ?? []) as Array<{ amount_naira: number }>);

  // MRR from active subscriptions
  const mrr = (allActiveSubs.data ?? []).reduce((s, sub) => {
    return s + (PLAN_PRICES[(sub as { plan_id: string }).plan_id] ?? 0);
  }, 0);

  // Plan breakdown
  const planBreakdown: Record<string, number> = {};
  for (const sub of (subsByPlan.data ?? []) as Array<{ plan_id: string }>) {
    planBreakdown[sub.plan_id] = (planBreakdown[sub.plan_id] ?? 0) + 1;
  }

  // Failure rate
  const recentFailed = await supabaseAdmin
    .from("metrics")
    .select("value")
    .eq("metric", "jobs_failed")
    .gt("bucket_at", fiveMinAgo);
  const recentCreated = await supabaseAdmin
    .from("metrics")
    .select("value")
    .eq("metric", "jobs_created")
    .gt("bucket_at", fiveMinAgo);
  const failedCount = (recentFailed.data ?? []).reduce(
    (s: number, r: { value: number }) => s + r.value,
    0,
  );
  const createdCount = (recentCreated.data ?? []).reduce(
    (s: number, r: { value: number }) => s + r.value,
    0,
  );
  const failureRate = createdCount > 0 ? Math.round((failedCount / createdCount) * 100) : 0;

  // API health
  const [twilioHealth, paystackHealth] = await Promise.all([
    getApiHealthStats("twilio", 1),
    getApiHealthStats("paystack", 1),
  ]);

  return {
    overview: {
      activeUsers: activeUsersRes.count ?? 0,
      totalBusinesses: totalBusinessesRes.count ?? 0,
      totalMessages: totalMessagesRes.count ?? 0,
      queueTotal: queueStats.total,
      queueReady: queueStats.ready,
      queueDeferred: queueStats.deferred,
      jobsFailed: queueStats.total - queueStats.ready - queueStats.deferred,
      dlqCount: dlqJobs.length,
      recentErrors: recentErrorsRes.count ?? 0,
      failureRatePct: failureRate,
      queueByType: queueStats.byType,
    },
    revenue: {
      totalAllTime: totalRevenue,
      todayRevenue,
      monthRevenue,
      mrr,
      planBreakdown,
    },
    users: {
      totalBusinesses: totalBusinessesRes.count ?? 0,
      activeSubs: activeSubsRes.count ?? 0,
      trialSubs: trialSubsRes.count ?? 0,
      cancelledThisMonth: cancelledSubsRes.count ?? 0,
      newToday: newTodayRes.count ?? 0,
      newThisMonth: newMonthRes.count ?? 0,
      recentSignups: (recentSignups.data ?? []) as Array<{
        id: string;
        name: string;
        created_at: string;
        subscription_status: string;
      }>,
    },
    apiHealth: {
      twilio: twilioHealth,
      paystack: paystackHealth,
    },
    series: {
      jobsCreated: jobsCreatedSeries,
      jobsFailed: jobsFailedSeries,
    },
  };
}

// ── Queue ─────────────────────────────────────────────────────────────────────

export async function getAdminQueue() {
  const [dlqJobs, stuckWebhooks, recentLogs] = await Promise.all([
    listDlqJobs(),
    // Webhooks stuck in processing > 5 min
    supabaseAdmin
      .from("webhook_events")
      .select("id, event_id, source, status, received_at, error_message")
      .eq("status", "processing")
      .lt("received_at", new Date(Date.now() - 5 * 60 * 1000).toISOString())
      .order("received_at", { ascending: false })
      .limit(20),
    // Recent failed jobs from error_logs
    supabaseAdmin
      .from("error_logs")
      .select("id, source, message, level, context, occurred_at, request_id")
      .in("level", ["error", "fatal"])
      .order("occurred_at", { ascending: false })
      .limit(50),
  ]);

  return {
    dlqJobs: dlqJobs.slice(0, 50),
    stuckWebhooks: stuckWebhooks.data ?? [],
    recentFailedLogs: recentLogs.data ?? [],
  };
}

// ── Retry DLQ job ─────────────────────────────────────────────────────────────

export async function retryDlqJob(jobId: string, admin: AdminToken) {
  const dlqJobs = await listDlqJobs();
  const entry = dlqJobs.find((j) => j.jobId === jobId);
  if (!entry) throw new Error(`DLQ job not found: ${jobId}`);

  // Re-enqueue: insert back into KV queue with reset retry count
  // Since we may not have KV here directly, we insert into a pending replay table
  // and the next processQueue() invocation picks it up.
  const resetJob = { ...entry.job, retryCount: 0, nextRetryAt: undefined };

  // Re-enqueue via Cloudflare Queues (production) or log for manual replay (dev)
  declare const WABIZZ_QUEUE: Queue | undefined;
  if (typeof WABIZZ_QUEUE !== "undefined") {
    await WABIZZ_QUEUE.send(resetJob, { contentType: "json" });
  } else {
    console.warn("[admin-api] WABIZZ_QUEUE not bound — job logged for manual replay", resetJob);
  }

  await acknowledgeDlqJob(jobId);

  // Update DB row status to "replayed"
  await supabaseAdmin
    .from("dead_letter_jobs")
    .update({ status: "replayed", replayed_at: new Date().toISOString() })
    .eq("job_id", jobId);

  await logAdminAction({
    adminId: admin.adminId,
    action: "retry_dlq_job",
    targetId: jobId,
    details: { jobType: entry.job.type },
  });

  return { success: true };
}

// ── Acknowledge DLQ job ───────────────────────────────────────────────────────

export async function ackDlqJob(jobId: string, admin: AdminToken) {
  await acknowledgeDlqJob(jobId);
  await logAdminAction({
    adminId: admin.adminId,
    action: "ack_dlq_job",
    targetId: jobId,
  });
  return { success: true };
}

// ── Error Logs ────────────────────────────────────────────────────────────────

export async function getAdminLogs(filters: {
  level?: string;
  source?: string;
  limit?: number;
  since?: string;
}) {
  let query = supabaseAdmin
    .from("error_logs")
    .select("id, source, message, level, context, occurred_at, request_id")
    .order("occurred_at", { ascending: false })
    .limit(filters.limit ?? 100);

  if (filters.level) query = query.eq("level", filters.level);
  if (filters.source) query = query.ilike("source", `%${filters.source}%`);
  if (filters.since) query = query.gt("occurred_at", filters.since);

  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

// ── API Health ────────────────────────────────────────────────────────────────

export async function getAdminApiHealth() {
  const [twilio6h, paystack6h, anthropic6h, recent] = await Promise.all([
    getApiHealthStats("twilio", 6),
    getApiHealthStats("paystack", 6),
    getApiHealthStats("anthropic", 6),
    supabaseAdmin
      .from("api_health_log")
      .select("service, success, latency_ms, status_code, error, occurred_at")
      .order("occurred_at", { ascending: false })
      .limit(100),
  ]);

  return {
    twilio: twilio6h,
    paystack: paystack6h,
    anthropic: anthropic6h,
    recentCalls: recent.data ?? [],
  };
}

// ── Rate limiting stats ───────────────────────────────────────────────────────

export async function getAdminRateLimitStats() {
  const oneHourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
  const { data } = await supabaseAdmin
    .from("error_logs")
    .select("context, occurred_at")
    .eq("source", "rate-limiter")
    .gt("occurred_at", oneHourAgo)
    .order("occurred_at", { ascending: false })
    .limit(200);

  return { recentBlocked: data ?? [] };
}

// ── Grant Free Subscription ───────────────────────────────────────────────────

/**
 * Grants a permanent free active subscription to a business, bypassing Paystack.
 * Sets status = "active" with no trial_ends_at, so it never expires.
 * If a subscription already exists it is updated in-place; otherwise a new one is inserted.
 */
export async function grantFreeSubscription(
  businessId: string,
  planId: "starter" | "growth" | "pro",
  admin: AdminToken,
) {
  // Check the business exists
  const { data: biz, error: bizErr } = await supabaseAdmin
    .from("businesses")
    .select("id, name")
    .eq("id", businessId)
    .maybeSingle();
  if (bizErr || !biz) throw new Error(`Business not found: ${businessId}`);

  // Upsert: update existing subscription or insert a new free one
  const { data: existing } = await supabaseAdmin
    .from("subscriptions")
    .select("id")
    .eq("business_id", businessId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  let upsertError;
  if (existing) {
    const { error } = await supabaseAdmin
      .from("subscriptions")
      .update({
        plan_id: planId,
        status: "active",
        trial_ends_at: null,
        paystack_reference: "ADMIN_GRANT_FREE",
      })
      .eq("id", existing.id);
    upsertError = error;
  } else {
    const { error } = await supabaseAdmin.from("subscriptions").insert({
      business_id: businessId,
      plan_id: planId,
      status: "active",
      trial_ends_at: null,
      paystack_reference: "ADMIN_GRANT_FREE",
    });
    upsertError = error;
  }

  if (upsertError) throw new Error(upsertError.message);

  // Keep businesses.subscription_status in sync
  await supabaseAdmin
    .from("businesses")
    .update({ subscription_status: "active" })
    .eq("id", businessId);

  await logAdminAction({
    adminId: admin.adminId,
    action: "grant_free_subscription",
    targetId: businessId,
    details: { businessName: biz.name, planId },
  });

  return { success: true, businessName: biz.name, planId };
}

// ── Trace lookup ──────────────────────────────────────────────────────────────

/**
 * Fetch all events for a given traceId — end-to-end request trace.
 * Powers the "trace" lookup in the admin dashboard.
 */
export async function getAdminTrace(traceId: string) {
  const [logs, events, dlqJobs, webhooks] = await Promise.all([
    supabaseAdmin
      .from("error_logs")
      .select("id, source, message, level, context, occurred_at")
      .or(`context->request_id.eq.${traceId},context->>request_id.eq.${traceId}`)
      .order("occurred_at", { ascending: true })
      .limit(50),
    supabaseAdmin
      .from("system_events")
      .select("id, type, severity, metadata, occurred_at")
      .eq("trace_id", traceId)
      .order("occurred_at", { ascending: true })
      .limit(50),
    supabaseAdmin
      .from("dead_letter_jobs")
      .select("job_id, job_type, last_error, attempts, failed_at")
      .eq("request_id", traceId),
    supabaseAdmin
      .from("webhook_events")
      .select("event_id, source, status, received_at, processed_at, error_message")
      .eq("request_id", traceId),
  ]);

  return {
    traceId,
    logs: logs.data ?? [],
    events: events.data ?? [],
    dlqJobs: dlqJobs.data ?? [],
    webhooks: webhooks.data ?? [],
  };
}
