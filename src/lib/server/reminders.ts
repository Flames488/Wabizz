/**
 * reminders.ts — Payment & subscription reminders engine  (v3 — bug-fixed)
 *
 * Fixes applied vs v2:
 *   BUG 2  — Reads `whatsapp` column (populated by onboarding) instead of
 *             `whatsapp_number` (nullable, never populated before migration).
 *   PERF 1 — Vault lookups batch-fetched before the loop via getWhatsAppApiKeys.
 *   PERF 2 — notification_log dedup fetched in one query per run, filtered in
 *             memory — eliminates N+1 SELECT COUNT(*) inside loops.
 *   PERF 4 — sendWhatsApp now uses fetchWithRetry instead of a raw AbortController.
 *   TYPE 5 — Join results are explicitly typed; no more `as any` casts.
 *   TRIAL  — Trial confirmation message updated to reflect the 30-day trial.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { logError, logInfo } from "@/lib/server-logger";
import { getWhatsAppApiKey } from "@/lib/keys.functions";
import { fetchWithRetry } from "@/lib/server/request-timeout";

const requestId = () => crypto.randomUUID();

// ── Types ────────────────────────────────────────────────────────────────────

interface SendResult {
  ok: boolean;
  error?: string;
}

/** Shape of a joined business row returned by reminder queries. */
interface ReminderBusiness {
  name: string;
  /** Original onboarding column — always populated. */
  whatsapp: string;
}

/** Shape returned by the trial-expiry query. */
interface TrialRow {
  id: string;
  business_id: string;
  plan_id: string;
  trial_ends_at: string | null;
  businesses: ReminderBusiness;
}

/** Shape returned by the renewal-reminder query. */
interface RenewalRow {
  id: string;
  business_id: string;
  plan_id: string;
  current_period_end: string | null;
  businesses: ReminderBusiness;
}

/** Minimal notification_log row used for dedup. */
interface NotifLogRow {
  business_id: string;
  type: string;
  sent_at: string;
  meta: Record<string, unknown>;
}

/** Shape returned by the overdue-orders query (orders + conversations + businesses join). */
interface OverdueOrderRow {
  id: string;
  amount_naira: number;
  customer_number: string;
  paystack_reference: string;
  created_at: string;
  conversations: {
    id: string;
    business_id: string;
    businesses: {
      name: string;
      whatsapp_config: {
        dialog_api_key_vault_id: string;
      };
    };
  } | null;
}

// ── Main scheduled entrypoint (called by Cron) ───────────────────────────────

export async function runScheduledReminders(): Promise<void> {
  const rid = requestId();
  await logInfo("reminders", "Scheduled reminder run started", {}, rid);

  await Promise.allSettled([
    sendTrialExpiryWarnings(rid),
    sendOverduePaymentReminders(rid),
    sendSubscriptionRenewalReminders(rid),
  ]);

  await logInfo("reminders", "Scheduled reminder run complete", {}, rid);
}

// ── Trial expiry warnings ────────────────────────────────────────────────────

async function sendTrialExpiryWarnings(rid: string): Promise<void> {
  const now = new Date();
  const in25h = new Date(now.getTime() + 25 * 60 * 60 * 1000);

  // FIX BUG 2: select `whatsapp` (the original, always-populated column)
  const { data: trials, error } = await supabaseAdmin
    .from("subscriptions")
    .select("id, business_id, plan_id, trial_ends_at, businesses!inner(name, whatsapp)")
    .eq("status", "trial")
    .gt("trial_ends_at", now.toISOString())
    .lt("trial_ends_at", in25h.toISOString());

  if (error) {
    await logError("reminders", "Trial expiry query failed", { error: error.message }, rid);
    return;
  }

  const rows = (trials ?? []) as unknown as TrialRow[];
  if (rows.length === 0) return;

  // FIX PERF 1: batch-fetch all vault API keys upfront
  const businessIds = [...new Set(rows.map((r) => r.business_id))];
  const apiKeyMap = await batchGetApiKeys(businessIds);

  // FIX PERF 2: fetch all relevant notification_log rows in one query
  const { data: sentLogs } = await supabaseAdmin
    .from("notification_log")
    .select("business_id, type, sent_at, meta")
    .eq("type", "trial_expiry_warning")
    .in("business_id", businessIds)
    .gt("sent_at", new Date(now.getTime() - 20 * 60 * 60 * 1000).toISOString());

  const alreadySentSet = new Set((sentLogs ?? []).map((l: NotifLogRow) => l.business_id));

  for (const row of rows) {
    if (!row.businesses?.whatsapp) continue;
    if (alreadySentSet.has(row.business_id)) continue;

    const apiKey = apiKeyMap.get(row.business_id);
    if (!apiKey) continue;

    const trialEnd = new Date(row.trial_ends_at!);
    const hoursLeft = Math.round((trialEnd.getTime() - now.getTime()) / 3_600_000);
    const endStr = trialEnd.toLocaleDateString("en-NG", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

    const text =
      `⏰ *Wabizz AI — Trial Ending Soon*\n\n` +
      `Hi ${row.businesses.name},\n\n` +
      `Your free trial expires in *${hoursLeft} hour${hoursLeft === 1 ? "" : "s"}* (${endStr}).\n\n` +
      `To keep your AI assistant running without interruption, add your card before the trial ends:\n` +
      `👉 ${process.env.APP_URL ?? "https://app.wabizz.ai"}/pricing\n\n` +
      `— Wabizz AI 🤖`;

    const result = await sendWhatsApp(apiKey, row.businesses.whatsapp, text, rid);
    if (result.ok) {
      await logInfo(
        "reminders",
        "Trial expiry warning sent",
        { business_id: row.business_id, hours_left: hoursLeft },
        rid,
      );
      await supabaseAdmin.from("notification_log").insert({
        business_id: row.business_id,
        type: "trial_expiry_warning",
        sent_at: now.toISOString(),
        meta: { hours_left: hoursLeft },
      });
    }
  }
}

// ── Overdue payment reminders ─────────────────────────────────────────────────

async function sendOverduePaymentReminders(rid: string): Promise<void> {
  const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
  const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000);

  const { data: orders, error } = await supabaseAdmin
    .from("orders")
    .select(
      `id, amount_naira, customer_number, paystack_reference, created_at,
       conversations!inner(id, business_id,
         businesses!inner(name, whatsapp_config!inner(dialog_api_key_vault_id)))`,
    )
    .eq("status", "pending")
    .lt("created_at", thirtyMinutesAgo.toISOString())
    .gt("created_at", fourHoursAgo.toISOString());

  if (error) {
    await logError("reminders", "Overdue orders query failed", { error: error.message }, rid);
    return;
  }

  const orderList = (orders ?? []) as unknown as OverdueOrderRow[];
  if (orderList.length === 0) return;

  // FIX PERF 2: batch-fetch dedup logs for all orders at once
  const orderIds = orderList.map((o) => o.id);
  const { data: sentLogs } = await supabaseAdmin
    .from("notification_log")
    .select("meta")
    .eq("type", "payment_reminder")
    .in("meta->>order_id", orderIds);

  const alreadyNotifiedOrderIds = new Set(
    (sentLogs ?? []).map((l: { meta: Record<string, unknown> }) => l.meta?.order_id as string),
  );

  // FIX PERF 1: batch-fetch API keys
  const businessIds = [
    ...new Set(orderList.map((o) => o.conversations?.business_id ?? "").filter(Boolean)),
  ];
  const apiKeyMap = await batchGetApiKeys(businessIds);

  for (const order of orderList) {
    const convo = order.conversations;
    if (!convo?.business_id) continue;
    if (alreadyNotifiedOrderIds.has(order.id)) continue;

    const apiKey = apiKeyMap.get(convo.business_id);
    if (!apiKey) continue;

    const text =
      `💳 *Payment Reminder*\n\n` +
      `Hi! You started an order of ₦${order.amount_naira.toLocaleString()} but haven't completed payment yet.\n\n` +
      `Please complete your payment to confirm your order.\n` +
      `Reply *CANCEL* if you'd like to cancel this order.`;

    const result = await sendWhatsApp(apiKey, order.customer_number, text, rid);
    if (result.ok) {
      await logInfo(
        "reminders",
        "Payment reminder sent",
        { order_id: order.id, business_id: convo.business_id },
        rid,
      );
      await supabaseAdmin.from("notification_log").insert({
        business_id: convo.business_id,
        type: "payment_reminder",
        sent_at: new Date().toISOString(),
        meta: { order_id: order.id },
      });
    }
  }
}

// ── Subscription renewal reminders ───────────────────────────────────────────

async function sendSubscriptionRenewalReminders(rid: string): Promise<void> {
  const now = new Date();
  const in3Days = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
  const in4Days = new Date(now.getTime() + 4 * 24 * 60 * 60 * 1000);

  // FIX BUG 2: select `whatsapp` column
  const { data: subs, error } = await supabaseAdmin
    .from("subscriptions")
    .select("id, business_id, plan_id, current_period_end, businesses!inner(name, whatsapp)")
    .eq("status", "active")
    .gt("current_period_end", in3Days.toISOString())
    .lt("current_period_end", in4Days.toISOString());

  if (error) {
    await logError("reminders", "Renewal reminder query failed", { error: error.message }, rid);
    return;
  }

  const rows = (subs ?? []) as unknown as RenewalRow[];
  if (rows.length === 0) return;

  const businessIds = [...new Set(rows.map((r) => r.business_id))];

  // FIX PERF 1 & 2: batch-fetch API keys and dedup logs
  const [apiKeyMap, sentLogsResult] = await Promise.all([
    batchGetApiKeys(businessIds),
    supabaseAdmin
      .from("notification_log")
      .select("business_id, meta")
      .eq("type", "renewal_reminder")
      .in("business_id", businessIds)
      .gt("sent_at", new Date(now.getTime() - 4 * 24 * 60 * 60 * 1000).toISOString()),
  ]);

  const alreadySentSubIds = new Set(
    (sentLogsResult.data ?? []).map(
      (l: { business_id: string; meta: Record<string, unknown> }) => l.meta?.sub_id as string,
    ),
  );

  for (const sub of rows) {
    if (!sub.businesses?.whatsapp) continue;
    if (alreadySentSubIds.has(sub.id)) continue;

    const apiKey = apiKeyMap.get(sub.business_id);
    if (!apiKey) continue;

    const renewDate = new Date(sub.current_period_end!).toLocaleDateString("en-NG", {
      weekday: "long",
      month: "long",
      day: "numeric",
    });

    const text =
      `🔄 *Subscription Renewal in 3 Days*\n\n` +
      `Hi ${sub.businesses.name},\n\n` +
      `Your *${sub.plan_id}* plan renews on *${renewDate}*.\n` +
      `Your card on file will be charged automatically.\n\n` +
      `To update your payment method or cancel, visit:\n` +
      `👉 ${process.env.APP_URL ?? "https://app.wabizz.ai"}/settings\n\n` +
      `— Wabizz AI 🤖`;

    const result = await sendWhatsApp(apiKey, sub.businesses.whatsapp, text, rid);
    if (result.ok) {
      await supabaseAdmin.from("notification_log").insert({
        business_id: sub.business_id,
        type: "renewal_reminder",
        sent_at: now.toISOString(),
        meta: { sub_id: sub.id },
      });
    }
  }
}

// ── Immediate confirmations (called from event handlers) ─────────────────────

/**
 * Send an immediate payment-received confirmation after a successful order.
 * Called directly from the Paystack webhook handler — not the cron.
 */
export async function sendPaymentConfirmation(args: {
  businessId: string;
  customerNumber: string;
  amountNaira: number;
  orderId: string;
  requestId: string;
}): Promise<void> {
  const apiKey = await getWhatsAppApiKey(args.businessId);
  if (!apiKey) return;

  const text =
    `✅ *Payment Received!*\n\n` +
    `We've confirmed your payment of ₦${args.amountNaira.toLocaleString()}.\n\n` +
    `Your order is now being processed. We'll update you shortly! 🎉`;

  await sendWhatsApp(apiKey, args.customerNumber, text, args.requestId);
}

/**
 * Send a trial-started confirmation immediately after trial activation.
 * Updated to reflect the 30-day trial period.
 */
export async function sendTrialStartedConfirmation(args: {
  businessName: string;
  whatsappNumber: string;
  trialEndsAt: string;
  businessId: string;
  requestId: string;
}): Promise<void> {
  const apiKey = await getWhatsAppApiKey(args.businessId);
  if (!apiKey) return;

  const endDate = new Date(args.trialEndsAt).toLocaleDateString("en-NG", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const text =
    `🎉 *Your Wabizz AI 30-day free trial has started!*\n\n` +
    `Hi ${args.businessName},\n\n` +
    `Your AI WhatsApp assistant is now *live*.\n\n` +
    `Trial ends: *${endDate}*\n` +
    `No card required until then.\n\n` +
    `Tip: Connect your WhatsApp number in Settings to start receiving AI-powered replies instantly.\n\n` +
    `— The Wabizz AI team 🤖`;

  await sendWhatsApp(apiKey, args.whatsappNumber, text, args.requestId);
}

/**
 * Send a WhatsApp alert to the *business owner* when a conversation is escalated
 * to needs_you — i.e. the AI couldn't handle the customer's request.
 *
 * Uses the same 360dialog sender as all other reminder notifications.
 * Looks up the business owner's WhatsApp number from the businesses table.
 */
export async function sendNeedsYouAlert(args: {
  businessId: string;
  customerName: string | null;
  customerNumber: string;
  requestId: string;
}): Promise<void> {
  const rid = args.requestId;

  // Fetch the business owner's WhatsApp number
  const { data: biz } = await supabaseAdmin
    .from("businesses")
    .select("name, whatsapp")
    .eq("id", args.businessId)
    .maybeSingle();

  if (!biz?.whatsapp) {
    await logInfo(
      "reminders",
      "sendNeedsYouAlert: business has no whatsapp number — skipping",
      { businessId: args.businessId },
      rid,
    );
    return;
  }

  const apiKey = await getWhatsAppApiKey(args.businessId);
  if (!apiKey) return;

  const customerDisplay = args.customerName
    ? `${args.customerName} (${args.customerNumber})`
    : args.customerNumber;

  const text =
    `🔔 *A customer needs your attention!*\n\n` +
    `Hi ${biz.name},\n\n` +
    `Your AI assistant couldn't fully help this customer and needs a human reply:\n\n` +
    `👤 *Customer:* ${customerDisplay}\n\n` +
    `Please reply to them on WhatsApp as soon as you can, then mark the conversation as handled in your Wabizz dashboard.\n\n` +
    `— Wabizz AI 🤖`;

  const result = await sendWhatsApp(apiKey, biz.whatsapp, text, rid);
  if (result.ok) {
    await logInfo(
      "reminders",
      "needs_you alert sent to business owner",
      { businessId: args.businessId, customerNumber: args.customerNumber },
      rid,
    );
  }
}

// ── Batch API key helper ──────────────────────────────────────────────────────

/**
 * FIX PERF 1: Fetch WhatsApp API keys for multiple businesses in parallel
 * instead of one sequential call per business inside a loop.
 */
async function batchGetApiKeys(businessIds: string[]): Promise<Map<string, string>> {
  const results = await Promise.allSettled(
    businessIds.map(async (id) => {
      const key = await getWhatsAppApiKey(id);
      return { id, key };
    }),
  );

  const map = new Map<string, string>();
  for (const r of results) {
    if (r.status === "fulfilled" && r.value.key) {
      map.set(r.value.id, r.value.key);
    }
  }
  return map;
}

// ── Shared 360dialog sender ───────────────────────────────────────────────────

/**
 * FIX PERF 4: Use fetchWithRetry instead of a raw AbortController so transient
 * 503s from 360dialog are automatically retried with exponential backoff.
 */
async function sendWhatsApp(
  apiKey: string,
  to: string,
  text: string,
  rid: string,
): Promise<SendResult> {
  // FIX BUG 7: strip only formatting characters (spaces, dashes, parens) —
  // NOT the `+` prefix. The 360dialog API expects E.164 format (+2348012345678).
  // The old `replace(/\D/g, "")` matched ALL non-digits including `+`,
  // causing delivery failures for any number stored with a leading `+`.
  const cleanTo = to.replace(/[\s\-()]/g, "");

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
          to: cleanTo,
          type: "text",
          text: { body: text },
        }),
      },
      { retries: 2, timeoutMs: 15_000, label: "360dialog send" },
    );

    if (!res.ok) {
      const errBody = await res.text();
      await logError(
        "reminders",
        "360dialog send failed",
        { status: res.status, body: errBody.slice(0, 300), to: cleanTo },
        rid,
      );
      return { ok: false, error: errBody };
    }
    return { ok: true };
  } catch (e) {
    const isTimeout = e instanceof Error && e.name === "AbortError";
    await logError(
      "reminders",
      isTimeout ? "360dialog send timed out (after retries)" : "360dialog send error",
      { error: String(e), to: cleanTo },
      rid,
    );
    return { ok: false, error: String(e) };
  }
}
