-- Phase 1 Rollback Script
-- Run in REVERSE order (I → A) to safely undo all Phase 1 migrations.
-- Each section is idempotent: safe to run even if a migration was partially applied.
--
-- WARNING: Rolling back Migration H removes party_type and pref_source columns.
-- Any customer preferences inserted (should be NONE in Phase 1) will be lost.
--
-- Confirm before executing:
--   SELECT COUNT(*) FROM vendor_ledger_preferences WHERE party_type = 'customer';
--   -- Expected: 0 (customer learning is disabled in Phase 1)

BEGIN;

-- ----------------------------------------------------------------
-- Rollback I: voucher_classes
-- ----------------------------------------------------------------
DROP TABLE IF EXISTS voucher_classes;

-- ----------------------------------------------------------------
-- Rollback H: vendor_ledger_preferences party_type columns
-- ----------------------------------------------------------------
DROP INDEX IF EXISTS vendor_ledger_prefs_party_type;
ALTER TABLE vendor_ledger_preferences
  DROP COLUMN IF EXISTS party_type,
  DROP COLUMN IF EXISTS pref_source;
-- created_at and updated_at were added in migration 042; do not drop.

-- ----------------------------------------------------------------
-- Rollback G: customer_masters
-- ----------------------------------------------------------------
DROP TABLE IF EXISTS customer_masters;

-- ----------------------------------------------------------------
-- Rollback F: companies sales_ledger_config
-- ----------------------------------------------------------------
ALTER TABLE companies
  DROP COLUMN IF EXISTS sales_ledger_config;

-- ----------------------------------------------------------------
-- Rollback E: duties_taxes_masters tax_direction
-- ----------------------------------------------------------------
ALTER TABLE duties_taxes_masters
  DROP COLUMN IF EXISTS tax_direction;

-- ----------------------------------------------------------------
-- Rollback D: rejection_archive voucher fields
-- ----------------------------------------------------------------
ALTER TABLE rejection_archive
  DROP COLUMN IF EXISTS voucher_class,
  DROP COLUMN IF EXISTS party_name,
  DROP COLUMN IF EXISTS party_gstin;

-- ----------------------------------------------------------------
-- Rollback C: invoice_batches voucher fields
-- ----------------------------------------------------------------
ALTER TABLE invoice_batches
  DROP COLUMN IF EXISTS voucher_class,
  DROP COLUMN IF EXISTS source,
  DROP COLUMN IF EXISTS source_profile_id;

-- ----------------------------------------------------------------
-- Rollback B: invoices voucher fields
-- ----------------------------------------------------------------
DROP INDEX IF EXISTS invoices_company_class_status;
DROP INDEX IF EXISTS invoices_source_profile;
ALTER TABLE invoices
  DROP COLUMN IF EXISTS voucher_class,
  DROP COLUMN IF EXISTS voucher_direction,
  DROP COLUMN IF EXISTS source,
  DROP COLUMN IF EXISTS source_file_name,
  DROP COLUMN IF EXISTS source_profile_id,
  DROP COLUMN IF EXISTS source_sheet_name,
  DROP COLUMN IF EXISTS exported_at;

-- ----------------------------------------------------------------
-- Rollback A: pos_import_profiles
-- Must be last because invoices.source_profile_id FK references it
-- ----------------------------------------------------------------
DROP TABLE IF EXISTS pos_import_profiles;

COMMIT;
