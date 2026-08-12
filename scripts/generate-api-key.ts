/**
 * generate-api-key.ts
 *
 * One-off script: mints an external API key for a business (e.g. Vitar) so
 * it can call POST /api/send. There's no dashboard UI for this yet — this
 * is a deliberately manual, run-once-per-partner step.
 *
 * The raw key is shown ONCE. Only its SHA-256 hash is stored — if the key
 * is lost, run this again to mint a new one (the old one stops working the
 * moment a new hash is written).
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npx tsx scripts/generate-api-key.ts <business-owner-email> "<label>"
 *
 * Example:
 *   npx tsx scripts/generate-api-key.ts vitar@example.com "Vitar Sales Agent"
 */

import { createClient } from "@supabase/supabase-js";
import { randomBytes, createHash } from "crypto";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const [, , ownerEmail, label] = process.argv;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
if (!ownerEmail) {
  console.error('Usage: npx tsx scripts/generate-api-key.ts <business-owner-email> "<label>"');
  process.exit(1);
}

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function main() {
  // Resolve the business by its owner's auth email.
  const { data: userList, error: userErr } = await db.auth.admin.listUsers();
  if (userErr) {
    console.error("Failed to list users:", userErr.message);
    process.exit(1);
  }
  const user = userList.users.find((u) => u.email?.toLowerCase() === ownerEmail.toLowerCase());
  if (!user) {
    console.error(`No auth user found with email ${ownerEmail}`);
    process.exit(1);
  }

  const { data: biz, error: bizErr } = await db
    .from("businesses")
    .select("id, name")
    .eq("owner_id", user.id)
    .maybeSingle();
  if (bizErr || !biz) {
    console.error(`No business found for owner ${ownerEmail}. Create the business profile first.`);
    process.exit(1);
  }

  // Generate: wbz_live_<43 url-safe base64 chars from 32 random bytes>
  const rawKey = `wbz_live_${randomBytes(32).toString("base64url")}`;
  const keyHash = createHash("sha256").update(rawKey).digest("hex");

  const { error: updateErr } = await db
    .from("businesses")
    .update({
      external_api_enabled: true,
      external_api_key_hash: keyHash,
      external_api_key_label: label ?? null,
      external_api_key_created_at: new Date().toISOString(),
      external_api_key_last_used_at: null,
    })
    .eq("id", biz.id);

  if (updateErr) {
    console.error("Failed to store key hash:", updateErr.message);
    process.exit(1);
  }

  console.log(`\nAPI key generated for "${biz.name}" (${ownerEmail}).`);
  console.log("This is shown ONCE — store it now, it cannot be retrieved again:\n");
  console.log(`  ${rawKey}\n`);
  console.log("Use it as:  Authorization: Bearer " + rawKey);
}

main();
