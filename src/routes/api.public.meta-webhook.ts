/**
 * Meta WhatsApp Cloud API webhook.
 *
 * Uses V1's production routing architecture and COPY's bank-transfer behavior.
 */

import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { verifyMetaWebhookSignature } from "@/lib/meta-whatsapp";
import { handleIncomingMessage, buildBasicDbDeps, type AiDeps } from "@/lib/server/twilio-handler";
import { cache, CacheKeys, CacheTTL } from "@/lib/cache";
import { logError, logInfo } from "@/lib/server-logger";
import { enqueue } from "@/lib/queue";
import { acquireIdempotencyKey } from "@/lib/server/idempotency";
import { checkRateLimit, checkIpRateLimit } from "@/lib/rate-limiter";
import { matchAutomationRule } from "@/lib/automation.functions";
import { isBankTransfer, parseBankTransferKey } from "@/lib/paystack";
import { fetchWithRetry } from "@/lib/server/request-timeout";
import { applySecurityHeaders } from "@/lib/server/security-headers";
import { events } from "@/lib/server/event-pipeline";

const VERIFY_TOKEN_ENV = "META_WEBHOOK_VERIFY_TOKEN";

interface MetaContact {
  profile: { name?: string };
  wa_id: string;
}

interface MetaMessage {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  text?: { body?: string };
}

interface MetaStatus {
  id: string;
  status: string;
  timestamp: string;
  recipient_id: string;
}

interface MetaValue {
  messaging_product: "whatsapp";
  metadata: { display_phone_number: string; phone_number_id: string };
  contacts?: MetaContact[];
  messages?: MetaMessage[];
  statuses?: MetaStatus[];
}

interface MetaWebhookPayload {
  object: string;
  entry: Array<{
    id: string;
    changes: Array<{ value: MetaValue; field: string }>;
  }>;
}

export const Route = createFileRoute("/api/public/meta-webhook")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const mode = url.searchParams.get("hub.mode");
        const token = url.searchParams.get("hub.verify_token");
        const challenge = url.searchParams.get("hub.challenge");
        const expectedToken = process.env[VERIFY_TOKEN_ENV];

        if (!expectedToken) {
          await logError("meta-webhook", "META_WEBHOOK_VERIFY_TOKEN is not configured", {}, undefined, "fatal");
          return new Response("Webhook verify token not configured", { status: 500 });
        }

        if (mode === "subscribe" && token === expectedToken && challenge) {
          return new Response(challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
        }

        await logError("meta-webhook", "Webhook verification failed", { mode }, undefined, "warn");
        return new Response("Forbidden", { status: 403 });
      },

      POST: async ({ request }) => {
        const requestId = crypto.randomUUID();
        events.webhookReceived(requestId, "meta_cloud_api");

        const appSecret = process.env.META_APP_SECRET;
        if (!appSecret) {
          await logError("meta-webhook", "META_APP_SECRET is not configured", {}, requestId, "fatal");
          return new Response("Meta app secret not configured", { status: 500 });
        }

        const ip =
          request.headers.get("CF-Connecting-IP") ??
          request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
          "unknown";
        const ipLimit = await checkIpRateLimit(ip, 500);
        if (!ipLimit.allowed) {
          return new Response("Too many requests", { status: 429 });
        }

        const rawBody = await request.text();
        const signature = request.headers.get("x-hub-signature-256") ?? "";
        const validSignature = await verifyMetaWebhookSignature({ rawBody, signature, appSecret });
        if (!validSignature) {
          await logError("meta-webhook", "Invalid Meta webhook signature", { requestId }, requestId, "warn");
          return new Response("Unauthorized", { status: 401 });
        }

        let payload: MetaWebhookPayload;
        try {
          payload = JSON.parse(rawBody) as MetaWebhookPayload;
        } catch {
          return new Response("Bad Request", { status: 400 });
        }

        if (payload.object === "whatsapp_business_account") {
          for (const entry of payload.entry ?? []) {
            for (const change of entry.changes ?? []) {
              if (change.field === "messages") {
                await processMetaChange(change.value, requestId);
              }
            }
          }
        }

        return applySecurityHeaders(new Response("OK", { status: 200 }));
      },
    },
  },
  component: () => null,
});

async function processMetaChange(value: MetaValue, requestId: string): Promise<void> {
  const phoneNumberId = value.metadata?.phone_number_id;
  if (!phoneNumberId) return;

  if (value.statuses?.length) {
    for (const status of value.statuses) {
      await logInfo(
        "meta-webhook",
        "Message status update",
        { status: status.status, messageId: status.id, recipientId: status.recipient_id },
        requestId,
      );
    }
    return;
  }

  if (!value.messages?.length) return;

  const wa = await getMetaBusinessConfig(phoneNumberId, requestId);
  if (!wa) return;

  for (const message of value.messages) {
    if (message.type !== "text" || !message.text?.body) {
      await logInfo("meta-webhook", "Skipping non-text Meta message", { type: message.type, phoneNumberId }, requestId);
      continue;
    }

    const dedupeKey = `meta_msg:${message.id}`;
    const dedupe = await acquireIdempotencyKey(dedupeKey, requestId);
    if (dedupe.alreadySeen) {
      await logInfo("meta-webhook", "Skipping duplicate Meta message", { messageId: message.id }, requestId);
      continue;
    }

    try {
      await processTextMessage({
        value,
        wa,
        message,
        requestId,
      });
      await dedupe.markSuccess();
    } catch (error) {
      await dedupe.markFailed(String(error));
      await logError("meta-webhook", "Meta message processing failed", { error: String(error), messageId: message.id }, requestId);
    }
  }
}

async function getMetaBusinessConfig(phoneNumberId: string, requestId: string): Promise<{
  business_id: string;
  business_number: string;
  coexistence_enabled: boolean;
  phone_number_id: string;
} | null> {
  const cacheKey = `meta:biz:${phoneNumberId}`;
  const cached = await cache.get<{
    business_id: string;
    business_number: string;
    coexistence_enabled: boolean;
    phone_number_id: string;
  }>(cacheKey);
  if (cached) return cached;

  const { data } = await supabaseAdmin
    .from("whatsapp_config")
    .select("business_id, business_number, coexistence_enabled, phone_number_id")
    .eq("phone_number_id", phoneNumberId)
    .eq("connected_via", "meta_cloud_api")
    .maybeSingle();

  if (!data) {
    await logError("meta-webhook", "No business found for Meta phone_number_id", { phoneNumberId }, requestId, "warn");
    return null;
  }

  await cache.set(cacheKey, data, { ttlSeconds: CacheTTL.whatsappConfig });
  await cache.set(`meta_phone_biz:${phoneNumberId}`, data, { ttlSeconds: CacheTTL.whatsappConfig });
  return data;
}

async function processTextMessage(args: {
  value: MetaValue;
  wa: {
    business_id: string;
    business_number: string;
    coexistence_enabled: boolean;
    phone_number_id: string;
  };
  message: MetaMessage;
  requestId: string;
}): Promise<void> {
  const { value, wa, message, requestId } = args;
  const customerNumber = normalizePhone(message.from);
  const businessNumber = wa.business_number;

  if (wa.coexistence_enabled && isBusinessEcho(customerNumber, businessNumber)) {
    await logInfo("meta-webhook", "Skipping Coexistence echo from business owner", { businessId: wa.business_id }, requestId);
    return;
  }

  const [senderLimit, bizLimit] = await Promise.all([
    checkRateLimit(`sender:${customerNumber}`, 20),
    checkRateLimit(`business:${businessNumber}`, 200),
  ]);
  if (!senderLimit.allowed || !bizLimit.allowed) {
    await logError("meta-webhook", "Rate limit hit", { customerNumber, businessId: wa.business_id }, requestId, "warn");
    return;
  }

  const body = message.text?.body?.slice(0, 4000) ?? "";
  const automationMatch = await matchAutomationRule(wa.business_id, body).catch(() => null);
  const contact = value.contacts?.find((c) => c.wa_id === message.from);
  const customerName = contact?.profile?.name ?? null;

  if (automationMatch) {
    if (automationMatch.actionType === "opt_out") {
      await supabaseAdmin
        .from("contacts")
        .update({ opted_out: true, opted_out_at: new Date().toISOString() })
        .eq("business_id", wa.business_id)
        .eq("phone", customerNumber);
      return;
    }

    if (automationMatch.actionType === "reply" && automationMatch.replyTemplate) {
      await enqueue(
        "send_automation_step",
        {
          businessId: wa.business_id,
          ruleId: automationMatch.ruleId,
          contactPhone: customerNumber,
          contactName: customerName ?? undefined,
          replyTemplate: automationMatch.replyTemplate,
          addTags: automationMatch.addTags,
        },
        requestId,
        wa.business_id,
      );
      return;
    }
  }

  void supabaseAdmin
    .from("contacts")
    .upsert(
      { business_id: wa.business_id, phone: customerNumber, name: customerName, source: "chat", last_messaged_at: new Date().toISOString() },
      { onConflict: "business_id,phone", ignoreDuplicates: false },
    )
    .catch(() => {});

  const biz = await getBusinessProfile(wa.business_id);
  if (!biz) return;

  const bankTransferDetails = await getBankTransferDetails(wa.business_id);
  const reply = await handleIncomingMessage(
    {
      business: { ...biz, bankTransferDetails },
      customerNumber,
      customerName,
      text: body,
      messageSid: message.id,
    },
    { db: buildBasicDbDeps(requestId), ai: buildAiDeps(requestId), requestId },
  );

  if (!reply) return;

  await enqueue(
    "send_meta_whatsapp",
    {
      businessId: wa.business_id,
      phoneNumberId: wa.phone_number_id,
      to: customerNumber,
      text: reply,
    },
    requestId,
    wa.business_id,
  );
}

async function getBusinessProfile(businessId: string) {
  const cacheKey = CacheKeys.business(businessId);
  const cached = await cache.get<{
    id: string;
    name: string;
    type: string;
    products_list: string;
    open_time: string;
    close_time: string;
    tone: string;
    custom_message: string | null;
    timezone: string | null;
  }>(cacheKey);
  if (cached) return cached;

  const { data } = await supabaseAdmin
    .from("businesses")
    .select("id, name, type, products_list, open_time, close_time, tone, custom_message, timezone")
    .eq("id", businessId)
    .maybeSingle();
  if (data) await cache.set(cacheKey, data, { ttlSeconds: CacheTTL.business });
  return data ?? null;
}

async function getBankTransferDetails(businessId: string): Promise<{
  bankName: string;
  accountNumber: string;
  accountName: string;
} | null> {
  const { data } = await supabaseAdmin
    .from("paystack_keys")
    .select("public_key")
    .eq("business_id", businessId)
    .maybeSingle();
  return data?.public_key && isBankTransfer(data.public_key)
    ? parseBankTransferKey(data.public_key)
    : null;
}

function buildAiDeps(requestId: string): AiDeps {
  return {
    async complete({ systemPrompt, messages }) {
      const groqKey = process.env.GROQ_API_KEY;
      if (!groqKey) {
        await logError("meta-webhook", "GROQ_API_KEY is not configured", {}, requestId, "fatal");
        return null;
      }

      const res = await fetchWithRetry(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${groqKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
            max_tokens: 1024,
            messages: [
              { role: "system", content: systemPrompt },
              ...messages.map((m) => ({ role: m.role, content: m.content })),
            ],
          }),
        },
        { retries: 2, timeoutMs: 7_000, label: "Groq meta-webhook" },
      );

      if (!res.ok) {
        await logError("meta-webhook", "Groq API error", { status: res.status }, requestId);
        return null;
      }

      const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      return json.choices?.[0]?.message?.content ?? null;
    },
  };
}

function normalizePhone(phone: string): string {
  return `+${phone.replace(/\D/g, "")}`;
}

function isBusinessEcho(customerNumber: string, businessNumber: string): boolean {
  const fromDigits = customerNumber.replace(/\D/g, "");
  const businessDigits = businessNumber.replace(/\D/g, "");
  return fromDigits === businessDigits || fromDigits === businessDigits.replace(/^234/, "");
}
