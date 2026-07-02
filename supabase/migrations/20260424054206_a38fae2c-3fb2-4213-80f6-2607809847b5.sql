CREATE POLICY "Owner can insert own subscription"
ON public.subscriptions
FOR INSERT
TO authenticated
WITH CHECK (EXISTS (
  SELECT 1 FROM public.businesses b
  WHERE b.id = subscriptions.business_id AND b.owner_id = auth.uid()
));

CREATE POLICY "Owner can update own subscription"
ON public.subscriptions
FOR UPDATE
TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.businesses b
  WHERE b.id = subscriptions.business_id AND b.owner_id = auth.uid()
));