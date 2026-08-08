/**
 * subscription.functions.ts — v3 (bug-fixed)
 *
 * Fixes applied:
 *   BUG 3  — initSubscriptionCheckout now inserts status='pending_payment' instead
 *             of a phantom status='trial' row that blocked real trials from ever
 *             starting and conflicted on the paystack_reference UNIQUE constraint.
 *   PERF 4 — Paystack call in initSubscriptionCheckout now uses fetchWithRetry.
 *   TRIAL  — Free trial extended from 7 days to 30 days.
 *   FIX    — startTrial selects the `whatsapp` column (original, always-populated)
 *             rather than `whatsapp_number` (nullable, may be empty pre-migration).
 */

import { createServerFn, createServerOnlyFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { PLANS, type PlanId } from "@/lib/plan";
import { logError, logInfo } from "@/lib/server-logger";
import { cache, CacheKeys } from "@/lib/cache";
import { fetchWithRetry } from "@/lib/request-timeout";

// This file is imported by settings.tsx, pricing.tsx, and dashboard.tsx —
// all client routes — and a static (or even bare dynamic) import of anything
// under lib/server/ gets hard-blocked from the client bundle by TanStack
// Start's import-protection plugin, which broke the build for all three
// pages. createServerOnlyFn is the framework's sanctioned way around this:
// it strips the real implementation from the client bundle entirely.
// (withErrorHandling/WabizzError from lib/server/error-handler were also
// imported here previously but never actually used anywhere in this file —
// removed rather than wrapped.)
const _sendTrialStartedConfirmation = createServerOnlyFn(
  async (args: {
    businessName: string;
    whatsappNumber: string;
    trialEndsAt: string;
    businessId: string;
    requestId: string;
  }) => {
    const { sendTrialStartedConfirmation } = await import("@/lib/server/reminders");
    return sendTrialStartedConfirmation(args);
  },
);

const PlanIdSchema = z.enum(["starter", "growth", "pro"]);

// How long the free trial lasts — single source of truth for the whole file.
const TRIAL_DAYS = 30;

export const getMySubscription = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { data: biz } = await supabase
      .from("businesses")
      .select("id")
      .eq("owner_id", userId)
      .maybeSingle();
    if (!biz) return { subscription: null };
    const { data } = await supabase
      .from("subscriptions")
      .select("*")
      .eq("business_id", biz.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    return { subscription: data };
  });

/** Check if the business already has an active or trial subscription. */
export const checkExistingTrial = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { data: biz } = await supabase
      .from("businesses")
      .select("id")
      .eq("owner_id", userId)
      .maybeSingle();
    if (!biz) return { hasTrial: false, hasActive: false };
    const { data } = await supabase
      .from("subscriptions")
      .select("status, trial_ends_at")
      .eq("business_id", biz.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!data) return { hasTrial: false, hasActive: false };
    const isTrialAlive =
      data.status === "trial" &&
      data.trial_ends_at != null &&
      new Date(data.trial_ends_at) > new Date();
    return { hasTrial: isTrialAlive, hasActive: data.status === "active" };
  });

/** Start the 30-day free trial for the chosen plan. */
export const startTrial = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ planId: PlanIdSchema }).parse(input))
  .handler(async ({ data, context }) => {
    const requestId = crypto.randomUUID();
    const { supabase, userId } = context;

    // FIX: select `whatsapp` (always-populated), not `whatsapp_number` (nullable).
    const { data: biz } = await supabase
      .from("businesses")
      .select("id, name, email, whatsapp")
      .eq("owner_id", userId)
      .maybeSingle();
    if (!biz) return { ok: false, error: "Set up your business first." };

    // Guard: block if a live trial or paid plan already exists
    const { data: existing } = await supabase
      .from("subscriptions")
      .select("status, trial_ends_at")
      .eq("business_id", biz.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existing) {
      if (existing.status === "active")
        return { ok: false, error: "You already have an active plan." };
      if (
        existing.status === "trial" &&
        existing.trial_ends_at &&
        new Date(existing.trial_ends_at) > new Date()
      )
        return { ok: false, error: "Your free trial is already running." };
    }

    const now = new Date();
    const trialEndsAt = new Date(now.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000).toISOString();

    const { error } = await supabase.from("subscriptions").insert({
      business_id: biz.id,
      plan_id: data.planId,
      status: "trial",
      trial_ends_at: trialEndsAt,
    });
    if (error) return { ok: false, error: error.message };

    // FIX BUG 12: check insert result — a silent failure here leaves the
    // subscription lifecycle mutated but the audit trail incomplete.
    const { error: histError } = await supabase.from("subscription_history").insert({
      business_id: biz.id,
      event_type: "trial_started",
      plan_id: data.planId,
      notes: `${TRIAL_DAYS}-day trial started. Ends at ${trialEndsAt}`,
    });
    if (histError) {
      await logError(
        "subscription.functions",
        "subscription_history insert failed (trial_started)",
        { error: histError.message, businessId: biz.id },
        requestId,
      );
    }

    // Invalidate subscription cache so the webhook picks up the trial immediately.
    await cache.del(CacheKeys.subscription(biz.id));

    // Send WhatsApp confirmation (non-blocking)
    // FIX BUG 10b: use typed access — biz.whatsapp is now properly selected above.
    // Previously `(biz as any).whatsapp` silently returned undefined if the
    // select string had a typo or RLS stripped the column; now TypeScript
    // enforces that the column must be in the result set.
    const whatsappNumber = biz.whatsapp as string | null;
    try {
      if (whatsappNumber) {
        await _sendTrialStartedConfirmation({
          businessName: biz.name,
          whatsappNumber,
          trialEndsAt,
          businessId: biz.id,
          requestId,
        });
      }
    } catch (e) {
      await logError(
        "subscription.functions",
        "Failed to send trial confirmation",
        { error: String(e) },
        requestId,
      );
    }

    return { ok: true, error: null as string | null };
  });

/** Cancel the active free trial. */
export const cancelTrial = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const requestId = crypto.randomUUID();
    const { supabase, userId } = context;
    const { data: biz } = await supabase
      .from("businesses")
      .select("id")
      .eq("owner_id", userId)
      .maybeSingle();
    if (!biz) return { ok: false, error: "Business not found." };

    const { data: sub } = await supabase
      .from("subscriptions")
      .select("id, plan_id, status")
      .eq("business_id", biz.id)
      .eq("status", "trial")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!sub) return { ok: false, error: "No active trial found." };

    const { error } = await supabase
      .from("subscriptions")
      .update({ status: "cancelled", cancelled_at: new Date().toISOString() })
      .eq("id", sub.id);

    if (error) return { ok: false, error: error.message };

    // FIX BUG 12: check insert result — silent failure here leaves audit trail incomplete.
    const { error: cancelHistError } = await supabase.from("subscription_history").insert({
      business_id: biz.id,
      event_type: "trial_cancelled",
      plan_id: sub.plan_id,
      notes: "Cancelled by user from dashboard overlay.",
    });
    if (cancelHistError) {
      await logError(
        "subscription.functions",
        "subscription_history insert failed (trial_cancelled)",
        { error: cancelHistError.message, businessId: biz.id },
        requestId,
      );
    }

    // Invalidate cache immediately
    await cache.del(CacheKeys.subscription(biz.id));

    return { ok: true, error: null as string | null };
  });

/** Fetch full subscription history for the Settings page. */
export const getSubscriptionHistory = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { data: biz } = await supabase
      .from("businesses")
      .select("id")
      .eq("owner_id", userId)
      .maybeSingle();
    if (!biz) return { history: [], currentSub: null };

    const [{ data: history }, { data: currentSub }] = await Promise.all([
      supabase
        .from("subscription_history")
        .select("*")
        .eq("business_id", biz.id)
        .order("created_at", { ascending: false })
        .limit(50),
      supabase
        .from("subscriptions")
        .select("*")
        .eq("business_id", biz.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

    return { history: history ?? [], currentSub: currentSub ?? null };
  });

/**
 * Server-side guard: Check whether AI message processing is allowed.
 * Expired trials and cancelled subs are blocked.
 */
export const checkAIAccessAllowed = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { data: biz } = await supabase
      .from("businesses")
      .select("id")
      .eq("owner_id", userId)
      .maybeSingle();
    if (!biz) return { allowed: false, reason: "no_business" };

    const { data: sub } = await supabase
      .from("subscriptions")
      .select("status, trial_ends_at")
      .eq("business_id", biz.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!sub) return { allowed: false, reason: "no_subscription" };
    if (sub.status === "active") return { allowed: true, reason: null };
    if (sub.status === "trial") {
      const ended = sub.trial_ends_at && new Date(sub.trial_ends_at) < new Date();
      if (ended) return { allowed: false, reason: "trial_expired" };
      return { allowed: true, reason: null };
    }
    return { allowed: false, reason: "subscription_inactive" };
  });

/**
 * Initialise a Paystack subscription transaction server-side.
 *
 * FIX BUG 3: This used to insert a `status: "trial"` row with a 30-minute
 * trial_ends_at as a "pending placeholder". That caused two problems:
 *   1. An abandoned checkout left a phantom row that blocked `startTrial` forever.
 *   2. A payment retry on the same reference threw a UNIQUE constraint error.
 *
 * Now we insert `status: "pending_payment"` (no trial_ends_at). The Paystack
 * webhook handler upgrades the row to `status: "active"` on successful payment.
 */
export const initSubscriptionCheckout = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ planId: PlanIdSchema }).parse(input))
  .handler(async ({ data, context }) => {
    const requestId = crypto.randomUUID();
    const { supabase, userId } = context;

    const { data: biz } = await supabase
      .from("businesses")
      .select("id, name, email")
      .eq("owner_id", userId)
      .maybeSingle();
    if (!biz) return { ok: false, error: "Set up your business first.", url: null };
    if (!biz.email) return { ok: false, error: "Add an email in onboarding.", url: null };

    const plan = PLANS[data.planId as PlanId];
    const wabizzSk = process.env.WABIZZ_PAYSTACK_SECRET_KEY;
    if (!wabizzSk) {
      return {
        ok: false,
        error: "Payments aren't fully set up yet. Try again shortly.",
        url: null,
      };
    }

    const reference = `wabizz_sub_${biz.id.slice(0, 8)}_${Date.now().toString(36)}`;
    const origin = process.env.APP_URL;
    if (!origin) {
      await logError(
        "subscription.functions",
        "APP_URL not set — cannot build Paystack callback URL",
        {},
        requestId,
      );
      return {
        ok: false,
        error: "APP_URL is not configured. Add it to your Cloudflare Worker secrets.",
        url: null,
      };
    }

    try {
      // FIX PERF 4: use fetchWithRetry instead of a raw AbortController
      const res = await fetchWithRetry(
        "https://api.paystack.co/transaction/initialize",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${wabizzSk}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            email: biz.email,
            amount: plan.amountNaira * 100,
            currency: "NGN",
            reference,
            callback_url: `${origin}/dashboard`,
            metadata: {
              kind: "wabizz_subscription",
              business_id: biz.id,
              plan_id: plan.id,
              plan_name: plan.name,
              business_name: biz.name,
            },
          }),
        },
        { retries: 2, timeoutMs: 15_000, label: "Paystack subscription init" },
      );

      const json = await res.json();
      if (!res.ok || !json.status) {
        return { ok: false, error: json.message ?? "Paystack init failed", url: null };
      }

      // FIX BUG 3: insert as 'pending_payment' — not a phantom trial.
      // The webhook upgrades this to 'active' on payment confirmation.
      await supabase.from("subscriptions").insert({
        business_id: biz.id,
        plan_id: plan.id,
        status: "pending_payment",
        paystack_reference: reference,
      });

      return {
        ok: true,
        error: null as string | null,
        url: json.data.authorization_url as string,
      };
    } catch (e) {
      await logError(
        "subscription.functions",
        "Paystack init error",
        { error: String(e) },
        requestId,
      );
      return { ok: false, error: "Couldn't reach Paystack. Try again.", url: null };
    }
  });

// ---------------------------------------------------------------------------
// Internal helpers
// Trial confirmation is handled by src/lib/server/reminders.ts
