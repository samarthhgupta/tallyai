-- Migration C: Extend invoice_batches with voucher classification and source tracking.
--
-- Safeguard: Existing rows are explicitly backfilled after column creation.

DO $$
DECLARE
  v_start timestamptz := clock_timestamp();
  v_batches_before integer;
  v_backfill_class integer;
  v_backfill_source integer;
BEGIN

  SELECT COUNT(*) INTO v_batches_before FROM invoice_batches;

  ALTER TABLE invoice_batches
    ADD COLUMN IF NOT EXISTS voucher_class text NOT NULL DEFAULT 'purchase'
      CHECK (voucher_class IN (
        'purchase', 'sales', 'credit_note', 'debit_note',
        'journal', 'receipt', 'payment'
      ));

  ALTER TABLE invoice_batches
    ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'pdf_extraction'
      CHECK (source IN (
        'pdf_extraction', 'excel_import', 'pos_import',
        'api_import', 'manual_entry'
      ));

  ALTER TABLE invoice_batches
    ADD COLUMN IF NOT EXISTS source_profile_id uuid
      REFERENCES pos_import_profiles(id) ON DELETE SET NULL;

  -- Explicit backfill
  UPDATE invoice_batches
  SET voucher_class = 'purchase'
  WHERE voucher_class IS NULL OR voucher_class = '';
  GET DIAGNOSTICS v_backfill_class = ROW_COUNT;

  UPDATE invoice_batches
  SET source = 'pdf_extraction'
  WHERE source IS NULL OR source = '';
  GET DIAGNOSTICS v_backfill_source = ROW_COUNT;

  RAISE NOTICE '------------------------------------------------------------';
  RAISE NOTICE 'Migration C: invoice_batches voucher fields';
  RAISE NOTICE '------------------------------------------------------------';
  RAISE NOTICE 'Batches before:           %', v_batches_before;
  RAISE NOTICE 'voucher_class backfilled: %', v_backfill_class;
  RAISE NOTICE 'source backfilled:        %', v_backfill_source;
  RAISE NOTICE 'Completed in: % ms',
    EXTRACT(MILLISECONDS FROM (clock_timestamp() - v_start))::integer;
  RAISE NOTICE '------------------------------------------------------------';

END $$;
