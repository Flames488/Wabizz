/**
 * src/lib/niche/niche-loader.ts
 *
 * Loads active niche module configurations from Supabase for a given business.
 * Resolves Vault-stored API keys for the hospital module server-side.
 *
 * Used by both the twilio-webhook handler and the niche-router.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { logError, logInfo } from "@/lib/server-logger";
import { cache, CacheKeys, CacheTTL } from "@/lib/cache";
import type {
  ActiveNicheConfigs,
  HospitalNicheConfig,
  FoodTraderNicheConfig,
  NicheConfigRow,
} from "./types";

/**
 * Fetches all active niche configs for a business, including resolving Vault
 * secrets, and caches the result for 1 hour.
 *
 * PERF FIX: vault_read_secret is a Supabase RPC call that fired on every single
 * inbound WhatsApp message for hospital businesses. Vault secrets and niche
 * configs change essentially never (only on explicit admin save). Caching for
 * 1 hour eliminates the Vault round-trip from the hot webhook path entirely.
 * Call invalidateNicheConfigCache() from upsertNicheConfig / setNicheActive
 * so the cache stays coherent on changes.
 *
 * @param businessId - UUID of the business
 * @param requestId  - For structured logging correlation
 */
export async function getNicheConfigs(
  businessId: string,
  requestId = "niche-loader",
): Promise<ActiveNicheConfigs> {
  // ── Cache read ──────────────────────────────────────────────────────────
  const cacheKey = CacheKeys.nicheConfigs(businessId);
  const cached = await cache.get<ActiveNicheConfigs>(cacheKey);
  if (cached) {
    return cached;
  }

  const result: ActiveNicheConfigs = {};

  try {
    const { data: rows, error } = await supabaseAdmin
      .from("business_niche_configs")
      .select("*")
      .eq("business_id", businessId)
      .eq("is_active", true);

    if (error) {
      await logError(
        "niche-loader",
        "Failed to fetch niche configs",
        { businessId, error: error.message },
        requestId,
      );
      return result;
    }

    for (const row of (rows ?? []) as NicheConfigRow[]) {
      if (row.niche === "hospital") {
        const config = row.config as HospitalNicheConfig;
        let resolvedApiKey: string | undefined;

        // Resolve Vitar API key from Supabase Vault
        if (config.vitar_api_key_vault_name) {
          resolvedApiKey = await resolveVaultSecret(
            config.vitar_api_key_vault_name,
            businessId,
            requestId,
          );
        }

        result.hospital = {
          is_active: true,
          config,
          resolvedApiKey,
        };
      } else if (row.niche === "food_trader") {
        result.food_trader = {
          is_active: true,
          config: row.config as FoodTraderNicheConfig,
        };
      }
    }

    await logInfo(
      "niche-loader",
      "Niche configs loaded",
      {
        businessId,
        activeNiches: Object.keys(result),
      },
      requestId,
    );

    // ── Cache write ───────────────────────────────────────────────────────
    // Write even if result is empty — businesses with no niches should also
    // be cached so we don't hit Supabase on every message for them.
    await cache.set(cacheKey, result, { ttlSeconds: CacheTTL.nicheConfigs });
  } catch (err) {
    await logError(
      "niche-loader",
      "Unexpected error loading niche configs",
      { businessId, err: String(err) },
      requestId,
    );
  }

  return result;
}

/**
 * Invalidates the niche config cache for a business.
 * Must be called whenever upsertNicheConfig or setNicheActive writes to DB
 * so the 1-hour cache doesn't serve stale data after an admin config change.
 */
export async function invalidateNicheConfigCache(businessId: string): Promise<void> {
  await cache.del(CacheKeys.nicheConfigs(businessId));
}

/**
 * Reads a secret value from Supabase Vault by its secret name.
 * Returns undefined if the secret cannot be found or Vault is unavailable.
 */
async function resolveVaultSecret(
  secretName: string,
  businessId: string,
  requestId: string,
): Promise<string | undefined> {
  try {
    // Supabase Vault exposes secrets through a SQL function.
    // The service role key has permission to call vault.decrypted_secrets.
    const { data, error } = await supabaseAdmin.rpc("vault_read_secret", {
      secret_name: secretName,
    });

    if (error || !data) {
      await logError(
        "niche-loader",
        "Vault secret not found",
        { secretName, businessId, error: error?.message },
        requestId,
        "warn",
      );
      return undefined;
    }

    return data as string;
  } catch (err) {
    await logError(
      "niche-loader",
      "Vault read failed",
      { secretName, err: String(err) },
      requestId,
      "warn",
    );
    return undefined;
  }
}

/**
 * Upserts a niche config for a business.  Used by dashboard settings pages.
 * Does NOT store raw API keys — callers must store them in Vault first and
 * pass only the vault secret name inside `config`.
 */
export async function upsertNicheConfig(
  businessId: string,
  niche: "hospital" | "food_trader",
  config: HospitalNicheConfig | FoodTraderNicheConfig,
  requestId = "niche-loader",
): Promise<boolean> {
  const { error } = await supabaseAdmin
    .from("business_niche_configs")
    .upsert(
      { business_id: businessId, niche, config, is_active: true },
      { onConflict: "business_id,niche" },
    );

  if (error) {
    await logError(
      "niche-loader",
      "Failed to upsert niche config",
      { businessId, niche, error: error.message },
      requestId,
    );
    return false;
  }

  // Invalidate cache so the next message picks up the new config immediately
  await invalidateNicheConfigCache(businessId);
  return true;
}

/**
 * Enables or disables a niche module for a business without touching the config.
 */
export async function setNicheActive(
  businessId: string,
  niche: "hospital" | "food_trader",
  isActive: boolean,
  requestId = "niche-loader",
): Promise<boolean> {
  const { error } = await supabaseAdmin
    .from("business_niche_configs")
    .update({ is_active: isActive })
    .eq("business_id", businessId)
    .eq("niche", niche);

  if (error) {
    await logError(
      "niche-loader",
      "Failed to toggle niche active state",
      { businessId, niche, isActive, error: error.message },
      requestId,
    );
    return false;
  }

  await invalidateNicheConfigCache(businessId);
  return true;
}

/**
 * Reads the current conversation state JSON for a given conversation.
 * Returns an empty object if the state column is null or the row is not found.
 */
export async function getConversationState(
  conversationId: string,
  requestId = "niche-loader",
): Promise<Record<string, unknown>> {
  const { data, error } = await supabaseAdmin
    .from("conversations")
    .select("state")
    .eq("id", conversationId)
    .single();

  if (error || !data) {
    return {};
  }

  return (data.state as Record<string, unknown>) ?? {};
}

/**
 * Persists conversation state for multi-turn niche flows.
 */
export async function setConversationState(
  conversationId: string,
  state: Record<string, unknown>,
  requestId = "niche-loader",
): Promise<void> {
  const { error } = await supabaseAdmin
    .from("conversations")
    .update({ state })
    .eq("id", conversationId);

  if (error) {
    await logError(
      "niche-loader",
      "Failed to persist conversation state",
      { conversationId, error: error.message },
      requestId,
    );
  }
}
