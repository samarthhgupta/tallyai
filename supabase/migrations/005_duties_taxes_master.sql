-- Migration 005: Duties & Taxes Master
-- Purpose: maps tax component + optional rate → exact Tally tax ledger name
-- Replaces the old ledger_masters table (HSN+rate approach)
--
-- Key rules:
--   1. tally_ledger_name stored EXACTLY as entered — no trim, no normalisation
--   2. Lookup: component + rate first; rate=NULL means consolidated (fallback)
--   3. Multiple rows allowed per component (e.g. CGST@9%, CGST@2.5%, CGST consolidated)
--   4. Does NOT calculate tax — only maps extracted amounts to Tally ledgers

CREATE TABLE IF NOT EXISTS duties_taxes_masters (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at         timestamptz DEFAULT now(),
  updated_at         timestamptz DEFAULT now(),
  company_id         uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  created_by         uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  tax_component      text NOT NULL,   -- CGST | SGST | IGST | CESS | TDS | TCS | GST TDS | GST TCS
  tax_rate           numeric(5,2),    -- NULL = consolidated (no rate distinction)
  tally_ledger_name  text NOT NULL    -- sacred — stored and output exactly as entered
);

ALTER TABLE duties_taxes_masters ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "company owner access" ON duties_taxes_masters;
CREATE POLICY "company owner access" ON duties_taxes_masters
  USING (
    company_id IN (SELECT id FROM companies WHERE created_by = auth.uid())
  )
  WITH CHECK (
    company_id IN (SELECT id FROM companies WHERE created_by = auth.uid())
  );

-- Lookup index: component + rate per company
CREATE INDEX IF NOT EXISTS idx_duties_taxes_lookup
  ON duties_taxes_masters (company_id, tax_component, tax_rate);
