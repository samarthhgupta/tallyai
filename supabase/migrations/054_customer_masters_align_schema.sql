-- Migration 054: Align customer_masters schema with application expectations
--
-- Migration 049 created the table with column name 'gstin' but all application
-- code uses 'customer_gstin'. Also adds state_name and gstin_valid columns
-- that the application writes but the table currently lacks.
--
-- The unique index customer_masters_gstin_unique references the column by
-- predicate value, not name — PostgreSQL updates it automatically on rename.

DO $$
DECLARE
  v_start timestamptz := clock_timestamp();
BEGIN

  -- Rename gstin → customer_gstin to match application column expectations.
  -- IF the column was already renamed by a prior run, this will error — hence
  -- we check first.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'customer_masters'
      AND column_name  = 'gstin'
  ) THEN
    ALTER TABLE customer_masters RENAME COLUMN gstin TO customer_gstin;
  END IF;

  -- Add state_name if missing.
  ALTER TABLE customer_masters
    ADD COLUMN IF NOT EXISTS state_name text;

  -- Add gstin_valid if missing.
  ALTER TABLE customer_masters
    ADD COLUMN IF NOT EXISTS gstin_valid boolean NOT NULL DEFAULT true;

  RAISE NOTICE '------------------------------------------------------------';
  RAISE NOTICE 'Migration 054: customer_masters schema alignment';
  RAISE NOTICE '------------------------------------------------------------';
  RAISE NOTICE 'Renamed gstin → customer_gstin (if not already done)';
  RAISE NOTICE 'Added state_name column (if not already present)';
  RAISE NOTICE 'Added gstin_valid column (if not already present)';
  RAISE NOTICE 'Completed in: % ms',
    EXTRACT(MILLISECONDS FROM (clock_timestamp() - v_start))::integer;
  RAISE NOTICE '------------------------------------------------------------';

END $$;
