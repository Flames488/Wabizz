-- ============================================================================
-- Production Hardening v2
-- Adds: notification_log, level column on error_logs, status on conversations,
--       performance indexes, idempotency guards, whatsapp_number on businesses
-- ============================================================================

-- ── 1. error_logs: add level column ─────────────────────────────────────────
alter table public.error_logs
  add column if not exists level text not null default 'error'
    check (level in ('debug','info','warn','error','fatal'));

create index if not exists error_logs_level_idx on public.error_logs(level);
create index if not exists error_logs_source_idx on public.error_logs(source);
create index if not exists error_logs_occurred_at_idx on public.error_logs(occurred_at desc);

-- ── 2. businesses: add whatsapp_number for reminder delivery ─────────────────
alter table public.businesses
  add column if not exists whatsapp_number text;

-- ── 3. conversations: add status column for state machine ────────────────────
alter table public.conversations
  add column if not exists status text not null default 'open'
    check (status in (
      'open',
      'awaiting_payment',
      'payment_confirmation_pending',
      'order_placed',
      'cancelled',
      'resolved'
    ));

create index if not exists conversations_status_idx on public.conversations(status);
create index if not exists conversations_business_number_idx
  on public.conversations(business_id, customer_number);
create index if not exists conversations_last_message_idx
  on public.conversations(last_message_at desc);

-- ── 4. messages: index for history fetch (DESC — matches getMessageHistory ORDER BY created_at DESC LIMIT) ──
create index if not exists messages_conversation_created_idx
  on public.messages(conversation_id, created_at desc);

-- ── 5. orders: add paid_at, indexes ──────────────────────────────────────────
alter table public.orders
  add column if not exists paid_at timestamptz;

create index if not exists orders_status_created_idx
  on public.orders(status, created_at desc);
create index if not exists orders_paystack_reference_idx
  on public.orders(paystack_reference);

-- ── 6. subscriptions: indexes for query performance ──────────────────────────
create index if not exists subscriptions_status_trial_ends_idx
  on public.subscriptions(status, trial_ends_at)
  where status = 'trial';

create index if not exists subscriptions_status_period_end_idx
  on public.subscriptions(status, current_period_end)
  where status = 'active';

create index if not exists subscriptions_paystack_reference_idx
  on public.subscriptions(paystack_reference)
  where paystack_reference is not null;

-- ── 7. notification_log: dedup guard for reminders ───────────────────────────
create table if not exists public.notification_log (
  id             uuid primary key default gen_random_uuid(),
  business_id    uuid not null references public.businesses(id) on delete cascade,
  type           text not null, -- 'trial_expiry_warning' | 'payment_reminder' | 'renewal_reminder' | etc.
  sent_at        timestamptz not null default now(),
  meta           jsonb not null default '{}'::jsonb
);

create index if not exists notification_log_business_type_idx
  on public.notification_log(business_id, type, sent_at desc);
create index if not exists notification_log_meta_order_id_idx
  on public.notification_log using gin(meta);

alter table public.notification_log enable row level security;
-- Only service role writes; no user reads needed.

-- ── 8. whatsapp_config: index on business_number for webhook lookup ───────────
create index if not exists whatsapp_config_business_number_idx
  on public.whatsapp_config(business_number);

-- ── 9. paystack_keys: ensure secret_key_vault_id column exists ───────────────
alter table public.paystack_keys
  add column if not exists secret_key_vault_id text;

-- ── 10. Subscription history: indexes ────────────────────────────────────────
create index if not exists sub_history_business_created_idx
  on public.subscription_history(business_id, created_at desc);
