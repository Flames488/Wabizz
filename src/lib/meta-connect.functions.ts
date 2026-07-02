/**
 * meta-connect.functions.ts — Meta WhatsApp Embedded Signup server functions
 *
 * Called from the Settings page after the Facebook Login popup completes.
 * Exchanges the short-lived token for a long-lived one, fetches the
 * phone number ID and WABA ID, stores everything in Vault + DB.
 */

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { logError, logInfo } from "@/lib/server-logger";
import {
  exchangeForLongLivedToken,
  getWhatsAppAccountInfo,
  subscribePhoneToWebhook,
} from "@/lib/meta-whatsapp";
import { cache, CacheKeys } from "@/lib/cache";

const ConnectMetaInput = z.object({
  /** Short-lived access token from Facebook Login (Embedded Signup) */
  shortLivedToken: z.string().min(10),
  /** Phone number ID chosen by the user (passed back from the FB SDK) */
  phoneNumberId: z.string().optional(),
  /** WABA ID from the FB SDK callback */
  wabaId: z.string().optional(),
  /** User preference from Embedded Signup. Persisted only when Meta reports eligibility. */
  coexistenceEnabled: z.boolean().optional().default(false),
});

export const connectMetaWhatsApp = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => ConnectMetaInput.parse(input))
  .handler(async ({ data, context }) => {
    const requestId = crypto.randomUUID();
    const { supabase, userId } = context;
    const env = process.env as Record<string, string>;

    const appId = env["META_APP_ID"] ?? "";
    const appSecret = env["META_APP_SECRET"] ?? "";

    if (!appId || !appSecret) {
      return {
        ok: false,
        error: "Meta app credentials are not configured on the server. Contact support.",
        phoneNumber: null as string | null,
      };
    }

    // 1. Get business
    const { data: biz } = await supabase
      .from("businesses")
      .select("id, name")
      .eq("owner_id", userId)
      .maybeSingle();

    if (!biz) {
      return { ok: false, error: "Complete your business profile first.", phoneNumber: null };
    }

    try {
      // 2. Exchange short-lived token → long-lived token
      logInfo("meta-connect", "Exchanging token", { businessId: biz.id, requestId });
      const longLivedToken = await exchangeForLongLivedToken({
        shortLivedToken: data.shortLivedToken,
        appId,
        appSecret,
      });

      // 3. Resolve WABA and phone number via /me/whatsapp_business_accounts.
      const info = await getWhatsAppAccountInfo(
        longLivedToken,
        data.phoneNumberId,
        data.wabaId,
      );
      const coexistenceEnabled = Boolean(data.coexistenceEnabled && info.coexistenceEligible);

      // 4. Store long-lived token in Vault
      const vaultName = `meta_access_token_${biz.id}`;
      const { data: vaultRow, error: vaultErr } = await supabaseAdmin.rpc("upsert_vault_secret", {
        p_secret: longLivedToken,
        p_name: vaultName,
      });

      if (vaultErr) {
        logError("meta-connect", "Vault upsert failed", { error: vaultErr.message, requestId });
        return { ok: false, error: "Could not securely store your token. Please try again.", phoneNumber: null };
      }

      // 5. Upsert whatsapp_config
      const { error: dbErr } = await supabase.from("whatsapp_config").upsert(
        {
          business_id: biz.id,
          phone_number_id: info.phoneNumberId,
          waba_id: info.wabaId,
          business_manager_id: info.businessManagerId,
          access_token_vault_id: vaultRow as string,
          meta_access_token_vault_id: vaultRow as string,
          business_number: info.phoneNumber,
          meta_connected: true,
          connected_via: "meta_cloud_api",
          coexistence_eligible: info.coexistenceEligible,
          coexistence_enabled: coexistenceEnabled,
          connected_at: new Date().toISOString(),
          // Keep these nullable for Meta businesses (no 360Dialog key needed)
          dialog_api_key: "meta_cloud_api",
          dialog_api_key_vault_id: null,
        },
        { onConflict: "business_id" },
      );

      if (dbErr) {
        logError("meta-connect", "DB upsert failed", { error: dbErr.message, requestId });
        return { ok: false, error: dbErr.message, phoneNumber: null };
      }

      // 6. Subscribe to webhook
      try {
        await subscribePhoneToWebhook({ wabaId: info.wabaId, accessToken: longLivedToken });
      } catch (subErr) {
        // Non-fatal — webhook subscription can be retried from Meta dashboard
        logError("meta-connect", "Webhook subscription failed (non-fatal)", {
          error: String(subErr),
          requestId,
        });
      }

      // 7. Clear cache so next message uses new config
      await cache.del(`meta:biz:${info.phoneNumberId}`);
      await cache.del(`meta_phone_biz:${info.phoneNumberId}`);
      await cache.del(CacheKeys.whatsappConfig(info.phoneNumber));
      await cache.del(CacheKeys.whatsappApiKey(biz.id));

      logInfo("meta-connect", "Meta WhatsApp connected successfully", {
        businessId: biz.id,
        phoneNumberId: info.phoneNumberId,
        requestId,
      });

      return {
        ok: true,
        error: null as string | null,
        phoneNumber: info.phoneNumber,
        phoneNumberId: info.phoneNumberId,
        wabaId: info.wabaId,
        businessManagerId: info.businessManagerId,
        coexistenceEligible: info.coexistenceEligible,
        coexistenceEnabled,
        platformType: info.platformType,
      };
    } catch (err) {
      logError("meta-connect", "connectMetaWhatsApp failed", { error: String(err), requestId });
      return {
        ok: false,
        error: `Connection failed: ${err instanceof Error ? err.message : String(err)}`,
        phoneNumber: null,
      };
    }
  });

export const getMetaConnectionStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;

    const { data: biz } = await supabase
      .from("businesses")
      .select("id")
      .eq("owner_id", userId)
      .maybeSingle();

    if (!biz) return { connected: false, phoneNumber: null as string | null, status: null };

    const { data } = await supabase
      .from("whatsapp_config")
      .select(
        "meta_connected, business_number, phone_number_id, waba_id, business_manager_id, connected_via, coexistence_enabled, coexistence_eligible, connected_at",
      )
      .eq("business_id", biz.id)
      .maybeSingle();

    const connected = data?.meta_connected === true || data?.connected_via === "meta_cloud_api";
    return {
      connected,
      phoneNumber: data?.business_number ?? null,
      phoneNumberId: data?.phone_number_id ?? null,
      status: data
        ? {
            businessNumber: data.business_number,
            phoneNumberId: data.phone_number_id,
            wabaId: data.waba_id,
            businessManagerId: data.business_manager_id,
            connectedVia: data.connected_via,
            coexistenceEnabled: data.coexistence_enabled,
            coexistenceEligible: data.coexistence_eligible,
            connectedAt: data.connected_at,
          }
        : null,
    };
  });

export const disconnectMetaWhatsApp = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;

    const { data: biz } = await supabase
      .from("businesses")
      .select("id")
      .eq("owner_id", userId)
      .maybeSingle();

    if (!biz) return { ok: false, error: "Business not found." };

    const { error } = await supabase
      .from("whatsapp_config")
      .update({
        meta_connected: false,
        connected_via: "360dialog",
        coexistence_enabled: false,
        phone_number_id: null,
        waba_id: null,
        business_manager_id: null,
        meta_access_token_vault_id: null,
        access_token_vault_id: null,
      })
      .eq("business_id", biz.id);

    if (error) return { ok: false, error: error.message };
    return { ok: true, error: null as string | null };
  });
