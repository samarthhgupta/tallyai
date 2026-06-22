-- Migration 052: sales_ledger_config
-- Adds sales_ledger_config to companies table, mirroring purchase_ledger_config.
-- Stores the list of Tally Sales Account ledger names for this company.
-- Format: [{ "tally_ledger_name": "GST SALE" }, ...]

DO $$
DECLARE
  v_start timestamptz := clock_timestamp();
BEGIN

  ALTER TABLE companies
    ADD COLUMN IF NOT EXISTS sales_ledger_config jsonb NOT NULL DEFAULT '[]';

  RAISE NOTICE '------------------------------------------------------------';
  RAISE NOTICE 'Migration 052: sales_ledger_config';
  RAISE NOTICE '------------------------------------------------------------';
  RAISE NOTICE 'Added sales_ledger_config column to companies';
  RAISE NOTICE 'Completed in: % ms',
    EXTRACT(MILLISECONDS FROM (clock_timestamp() - v_start))::integer;
  RAISE NOTICE '------------------------------------------------------------';

END $$;
