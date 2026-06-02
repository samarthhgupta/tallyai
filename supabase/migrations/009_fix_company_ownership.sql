-- Migration 009: Fix company ownership for companies created before auth was set up.
--
-- Problem: Companies created before login was implemented have created_by = NULL.
-- The RLS policies require created_by = auth.uid(), so those companies are
-- inaccessible for insert operations (invoice_batches, invoices).
--
-- Fix: Assign all ownerless companies to the first admin user (test@tallyai.com).
-- Also update RLS policies to gracefully handle future null cases.

-- Step 1: Claim ownership of unowned companies for the test account
UPDATE companies
SET created_by = (
  SELECT id FROM auth.users WHERE email = 'test@tallyai.com' LIMIT 1
)
WHERE created_by IS NULL;

-- Step 2: Update RLS to allow access if created_by matches OR is null
--   (belt-and-suspenders for any future ownerless rows)

DROP POLICY IF EXISTS "owner full access" ON companies;
CREATE POLICY "owner full access" ON companies
  USING (created_by = auth.uid() OR created_by IS NULL)
  WITH CHECK (created_by = auth.uid());

DROP POLICY IF EXISTS "company owner access" ON invoice_batches;
CREATE POLICY "company owner access" ON invoice_batches
  USING (
    company_id IN (
      SELECT id FROM companies WHERE created_by = auth.uid() OR created_by IS NULL
    )
  )
  WITH CHECK (
    company_id IN (
      SELECT id FROM companies WHERE created_by = auth.uid() OR created_by IS NULL
    )
  );

DROP POLICY IF EXISTS "company owner access" ON invoices;
CREATE POLICY "company owner access" ON invoices
  USING (
    company_id IN (
      SELECT id FROM companies WHERE created_by = auth.uid() OR created_by IS NULL
    )
  )
  WITH CHECK (
    company_id IN (
      SELECT id FROM companies WHERE created_by = auth.uid() OR created_by IS NULL
    )
  );

DROP POLICY IF EXISTS "company owner access" ON supplier_masters;
CREATE POLICY "company owner access" ON supplier_masters
  USING (
    company_id IN (
      SELECT id FROM companies WHERE created_by = auth.uid() OR created_by IS NULL
    )
  )
  WITH CHECK (
    company_id IN (
      SELECT id FROM companies WHERE created_by = auth.uid() OR created_by IS NULL
    )
  );

DROP POLICY IF EXISTS "company owner access" ON rejection_archive;
CREATE POLICY "company owner access" ON rejection_archive
  USING (
    company_id IN (
      SELECT id FROM companies WHERE created_by = auth.uid() OR created_by IS NULL
    )
  )
  WITH CHECK (
    company_id IN (
      SELECT id FROM companies WHERE created_by = auth.uid() OR created_by IS NULL
    )
  );
