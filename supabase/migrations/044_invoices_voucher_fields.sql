-- Migration B: Extend invoices with voucher classification, direction,
-- source tracking, and exported_at for the Accepted → Export Ready → Exported lifecycle.
--
-- Safeguard: All existing rows are explicitly backfilled immediately after
-- column creation. Column defaults alone are not relied upon for historical data.

DO $$
DECLARE
  v_start timestamptz := clock_timestamp();
  v_invoices_before integer;
  v_backfill_class integer;
  v_backfill_direction integer;
  v_backfill_source integer;
BEGIN

  SELECT COUNT(*) INTO v_invoices_before FROM invoices;

  -- Add voucher classification
  ALTER TABLE invoices
    ADD COLUMN IF NOT EXISTS voucher_class text NOT NULL DEFAULT 'purchase'
      CHECK (voucher_class IN (
        'purchase', 'sales', 'credit_note', 'debit_note',
        'journal', 'receipt', 'payment'
      ));

  -- Add voucher direction (Phase 1: only purchase=inward and sales=outward are used)
  ALTER TABLE invoices
    ADD COLUMN IF NOT EXISTS voucher_direction text NOT NULL DEFAULT 'inward'
      CHECK (voucher_direction IN ('inward', 'outward'));

  -- Add source tracking
  ALTER TABLE invoices
    ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'pdf_extraction'
      CHECK (source IN (
        'pdf_extraction', 'excel_import', 'pos_import',
        'api_import', 'manual_entry'
      ));

  ALTER TABLE invoices
    ADD COLUMN IF NOT EXISTS source_file_name text;

  ALTER TABLE invoices
    ADD COLUMN IF NOT EXISTS source_profile_id uuid
      REFERENCES pos_import_profiles(id) ON DELETE SET NULL;

  ALTER TABLE invoices
    ADD COLUMN IF NOT EXISTS source_sheet_name text;

  -- Add exported_at to support Accepted → Export Ready → Exported lifecycle
  -- Export Ready = accepted AND exported_at IS NULL
  -- Exported      = accepted AND exported_at IS NOT NULL
  ALTER TABLE invoices
    ADD COLUMN IF NOT EXISTS exported_at timestamptz;

  -- ----------------------------------------------------------------
  -- Explicit backfill of all existing rows.
  -- All historical invoices are purchase invoices uploaded via PDF.
  -- Do not leave existing rows relying on column defaults alone.
  -- ----------------------------------------------------------------

  UPDATE invoices
  SET voucher_class = 'purchase'
  WHERE voucher_class IS NULL OR voucher_class = '';
  GET DIAGNOSTICS v_backfill_class = ROW_COUNT;

  UPDATE invoices
  SET voucher_direction = 'inward'
  WHERE voucher_direction IS NULL OR voucher_direction = '';
  GET DIAGNOSTICS v_backfill_direction = ROW_COUNT;

  UPDATE invoices
  SET source = 'pdf_extraction'
  WHERE source IS NULL OR source = '';
  GET DIAGNOSTICS v_backfill_source = ROW_COUNT;

  -- Add index for common query pattern: filter by company + class + status
  CREATE INDEX IF NOT EXISTS invoices_company_class_status
    ON invoices (company_id, voucher_class, status);

  CREATE INDEX IF NOT EXISTS invoices_source_profile
    ON invoices (source_profile_id)
    WHERE source_profile_id IS NOT NULL;

  RAISE NOTICE '------------------------------------------------------------';
  RAISE NOTICE 'Migration B: invoices voucher fields';
  RAISE NOTICE '------------------------------------------------------------';
  RAISE NOTICE 'Invoices before:               %', v_invoices_before;
  RAISE NOTICE 'voucher_class backfilled:       %', v_backfill_class;
  RAISE NOTICE 'voucher_direction backfilled:   %', v_backfill_direction;
  RAISE NOTICE 'source backfilled:              %', v_backfill_source;
  RAISE NOTICE 'Completed in: % ms',
    EXTRACT(MILLISECONDS FROM (clock_timestamp() - v_start))::integer;
  RAISE NOTICE '------------------------------------------------------------';

END $$;
