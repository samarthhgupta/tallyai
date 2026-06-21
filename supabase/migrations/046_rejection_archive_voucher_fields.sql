-- Migration D: Extend rejection_archive with voucher class and generalised party fields.
-- Existing columns vendor_name/vendor_gstin are preserved unchanged.
-- New party_name/party_gstin are the generalised equivalents used by Sales and future types.
--
-- Safeguard: Explicit backfill copies existing vendor data into party fields
-- for all historical rejection records.

DO $$
DECLARE
  v_start timestamptz := clock_timestamp();
  v_archive_before integer;
  v_backfill_class integer;
  v_backfill_party integer;
BEGIN

  SELECT COUNT(*) INTO v_archive_before FROM rejection_archive;

  ALTER TABLE rejection_archive
    ADD COLUMN IF NOT EXISTS voucher_class text NOT NULL DEFAULT 'purchase'
      CHECK (voucher_class IN (
        'purchase', 'sales', 'credit_note', 'debit_note',
        'journal', 'receipt', 'payment'
      ));

  -- Generalised party columns (vendor_name/vendor_gstin remain for backwards compat)
  ALTER TABLE rejection_archive
    ADD COLUMN IF NOT EXISTS party_name text;

  ALTER TABLE rejection_archive
    ADD COLUMN IF NOT EXISTS party_gstin text;

  -- Explicit backfill
  UPDATE rejection_archive
  SET voucher_class = 'purchase'
  WHERE voucher_class IS NULL OR voucher_class = '';
  GET DIAGNOSTICS v_backfill_class = ROW_COUNT;

  -- Populate party fields from vendor fields for all historical records
  UPDATE rejection_archive
  SET
    party_name  = vendor_name,
    party_gstin = vendor_gstin
  WHERE party_name IS NULL;
  GET DIAGNOSTICS v_backfill_party = ROW_COUNT;

  RAISE NOTICE '------------------------------------------------------------';
  RAISE NOTICE 'Migration D: rejection_archive voucher fields';
  RAISE NOTICE '------------------------------------------------------------';
  RAISE NOTICE 'Archive rows before:         %', v_archive_before;
  RAISE NOTICE 'voucher_class backfilled:    %', v_backfill_class;
  RAISE NOTICE 'party fields backfilled:     %', v_backfill_party;
  RAISE NOTICE 'Completed in: % ms',
    EXTRACT(MILLISECONDS FROM (clock_timestamp() - v_start))::integer;
  RAISE NOTICE '------------------------------------------------------------';

END $$;
