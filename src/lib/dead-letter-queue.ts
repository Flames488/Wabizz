/**
 * dead-letter-queue.ts — Persistent store for exhausted jobs
 *
 * v2 changes:
 *   - KV backend REMOVED. DLQ entries go to Supabase only.
 *     (Cloudflare Queues handles its own DLQ routing to WABIZZ_DLQ queue;
 *      this module provides the Supabase-side admin visibility + manual replay.)
 *   - moveToDlq() is now synchronous-first (writes to Supabase, no KV fallback)
 *   - Telegram alert fired immediately on DLQ entry
 *
 * When a job exhausts all retries in the consumer worker:
 *   1. Cloudflare Queues automatically routes the message to WABIZZ_DLQ queue
 *   2. consumer.ts calls moveToDlq() to write a row to dead_letter_jobs table
 *   3. alertDlqJob() fires a Slack + Telegram alert
 *   4. Admin can see + replay the job via /admin → Queue tab
 */

import { logError, logWarn } from "@/lib/server-logger";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { alerts } from "@/lib/server/alerts/alert-engine";
import type { Job } from "@/lib/queue";

export interface DlqEntry {
  jobId: string;
  job: Job;
  failedAt: string;
  lastError: string;
  attempts: number;
}

const DLQ_INSERT_ATTEMPTS = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function insertDlqEntry(entry: DlqEntry): Promise<void> {
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= DLQ_INSERT_ATTEMPTS; attempt++) {
    const { error } = await supabaseAdmin.from("dead_letter_jobs").insert({
      job_id: entry.jobId,
      job_type: entry.job.type,
      payload: entry.job,
      last_error: entry.lastError,
      attempts: entry.attempts,
      failed_at: entry.failedAt,
      request_id: entry.job.requestId,
      status: "pending",
    });

    if (!error) return;
    lastError = error;
    if (attempt < DLQ_INSERT_ATTEMPTS) await sleep(250 * 2 ** (attempt - 1));
  }

  throw lastError;
}

export async function moveToDlq(job: Job, lastError: unknown): Promise<void> {
  const entry: DlqEntry = {
    jobId: job.id,
    job,
    failedAt: new Date().toISOString(),
    lastError: lastError instanceof Error ? lastError.message : String(lastError),
    attempts: job.retryCount + 1,
  };

  logWarn(
    "dead-letter-queue",
    `Job moved to DLQ after ${entry.attempts} attempts: ${job.type}`,
    { jobId: job.id, jobType: job.type, error: entry.lastError },
    job.requestId,
  );

  void alerts.dlqJob(job.id, job.type, job.retryCount + 1, String(lastError));

  try {
    await insertDlqEntry(entry);
  } catch (e) {
    // All DLQ_INSERT_ATTEMPTS retries (with exponential backoff) exhausted.
    // Last resort: structured stdout — captured by Cloudflare logs / Logflare for manual recovery.
    logError(
      "dead-letter-queue",
      `DLQ DB write failed after ${DLQ_INSERT_ATTEMPTS} attempts — job data follows for manual recovery`,
      { entry, error: String(e) },
      job.requestId,
    );
    // Belt-and-suspenders: also dump raw JSON so the full payload survives
    // even if the logger itself has issues.
    console.error(
      JSON.stringify({
        level: "fatal",
        source: "dead-letter-queue",
        message: `DLQ DB write failed after ${DLQ_INSERT_ATTEMPTS} attempts — job data follows for manual recovery`,
        entry,
        error: String(e),
        timestamp: new Date().toISOString(),
      }),
    );
  }
}

export async function listDlqJobs(): Promise<DlqEntry[]> {
  const { data } = await supabaseAdmin
    .from("dead_letter_jobs")
    .select("*")
    .eq("status", "pending")
    .order("failed_at", { ascending: false })
    .limit(100);

  return (data ?? []).map((row) => ({
    jobId: row.job_id as string,
    job: row.payload as Job,
    failedAt: row.failed_at as string,
    lastError: row.last_error as string,
    attempts: row.attempts as number,
  }));
}

export async function acknowledgeDlqJob(jobId: string): Promise<void> {
  await supabaseAdmin
    .from("dead_letter_jobs")
    .update({ status: "acknowledged", acknowledged_at: new Date().toISOString() })
    .eq("job_id", jobId);
}
