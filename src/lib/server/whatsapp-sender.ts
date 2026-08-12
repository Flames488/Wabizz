/**
 * whatsapp-sender.ts — Shared outbound WhatsApp send logic
 *
 * Extracted from campaign-processor.ts so it can be reused by:
 *   - The queue worker (campaigns, automation replies)
 *   - The external /api/send route (api.public.send.ts)
 *
 * Resolves a business's connected provider (Meta Cloud API or 360dialog,
 * whichever they connected via Settings) and sends either free-form text
 * or an approved template through it.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { circuitBreaker } from "@/lib/server/circuit-breaker/circuit-breaker";
import { getWhatsAppApiKey } from "@/lib/keys.functions";
import { buildTextMessageBody, buildTemplateMessageBody, DIALOG_API_BASE } from "@/lib/whatsapp";
import { sendMetaTextMessage, sendMetaTemplateMessage } from "@/lib/meta-whatsapp";
import { events } from "@/lib/server/event-pipeline";
import { recordApiCall } from "@/lib/server/admin/metrics";

export type WhatsAppSender =
  | { provider: "meta_cloud_api"; phoneNumberId: string; accessToken: string }
  | { provider: "360dialog"; apiKey: string };

export type SendResult = { ok: boolean; messageSid?: string; error?: string };

export async function getWhatsAppSender(businessId: string): Promise<WhatsAppSender | null> {
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

// ── Free-form text send ─────────────────────────────────────────────────────
// Only legal within 24h of the user having messaged in first. For cold
// first-contact, use sendOutboundWhatsAppTemplate instead.

async function sendVia360dialog(apiKey: string, to: string, text: string, traceId: string): Promise<SendResult> {
  const start = Date.now();
  try {
    const result = await circuitBreaker("360dialog", async () => {
      const res = await fetch(`${DIALOG_API_BASE}/messages`, {
        method: "POST",
        headers: { "D360-API-KEY": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify(buildTextMessageBody(to, text)),
        signal: AbortSignal.timeout(15_000),
      });
      const latencyMs = Date.now() - start;
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        void recordApiCall({ service: "360dialog", success: false, latencyMs, statusCode: res.status, error: body.slice(0, 200) });
        events.apiFailed(traceId, "360dialog", res.status, body.slice(0, 200));
        throw new Error(`360dialog ${res.status}: ${body.slice(0, 200)}`);
      }
      void recordApiCall({ service: "360dialog", success: true, latencyMs, statusCode: res.status });
      events.apiSuccess(traceId, "360dialog", latencyMs);
      const json = (await res.json()) as { messages?: Array<{ id: string }> };
      return { ok: true, messageSid: json.messages?.[0]?.id };
    });
    return result as SendResult;
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function sendViaMeta(phoneNumberId: string, accessToken: string, to: string, text: string, traceId: string): Promise<SendResult> {
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
    void recordApiCall({ service: "meta_whatsapp", success: false, latencyMs, error: String(e).slice(0, 200) });
    events.apiFailed(traceId, "meta_whatsapp", 0, String(e).slice(0, 200));
    return { ok: false, error: String(e) };
  }
}

export async function sendOutboundWhatsApp(sender: WhatsAppSender, to: string, text: string, traceId: string): Promise<SendResult> {
  if (sender.provider === "meta_cloud_api") {
    return sendViaMeta(sender.phoneNumberId, sender.accessToken, to, text, traceId);
  }
  return sendVia360dialog(sender.apiKey, to, text, traceId);
}

// ── Template send (cold first-contact) ──────────────────────────────────────

async function sendViaMetaTemplate(
  sender: Extract<WhatsAppSender, { provider: "meta_cloud_api" }>,
  to: string,
  templateName: string,
  languageCode: string,
  components: unknown[],
  traceId: string,
): Promise<SendResult> {
  const start = Date.now();
  try {
    await circuitBreaker("meta_whatsapp", async () => {
      await sendMetaTemplateMessage({
        phoneNumberId: sender.phoneNumberId,
        accessToken: sender.accessToken,
        to,
        templateName,
        languageCode,
        components,
      });
      const latencyMs = Date.now() - start;
      void recordApiCall({ service: "meta_whatsapp", success: true, latencyMs, statusCode: 200 });
      events.apiSuccess(traceId, "meta_whatsapp", latencyMs);
    });
    return { ok: true };
  } catch (e) {
    const latencyMs = Date.now() - start;
    void recordApiCall({ service: "meta_whatsapp", success: false, latencyMs, error: String(e).slice(0, 200) });
    events.apiFailed(traceId, "meta_whatsapp", 0, String(e).slice(0, 200));
    return { ok: false, error: String(e) };
  }
}

async function sendVia360dialogTemplate(
  sender: Extract<WhatsAppSender, { provider: "360dialog" }>,
  to: string,
  templateName: string,
  languageCode: string,
  components: unknown[],
  traceId: string,
): Promise<SendResult> {
  const start = Date.now();
  try {
    const result = await circuitBreaker("360dialog", async () => {
      const res = await fetch(`${DIALOG_API_BASE}/messages`, {
        method: "POST",
        headers: { "D360-API-KEY": sender.apiKey, "Content-Type": "application/json" },
        body: JSON.stringify(buildTemplateMessageBody(to, templateName, languageCode, components)),
        signal: AbortSignal.timeout(15_000),
      });
      const latencyMs = Date.now() - start;
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        void recordApiCall({ service: "360dialog", success: false, latencyMs, statusCode: res.status, error: body.slice(0, 200) });
        events.apiFailed(traceId, "360dialog", res.status, body.slice(0, 200));
        throw new Error(`360dialog ${res.status}: ${body.slice(0, 200)}`);
      }
      void recordApiCall({ service: "360dialog", success: true, latencyMs, statusCode: res.status });
      events.apiSuccess(traceId, "360dialog", latencyMs);
      const json = (await res.json()) as { messages?: Array<{ id: string }> };
      return { ok: true, messageSid: json.messages?.[0]?.id };
    });
    return result as SendResult;
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function sendOutboundWhatsAppTemplate(
  sender: WhatsAppSender,
  to: string,
  templateName: string,
  languageCode: string,
  components: unknown[],
  traceId: string,
): Promise<SendResult> {
  if (sender.provider === "meta_cloud_api") {
    return sendViaMetaTemplate(sender, to, templateName, languageCode, components, traceId);
  }
  return sendVia360dialogTemplate(sender, to, templateName, languageCode, components, traceId);
}
