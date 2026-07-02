import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { logError } from "@/lib/server-logger";
import { cache, CacheKeys, CacheTTL } from "@/lib/cache";

// Accepts both Paystack keys (pk_live_/pk_test_) and bank transfer encoded values (BANK:...)
const PaystackInput = z.object({
  publicKey: z.string().min(5).max(500),
  secretKey: z.string().min(5).max(500),
});

export const getPaystackStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { data: biz } = await supabase
      .from("businesses")
      .select("id")
      .eq("owner_id", userId)
      .maybeSingle();
    if (!biz) return { connected: false, publicKey: null as string | null };
    // Only return public_key — never return secret_key to the client.
    const { data } = await supabase
      .from("paystack_keys")
      .select("public_key, secret_key_vault_id")
      .eq("business_id", biz.id)
      .maybeSingle();
    return {
      connected: !!(data?.public_key && data?.secret_key_vault_id),
      publicKey: data?.public_key ?? null,
    };
  });

export const savePaystackKeys = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => PaystackInput.parse(input))
  .handler(async ({ data, context }) => {
    const requestId = crypto.randomUUID();
    const { supabase, userId } = context;
    const { data: biz } = await supabase
      .from("businesses")
      .select("id")
      .eq("owner_id", userId)
      .maybeSingle();
    if (!biz) return { ok: false, error: "Set up your business profile first." };

    try {
      // Store secret_key in Vault — never in a plain DB column.
      const vaultName = `paystack_sk_${biz.id}`;
      const { data: vaultRow, error: vaultErr } = await supabaseAdmin.rpc("upsert_vault_secret", {
        p_secret: data.secretKey,
        p_name: vaultName,
      });
      if (vaultErr) {
        await logError(
          "keys.functions",
          "Vault upsert failed for Paystack SK",
          {
            error: vaultErr.message,
            biz_id: biz.id,
          },
          requestId,
        );
        return { ok: false, error: "Could not securely store your secret key. Please try again." };
      }

      const { error } = await supabase.from("paystack_keys").upsert(
        {
          business_id: biz.id,
          public_key: data.publicKey,
          secret_key_vault_id: vaultRow as string,
        },
        { onConflict: "business_id" },
      );
      if (error) return { ok: false, error: error.message };
      await cache.del(CacheKeys.paystackSecretKey(biz.id));
      return { ok: true, error: null as string | null };
    } catch (e) {
      await logError(
        "keys.functions",
        "savePaystackKeys unexpected error",
        { error: String(e) },
        requestId,
      );
      return { ok: false, error: "Unexpected error saving keys." };
    }
  });

const WhatsAppInput = z.object({
  apiKey: z.string().min(10).max(500),
  // Accept E.164 Nigerian numbers only (normalized before saving)
  businessNumber: z.string().regex(/^\+234(70|80|81|90|91)\d{8}$/, "Invalid Nigerian WhatsApp number"),
});

export const getWhatsAppStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { data: biz } = await supabase
      .from("businesses")
      .select("id")
      .eq("owner_id", userId)
      .maybeSingle();
    if (!biz) return { connected: false, businessNumber: null as string | null };
    const { data } = await supabase
      .from("whatsapp_config")
      .select("business_number, dialog_api_key_vault_id")
      .eq("business_id", biz.id)
      .maybeSingle();
    return {
      connected: !!(data?.business_number && data?.dialog_api_key_vault_id),
      businessNumber: data?.business_number ?? null,
    };
  });

export const saveWhatsAppConfig = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => WhatsAppInput.parse(input))
  .handler(async ({ data, context }) => {
    const requestId = crypto.randomUUID();
    const { supabase, userId } = context;
    const { data: biz } = await supabase
      .from("businesses")
      .select("id")
      .eq("owner_id", userId)
      .maybeSingle();
    if (!biz) return { ok: false, error: "Set up your business profile first." };

    try {
      const vaultName = `whatsapp_api_key_${biz.id}`;
      const { data: vaultRow, error: vaultErr } = await supabaseAdmin.rpc("upsert_vault_secret", {
        p_secret: data.apiKey,
        p_name: vaultName,
      });
      if (vaultErr) {
        await logError(
          "keys.functions",
          "Vault upsert failed for WhatsApp API key",
          {
            error: vaultErr.message,
            biz_id: biz.id,
          },
          requestId,
        );
        return { ok: false, error: "Could not securely store your API key. Please try again." };
      }

      // businessNumber is already normalized to E.164 by the client before calling this fn
      const { error } = await supabase.from("whatsapp_config").upsert(
        {
          business_id: biz.id,
          dialog_api_key_vault_id: vaultRow as string,
          business_number: data.businessNumber,
        },
        { onConflict: "business_id" },
      );
      if (error) return { ok: false, error: error.message };
      await cache.del(CacheKeys.whatsappApiKey(biz.id));
      return { ok: true, error: null as string | null };
    } catch (e) {
      await logError(
        "keys.functions",
        "saveWhatsAppConfig unexpected error",
        { error: String(e) },
        requestId,
      );
      return { ok: false, error: "Unexpected error saving WhatsApp config." };
    }
  });

/**
 * Server-only helper: retrieve the Paystack secret key from Vault.
 * Never call this from a client-side function.
 */
export async function getPaystackSecretKey(businessId: string): Promise<string | null> {
  const cacheKey = CacheKeys.paystackSecretKey(businessId);
  const cached = await cache.get<string>(cacheKey);
  if (cached !== null) return cached;

  const { data } = await supabaseAdmin
    .from("paystack_keys")
    .select("secret_key_vault_id, secret_key")
    .eq("business_id", businessId)
    .maybeSingle();

  if (!data) return null;

  let secret: string | null = null;

  if (data.secret_key_vault_id) {
    const { data: vaultRow } = await supabaseAdmin
      .schema("vault")
      .from("decrypted_secrets")
      .select("decrypted_secret")
      .eq("id", data.secret_key_vault_id)
      .maybeSingle();
    secret = vaultRow?.decrypted_secret ?? null;
    if (!secret) {
      await logError("keys.functions", "Vault lookup returned null for Paystack SK", {
        businessId,
        vault_id: data.secret_key_vault_id,
      });
    }
  } else {
    secret = (data as { secret_key?: string }).secret_key ?? null;
  }

  if (secret) await cache.set(cacheKey, secret, { ttlSeconds: CacheTTL.paystackSecretKey });
  return secret;
}

/**
 * Server-only helper: retrieve the 360dialog API key from Vault.
 */
export async function getWhatsAppApiKey(businessId: string): Promise<string | null> {
  const cacheKey = CacheKeys.whatsappApiKey(businessId);
  const cached = await cache.get<string>(cacheKey);
  if (cached !== null) return cached;

  const { data } = await supabaseAdmin
    .from("whatsapp_config")
    .select("dialog_api_key_vault_id, dialog_api_key")
    .eq("business_id", businessId)
    .maybeSingle();

  if (!data) return null;

  let secret: string | null = null;

  if ((data as { dialog_api_key_vault_id?: string }).dialog_api_key_vault_id) {
    const vaultId = (data as { dialog_api_key_vault_id: string }).dialog_api_key_vault_id;
    const { data: vaultRow } = await supabaseAdmin
      .schema("vault")
      .from("decrypted_secrets")
      .select("decrypted_secret")
      .eq("id", vaultId)
      .maybeSingle();
    secret = vaultRow?.decrypted_secret ?? null;
    if (!secret) {
      await logError("keys.functions", "Vault lookup returned null for WhatsApp API key", {
        businessId,
        vault_id: vaultId,
      });
    }
  } else {
    secret = (data as { dialog_api_key?: string }).dialog_api_key ?? null;
  }

  if (secret) await cache.set(cacheKey, secret, { ttlSeconds: CacheTTL.whatsappApiKey });
  return secret;
}
