-- ============================================================================
-- Migration 035 — WhatsApp Business-Scoped User ID (BSUID) support
--
-- WhatsApp usernames let a user hide their phone number from businesses.
-- When that happens, Meta sends a stable per-business identifier (BSUID)
-- instead of (or alongside) the phone number. Twilio surfaces this as the
-- `ExternalUserId` field on inbound message webhooks.
--
-- This adds a place to store that identifier on contacts so:
--   - a contact who has only ever messaged via a hidden username still gets
--     a stable row (webhook code now uses the raw BSUID as `phone` for
--     these contacts instead of mangling it through phone normalization)
--   - a contact who has a real phone on file also gets their BSUID recorded,
--     so if they later hide their number we still have a way to recognize
--     them consistently (future enhancement — this migration only adds the
--     column, the webhook fix in this same change starts populating it).
-- ============================================================================

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS external_user_id TEXT;

CREATE INDEX IF NOT EXISTS contacts_business_external_user_id_idx
  ON contacts (business_id, external_user_id)
  WHERE external_user_id IS NOT NULL;

COMMENT ON COLUMN contacts.external_user_id IS
  'WhatsApp Business-Scoped User ID (BSUID) from Twilio''s ExternalUserId webhook field. Stable per business+user even if the user hides their phone number via a WhatsApp username.';
