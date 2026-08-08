import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { verifyPaystackSignature } from "@/lib/server/paystack-crypto.server";
import { PLANS, type PlanId } from "@/lib/plan";
import { getWhatsAppApiKey } from "@/lib/keys.functions";
import { logError, logInfo } from "@/lib/server-logger";
import { handlePaystackEvent } from "@/lib/server/twilio-handler";
import type { PaystackDeps } from "@/lib/server/twilio-handler";
import { cache, CacheKeys } from "@/lib/cache";
import { applySecurityHeaders } from "@/lib/server/security-headers";
import { withRequestTimeout, fetchWithRetry } from "@/lib/request-timeout";
import "@/lib/server-init"; // bootstrap graceful shutdown + process error handlers
import { withRequestTracking } from "@/lib/server/request-tracker";
import { acquireWebhookEvent } from "@/lib/server/webhook-event-store";
import { checkIpRateLimit } from "@/lib/rate-limiter";
import { events } from "@/lib/server/event-pipeline";

/**
 * Paystack webhook receiver.
 * Verifies the x-paystack-signature header (HMAC-SHA512 of the raw body
 * with the Wabizz secret key).
 *
 * Activates subscriptions or marks orders as paid only on charge.success.
 */
export const Route = createFileRoute("/api/public/paystack-webhook")({
  server: {
    handlers: {
      POST: async ({ request }) =>
        withRequestTracking(
          () =>
            withRequestTimeout(request, 25_000, async () => {
              const requestId = crypto.randomUUID();
              events.webhookReceived(requestId, "paystack");

              const sk = process.env.WABIZZ_PAYSTACK_SECRET_KEY;
              if (!sk) {
                await logError(
                  "paystack-webhook",
                  "WABIZZ_PAYSTACK_SECRET_KEY not configured",
                  {},
                  requestId,
                );
                return new Response("Not configured", { status: 503 });
              }

              const signature = request.headers.get("x-paystack-signature");
              const body = await request.text();
              if (!signature) return new Response("Missing signature", { status: 401 });

              if (!verifyPaystackSignature(sk, body, signature)) {
                return new Response("Invalid signature", { status: 401 });
              }

              // Rate limit: max 300 paystack webhook calls per IP per minute.
              // Paystack's retry logic is well-behaved, so a legitimate surge above
              // this would indicate replay or misconfiguration rather than normal traffic.
              const webhookIp =
                request.headers.get("CF-Connecting-IP") ??
                request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
                "unknown";
              const rlResult = await checkIpRateLimit(webhookIp, 300);
              if (!rlResult.allowed) {
                return new Response("Too many requests", {
                  status: 429,
                  headers: { "Retry-After": "60" },
                });
              }

              let payload: { event?: string; data?: Record<string, unknown> };
              try {
                payload = JSON.parse(body);
              } catch {
                return new Response("Invalid JSON", { status: 400 });
              }

              // Idempotency guard — Paystack retries the same webhook on timeout/failure.
              // Use the Paystack reference as the unique event ID.
              const reference = String(
                (payload.data as Record<string, unknown>)?.reference ?? requestId,
              );
              const guard = await acquireWebhookEvent({
                eventId: reference,
                source: "paystack",
                rawBody: body,
                requestId,
              });

              if (guard.alreadyProcessed) {
                events.webhookDuplicate(requestId, reference, "paystack");
                return applySecurityHeaders(new Response("ok", { status: 200 }));
              }

              const deps: PaystackDeps = buildPaystackDeps(requestId);
              try {
                await handlePaystackEvent(payload, deps);
                await guard.markSuccess();
              } catch (err) {
                await guard.markFailed(String(err));
                throw err;
              }

              return applySecurityHeaders(new Response("ok", { status: 200 }));
            }), // end withRequestTimeout
        ), // end withRequestTracking
      GET: async () => new Response("ok", { status: 200 }),
    },
  },
});

// ---------- dep builder ----------

function buildPaystackDeps(requestId: string): PaystackDeps {
  return {
    requestId,
    db: {
      async getSubscriptionByReference(ref) {
        const { data } = await supabaseAdmin
          .from("subscriptions")
          .select("id")
          .eq("paystack_reference", ref)
          .maybeSingle();
        return data ?? null;
      },
      async updateSubscriptionToActive(id, periodEnd) {
        const { data: sub } = await supabaseAdmin
          .from("subscriptions")
          .update({ status: "active", trial_ends_at: null, current_period_end: periodEnd })
          .eq("id", id)
          .select("business_id")
          .single();
        // Invalidate subscription cache so next webhook/AI call sees fresh status
        if (sub?.business_id) {
          await cache.del(CacheKeys.subscription(sub.business_id));
        }
      },
      async insertSubscription({ businessId, planId, reference, periodEnd }) {
        // Validate planId before inserting
        if (!(planId in PLANS)) {
          await logError(
            "paystack-webhook",
            "Unknown plan_id in subscription insert",
            { planId },
            requestId,
          );
          return;
        }
        await supabaseAdmin.from("subscriptions").insert({
          business_id: businessId,
          plan_id: planId as PlanId,
          status: "active",
          current_period_end: periodEnd,
          paystack_reference: reference,
        });
        // Invalidate cache for the new subscription
        await cache.del(CacheKeys.subscription(businessId));
      },
      async getOrderByReference(ref) {
        // FIX BUG 8: include amount_naira in the select to match the interface declaration.
        // Previously it was never selected so order.amount_naira was always undefined,
        // making the PaystackDeps interface a misleading lie to any future developer.
        const { data } = await supabaseAdmin
          .from("orders")
          .select("id, conversation_id, status, amount_naira")
          .eq("paystack_reference", ref)
          .maybeSingle();
        return data ?? null;
      },
      async markOrderPaid(id, paidAt) {
        await supabaseAdmin.from("orders").update({ status: "paid", paid_at: paidAt }).eq("id", id);
      },
      async getConversationById(id) {
        const { data } = await supabaseAdmin
          .from("conversations")
          .select("customer_number, business_id")
          .eq("id", id)
          .maybeSingle();
        return data ?? null;
      },
      async insertMessage({ conversationId, role, content }) {
        await supabaseAdmin.from("messages").insert({
          conversation_id: conversationId,
          role,
          content,
        });
        // Keep last_message_content in sync (dashboard reads this directly — no join).
        await supabaseAdmin
          .from("conversations")
          .update({
            last_message_content: content,
            last_message_role: role,
            last_message_at: new Date().toISOString(),
          })
          .eq("id", conversationId);
      },
      async updateConversationStatus(conversationId, status) {
        await supabaseAdmin
          .from("conversations")
          .update({ status, last_message_at: new Date().toISOString() })
          .eq("id", conversationId);
      },
      async getFoodOrderByReference(ref) {
        const { data } = await supabaseAdmin
          .from("food_orders")
          .select("id, customer_phone, business_id, total_amount, payment_status")
          .eq("paystack_ref", ref)
          .maybeSingle();
        return data ?? null;
      },
      async markFoodOrderPaid(ref, paidAt) {
        await supabaseAdmin
          .from("food_orders")
          .update({ payment_status: "paid", status: "paid" })
          .eq("paystack_ref", ref);
      },
      async getAppointmentByPaystackRef(ref) {
        // Looks up a wabizz_appointment record by paystack_ref.
        // wabizz_appointments is a lightweight tracking table written by
        // hospital-intent-handler when it creates a payment link, storing the
        // appointment_id, patient_phone, business_id, fee, and paystack_ref.
        const { data } = await supabaseAdmin
          .from("wabizz_appointments")
          .select("id, patient_phone, business_id, consultation_fee, confirmation_sent")
          .eq("paystack_ref", ref)
          .maybeSingle();
        return data ?? null;
      },
      async markAppointmentPaid(ref, paidAt) {
        await supabaseAdmin
          .from("wabizz_appointments")
          .update({ confirmation_sent: true, paid_at: paidAt })
          .eq("paystack_ref", ref);
      },
    },
    async getWhatsAppApiKey(businessId) {
      return getWhatsAppApiKey(businessId);
    },
    async sendWhatsAppMessage({ apiKey, to, text }) {
      try {
        const res = await fetchWithRetry(
          "https://waba-v2.360dialog.io/messages",
          {
            method: "POST",
            headers: {
              "D360-API-KEY": apiKey,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              messaging_product: "whatsapp",
              to,
              type: "text",
              text: { body: text },
            }),
          },
          { retries: 2, timeoutMs: 15_000, label: "360dialog send (paystack-webhook)" },
        );
        if (!res.ok) {
          await logError(
            "paystack-webhook",
            "360dialog send failed",
            { status: res.status },
            requestId,
          );
        }
      } catch (e) {
        const isTimeout = e instanceof Error && e.name === "AbortError";
        await logError(
          "paystack-webhook",
          isTimeout
            ? "360dialog send timed out (after retries)"
            : "360dialog send error (after retries)",
          { error: String(e) },
          requestId,
        );
      }
    },
  };
}

// verifyPaystackSignature lives in @/lib/server/paystack-crypto.server.ts
// and is re-exported from there for unit testing.
