-- Migration 029: Wabizz appointment payment tracking table
--
-- When a hospital booking is made via WhatsApp and a consultation fee is required,
-- hospital-intent-handler.ts creates a Paystack payment link and writes a row here.
-- The Paystack webhook uses this table to look up the appointment by paystack_ref
-- and send the patient a confirmation message once payment clears.
--
-- This is intentionally separate from Vitar's own appointment table — Vitar is a
-- separate service and Wabizz does not write directly to its database.

-- ── Table ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wabizz_appointments (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id       UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  -- Vitar appointment UUID (from POST /api/v1/appointments/wabizz response)
  vitar_appointment_id  TEXT NOT NULL,
  patient_phone     TEXT NOT NULL,
  patient_name      TEXT,
  doctor_name       TEXT,
  scheduled_at      TIMESTAMPTZ,
  consultation_fee  NUMERIC(10, 2),
  -- Paystack reference set after createPaymentLink() is called
  paystack_ref      TEXT,
  -- Set to true after charge.success fires and customer is notified
  confirmation_sent BOOLEAN NOT NULL DEFAULT false,
  paid_at           TIMESTAMPTZ,
  created_at        TIMESTAMPTZ DEFAULT now()
);

-- ── Indexes ───────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_wabizz_appointments_business_id
  ON wabizz_appointments(business_id);

CREATE INDEX IF NOT EXISTS idx_wabizz_appointments_paystack_ref
  ON wabizz_appointments(paystack_ref)
  WHERE paystack_ref IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_wabizz_appointments_patient_phone
  ON wabizz_appointments(business_id, patient_phone);

-- ── Row-Level Security ────────────────────────────────────────────────────────
ALTER TABLE wabizz_appointments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "wabizz_appointments_owner_select" ON wabizz_appointments
  FOR SELECT USING (
    business_id IN (
      SELECT id FROM businesses WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "wabizz_appointments_service_role" ON wabizz_appointments
  FOR ALL USING (auth.role() = 'service_role');
