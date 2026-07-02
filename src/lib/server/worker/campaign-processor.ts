/**
 * campaign-processor.ts — Queue consumer handler for send_campaign_batch jobs
 *
 * Responsibilities:
 *   1. Fetch pending campaign_contacts for this batch from Supabase
 *   2. Check campaign is still running (not paused/cancelled)
 *   3. Retrieve WhatsApp API key from Vault (server-side, never stored in job payload)
 *   4. Send messages with per-message idempotency + circuit breaker
 *   5. Apply rate limiting (messages_per_min) via sleep between messages
 *   6. Update campaign_contacts status (sent/failed)
 *   7. Atomically update campaign counters via DB function
 *   8. Mark campaign as completed when pending_count reaches 0
 *
 * Rate limiting implementation:
 *   If messages_per_min = 60, we sleep 1000ms between each message.
 *   If messages_per_min = 30, we sleep 2000ms between each message.
 *   This is "leaky bucket" style — steady throughput, no bursting.
 *   Cloudflare Workers have a 30s CPU time limit per request, so batches
 *   of > 30 messages at 1msg/s will exceed CPU time. For 60msg/min campaigns,
 *   keep batch_size ≤ 50. The default of 100 contacts/batch at 60msg/min
 *   is designed for queue_worker context which has no CPU limit.
 *
 * Merge tags supported in message_template:
 *   {{name}}          → contact name (or "there" if unknown)
 *   {{business_name}} → loaded from businesses table
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { logError, logInfo, logWarn } from "@/lib/server-logger";
import { circuitBreaker } from "@/lib/server/circuit-breaker/circuit-breaker";
import { acquireIdempotencyKey } from "@/lib/server/idempotency";
import { getWhatsAppApiKey } from "@/lib/keys.functions";
import { buildTextMessageBody, DIALOG_API_BASE } from "@/lib/whatsapp";
import { sendMetaTextMessage } from "@/lib/meta-whatsapp";
import { events } from "@/lib/server/event-pipeline";
import { recordApiCall } from "@/lib/server/admin/metrics";
import type { SendCampaignBatchJob, SendAutomationStepJob } from "@/lib/queue";

type WhatsAppSender =
  | { provider: "meta_cloud_api"; phoneNumberId: string; accessToken: string }
  | { provider: "360dialog"; apiKey: string };

// ── Merge tag rendering ───────────────────────────────────────────────────────

function renderTemplate(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => variables[key] ?? "");
}

// ── Single message send (shared between campaign + automation) ─────────────────

async function sendVia360dialog(
  apiKey: string,
  to: string,
  text: string,
  traceId: string,
): Promise<{ ok: boolean; messageSid?: string; error?: string }> {
  const start = Date.now();

  try {
    const result = await circuitBreaker("360dialog", async () => {
      // WARN 3 FIX: was mislabeled "twilio"; this call goes to 360dialog
      const res = await fetch(`${DIALOG_API_BASE}/messages`, {
        method: "POST",
        headers: {
          "D360-API-KEY": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(buildTextMessageBody(to, text)),
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
        events.apiFailed(traceId, "360dialog", res.status, body.slice(0, 200));
        throw new Error(`360dialog ${res.status}: ${body.slice(0, 200)}`);
      }

      void recordApiCall({ service: "360dialog", success: true, latencyMs, statusCode: res.status });
      events.apiSuccess(traceId, "360dialog", latencyMs);

      const json = (await res.json()) as { messages?: Array<{ id: string }> };
      return { ok: true, messageSid: json.messages?.[0]?.id };
    });

    return result as { ok: boolean; messageSid?: string };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function sendViaMeta(
  phoneNumberId: string,
  accessToken: string,
  to: string,
  text: string,
  traceId: string,
): Promise<{ ok: boolean; messageSid?: string; error?: string }> {
  const start = Date.now();

  try {
    await circuitBreaker("meta_whatsapp", async () => {
      await sendMetaTextMessage({ phoneNumberId, accessToken, to, text });
      const latencyMs = Date.now() - start;
      void recordApiCall({ service: "meta_whatsapp", success: true, latencyMs, statusCode: 200 });
      events.apiSuccess(traceId, "meta_whatsapp", latencyMs);
    });

    return { ok: true };
  } catch (e) {
    const latencyMs = Date.now() - start;
    void recordApiCall({
      service: "meta_whatsapp",
      success: false,
      latencyMs,
      error: String(e).slice(0, 200),
    });
    events.apiFailed(traceId, "meta_whatsapp", 0, String(e).slice(0, 200));
    return { ok: false, error: String(e) };
  }
}

async function getWhatsAppSender(businessId: string): Promise<WhatsAppSender | null> {
  const { data: config } = await supabaseAdmin
    .from("whatsapp_config")
    .select("connected_via, phone_number_id, meta_access_token_vault_id, access_token_vault_id")
    .eq("business_id", businessId)
    .maybeSingle();

  if (config?.connected_via === "meta_cloud_api") {
    const phoneNumberId = config.phone_number_id;
    const vaultId = config.meta_access_token_vault_id ?? config.access_token_vault_id;
    if (!phoneNumberId || !vaultId) return null;

    const { data: vaultRow } = await supabaseAdmin
      .schema("vault")
      .from("decrypted_secrets")
      .select("decrypted_secret")
      .eq("id", vaultId)
      .maybeSingle();

    if (!vaultRow?.decrypted_secret) return null;
    return { provider: "meta_cloud_api", phoneNumberId, accessToken: vaultRow.decrypted_secret };
  }

  const apiKey = await getWhatsAppApiKey(businessId);
  return apiKey ? { provider: "360dialog", apiKey } : null;
}

async function sendOutboundWhatsApp(
  sender: WhatsAppSender,
  to: string,
  text: string,
  traceId: string,
): Promise<{ ok: boolean; messageSid?: string; error?: string }> {
  if (sender.provider === "meta_cloud_api") {
    return sendViaMeta(sender.phoneNumberId, sender.accessToken, to, text, traceId);
  }
  return sendVia360dialog(sender.apiKey, to, text, traceId);
}

// ── Campaign batch processor ──────────────────────────────────────────────────

export async function handleSendCampaignBatch(job: SendCampaignBatchJob): Promise<void> {
  const {
    campaignId,
    businessId,
    batchIndex,
    batchSize,
    messageTemplate,
    messagesPerMin,
    explicitContactIds,
  } = job.payload;
  const traceId = job.requestId;

  // 1. Check campaign is still running
  const { data: campaign } = await supabaseAdmin
    .from("campaigns")
    .select("status, message_template")
    .eq("id", campaignId)
    .maybeSingle();

  if (!campaign) {
    logWarn(
      "campaign-processor",
      "Campaign not found, skipping batch",
      { campaignId, batchIndex },
      traceId,
    );
    return;
  }

  if (!["running"].includes(campaign.status as string)) {
    logInfo(
      "campaign-processor",
      `Campaign ${campaign.status}, skipping batch`,
      { campaignId, batchIndex },
      traceId,
    );
    return;
  }

  // 2. Fetch contacts for this batch
  let query = supabaseAdmin
    .from("campaign_contacts")
    .select("id, contact_id, phone, name")
    .eq("campaign_id", campaignId)
    .eq("status", "pending")
    .order("id");

  if (explicitContactIds && explicitContactIds.length > 0) {
    query = query.in("id", explicitContactIds);
  } else {
    query = query.range(batchIndex * batchSize, (batchIndex + 1) * batchSize - 1);
  }

  const { data: contacts } = await query;

  if (!contacts || contacts.length === 0) {
    logInfo(
      "campaign-processor",
      "No pending contacts in batch",
      { campaignId, batchIndex },
      traceId,
    );
    return;
  }

  // 3. Resolve WhatsApp sender from the active provider configuration.
  const sender = await getWhatsAppSender(businessId);
  if (!sender) {
    logError(
      "campaign-processor",
      "No WhatsApp sender configured for business",
      { businessId, campaignId },
      traceId,
    );
    await supabaseAdmin
      .from("campaigns")
      .update({ status: "failed", last_error: "No WhatsApp sender configured" })
      .eq("id", campaignId);
    return;
  }

  // 4. Get business name for merge tags
  const { data: bizRow } = await supabaseAdmin
    .from("businesses")
    .select("name")
    .eq("id", businessId)
    .maybeSingle();
  const businessName = (bizRow?.name as string) ?? "";

  // Rate limiting: delay between messages
  const delayMs = messagesPerMin > 0 ? Math.floor(60_000 / messagesPerMin) : 1_000;

  let sentDelta = 0;
  let failedDelta = 0;

  // 5. Process each contact
  for (let i = 0; i < contacts.length; i++) {
    const cc = contacts[i];
    const contactId = cc.id as string;
    const phone = cc.phone as string;
    const name = (cc.name as string) || "there";

    // Per-message idempotency key
    const idemKey = `campaign_msg:${campaignId}:${contactId}`;
    const guard = await acquireIdempotencyKey(idemKey, traceId);

    if (guard.alreadySeen) {
      logInfo(
        "campaign-processor",
        "Skipping duplicate message",
        { campaignId, contactId },
        traceId,
      );
      continue;
    }

    // Mark as queued
    await supabaseAdmin
      .from("campaign_contacts")
      .update({ status: "queued", queued_at: new Date().toISOString() })
      .eq("id", contactId);

    // Render message with merge tags
    const text = renderTemplate(messageTemplate, {
      name,
      business_name: businessName,
    });

    // Send
    const result = await sendOutboundWhatsApp(sender, phone, text, traceId);

    if (result.ok) {
      await supabaseAdmin
        .from("campaign_contacts")
        .update({
          status: "sent",
          sent_at: new Date().toISOString(),
          message_sid: result.messageSid ?? null,
        })
        .eq("id", contactId);
      await guard.markSuccess();
      sentDelta++;

      // Update contact's last_messaged_at
      void supabaseAdmin
        .from("contacts")
        .update({ last_messaged_at: new Date().toISOString() })
        .eq("id", cc.contact_id as string);
    } else {
      await supabaseAdmin
        .from("campaign_contacts")
        .update({
          status: "failed",
          failed_at: new Date().toISOString(),
          error: result.error?.slice(0, 500) ?? null,
        })
        .eq("id", contactId);
      await guard.markFailed(result.error ?? "unknown");
      failedDelta++;
      logError(
        "campaign-processor",
        "Message send failed",
        {
          campaignId,
          contactId,
          phone,
          error: result.error,
        },
        traceId,
      );
    }

    // Rate limiting sleep (skip after last contact)
    if (i < contacts.length - 1 && delayMs > 0) {
      await new Promise<void>((res) => setTimeout(res, delayMs));
    }
  }

  // 6. Update campaign counters atomically
  await supabaseAdmin.rpc("increment_campaign_counter", {
    p_campaign_id: campaignId,
    p_sent_delta: sentDelta,
    p_failed_delta: failedDelta,
    p_pending_delta: -(sentDelta + failedDelta),
  });

  // 7. Check if campaign is complete
  const { data: updated } = await supabaseAdmin
    .from("campaigns")
    .select("pending_count, total_contacts")
    .eq("id", campaignId)
    .maybeSingle();

  if (updated && (updated.pending_count as number) <= 0) {
    await supabaseAdmin
      .from("campaigns")
      .update({ status: "completed", completed_at: new Date().toISOString() })
      .eq("id", campaignId)
      .eq("status", "running");

    logInfo(
      "campaign-processor",
      "Campaign completed",
      {
        campaignId,
        sent: sentDelta,
        failed: failedDelta,
      },
      traceId,
    );
  }
}

// ── Automation step processor ─────────────────────────────────────────────────

export async function handleSendAutomationStep(job: SendAutomationStepJob): Promise<void> {
  const { businessId, ruleId, contactPhone, contactName, replyTemplate, addTags } = job.payload;
  const traceId = job.requestId;

  const sender = await getWhatsAppSender(businessId);
  if (!sender) {
    logError(
      "campaign-processor",
      "No WhatsApp sender configured for automation",
      { businessId, ruleId },
      traceId,
    );
    return;
  }

  // Idempotency: prevent double-replies within 1 hour
  const idemKey = `automation:${ruleId}:${contactPhone}:${new Date().toISOString().slice(0, 13)}`;
  const guard = await acquireIdempotencyKey(idemKey, traceId);
  if (guard.alreadySeen) return;

  const text = renderTemplate(replyTemplate, {
    name: contactName ?? "there",
  });

  const result = await sendOutboundWhatsApp(sender, contactPhone, text, traceId);

  if (result.ok) {
    await guard.markSuccess();

    // Apply tags if configured
    if (addTags && addTags.length > 0) {
      const { data: contact } = await supabaseAdmin
        .from("contacts")
        .select("id, tags")
        .eq("business_id", businessId)
        .eq("phone", contactPhone)
        .maybeSingle();

      if (contact) {
        const existing = (contact.tags as string[]) ?? [];
        const merged = Array.from(new Set([...existing, ...addTags]));
        await supabaseAdmin
          .from("contacts")
          .update({ tags: merged })
          .eq("id", contact.id as string);
      }
    }

    // Increment rule match count via DB function (avoids read-modify-write race)
    void supabaseAdmin.rpc("increment_automation_match_count", { p_rule_id: ruleId });

    logInfo("campaign-processor", "Automation step sent", { ruleId, contactPhone }, traceId);
  } else {
    await guard.markFailed(result.error ?? "unknown");
    logError(
      "campaign-processor",
      "Automation step failed",
      { ruleId, contactPhone, error: result.error },
      traceId,
    );
  }
}
