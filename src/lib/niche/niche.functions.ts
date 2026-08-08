/**
 * src/lib/niche/niche.functions.ts
 *
 * TanStack Start server functions for niche module config saves and toggle.
 *
 * WHY THIS FILE EXISTS:
 * Both hospital.tsx (settings save) and niche/index.tsx (toggle) were writing
 * directly to Supabase from the browser.  This bypassed upsertNicheConfig() and
 * setNicheActive() in niche-loader.ts — the only places that call
 * invalidateNicheConfigCache().  The consequence: after a business owner saved
 * a new Vitar API key or toggled a module, the in-process cache served the OLD
 * config for up to 1 hour, so WhatsApp messages kept hitting the wrong Vitar
 * endpoint / treating the module as still-inactive / still-active.
 *
 * FIX: All niche writes go through these server functions.  They use
 * supabaseAdmin (service-role key) to write, then call invalidateNicheConfigCache()
 * so the next inbound WhatsApp message always picks up the latest config.
 */

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { upsertNicheConfig, setNicheActive } from "./niche-loader";
import type { HospitalNicheConfig, FoodTraderNicheConfig } from "./types";

// ── saveHospitalConfig ────────────────────────────────────────────────────────

const SaveHospitalConfigInput = z.object({
  vitar_api_url: z.string().url("Vitar API URL must be a valid URL"),
  vitar_api_key_vault_name: z.string(),
  vitar_clinic_id: z.string(),
  clinic_name: z.string().min(1, "Clinic name is required"),
  currency: z.string().default("NGN"),
  services: z.array(z.string()),
  clinic_phone: z.string().default(""),
});

export type SaveHospitalConfigInput = z.infer<typeof SaveHospitalConfigInput>;

/**
 * Saves hospital niche config via the server so cache invalidation fires.
 * Does NOT handle Vault storage — callers must have already stored the raw
 * API key in Vault and pass only the vault secret name here.
 */
export const saveHospitalConfig = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(SaveHospitalConfigInput)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    // Resolve business_id from the authenticated user
    const { data: biz, error: bizError } = await supabase
      .from("businesses")
      .select("id")
      .eq("owner_id", userId)
      .single();

    if (bizError || !biz) {
      return { success: false, error: "Business not found" };
    }

    const config: HospitalNicheConfig = {
      vitar_api_url: data.vitar_api_url,
      vitar_api_key_vault_name: data.vitar_api_key_vault_name,
      vitar_clinic_id: data.vitar_clinic_id,
      clinic_name: data.clinic_name,
      currency: data.currency,
      services: data.services,
      clinic_phone: data.clinic_phone,
    };

    // upsertNicheConfig writes via supabaseAdmin and calls
    // invalidateNicheConfigCache() — the browser-direct write previously did neither.
    const ok = await upsertNicheConfig(biz.id, "hospital", config);
    if (!ok) {
      return { success: false, error: "Failed to save config. Please try again." };
    }

    return { success: true };
  });

// ── saveFoodTraderConfig ──────────────────────────────────────────────────────

const SaveFoodTraderConfigInput = z.object({
  business_name: z.string().min(1, "Business name is required"),
  menu_table_id: z.string().optional(),
  order_cutoff: z.string().optional(),
  delivery_areas: z.array(z.string()).optional(),
  business_phone: z.string().optional(),
});

export type SaveFoodTraderConfigInput = z.infer<typeof SaveFoodTraderConfigInput>;

export const saveFoodTraderConfig = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(SaveFoodTraderConfigInput)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    const { data: biz, error: bizError } = await supabase
      .from("businesses")
      .select("id")
      .eq("owner_id", userId)
      .single();

    if (bizError || !biz) {
      return { success: false, error: "Business not found" };
    }

    const config: FoodTraderNicheConfig = {
      business_name: data.business_name,
      menu_table_id: data.menu_table_id,
      order_cutoff: data.order_cutoff,
      delivery_areas: data.delivery_areas,
      business_phone: data.business_phone,
    };

    const ok = await upsertNicheConfig(biz.id, "food_trader", config);
    if (!ok) {
      return { success: false, error: "Failed to save config. Please try again." };
    }

    return { success: true };
  });

// ── toggleNicheActive ─────────────────────────────────────────────────────────

const ToggleNicheInput = z.object({
  niche: z.enum(["hospital", "food_trader"]),
  is_active: z.boolean(),
});

export type ToggleNicheInput = z.infer<typeof ToggleNicheInput>;

/**
 * Enables or disables a niche module.  Invalidates cache via setNicheActive()
 * so the new state takes effect on the next inbound WhatsApp message.
 */
export const toggleNicheActive = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(ToggleNicheInput)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    const { data: biz, error: bizError } = await supabase
      .from("businesses")
      .select("id")
      .eq("owner_id", userId)
      .single();

    if (bizError || !biz) {
      return { success: false, error: "Business not found" };
    }

    const ok = await setNicheActive(biz.id, data.niche, data.is_active);
    if (!ok) {
      return { success: false, error: "Failed to update module status. Please try again." };
    }

    return { success: true };
  });
