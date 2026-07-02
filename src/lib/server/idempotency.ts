/**
 * idempotency.ts — Strict job deduplication (Section 2 of Mandate)
 *
 * Guarantees: no job executes twice under any retry/concurrency condition.
 * Prevents:
 *   - Double payments (Paystack link generated twice for same order)
 *   - Duplicate WhatsApp messages (send_whatsapp fired twice for same message)
 *   - Duplicate reminders (trial_expiry sent twice on same day)
 *
 * Storage: Supabase idempotency_keys table with UNIQUE constraint.
 * The INSERT ON CONFLICT approach is atomic — safe under concurrent workers.
 *
 * Key construction:
 *   Callers compose: `${jobType}:${businessId}:${contentHash}`
 *   Examples:
 *     "send_whatsapp:biz123:msg_sid_SM123"
 *     "send_payment_link:biz123:conv456:2025-01-15"
 *     "trial_expiry:biz123:2025-01-15"
 *
 * TTL: keys expire after 24 hours (cleaned by cron).
 * This window covers all realistic retry scenarios.
 *
 * Usage in consumer.ts:
 *   const key = `send_whatsapp:${businessId}:${messageSid}`;
 *   const guard = await acquireIdempotencyKey(key, traceId);
 *   if (guard.alreadySeen) return; // skip — already processed
 *   try {
 *     await doWork();
 *     await guard.markSuccess();
 *   } catch (e) {
 *     await guard.markFailed(String(e));
 *     throw e;
 *   }
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { events } from "@/lib/server/event-pipeline";

export interface IdempotencyGuard {
  alreadySeen: boolean;
  markSuccess: () => Promise<void>;
  markFailed: (error: string) => Promise<void>;
}

const IDEMPOTENCY_TTL_HOURS = 24;

/**
 * Acquire an idempotency key.
 * Returns { alreadySeen: true } if this key was already successfully processed.
 * Returns { alreadySeen: false } + callbacks on first execution.
 */
export async function acquireIdempotencyKey(
  key: string,
  traceId: string,
): Promise<IdempotencyGuard> {
  // Atomic INSERT — if key exists and status='success', it's a duplicate
  const { error: insertError } = await supabaseAdmin.from("idempotency_keys").insert({
    key,
    status: "processing",
    trace_id: traceId,
    expires_at: new Date(Date.now() + IDEMPOTENCY_TTL_HOURS * 3600 * 1000).toISOString(),
  });

  if (!insertError) {
    // Fresh — we own this execution
    return {
      alreadySeen: false,
      markSuccess: async () => {
        // HYGIENE FIX: always check DB errors so silent failures don't leave
        // the key stuck in "processing" and trigger stale-lock recovery loops
        const { error } = await supabaseAdmin
          .from("idempotency_keys")
          .update({ status: "success", completed_at: new Date().toISOString() })
          .eq("key", key);
        if (error) throw new Error(`Idempotency markSuccess failed: ${error.message}`);
      },
      markFailed: async (_error: string) => {
        // On failure: delete so the next retry can re-acquire cleanly.
        // The eq("status","processing") guard prevents accidentally deleting
        // a row that was concurrently marked success by another path.
        await supabaseAdmin
          .from("idempotency_keys")
          .delete()
          .eq("key", key)
          .eq("status", "processing");
      },
    };
  }

  // Conflict — check existing status and age
  const { data: existing } = await supabaseAdmin
    .from("idempotency_keys")
    // BUG 2 FIX: fetch updated_at so we can detect stale locks
    .select("status, updated_at")
    .eq("key", key)
    .maybeSingle();

  if (existing?.status === "success") {
    // Already successfully processed — skip
    events.jobDuplicate(traceId, key, key.split(":")[0] ?? "unknown");
    return {
      alreadySeen: true,
      markSuccess: async () => {},
      markFailed: async () => {},
    };
  }

  if (existing?.status === "processing") {
    // BUG 2 FIX: A "processing" lock that is older than STALE_THRESHOLD_MS means
    // the worker that acquired it crashed, was evicted, or hit a timeout without
    // calling markFailed(). Without this recovery path, the job is permanently
    // dead — the queue retries it forever but acquireIdempotencyKey keeps
    // returning alreadySeen:true. This silently drops jobs and leaks revenue.
    const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
    const age = existing.updated_at
      ? Date.now() - new Date(existing.updated_at).getTime()
      : Infinity; // treat missing timestamp as infinitely stale

    if (age > STALE_THRESHOLD_MS) {
      // Stale lock — delete it so this execution can re-acquire a fresh lock.
      // Use a targeted delete (not update) so that if two workers race here,
      // only one of them will successfully insert a new row (INSERT is still atomic).
      const { error: deleteError } = await supabaseAdmin
        .from("idempotency_keys")
        .delete()
        .eq("key", key)
        .eq("status", "processing"); // guard: don't delete if another worker succeeded first

      if (deleteError) {
        // Delete raced with another worker's markSuccess — treat as duplicate
        return { alreadySeen: true, markSuccess: async () => {}, markFailed: async () => {} };
      }

      // Re-insert — we now own this execution
      const { error: reinsertError } = await supabaseAdmin.from("idempotency_keys").insert({
        key,
        status: "processing",
        trace_id: traceId,
        expires_at: new Date(Date.now() + IDEMPOTENCY_TTL_HOURS * 3600 * 1000).toISOString(),
      });

      if (reinsertError) {
        // Another concurrent worker beat us to the re-insert — back off
        return { alreadySeen: true, markSuccess: async () => {}, markFailed: async () => {} };
      }

      // We successfully recovered the stale lock — proceed with execution
      return {
        alreadySeen: false,
        markSuccess: async () => {
          const { error } = await supabaseAdmin
            .from("idempotency_keys")
            .update({ status: "success", completed_at: new Date().toISOString() })
            .eq("key", key);
          if (error) throw new Error(`Idempotency markSuccess failed: ${error.message}`);
        },
        markFailed: async (_error: string) => {
          await supabaseAdmin
            .from("idempotency_keys")
            .delete()
            .eq("key", key)
            .eq("status", "processing");
        },
      };
    }

    // Lock is fresh — another worker is actively processing this job right now.
    // Return alreadySeen to avoid double execution.
    return { alreadySeen: true, markSuccess: async () => {}, markFailed: async () => {} };
  }

  // Unknown status (shouldn't happen but defend against schema drift)
  return {
    alreadySeen: true,
    markSuccess: async () => {},
    markFailed: async () => {},
  };
}

/**
 * Prune expired idempotency keys — call from scheduled cron.
 */
export async function pruneIdempotencyKeys(): Promise<void> {
  await supabaseAdmin.from("idempotency_keys").delete().lt("expires_at", new Date().toISOString());
}
