/**
 * reply-forwarder.ts — Forward inbound replies to a business's external webhook
 *
 * A contact reached via the external /api/send route (src/routes/api.send.ts)
 * is tagged contacts.source = "api". When such a contact replies, and the
 * owning business has businesses.reply_webhook_url configured, POST the
 * reply there so an external system (e.g. Vitar's Sales Agent) sees it.
 *
 * Called from both the Twilio and Meta inbound webhook handlers. Always
 * fire-and-forget from the caller's side — a slow or failing third-party
 * webhook must never delay or fail the response back to Twilio/Meta.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { logError, logInfo } from "@/lib/server-logger";
import { fetchWithRetry } from "@/lib/server/request-timeout";

export async function forwardReplyIfConfigured(args: {
  bizId: string;
  customerNumber: string;
  body: string;
  requestId: string;
}): Promise<void> {
  const { bizId, customerNumber, body, requestId } = args;

  const [{ data: biz }, { data: contact }] = await Promise.all([
    supabaseAdmin
      .from("businesses")
      .select("reply_webhook_url, reply_webhook_secret")
      .eq("id", bizId)
      .maybeSingle(),
    supabaseAdmin
      .from("contacts")
      .select("source")
      .eq("business_id", bizId)
      .eq("phone", customerNumber)
      .maybeSingle(),
  ]);

  if (!biz?.reply_webhook_url || contact?.source !== "api") return;

  try {
    const res = await fetchWithRetry(
      biz.reply_webhook_url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Wabizz-Webhook-Secret": biz.reply_webhook_secret ?? "",
        },
        body: JSON.stringify({
          phone: customerNumber,
          message_text: body,
          received_at: new Date().toISOString(),
        }),
      },
      { retries: 2, timeoutMs: 10_000, label: "reply-forward" },
    );

    if (!res.ok) {
      await logError(
        "reply-forwarder",
        "Reply-forward webhook returned non-2xx",
        { businessId: bizId, status: res.status, url: biz.reply_webhook_url },
        requestId,
      );
      return;
    }

    await logInfo("reply-forwarder", "Reply forwarded", { businessId: bizId }, requestId);
  } catch (e) {
    await logError(
      "reply-forwarder",
      "Reply-forward webhook failed (after retries)",
      { businessId: bizId, error: String(e), url: biz.reply_webhook_url },
      requestId,
    );
  }
}
