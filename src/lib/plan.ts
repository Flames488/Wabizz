export type PlanId = "starter" | "growth" | "pro";

export type PlanInfo = {
  id: PlanId;
  name: string;
  amountNaira: number;
};

export const PLANS: Record<PlanId, PlanInfo> = {
  starter: { id: "starter", name: "Starter", amountNaira: 5000 },
  growth: { id: "growth", name: "Growth", amountNaira: 12000 },
  pro: { id: "pro", name: "Pro", amountNaira: 25000 },
};

const KEY = "wabizz_plan";

export function getSavedPlan(): PlanInfo | null {
  if (typeof window === "undefined") return null;
  const id = localStorage.getItem(KEY) as PlanId | null;
  if (!id || !(id in PLANS)) return null;
  return PLANS[id];
}
