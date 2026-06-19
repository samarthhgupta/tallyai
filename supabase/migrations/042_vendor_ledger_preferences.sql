CREATE TABLE IF NOT EXISTS vendor_ledger_preferences (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  vendor_key  text NOT NULL,
  -- vendor_key is: vendor_gstin (uppercased) when GSTIN is present and valid
  ledger_type text NOT NULL,
  -- 'purchase' | 'CGST' | 'SGST' | 'IGST' | 'CESS'
  ledger_name text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, vendor_key, ledger_type)
);

CREATE INDEX IF NOT EXISTS vendor_ledger_preferences_company_vendor
  ON vendor_ledger_preferences (company_id, vendor_key);

ALTER TABLE vendor_ledger_preferences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Company owner access"
  ON vendor_ledger_preferences FOR ALL
  USING (
    company_id IN (SELECT id FROM companies WHERE created_by = auth.uid())
  )
  WITH CHECK (
    company_id IN (SELECT id FROM companies WHERE created_by = auth.uid())
  );
