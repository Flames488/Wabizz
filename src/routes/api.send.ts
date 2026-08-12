/**
 * api.public.send.ts — External send API
 *
 * POST /api/send
 *   Authorization: Bearer <wbz_live_...>
 *   { "phone": "+234...", "message": "..." }
 *     — free-form text. Only legal WhatsApp policy-wise if the recipient has
 *       messaged this business within the last 24h.
 *   { "phone": "+234...", "template": { "name": "...", "language": "en", "components": [...] } }
 *     — approved template send, required for cold first-contact.
 *
 * Auth: the bearer token is SHA-256 hashed and looked up against
 * businesses.external_api_key_hash (a unique index — this is a fast opaque
 * lookup, not a secret-vs-secret comparison, so no timing-attack surface;
 * the token itself is 256 bits of randomness, not a guessable password).
 *
 * A non-2xx response always means the send genuinely did not happen —
 * this route never swallows a provider failure into a 200.
 */

import { createFileRoute } from "@tanstack/react-router";
import { createHash } from "crypto";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { logError, logInfo } from "@/lib/server-logger";
import { checkRateLimit, checkIpRateLimit } from "@/lib/rate-limiter";
import { getWhatsAppSender, sendOutboundWhatsApp, sendOutboundWhatsAppTemplate } from "@/lib/server/whatsapp-sender";
import { applySecurityHeaders } from "@/lib/server/security-headers";

function json(data: unknown, status = 200) {
  return applySecurityHeaders(
    new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    }),
  );
}

function err(message: string, status: number) {
  return json({ status: "failed", error: message }, status);
}

interface TemplateInput {
  name: string;
  language?: string;
  components?: unknown[];
}

interface SendBody {
  phone?: string;
  message?: string;
  template?: TemplateInput;
}

export const Route = createFileRoute("/api/send")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const requestId = crypto.randomUUID();

        const ip =
          request.headers.get("CF-Connecting-IP") ??
          request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
          "unknown";
        const ipLimit = await checkIpRateLimit(ip, 500, "api.send");
        if (!ipLimit.allowed) return err("Too many requests", 429);

        // ── Auth ─────────────────────────────────────────────────────────────
        const authHeader = request.headers.get("authorization") ?? "";
        const token = authHeader.match(/^Bearer\s+(.+)$/i)?.[1];
        if (!token) return err("Missing or malformed Authorization header", 401);

        const tokenHash = createHash("sha256").update(token).digest("hex");
        const { data: biz } = await supabaseAdmin
          .from("businesses")
          .select("id, name, external_api_enabled")
          .eq("external_api_key_hash", tokenHash)
          .maybeSingle();

        if (!biz || !biz.external_api_enabled) {
          await logError("api.send", "Invalid or disabled API key", { ip }, requestId, "warn");
          return err("Invalid API key", 401);
        }

        // Per-business send rate limit — a leaked key can't be used to blast
        // messages unbounded even though it's still valid.
        const bizLimit = await checkRateLimit(`api-send:${biz.id}`, 60, 60_000, "api.send", ip);
        if (!bizLimit.allowed) return err("Rate limit exceeded for this API key", 429);

        void supabaseAdmin
          .from("businesses")
          .update({ external_api_key_last_used_at: new Date().toISOString() })
          .eq("id", biz.id)
          .then(() => {})
          .catch(() => {});

        // ── Body ─────────────────────────────────────────────────────────────
        let body: SendBody;
        try {
          body = await request.json();
        } catch {
          return err("Invalid JSON body", 400);
        }

        const phone = body.phone?.trim();
        if (!phone || !/^\+\d{7,15}$/.test(phone)) {
          return err('"phone" must be E.164 format, e.g. "+2348012345678"', 400);
        }
        if (!body.template && (!body.message || !body.message.trim())) {
          return err('"message" is required unless "template" is provided', 400);
        }
        if (body.message && body.message.length > 4000) {
          return err('"message" exceeds 4000 characters', 400);
        }

        // ── Compliance guard ─────────────────────────────────────────────────
        // Free-form text is only legal within 24h of the recipient having
        // messaged this business first. Outside that window (or if we've
        // never talked to this number at all) an approved template is
        // required — reject rather than let a doomed send hit the provider.
        if (!body.template) {
          const { data: convo } = await supabaseAdmin
            .from("conversations")
            .select("last_message_at")
            .eq("business_id", biz.id)
            .eq("customer_number", phone.replace(/[^\d+]/g, ""))
            .maybeSingle();

          const withinWindow =
            convo?.last_message_at &&
            Date.now() - new Date(convo.last_message_at).getTime() < 24 * 60 * 60 * 1000;

          if (!withinWindow) {
            return err(
              "This recipient hasn't messaged in the last 24h (or ever) — WhatsApp requires an approved template for first contact. Pass \"template\" instead of \"message\".",
              422,
            );
          }
        }

        // ── Send ─────────────────────────────────────────────────────────────
        const sender = await getWhatsAppSender(biz.id);
        if (!sender) {
          await logError("api.send", "Business has no connected WhatsApp sender", { businessId: biz.id }, requestId);
          return err("This business has no connected WhatsApp number", 503);
        }

        const result = body.template
          ? await sendOutboundWhatsAppTemplate(
              sender,
              phone,
              body.template.name,
              body.template.language ?? "en",
              body.template.components ?? [],
              requestId,
            )
          : await sendOutboundWhatsApp(sender, phone, body.message!, requestId);

        if (!result.ok) {
          await logError("api.send", "Send failed", { businessId: biz.id, phone, error: result.error }, requestId);
          return err(result.error ?? "Send failed", 502);
        }

        // Mark this contact as API-sourced so inbound replies get forwarded
        // to the business's configured reply webhook (see twilio-webhook.ts).
        void supabaseAdmin
          .from("contacts")
          .upsert(
            {
              business_id: biz.id,
              phone: phone.replace(/[^\d+]/g, ""),
              source: "api",
              last_messaged_at: new Date().toISOString(),
            },
            { onConflict: "business_id,phone", ignoreDuplicates: false },
          )
          .then(() => {})
          .catch(() => {});

        await logInfo("api.send", "Message sent", { businessId: biz.id, phone, template: body.template?.name }, requestId);

        return json({ status: "sent", messageSid: result.messageSid ?? null });
      },
    },
  },
  component: () => null,
});
