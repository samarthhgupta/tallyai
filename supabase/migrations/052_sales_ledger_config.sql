-- Migration 052: Fix sales_ledger_config column format
--
-- Migration 048 created this column with a goods/services nested object shape:
--   { "goods": { "default_ledger": null, "sub_groups": {} }, "services": {...} }
-- That structure was documented as schema-only with no application logic.
-- The application now uses a flat array:
--   [{ "tally_ledger_name": "GST SALE" }, ...]
--
-- This migration:
--   1. Changes the column default to '[]' (affects future INSERT defaults only).
--   2. Backfills all existing rows that still hold the old object structure.
--      jsonb_typeof() returns 'object' for {} shapes and 'array' for [] shapes.
--      Any row already set to an array (e.g. already processed by the app) is
--      left untouched.

DO $$
DECLARE
  v_start    timestamptz := clock_timestamp();
  v_backfill integer;
BEGIN

  ALTER TABLE companies
    ALTER COLUMN sales_ledger_config SET DEFAULT '[]';

  UPDATE companies
    SET sales_ledger_config = '[]'
    WHERE jsonb_typeof(sales_ledger_config) = 'object';

  GET DIAGNOSTICS v_backfill = ROW_COUNT;

  RAISE NOTICE '------------------------------------------------------------';
  RAISE NOTICE 'Migration 052: Fix sales_ledger_config column format';
  RAISE NOTICE '------------------------------------------------------------';
  RAISE NOTICE 'Column default changed to: ''[]''';
  RAISE NOTICE 'Rows backfilled (object → array): %', v_backfill;
  RAISE NOTICE 'Completed in: % ms',
    EXTRACT(MILLISECONDS FROM (clock_timestamp() - v_start))::integer;
  RAISE NOTICE '------------------------------------------------------------';

END $$;
