-- Migration E: Add tax_direction to duties_taxes_masters.
-- All existing rows are purchase-side (input tax). Backfill explicitly.
--
-- Values:
--   input           = tax paid on purchases (claimable as ITC)
--   output          = tax collected on sales (payable to govt)
--   unclaimed_input = input tax not claimed as ITC (blocked, exempt categories)

DO $$
DECLARE
  v_start timestamptz := clock_timestamp();
  v_masters_before integer;
  v_backfill_direction integer;
BEGIN

  SELECT COUNT(*) INTO v_masters_before FROM duties_taxes_masters;

  ALTER TABLE duties_taxes_masters
    ADD COLUMN IF NOT EXISTS tax_direction text NOT NULL DEFAULT 'input'
      CHECK (tax_direction IN ('input', 'output', 'unclaimed_input'));

  -- All existing rows are input tax (purchase side)
  UPDATE duties_taxes_masters
  SET tax_direction = 'input'
  WHERE tax_direction IS NULL OR tax_direction = '';
  GET DIAGNOSTICS v_backfill_direction = ROW_COUNT;

  RAISE NOTICE '------------------------------------------------------------';
  RAISE NOTICE 'Migration E: duties_taxes_masters tax_direction';
  RAISE NOTICE '------------------------------------------------------------';
  RAISE NOTICE 'Masters before:            %', v_masters_before;
  RAISE NOTICE 'tax_direction backfilled:  %', v_backfill_direction;
  RAISE NOTICE 'Completed in: % ms',
    EXTRACT(MILLISECONDS FROM (clock_timestamp() - v_start))::integer;
  RAISE NOTICE '------------------------------------------------------------';

END $$;
