/**
 * src/lib/niche/niche-router.ts
 *
 * Top-level niche dispatcher.  Called from the twilio-webhook handler after the
 * base Wabizz intent resolver runs.  Returns a reply string if a niche handled
 * the message, or null if Wabizz's generic response should be used.
 *
 * Integration point (see Section 6.1 of the tech spec):
 *
 *   const nicheConfigs = await getNicheConfigs(businessId);
 *   const nicheReply = await routeToNiche(message, conversationId, nicheConfigs, requestId);
 *   if (nicheReply !== null) return nicheReply;
 *   // fall through to generic Wabizz response
 */

import { logInfo, logError } from "@/lib/server-logger";
import type { ActiveNicheConfigs } from "./types";
import { handleHospitalMessage } from "./hospital/hospital-intent-handler";
import { handleFoodMessage } from "./food/food-intent-handler";

export interface NicheRouterPayload {
  businessId: string;
  conversationId: string;
  customerPhone: string;
  customerName: string | null;
  message: string;
  nicheConfigs: ActiveNicheConfigs;
  requestId: string;
}

/**
 * Routes an inbound WhatsApp message to the appropriate niche handler.
 *
 * Evaluation order:
 *   1. Hospital module — if active and message matches a hospital intent
 *   2. Food trader module — if active and message matches a food intent
 *   3. Returns null → caller uses the generic Wabizz AI response
 *
 * @returns Reply string if a niche handled it, null otherwise.
 */
export async function routeToNiche(payload: NicheRouterPayload): Promise<string | null> {
  const { businessId, nicheConfigs, message, requestId } = payload;

  try {
    // ── 1. Hospital module ─────────────────────────────────────────────────
    if (nicheConfigs.hospital?.is_active) {
      if (!nicheConfigs.hospital.resolvedApiKey) {
        await logError(
          "niche-router",
          "Hospital niche active but Vault API key not resolved — skipping",
          { businessId },
          requestId,
          "warn",
        );
      } else {
        const reply = await handleHospitalMessage({
          ...payload,
          hospitalConfig: nicheConfigs.hospital.config,
          vitarApiKey: nicheConfigs.hospital.resolvedApiKey,
        });

        if (reply !== null) {
          await logInfo(
            "niche-router",
            "Hospital module handled message",
            { businessId, conversationId: payload.conversationId },
            requestId,
          );
          return reply;
        }
      }
    }

    // ── 2. Food trader module ──────────────────────────────────────────────
    if (nicheConfigs.food_trader?.is_active) {
      const reply = await handleFoodMessage({
        ...payload,
        foodConfig: nicheConfigs.food_trader.config,
      });

      if (reply !== null) {
        await logInfo(
          "niche-router",
          "Food trader module handled message",
          { businessId, conversationId: payload.conversationId },
          requestId,
        );
        return reply;
      }
    }
  } catch (err) {
    // Niche errors must NEVER crash the main webhook flow.
    // Log and fall through to the generic Wabizz response.
    await logError(
      "niche-router",
      "Niche router threw — falling through to generic response",
      { businessId, err: String(err) },
      requestId,
      "error",
    );
  }

  return null;
}
