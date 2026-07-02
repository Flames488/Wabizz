-- Migration 028: Missing Supabase RPC functions for niche module
--
-- Two functions called by name from the Wabizz app that had no backing SQL:
--
-- 1. store_vitar_api_key(business_id, api_key) → secret_name
--    Called by hospital.tsx (browser, authenticated user) to securely store
--    the Vitar API key in Supabase Vault.  Uses the existing upsert_vault_secret
--    helper added in migration 001.
--
-- 2. vault_read_secret(secret_name) → decrypted_value
--    Called by niche-loader.ts (server, service role) to resolve the Vitar API
--    key from Vault on each niche config load.  Reads vault.decrypted_secrets,
--    which requires elevated permissions not available to anon/authenticated.
--
-- Without these functions, hospital API key save throws a PostgREST 404,
-- and niche-loader silently falls back with no API key, disabling hospital
-- booking for every business.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1.  store_vitar_api_key
--     Browser-callable (authenticated role), SECURITY DEFINER to write Vault.
--     Verifies the caller owns the business before writing the secret.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.store_vitar_api_key(
  business_id uuid,
  api_key     text
)
RETURNS text           -- returns the vault secret name for storage in niche config
LANGUAGE plpgsql
SECURITY DEFINER       -- runs as DB owner so it can write to vault.secrets
SET search_path = public, vault
AS $$
DECLARE
  v_secret_name text;
  v_owner_id    uuid;
BEGIN
  -- Verify the authenticated user owns this business.
  -- Prevents one business from overwriting another's vault secret.
  SELECT user_id INTO v_owner_id
  FROM businesses
  WHERE id = business_id
  LIMIT 1;

  IF v_owner_id IS NULL THEN
    RAISE EXCEPTION 'Business not found';
  END IF;

  IF v_owner_id <> auth.uid() THEN
    RAISE EXCEPTION 'Permission denied: you do not own this business';
  END IF;

  IF api_key IS NULL OR trim(api_key) = '' THEN
    RAISE EXCEPTION 'API key must not be empty';
  END IF;

  -- Construct a deterministic, human-readable secret name.
  -- niche-loader.ts stores this name in business_niche_configs.config->>'vitar_api_key_vault_name'
  -- and passes it back to vault_read_secret() on every message.
  v_secret_name := 'vitar_api_key_for_' || business_id::text;

  -- Upsert: create if new, rotate if already exists.
  PERFORM public.upsert_vault_secret(trim(api_key), v_secret_name);

  RETURN v_secret_name;
END;
$$;

-- Only authenticated users can call this; anon is explicitly blocked.
REVOKE EXECUTE ON FUNCTION public.store_vitar_api_key(uuid, text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.store_vitar_api_key(uuid, text) TO authenticated;

COMMENT ON FUNCTION public.store_vitar_api_key IS
  'Stores a Vitar API key in Supabase Vault for the given business. '
  'Caller must own the business. Returns the vault secret name.';


-- ─────────────────────────────────────────────────────────────────────────────
-- 2.  vault_read_secret
--     Server-only (service role), SECURITY DEFINER to read vault.decrypted_secrets.
--     Returns the plaintext secret value, or NULL if not found.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.vault_read_secret(
  secret_name text
)
RETURNS text           -- the decrypted secret value, or NULL if not found
LANGUAGE plpgsql
SECURITY DEFINER       -- vault.decrypted_secrets is not accessible to anon/authenticated
SET search_path = public, vault
AS $$
DECLARE
  v_secret text;
BEGIN
  SELECT decrypted_secret
  INTO   v_secret
  FROM   vault.decrypted_secrets
  WHERE  name = secret_name
  LIMIT  1;

  RETURN v_secret;  -- NULL if not found
END;
$$;

-- Restrict to service_role only — this function returns plaintext secrets.
-- niche-loader.ts calls it via supabaseAdmin (service role key), never anon.
REVOKE EXECUTE ON FUNCTION public.vault_read_secret(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.vault_read_secret(text) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.vault_read_secret(text) TO service_role;

COMMENT ON FUNCTION public.vault_read_secret IS
  'Reads a decrypted secret from Supabase Vault by name. '
  'Service role only — never expose to browser clients.';
