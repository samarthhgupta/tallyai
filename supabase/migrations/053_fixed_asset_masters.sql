-- Migration 053: fixed_asset_masters
-- Stores Fixed Asset ledgers imported from Tally or created manually.
-- Each row represents one Tally ledger under the Fixed Assets group (or any sub-group of it).
-- The tally_ledger_name is sacred and stored verbatim.
-- asset_group stores the immediate parent group in Tally (e.g. "Fixed Assets", "Jewellery").

DO $$
DECLARE
  v_start timestamptz := clock_timestamp();
  v_rows_after integer;
BEGIN

  CREATE TABLE IF NOT EXISTS fixed_asset_masters (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id        uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    tally_ledger_name text NOT NULL,
    asset_group       text NOT NULL DEFAULT 'Fixed Assets',
    hsn_code          text,
    gst_percent       numeric(5,2),
    gst_applicable    boolean NOT NULL DEFAULT true,
    type_of_supply    text NOT NULL DEFAULT 'Goods'
      CHECK (type_of_supply IN ('Goods', 'Services', 'Not Applicable')),
    state_name        text,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    UNIQUE (company_id, tally_ledger_name)
  );

  ALTER TABLE fixed_asset_masters ENABLE ROW LEVEL SECURITY;

  DROP POLICY IF EXISTS "fixed_asset_masters_company_isolation" ON fixed_asset_masters;
  CREATE POLICY "fixed_asset_masters_company_isolation"
    ON fixed_asset_masters
    USING (company_id IN (
      SELECT company_id FROM user_companies WHERE user_id = auth.uid()
    ));

  SELECT COUNT(*) INTO v_rows_after FROM fixed_asset_masters;

  RAISE NOTICE '------------------------------------------------------------';
  RAISE NOTICE 'Migration 053: fixed_asset_masters';
  RAISE NOTICE '------------------------------------------------------------';
  RAISE NOTICE 'Table created (rows): %', v_rows_after;
  RAISE NOTICE 'Completed in: % ms',
    EXTRACT(MILLISECONDS FROM (clock_timestamp() - v_start))::integer;
  RAISE NOTICE '------------------------------------------------------------';

END $$;
