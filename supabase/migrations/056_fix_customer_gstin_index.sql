-- Migration 056: Fix customer_masters unique indexes for empty-string GSTIN
--
-- Migration 049 designed the indexes assuming NULL for B2C (unregistered) customers:
--   B2B index: WHERE gstin IS NOT NULL
--   B2C index: WHERE gstin IS NULL
--
-- The application's normaliseCustomerGstin() returns '' (empty string), not NULL,
-- for B2C / unregistered customers. In PostgreSQL, '' IS NOT NULL is TRUE, so every
-- B2C row (customer_gstin = '') falls under the B2B partial index.
-- The second B2C customer for any company triggers:
--   "duplicate key value violates unique constraint customer_masters_gstin_unique"
--
-- Fix: rebuild both indexes to use != '' as the B2B predicate, and
--      (IS NULL OR = '') as the B2C predicate.
--
-- Migration 054 renamed gstin -> customer_gstin. PostgreSQL updates index column
-- references automatically on RENAME COLUMN, so the index already covers
-- customer_gstin — we DROP and recreate to make the predicates correct.

DO $$
DECLARE
  v_start timestamptz := clock_timestamp();
BEGIN

  -- B2B index: unique per (company_id, customer_gstin) for non-empty GSTINs only.
  DROP INDEX IF EXISTS customer_masters_gstin_unique;
  CREATE UNIQUE INDEX customer_masters_gstin_unique
    ON customer_masters (company_id, customer_gstin)
    WHERE customer_gstin IS NOT NULL AND customer_gstin != '';

  -- B2C index: unique per (company_id, tally_ledger_name) when GSTIN is absent.
  DROP INDEX IF EXISTS customer_masters_b2c_ledger_unique;
  CREATE UNIQUE INDEX customer_masters_b2c_ledger_unique
    ON customer_masters (company_id, tally_ledger_name)
    WHERE (customer_gstin IS NULL OR customer_gstin = '') AND tally_ledger_name IS NOT NULL;

  RAISE NOTICE '------------------------------------------------------------';
  RAISE NOTICE 'Migration 056: Fix customer_masters partial index predicates';
  RAISE NOTICE '------------------------------------------------------------';
  RAISE NOTICE 'Rebuilt customer_masters_gstin_unique with != '''' predicate';
  RAISE NOTICE 'Rebuilt customer_masters_b2c_ledger_unique with IS NULL OR = '''' predicate';
  RAISE NOTICE 'Completed in: % ms',
    EXTRACT(MILLISECONDS FROM (clock_timestamp() - v_start))::integer;
  RAISE NOTICE '------------------------------------------------------------';

END $$;
