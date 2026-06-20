-- Phase 1 Validation Script
-- Run this in the Supabase SQL Editor (or via psql) AFTER applying migrations 043–051.
-- It produces 6 reports covering migration execution, schema, row counts,
-- Purchase Register smoke test, learning engine smoke test, and rollback validity.
-- No data is modified. All statements are SELECT / information_schema queries.

-- ============================================================
-- REPORT 1: Schema Verification — All new columns and tables
-- ============================================================

SELECT '=== REPORT 1: SCHEMA VERIFICATION ===' AS report;

-- 1a. New tables
SELECT
  table_name,
  CASE WHEN table_name IN (
    'pos_import_profiles', 'customer_masters', 'voucher_classes'
  ) THEN 'EXPECTED' ELSE 'UNEXPECTED' END AS expected
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('pos_import_profiles', 'customer_masters', 'voucher_classes')
ORDER BY table_name;

-- 1b. New columns on invoices
SELECT
  column_name,
  data_type,
  column_default,
  is_nullable,
  CASE WHEN column_name IN (
    'voucher_class','voucher_direction','source',
    'source_file_name','source_profile_id','source_sheet_name','exported_at'
  ) THEN 'EXPECTED' ELSE 'UNEXPECTED' END AS expected
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'invoices'
  AND column_name IN (
    'voucher_class','voucher_direction','source',
    'source_file_name','source_profile_id','source_sheet_name','exported_at'
  )
ORDER BY column_name;

-- 1c. New columns on invoice_batches
SELECT column_name, data_type, column_default, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'invoice_batches'
  AND column_name IN ('voucher_class','source','source_profile_id')
ORDER BY column_name;

-- 1d. New columns on rejection_archive
SELECT column_name, data_type, column_default, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'rejection_archive'
  AND column_name IN ('voucher_class','party_name','party_gstin')
ORDER BY column_name;

-- 1e. New column on duties_taxes_masters
SELECT column_name, data_type, column_default, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'duties_taxes_masters'
  AND column_name = 'tax_direction';

-- 1f. New column on companies
SELECT column_name, data_type, column_default, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'companies'
  AND column_name = 'sales_ledger_config';

-- 1g. New columns on vendor_ledger_preferences
SELECT column_name, data_type, column_default, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'vendor_ledger_preferences'
  AND column_name IN ('party_type','pref_source')
ORDER BY column_name;

-- 1h. CHECK constraints on invoices
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'invoices'::regclass
  AND contype = 'c'
  AND conname LIKE '%voucher%' OR conname LIKE '%source%' OR conname LIKE '%direction%';

-- 1i. Indexes created by migrations
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename IN ('invoices','vendor_ledger_preferences','customer_masters')
  AND indexname IN (
    'invoices_company_class_status',
    'invoices_source_profile',
    'customer_masters_gstin_unique',
    'customer_masters_b2c_ledger_unique',
    'customer_masters_is_b2c',
    'vendor_ledger_prefs_party_type'
  )
ORDER BY indexname;

-- 1j. voucher_classes seed data
SELECT code, display_name, default_direction, active FROM voucher_classes ORDER BY code;

-- ============================================================
-- REPORT 2: Row-Count Validation
-- ============================================================

SELECT '=== REPORT 2: ROW-COUNT VALIDATION ===' AS report;

-- 2a. invoices: all rows must have non-null voucher_class, voucher_direction, source
SELECT
  COUNT(*)                                                          AS total_invoices,
  COUNT(*) FILTER (WHERE voucher_class IS NOT NULL)                AS has_voucher_class,
  COUNT(*) FILTER (WHERE voucher_direction IS NOT NULL)            AS has_voucher_direction,
  COUNT(*) FILTER (WHERE source IS NOT NULL)                       AS has_source,
  COUNT(*) FILTER (WHERE voucher_class = 'purchase')               AS is_purchase,
  COUNT(*) FILTER (WHERE voucher_direction = 'inward')             AS is_inward,
  COUNT(*) FILTER (WHERE source = 'pdf_extraction')                AS is_pdf,
  -- These should all be 0 (no orphan rows)
  COUNT(*) FILTER (WHERE voucher_class IS NULL)                    AS NULL_class_SHOULD_BE_0,
  COUNT(*) FILTER (WHERE voucher_direction IS NULL)                AS NULL_direction_SHOULD_BE_0,
  COUNT(*) FILTER (WHERE source IS NULL)                           AS NULL_source_SHOULD_BE_0
FROM invoices;

-- 2b. invoice_batches: all rows must have non-null voucher_class, source
SELECT
  COUNT(*)                                                AS total_batches,
  COUNT(*) FILTER (WHERE voucher_class = 'purchase')     AS is_purchase,
  COUNT(*) FILTER (WHERE source = 'pdf_extraction')      AS is_pdf,
  COUNT(*) FILTER (WHERE voucher_class IS NULL)          AS NULL_class_SHOULD_BE_0,
  COUNT(*) FILTER (WHERE source IS NULL)                 AS NULL_source_SHOULD_BE_0
FROM invoice_batches;

-- 2c. rejection_archive: all rows must have non-null voucher_class
SELECT
  COUNT(*)                                                AS total_archived,
  COUNT(*) FILTER (WHERE voucher_class = 'purchase')     AS is_purchase,
  COUNT(*) FILTER (WHERE party_name IS NOT NULL)         AS has_party_name,
  COUNT(*) FILTER (WHERE voucher_class IS NULL)          AS NULL_class_SHOULD_BE_0
FROM rejection_archive;

-- 2d. duties_taxes_masters: all rows must have tax_direction = 'input'
SELECT
  COUNT(*)                                                AS total_masters,
  COUNT(*) FILTER (WHERE tax_direction = 'input')        AS is_input,
  COUNT(*) FILTER (WHERE tax_direction IS NULL)          AS NULL_direction_SHOULD_BE_0,
  COUNT(*) FILTER (WHERE tax_direction != 'input')       AS non_input_SHOULD_BE_0
FROM duties_taxes_masters;

-- 2e. vendor_ledger_preferences: all rows must have party_type = 'vendor'
SELECT
  COUNT(*)                                                AS total_prefs,
  COUNT(*) FILTER (WHERE party_type = 'vendor')          AS is_vendor,
  COUNT(*) FILTER (WHERE pref_source = 'learned')        AS is_learned,
  COUNT(*) FILTER (WHERE party_type IS NULL)             AS NULL_type_SHOULD_BE_0,
  -- Customer learning must be 0 in Phase 1
  COUNT(*) FILTER (WHERE party_type = 'customer')        AS customer_rows_SHOULD_BE_0
FROM vendor_ledger_preferences;

-- 2f. New tables: should be empty (Phase 1 creates schema only)
SELECT 'pos_import_profiles' AS tbl, COUNT(*) AS row_count FROM pos_import_profiles
UNION ALL
SELECT 'customer_masters',           COUNT(*) FROM customer_masters
UNION ALL
SELECT 'voucher_classes',            COUNT(*) FROM voucher_classes;
-- Expected: pos_import_profiles=0, customer_masters=0, voucher_classes=7

-- ============================================================
-- REPORT 3: Purchase Register Smoke Test
-- ============================================================

SELECT '=== REPORT 3: PURCHASE REGISTER SMOKE TEST ===' AS report;

-- 3a. Status distribution — must match pre-migration distribution
SELECT status, COUNT(*) AS count
FROM invoices
WHERE voucher_class = 'purchase'
GROUP BY status
ORDER BY status;

-- 3b. Readiness distribution
SELECT readiness, COUNT(*) AS count
FROM invoices
WHERE voucher_class = 'purchase'
GROUP BY readiness
ORDER BY readiness;

-- 3c. Recent accepted invoices still have accepted_at
SELECT COUNT(*) AS accepted_with_timestamp
FROM invoices
WHERE status = 'accepted' AND accepted_at IS NOT NULL;

-- 3d. line_items JSON intact (sample 5 rows)
SELECT id, invoice_number, vendor_name,
       jsonb_array_length(line_items) AS line_item_count
FROM invoices
WHERE line_items IS NOT NULL AND jsonb_array_length(line_items) > 0
ORDER BY created_at DESC
LIMIT 5;

-- 3e. Batch → invoice relationship intact
SELECT
  ib.id AS batch_id,
  ib.voucher_class AS batch_class,
  COUNT(i.id) AS invoice_count_in_batch
FROM invoice_batches ib
LEFT JOIN invoices i ON i.batch_id = ib.id
GROUP BY ib.id, ib.voucher_class
ORDER BY ib.created_at DESC
LIMIT 5;

-- ============================================================
-- REPORT 4: Learning Engine Smoke Test
-- ============================================================

SELECT '=== REPORT 4: LEARNING ENGINE SMOKE TEST ===' AS report;

-- 4a. All existing preferences are vendor type
SELECT
  ledger_type,
  party_type,
  pref_source,
  COUNT(*) AS count
FROM vendor_ledger_preferences
GROUP BY ledger_type, party_type, pref_source
ORDER BY ledger_type;

-- 4b. Sample preferences (verify data is intact)
SELECT company_id, vendor_key, ledger_type, ledger_name, party_type, pref_source
FROM vendor_ledger_preferences
ORDER BY created_at DESC
LIMIT 10;

-- 4c. UNIQUE constraint still enforces (company_id, vendor_key, ledger_type)
-- This query returns the constraint; if missing, learning engine is broken
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'vendor_ledger_preferences'::regclass
  AND contype = 'u';

-- 4d. Confirm no customer rows exist (learning disabled in Phase 1)
SELECT COUNT(*) AS customer_rows_MUST_BE_0
FROM vendor_ledger_preferences
WHERE party_type = 'customer';

-- ============================================================
-- REPORT 5: Rollback Script Validity Check
-- (Verifies that all objects the rollback will drop actually exist)
-- ============================================================

SELECT '=== REPORT 5: ROLLBACK VALIDITY CHECK ===' AS report;

-- 5a. Tables that rollback will DROP
SELECT
  table_name,
  CASE WHEN EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema='public' AND table_name=t.table_name
  ) THEN 'EXISTS — rollback DROP will succeed'
   ELSE 'MISSING — already gone or never created'
  END AS rollback_status
FROM (VALUES
  ('voucher_classes'),
  ('customer_masters'),
  ('pos_import_profiles')
) AS t(table_name);

-- 5b. Columns that rollback will DROP COLUMN
SELECT
  tbl, col,
  CASE WHEN EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name=tbl AND column_name=col
  ) THEN 'EXISTS — rollback DROP COLUMN will succeed'
   ELSE 'MISSING — already removed or never added'
  END AS rollback_status
FROM (VALUES
  ('vendor_ledger_preferences', 'party_type'),
  ('vendor_ledger_preferences', 'pref_source'),
  ('companies', 'sales_ledger_config'),
  ('duties_taxes_masters', 'tax_direction'),
  ('rejection_archive', 'voucher_class'),
  ('rejection_archive', 'party_name'),
  ('rejection_archive', 'party_gstin'),
  ('invoice_batches', 'voucher_class'),
  ('invoice_batches', 'source'),
  ('invoice_batches', 'source_profile_id'),
  ('invoices', 'voucher_class'),
  ('invoices', 'voucher_direction'),
  ('invoices', 'source'),
  ('invoices', 'source_file_name'),
  ('invoices', 'source_profile_id'),
  ('invoices', 'source_sheet_name'),
  ('invoices', 'exported_at')
) AS t(tbl, col);

-- 5c. Indexes that rollback will DROP
SELECT
  idx,
  CASE WHEN EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname=idx
  ) THEN 'EXISTS — rollback DROP INDEX will succeed'
   ELSE 'MISSING'
  END AS rollback_status
FROM (VALUES
  ('invoices_company_class_status'),
  ('invoices_source_profile'),
  ('vendor_ledger_prefs_party_type')
) AS t(idx);

-- ============================================================
-- REPORT 6: Summary Pass/Fail
-- ============================================================

SELECT '=== REPORT 6: SUMMARY ===' AS report;

SELECT
  'invoices.voucher_class fully backfilled' AS check_name,
  CASE WHEN COUNT(*) FILTER (WHERE voucher_class IS NULL) = 0
    THEN 'PASS' ELSE 'FAIL' END AS result,
  COUNT(*) FILTER (WHERE voucher_class IS NULL) AS null_count
FROM invoices
UNION ALL
SELECT
  'invoices.voucher_direction fully backfilled',
  CASE WHEN COUNT(*) FILTER (WHERE voucher_direction IS NULL) = 0
    THEN 'PASS' ELSE 'FAIL' END,
  COUNT(*) FILTER (WHERE voucher_direction IS NULL)
FROM invoices
UNION ALL
SELECT
  'invoices.source fully backfilled',
  CASE WHEN COUNT(*) FILTER (WHERE source IS NULL) = 0
    THEN 'PASS' ELSE 'FAIL' END,
  COUNT(*) FILTER (WHERE source IS NULL)
FROM invoices
UNION ALL
SELECT
  'vendor_ledger_preferences no customer rows',
  CASE WHEN COUNT(*) FILTER (WHERE party_type = 'customer') = 0
    THEN 'PASS' ELSE 'FAIL — customer learning leaked' END,
  COUNT(*) FILTER (WHERE party_type = 'customer')
FROM vendor_ledger_preferences
UNION ALL
SELECT
  'voucher_classes has 7 rows',
  CASE WHEN COUNT(*) = 7 THEN 'PASS' ELSE 'FAIL' END,
  COUNT(*)
FROM voucher_classes
UNION ALL
SELECT
  'invoice_batches.voucher_class fully backfilled',
  CASE WHEN COUNT(*) FILTER (WHERE voucher_class IS NULL) = 0
    THEN 'PASS' ELSE 'FAIL' END,
  COUNT(*) FILTER (WHERE voucher_class IS NULL)
FROM invoice_batches
UNION ALL
SELECT
  'duties_taxes_masters.tax_direction fully backfilled',
  CASE WHEN COUNT(*) FILTER (WHERE tax_direction IS NULL) = 0
    THEN 'PASS' ELSE 'FAIL' END,
  COUNT(*) FILTER (WHERE tax_direction IS NULL)
FROM duties_taxes_masters
UNION ALL
SELECT
  'rejection_archive.voucher_class fully backfilled',
  CASE WHEN COUNT(*) FILTER (WHERE voucher_class IS NULL) = 0
    THEN 'PASS' ELSE 'FAIL' END,
  COUNT(*) FILTER (WHERE voucher_class IS NULL)
FROM rejection_archive;
