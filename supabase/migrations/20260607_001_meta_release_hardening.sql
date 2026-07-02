-- Complete Meta WhatsApp Cloud API release fields used by application code.

alter table public.whatsapp_config
  add column if not exists business_manager_id text,
  add column if not exists connected_via text not null default '360dialog',
  add column if not exists connected_at timestamptz,
  add column if not exists coexistence_enabled boolean not null default false,
  add column if not exists coexistence_eligible boolean not null default false,
  add column if not exists meta_access_token_vault_id text;

create index if not exists whatsapp_config_connected_via_idx
  on public.whatsapp_config(connected_via);

create index if not exists whatsapp_config_meta_phone_idx
  on public.whatsapp_config(phone_number_id, connected_via)
  where phone_number_id is not null;

comment on column public.whatsapp_config.business_manager_id is
  'Meta Business Manager ID discovered during Embedded Signup';
comment on column public.whatsapp_config.connected_via is
  'Provider currently connected for this business, for example meta_cloud_api or 360dialog';
comment on column public.whatsapp_config.connected_at is
  'Timestamp when the current WhatsApp provider connection was established';
comment on column public.whatsapp_config.coexistence_enabled is
  'Whether Meta WhatsApp coexistence behavior is enabled for this business';
comment on column public.whatsapp_config.coexistence_eligible is
  'Whether Meta reported this business phone as eligible for coexistence';
comment on column public.whatsapp_config.meta_access_token_vault_id is
  'Supabase Vault secret ID for the Meta long-lived access token';
