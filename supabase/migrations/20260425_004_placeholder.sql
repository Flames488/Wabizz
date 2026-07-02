-- Migration 004 — Chain continuity placeholder
--
-- Migrations 004 and 005 were intentionally skipped during v3–v5
-- development (those version bumps carried no schema changes).
-- These placeholder files exist solely to keep the migration chain
-- contiguous so `supabase db status` does not flag a gap.
--
-- No schema changes in this file.
SELECT 1; -- no-op
