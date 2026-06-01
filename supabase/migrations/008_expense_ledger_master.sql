-- Migration 008: Expense Ledger Master
-- Purpose: maps expense descriptions on invoices to exact Tally expense ledger names
-- Examples: Freight, Courier, Packing, Loading, Insurance, Labour, Handling Charges
--
-- Key rules:
--   1. tally_ledger_name stored EXACTLY as entered — no trim, no normalisation
--   2. expense_keyword is the invoice-side term used for matching (optional)
--   3. SAC code is optional — XML generation never depends on it
--   4. No GST logic stored here — this master only maps descriptions to ledgers

CREATE TABLE IF NOT EXISTS expense_ledger_masters (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at         timestamptz DEFAULT now(),
  updated_at         timestamptz DEFAULT now(),
  company_id         uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  created_by         uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  tally_ledger_name  text NOT NULL,  -- sacred — stored and output exactly as entered
  expense_keyword    text,           -- invoice-side term for matching (e.g. "freight")
  sac_code           text            -- optional
);

ALTER TABLE expense_ledger_masters ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "company owner access" ON expense_ledger_masters;
CREATE POLICY "company owner access" ON expense_ledger_masters
  USING (
    company_id IN (SELECT id FROM companies WHERE created_by = auth.uid())
  )
  WITH CHECK (
    company_id IN (SELECT id FROM companies WHERE created_by = auth.uid())
  );

-- Unique: one record per ledger name per company
CREATE UNIQUE INDEX IF NOT EXISTS idx_expense_ledger_masters_name
  ON expense_ledger_masters (company_id, tally_ledger_name);

-- Lookup by keyword
CREATE INDEX IF NOT EXISTS idx_expense_ledger_masters_keyword
  ON expense_ledger_masters (company_id, expense_keyword);

CREATE INDEX IF NOT EXISTS idx_expense_ledger_masters_company
  ON expense_ledger_masters (company_id);
