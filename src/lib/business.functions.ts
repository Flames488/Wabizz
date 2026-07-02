/**
 * business.functions.ts — v2 (bug-fixed)
 *
 * Fix applied:
 *   CONCERN 4 — `upsertMyBusiness` was calling Supabase directly without
 *               touching the cache, so an owner who updated their business
 *               profile would see stale data for up to 5 minutes on the next
 *               webhook hit (the cache TTL for business records).
 *
 *               Fixed: after every upsert or update we now explicitly invalidate
 *               both cache keys (by owner and by business ID) so the next read
 *               always goes back to the DB.
 */

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { cache, CacheKeys } from "@/lib/cache";

const ToneEnum = z.enum(["Professional", "Friendly", "Pidgin"]);

const BusinessInput = z.object({
  name: z.string().trim().min(1).max(200),
  type: z.string().trim().min(1).max(100),
  email: z.string().trim().email().max(255),
  // E.164 Nigerian number (+234 + 10 digits starting with 70/80/81/90/91).
  // The frontend normalizes local (080…) input to E.164 before calling this fn.
  whatsapp: z
    .string()
    .trim()
    .regex(
      /^\+234(70|80|81|90|91)\d{8}$/,
      "WhatsApp number must be a valid Nigerian E.164 number (+234XXXXXXXXXX)",
    ),
  open_time: z.string().regex(/^\d{2}:\d{2}$/),
  close_time: z.string().regex(/^\d{2}:\d{2}$/),
  products_list: z.string().max(10000).default(""),
  tone: ToneEnum.default("Friendly"),
  custom_message: z.string().max(2000).optional().default(""),
  // FIX BUG 6: expose timezone field so business owners can actually set it.
  // Migration 012 added the column and the webhook reads it, but the input
  // schema never included it — every business stayed on Africa/Lagos forever.
  timezone: z.string().max(100).optional().default("Africa/Lagos"),
});

export const getMyBusiness = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase } = context;
    const { data, error } = await supabase.from("businesses").select("*").maybeSingle();
    if (error) return { business: null, error: error.message };
    return { business: data, error: null as string | null };
  });

export const upsertMyBusiness = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => BusinessInput.parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: row, error } = await supabase
      .from("businesses")
      .upsert(
        { ...data, owner_id: userId, custom_message: data.custom_message ?? "" },
        { onConflict: "owner_id" },
      )
      .select()
      .single();
    if (error) return { business: null, error: error.message };

    // FIX CONCERN 4: invalidate both cache keys so the webhook handler doesn't
    // serve stale business data after an onboarding update.
    await Promise.all([
      cache.del(CacheKeys.businessByOwner(userId)),
      cache.del(CacheKeys.business(row.id)),
    ]);

    return { business: row, error: null as string | null };
  });

const UpdateBusinessInput = BusinessInput.partial();

export const updateMyBusiness = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => UpdateBusinessInput.parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: row, error } = await supabase
      .from("businesses")
      .update(data)
      .eq("owner_id", userId)
      .select()
      .single();
    if (error) return { business: null, error: error.message };

    // FIX CONCERN 4: same invalidation for partial updates
    await Promise.all([
      cache.del(CacheKeys.businessByOwner(userId)),
      cache.del(CacheKeys.business(row.id)),
    ]);

    return { business: row, error: null as string | null };
  });
