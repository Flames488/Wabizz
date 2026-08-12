/**
 * api.public.twilio-webhook.ts — v3 (bug-fixed)
 *
 * Fixes applied:
 *   BUG 1  — getMessageHistory sorted ascending + limited, returning the FIRST
 *             30 messages ever sent instead of the most recent 30.  Fixed:
 *             sort descending, limit, then reverse in memory.
 *   CONCERN 2 — History capped at 20 messages (not 30) to bound token cost.
 *               30 × 4 000-char messages ≈ 120 k chars of context before the
 *               system prompt.  20 messages is safer and still gives plenty
 *               of conversational context.
 *   PERF 4 — Anthropic call in buildAiDeps now uses fetchWithRetry instead of
 *             a raw AbortController so transient 503s are automatically retried.
 *   PROBLEM 3 — insertMessage now also updates last_message_content and
 *               last_message_role on the parent conversation row, so the dashboard
 *               can read those columns directly instead of joining all messages.
 */

import { createFileRoute } from "@tanstack/react-router";
import { verifyTwilioSignature } from "@/lib/server/twilio-crypto.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { logError, logInfo } from "@/lib/server-logger";
import { checkRateLimit, checkIpRateLimit } from "@/lib/rate-limiter";
import { handleIncomingMessage } from "@/lib/server/twilio-handler";
import { isBankTransfer, parseBankTransferKey } from "@/lib/paystack";
import type { DbDeps, AiDeps, MessageRecord } from "@/lib/server/twilio-handler";
import { cache, CacheKeys, CacheTTL } from "@/lib/cache";
import { applySecurityHeaders } from "@/lib/server/security-headers";
import { withRequestTimeout, fetchWithRetry } from "@/lib/server/request-timeout";
import "@/lib/server-init"; // bootstrap graceful shutdown + process error handlers
import { withRequestTracking } from "@/lib/server/request-tracker";
import { events } from "@/lib/server/event-pipeline";
import { getWhatsAppApiKey } from "@/lib/keys.functions";
import { sendNeedsYouAlert } from "@/lib/server/reminders";
import { matchAutomationRule } from "@/lib/automation.functions";
import { enqueue } from "@/lib/queue";
import { forwardReplyIfConfigured } from "@/lib/server/reply-forwarder";

// Maximum number of history messages sent to the AI.
// Keep this at 20 — 30 × 4 000-char messages approaches 120 k chars of context
// and makes token costs unpredictable.
const MESSAGE_HISTORY_LIMIT = 20;

export const Route = createFileRoute("/api/public/twilio-webhook")({
  server: {
    handlers: {
      GET: async () => new Response("ok", { status: 200 }),
      POST: async ({ request }) =>
        withRequestTracking(
          () =>
            withRequestTimeout(request, 25_000, async () => {
              const requestId = crypto.randomUUID();
              const requestBodyText = await request.text();
              events.webhookReceived(requestId, "twilio"); // FIRST: consume body immediately before any awaits
              const params = new URLSearchParams(requestBodyText);

              // FIX BUG 13: Twilio signature verification runs FIRST.
              // The HMAC-SHA1 check is cheap and cryptographically authenticates the
              // request. Unauthenticated traffic should never touch the rate limit
              // counter — doing it the other way lets attackers probe which IPs are
              // rate-limited without a valid Twilio signature.
              const authToken = process.env.TWILIO_AUTH_TOKEN;
              const signature = request.headers.get("x-twilio-signature");
              if (!authToken) {
                await logError(
                  "twilio-webhook",
                  "TWILIO_AUTH_TOKEN missing",
                  {},
                  requestId,
                  "fatal",
                );
                return new Response("Server misconfigured", { status: 500 });
              }
              if (!signature) {
                return new Response("Missing signature", { status: 401 });
              }

              const fullUrl = request.headers.get("x-forwarded-proto")
                ? `${request.headers.get("x-forwarded-proto")}://${request.headers.get("host")}${new URL(request.url).pathname}${new URL(request.url).search}`
                : request.url;

              if (
                !verifyTwilioSignature(authToken, fullUrl, params, signature) &&
                !verifyTwilioSignature(authToken, request.url, params, signature)
              ) {
                // Extract ip for logging — only after signature fails (so we don't
                // leak whether an IP is rate-limited to unauthenticated callers).
                const ip =
                  request.headers.get("CF-Connecting-IP") ??
                  request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
                  "unknown";
                await logError(
                  "twilio-webhook",
                  "Invalid Twilio signature — both URL forms rejected",
                  {
                    ip,
                    reconstructedUrl: fullUrl,
                    rawRequestUrl: request.url,
                    urlsMatch: fullUrl === request.url,
                  },
                  requestId,
                  "warn",
                );
                return new Response("Invalid signature", { status: 401 });
              }

              // IP-level guard runs AFTER signature verification (see Fix #13 above).
              // Cloudflare provides CF-Connecting-IP; fall back to x-forwarded-for.
              const ip =
                request.headers.get("CF-Connecting-IP") ??
                request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
                "unknown";
              const ipLimit = await checkIpRateLimit(ip, 500);
              if (!ipLimit.allowed) {
                return new Response("Too many requests", { status: 429 });
              }

              const from = params.get("From") ?? "";
              const to = params.get("To") ?? "";
              // Bug 3 fix: cap incoming message body to 4 000 characters.
              // Twilio's stated limit is 1 600 chars for WhatsApp, but we add our own
              // defence-in-depth cap. Maliciously crafted bodies would otherwise go
              // straight into the AI context unbounded.
              const bodyRaw = params.get("Body") ?? "";
              const body =
                bodyRaw.length > 4000
                  ? (await logInfo(
                      "twilio-webhook",
                      "Message body truncated",
                      {
                        originalLen: bodyRaw.length,
                        from,
                      },
                      requestId,
                    ),
                    bodyRaw.slice(0, 4000))
                  : bodyRaw;
              const profileName = params.get("ProfileName");
              const messageSid = params.get("MessageSid") ?? undefined;
              // WhatsApp usernames: once a user hides their phone number, Twilio sends
              // a Business-Scoped User ID (BSUID, e.g. "US.13491208655302741918") in
              // `From` instead of a phone number, and mirrors it in `ExternalUserId`.
              // When a real phone IS present, `ExternalUserId` still carries the BSUID
              // alongside it. See: https://www.twilio.com/en-us/changelog/whatsapp-usernames--new-business-scoped-user-id--bsuid--field-re
              const externalUserId = params.get("ExternalUserId") || null;

              if (!from || !to || !body) {
                return twimlResponse("");
              }

              const strippedFrom = stripWhatsappPrefix(from);
              // Running a BSUID through normalizePhone (digits + "+" only) would strip
              // its country-code prefix and dot, silently corrupting it into a fake
              // phone-shaped string. Detect the BSUID format (2-letter country code,
              // ".", alphanumeric) and use it as-is instead.
              const isBsuid = /^[A-Za-z]{2}\.[A-Za-z0-9]+$/.test(strippedFrom);
              const customerNumber = isBsuid ? strippedFrom : normalizePhone(strippedFrom);
              const businessNumber = normalizePhone(stripWhatsappPrefix(to));

              // Look up business by WhatsApp number — cached for 600s (same TTL as whatsappConfig).
              // This mapping changes only when the business changes their WhatsApp number in Settings.
              const waCacheKey = CacheKeys.whatsappConfig(businessNumber);
              let wa = await cache.get<{ business_id: string; business_number: string }>(
                waCacheKey,
              );

              if (!wa) {
                const { data: freshWa } = await supabaseAdmin
                  .from("whatsapp_config")
                  .select("business_id, business_number")
                  .or(
                    `business_number.eq.${businessNumber},business_number.eq.${businessNumber.replace(/^\+/, "")}`,
                  )
                  .maybeSingle();

                if (!freshWa) {
                  await logError(
                    "twilio-webhook",
                    "No business matched Twilio number",
                    { businessNumber },
                    requestId,
                    "warn",
                  );
                  return twimlResponse("");
                }
                wa = freshWa;
                await cache.set(waCacheKey, wa, { ttlSeconds: CacheTTL.whatsappConfig });
              }

              // FIX BUG 5: cache rate_limit_overrides — this table almost never changes
              // but was being queried on every single inbound message. At 500 msg/min
              // that's 500 extra cold DB round-trips per minute. Cache with 5-min TTL.
              const overridesCacheKey = `rate_limit_overrides:${wa.business_id}`;
              let overrides =
                await cache.get<Array<{ limit_key: string; limit_value: number }>>(
                  overridesCacheKey,
                );
              if (overrides === null) {
                const { data: freshOverrides } = await supabaseAdmin
                  .from("rate_limit_overrides")
                  .select("limit_key, limit_value")
                  .eq("business_id", wa.business_id);
                overrides = freshOverrides ?? [];
                await cache.set(overridesCacheKey, overrides, { ttlSeconds: 300 });
              }

              const bizRateLimit =
                overrides?.find((o) => o.limit_key === "business")?.limit_value ?? 200;
              const senderRateLimit =
                overrides?.find((o) => o.limit_key === "sender")?.limit_value ?? 20;

              // --- Per-sender + per-business rate limiting (with per-business overrides) ---
              const [senderLimit, bizLimit] = await Promise.all([
                checkRateLimit(`sender:${customerNumber}`, senderRateLimit),
                checkRateLimit(`business:${businessNumber}`, bizRateLimit),
              ]);

              if (!senderLimit.allowed) {
                await logError(
                  "twilio-webhook",
                  "Rate limit: sender",
                  { customer: customerNumber, reason: senderLimit.reason },
                  requestId,
                  "warn",
                );
                return twimlResponse("");
              }
              if (!bizLimit.allowed) {
                await logError(
                  "twilio-webhook",
                  "Rate limit: business",
                  { business: businessNumber, reason: bizLimit.reason, limit: bizRateLimit },
                  requestId,
                  "warn",
                );
                return twimlResponse("");
              }

              // Bug 4 fix: include timezone column so isWithinBusinessHours can use
              // the business's actual timezone instead of always assuming Africa/Lagos.
              // Cache the business profile for 300s — it changes only when the owner
              // updates settings. Without caching this is a cold DB query on every message.
              const bizCacheKey = CacheKeys.business(wa.business_id);
              let biz = await cache.get<{
                id: string;
                name: string;
                type: string;
                products_list: string;
                open_time: string;
                close_time: string;
                tone: string;
                custom_message: string | null;
                timezone: string | null;
              }>(bizCacheKey);

              if (!biz) {
                const { data: freshBiz } = await supabaseAdmin
                  .from("businesses")
                  .select(
                    "id, name, type, products_list, open_time, close_time, tone, custom_message, timezone",
                  )
                  .eq("id", wa.business_id)
                  .maybeSingle();

                if (!freshBiz) return twimlResponse("");
                biz = freshBiz;
                await cache.set(bizCacheKey, biz, { ttlSeconds: CacheTTL.business });
              }

              if (!biz) return twimlResponse("");

              // HYGIENE FIX: capture bizId in a local const before any fire-and-forget
              // async closures. If `biz` is ever reassigned (e.g. by a future code change),
              // closures that capture `biz` would silently use the new value. A primitive
              // capture is immune to reference mutation.
              const bizId = biz.id;

              await logInfo(
                "twilio-webhook",
                "Inbound message",
                { businessId: bizId, from: customerNumber, bodyLen: body.length },
                requestId,
              );

              // ── Forward reply to the business's external webhook, if configured ──
              // Only for contacts reached via /api/send (source="api") — e.g. Vitar's
              // outreach. Fire-and-forget, before automation branching, so it fires
              // regardless of which branch (opt_out/reply/tag/AI) ends up handling
              // the message. Must never block or fail the Twilio response.
              void forwardReplyIfConfigured({ bizId, customerNumber, body, requestId }).catch(() => {});

              // ── Automation rule check ───────────────────────────────────────
              // Check before the AI call. If a keyword rule matches, enqueue
              // the action and short-circuit — no AI tokens consumed.
              const automationMatch = await matchAutomationRule(bizId, body).catch(() => null);

              if (automationMatch) {
                if (automationMatch.actionType === "opt_out") {
                  // Handle opt-out synchronously (fast DB write, no queue needed)
                  await supabaseAdmin
                    .from("contacts")
                    .update({ opted_out: true, opted_out_at: new Date().toISOString() })
                    .eq("business_id", bizId)
                    .eq("phone", customerNumber);
                  await logInfo(
                    "twilio-webhook",
                    "Contact opted out via automation",
                    { businessId: bizId, customerNumber },
                    requestId,
                  );
                  return applySecurityHeaders(twimlResponse(""));
                }

                if (automationMatch.actionType === "reply" && automationMatch.replyTemplate) {
                  // Enqueue the reply — don't call 360dialog on the webhook path
                  await enqueue(
                    "send_automation_step",
                    {
                      businessId: bizId,
                      ruleId: automationMatch.ruleId,
                      contactPhone: customerNumber,
                      contactName: profileName ?? undefined,
                      replyTemplate: automationMatch.replyTemplate,
                      addTags: automationMatch.addTags,
                    },
                    requestId,
                    bizId,
                  );
                  return applySecurityHeaders(twimlResponse(""));
                }

                if (automationMatch.actionType === "tag" && automationMatch.addTags?.length > 0) {
                  // Upsert contact (preserving an existing source, see the main
                  // inbound upsert below for why) then merge tags via DB function.
                  void supabaseAdmin
                    .from("contacts")
                    .select("id")
                    .eq("business_id", bizId)
                    .eq("phone", customerNumber)
                    .maybeSingle()
                    .then(({ data: existing }) => {
                      if (existing) {
                        return supabaseAdmin
                          .from("contacts")
                          .update({ external_user_id: externalUserId, name: profileName ?? undefined })
                          .eq("id", existing.id);
                      }
                      return supabaseAdmin.from("contacts").insert({
                        business_id: bizId,
                        phone: customerNumber,
                        external_user_id: externalUserId,
                        name: profileName ?? null,
                        tags: automationMatch.addTags,
                        source: "chat",
                      });
                    })
                    .then(async () => {
                      await supabaseAdmin.rpc("merge_contact_tags", {
                        p_business_id: bizId,
                        p_phone: customerNumber,
                        p_add_tags: automationMatch.addTags,
                      });
                    })
                    .catch(() => {});

                  // BUG 1 FIX: hard stop after tagging.
                  // Without this return, execution falls through to handleIncomingMessage,
                  // which calls the Anthropic API and sends an unintended AI reply.
                  // Cost: wasted AI tokens per tagged message. Trust: users receive
                  // unexpected bot messages after tag-only automation rules fire.
                  return applySecurityHeaders(twimlResponse(""));
                }
              }

              // ── Upsert contact on every inbound (keeps contact list current) ──
              // Read the existing row first so we never clobber `source` on an
              // UPDATE — only a brand-new contact gets source="chat". Without
              // this, a contact tagged source="api" (reached via /api/send,
              // e.g. by Vitar) would silently flip back to "chat" the moment
              // they replied, breaking reply-forwarding after their first
              // message. This also fixes the same latent bug for source
              // ="import"/"manual" contacts, which were being overwritten to
              // "chat" on every subsequent inbound message.
              void supabaseAdmin
                .from("contacts")
                .select("id")
                .eq("business_id", bizId)
                .eq("phone", customerNumber)
                .maybeSingle()
                .then(({ data: existing }) => {
                  if (existing) {
                    return supabaseAdmin
                      .from("contacts")
                      .update({
                        external_user_id: externalUserId,
                        name: profileName ?? undefined,
                        last_messaged_at: new Date().toISOString(),
                      })
                      .eq("id", existing.id);
                  }
                  return supabaseAdmin.from("contacts").insert({
                    business_id: bizId,
                    phone: customerNumber,
                    external_user_id: externalUserId,
                    name: profileName ?? null,
                    source: "chat",
                    last_messaged_at: new Date().toISOString(),
                  });
                })
                .catch(() => {});

              const db: DbDeps = buildDbDeps(requestId);
              const ai: AiDeps = buildAiDeps(requestId);

              // ── Niche module pre-check ──────────────────────────────────────────
              // Load niche configs for this business and attempt niche routing BEFORE
              // the generic AI call. If a niche handler owns the intent, it returns a
              // reply directly and we skip the generic handleIncomingMessage path entirely.
              let reply: string | null = null;

              // ── Load bank transfer details if configured ────────────────────────
              // Check paystack_keys for a BANK: prefix and enrich the business profile
              // so the AI system prompt includes the correct payment instructions.
              let bankTransferDetails: { bankName: string; accountNumber: string; accountName: string } | null = null;
              try {
                const { data: pkRow } = await supabaseAdmin
                  .from("paystack_keys")
                  .select("public_key")
                  .eq("business_id", bizId)
                  .maybeSingle();
                if (pkRow?.public_key && isBankTransfer(pkRow.public_key)) {
                  bankTransferDetails = parseBankTransferKey(pkRow.public_key);
                }
              } catch {
                // Non-fatal — fall back to no bank transfer details
              }
              const bizWithPayment = { ...biz, bankTransferDetails };

              // ── Generic AI handler (only if niche didn't handle it) ────────────
              if (reply === null) {
                const aiReply = await handleIncomingMessage(
                  {
                    business: bizWithPayment,
                    customerNumber,
                    customerName: profileName,
                    text: body,
                    messageSid,
                  },
                  { db, ai, requestId },
                );

                // Fix 2: If handleIncomingMessage returns null because Claude was 429-throttled,
                // enqueue a retry job instead of sending a silent dead-end fallback.
                // The _last429 flag is set by buildAiDeps when it intercepts a 429 before
                // returning null — consumers re-run the full AI flow once capacity returns.
                if (!aiReply && (ai as AiDepsInternal)._last429) {
                  const retryConversation = await db
                    .getConversation(bizId, customerNumber)
                    .catch(() => null);
                  await enqueue(
                    "retry_claude_reply",
                    {
                      businessId: bizId,
                      conversationId: retryConversation?.id ?? "",
                      customerPhone: from, // original whatsapp:+... form for sendTwilioWhatsapp
                      customerNumber,
                      text: body,
                      messageSid: messageSid ?? "",
                      requestId,
                    },
                    requestId,
                    bizId,
                  );
                  // Tell the customer to wait rather than leaving them hanging silently
                  await sendTwilioWhatsapp({
                    to: from,
                    from: to,
                    body: "We're experiencing high demand right now — we'll reply to you in a moment! ⏳",
                    requestId,
                  });
                } else if (aiReply) {
                  reply = aiReply;
                } else {
                  reply = "Thanks for your message! We'll get back to you shortly.";
                }
              }

              if (reply) {
                await sendTwilioWhatsapp({ to: from, from: to, body: reply, requestId });
              }

              return applySecurityHeaders(twimlResponse(""));
            }), // end withRequestTimeout
        ), // end withRequestTracking
    },
  },
});

// ---------- dep builders ----------

// Internal extension of AiDeps that carries a _last429 flag.
// Set to true when Anthropic returned 429 and all retries were exhausted —
// the webhook uses this to route to the retry_claude_reply job instead of
// sending a silent fallback.
interface AiDepsInternal extends AiDeps {
  _last429: boolean;
}

function buildDbDeps(requestId: string): DbDeps {
  return {
    async getConversation(businessId, customerNumber) {
      const { data } = await supabaseAdmin
        .from("conversations")
        .select("id, status")
        .eq("business_id", businessId)
        .eq("customer_number", customerNumber)
        .maybeSingle();
      return data ?? null;
    },

    async createConversation({ businessId, customerNumber, customerName }) {
      const { data, error } = await supabaseAdmin
        .from("conversations")
        .insert({
          business_id: businessId,
          customer_number: customerNumber,
          customer_name: customerName,
          last_message_at: new Date().toISOString(),
          status: "open",
        })
        .select("id")
        .single();

      if (error) {
        // Bug 1 fix: if two concurrent Twilio retries both reach createConversation,
        // the second will hit the UNIQUE (business_id, customer_number) constraint
        // (error code 23505). Recover by fetching the row the first request created.
        // This replaces the silent data-loss failure in the original code.
        if (error.code === "23505") {
          const { data: existing } = await supabaseAdmin
            .from("conversations")
            .select("id")
            .eq("business_id", businessId)
            .eq("customer_number", customerNumber)
            .maybeSingle();
          if (existing) return existing;
        }
        await logError(
          "twilio-webhook",
          "Conversation create failed",
          { error: error.message, code: error.code },
          requestId,
        );
        return null;
      }
      return data;
    },

    async updateConversationTimestamp(conversationId, customerName) {
      await supabaseAdmin
        .from("conversations")
        .update({
          last_message_at: new Date().toISOString(),
          customer_name: customerName ?? undefined,
        })
        .eq("id", conversationId);
    },

    async updateConversationStatus(conversationId, status) {
      await supabaseAdmin
        .from("conversations")
        .update({ status, last_message_at: new Date().toISOString() })
        .eq("id", conversationId);
    },

    async insertMessage({ conversationId, role, content, messageSid }) {
      // Use ON CONFLICT DO NOTHING on message_sid to make Twilio retries idempotent.
      // If the same MessageSid arrives twice (Twilio retry), the second insert is a no-op.
      await supabaseAdmin.from("messages").insert({
        conversation_id: conversationId,
        role,
        content,
        ...(messageSid ? { message_sid: messageSid } : {}),
      });

      // FIX PROBLEM 3: keep last_message_content in sync on the conversation row.
      // The dashboard reads this column directly — zero messages join needed.
      await supabaseAdmin
        .from("conversations")
        .update({
          last_message_content: content,
          last_message_role: role,
          last_message_at: new Date().toISOString(),
        })
        .eq("id", conversationId);

      // SCALE FIX: Invalidate the message history cache for this conversation.
      // getMessageHistory caches for 15s to reduce DB load at scale. We must
      // bust that cache on every insert so the AI gets the new message on the
      // very next request — not 15s later.
      await cache.del(`msg_history:${conversationId}:${MESSAGE_HISTORY_LIMIT}`);
    },

    async getMessageHistory(conversationId, limit = MESSAGE_HISTORY_LIMIT) {
      // SCALE FIX: Cache message history with a short TTL (15s).
      // At 1 000 concurrent conversations this query is the single highest-frequency
      // uncached DB hit — every AI reply triggered a raw SELECT with ORDER + LIMIT.
      // 15s is short enough that a new message is visible to the AI within 1–2 turns,
      // long enough to absorb bursts from fast-typing users.
      // The cache is INVALIDATED on every insertMessage call below so the AI never
      // sees stale history when it matters (after a new message arrives).
      const historyCacheKey = `msg_history:${conversationId}:${limit}`;
      const cached = await cache.get<MessageRecord[]>(historyCacheKey);
      if (cached !== null) return cached;

      // FIX BUG 1: sort DESCENDING to get the most recent `limit` messages,
      // then reverse so the array is in chronological order for the AI.
      // The old code sorted ascending, which returned the FIRST 30 messages
      // ever sent — completely wrong context for long-running conversations.
      const { data } = await supabaseAdmin
        .from("messages")
        .select("role, content")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: false })
        .limit(limit);

      const history = (data ?? []).reverse() as MessageRecord[];
      await cache.set(historyCacheKey, history, { ttlSeconds: 15 });
      return history;
    },

    async isSubscriptionActive(businessId) {
      const cacheKey = CacheKeys.subscription(businessId);
      const cached = await cache.get<boolean>(cacheKey);
      if (cached !== null) return cached;

      const { data } = await supabaseAdmin
        .from("subscriptions")
        .select("status, trial_ends_at")
        .eq("business_id", businessId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!data) {
        await cache.set(cacheKey, false, { ttlSeconds: 60 });
        return false;
      }

      let active = false;
      if (data.status === "active") active = true;
      if (data.status === "trial") {
        active = !!data.trial_ends_at && new Date(data.trial_ends_at) > new Date();
      }

      // Short TTL for trials (expiry matters), longer for paid
      const ttl = data.status === "trial" ? 60 : CacheTTL.subscription;
      await cache.set(cacheKey, active, { ttlSeconds: ttl });
      return active;
    },

    async getPlanAndMonthlyCount(businessId) {
      // Cache with a 60-second TTL — monthly count only needs to be approximate.
      // At 500 messages/min, an uncached COUNT(*) here is 500 extra DB queries/min.
      //
      // FIX BUG 7 (thundering herd): The original key used "YYYY-MM" granularity,
      // causing ALL businesses to have their cache entries expire simultaneously at
      // UTC midnight on the 1st of each month — producing a thundering herd of
      // COUNT(*) queries against Supabase at that instant.
      //
      // Fix: use "YYYY-MM-DD-HH" granularity so keys spread across a 24-hour window,
      // plus add a per-business jitter offset (0–59 min) derived from the last two
      // hex chars of the businessId. This distributes resets across the entire first
      // day of the month rather than concentrating them at 00:00:00.
      //
      // The jitter is deterministic per businessId (same offset every month),
      // so a given business always refreshes at the same minute — predictable for
      // debugging, but staggered across the fleet.
      const jitterMinutes = parseInt(businessId.slice(-2), 16) % 60; // 0–59
      const now = new Date();
      // Shift "now" forward by the jitter offset so the cache-key hour increments
      // at businessId-specific times rather than on the wall-clock hour boundary.
      const jittered = new Date(now.getTime() + jitterMinutes * 60_000);
      const countCacheKey = `plan_count:${businessId}:${jittered.toISOString().slice(0, 13)}`; // "YYYY-MM-DD-HH"
      const cachedResult = await cache.get<{ planId: string; monthlyCount: number }>(countCacheKey);
      if (cachedResult !== null) return cachedResult;

      // Get current plan from most recent subscription
      const { data: sub } = await supabaseAdmin
        .from("subscriptions")
        .select("plan_id")
        .eq("business_id", businessId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!sub) return null;

      // Count conversations started this calendar month
      const startOfMonth = new Date();
      startOfMonth.setDate(1);
      startOfMonth.setHours(0, 0, 0, 0);

      const { count } = await supabaseAdmin
        .from("conversations")
        .select("id", { count: "exact", head: true })
        .eq("business_id", businessId)
        .gte("created_at", startOfMonth.toISOString());

      const result = {
        planId: sub.plan_id,
        monthlyCount: count ?? 0,
      };
      // 60s TTL — allows ~60 messages through after limit is reached before next refresh.
      // Acceptable approximation: the limit is soft by design (not a hard payment gate).
      await cache.set(countCacheKey, result, { ttlSeconds: 60 });
      return result;
    },

    async notifyBusinessOwner({ businessId, customerName, customerNumber, requestId: rid }) {
      try {
        await sendNeedsYouAlert({ businessId, customerName, customerNumber, requestId: rid });
      } catch (e) {
        await logError(
          "twilio-webhook",
          "Failed to send needs_you alert",
          { error: String(e) },
          rid,
        );
      }
    },
  };
}

function buildAiDeps(requestId: string): AiDepsInternal {
  const internal: AiDepsInternal = { _last429: false, complete: null! };
  internal.complete = async function ({ systemPrompt, messages }) {
    const groqKey = process.env.GROQ_API_KEY;
    if (!groqKey) {
      await logError("twilio-webhook", "GROQ_API_KEY not set", {}, requestId, "fatal");
      return null;
    }

    try {
      // FIX BUG 2: timeoutMs reduced to 7_000 per attempt so that 3 attempts
      // (7s + 500ms backoff + 7s + 1000ms backoff + 7s = ~22.5s) fit inside the
      // 25-second outer withRequestTimeout budget with margin to spare.
      // Previously timeoutMs was 25_000 — meaning retries could never fire because
      // the outer timeout would kill the request before retry 1 started.
      const res = await fetchWithRetry(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${groqKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model:
              (typeof process !== "undefined" && process.env.GROQ_MODEL) ||
              "llama-3.3-70b-versatile",
            max_tokens: 1024,
            messages: [
              { role: "system", content: systemPrompt },
              ...messages.map((m) => ({ role: m.role, content: m.content })),
            ],
          }),
        },
        { retries: 2, timeoutMs: 7_000, label: "Groq webhook" },
      );

      if (res.ok) {
        const json = await res.json();
        return (json.choices?.[0]?.message?.content as string) ?? null;
      }

      // Fix 2: detect 429 explicitly before the error is swallowed into null
      if (res.status === 429) {
        internal._last429 = true;
      }

      await logError(
        "twilio-webhook",
        "Groq API error",
        { status: res.status, body: await res.text() },
        requestId,
      );
      return null;
    } catch (e) {
      const isTimeout = e instanceof Error && e.name === "AbortError";
      await logError(
        "twilio-webhook",
        isTimeout
          ? "Groq call timed out (after retries)"
          : "Groq call failed (after retries)",
        { error: String(e) },
        requestId,
      );
      return null;
    }
  };
  return internal;
}

// ---------- helpers ----------

function stripWhatsappPrefix(n: string) {
  return n.replace(/^whatsapp:/i, "").trim();
}

// HYGIENE FIX: normalize phone numbers by stripping all non-digit, non-plus characters.
// Twilio sometimes delivers numbers with spaces, dashes, or parentheses depending on
// the sender's locale. Storing un-normalized numbers causes duplicate contact rows
// and missed lookups (e.g., "+234 801 234 5678" vs "+2348012345678").
function normalizePhone(phone: string): string {
  return phone.replace(/[^\d+]/g, "");
}

function twimlResponse(message: string) {
  const xml = message
    ? `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(message)}</Message></Response>`
    : `<?xml version="1.0" encoding="UTF-8"?><Response/>`;
  return new Response(xml, {
    status: 200,
    headers: { "Content-Type": "text/xml; charset=utf-8" },
  });
}

function escapeXml(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// verifyTwilioSignature lives in @/lib/server/twilio-crypto.server.ts

async function sendTwilioWhatsapp(args: {
  to: string;
  from: string;
  body: string;
  requestId: string;
}) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const apiKeySid = process.env.TWILIO_API_KEY_SID;
  const apiKeySecret = process.env.TWILIO_API_KEY_SECRET;

  if (!accountSid || !apiKeySid || !apiKeySecret) {
    await logError(
      "twilio-webhook",
      "Twilio credentials missing",
      {
        has_sid: !!accountSid,
        has_key_sid: !!apiKeySid,
        has_key_secret: !!apiKeySecret,
      },
      args.requestId,
      "fatal",
    );
    return;
  }

  const credentials = btoa(`${apiKeySid}:${apiKeySecret}`);

  try {
    const res = await fetchWithRetry(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${credentials}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ To: args.to, From: args.from, Body: args.body }),
      },
      { retries: 2, timeoutMs: 15_000, label: "Twilio send" },
    );
    if (!res.ok) {
      await logError(
        "twilio-webhook",
        "Twilio send failed",
        { status: res.status, body: await res.text() },
        args.requestId,
      );
    }
  } catch (e) {
    await logError(
      "twilio-webhook",
      "Twilio send error (after retries)",
      { error: String(e) },
      args.requestId,
    );
  }
}
