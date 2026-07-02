/**
 * consumer.ts — Cloudflare Queue consumer (v3 — campaign + automation jobs added)
 *
 * Changes vs v2:
 *   - send_campaign_batch jobs handled by campaign-processor.ts
 *   - send_automation_step jobs handled by campaign-processor.ts
 *   - Both new job types honour idempotency + circuit breaker
 *
 * Job lifecycle (unchanged):
 *   receive → check idempotency → execute → ack | retry
 */

import { moveToDlq } from "@/lib/dead-letter-queue";
import { circuitBreaker } from "@/lib/server/circuit-breaker/circuit-breaker";
import { acquireIdempotencyKey } from "@/lib/server/idempotency";
import { events } from "@/lib/server/event-pipeline";
import { recordApiCall } from "@/lib/server/admin/metrics";
import {
  handleSendCampaignBatch,
  handleSendAutomationStep,
} from "@/lib/server/worker/campaign-processor";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { logError, logInfo } from "@/lib/server-logger";
import type {
  Job,
  SendWhatsAppJob,
  SendMetaWhatsAppJob,
  SendPaymentLinkJob,
  SendReminderJob,
  LogEventJob,
  SendCampaignBatchJob,
  SendAutomationStepJob,
  RetryClaudeReplyJob,
} from "@/lib/queue";

const MAX_RETRIES = 5;
type WorkerEnv = Record<string, string | undefined>;

function envValue(env: WorkerEnv | undefined, key: string): string | undefined {
  return env?.[key] ?? (typeof process !== "undefined" ? process.env[key] : undefined);
}

// ── Idempotency key builders ──────────────────────────────────────────────────

function _idempotencyKey(job: Job): string {
  // WARN 2 FIX: use job.createdAt (the time the job was enqueued) as the time
  // base for all time-bucketed idempotency keys, NOT new Date() (the time the
  // worker processes it). If a job is enqueued at 23:59:59 and processed at
  // 00:00:01, using new Date() produces a key for the NEW hour/day, which does
  // not match the key already in the idempotency_keys table — allowing a duplicate
  // trigger to fire. job.createdAt is set once at enqueue time and never changes.
  const baseTime = new Date(job.createdAt);

  switch (job.type) {
    case "send_whatsapp":
      return `send_whatsapp:${job.payload.to}:${_hash(job.payload.text)}`;
    case "send_meta_whatsapp":
      return `send_meta_whatsapp:${job.payload.to}:${_hash(job.payload.text)}`;
    case "send_payment_link":
      return `send_payment_link:${job.payload.businessId}:${job.payload.conversationId}:${job.payload.amountNaira}`;
    case "send_reminder":
      // Use the date the reminder was enqueued — not when it's processed
      return `${job.payload.reminderType}:${job.payload.businessId}:${baseTime.toISOString().slice(0, 10)}`;
    case "send_campaign_batch":
      return `campaign_batch:${job.payload.campaignId}:${job.payload.batchIndex}`;
    case "send_automation_step":
      // Hour-bucketed: one auto-reply per rule per contact per hour
      return `automation:${job.payload.ruleId}:${job.payload.contactPhone}:${baseTime.toISOString().slice(0, 13)}`;
    case "log_event":
      return `log_event:${job.id}`;
    case "retry_claude_reply":
      // Idempotency per conversation + message SID: only one retry per inbound message
      return `retry_claude:${job.payload.conversationId || job.payload.messageSid}:${job.payload.messageSid}`;
    default:
      return `${(job as Job).type}:${(job as Job).id}`;
  }
}

function _hash(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16);
}

// ── Handlers ──────────────────────────────────────────────────────────────────

async function handleSendWhatsApp(job: SendWhatsAppJob): Promise<void> {
  // BUG 4 FIX: apiKey is no longer in the payload. Fetch it from Vault using
  // businessId so the secret never transits the queue, logs, or DLQ.
  const { businessId, to, text } = job.payload;
  const start = Date.now();

  const { getWhatsAppApiKey } = await import("@/lib/keys.functions");
  const apiKey = await getWhatsAppApiKey(businessId);
  if (!apiKey) {
    throw new Error(`No WhatsApp API key found for business ${businessId} — cannot send message`);
  }

  await circuitBreaker("360dialog", async () => {
    const res = await fetch("https://waba.360dialog.io/v1/messages", {
      method: "POST",
      headers: { "D360-API-KEY": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient_type: "individual",
        to,
        type: "text",
        text: { body: text },
      }),
      signal: AbortSignal.timeout(15_000),
    });

    const latencyMs = Date.now() - start;

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      void recordApiCall({
        service: "360dialog",
        success: false,
        latencyMs,
        statusCode: res.status,
        error: body.slice(0, 200),
      });
      events.apiFailed(job.requestId, "360dialog", res.status, body.slice(0, 200));
      throw new Error(`360dialog ${res.status}: ${body.slice(0, 200)}`);
    }

    void recordApiCall({ service: "360dialog", success: true, latencyMs, statusCode: res.status });
    events.apiSuccess(job.requestId, "360dialog", latencyMs);
  });
}

async function handleSendPaymentLink(job: SendPaymentLinkJob): Promise<void> {
  const { businessId, customerNumber, amountNaira, conversationId } = job.payload;
  const start = Date.now();

  await circuitBreaker("paystack", async () => {
    const { generateAndSendPaymentLink } = await import("@/lib/payment-link.functions");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { getWhatsAppApiKey } = await import("@/lib/keys.functions");

    const apiKey = await getWhatsAppApiKey(businessId);
    if (!apiKey) throw new Error(`No WhatsApp API key for business ${businessId}`);

    await generateAndSendPaymentLink({
      businessId,
      customerNumber,
      amountNaira,
      conversationId,
      apiKey,
    });

    const latencyMs = Date.now() - start;
    void recordApiCall({ service: "paystack", success: true, latencyMs });
    events.apiSuccess(job.requestId, "paystack", latencyMs);
  });
}

async function handleSendReminder(job: SendReminderJob): Promise<void> {
  const { runSingleReminder } = await import("@/lib/server/reminders");
  await runSingleReminder(job.payload.reminderType, job.payload.businessId);
}

async function handleLogEvent(job: LogEventJob): Promise<void> {
  const { source, message, level, context } = job.payload;
  const { logError, logInfo, logWarn } = await import("@/lib/server-logger");
  if (level === "error") logError(source, message, context, job.requestId);
  else if (level === "warn") logWarn(source, message, context, job.requestId);
  else logInfo(source, message, context, job.requestId);
}

/**
 * handleRetryClaudeReply — Fix 2: Re-runs the full AI reply flow.
 *
 * Called when Anthropic returned 429 on the hot webhook path and all retries
 * were exhausted. By the time this job fires (queue retry backoff: ≥1s), the
 * rate limit window will have reset and the AI call should succeed.
 */
async function handleRetryClaudeReply(job: RetryClaudeReplyJob, env?: WorkerEnv): Promise<void> {
  const {
    businessId,
    customerPhone,
    customerNumber,
    text,
    messageSid,
    requestId: rid,
  } = job.payload;

  await logInfo(
    "consumer",
    "Retrying Claude reply after 429",
    { businessId, customerPhone, messageSid },
    rid,
  );

  // Resolve business profile
  const { data: biz } = await supabaseAdmin
    .from("businesses")
    .select("id, name, type, products_list, open_time, close_time, tone, custom_message, timezone")
    .eq("id", businessId)
    .maybeSingle();

  if (!biz) {
    await logError(
      "consumer",
      "retry_claude_reply: business not found",
      { businessId },
      rid,
      "error",
    );
    return;
  }

  const { handleIncomingMessage } = await import("@/lib/server/twilio-handler");
  const { fetchWithRetry } = await import("@/lib/server/request-timeout");

  // Build minimal AiDeps for retry
  const ai = {
    async complete({
      systemPrompt,
      messages,
    }: {
      systemPrompt: string;
      messages: Array<{ role: string; content: string }>;
    }) {
      const anthropicKey = envValue(env, "ANTHROPIC_API_KEY");
      if (!anthropicKey) return null;
      try {
        const res = await fetchWithRetry(
          "https://api.anthropic.com/v1/messages",
          {
            method: "POST",
            headers: {
              "x-api-key": anthropicKey,
              "anthropic-version": "2023-06-01",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: envValue(env, "ANTHROPIC_MODEL") || "claude-haiku-4-5-20251001",
              max_tokens: 1024,
              system: systemPrompt,
              messages: messages.map((m) => ({ role: m.role, content: m.content })),
            }),
          },
          { retries: 2, timeoutMs: 10_000, label: "Anthropic retry-job" },
        );
        if (res.ok) {
          const json = await res.json();
          return (json.content?.[0]?.text as string) ?? null;
        }
        return null;
      } catch {
        return null;
      }
    },
  };

  // Build minimal DbDeps (same Supabase calls, no caching needed for retry path)
  const { buildBasicDbDeps } = await import("@/lib/server/twilio-handler").catch(() => ({
    buildBasicDbDeps: null,
  }));
  const db = buildBasicDbDeps ? buildBasicDbDeps(rid) : null;

  if (!db) {
    await logError("consumer", "retry_claude_reply: could not build db deps", {}, rid, "error");
    return;
  }

  const reply = await handleIncomingMessage(
    { business: biz, customerNumber, customerName: null, text, messageSid },
    { db, ai, requestId: rid },
  );

  if (reply) {
    // BUG 3 FIX: retry must send via the same provider the business uses.
    // Previously this was hardcoded to Twilio, which silently fails for any
    // business connected via Meta Cloud API.
    const { data: waConfig } = await supabaseAdmin
      .from("whatsapp_config")
      .select("connected_via, phone_number_id")
      .eq("business_id", businessId)
      .maybeSingle();

    if (waConfig?.connected_via === "meta_cloud_api" && waConfig.phone_number_id) {
      // Meta path: enqueue a send_meta_whatsapp job — token fetched from Vault at execution time
      // enqueue is statically imported at top of this file
      await enqueue(
        "send_meta_whatsapp",
        {
          businessId,
          phoneNumberId: waConfig.phone_number_id,
          to: customerNumber,
          text: reply,
        },
        rid,
        businessId,
      );
    } else {
      // Twilio path (360dialog or legacy)
      const accountSid = envValue(env, "TWILIO_ACCOUNT_SID");
      const apiKeySid = envValue(env, "TWILIO_API_KEY_SID");
      const apiKeySecret = envValue(env, "TWILIO_API_KEY_SECRET");
      const from = envValue(env, "TWILIO_PHONE_NUMBER");
      if (accountSid && apiKeySid && apiKeySecret && from) {
        const credentials = btoa(`${apiKeySid}:${apiKeySecret}`);
        await fetchWithRetry(
          `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
          {
            method: "POST",
            headers: {
              Authorization: `Basic ${credentials}`,
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({ To: customerPhone, From: from, Body: reply }),
          },
          { retries: 2, timeoutMs: 15_000, label: "Twilio retry-job send" },
        ).catch(() => {});
      } else {
        await logError(
          "consumer",
          "retry_claude_reply: Twilio credentials missing",
          {
            hasAccountSid: !!accountSid,
            hasApiKeySid: !!apiKeySid,
            hasApiKeySecret: !!apiKeySecret,
            hasFrom: !!from,
          },
          rid,
          "error",
        );
      }
    }
    await logInfo(
      "consumer",
      "retry_claude_reply: sent successfully",
      { businessId, messageSid, provider: waConfig?.connected_via ?? "twilio" },
      rid,
    );
  }
}

async function handleSendMetaWhatsApp(job: SendMetaWhatsAppJob): Promise<void> {
  const { businessId, phoneNumberId, to, text } = job.payload;
  const start = Date.now();

  // Get access token from Vault via whatsapp_config at execution time.
  const { data: config } = await supabaseAdmin
    .from("whatsapp_config")
    .select("meta_access_token_vault_id, access_token_vault_id")
    .eq("business_id", businessId)
    .eq("connected_via", "meta_cloud_api")
    .maybeSingle();

  const vaultId = config?.meta_access_token_vault_id ?? config?.access_token_vault_id;
  if (!vaultId) {
    throw new Error(`No Meta access token for business ${businessId}`);
  }

  const { data: vaultRow } = await supabaseAdmin
    .schema("vault")
    .from("decrypted_secrets")
    .select("decrypted_secret")
    .eq("id", vaultId)
    .maybeSingle();

  const accessToken = vaultRow?.decrypted_secret;
  if (!accessToken) {
    throw new Error(`Vault lookup returned null for business ${businessId}`);
  }

  await circuitBreaker("meta_whatsapp", async () => {
    const { sendMetaTextMessage } = await import("@/lib/meta-whatsapp");
    await sendMetaTextMessage({ phoneNumberId, accessToken, to, text });

    const latencyMs = Date.now() - start;
    void recordApiCall({ service: "meta_whatsapp", success: true, latencyMs, statusCode: 200 });
    events.apiSuccess(job.requestId, "meta_whatsapp", latencyMs);
  });
}


const HANDLERS: Record<string, (job: Job, env?: WorkerEnv) => Promise<void>> = {
  send_whatsapp: (j) => handleSendWhatsApp(j as SendWhatsAppJob),
  send_meta_whatsapp: (j) => handleSendMetaWhatsApp(j as SendMetaWhatsAppJob),
  send_payment_link: (j) => handleSendPaymentLink(j as SendPaymentLinkJob),
  send_reminder: (j) => handleSendReminder(j as SendReminderJob),
  log_event: (j) => handleLogEvent(j as LogEventJob),
  send_campaign_batch: (j) => handleSendCampaignBatch(j as SendCampaignBatchJob),
  send_automation_step: (j) => handleSendAutomationStep(j as SendAutomationStepJob),
  retry_claude_reply: (j, env) => handleRetryClaudeReply(j as RetryClaudeReplyJob, env),
};

// ── Queue consumer ────────────────────────────────────────────────────────────

export async function processQueueBatch(batch: MessageBatch<Job>, env?: WorkerEnv): Promise<void> {
  await Promise.allSettled(
    batch.messages.map(async (message) => {
      const job = message.body;
      const traceId = job.requestId;
      const start = Date.now();

      try {
        const handler = HANDLERS[job.type];
        if (!handler) {
          console.warn(
            JSON.stringify({ event: "JOB_UNKNOWN_TYPE", type: job.type, jobId: job.id }),
          );
          message.ack();
          return;
        }

        // ── Idempotency check ─────────────────────────────────────────────
        const idemKey = _idempotencyKey(job);
        const guard = await acquireIdempotencyKey(idemKey, traceId);

        if (guard.alreadySeen) {
          message.ack();
          return;
        }

        // ── Execute ───────────────────────────────────────────────────────
        try {
          await handler(job, env);
          await guard.markSuccess();
          message.ack();
          events.jobProcessed(traceId, job.id, job.type, Date.now() - start);
        } catch (e) {
          await guard.markFailed(String(e));
          const attempt = (job.retryCount ?? 0) + 1;
          events.jobFailed(traceId, job.id, job.type, attempt, String(e));

          if (attempt >= MAX_RETRIES) {
            await moveToDlq({ ...job, retryCount: attempt }, e);
            events.jobDlq(traceId, job.id, job.type, String(e));
            message.ack();
          } else {
            message.retry();
          }
        }
      } catch (outer) {
        console.error(
          JSON.stringify({
            event: "JOB_INFRASTRUCTURE_ERROR",
            jobId: job.id,
            error: String(outer),
            traceId,
          }),
        );
        message.retry();
      }
    }),
  );
}
