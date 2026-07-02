/**
 * conversation.functions.ts
 *
 * Server functions for the conversation detail view.
 * Fetches the full message thread for a single conversation,
 * scoped to the authenticated business owner.
 */

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const getConversationDetail = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  // FIX BUG 7: was .validator() — every other server fn uses .inputValidator().
  // .validator() may not exist on this version of the server fn builder,
  // causing a runtime throw on first call to this endpoint.
  .inputValidator((input: unknown) => z.object({ conversationId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    // 1. Resolve the business that belongs to this user
    const { data: biz } = await supabase
      .from("businesses")
      .select("id")
      .eq("owner_id", userId)
      .maybeSingle();

    if (!biz) {
      return { ok: false as const, error: "Business not found" };
    }

    // 2. Load the conversation — verify it belongs to this business
    const { data: convo } = await supabase
      .from("conversations")
      .select("id, customer_name, customer_number, status, last_message_at, created_at")
      .eq("id", data.conversationId)
      .eq("business_id", biz.id)
      .maybeSingle();

    if (!convo) {
      return { ok: false as const, error: "Conversation not found" };
    }

    // 3. Load full message history (up to 200 messages, ascending for display)
    const { data: messages } = await supabase
      .from("messages")
      .select("id, role, content, created_at")
      .eq("conversation_id", data.conversationId)
      .order("created_at", { ascending: true })
      .limit(200);

    return {
      ok: true as const,
      conversation: convo,
      messages: messages ?? [],
    };
  });

/** Mark a conversation as resolved / back to handled */
export const resolveConversation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  // FIX BUG 7: was .validator() — see getConversationDetail for explanation.
  .inputValidator((input: unknown) => z.object({ conversationId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    const { data: biz } = await supabase
      .from("businesses")
      .select("id")
      .eq("owner_id", userId)
      .maybeSingle();

    if (!biz) return { ok: false as const, error: "Business not found" };

    const { error } = await supabase
      .from("conversations")
      .update({ status: "handled" })
      .eq("id", data.conversationId)
      .eq("business_id", biz.id);

    if (error) return { ok: false as const, error: error.message };
    return { ok: true as const };
  });
