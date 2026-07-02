
-- Trigger function for updated_at
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- BUSINESSES
create table public.businesses (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  type text not null default 'Other',
  email text not null,
  whatsapp text not null,
  open_time text not null default '09:00',
  close_time text not null default '20:00',
  products_list text not null default '',
  tone text not null default 'Friendly' check (tone in ('Professional','Friendly','Pidgin')),
  custom_message text default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id)
);
create index businesses_owner_id_idx on public.businesses(owner_id);
create trigger businesses_updated_at before update on public.businesses
  for each row execute function public.set_updated_at();

alter table public.businesses enable row level security;
create policy "Owner can view own business" on public.businesses
  for select to authenticated using (auth.uid() = owner_id);
create policy "Owner can insert own business" on public.businesses
  for insert to authenticated with check (auth.uid() = owner_id);
create policy "Owner can update own business" on public.businesses
  for update to authenticated using (auth.uid() = owner_id);
create policy "Owner can delete own business" on public.businesses
  for delete to authenticated using (auth.uid() = owner_id);

-- SUBSCRIPTIONS
create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  plan_id text not null check (plan_id in ('starter','growth','pro')),
  status text not null check (status in ('trial','active','expired','cancelled')),
  trial_ends_at timestamptz,
  current_period_end timestamptz,
  paystack_reference text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index subscriptions_business_id_idx on public.subscriptions(business_id);
create trigger subscriptions_updated_at before update on public.subscriptions
  for each row execute function public.set_updated_at();

alter table public.subscriptions enable row level security;
create policy "Owner can view own subscription" on public.subscriptions
  for select to authenticated using (
    exists (select 1 from public.businesses b where b.id = subscriptions.business_id and b.owner_id = auth.uid())
  );
-- Inserts/updates handled by service role via webhook only. No user write policy.

-- PAYSTACK KEYS
create table public.paystack_keys (
  business_id uuid primary key references public.businesses(id) on delete cascade,
  public_key text not null,
  secret_key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger paystack_keys_updated_at before update on public.paystack_keys
  for each row execute function public.set_updated_at();

alter table public.paystack_keys enable row level security;
-- Only allow reading the public_key indirectly — secret_key is sensitive.
-- We'll never select secret_key from client; always go through a server function.
-- For RLS we let the owner know whether keys exist (via select), but server functions
-- with service role read the actual secret_key.
create policy "Owner can view own paystack keys" on public.paystack_keys
  for select to authenticated using (
    exists (select 1 from public.businesses b where b.id = paystack_keys.business_id and b.owner_id = auth.uid())
  );
create policy "Owner can upsert own paystack keys" on public.paystack_keys
  for insert to authenticated with check (
    exists (select 1 from public.businesses b where b.id = paystack_keys.business_id and b.owner_id = auth.uid())
  );
create policy "Owner can update own paystack keys" on public.paystack_keys
  for update to authenticated using (
    exists (select 1 from public.businesses b where b.id = paystack_keys.business_id and b.owner_id = auth.uid())
  );
create policy "Owner can delete own paystack keys" on public.paystack_keys
  for delete to authenticated using (
    exists (select 1 from public.businesses b where b.id = paystack_keys.business_id and b.owner_id = auth.uid())
  );

-- WHATSAPP CONFIG
create table public.whatsapp_config (
  business_id uuid primary key references public.businesses(id) on delete cascade,
  dialog_api_key text not null,
  business_number text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger whatsapp_config_updated_at before update on public.whatsapp_config
  for each row execute function public.set_updated_at();
create unique index whatsapp_config_number_idx on public.whatsapp_config(business_number);

alter table public.whatsapp_config enable row level security;
create policy "Owner can view own whatsapp config" on public.whatsapp_config
  for select to authenticated using (
    exists (select 1 from public.businesses b where b.id = whatsapp_config.business_id and b.owner_id = auth.uid())
  );
create policy "Owner can insert own whatsapp config" on public.whatsapp_config
  for insert to authenticated with check (
    exists (select 1 from public.businesses b where b.id = whatsapp_config.business_id and b.owner_id = auth.uid())
  );
create policy "Owner can update own whatsapp config" on public.whatsapp_config
  for update to authenticated using (
    exists (select 1 from public.businesses b where b.id = whatsapp_config.business_id and b.owner_id = auth.uid())
  );
create policy "Owner can delete own whatsapp config" on public.whatsapp_config
  for delete to authenticated using (
    exists (select 1 from public.businesses b where b.id = whatsapp_config.business_id and b.owner_id = auth.uid())
  );

-- CONVERSATIONS
create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  customer_name text,
  customer_number text not null,
  status text not null default 'handled' check (status in ('handled','needs_you','order_placed')),
  last_message_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index conversations_business_id_idx on public.conversations(business_id);
create unique index conversations_business_customer_idx on public.conversations(business_id, customer_number);

alter table public.conversations enable row level security;
create policy "Owner can view own conversations" on public.conversations
  for select to authenticated using (
    exists (select 1 from public.businesses b where b.id = conversations.business_id and b.owner_id = auth.uid())
  );

-- MESSAGES
create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  role text not null check (role in ('user','assistant')),
  content text not null,
  created_at timestamptz not null default now()
);
create index messages_conversation_id_idx on public.messages(conversation_id);

alter table public.messages enable row level security;
create policy "Owner can view own messages" on public.messages
  for select to authenticated using (
    exists (
      select 1 from public.conversations c
      join public.businesses b on b.id = c.business_id
      where c.id = messages.conversation_id and b.owner_id = auth.uid()
    )
  );

-- ORDERS
create table public.orders (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete set null,
  customer_number text not null,
  amount_naira integer not null check (amount_naira > 0),
  paystack_reference text unique,
  status text not null default 'pending' check (status in ('pending','paid','failed')),
  created_at timestamptz not null default now(),
  paid_at timestamptz
);
create index orders_business_id_idx on public.orders(business_id);
create index orders_status_idx on public.orders(status);

alter table public.orders enable row level security;
create policy "Owner can view own orders" on public.orders
  for select to authenticated using (
    exists (select 1 from public.businesses b where b.id = orders.business_id and b.owner_id = auth.uid())
  );
