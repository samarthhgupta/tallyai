-- Migration 004: Redesign supplier_masters for Phase 1 architecture
-- Changes:
--   1. vendor_gstin → nullable (unregistered parties have no GSTIN)
--   2. Add state_name (auto-derived, never user-entered)
--   3. Add is_unregistered flag
--   4. Add gstin_valid flag (invalid format allowed but flagged)
--   5. Add updated_at
--   6. Drop old UNIQUE(company_id, vendor_gstin) — replace with partial indexes
--   7. Remove old ledger_masters table (replaced by duties_taxes_masters in next migration)

-- ── supplier_masters: add missing columns ─────────────────────────────────────

ALTER TABLE supplier_masters
  ALTER COLUMN vendor_gstin DROP NOT NULL;

ALTER TABLE supplier_masters
  ADD COLUMN IF NOT EXISTS state_name        text,
  ADD COLUMN IF NOT EXISTS is_unregistered   boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS gstin_valid       boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS updated_at        timestamptz DEFAULT now();

-- Drop old unique constraint (vendor_gstin was NOT NULL before)
ALTER TABLE supplier_masters
  DROP CONSTRAINT IF EXISTS supplier_masters_company_id_vendor_gstin_key;

-- Registered: unique by company + GSTIN
CREATE UNIQUE INDEX IF NOT EXISTS idx_supplier_masters_registered
  ON supplier_masters (company_id, vendor_gstin)
  WHERE vendor_gstin IS NOT NULL AND vendor_gstin != '';

-- Unregistered: unique by company + tally_ledger_name
CREATE UNIQUE INDEX IF NOT EXISTS idx_supplier_masters_unregistered
  ON supplier_masters (company_id, tally_ledger_name)
  WHERE vendor_gstin IS NULL OR vendor_gstin = '';

-- General lookup index
CREATE INDEX IF NOT EXISTS idx_supplier_masters_company
  ON supplier_masters (company_id);
