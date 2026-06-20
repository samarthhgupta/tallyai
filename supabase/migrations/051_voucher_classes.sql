-- Migration I: voucher_classes reference table.
--
-- Provides a registry of all supported voucher types. invoices.voucher_class
-- remains a TEXT CHECK constraint in Phase 1 for simplicity. The FK reference
-- to voucher_classes.code will be added in Phase 2 once the table is stable.
--
-- default_direction is NULL for voucher classes where direction depends on
-- business configuration (credit_note, debit_note, receipt, payment, journal).
-- Phase 1 only uses 'purchase'=inward and 'sales'=outward.

DO $$
DECLARE
  v_start timestamptz := clock_timestamp();
BEGIN

  CREATE TABLE IF NOT EXISTS voucher_classes (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code              text NOT NULL UNIQUE,
    display_name      text NOT NULL,
    default_direction text
      CHECK (default_direction IN ('inward', 'outward')),
    active            boolean NOT NULL DEFAULT true
  );

  INSERT INTO voucher_classes (code, display_name, default_direction) VALUES
    ('purchase',    'Purchase',    'inward'),
    ('sales',       'Sales',       'outward'),
    ('credit_note', 'Credit Note', NULL),
    ('debit_note',  'Debit Note',  NULL),
    ('receipt',     'Receipt',     NULL),
    ('payment',     'Payment',     NULL),
    ('journal',     'Journal',     NULL)
  ON CONFLICT (code) DO NOTHING;

  RAISE NOTICE '------------------------------------------------------------';
  RAISE NOTICE 'Migration I: voucher_classes reference table';
  RAISE NOTICE '------------------------------------------------------------';
  RAISE NOTICE '7 voucher class rows seeded';
  RAISE NOTICE 'NOTE: invoices.voucher_class FK reference deferred to Phase 2.';
  RAISE NOTICE 'Completed in: % ms',
    EXTRACT(MILLISECONDS FROM (clock_timestamp() - v_start))::integer;
  RAISE NOTICE '------------------------------------------------------------';

END $$;
