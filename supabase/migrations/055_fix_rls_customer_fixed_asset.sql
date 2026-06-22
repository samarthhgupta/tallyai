-- Migration 055: Fix RLS INSERT policies on customer_masters and fixed_asset_masters
--
-- supplier_masters (migration 003) uses:
--   USING  (company_id IN (SELECT id FROM companies WHERE created_by = auth.uid()))
--   WITH CHECK (same)
-- This is proven to work for bulk inserts by the company owner.
--
-- customer_masters (migration 049) used only a USING clause pointing at the
-- user_companies junction table, with no WITH CHECK. PostgreSQL applies the
-- USING expression as the write check for INSERT — but if user_companies is
-- not populated for the owner, the insert is rejected even though the same
-- user can write to supplier_masters. This caused the "violates row-level
-- security policy" error during Sundry Debtor XML import.
--
-- fixed_asset_masters (migration 053) had the identical gap.
--
-- Fix: replace both policies with the same companies.created_by pattern used
-- by supplier_masters. Existing reads remain isolated to company owner.

DO $$
DECLARE
  v_start timestamptz := clock_timestamp();
BEGIN

  -- ── customer_masters ──────────────────────────────────────────────────────
  DROP POLICY IF EXISTS "customer_masters_company_isolation" ON customer_masters;
  CREATE POLICY "customer_masters_company_isolation"
    ON customer_masters
    USING (
      company_id IN (SELECT id FROM companies WHERE created_by = auth.uid())
    )
    WITH CHECK (
      company_id IN (SELECT id FROM companies WHERE created_by = auth.uid())
    );

  -- ── fixed_asset_masters ───────────────────────────────────────────────────
  DROP POLICY IF EXISTS "fixed_asset_masters_company_isolation" ON fixed_asset_masters;
  CREATE POLICY "fixed_asset_masters_company_isolation"
    ON fixed_asset_masters
    USING (
      company_id IN (SELECT id FROM companies WHERE created_by = auth.uid())
    )
    WITH CHECK (
      company_id IN (SELECT id FROM companies WHERE created_by = auth.uid())
    );

  RAISE NOTICE '------------------------------------------------------------';
  RAISE NOTICE 'Migration 055: Fix RLS policies — customer_masters, fixed_asset_masters';
  RAISE NOTICE '------------------------------------------------------------';
  RAISE NOTICE 'customer_masters: replaced user_companies USING-only policy';
  RAISE NOTICE '  with companies.created_by USING + WITH CHECK (matches supplier_masters)';
  RAISE NOTICE 'fixed_asset_masters: same fix applied';
  RAISE NOTICE 'Completed in: % ms',
    EXTRACT(MILLISECONDS FROM (clock_timestamp() - v_start))::integer;
  RAISE NOTICE '------------------------------------------------------------';

END $$;
