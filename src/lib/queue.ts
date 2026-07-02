/**
 * queue.ts — v5 (campaign batch job type added)
 *
 * Changes vs v4:
 *   - send_campaign_batch job type: autonomous bulk WhatsApp campaign delivery
 *   - send_automation_step job type: keyword-triggered auto-reply sequences
 *   - Both new job types honour queue partitioning (userId = businessId)
 *   - explicitContactIds optional override for pause/resume scenarios
 *
 * Partitioning strategy (unchanged from v4):
 *   Jobs keyed by userId — one tenant's failures don't block other tenants.
 *   For Stage 2 (3k-5k users): create wabizz-jobs-0..7 and route via hash(userId)%8.
 */

import { logError, logInfo } from "@/lib/server-logger";
import { events } from "@/lib/server/event-pipeline";

declare const WABIZZ_QUEUE_0: Queue | undefined;
declare const WABIZZ_QUEUE_1: Queue | undefined;
declare const WABIZZ_QUEUE_2: Queue | undefined;
declare const WABIZZ_QUEUE_3: Queue | undefined;
declare const WABIZZ_QUEUE_4: Queue | undefined;
declare const WABIZZ_QUEUE_5: Queue | undefined;
declare const WABIZZ_QUEUE_6: Queue | undefined;
declare const WABIZZ_QUEUE_7: Queue | undefined;

let _queueBindingValidation: Queue[] | null | undefined = undefined;

function _queueBindings(): Array<Queue | undefined> {
  return [
    typeof WABIZZ_QUEUE_0 !== "undefined" ? WABIZZ_QUEUE_0 : undefined,
    typeof WABIZZ_QUEUE_1 !== "undefined" ? WABIZZ_QUEUE_1 : undefined,
    typeof WABIZZ_QUEUE_2 !== "undefined" ? WABIZZ_QUEUE_2 : undefined,
    typeof WABIZZ_QUEUE_3 !== "undefined" ? WABIZZ_QUEUE_3 : undefined,
    typeof WABIZZ_QUEUE_4 !== "undefined" ? WABIZZ_QUEUE_4 : undefined,
    typeof WABIZZ_QUEUE_5 !== "undefined" ? WABIZZ_QUEUE_5 : undefined,
    typeof WABIZZ_QUEUE_6 !== "undefined" ? WABIZZ_QUEUE_6 : undefined,
    typeof WABIZZ_QUEUE_7 !== "undefined" ? WABIZZ_QUEUE_7 : undefined,
  ];
}

function _assertQueueBindings(): Queue[] | null {
  if (_queueBindingValidation !== undefined) return _queueBindingValidation;

  const queues = _queueBindings();
  const present = queues.filter((queue): queue is Queue => Boolean(queue));
  if (present.length === 0) {
    _queueBindingValidation = null;
    return null;
  }

  if (present.length !== queues.length) {
    const missing = queues
      .map((queue, index) => (queue ? null : `WABIZZ_QUEUE_${index}`))
      .filter((binding): binding is string => binding !== null);
    throw new Error(`Missing Cloudflare Queue binding(s): ${missing.join(", ")}`);
  }

  _queueBindingValidation = present;
  return present;
}

/**
 * Fix 10 — Queue partitioning.
 * Routes jobs to one of 8 queues by hash(userId) % 8 so one tenant's
 * bulk campaign cannot block real-time webhook replies for other businesses.
 * Falls back to queue 0 when userId is absent (e.g. log_event jobs).
 */
function _selectQueue(queues: Queue[], userId?: string): Queue {
  if (!userId) return queues[0];
  // FNV-1a hash of userId, then modulo 8
  let h = 0x811c9dc5;
  for (let i = 0; i < userId.length; i++) {
    h ^= userId.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return queues[h % 8];
}

export type JobType =
  | "send_whatsapp"
  | "send_meta_whatsapp"
  | "send_payment_link"
  | "send_reminder"
  | "log_event"
  | "send_campaign_batch"
  | "send_automation_step"
  | "retry_claude_reply";

export interface BaseJob {
  id: string;
  type: JobType;
  createdAt: string;
  retryCount: number;
  requestId: string;
  userId?: string;
}

export interface SendWhatsAppJob extends BaseJob {
  type: "send_whatsapp";
  // BUG 4 FIX: apiKey removed from payload. Secrets must never exist in queues,
  // logs, or dead-letter tables — a compromised queue dump would expose all
  // customer WhatsApp credentials. businessId is used by the consumer to fetch
  // the credential from Vault at execution time, on the secure worker side.
  payload: {
    businessId: string; // consumer fetches apiKey from Vault using this
    to: string;
    text: string;
  };
}


export interface SendMetaWhatsAppJob extends BaseJob {
  type: "send_meta_whatsapp";
  payload: {
    businessId: string;
    /** Meta phone_number_id — used in Graph API calls */
    phoneNumberId: string;
    /** Recipient E.164 number (with or without +) */
    to: string;
    text: string;
  };
}

export interface SendPaymentLinkJob extends BaseJob {
  type: "send_payment_link";
  payload: {
    businessId: string;
    customerNumber: string;
    amountNaira: number;
    conversationId: string;
  };
}

export interface SendReminderJob extends BaseJob {
  type: "send_reminder";
  payload: {
    reminderType: "trial_expiry" | "overdue_payment" | "subscription_renewal";
    businessId: string;
  };
}

export interface LogEventJob extends BaseJob {
  type: "log_event";
  payload: {
    source: string;
    message: string;
    level: "info" | "warn" | "error";
    context: Record<string, unknown>;
  };
}

/**
 * send_campaign_batch — processes one batch of contacts in a campaign.
 *
 * The consumer fetches the actual campaign_contacts rows from Supabase
 * using batchIndex + batchSize, so the payload stays small.
 * The WhatsApp API key is retrieved server-side from Vault — never stored here.
 */
export interface SendCampaignBatchJob extends BaseJob {
  type: "send_campaign_batch";
  payload: {
    campaignId: string;
    businessId: string;
    batchIndex: number;
    batchSize: number;
    messageTemplate: string; // supports {{name}} merge tag
    messagesPerMin: number; // rate limit for this campaign
    explicitContactIds?: string[]; // campaign_contact IDs to process (resume scenario)
  };
}

/**
 * send_automation_step — fire an automated reply triggered by a keyword.
 */
export interface SendAutomationStepJob extends BaseJob {
  type: "send_automation_step";
  payload: {
    businessId: string;
    ruleId: string;
    contactPhone: string;
    contactName?: string;
    replyTemplate: string;
    addTags?: string[];
  };
}

/**
 * retry_claude_reply — Re-runs the full AI reply flow after a 429 rate-limit.
 *
 * Enqueued by the twilio-webhook when Anthropic returns 429 and all retries
 * are exhausted. The consumer re-runs handleIncomingMessage with the stored
 * conversation history and sends the reply via WhatsApp once capacity returns.
 * Idempotency key: retry_claude:<conversationId>:<messageSid>
 */
export interface RetryClaudeReplyJob extends BaseJob {
  type: "retry_claude_reply";
  payload: {
    businessId: string;
    conversationId: string;
    customerPhone: string;
    customerNumber: string; // E.164, with whatsapp: prefix for Twilio
    text: string; // original customer message
    messageSid: string;
    requestId: string;
  };
}

export type Job =
  | SendWhatsAppJob
  | SendMetaWhatsAppJob
  | SendPaymentLinkJob
  | SendReminderJob
  | LogEventJob
  | SendCampaignBatchJob
  | SendAutomationStepJob
  | RetryClaudeReplyJob;

export const RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
export const MAX_RETRIES = 5;

/**
 * Enqueue a job.
 * @param traceId - Correlation ID from the inbound HTTP request
 * @param userId  - BusinessId for queue partitioning + tenant tracing
 */
export async function enqueue(
  jobType: JobType,
  payload: Job["payload"],
  traceId: string,
  userId?: string,
  syncHandler?: () => Promise<void>,
): Promise<string> {
  const id = crypto.randomUUID();
  const job: Job = {
    id,
    type: jobType,
    createdAt: new Date().toISOString(),
    retryCount: 0,
    requestId: traceId,
    userId,
    payload,
  } as Job;

  const queues = _assertQueueBindings();
  if (queues) {
    const queue = _selectQueue(queues, userId);
    try {
      await queue.send(job, { contentType: "json" });
      events.jobEnqueued(traceId, id, jobType, userId);
    } catch (e) {
      logError("queue", `Failed to enqueue: ${jobType}`, { error: String(e) }, traceId);
      if (syncHandler) {
        await syncHandler().catch((se) =>
          logError("queue", "Sync fallback failed", { error: String(se) }, traceId),
        );
      }
    }
    return id;
  }

  // Local dev: synchronous execution
  if (syncHandler) {
    try {
      await syncHandler();
      events.jobEnqueued(traceId, id, jobType, userId);
    } catch (e) {
      logError("queue", `Sync job failed: ${jobType}`, { error: String(e) }, traceId);
    }
  }
  return id;
}

export async function getQueueStats() {
  // NOTE: Cloudflare Queues does not expose queue depth to Worker code — this
  // function is intentionally stubbed and will always return zeros. Any alert
  // thresholds that read `total`, `ready`, or `deferred` (e.g. the total > 500
  // check in the scheduled handler) are NON-FUNCTIONAL and will never fire.
  // Remove or replace those checks once Cloudflare exposes a queue-depth API.
  return { total: 0, ready: 0, deferred: 0, byType: {} as Record<string, number> };
}
