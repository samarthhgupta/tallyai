-- Migration F: Add sales_ledger_config to companies.
-- JSON structure is future-proofed for goods/services hierarchy.
-- No application logic uses this in Phase 1 — schema only.

DO $$
DECLARE
  v_start timestamptz := clock_timestamp();
  v_companies_before integer;
BEGIN

  SELECT COUNT(*) INTO v_companies_before FROM companies;

  ALTER TABLE companies
    ADD COLUMN IF NOT EXISTS sales_ledger_config jsonb NOT NULL DEFAULT '{
      "goods": {
        "default_ledger": null,
        "sub_groups": {}
      },
      "services": {
        "default_ledger": null,
        "sub_groups": {}
      }
    }';

  RAISE NOTICE '------------------------------------------------------------';
  RAISE NOTICE 'Migration F: companies sales_ledger_config';
  RAISE NOTICE '------------------------------------------------------------';
  RAISE NOTICE 'Companies before: %', v_companies_before;
  RAISE NOTICE 'Column added with default JSON (no backfill required — default is valid for all rows)';
  RAISE NOTICE 'Completed in: % ms',
    EXTRACT(MILLISECONDS FROM (clock_timestamp() - v_start))::integer;
  RAISE NOTICE '------------------------------------------------------------';

END $$;
