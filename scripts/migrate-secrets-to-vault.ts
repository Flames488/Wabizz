/**
 * migrate-secrets-to-vault.ts
 *
 * One-time script: moves plaintext API secrets from DB columns into Supabase Vault.
 * Run ONCE after deploying the 20260424_001_error_logs_and_vault.sql migration.
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npx tsx scripts/migrate-secrets-to-vault.ts
 *
 * What it does:
 *   1. Reads every row in paystack_keys where secret_key IS NOT NULL
 *   2. Writes the secret to Vault via upsert_vault_secret()
 *   3. Updates secret_key_vault_id on the row
 *   4. Nulls out the plaintext secret_key
 *   Repeats for whatsapp_config.dialog_api_key
 *
 * After confirming all rows migrated, run the DROP COLUMN statements in the migration file.
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function migratePaystackKeys() {
  console.log("Migrating paystack_keys.secret_key → Vault…");
  const { data: rows, error } = await db
    .from("paystack_keys")
    .select("id, business_id, secret_key")
    .not("secret_key", "is", null)
    .is("secret_key_vault_id", null);

  if (error) {
    console.error("Query failed:", error.message);
    return;
  }
  if (!rows?.length) {
    console.log("  Nothing to migrate.");
    return;
  }

  for (const row of rows) {
    const vaultName = `paystack_sk_${row.business_id}`;
    const { data: vaultId, error: vaultErr } = await db.rpc("upsert_vault_secret", {
      p_secret: row.secret_key,
      p_name: vaultName,
    });
    if (vaultErr) {
      console.error(`  [SKIP] Row ${row.id}: Vault error —`, vaultErr.message);
      continue;
    }
    const { error: updErr } = await db
      .from("paystack_keys")
      .update({ secret_key_vault_id: vaultId, secret_key: null })
      .eq("id", row.id);
    if (updErr) {
      console.error(`  [FAIL] Row ${row.id}: Update error —`, updErr.message);
    } else {
      console.log(`  [OK] paystack_keys row ${row.id} → Vault ${vaultId}`);
    }
  }
}

async function migrateWhatsAppKeys() {
  console.log("Migrating whatsapp_config.dialog_api_key → Vault…");
  const { data: rows, error } = await db
    .from("whatsapp_config")
    .select("id, business_id, dialog_api_key")
    .not("dialog_api_key", "is", null)
    .is("dialog_api_key_vault_id", null);

  if (error) {
    console.error("Query failed:", error.message);
    return;
  }
  if (!rows?.length) {
    console.log("  Nothing to migrate.");
    return;
  }

  for (const row of rows) {
    const vaultName = `whatsapp_api_key_${row.business_id}`;
    const { data: vaultId, error: vaultErr } = await db.rpc("upsert_vault_secret", {
      p_secret: row.dialog_api_key,
      p_name: vaultName,
    });
    if (vaultErr) {
      console.error(`  [SKIP] Row ${row.id}: Vault error —`, vaultErr.message);
      continue;
    }
    const { error: updErr } = await db
      .from("whatsapp_config")
      .update({ dialog_api_key_vault_id: vaultId, dialog_api_key: null })
      .eq("id", row.id);
    if (updErr) {
      console.error(`  [FAIL] Row ${row.id}: Update error —`, updErr.message);
    } else {
      console.log(`  [OK] whatsapp_config row ${row.id} → Vault ${vaultId}`);
    }
  }
}

(async () => {
  await migratePaystackKeys();
  await migrateWhatsAppKeys();
  console.log("\nDone. Verify rows, then drop the plaintext columns (see migration SQL).");
})();
