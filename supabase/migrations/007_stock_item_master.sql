-- Migration 007: Stock Item Master
-- Purpose: maps invoice line item descriptions to exact Tally stock item names
--
-- Key rules:
--   1. tally_item_name stored EXACTLY as entered — no trim, no normalisation
--   2. alias_name is the invoice-side description used for matching
--   3. HSN code is optional — XML generation must not depend on it
--   4. Multiple alias names can point to the same Tally stock item

CREATE TABLE IF NOT EXISTS stock_item_masters (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at        timestamptz DEFAULT now(),
  updated_at        timestamptz DEFAULT now(),
  company_id        uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  created_by        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  tally_item_name   text NOT NULL,   -- sacred — stored and output exactly as entered
  alias_name        text,            -- alternate description as it appears on invoice
  unit              text,            -- e.g. NOS, KG, MTR, BOX (optional)
  hsn_code          text             -- optional — never blocks XML generation
);

ALTER TABLE stock_item_masters ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "company owner access" ON stock_item_masters;
CREATE POLICY "company owner access" ON stock_item_masters
  USING (
    company_id IN (SELECT id FROM companies WHERE created_by = auth.uid())
  )
  WITH CHECK (
    company_id IN (SELECT id FROM companies WHERE created_by = auth.uid())
  );

-- Unique: one record per tally_item_name per company
CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_item_masters_name
  ON stock_item_masters (company_id, tally_item_name);

-- Lookup by alias
CREATE INDEX IF NOT EXISTS idx_stock_item_masters_alias
  ON stock_item_masters (company_id, alias_name);

CREATE INDEX IF NOT EXISTS idx_stock_item_masters_company
  ON stock_item_masters (company_id);
