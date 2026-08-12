/**
 * message-templates.functions.ts — WhatsApp template submission & status
 *
 * Submitting a template only queues it for Meta's review (status: pending).
 * Approval itself happens on Meta's side — hours to days, cannot be
 * triggered by code. refreshTemplateStatus polls Meta for the current
 * status once a decision has been made.
 *
 * A template must reach status="approved" before /api/send will accept it
 * for a cold first-contact send.
 */

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { logError, logInfo } from "@/lib/server-logger";
import { createMessageTemplate, getMessageTemplateStatus } from "@/lib/meta-whatsapp";

async function getMetaCredentials(businessId: string) {
  const { data } = await supabaseAdmin
    .from("whatsapp_config")
    .select("connected_via, waba_id, meta_access_token_vault_id, access_token_vault_id")
    .eq("business_id", businessId)
    .maybeSingle();

  if (!data || data.connected_via !== "meta_cloud_api" || !data.waba_id) return null;
  const vaultId = data.meta_access_token_vault_id ?? data.access_token_vault_id;
  if (!vaultId) return null;

  const { data: vaultRow } = await supabaseAdmin
    .schema("vault")
    .from("decrypted_secrets")
    .select("decrypted_secret")
    .eq("id", vaultId)
    .maybeSingle();

  if (!vaultRow?.decrypted_secret) return null;
  return { wabaId: data.waba_id as string, accessToken: vaultRow.decrypted_secret as string };
}

const SubmitTemplateInput = z.object({
  name: z.string().min(1).max(512).regex(/^[a-z0-9_]+$/, "Template name must be lowercase letters, numbers, and underscores only"),
  language: z.string().min(2).max(10).default("en"),
  category: z.enum(["UTILITY", "MARKETING", "AUTHENTICATION"]).default("UTILITY"),
  components: z.array(z.unknown()).min(1),
});

export const submitMessageTemplate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => SubmitTemplateInput.parse(input))
  .handler(async ({ data, context }) => {
    const requestId = crypto.randomUUID();
    const { supabase, userId } = context;

    const { data: biz } = await supabase.from("businesses").select("id").eq("owner_id", userId).maybeSingle();
    if (!biz) return { ok: false, error: "Complete your business profile first.", template: null };

    const creds = await getMetaCredentials(biz.id);
    if (!creds) {
      return {
        ok: false,
        error: "Connect a WhatsApp number via Meta Embedded Signup first (Settings). Templates require a Meta Cloud API connection.",
        template: null,
      };
    }

    try {
      const result = await createMessageTemplate({
        wabaId: creds.wabaId,
        accessToken: creds.accessToken,
        name: data.name,
        language: data.language,
        category: data.category,
        components: data.components,
      });

      const { data: row, error: dbErr } = await supabaseAdmin
        .from("message_templates")
        .upsert(
          {
            business_id: biz.id,
            name: data.name,
            language: data.language,
            category: data.category,
            components: data.components,
            status: result.status.toLowerCase(),
            meta_template_id: result.id,
            submitted_at: new Date().toISOString(),
          },
          { onConflict: "business_id,name,language" },
        )
        .select()
        .single();

      if (dbErr) {
        logError("message-templates", "DB upsert failed after Meta submission", { error: dbErr.message, requestId });
        return { ok: false, error: dbErr.message, template: null };
      }

      logInfo("message-templates", "Template submitted to Meta", { businessId: biz.id, name: data.name, requestId });
      return { ok: true, error: null as string | null, template: row };
    } catch (e) {
      logError("message-templates", "Template submission failed", { error: String(e), requestId });
      return { ok: false, error: e instanceof Error ? e.message : String(e), template: null };
    }
  });

const RefreshStatusInput = z.object({ templateId: z.string().uuid() });

export const refreshTemplateStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => RefreshStatusInput.parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: biz } = await supabase.from("businesses").select("id").eq("owner_id", userId).maybeSingle();
    if (!biz) return { ok: false, error: "Business not found.", status: null as string | null };

    const { data: tmpl } = await supabase
      .from("message_templates")
      .select("id, name")
      .eq("id", data.templateId)
      .eq("business_id", biz.id)
      .maybeSingle();
    if (!tmpl) return { ok: false, error: "Template not found.", status: null };

    const creds = await getMetaCredentials(biz.id);
    if (!creds) return { ok: false, error: "No Meta connection.", status: null };

    const meta = await getMessageTemplateStatus({ wabaId: creds.wabaId, accessToken: creds.accessToken, name: tmpl.name });
    if (!meta) return { ok: false, error: "Could not fetch status from Meta.", status: null };

    const status = meta.status.toLowerCase();
    await supabaseAdmin
      .from("message_templates")
      .update({ status, rejection_reason: meta.rejectedReason, reviewed_at: new Date().toISOString() })
      .eq("id", tmpl.id);

    return { ok: true, error: null as string | null, status };
  });

export const listMessageTemplates = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { data: biz } = await supabase.from("businesses").select("id").eq("owner_id", userId).maybeSingle();
    if (!biz) return { templates: [] };

    const { data } = await supabase
      .from("message_templates")
      .select("id, name, language, category, status, rejection_reason, submitted_at, reviewed_at")
      .eq("business_id", biz.id)
      .order("created_at", { ascending: false });

    return { templates: data ?? [] };
  });
