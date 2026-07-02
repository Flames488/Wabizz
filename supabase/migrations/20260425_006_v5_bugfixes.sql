-- ============================================================================
-- v5 Bug-fix Migration
-- Fixes:
--   1. conversations: drop v1 status check, apply v2 statuses correctly
--   2. subscriptions:  add 'pending_payment' to status check (Bug 3 fix)
--   3. businesses:     back-fill whatsapp_number from whatsapp (Bug 2 fix)
--   4. conversations:  add last_message_content + last_message_role for
--                      efficient dashboard queries (Problem 3 fix)
-- ============================================================================

-- ── 1. Fix conversations status constraint ────────────────────────────────────
-- The v1 migration created a check constraint that only allowed the old statuses.
-- v2 tried to add the new statuses via ADD COLUMN IF NOT EXISTS, but the column
-- already existed so the new constraint was silently ignored.
-- We drop the old constraint and add the correct union of all valid values.

DO $$
DECLARE
  con_name text;
BEGIN
  SELECT conname INTO con_name
  FROM pg_constraint
  WHERE conrelid = 'public.conversations'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%status%';

  IF con_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.conversations DROP CONSTRAINT %I', con_name);
  END IF;
END;
$$;

ALTER TABLE public.conversations
  ADD CONSTRAINT conversations_status_check
  CHECK (status IN (
    'handled',
    'needs_you',
    'order_placed',
    'open',
    'awaiting_payment',
    'payment_confirmation_pending',
    'cancelled',
    'resolved'
  ));

-- ── 2. Add pending_payment to subscriptions status ────────────────────────────
-- initSubscriptionCheckout now inserts status='pending_payment' instead of
-- a phantom 'trial' row, so the constraint must allow it.

DO $$
DECLARE
  con_name text;
BEGIN
  SELECT conname INTO con_name
  FROM pg_constraint
  WHERE conrelid = 'public.subscriptions'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%status%';

  IF con_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.subscriptions DROP CONSTRAINT %I', con_name);
  END IF;
END;
$$;

ALTER TABLE public.subscriptions
  ADD CONSTRAINT subscriptions_status_check
  CHECK (status IN (
    'trial',
    'active',
    'expired',
    'cancelled',
    'pending_payment'
  ));

-- ── 3. Back-fill whatsapp_number from whatsapp ────────────────────────────────
-- The v2 migration added whatsapp_number as a nullable column but never
-- populated it from the original whatsapp column.  Reminders read
-- whatsapp_number, so every business that was onboarded before this fix
-- would silently skip reminder delivery.

UPDATE public.businesses
  SET whatsapp_number = whatsapp
WHERE whatsapp_number IS NULL
  AND whatsapp IS NOT NULL
  AND whatsapp != '';

-- Ensure new rows always get whatsapp_number populated via a trigger.
CREATE OR REPLACE FUNCTION public.sync_whatsapp_number()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.whatsapp_number IS NULL AND NEW.whatsapp IS NOT NULL THEN
    NEW.whatsapp_number := NEW.whatsapp;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sync_whatsapp_number_trigger ON public.businesses;
CREATE TRIGGER sync_whatsapp_number_trigger
  BEFORE INSERT OR UPDATE OF whatsapp ON public.businesses
  FOR EACH ROW EXECUTE FUNCTION public.sync_whatsapp_number();

-- ── 4. Add last_message_content / role to conversations ───────────────────────
-- Dashboard was fetching ALL messages for each conversation just to display
-- the most recent one in the list.  Caching it on the conversation row means
-- zero extra queries on dashboard load.

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS last_message_content text,
  ADD COLUMN IF NOT EXISTS last_message_role    text CHECK (last_message_role IN ('user', 'assistant'));

-- Back-fill from existing messages (most recent per conversation)
UPDATE public.conversations c
  SET
    last_message_content = sub.content,
    last_message_role    = sub.role
  FROM (
    SELECT DISTINCT ON (conversation_id)
      conversation_id, content, role
    FROM public.messages
    ORDER BY conversation_id, created_at DESC
  ) sub
  WHERE c.id = sub.conversation_id
    AND c.last_message_content IS NULL;

-- ── 5. Unique constraint on paystack_reference in subscriptions ───────────────
-- Ensure a payment retry on the same reference can't insert a duplicate row.
CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_paystack_reference_unique_idx
  ON public.subscriptions(paystack_reference)
  WHERE paystack_reference IS NOT NULL;
