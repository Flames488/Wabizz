/**
 * chat.functions.ts — v2 (bug-fixed)
 *
 * Fix applied:
 *   PERF 4 — Anthropic call now uses fetchWithRetry instead of a raw AbortController.
 *             A single transient 503 from Anthropic will be retried automatically
 *             instead of silently returning null to the customer.
 */

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { logError } from "@/lib/server-logger";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { fetchWithRetry } from "@/lib/server/request-timeout";

const ChatInput = z.object({
  businessName: z.string().min(1).max(200),
  businessType: z.string().min(1).max(100),
  productsList: z.string().max(5000),
  businessHours: z.string().max(200),
  tone: z.enum(["Professional", "Friendly", "Pidgin"]),
  customMessage: z.string().max(1000).optional(),
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().min(1).max(4000),
      }),
    )
    .min(1)
    .max(50),
});

/**
 * Authenticated chat endpoint — includes server-side guard that blocks
 * AI processing when the trial is expired or subscription is inactive.
 * The user can still view the dashboard and settings; only AI replies are gated.
 */
export const chatWithAI = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => ChatInput.parse(input))
  .handler(async ({ data, context }) => {
    const requestId = crypto.randomUUID();
    const { supabase, userId } = context;

    // ── SERVER-SIDE SUBSCRIPTION GUARD ──────────────────────────────────────
    const { data: biz } = await supabase
      .from("businesses")
      .select("id")
      .eq("owner_id", userId)
      .maybeSingle();

    if (biz) {
      const { data: sub } = await supabase
        .from("subscriptions")
        .select("status, trial_ends_at")
        .eq("business_id", biz.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!sub) {
        return {
          reply: null,
          error:
            "No active subscription found. Go to Pricing to start your free trial or pick a plan.",
        };
      }

      if (sub.status === "trial") {
        const expired = sub.trial_ends_at && new Date(sub.trial_ends_at) < new Date();
        if (expired) {
          return {
            reply: null,
            error:
              "Your free trial has expired. Add your card on the dashboard to keep your AI running.",
          };
        }
      } else if (sub.status !== "active") {
        return {
          reply: null,
          error: "Your subscription is inactive. Go to Pricing to choose a plan.",
        };
      }
    }
    // ── END GUARD ──────────────────────────────────────────────────────────

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      await logError("chat.functions", "ANTHROPIC_API_KEY not configured", {}, requestId);
      return {
        reply: null,
        error: "AI is not configured. Please add ANTHROPIC_API_KEY to Cloudflare Worker secrets.",
      };
    }

    const systemPrompt =
      `You are an AI business assistant for ${data.businessName}, a ${data.businessType} business in Nigeria. ` +
      `Your job is to respond to customer WhatsApp messages. Always be helpful, answer questions about their products:\n\n${data.productsList}\n\n` +
      `Business hours are ${data.businessHours}. Your tone should be ${data.tone}. ` +
      `When a customer wants to order, collect their details (name, delivery address, phone), confirm the total, then say: "I'll send your payment link now. Pay with the link, then reply PAID once done! 🙏" — NEVER invent or share a payment URL yourself, the system sends it automatically. ` +
      `Never make up products not listed. If asked something you don't know, say you'll check with the team.` +
      (data.customMessage ? `\n\nAlways remember: ${data.customMessage}` : "") +
      `\n\nKeep replies short, warm, and WhatsApp-style. Use emojis sparingly.`;

    try {
      // FIX PERF 4: fetchWithRetry replaces the raw AbortController pattern.
      const res = await fetchWithRetry(
        "https://api.anthropic.com/v1/messages",
        {
          method: "POST",
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 1024,
            system: systemPrompt,
            messages: data.messages.map((m) => ({ role: m.role, content: m.content })),
          }),
        },
        { retries: 2, timeoutMs: 25_000, label: "Anthropic chat" },
      );

      if (res.status === 429) {
        await logError("chat.functions", "Anthropic rate limit", { status: 429 }, requestId);
        return { reply: null, error: "Too many requests. Please wait a moment and try again." };
      }
      if (!res.ok) {
        const t = await res.text();
        await logError(
          "chat.functions",
          "Anthropic API error",
          { status: res.status, body: t },
          requestId,
        );
        // Surface a status-specific hint so whoever is looking at the
        // simulator can self-diagnose without digging through server logs —
        // a generic "AI service error" for every failure mode (bad key,
        // no credits, Anthropic outage) makes this near-impossible to fix
        // without Supabase access.
        const hint =
          res.status === 401 || res.status === 403
            ? "Invalid or expired ANTHROPIC_API_KEY — check Cloudflare Worker secrets."
            : res.status === 400
              ? "The AI request was malformed (bad request to Anthropic)."
              : res.status >= 500
                ? "Anthropic is temporarily unavailable."
                : `Anthropic returned HTTP ${res.status}.`;
        return { reply: null, error: `AI service error: ${hint}` };
      }

      const json = await res.json();
      const reply: string = json.content?.[0]?.text ?? "";
      return { reply, error: null as string | null };
    } catch (e) {
      await logError(
        "chat.functions",
        "Network error calling Anthropic (after retries)",
        { error: String(e) },
        requestId,
      );
      return { reply: null, error: "Network error. Please try again." };
    }
  });
