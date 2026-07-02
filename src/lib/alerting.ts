/**
 * alerting.ts — Thin shim over the unified alert engine
 *
 * All alert logic now lives in src/lib/server/alerts/alert-engine.ts.
 * This file re-exports the convenience wrappers so existing callers
 * (scheduled.ts, dead-letter-queue.ts, circuit-breaker.ts) don't need
 * to change their import paths.
 *
 * Features now handled by alert-engine.ts:
 *   ✅ Alert aggregation (group similar errors in 2-min windows)
 *   ✅ Severity levels: info / warning / critical
 *   ✅ Anti-spam cooldowns (info: 4h, warning: 1h, critical: 15min)
 *   ✅ Auto-remediation for critical alerts
 *   ✅ Telegram + Slack dual delivery
 *   ✅ Persisted alert history in Supabase
 */

import { alerts, alert } from "@/lib/server/alerts/alert-engine";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Job } from "@/lib/queue";

export { alert, alerts };

/** Legacy: called by dead-letter-queue.ts */
export async function alertDlqJob(job: Job, lastError: unknown): Promise<void> {
  void alerts.dlqJob(job.id, job.type, job.retryCount + 1, String(lastError));
}

/** Legacy: called by scheduled cron */
export async function alertWebhookStall(): Promise<void> {
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const { data: stalled } = await supabaseAdmin
    .from("webhook_events")
    .select("id, event_id, source, received_at")
    .eq("status", "processing")
    .lt("received_at", fiveMinAgo)
    .limit(10);

  if (!stalled?.length) return;
  void alerts.webhookStall(
    stalled.length,
    stalled as Array<{ source: string; event_id: string; received_at: string }>,
  );
}

/** Legacy: called by scheduled cron */
export async function checkErrorRate(): Promise<void> {
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const { data: logs } = await supabaseAdmin
    .from("error_logs")
    .select("source")
    .in("level", ["error", "fatal"])
    .gt("occurred_at", fiveMinAgo);

  if (!logs?.length) return;

  const counts = new Map<string, number>();
  for (const row of logs as { source: string }[]) {
    counts.set(row.source, (counts.get(row.source) ?? 0) + 1);
  }
  for (const [, count] of counts) {
    if (count >= 10) {
      const total = [...counts.values()].reduce((a, b) => a + b, 0);
      void alerts.failureRate(Math.round((count / total) * 100), count, total);
    }
  }
}
