/**
 * webhook-event-store.ts — Idempotent webhook event store
 *
 * Problem: Paystack and Twilio both retry webhooks on delivery failure or timeout.
 * Without this, a single payment confirmation can trigger:
 *   - duplicate order confirmations sent to customers
 *   - duplicate subscription activations
 *   - duplicate WhatsApp messages
 *
 * Solution: store each webhook event ID in Supabase on first receipt.
 * Before processing, check if the event was already processed.
 * On duplicate: log + return "already processed" immediately.
 *
 * Also enables manual event replay:
 *   - Store the raw event body alongside the processing result
 *   - Admin can trigger reprocessing of a failed event via its ID
 *
 * Storage: supabase.webhook_events table (see migration 016)
 *
 * Usage in webhook handlers:
 *
 *   const guard = await acquireWebhookEvent({
 *     eventId: reference,         // Paystack reference or Twilio MessageSid
 *     source: "paystack",
 *     rawBody: body,
 *     requestId,
 *   });
 *
 *   if (guard.alreadyProcessed) {
 *     return new Response("ok", { status: 200 }); // idempotent
 *   }
 *
 *   try {
 *     await handlePaystackEvent(payload, deps);
 *     await guard.markSuccess();
 *   } catch (err) {
 *     await guard.markFailed(String(err));
 *     throw err;
 *   }
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { logInfo, logWarn } from "@/lib/server-logger";

export type WebhookSource = "paystack" | "twilio";

export interface WebhookEventGuard {
  alreadyProcessed: boolean;
  markSuccess: () => Promise<void>;
  markFailed: (error: string) => Promise<void>;
}

/**
 * Acquire a processing lock for a webhook event.
 *
 * - If the event has been processed before: returns { alreadyProcessed: true }
 * - If new: inserts a "processing" row and returns mark* callbacks
 *
 * Uses INSERT ON CONFLICT DO NOTHING + a status check for atomic idempotency.
 * The unique constraint on (event_id, source) prevents races between concurrent
 * Twilio/Paystack retries delivering the same event simultaneously.
 */
export async function acquireWebhookEvent(args: {
  eventId: string;
  source: WebhookSource;
  rawBody: string;
  requestId: string;
}): Promise<WebhookEventGuard> {
  const { eventId, source, rawBody, requestId } = args;

  // Try to insert — ON CONFLICT DO NOTHING means concurrent duplicates skip
  const { error: insertError } = await supabaseAdmin.from("webhook_events").insert({
    event_id: eventId,
    source,
    raw_body: rawBody,
    status: "processing",
    request_id: requestId,
    received_at: new Date().toISOString(),
  });

  if (!insertError) {
    // Fresh event — we own processing
    return {
      alreadyProcessed: false,
      markSuccess: async () => {
        const { error } = await supabaseAdmin
          .from("webhook_events")
          .update({ status: "processed", processed_at: new Date().toISOString() })
          .eq("event_id", eventId)
          .eq("source", source);
        // HYGIENE FIX: throw on DB error so the consumer can markFailed and retry
        if (error) throw new Error(`Webhook markSuccess failed: ${error.message}`);
      },
      markFailed: async (error: string) => {
        await supabaseAdmin
          .from("webhook_events")
          .update({
            status: "failed",
            processed_at: new Date().toISOString(),
            error_message: error.slice(0, 1000),
          })
          .eq("event_id", eventId)
          .eq("source", source);
      },
    };
  }

  // Insert conflict — check if it was already successfully processed
  const { data: existing } = await supabaseAdmin
    .from("webhook_events")
    .select("id, status")
    .eq("event_id", eventId)
    .eq("source", source)
    .maybeSingle();

  if (existing?.status === "processed") {
    await logInfo(
      "webhook-event-store",
      `Duplicate ${source} event — already processed`,
      { eventId, source },
      requestId,
    );
    return {
      alreadyProcessed: true,
      markSuccess: async () => {
        /* already done */
      },
      markFailed: async () => {
        /* already done */
      },
    };
  }

  // BUG 3 FIX: "failed" ≠ final. A failed webhook event is retryable.
  // The original code returned alreadyProcessed:true for failed events,
  // meaning a Paystack/Twilio retry after a transient error (network blip,
  // DB timeout, downstream 503) was permanently silenced. Payments and messages
  // were silently dropped. Fix: delete the failed row so this retry can insert
  // a fresh "processing" row and attempt delivery again.
  if (existing?.status === "failed" && existing.id) {
    const { error: deleteError } = await supabaseAdmin
      .from("webhook_events")
      .delete()
      .eq("id", existing.id);

    if (deleteError) {
      // Delete raced with another concurrent retry — bail out to avoid double processing
      await logWarn(
        "webhook-event-store",
        `Failed to clear failed ${source} event for retry`,
        { eventId, source, error: deleteError.message },
        requestId,
      );
      return {
        alreadyProcessed: true,
        markSuccess: async () => {},
        markFailed: async () => {},
      };
    }

    // Deleted successfully — re-insert as "processing" so we own this retry
    const { error: reinsertError } = await supabaseAdmin.from("webhook_events").insert({
      event_id: eventId,
      source,
      raw_body: rawBody,
      status: "processing",
      request_id: requestId,
      received_at: new Date().toISOString(),
    });

    if (reinsertError) {
      // Another concurrent retry beat us — skip
      return {
        alreadyProcessed: true,
        markSuccess: async () => {},
        markFailed: async () => {},
      };
    }

    await logInfo(
      "webhook-event-store",
      `Retrying previously failed ${source} event`,
      { eventId, source },
      requestId,
    );

    return {
      alreadyProcessed: false,
      markSuccess: async () => {
        const { error } = await supabaseAdmin
          .from("webhook_events")
          .update({ status: "processed", processed_at: new Date().toISOString() })
          .eq("event_id", eventId)
          .eq("source", source);
        if (error) throw new Error(`Webhook markSuccess failed: ${error.message}`);
      },
      markFailed: async (error: string) => {
        await supabaseAdmin
          .from("webhook_events")
          .update({
            status: "failed",
            processed_at: new Date().toISOString(),
            error_message: error.slice(0, 1000),
          })
          .eq("event_id", eventId)
          .eq("source", source);
      },
    };
  }

  // Status is "processing" — another concurrent worker is handling this event
  await logWarn(
    "webhook-event-store",
    `Duplicate ${source} event — status: ${existing?.status ?? "unknown"}`,
    { eventId, source, status: existing?.status },
    requestId,
  );

  return {
    alreadyProcessed: true,
    markSuccess: async () => {
      /* no-op */
    },
    markFailed: async () => {
      /* no-op */
    },
  };
}
