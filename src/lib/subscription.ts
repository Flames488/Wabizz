import { PLANS, type PlanId, type PlanInfo } from "./plan";

export type ActiveSubscription = {
  planId: PlanId;
  status: "trial" | "active";
  startedAt: number; // ms epoch
  trialEndsAt?: number; // ms epoch — only when status === "trial"
  paymentRef?: string;
  _syncedAt?: number; // ms epoch — when this was last synced from DB
};

const KEY = "wabizz_subscription";
/** Must match the TRIAL_DAYS constant in subscription.functions.ts (server). */
export const TRIAL_DAYS = 30;

/** Max age before localStorage subscription is considered stale (5 minutes). */
const STALE_THRESHOLD_MS = 5 * 60 * 1000;

export function getSubscription(): ActiveSubscription | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ActiveSubscription;
    if (!parsed.planId || !(parsed.planId in PLANS)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Returns whether the locally-cached subscription is potentially stale.
 * Use this to decide whether to re-fetch from the server.
 */
export function isSubscriptionStale(): boolean {
  const sub = getSubscription();
  if (!sub) return true;
  if (!sub._syncedAt) return true;
  return Date.now() - sub._syncedAt > STALE_THRESHOLD_MS;
}

export function saveSubscription(sub: ActiveSubscription) {
  if (typeof window === "undefined") return;
  const withTimestamp: ActiveSubscription = { ...sub, _syncedAt: Date.now() };
  localStorage.setItem(KEY, JSON.stringify(withTimestamp));
  // Keep the legacy wabizz_plan key in sync so older code paths still work.
  localStorage.setItem("wabizz_plan", sub.planId);
}

export function clearSubscription() {
  if (typeof window === "undefined") return;
  localStorage.removeItem(KEY);
  localStorage.removeItem("wabizz_plan");
}

export function getActivePlan(): PlanInfo | null {
  const sub = getSubscription();
  if (!sub) return null;
  return PLANS[sub.planId];
}

export function trialDaysLeft(sub: ActiveSubscription): number {
  if (sub.status !== "trial" || !sub.trialEndsAt) return 0;
  const ms = sub.trialEndsAt - Date.now();
  return Math.max(0, Math.ceil(ms / (1000 * 60 * 60 * 24)));
}

export function isTrialExpired(sub: ActiveSubscription): boolean {
  return sub.status === "trial" && !!sub.trialEndsAt && Date.now() > sub.trialEndsAt;
}

export function startTrialSubscription(planId: PlanId): ActiveSubscription {
  const now = Date.now();
  const sub: ActiveSubscription = {
    planId,
    status: "trial",
    startedAt: now,
    trialEndsAt: now + TRIAL_DAYS * 24 * 60 * 60 * 1000,
  };
  saveSubscription(sub);
  return sub;
}

export function activatePaidSubscription(planId: PlanId, paymentRef: string): ActiveSubscription {
  const sub: ActiveSubscription = {
    planId,
    status: "active",
    startedAt: Date.now(),
    paymentRef,
  };
  saveSubscription(sub);
  return sub;
}

/**
 * Sync the local subscription cache from a server response.
 * Call this after getMySubscription() succeeds to keep localStorage in sync with DB truth.
 */
export function syncSubscriptionFromServer(
  serverSub: {
    plan_id: string;
    status: string;
    trial_ends_at?: string | null;
    paystack_reference?: string | null;
  } | null,
): void {
  if (!serverSub) {
    clearSubscription();
    return;
  }
  if (!(serverSub.plan_id in PLANS)) return;
  const planId = serverSub.plan_id as PlanId;
  const status = serverSub.status === "active" ? "active" : "trial";
  const sub: ActiveSubscription = {
    planId,
    status,
    startedAt: Date.now(), // approximate; server has the real value
    trialEndsAt: serverSub.trial_ends_at ? new Date(serverSub.trial_ends_at).getTime() : undefined,
    paymentRef: serverSub.paystack_reference ?? undefined,
  };
  saveSubscription(sub);
}
