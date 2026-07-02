/**
 * dashboard.functions.ts — v2 (bug-fixed)
 *
 * Fix applied:
 *   PROBLEM 3 — The original query joined ALL messages for each conversation
 *               (`messages(content, created_at, role)` with no limit), meaning
 *               a 3-month-old business with 200 messages per conversation would
 *               fetch 2 000+ message rows just to render the dashboard list.
 *
 *               Fixed by reading `last_message_content` and `last_message_role`
 *               directly from the conversations table — columns that are now
 *               maintained by the `insertMessage` call in the webhook handler
 *               and back-filled by migration 20260425_006_v5_bugfixes.sql.
 *               Zero extra queries, O(1) payload size regardless of history depth.
 */

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const getDashboard = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { data: biz } = await supabase
      .from("businesses")
      .select("id, name")
      .eq("owner_id", userId)
      .maybeSingle();

    if (!biz) {
      return {
        businessName: null as string | null,
        stats: { conversationsToday: 0, ordersToday: 0, revenueToday: 0 },
        conversations: [] as Array<{
          id: string;
          customer_name: string | null;
          customer_number: string;
          last_message: string | null;
          last_message_at: string;
          status: string;
        }>,
      };
    }

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const sod = startOfDay.toISOString();

    const [convosToday, ordersToday, paidToday, recentConvos] = await Promise.all([
      supabase
        .from("conversations")
        .select("id", { count: "exact", head: true })
        .eq("business_id", biz.id)
        .gte("last_message_at", sod),
      supabase
        .from("orders")
        .select("id", { count: "exact", head: true })
        .eq("business_id", biz.id)
        .gte("created_at", sod),
      supabase
        .from("orders")
        .select("amount_naira")
        .eq("business_id", biz.id)
        .eq("status", "paid")
        .gte("paid_at", sod),
      // FIX PROBLEM 3: select last_message_content from conversations directly —
      // no messages join, no unbounded payload.
      supabase
        .from("conversations")
        .select("id, customer_name, customer_number, status, last_message_at, last_message_content")
        .eq("business_id", biz.id)
        .order("last_message_at", { ascending: false })
        .limit(10),
    ]);

    const revenueToday = (paidToday.data ?? []).reduce((sum, r) => sum + (r.amount_naira ?? 0), 0);

    const conversations = (recentConvos.data ?? []).map((c) => ({
      id: c.id,
      customer_name: c.customer_name,
      customer_number: c.customer_number,
      last_message: c.last_message_content ?? null,
      last_message_at: c.last_message_at,
      status: c.status,
    }));

    return {
      businessName: biz.name,
      stats: {
        conversationsToday: convosToday.count ?? 0,
        ordersToday: ordersToday.count ?? 0,
        revenueToday,
      },
      conversations,
    };
  });
