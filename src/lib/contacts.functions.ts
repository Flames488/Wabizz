/**
 * contacts.functions.ts — Contact list management server functions
 *
 * All functions require authentication and scope to the caller's business.
 * Contacts are the audience for campaigns and automation rules.
 *
 * Features:
 *   - CRUD (create, list, update, delete, bulk-import)
 *   - Opt-out management (GDPR-safe)
 *   - Tag-based segmentation
 *   - Phone validation + normalisation
 *   - Duplicate detection (phone uniqueness per business)
 */

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { logError, logInfo } from "@/lib/server-logger";
import { isValidPhone, normalisePhone } from "@/lib/whatsapp";

// ── Validators ────────────────────────────────────────────────────────────────

const ContactInput = z.object({
  phone: z.string().min(7).max(20),
  name: z.string().max(100).optional(),
  tags: z.array(z.string().max(50)).max(20).optional().default([]),
  source: z.enum(["manual", "import", "chat"]).optional().default("manual"),
  metadata: z.record(z.unknown()).optional().default({}),
});

const BulkImportInput = z.object({
  contacts: z.array(ContactInput).max(10_000),
});

const ListContactsInput = z.object({
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(200).default(50),
  tag: z.string().optional(),
  search: z.string().optional(),
  includedOptedOut: z.boolean().optional().default(false),
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

export const createContact = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => ContactInput.parse(input))
  .handler(async ({ data, context }) => {
    const { userId } = context;
    const requestId = crypto.randomUUID();

    const businessId = await getBusinessId(userId);
    if (!businessId) return { ok: false as const, error: "No business profile found." };

    const phone = normalisePhone(data.phone);
    if (!isValidPhone(phone)) return { ok: false as const, error: "Invalid phone number." };

    const { data: row, error } = await supabaseAdmin
      .from("contacts")
      .insert({
        business_id: businessId,
        phone,
        name: data.name ?? null,
        tags: data.tags,
        source: data.source,
        metadata: data.metadata,
      })
      .select("id, phone, name, tags, opted_out, created_at")
      .single();

    if (error) {
      if (error.code === "23505")
        return { ok: false as const, error: "This number is already in your contacts." };
      logError("contacts.functions", "createContact failed", { error: error.message }, requestId);
      return { ok: false as const, error: "Failed to save contact." };
    }

    logInfo("contacts.functions", "Contact created", { businessId, phone }, requestId);
    return { ok: true as const, contact: row, error: null as string | null };
  });

export const bulkImportContacts = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => BulkImportInput.parse(input))
  .handler(async ({ data, context }) => {
    const { userId } = context;
    const requestId = crypto.randomUUID();

    const businessId = await getBusinessId(userId);
    if (!businessId)
      return { ok: false as const, error: "No business profile found.", imported: 0, skipped: 0 };

    // Validate + normalise all contacts
    const rows: Array<{
      business_id: string;
      phone: string;
      name: string | null;
      tags: string[];
      source: string;
      metadata: Record<string, unknown>;
    }> = [];

    let skipped = 0;
    const seen = new Set<string>();

    for (const c of data.contacts) {
      const phone = normalisePhone(c.phone);
      if (!isValidPhone(phone) || seen.has(phone)) {
        skipped++;
        continue;
      }
      seen.add(phone);
      rows.push({
        business_id: businessId,
        phone,
        name: c.name ?? null,
        tags: c.tags ?? [],
        source: c.source ?? "import",
        metadata: c.metadata ?? {},
      });
    }

    if (rows.length === 0)
      return { ok: true as const, error: null as string | null, imported: 0, skipped };

    // Upsert in batches of 500 (Supabase row limit per insert)
    const BATCH = 500;
    let imported = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH);
      const { error, count } = await supabaseAdmin
        .from("contacts")
        .upsert(batch, { onConflict: "business_id,phone", ignoreDuplicates: true })
        .select("id", { count: "exact", head: true });

      if (error) {
        logError(
          "contacts.functions",
          "bulkImport batch error",
          { error: error.message, batch: i },
          requestId,
        );
      } else {
        imported += count ?? batch.length;
      }
    }

    logInfo(
      "contacts.functions",
      "Bulk import complete",
      { businessId, imported, skipped },
      requestId,
    );
    return { ok: true as const, error: null as string | null, imported, skipped };
  });

export const listContacts = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => {
    if (!input || typeof input !== "object") return ListContactsInput.parse({});
    return ListContactsInput.parse(input);
  })
  .handler(async ({ data, context }) => {
    const { userId } = context;

    const businessId = await getBusinessId(userId);
    if (!businessId) return { contacts: [], total: 0 };

    const { page, pageSize, tag, search, includedOptedOut } = data;
    const from = (page - 1) * pageSize;

    let query = supabaseAdmin
      .from("contacts")
      .select("id, phone, name, tags, opted_out, source, last_messaged_at, created_at", {
        count: "exact",
      })
      .eq("business_id", businessId)
      .range(from, from + pageSize - 1)
      .order("created_at", { ascending: false });

    if (!includedOptedOut) query = query.eq("opted_out", false);
    if (tag) query = query.contains("tags", [tag]);
    if (search) query = query.or(`phone.ilike.%${search}%,name.ilike.%${search}%`);

    const { data: contacts, count } = await query;
    return { contacts: contacts ?? [], total: count ?? 0 };
  });

export const updateContact = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => {
    const schema = z.object({
      id: z.string().uuid(),
      name: z.string().max(100).optional(),
      tags: z.array(z.string().max(50)).max(20).optional(),
    });
    return schema.parse(input);
  })
  .handler(async ({ data, context }) => {
    const { userId } = context;
    const requestId = crypto.randomUUID();

    const businessId = await getBusinessId(userId);
    if (!businessId) return { ok: false as const, error: "No business profile found." };

    // Verify ownership via business_id
    const { error } = await supabaseAdmin
      .from("contacts")
      .update({ name: data.name, tags: data.tags })
      .eq("id", data.id)
      .eq("business_id", businessId);

    if (error) {
      logError("contacts.functions", "updateContact failed", { error: error.message }, requestId);
      return { ok: false as const, error: "Failed to update contact." };
    }

    return { ok: true as const, error: null as string | null };
  });

export const optOutContact = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { userId } = context;
    const requestId = crypto.randomUUID();

    const businessId = await getBusinessId(userId);
    if (!businessId) return { ok: false as const, error: "No business profile found." };

    const { error } = await supabaseAdmin
      .from("contacts")
      .update({ opted_out: true, opted_out_at: new Date().toISOString() })
      .eq("id", data.id)
      .eq("business_id", businessId);

    if (error) {
      logError("contacts.functions", "optOutContact failed", { error: error.message }, requestId);
      return { ok: false as const, error: "Failed to opt out contact." };
    }

    logInfo(
      "contacts.functions",
      "Contact opted out",
      { contactId: data.id, businessId },
      requestId,
    );
    return { ok: true as const, error: null as string | null };
  });

export const deleteContact = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { userId } = context;
    const requestId = crypto.randomUUID();

    const businessId = await getBusinessId(userId);
    if (!businessId) return { ok: false as const, error: "No business profile found." };

    const { error } = await supabaseAdmin
      .from("contacts")
      .delete()
      .eq("id", data.id)
      .eq("business_id", businessId);

    if (error) {
      logError("contacts.functions", "deleteContact failed", { error: error.message }, requestId);
      return { ok: false as const, error: "Failed to delete contact." };
    }

    return { ok: true as const, error: null as string | null };
  });

export const getContactStats = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { userId } = context;

    const businessId = await getBusinessId(userId);
    if (!businessId) return { total: 0, active: 0, optedOut: 0, tags: [] as string[] };

    const [totalRes, optedOutRes, tagsRes] = await Promise.all([
      supabaseAdmin
        .from("contacts")
        .select("id", { count: "exact", head: true })
        .eq("business_id", businessId),
      supabaseAdmin
        .from("contacts")
        .select("id", { count: "exact", head: true })
        .eq("business_id", businessId)
        .eq("opted_out", true),
      supabaseAdmin
        .from("contacts")
        .select("tags")
        .eq("business_id", businessId)
        .eq("opted_out", false),
    ]);

    const total = totalRes.count ?? 0;
    const optedOut = optedOutRes.count ?? 0;

    // Aggregate unique tags
    const tagSet = new Set<string>();
    for (const row of tagsRes.data ?? []) {
      for (const tag of row.tags ?? []) tagSet.add(tag);
    }

    return { total, active: total - optedOut, optedOut, tags: Array.from(tagSet).sort() };
  });
