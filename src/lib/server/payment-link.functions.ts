/**
 * payment-link.functions.ts — v3 (bug-fixed)
 *
 * Fixes applied:
 *   PERF 4 — Paystack call now uses fetchWithRetry instead of a raw AbortController.
 *             A transient 503 from Paystack will now be retried automatically
 *             instead of silently failing the order link generation.
 *   BUG 4  — Manual dashboard payment links now look up (or create) the customer's
 *             conversation and attach conversation_id to the order row. Previously
 *             conversation_id was always null, so handlePaystackEvent skipped the
 *             WhatsApp confirmation block — customers who paid got no receipt.
 */

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { getPaystackSecretKey } from "@/lib/keys.functions";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { logError } from "@/lib/server-logger";
import { fetchWithRetry } from "@/lib/server/request-timeout";
import { isBankTransfer, buildBankTransferMessage } from "@/lib/paystack";

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
    if (isBankTransfer(secretKey === "sk_bank_transfer_placeholder" ? secretKey : "")) {
      // secretKey is the placeholder — fetch public_key to build the message
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
