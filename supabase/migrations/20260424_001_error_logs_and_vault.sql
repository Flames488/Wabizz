-- ============================================================
-- Migration: error_logs table + Supabase Vault for API secrets
-- ============================================================

-- 1. Error logs table for production observability
--    Stores structured server-side errors so you can query them
--    without tailing Cloudflare's log stream at 2am.
CREATE TABLE IF NOT EXISTS public.error_logs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source      text NOT NULL,           -- e.g. "twilio-webhook", "chat.functions"
  message     text NOT NULL,
  context     jsonb NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL DEFAULT now()
);

-- Only service-role (server) can insert/select error logs. No user access.
ALTER TABLE public.error_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_only" ON public.error_logs
  USING (false)           -- blocks all SELECT from anon/authenticated
  WITH CHECK (false);     -- blocks all INSERT from anon/authenticated
                          -- service_role bypasses RLS entirely

-- Index for recency queries and filtering by source
CREATE INDEX error_logs_occurred_at_idx ON public.error_logs (occurred_at DESC);
CREATE INDEX error_logs_source_idx ON public.error_logs (source);

-- Auto-purge logs older than 90 days (keeps table lean)
-- Run this via pg_cron or a scheduled Supabase Edge Function:
-- DELETE FROM public.error_logs WHERE occurred_at < now() - interval '90 days';


-- 2. Supabase Vault for API secrets
--    Vault stores secrets as encrypted rows in vault.secrets (pgcrypto/pgsodium).
--    This replaces plaintext `dialog_api_key` and `secret_key` columns.
--
-- Enable the Vault extension (idempotent):
CREATE EXTENSION IF NOT EXISTS supabase_vault WITH SCHEMA vault;

-- Helper function: store or update a named secret in Vault.
-- Call from server functions: SELECT vault.create_secret('value', 'name');
-- Returns the secret UUID.
CREATE OR REPLACE FUNCTION public.upsert_vault_secret(
  p_secret text,
  p_name   text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER  -- runs as DB owner so it can write to vault.secrets
AS $$
DECLARE
  v_id uuid;
BEGIN
  SELECT id INTO v_id FROM vault.secrets WHERE name = p_name LIMIT 1;
  IF v_id IS NULL THEN
    v_id := vault.create_secret(p_secret, p_name);
  ELSE
    PERFORM vault.update_secret(v_id, p_secret);
  END IF;
  RETURN v_id;
END;
$$;

-- Revoke public execute — only service_role can call this function.
REVOKE EXECUTE ON FUNCTION public.upsert_vault_secret(text, text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.upsert_vault_secret(text, text) TO service_role;


-- 3. Add vault_secret_id columns to whatsapp_config and paystack_keys
--    so we can reference encrypted secrets instead of storing plaintext.
--
-- whatsapp_config: replace dialog_api_key with a vault reference
ALTER TABLE public.whatsapp_config
  ADD COLUMN IF NOT EXISTS dialog_api_key_vault_id uuid REFERENCES vault.secrets(id) ON DELETE SET NULL;

-- paystack_keys: replace secret_key with a vault reference  
ALTER TABLE public.paystack_keys
  ADD COLUMN IF NOT EXISTS secret_key_vault_id uuid REFERENCES vault.secrets(id) ON DELETE SET NULL;

-- NOTE: After deploying this migration:
-- 1. Run the data migration script (scripts/migrate-secrets-to-vault.ts) to move
--    existing plaintext secrets into Vault and populate the vault_id columns.
-- 2. Once confirmed, drop the plaintext columns:
--    ALTER TABLE public.whatsapp_config DROP COLUMN IF EXISTS dialog_api_key;
--    ALTER TABLE public.paystack_keys   DROP COLUMN IF EXISTS secret_key;
-- We don't auto-drop here to allow a safe rollback window.

