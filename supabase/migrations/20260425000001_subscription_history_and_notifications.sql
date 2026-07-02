-- Subscription history table: records every trial/plan event per business
CREATE TABLE IF NOT EXISTS public.subscription_history (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  event_type    text NOT NULL, -- 'trial_started' | 'trial_cancelled' | 'plan_activated' | 'plan_renewed' | 'plan_cancelled' | 'trial_expired'
  plan_id       text NOT NULL,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.subscription_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owner can read own subscription history"
ON public.subscription_history FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.businesses b
  WHERE b.id = subscription_history.business_id AND b.owner_id = auth.uid()
));

CREATE POLICY "Owner can insert own subscription history"
ON public.subscription_history FOR INSERT TO authenticated
WITH CHECK (EXISTS (
  SELECT 1 FROM public.businesses b
  WHERE b.id = subscription_history.business_id AND b.owner_id = auth.uid()
));

-- Add trial_notification_sent column to subscriptions to track 24h warning
ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS trial_reminder_sent_at timestamptz DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz DEFAULT NULL;
