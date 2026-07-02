/**
 * campaign.functions.ts — Campaign engine server functions
 *
 * Campaigns are the "autonomous machine" layer: create a campaign, point it at
 * a contact segment, schedule it, and the queue worker sends messages
 * automatically with rate limiting, idempotency, and DLQ safety.
 *
 * Lifecycle:
 *   draft → scheduled → running → completed | failed
 *                              ↗ paused → running (resume)
 *
 * On launch:
 *   1. Validates business has an active WhatsApp sender.
 *   2. Calls populate_campaign_contacts() DB function to materialise
 *      the contact list (respects opt-outs, tags, and target_contact_ids).
 *   3. Enqueues `send_campaign_batch` jobs in chunks of batch_size.
 *   4. Sets campaign status = 'running'.
 *
 * Rate limiting:
 *   The queue consumer honours messages_per_min per campaign.
 *   Each batch job delays itself so total throughput ≤ messages_per_min.
 */

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { logError, logInfo } from "@/lib/server-logger";
import { enqueue } from "@/lib/queue";

// ── Validators ────────────────────────────────────────────────────────────────

const CampaignInput = z.object({
  name: z.string().min(1).max(100),
  messageTemplate: z.string().min(1).max(4096),
  mediaUrl: z.string().url().optional(),
  targetContactIds: z.array(z.string().uuid()).optional(),
  targetTags: z.array(z.string()).optional(),
  scheduledAt: z.string().datetime().optional(),
  timezone: z.string().default("Africa/Lagos"),
  sendWindowStart: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .default("08:00"),
  sendWindowEnd: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .default("20:00"),
  batchSize: z.number().int().min(10).max(500).default(100),
  messagesPerMin: z.number().int().min(1).max(60).default(60),
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

async function hasWhatsAppSender(businessId: string): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from("whatsapp_config")
    .select("connected_via, phone_number_id, meta_access_token_vault_id, access_token_vault_id, dialog_api_key_vault_id")
    .eq("business_id", businessId)
    .maybeSingle();

  if (data?.connected_via === "meta_cloud_api") {
    return Boolean(
      data.phone_number_id &&
        (data.meta_access_token_vault_id ?? data.access_token_vault_id),
    );
  }

  return Boolean((data as { dialog_api_key_vault_id?: string | null } | null)?.dialog_api_key_vault_id);
}

async function assertOwnsCampaign(campaignId: string, businessId: string): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from("campaigns")
    .select("id")
    .eq("id", campaignId)
    .eq("business_id", businessId)
    .maybeSingle();
  return !!data;
}

// ── Server functions ──────────────────────────────────────────────────────────

export const createCampaign = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => CampaignInput.parse(input))
  .handler(async ({ data, context }) => {
    const { userId } = context;
    const requestId = crypto.randomUUID();

    const businessId = await getBusinessId(userId);
    if (!businessId)
      return { ok: false as const, error: "No business profile found.", campaign: null };

    const { data: row, error } = await supabaseAdmin
      .from("campaigns")
      .insert({
        business_id: businessId,
        name: data.name,
        message_template: data.messageTemplate,
        media_url: data.mediaUrl ?? null,
        target_contact_ids: data.targetContactIds ?? null,
        target_tags: data.targetTags ?? null,
        scheduled_at: data.scheduledAt ?? null,
        timezone: data.timezone,
        send_window_start: data.sendWindowStart,
        send_window_end: data.sendWindowEnd,
        batch_size: data.batchSize,
        messages_per_min: data.messagesPerMin,
        status: data.scheduledAt ? "scheduled" : "draft",
        created_by: userId,
      })
      .select("id, name, status, created_at")
      .single();

    if (error) {
      logError("campaign.functions", "createCampaign failed", { error: error.message }, requestId);
      return { ok: false as const, error: "Failed to create campaign.", campaign: null };
    }

    logInfo(
      "campaign.functions",
      "Campaign created",
      { businessId, campaignId: row.id },
      requestId,
    );
    return { ok: true as const, campaign: row, error: null as string | null };
  });

export const listCampaigns = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { userId } = context;

    const businessId = await getBusinessId(userId);
    if (!businessId) return { campaigns: [] };

    const { data } = await supabaseAdmin
      .from("campaigns")
      .select(
        "id, name, status, message_template, scheduled_at, launched_at, completed_at, " +
          "total_contacts, sent_count, failed_count, pending_count, created_at",
      )
      .eq("business_id", businessId)
      .order("created_at", { ascending: false })
      .limit(100);

    return { campaigns: data ?? [] };
  });

export const getCampaign = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { userId } = context;

    const businessId = await getBusinessId(userId);
    if (!businessId) return { campaign: null };

    const { data: campaign } = await supabaseAdmin
      .from("campaigns")
      .select("*")
      .eq("id", data.id)
      .eq("business_id", businessId)
      .maybeSingle();

    return { campaign };
  });

export const updateCampaign = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => {
    return z.object({ id: z.string().uuid() }).merge(CampaignInput.partial()).parse(input);
  })
  .handler(async ({ data, context }) => {
    const { userId } = context;
    const requestId = crypto.randomUUID();

    const businessId = await getBusinessId(userId);
    if (!businessId) return { ok: false as const, error: "No business profile found." };

    const {
      id,
      name,
      messageTemplate,
      mediaUrl,
      targetContactIds,
      targetTags,
      scheduledAt,
      timezone,
      sendWindowStart,
      sendWindowEnd,
      batchSize,
      messagesPerMin,
    } = data;

    // Only draft/scheduled campaigns can be edited
    const { data: existing } = await supabaseAdmin
      .from("campaigns")
      .select("status")
      .eq("id", id)
      .eq("business_id", businessId)
      .maybeSingle();

    if (!existing) return { ok: false as const, error: "Campaign not found." };
    if (!["draft", "scheduled"].includes(existing.status)) {
      return { ok: false as const, error: "Only draft or scheduled campaigns can be edited." };
    }

    const updates: Record<string, unknown> = {};
    if (name !== undefined) updates.name = name;
    if (messageTemplate !== undefined) updates.message_template = messageTemplate;
    if (mediaUrl !== undefined) updates.media_url = mediaUrl;
    if (targetContactIds !== undefined) updates.target_contact_ids = targetContactIds;
    if (targetTags !== undefined) updates.target_tags = targetTags;
    if (scheduledAt !== undefined) {
      updates.scheduled_at = scheduledAt;
      updates.status = "scheduled";
    }
    if (timezone !== undefined) updates.timezone = timezone;
    if (sendWindowStart !== undefined) updates.send_window_start = sendWindowStart;
    if (sendWindowEnd !== undefined) updates.send_window_end = sendWindowEnd;
    if (batchSize !== undefined) updates.batch_size = batchSize;
    if (messagesPerMin !== undefined) updates.messages_per_min = messagesPerMin;

    const { error } = await supabaseAdmin
      .from("campaigns")
      .update(updates)
      .eq("id", id)
      .eq("business_id", businessId);

    if (error) {
      logError("campaign.functions", "updateCampaign failed", { error: error.message }, requestId);
      return { ok: false as const, error: "Failed to update campaign." };
    }

    return { ok: true as const, error: null as string | null };
  });

export const launchCampaign = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { userId } = context;
    const requestId = crypto.randomUUID();

    const businessId = await getBusinessId(userId);
    if (!businessId) return { ok: false as const, error: "No business profile found.", total: 0 };

    // Validate campaign exists and is launchable
    const { data: campaign } = await supabaseAdmin
      .from("campaigns")
      .select("*")
      .eq("id", data.id)
      .eq("business_id", businessId)
      .maybeSingle();

    if (!campaign) return { ok: false as const, error: "Campaign not found.", total: 0 };
    if (!["draft", "scheduled"].includes(campaign.status as string)) {
      return {
        ok: false as const,
        error: `Cannot launch a campaign with status: ${campaign.status}`,
        total: 0,
      };
    }

    // Verify an active WhatsApp sender is configured.
    const whatsappReady = await hasWhatsAppSender(businessId);
    if (!whatsappReady) {
      return {
        ok: false as const,
        error:
          "WhatsApp is not connected. Go to Settings and complete Meta WhatsApp onboarding.",
        total: 0,
      };
    }

    // Populate campaign_contacts via DB function
    const { data: totalCount, error: populateError } = await supabaseAdmin.rpc(
      "populate_campaign_contacts",
      { p_campaign_id: campaign.id },
    );

    if (populateError) {
      logError(
        "campaign.functions",
        "populate_campaign_contacts failed",
        { error: populateError.message, campaignId: campaign.id },
        requestId,
      );
      return { ok: false as const, error: "Failed to resolve campaign audience.", total: 0 };
    }

    const total = (totalCount as number) ?? 0;
    if (total === 0) {
      return {
        ok: false as const,
        error: "No eligible contacts for this campaign (all opted out or no matching contacts).",
        total: 0,
      };
    }

    // Enqueue batch jobs
    const batchSize = (campaign.batch_size as number) ?? 100;
    const batches = Math.ceil(total / batchSize);

    for (let batchIndex = 0; batchIndex < batches; batchIndex++) {
      await enqueue(
        "send_campaign_batch",
        {
          campaignId: campaign.id,
          businessId,
          batchIndex,
          batchSize,
          messageTemplate: campaign.message_template as string,
          messagesPerMin: campaign.messages_per_min as number,
          // Provider credentials are fetched inside the consumer from Vault.
        },
        requestId,
        businessId,
      );
    }

    // Mark campaign as running
    await supabaseAdmin
      .from("campaigns")
      .update({ status: "running", launched_at: new Date().toISOString() })
      .eq("id", campaign.id);

    logInfo(
      "campaign.functions",
      "Campaign launched",
      {
        campaignId: campaign.id,
        businessId,
        total,
        batches,
      },
      requestId,
    );

    return { ok: true as const, error: null as string | null, total };
  });

export const pauseCampaign = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { userId } = context;
    const requestId = crypto.randomUUID();

    const businessId = await getBusinessId(userId);
    if (!businessId) return { ok: false as const, error: "No business profile found." };

    const owns = await assertOwnsCampaign(data.id, businessId);
    if (!owns) return { ok: false as const, error: "Campaign not found." };

    const { error } = await supabaseAdmin
      .from("campaigns")
      .update({ status: "paused", paused_at: new Date().toISOString() })
      .eq("id", data.id)
      .eq("status", "running");

    if (error) {
      logError("campaign.functions", "pauseCampaign failed", { error: error.message }, requestId);
      return { ok: false as const, error: "Failed to pause campaign." };
    }

    logInfo(
      "campaign.functions",
      "Campaign paused",
      { campaignId: data.id, businessId },
      requestId,
    );
    return { ok: true as const, error: null as string | null };
  });

export const resumeCampaign = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { userId } = context;
    const requestId = crypto.randomUUID();

    const businessId = await getBusinessId(userId);
    if (!businessId) return { ok: false as const, error: "No business profile found." };

    const owns = await assertOwnsCampaign(data.id, businessId);
    if (!owns) return { ok: false as const, error: "Campaign not found." };

    // Get campaign to re-enqueue remaining pending batches
    const { data: campaign } = await supabaseAdmin
      .from("campaigns")
      .select("id, pending_count, batch_size, message_template, messages_per_min")
      .eq("id", data.id)
      .maybeSingle();

    if (!campaign || campaign.status !== "paused") {
      return { ok: false as const, error: "Campaign is not paused." };
    }

    // Re-enqueue pending contacts
    const { data: pending } = await supabaseAdmin
      .from("campaign_contacts")
      .select("id, contact_id, phone, name")
      .eq("campaign_id", data.id)
      .eq("status", "pending")
      .order("id");

    const batchSize = (campaign.batch_size as number) ?? 100;

    for (let i = 0; i < (pending ?? []).length; i += batchSize) {
      await enqueue(
        "send_campaign_batch",
        {
          campaignId: campaign.id,
          businessId,
          batchIndex: Math.floor(i / batchSize),
          batchSize,
          messageTemplate: campaign.message_template as string,
          messagesPerMin: campaign.messages_per_min as number,
          explicitContactIds: (pending ?? [])
            .slice(i, i + batchSize)
            .map((c: { id: string }) => c.id),
        },
        requestId,
        businessId,
      );
    }

    await supabaseAdmin
      .from("campaigns")
      .update({ status: "running", paused_at: null })
      .eq("id", data.id);

    logInfo(
      "campaign.functions",
      "Campaign resumed",
      { campaignId: data.id, businessId },
      requestId,
    );
    return { ok: true as const, error: null as string | null };
  });

export const cancelCampaign = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { userId } = context;
    const requestId = crypto.randomUUID();

    const businessId = await getBusinessId(userId);
    if (!businessId) return { ok: false as const, error: "No business profile found." };

    const owns = await assertOwnsCampaign(data.id, businessId);
    if (!owns) return { ok: false as const, error: "Campaign not found." };

    const { error } = await supabaseAdmin
      .from("campaigns")
      .update({ status: "cancelled" })
      .eq("id", data.id)
      .eq("business_id", businessId)
      .in("status", ["draft", "scheduled", "running", "paused"]);

    if (error) {
      logError("campaign.functions", "cancelCampaign failed", { error: error.message }, requestId);
      return { ok: false as const, error: "Failed to cancel campaign." };
    }

    // Mark all pending campaign_contacts as skipped
    await supabaseAdmin
      .from("campaign_contacts")
      .update({ status: "skipped" })
      .eq("campaign_id", data.id)
      .eq("status", "pending");

    logInfo(
      "campaign.functions",
      "Campaign cancelled",
      { campaignId: data.id, businessId },
      requestId,
    );
    return { ok: true as const, error: null as string | null };
  });

export const deleteCampaign = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { userId } = context;
    const requestId = crypto.randomUUID();

    const businessId = await getBusinessId(userId);
    if (!businessId) return { ok: false as const, error: "No business profile found." };

    // Only draft/cancelled campaigns can be deleted
    const { data: existing } = await supabaseAdmin
      .from("campaigns")
      .select("status")
      .eq("id", data.id)
      .eq("business_id", businessId)
      .maybeSingle();

    if (!existing) return { ok: false as const, error: "Campaign not found." };
    if (!["draft", "cancelled", "completed", "failed"].includes(existing.status as string)) {
      return { ok: false as const, error: "Pause or cancel the campaign before deleting." };
    }

    const { error } = await supabaseAdmin
      .from("campaigns")
      .delete()
      .eq("id", data.id)
      .eq("business_id", businessId);

    if (error) {
      logError("campaign.functions", "deleteCampaign failed", { error: error.message }, requestId);
      return { ok: false as const, error: "Failed to delete campaign." };
    }

    return { ok: true as const, error: null as string | null };
  });

export const getCampaignStats = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { userId } = context;

    const businessId = await getBusinessId(userId);
    if (!businessId) return { stats: null };

    const { data: campaign } = await supabaseAdmin
      .from("campaigns")
      .select(
        "id, name, status, total_contacts, sent_count, failed_count, pending_count, " +
          "launched_at, completed_at, messages_per_min",
      )
      .eq("id", data.id)
      .eq("business_id", businessId)
      .maybeSingle();

    if (!campaign) return { stats: null };

    const total = (campaign.total_contacts as number) || 1;
    const sent = (campaign.sent_count as number) ?? 0;
    const failed = (campaign.failed_count as number) ?? 0;

    return {
      stats: {
        ...campaign,
        successRate: total > 0 ? Math.round((sent / total) * 100) : 0,
        failureRate: total > 0 ? Math.round((failed / total) * 100) : 0,
        progressPct: total > 0 ? Math.round(((sent + failed) / total) * 100) : 0,
        estimatedMinutesRemaining:
          campaign.messages_per_min && campaign.pending_count
            ? Math.ceil((campaign.pending_count as number) / (campaign.messages_per_min as number))
            : null,
      },
    };
  });
