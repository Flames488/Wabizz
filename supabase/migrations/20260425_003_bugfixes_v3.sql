-- ============================================================================
-- Bug Fixes v3
-- Fixes: order idempotency (unique constraint on paystack_reference),
--        notification_log dedup index improvements
-- ============================================================================

-- ── 1. Orders: enforce uniqueness on paystack_reference to prevent double-pay ─
-- This guarantees the idempotency guard in handlePaystackEvent can rely on a
-- unique reference per order without a race condition.
alter table public.orders
  add constraint orders_paystack_reference_unique unique (paystack_reference);

-- ── 2. Subscriptions: enforce uniqueness on paystack_reference ────────────────
-- Prevents duplicate subscription rows from duplicate webhook deliveries.
-- The app already checks getSubscriptionByReference before inserting, but this
-- provides a hard DB-level guarantee.
alter table public.subscriptions
  add constraint subscriptions_paystack_reference_unique unique (paystack_reference);

-- ── 3. notification_log: composite index for per-business-per-type dedup query ─
-- The trial expiry dedup check runs: WHERE type = ? AND business_id = ? AND sent_at > ?
-- An index on (business_id, type, sent_at) covers this perfectly.
create index if not exists notification_log_business_type_sent_idx
  on public.notification_log(business_id, type, sent_at desc);

-- ── 4. orders: index on (status, created_at) for overdue reminder query ───────
-- Already exists from v2 migration but re-stated here for clarity.
create index if not exists orders_pending_created_idx
  on public.orders(status, created_at desc)
  where status = 'pending';
