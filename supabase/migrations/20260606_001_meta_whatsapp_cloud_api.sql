-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: Add Meta WhatsApp Cloud API fields to whatsapp_config
--
-- Replaces 360Dialog with Meta Cloud API (WhatsApp Embedded Signup).
-- Adds:
--   phone_number_id   — Meta phone number ID (used in API calls)
--   waba_id           — WhatsApp Business Account ID
--   access_token_vault_id — Vault reference for the long-lived access token
--   meta_connected    — true once Embedded Signup completed successfully
--
-- Keeps existing columns (dialog_api_key, dialog_api_key_vault_id, business_number)
-- for backward compatibility during migration window.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.whatsapp_config
  add column if not exists phone_number_id       text,
  add column if not exists waba_id               text,
  add column if not exists access_token_vault_id text,
  add column if not exists meta_connected        boolean not null default false;

-- Index for Meta webhook routing (lookup by phone_number_id)
create index if not exists whatsapp_config_phone_number_id_idx
  on public.whatsapp_config(phone_number_id)
  where phone_number_id is not null;

comment on column public.whatsapp_config.phone_number_id is
  'Meta WhatsApp Cloud API phone number ID — used in Graph API calls';
comment on column public.whatsapp_config.waba_id is
  'WhatsApp Business Account ID from Meta';
comment on column public.whatsapp_config.access_token_vault_id is
  'Supabase Vault secret ID for the Meta system user access token';
comment on column public.whatsapp_config.meta_connected is
  'True when the business has completed Meta Embedded Signup';
