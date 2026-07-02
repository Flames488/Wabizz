/**
 * automation.functions.ts — Keyword-triggered auto-reply rules
 *
 * Rules are matched inside twilio-handler.ts on every inbound WhatsApp message.
 * When a keyword matches, a send_automation_step job is enqueued — never a
 * synchronous API call on the webhook path (keeps webhook response < 100ms).
 *
 * Match modes:
 *   exact      → message equals keyword (case-insensitive)
 *   contains   → message contains keyword anywhere
 *   starts_with → message starts with keyword
 *
 * Action types:
 *   reply     → send replyTemplate to the sender
 *   tag       → add addTags to the contact record
 *   opt_out   → mark contact opted_out = true (GDPR / DND)
 *
 * Priority: rules are sorted by priority DESC — highest priority matches first.
 * Only the first matching rule fires per message.
 */

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { logError, logInfo } from "@/lib/server-logger";

// ── Validators ────────────────────────────────────────────────────────────────

const RuleInput = z.object({
  name: z.string().min(1).max(100),
  isActive: z.boolean().default(true),
  priority: z.number().int().min(0).max(100).default(0),
  triggerType: z.enum(["keyword", "no_reply", "opt_out"]).default("keyword"),
  keywords: z.array(z.string().min(1).max(100)).max(20).default([]),
  matchMode: z.enum(["exact", "contains", "starts_with"]).default("contains"),
  actionType: z.enum(["reply", "tag", "opt_out"]).default("reply"),
  replyTemplate: z.string().max(4096).optional(),
  addTags: z.array(z.string().max(50)).max(10).default([]),
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getBusinessId(userId: string): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from("businesses")
    .select("id")
    .eq("owner_id", userId)
    .maybeSingle();
  return data?.id ?? null;
}

// ── Server functions ──────────────────────────────────────────────────────────

export const createAutomationRule = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => RuleInput.parse(input))
  .handler(async ({ data, context }) => {
    const { userId } = context;
    const requestId = crypto.randomUUID();

    if (data.actionType === "reply" && !data.replyTemplate?.trim()) {
      return {
        ok: false as const,
        error: "Reply template is required for 'reply' actions.",
        rule: null,
      };
    }
    if (data.triggerType === "keyword" && data.keywords.length === 0) {
      return { ok: false as const, error: "At least one keyword is required.", rule: null };
    }

    const businessId = await getBusinessId(userId);
    if (!businessId) return { ok: false as const, error: "No business profile found.", rule: null };

    const { data: row, error } = await supabaseAdmin
      .from("automation_rules")
      .insert({
        business_id: businessId,
        name: data.name,
        is_active: data.isActive,
        priority: data.priority,
        trigger_type: data.triggerType,
        keywords: data.keywords.map((k) => k.toLowerCase()),
        match_mode: data.matchMode,
        action_type: data.actionType,
        reply_template: data.replyTemplate ?? null,
        add_tags: data.addTags,
      })
      .select(
        "id, name, is_active, priority, trigger_type, keywords, match_mode, action_type, reply_template, add_tags, match_count, created_at",
      )
      .single();

    if (error) {
      logError("automation.functions", "createRule failed", { error: error.message }, requestId);
      return { ok: false as const, error: "Failed to create rule.", rule: null };
    }

    logInfo(
      "automation.functions",
      "Automation rule created",
      { businessId, ruleId: row.id },
      requestId,
    );
    return { ok: true as const, rule: row, error: null as string | null };
  });

export const listAutomationRules = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { userId } = context;

    const businessId = await getBusinessId(userId);
    if (!businessId) return { rules: [] };

    const { data } = await supabaseAdmin
      .from("automation_rules")
      .select(
        "id, name, is_active, priority, trigger_type, keywords, match_mode, action_type, reply_template, add_tags, match_count, created_at",
      )
      .eq("business_id", businessId)
      .order("priority", { ascending: false })
      .order("created_at", { ascending: true });

    return { rules: data ?? [] };
  });

export const updateAutomationRule = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => {
    return z.object({ id: z.string().uuid() }).merge(RuleInput.partial()).parse(input);
  })
  .handler(async ({ data, context }) => {
    const { userId } = context;
    const requestId = crypto.randomUUID();

    const businessId = await getBusinessId(userId);
    if (!businessId) return { ok: false as const, error: "No business profile found." };

    const {
      id,
      name,
      isActive,
      priority,
      triggerType,
      keywords,
      matchMode,
      actionType,
      replyTemplate,
      addTags,
    } = data;

    const updates: Record<string, unknown> = {};
    if (name !== undefined) updates.name = name;
    if (isActive !== undefined) updates.is_active = isActive;
    if (priority !== undefined) updates.priority = priority;
    if (triggerType !== undefined) updates.trigger_type = triggerType;
    if (keywords !== undefined) updates.keywords = keywords.map((k) => k.toLowerCase());
    if (matchMode !== undefined) updates.match_mode = matchMode;
    if (actionType !== undefined) updates.action_type = actionType;
    if (replyTemplate !== undefined) updates.reply_template = replyTemplate;
    if (addTags !== undefined) updates.add_tags = addTags;

    const { error } = await supabaseAdmin
      .from("automation_rules")
      .update(updates)
      .eq("id", id)
      .eq("business_id", businessId);

    if (error) {
      logError("automation.functions", "updateRule failed", { error: error.message }, requestId);
      return { ok: false as const, error: "Failed to update rule." };
    }

    return { ok: true as const, error: null as string | null };
  });

export const toggleAutomationRule = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ id: z.string().uuid(), isActive: z.boolean() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { userId } = context;

    const businessId = await getBusinessId(userId);
    if (!businessId) return { ok: false as const, error: "No business profile found." };

    const { error } = await supabaseAdmin
      .from("automation_rules")
      .update({ is_active: data.isActive })
      .eq("id", data.id)
      .eq("business_id", businessId);

    if (error) return { ok: false as const, error: "Failed to toggle rule." };
    return { ok: true as const, error: null as string | null };
  });

export const deleteAutomationRule = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { userId } = context;
    const requestId = crypto.randomUUID();

    const businessId = await getBusinessId(userId);
    if (!businessId) return { ok: false as const, error: "No business profile found." };

    const { error } = await supabaseAdmin
      .from("automation_rules")
      .delete()
      .eq("id", data.id)
      .eq("business_id", businessId);

    if (error) {
      logError("automation.functions", "deleteRule failed", { error: error.message }, requestId);
      return { ok: false as const, error: "Failed to delete rule." };
    }

    return { ok: true as const, error: null as string | null };
  });

/**
 * Server-only helper: match a message body against a business's active rules.
 * Called from twilio-handler.ts on every inbound message.
 * Returns the first matching rule, or null if no rules match.
 */
export async function matchAutomationRule(
  businessId: string,
  messageBody: string,
): Promise<{
  ruleId: string;
  actionType: string;
  replyTemplate: string | null;
  addTags: string[];
} | null> {
  const { data: rules } = await supabaseAdmin
    .from("automation_rules")
    .select("id, trigger_type, keywords, match_mode, action_type, reply_template, add_tags")
    .eq("business_id", businessId)
    .eq("is_active", true)
    .eq("trigger_type", "keyword")
    .order("priority", { ascending: false })
    .limit(50);

  if (!rules || rules.length === 0) return null;

  const body = messageBody.toLowerCase().trim();

  for (const rule of rules) {
    const keywords = (rule.keywords as string[]) ?? [];
    const mode = rule.match_mode as string;

    const matched = keywords.some((kw) => {
      switch (mode) {
        case "exact":
          return body === kw;
        case "starts_with":
          return body.startsWith(kw);
        case "contains":
        default:
          return body.includes(kw);
      }
    });

    if (matched) {
      return {
        ruleId: rule.id as string,
        actionType: rule.action_type as string,
        replyTemplate: rule.reply_template as string | null,
        addTags: (rule.add_tags as string[]) ?? [],
      };
    }
  }

  return null;
}
