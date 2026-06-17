-- Migration 036: Fix duties_taxes_masters unique constraint
--
-- Problem: migration 033 added UNIQUE(company_id, tax_component, tax_rate, tally_ledger_name)
-- which includes tally_ledger_name. This allows multiple rows with different ledger names
-- for the same (company_id, tax_component, tax_rate), causing non-deterministic XML.
-- It also allows infinite identical-name duplicates (same name bypasses the constraint).
--
-- Fix: Replace with UNIQUE(company_id, tax_component, tax_rate) so each component+rate
-- combination maps to exactly one ledger name per company.
--
-- Historical cleanup: delete duplicate rows, keeping the most recently updated one.

-- Step 1: Remove duplicates, keep newest per (company_id, tax_component, tax_rate)
DELETE FROM duties_taxes_masters
WHERE id NOT IN (
  SELECT DISTINCT ON (company_id, tax_component, COALESCE(tax_rate::text, 'NULL'))
    id
  FROM duties_taxes_masters
  ORDER BY company_id, tax_component, COALESCE(tax_rate::text, 'NULL'), updated_at DESC
);

-- Step 2: Replace the wrong constraint with the correct one
ALTER TABLE duties_taxes_masters
  DROP CONSTRAINT IF EXISTS uq_duties_taxes_per_company;

ALTER TABLE duties_taxes_masters
  ADD CONSTRAINT uq_duties_taxes_per_company
  UNIQUE (company_id, tax_component, tax_rate);
