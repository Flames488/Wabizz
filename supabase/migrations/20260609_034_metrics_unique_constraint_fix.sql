-- ============================================================================
-- Migration 034 — Fix metrics table UNIQUE constraint for NULL source
--
-- BUG: The existing UNIQUE (metric, bucket_at, source) constraint does NOT
-- fire when source IS NULL, because in PostgreSQL NULL != NULL. This means
-- every INSERT with source = NULL creates a new row instead of hitting the
-- conflict target, causing the metrics table to grow unbounded with thousands
-- of duplicate counter rows per bucket.
--
-- FIX: Replace the column-level UNIQUE constraint with a partial unique index
-- that uses COALESCE to treat NULL as an empty string sentinel, making the
-- uniqueness check work correctly for NULL source values.
-- ============================================================================

-- Step 1: Drop the broken constraint
ALTER TABLE public.metrics
  DROP CONSTRAINT IF EXISTS uq_metric_bucket;

-- Step 2: Add a unique index using COALESCE so NULLs are treated as ''
-- This makes (metric='jobs_created', bucket_at='...', source=NULL) unique
-- the same way (metric='jobs_created', bucket_at='...', source='queue') is.
CREATE UNIQUE INDEX IF NOT EXISTS uq_metric_bucket_coalesce
  ON public.metrics (metric, bucket_at, COALESCE(source, ''));

-- Step 3: Clean up any duplicate rows that accumulated before this fix.
-- Keep the row with the highest value per (metric, bucket_at, source) group.
-- This runs in a CTE to avoid deleting the wrong row.
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY metric, bucket_at, COALESCE(source, '')
      ORDER BY value DESC, created_at DESC
    ) AS rn
  FROM public.metrics
),
to_delete AS (
  SELECT id FROM ranked WHERE rn > 1
)
DELETE FROM public.metrics
WHERE id IN (SELECT id FROM to_delete);
