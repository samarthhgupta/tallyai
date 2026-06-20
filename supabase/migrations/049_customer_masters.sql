-- Migration G: customer_masters table.
--
-- B2C support is first-class: gstin=NULL is a valid primary use case, not an edge case.
-- is_b2c flag is authoritative; gstin=NULL alone does not imply B2C.
--
-- Uniqueness strategy:
--   Registered (gstin IS NOT NULL): unique by (company_id, gstin)
--   B2C (gstin IS NULL):            unique by (company_id, tally_ledger_name) where ledger is set
--   No unique constraint on customer_name — "Cash Customer" may appear many times.

DO $$
DECLARE
  v_start timestamptz := clock_timestamp();
BEGIN

  CREATE TABLE IF NOT EXISTS customer_masters (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id        uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    customer_name     text NOT NULL,
    gstin             text,
    trade_name        text,
    address           text,
    state_code        text,
    pincode           text,
    phone             text,
    email             text,
    tally_ledger_name text,
    is_b2c            boolean NOT NULL DEFAULT false,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
  );

  -- Registered customers: unique by GSTIN
  CREATE UNIQUE INDEX IF NOT EXISTS customer_masters_gstin_unique
    ON customer_masters (company_id, gstin)
    WHERE gstin IS NOT NULL;

  -- B2C customers: unique by Tally ledger name
  -- Handles "Cash Customer", "Walk-in Customer" as distinct named buckets
  CREATE UNIQUE INDEX IF NOT EXISTS customer_masters_b2c_ledger_unique
    ON customer_masters (company_id, tally_ledger_name)
    WHERE gstin IS NULL AND tally_ledger_name IS NOT NULL;

  -- Performance index for B2C queries
  CREATE INDEX IF NOT EXISTS customer_masters_is_b2c
    ON customer_masters (company_id, is_b2c)
    WHERE is_b2c = true;

  ALTER TABLE customer_masters ENABLE ROW LEVEL SECURITY;

  DROP POLICY IF EXISTS "customer_masters_company_isolation" ON customer_masters;
  CREATE POLICY "customer_masters_company_isolation"
    ON customer_masters
    USING (company_id IN (
      SELECT company_id FROM user_companies WHERE user_id = auth.uid()
    ));

  RAISE NOTICE '------------------------------------------------------------';
  RAISE NOTICE 'Migration G: customer_masters';
  RAISE NOTICE '------------------------------------------------------------';
  RAISE NOTICE 'Table created (new, 0 rows expected)';
  RAISE NOTICE 'Completed in: % ms',
    EXTRACT(MILLISECONDS FROM (clock_timestamp() - v_start))::integer;
  RAISE NOTICE '------------------------------------------------------------';

END $$;
