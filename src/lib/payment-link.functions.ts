/**
 * payment-link.functions.ts — v4 (bug-fixed)
 *
 * Fixes applied:
 *   PERF 4 — Paystack call now uses fetchWithRetry instead of a raw AbortController.
 *             A transient 503 from Paystack will now be retried automatically
 *             instead of silently failing the order link generation.
 *   BUG 4  — Manual dashboard payment links now look up (or create) the customer's
 *             conversation and attach conversation_id to the order row. Previously
 *             conversation_id was always null, so handlePaystackEvent skipped the
 *             WhatsApp confirmation block — customers who paid got no receipt.
 *   BUG 9  — Consolidated with the dead-code duplicate that used to live at
 *             src/lib/server/payment-link.functions.ts (never imported by anything).
 *             That copy had the only bank-transfer support in the codebase, but its
 *             `isBankTransfer(secretKey === "sk_bank_transfer_placeholder" ? secretKey : "")`
 *             check passed the wrong value in — a placeholder string can never start
 *             with "BANK:", so the branch was unreachable and bank-transfer merchants'
 *             "Send Payment Details" button always fell through to a Paystack call with
 *             a non-key string, which Paystack rejects. Fixed the check and merged it
 *             into the file the simulator actually imports.
 *   BUG 10 — Added the missing `generateAndSendPaymentLink` export. The queue consumer's
 *             `send_payment_link` job handler (src/lib/server/worker/consumer.ts) has
 *             always imported this name from this module, but it was never defined —
 *             every automatic payment-link job threw "generateAndSendPaymentLink is not
 *             a function" and went straight to the dead-letter queue.
 */

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getPaystackSecretKey } from "@/lib/keys.functions";
import { isBankTransfer, buildBankTransferMessage } from "@/lib/paystack";
import { logError } from "@/lib/server-logger";
import { fetchWithRetry } from "@/lib/server/request-timeout";

/**
 * Generate a real Paystack checkout URL for an order, using the business's
 * own Paystack secret key — retrieved from Supabase Vault (not a plaintext column).
 */
export const generateOrderPaymentLink = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        amountNaira: z.number().int().positive().max(100_000_000),
        customerNumber: z.string().max(40).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const requestId = crypto.randomUUID();
    const { supabase, userId } = context;

    const { data: biz } = await supabase
      .from("businesses")
      .select("id, name, email")
      .eq("owner_id", userId)
      .maybeSingle();
    if (!biz) return { ok: false, error: "Business not found", url: null };

    // Read secret key from Vault (falls back to legacy plaintext during migration window).
    const secretKey = await getPaystackSecretKey(biz.id);
    if (!secretKey) {
      return { ok: false, error: "Connect bank transfer or Paystack in Settings to enable this", url: null };
    }

    // Bank transfer path: if the business uses bank transfer instead of Paystack,
    // skip the Paystack API entirely and return a formatted WhatsApp message.
    if (secretKey === "sk_bank_transfer_placeholder") {
      const { data: pkRow } = await supabaseAdmin
        .from("paystack_keys")
        .select("public_key")
        .eq("business_id", biz.id)
        .maybeSingle();
      const publicKey = pkRow?.public_key ?? "";
      if (isBankTransfer(publicKey)) {
        const message = buildBankTransferMessage({
          publicKey,
          amountNaira: data.amountNaira,
          businessName: biz.name,
        });
        return { ok: true, error: null as string | null, url: null, bankTransferMessage: message };
      }
      return { ok: false, error: "Bank transfer details are misconfigured. Check Settings.", url: null };
    }

    const reference = `wabizz_ord_${biz.id.slice(0, 8)}_${Date.now().toString(36)}`;

    try {
      // FIX PERF 4: fetchWithRetry instead of manual AbortController
      const res = await fetchWithRetry(
        "https://api.paystack.co/transaction/initialize",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${secretKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            email: biz.email,
            amount: data.amountNaira * 100,
            currency: "NGN",
            reference,
            metadata: {
              kind: "wabizz_order",
              business_id: biz.id,
              customer_number: data.customerNumber ?? null,
            },
          }),
        },
        { retries: 2, timeoutMs: 15_000, label: "Paystack order init" },
      );

      const json = await res.json();
      if (!res.ok || !json.status) {
        await logError(
          "payment-link.functions",
          "Paystack order init failed",
          { status: res.status, message: json.message, biz_id: biz.id },
          requestId,
        );
        return { ok: false, error: json.message ?? "Paystack error", url: null };
      }

      // FIX BUG 4 (original) + FIX BUG 6 (race condition):
      // Look up or create a conversation so the Paystack webhook can send a
      // WhatsApp confirmation. The create path now uses upsert with
      // onConflict so simultaneous calls for the same customer (double-click,
      // concurrent API calls) don't hit the UNIQUE(business_id, customer_number)
      // constraint and silently null out conversationId.
      let conversationId: string | null = null;
      if (data.customerNumber && data.customerNumber !== "manual") {
        // First try a fast lookup — covers the common case of an existing customer.
        const { data: existingConvo } = await supabase
          .from("conversations")
          .select("id")
          .eq("business_id", biz.id)
          .eq("customer_number", data.customerNumber)
          .maybeSingle();

        if (existingConvo) {
          conversationId = existingConvo.id;
        } else {
          // Upsert: if a concurrent request already inserted the row between
          // our select and this insert, the ON CONFLICT clause returns the
          // existing row instead of throwing a 23505 unique violation.
          const { data: upsertedConvo } = await supabase
            .from("conversations")
            .upsert(
              {
                business_id: biz.id,
                customer_number: data.customerNumber,
                last_message_at: new Date().toISOString(),
                status: "open",
              },
              { onConflict: "business_id,customer_number", ignoreDuplicates: false },
            )
            .select("id")
            .maybeSingle();
          conversationId = upsertedConvo?.id ?? null;
        }
      }

      await supabase.from("orders").insert({
        business_id: biz.id,
        customer_number: data.customerNumber ?? "manual",
        amount_naira: data.amountNaira,
        paystack_reference: reference,
        status: "pending",
        ...(conversationId ? { conversation_id: conversationId } : {}),
      });

      return {
        ok: true,
        error: null as string | null,
        url: json.data.authorization_url as string,
      };
    } catch (e) {
      await logError(
        "payment-link.functions",
        "Paystack order init network error (after retries)",
        { error: String(e), biz_id: biz.id },
        requestId,
      );
      return { ok: false, error: "Couldn't reach Paystack", url: null };
    }
  });

/**
 * Worker-only counterpart to generateOrderPaymentLink: used by the
 * `send_payment_link` queue job (src/lib/server/worker/consumer.ts) when the
 * AI detects a completed order mid-conversation and needs to generate a
 * payment link/bank-transfer message and push it to the customer over
 * WhatsApp, with no authenticated user session available. Uses supabaseAdmin
 * instead of an RLS-scoped client, and the caller already knows the
 * conversationId so no lookup/upsert is needed.
 *
 * Throws on failure so the caller's circuit breaker / queue retry handles it.
 */
export async function generateAndSendPaymentLink(params: {
  businessId: string;
  customerNumber: string;
  amountNaira: number;
  conversationId: string;
  apiKey: string;
}): Promise<void> {
  const { businessId, customerNumber, amountNaira, conversationId, apiKey } = params;
  const requestId = crypto.randomUUID();

  const { data: biz } = await supabaseAdmin
    .from("businesses")
    .select("id, name, email")
    .eq("id", businessId)
    .maybeSingle();
  if (!biz) throw new Error(`generateAndSendPaymentLink: business ${businessId} not found`);

  const secretKey = await getPaystackSecretKey(businessId);
  if (!secretKey) {
    throw new Error(`generateAndSendPaymentLink: no Paystack/bank-transfer key for business ${businessId}`);
  }

  let messageText: string;

  if (secretKey === "sk_bank_transfer_placeholder") {
    const { data: pkRow } = await supabaseAdmin
      .from("paystack_keys")
      .select("public_key")
      .eq("business_id", businessId)
      .maybeSingle();
    const publicKey = pkRow?.public_key ?? "";
    if (!isBankTransfer(publicKey)) {
      throw new Error(`generateAndSendPaymentLink: bank transfer key malformed for business ${businessId}`);
    }
    messageText = buildBankTransferMessage({ publicKey, amountNaira, businessName: biz.name });
  } else {
    const reference = `wabizz_ord_${biz.id.slice(0, 8)}_${Date.now().toString(36)}`;

    const res = await fetchWithRetry(
      "https://api.paystack.co/transaction/initialize",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secretKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: biz.email,
          amount: amountNaira * 100,
          currency: "NGN",
          reference,
          metadata: {
            kind: "wabizz_order",
            business_id: biz.id,
            customer_number: customerNumber,
          },
        }),
      },
      { retries: 2, timeoutMs: 15_000, label: "Paystack order init (auto)" },
    );

    const json = await res.json();
    if (!res.ok || !json.status) {
      await logError(
        "payment-link.functions",
        "Paystack auto order init failed",
        { status: res.status, message: json.message, biz_id: biz.id },
        requestId,
      );
      throw new Error(`generateAndSendPaymentLink: Paystack error — ${json.message ?? res.status}`);
    }

    await supabaseAdmin.from("orders").insert({
      business_id: biz.id,
      customer_number: customerNumber,
      amount_naira: amountNaira,
      paystack_reference: reference,
      status: "pending",
      conversation_id: conversationId,
    });

    const url = json.data.authorization_url as string;
    messageText = `I'll send your payment link now. Pay with the link, then reply PAID once done! 🙏\n${url}`;
  }

  const cleanTo = customerNumber.replace(/[\s\-()]/g, "");
  const res = await fetch("https://waba.360dialog.io/v1/messages", {
    method: "POST",
    headers: { "D360-API-KEY": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      recipient_type: "individual",
      to: cleanTo,
      type: "text",
      text: { body: messageText },
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`generateAndSendPaymentLink: 360dialog ${res.status}: ${body.slice(0, 200)}`);
  }
}
