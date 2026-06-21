-- Migration A: pos_import_profiles
-- Creates the POS import profile registry. Must run before Migration B
-- because invoices.source_profile_id references this table.
--
-- This table is NOT Sales-only. default_voucher_class allows any voucher type
-- so a Shopify profile can default to 'sales' and a supplier POS profile
-- can default to 'purchase'.

DO $$
DECLARE
  v_start timestamptz := clock_timestamp();
  v_rows_before integer;
  v_rows_after integer;
BEGIN

  SELECT COUNT(*) INTO v_rows_before FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'pos_import_profiles';

  CREATE TABLE IF NOT EXISTS pos_import_profiles (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id           uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    profile_name         text NOT NULL,
    source_system        text NOT NULL,
    default_voucher_class text NOT NULL DEFAULT 'sales'
      CHECK (default_voucher_class IN (
        'purchase', 'sales', 'credit_note', 'debit_note',
        'receipt', 'payment', 'journal'
      )),
    column_map           jsonb NOT NULL DEFAULT '{}',
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),
    UNIQUE (company_id, profile_name)
  );

  ALTER TABLE pos_import_profiles ENABLE ROW LEVEL SECURITY;

  DROP POLICY IF EXISTS "pos_import_profiles_company_isolation" ON pos_import_profiles;
  CREATE POLICY "pos_import_profiles_company_isolation"
    ON pos_import_profiles
    USING (company_id IN (
      SELECT company_id FROM user_companies WHERE user_id = auth.uid()
    ));

  SELECT COUNT(*) INTO v_rows_after FROM pos_import_profiles;

  RAISE NOTICE '------------------------------------------------------------';
  RAISE NOTICE 'Migration A: pos_import_profiles';
  RAISE NOTICE '------------------------------------------------------------';
  RAISE NOTICE 'Table created (rows): %', v_rows_after;
  RAISE NOTICE 'Completed in: % ms',
    EXTRACT(MILLISECONDS FROM (clock_timestamp() - v_start))::integer;
  RAISE NOTICE '------------------------------------------------------------';

END $$;
