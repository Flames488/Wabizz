/**
 * business.service.ts — Business domain service
 *
 * Encapsulates all business profile operations with:
 *  - Cache integration (read-through, write-invalidate)
 *  - Error handling via WabizzError
 *  - Input validation
 *  - Audit logging
 *
 * Server functions (createServerFn) delegate to this service layer.
 * This makes the service independently testable.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { cache, CacheKeys, CacheTTL } from "@/lib/cache";
import { WabizzError } from "@/lib/server/error-handler";
import { logInfo } from "@/lib/server-logger";
import type { UpdateBusinessSchema } from "@/lib/server/validation";
import type { z } from "zod";

export interface BusinessProfile {
  id: string;
  owner_id: string;
  name: string;
  type: string;
  email: string;
  // FIX BUG 9: actual DB column is `whatsapp` (set during onboarding), NOT
  // `whatsapp_number` (which was never populated). The old interface caused
  // silent `undefined` on any code path that accessed `.whatsapp_number`
  // via this type even though TypeScript considered it valid.
  whatsapp: string | null;
  open_time: string;
  close_time: string;
  products_list: string | null;
  tone: string;
  custom_message: string | null;
  timezone: string | null;
  created_at: string;
  updated_at: string | null;
}

type UpdateFields = z.infer<typeof UpdateBusinessSchema>;

// ── Service class ─────────────────────────────────────────────────────────────

export const businessService = {
  /**
   * Get business by owner ID.
   * Uses read-through cache — DB hit only on miss.
   */
  async getByOwner(ownerId: string): Promise<BusinessProfile | null> {
    return cache.getOrSet(
      CacheKeys.businessByOwner(ownerId),
      async () => {
        const { data, error } = await supabaseAdmin
          .from("businesses")
          .select("*")
          .eq("owner_id", ownerId)
          .maybeSingle();

        if (error) throw WabizzError.db("getByOwner", error.message);
        return data as BusinessProfile | null;
      },
      { ttlSeconds: CacheTTL.business },
    );
  },

  /**
   * Get business by ID.
   */
  async getById(businessId: string): Promise<BusinessProfile | null> {
    return cache.getOrSet(
      CacheKeys.business(businessId),
      async () => {
        const { data, error } = await supabaseAdmin
          .from("businesses")
          .select("*")
          .eq("id", businessId)
          .maybeSingle();

        if (error) throw WabizzError.db("getById", error.message);
        return data as BusinessProfile | null;
      },
      { ttlSeconds: CacheTTL.business },
    );
  },

  /**
   * Upsert business profile (create or update).
   * Invalidates all related cache entries on success.
   */
  async upsert(ownerId: string, fields: UpdateFields, requestId: string): Promise<BusinessProfile> {
    const { data, error } = await supabaseAdmin
      .from("businesses")
      .upsert(
        { ...fields, owner_id: ownerId, custom_message: fields.custom_message ?? "" },
        { onConflict: "owner_id" },
      )
      .select()
      .single();

    if (error) throw WabizzError.db("upsert", error.message);

    // Invalidate caches
    await cache.del(CacheKeys.businessByOwner(ownerId));
    await cache.del(CacheKeys.business(data.id));

    await logInfo(
      "business.service",
      "Business upserted",
      {
        businessId: data.id,
        ownerId,
      },
      requestId,
    );

    return data as BusinessProfile;
  },

  /**
   * Partial update of business fields.
   * Invalidates related caches on success.
   */
  async update(
    ownerId: string,
    fields: Partial<UpdateFields>,
    requestId: string,
  ): Promise<BusinessProfile> {
    const { data, error } = await supabaseAdmin
      .from("businesses")
      .update(fields)
      .eq("owner_id", ownerId)
      .select()
      .single();

    if (error) throw WabizzError.db("update", error.message);

    await cache.del(CacheKeys.businessByOwner(ownerId));
    await cache.del(CacheKeys.business(data.id));

    await logInfo(
      "business.service",
      "Business updated",
      {
        businessId: data.id,
        fields: Object.keys(fields),
      },
      requestId,
    );

    return data as BusinessProfile;
  },
};

// ── Subscription service ──────────────────────────────────────────────────────

export const subscriptionService = {
  /**
   * Check if a business has an active subscription.
   * Uses a short-lived cache (2 min) — subscription status is checked frequently
   * (every AI call) so caching significantly reduces DB load.
   */
  async isActive(businessId: string): Promise<boolean> {
    const key = CacheKeys.subscription(businessId);
    const cached = await cache.get<boolean>(key);
    if (cached !== null) return cached;

    const { data } = await supabaseAdmin
      .from("subscriptions")
      .select("status, trial_ends_at")
      .eq("business_id", businessId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    let active = false;
    if (data) {
      if (data.status === "active") active = true;
      else if (data.status === "trial" && data.trial_ends_at) {
        active = new Date(data.trial_ends_at) > new Date();
      }
    }

    // Cache result — short TTL for trials (expiry matters), longer for active
    const ttl = data?.status === "trial" ? 60 : CacheTTL.subscription;
    await cache.set(key, active, { ttlSeconds: ttl });

    return active;
  },

  /** Invalidate subscription cache for a business (call after plan change). */
  async invalidate(businessId: string): Promise<void> {
    await cache.del(CacheKeys.subscription(businessId));
  },
};
