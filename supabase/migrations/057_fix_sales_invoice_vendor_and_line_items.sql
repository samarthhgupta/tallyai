-- Migration 057: Backfill vendor_name/vendor_gstin and fix (item) descriptions
-- for sales invoices imported before the Phase 1 code fixes were deployed.
--
-- These are data corrections, not schema changes.

DO $$
DECLARE
  v_start         timestamptz := clock_timestamp();
  v_vendor_fixed  integer;
  v_items_fixed   integer;
BEGIN

  -- ── 1. Back-fill vendor_name / vendor_gstin ───────────────────────────────
  -- Sales invoices: the seller is always our own company.
  -- Records imported before the code fix have vendor_name = NULL / ''.
  UPDATE invoices i
  SET    vendor_name  = c.name,
         vendor_gstin = COALESCE(NULLIF(c.gstin, ''), '')
  FROM   companies c
  WHERE  i.company_id      = c.id
    AND  i.voucher_class   = 'sales'
    AND  (i.vendor_name IS NULL OR trim(i.vendor_name) = '');

  GET DIAGNOSTICS v_vendor_fixed = ROW_COUNT;

  -- ── 2. Fix line_items: replace description='(item)' with HSN fallback ────
  -- Stored as a JSONB array; iterate each element and replace inline.
  UPDATE invoices
  SET    line_items = (
           SELECT jsonb_agg(
             CASE
               WHEN (item->>'description' IN ('(item)', ''))
                    AND coalesce(trim(item->>'hsn'), '') <> ''
               THEN jsonb_set(item, '{description}', to_jsonb(trim(item->>'hsn')))
               ELSE item
             END
           )
           FROM jsonb_array_elements(line_items) AS item
         )
  WHERE  voucher_class  = 'sales'
    AND  line_items      IS NOT NULL
    AND  line_items      != 'null'::jsonb
    AND  jsonb_array_length(line_items) > 0
    AND  EXISTS (
           SELECT 1
           FROM   jsonb_array_elements(line_items) AS item
           WHERE  (item->>'description' IN ('(item)', ''))
             AND  coalesce(trim(item->>'hsn'), '') <> ''
         );

  GET DIAGNOSTICS v_items_fixed = ROW_COUNT;

  RAISE NOTICE '------------------------------------------------------------';
  RAISE NOTICE 'Migration 057: fix sales invoice vendor + line_item descriptions';
  RAISE NOTICE '------------------------------------------------------------';
  RAISE NOTICE 'Vendor name/GSTIN backfilled:          % invoices', v_vendor_fixed;
  RAISE NOTICE 'Line-items description fixed (HSN):    % invoices', v_items_fixed;
  RAISE NOTICE 'Completed in: % ms',
    EXTRACT(MILLISECONDS FROM (clock_timestamp() - v_start))::integer;
  RAISE NOTICE '------------------------------------------------------------';

END $$;
