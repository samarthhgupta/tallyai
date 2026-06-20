-- =============================================================================
-- Phase 1 Validation Script
-- File: supabase/validation/phase1_validate.sql
--
-- Run this in the Supabase SQL Editor AFTER applying migrations 043–051.
-- All statements are read-only. No data is modified.
--
-- Output: one result set per section, plus a final PASS/FAIL summary table.
-- Any row in the summary showing FAIL must be investigated before Phase 2.
-- =============================================================================


-- =============================================================================
-- SECTION 1: SCHEMA VERIFICATION — New Tables
-- =============================================================================

SELECT '══════════════════════════════════════════════════' AS "";
SELECT 'SECTION 1A — NEW TABLES'                            AS "";
SELECT '══════════════════════════════════════════════════' AS "";

SELECT
    t.expected_table                            AS table_name,
    CASE
        WHEN it.table_name IS NOT NULL THEN 'EXISTS'
        ELSE '*** MISSING ***'
    END                                         AS status
FROM (VALUES
    ('pos_import_profiles'),
    ('customer_masters'),
    ('voucher_classes')
) AS t(expected_table)
LEFT JOIN information_schema.tables it
    ON  it.table_schema = 'public'
    AND it.table_name   = t.expected_table
ORDER BY t.expected_table;


-- =============================================================================
-- SECTION 1B: New Columns on invoices
-- =============================================================================

SELECT '══════════════════════════════════════════════════' AS "";
SELECT 'SECTION 1B — NEW COLUMNS: invoices'               AS "";
SELECT '══════════════════════════════════════════════════' AS "";

SELECT
    e.col                                       AS column_name,
    e.expected_type                             AS expected_type,
    c.data_type                                 AS actual_type,
    c.is_nullable                               AS nullable,
    CASE WHEN c.column_name IS NOT NULL THEN 'EXISTS' ELSE '*** MISSING ***' END AS status
FROM (VALUES
    ('voucher_class',     'text'),
    ('voucher_direction', 'text'),
    ('source',            'text'),
    ('source_file_name',  'text'),
    ('source_profile_id', 'uuid'),
    ('source_sheet_name', 'text'),
    ('exported_at',       'timestamp with time zone')
) AS e(col, expected_type)
LEFT JOIN information_schema.columns c
    ON  c.table_schema = 'public'
    AND c.table_name   = 'invoices'
    AND c.column_name  = e.col
ORDER BY e.col;


-- =============================================================================
-- SECTION 1C: New Columns on invoice_batches
-- =============================================================================

SELECT '══════════════════════════════════════════════════' AS "";
SELECT 'SECTION 1C — NEW COLUMNS: invoice_batches'        AS "";
SELECT '══════════════════════════════════════════════════' AS "";

SELECT
    e.col                                       AS column_name,
    CASE WHEN c.column_name IS NOT NULL THEN 'EXISTS' ELSE '*** MISSING ***' END AS status,
    c.data_type, c.is_nullable
FROM (VALUES
    ('voucher_class'),
    ('source'),
    ('source_profile_id')
) AS e(col)
LEFT JOIN information_schema.columns c
    ON  c.table_schema = 'public'
    AND c.table_name   = 'invoice_batches'
    AND c.column_name  = e.col
ORDER BY e.col;


-- =============================================================================
-- SECTION 1D: New Columns on rejection_archive
-- =============================================================================

SELECT '══════════════════════════════════════════════════' AS "";
SELECT 'SECTION 1D — NEW COLUMNS: rejection_archive'      AS "";
SELECT '══════════════════════════════════════════════════' AS "";

SELECT
    e.col                                       AS column_name,
    CASE WHEN c.column_name IS NOT NULL THEN 'EXISTS' ELSE '*** MISSING ***' END AS status,
    c.data_type, c.is_nullable
FROM (VALUES
    ('voucher_class'),
    ('party_name'),
    ('party_gstin')
) AS e(col)
LEFT JOIN information_schema.columns c
    ON  c.table_schema = 'public'
    AND c.table_name   = 'rejection_archive'
    AND c.column_name  = e.col
ORDER BY e.col;


-- =============================================================================
-- SECTION 1E: New Column on duties_taxes_masters
-- =============================================================================

SELECT '══════════════════════════════════════════════════' AS "";
SELECT 'SECTION 1E — NEW COLUMNS: duties_taxes_masters'   AS "";
SELECT '══════════════════════════════════════════════════' AS "";

SELECT
    'tax_direction'                             AS column_name,
    CASE WHEN c.column_name IS NOT NULL THEN 'EXISTS' ELSE '*** MISSING ***' END AS status,
    c.data_type, c.is_nullable, c.column_default
FROM information_schema.columns c
WHERE c.table_schema = 'public'
  AND c.table_name   = 'duties_taxes_masters'
  AND c.column_name  = 'tax_direction'
UNION ALL
SELECT 'tax_direction', '*** MISSING ***', NULL, NULL, NULL
WHERE NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='duties_taxes_masters' AND column_name='tax_direction'
);


-- =============================================================================
-- SECTION 1F: New Column on companies
-- =============================================================================

SELECT '══════════════════════════════════════════════════' AS "";
SELECT 'SECTION 1F — NEW COLUMNS: companies'              AS "";
SELECT '══════════════════════════════════════════════════' AS "";

SELECT
    'sales_ledger_config'                       AS column_name,
    CASE WHEN c.column_name IS NOT NULL THEN 'EXISTS' ELSE '*** MISSING ***' END AS status,
    c.data_type, c.is_nullable
FROM information_schema.columns c
WHERE c.table_schema = 'public'
  AND c.table_name   = 'companies'
  AND c.column_name  = 'sales_ledger_config'
UNION ALL
SELECT 'sales_ledger_config', '*** MISSING ***', NULL, NULL
WHERE NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='companies' AND column_name='sales_ledger_config'
);


-- =============================================================================
-- SECTION 1G: New Columns on vendor_ledger_preferences
-- =============================================================================

SELECT '══════════════════════════════════════════════════' AS "";
SELECT 'SECTION 1G — NEW COLUMNS: vendor_ledger_preferences' AS "";
SELECT '══════════════════════════════════════════════════' AS "";

SELECT
    e.col                                       AS column_name,
    CASE WHEN c.column_name IS NOT NULL THEN 'EXISTS' ELSE '*** MISSING ***' END AS status,
    c.data_type, c.is_nullable, c.column_default
FROM (VALUES
    ('party_type'),
    ('pref_source')
) AS e(col)
LEFT JOIN information_schema.columns c
    ON  c.table_schema = 'public'
    AND c.table_name   = 'vendor_ledger_preferences'
    AND c.column_name  = e.col
ORDER BY e.col;


-- =============================================================================
-- SECTION 1H: CHECK Constraints
-- =============================================================================

SELECT '══════════════════════════════════════════════════' AS "";
SELECT 'SECTION 1H — CHECK CONSTRAINTS'                    AS "";
SELECT '══════════════════════════════════════════════════' AS "";

SELECT
    n.nspname                                   AS schema,
    c.relname                                   AS table_name,
    con.conname                                 AS constraint_name,
    pg_get_constraintdef(con.oid)               AS definition
FROM pg_constraint con
JOIN pg_class     c   ON c.oid = con.conrelid
JOIN pg_namespace n   ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND con.contype = 'c'
  AND c.relname IN (
      'invoices', 'invoice_batches', 'rejection_archive',
      'duties_taxes_masters', 'vendor_ledger_preferences',
      'pos_import_profiles', 'customer_masters', 'voucher_classes'
  )
ORDER BY c.relname, con.conname;


-- =============================================================================
-- SECTION 1I: Indexes
-- =============================================================================

SELECT '══════════════════════════════════════════════════' AS "";
SELECT 'SECTION 1I — INDEXES CREATED BY PHASE 1'          AS "";
SELECT '══════════════════════════════════════════════════' AS "";

SELECT
    e.idx                                       AS expected_index,
    CASE WHEN pi.indexname IS NOT NULL THEN 'EXISTS' ELSE '*** MISSING ***' END AS status,
    pi.indexdef
FROM (VALUES
    ('invoices_company_class_status'),
    ('invoices_source_profile'),
    ('customer_masters_gstin_unique'),
    ('customer_masters_b2c_ledger_unique'),
    ('customer_masters_is_b2c'),
    ('vendor_ledger_prefs_party_type')
) AS e(idx)
LEFT JOIN pg_indexes pi
    ON pi.schemaname = 'public'
    AND pi.indexname = e.idx
ORDER BY e.idx;


-- =============================================================================
-- SECTION 2: BACKFILL VALIDATION
-- =============================================================================

SELECT '══════════════════════════════════════════════════' AS "";
SELECT 'SECTION 2A — BACKFILL: invoices'                   AS "";
SELECT '══════════════════════════════════════════════════' AS "";

SELECT
    COUNT(*)                                            AS total_rows,
    COUNT(*) FILTER (WHERE voucher_class IS NULL)       AS null_voucher_class,
    COUNT(*) FILTER (WHERE voucher_direction IS NULL)   AS null_voucher_direction,
    COUNT(*) FILTER (WHERE source IS NULL)              AS null_source,
    COUNT(*) FILTER (WHERE voucher_class = 'purchase')  AS class_purchase,
    COUNT(*) FILTER (WHERE voucher_direction = 'inward') AS direction_inward,
    COUNT(*) FILTER (WHERE source = 'pdf_extraction')   AS source_pdf
FROM invoices;

-- Expecting: null_voucher_class=0, null_voucher_direction=0, null_source=0
-- and total_rows = class_purchase = direction_inward = source_pdf


SELECT '══════════════════════════════════════════════════' AS "";
SELECT 'SECTION 2B — BACKFILL: invoice_batches'            AS "";
SELECT '══════════════════════════════════════════════════' AS "";

SELECT
    COUNT(*)                                            AS total_rows,
    COUNT(*) FILTER (WHERE voucher_class IS NULL)       AS null_voucher_class,
    COUNT(*) FILTER (WHERE source IS NULL)              AS null_source,
    COUNT(*) FILTER (WHERE voucher_class = 'purchase')  AS class_purchase,
    COUNT(*) FILTER (WHERE source = 'pdf_extraction')   AS source_pdf
FROM invoice_batches;


SELECT '══════════════════════════════════════════════════' AS "";
SELECT 'SECTION 2C — BACKFILL: duties_taxes_masters'       AS "";
SELECT '══════════════════════════════════════════════════' AS "";

SELECT
    COUNT(*)                                            AS total_rows,
    COUNT(*) FILTER (WHERE tax_direction IS NULL)       AS null_tax_direction,
    COUNT(*) FILTER (WHERE tax_direction = 'input')     AS direction_input,
    COUNT(*) FILTER (WHERE tax_direction != 'input')    AS direction_non_input
FROM duties_taxes_masters;

-- Expecting: null_tax_direction=0, direction_non_input=0


SELECT '══════════════════════════════════════════════════' AS "";
SELECT 'SECTION 2D — BACKFILL: vendor_ledger_preferences'  AS "";
SELECT '══════════════════════════════════════════════════' AS "";

SELECT
    COUNT(*)                                            AS total_rows,
    COUNT(*) FILTER (WHERE party_type IS NULL)          AS null_party_type,
    COUNT(*) FILTER (WHERE pref_source IS NULL)         AS null_pref_source,
    COUNT(*) FILTER (WHERE party_type = 'vendor')       AS type_vendor,
    COUNT(*) FILTER (WHERE party_type = 'customer')     AS type_customer_MUST_BE_0
FROM vendor_ledger_preferences;


-- =============================================================================
-- SECTION 3: DATA INTEGRITY VALIDATION
-- =============================================================================

SELECT '══════════════════════════════════════════════════' AS "";
SELECT 'SECTION 3A — ROW COUNTS'                           AS "";
SELECT '══════════════════════════════════════════════════' AS "";

SELECT 'invoices'                       AS table_name, COUNT(*) AS row_count FROM invoices
UNION ALL
SELECT 'invoice_batches',                              COUNT(*) FROM invoice_batches
UNION ALL
SELECT 'rejection_archive',                            COUNT(*) FROM rejection_archive
UNION ALL
SELECT 'duties_taxes_masters',                         COUNT(*) FROM duties_taxes_masters
UNION ALL
SELECT 'vendor_ledger_preferences',                    COUNT(*) FROM vendor_ledger_preferences
UNION ALL
SELECT 'pos_import_profiles (new)',                    COUNT(*) FROM pos_import_profiles
UNION ALL
SELECT 'customer_masters (new)',                       COUNT(*) FROM customer_masters
UNION ALL
SELECT 'voucher_classes (seed)',                       COUNT(*) FROM voucher_classes;

-- Expected: pos_import_profiles=0, customer_masters=0, voucher_classes=7


SELECT '══════════════════════════════════════════════════' AS "";
SELECT 'SECTION 3B — ORPHAN CHECK: invoices without batch' AS "";
SELECT '══════════════════════════════════════════════════' AS "";

-- Invoices with a batch_id that no longer exists in invoice_batches
SELECT COUNT(*) AS orphaned_invoices_SHOULD_BE_0
FROM invoices i
WHERE i.batch_id IS NOT NULL
  AND NOT EXISTS (
      SELECT 1 FROM invoice_batches ib WHERE ib.id = i.batch_id
  );


SELECT '══════════════════════════════════════════════════' AS "";
SELECT 'SECTION 3C — INVALID voucher_class VALUES'         AS "";
SELECT '══════════════════════════════════════════════════' AS "";

-- Any row with a value outside the CHECK constraint set
SELECT COUNT(*) AS invalid_voucher_class_SHOULD_BE_0
FROM invoices
WHERE voucher_class NOT IN (
    'purchase','sales','credit_note','debit_note','journal','receipt','payment'
);

SELECT COUNT(*) AS invalid_batch_voucher_class_SHOULD_BE_0
FROM invoice_batches
WHERE voucher_class NOT IN (
    'purchase','sales','credit_note','debit_note','journal','receipt','payment'
);


SELECT '══════════════════════════════════════════════════' AS "";
SELECT 'SECTION 3D — INVALID voucher_direction VALUES'     AS "";
SELECT '══════════════════════════════════════════════════' AS "";

SELECT COUNT(*) AS invalid_voucher_direction_SHOULD_BE_0
FROM invoices
WHERE voucher_direction NOT IN ('inward','outward');


SELECT '══════════════════════════════════════════════════' AS "";
SELECT 'SECTION 3E — voucher_classes SEED DATA'            AS "";
SELECT '══════════════════════════════════════════════════' AS "";

SELECT code, display_name, default_direction, active
FROM voucher_classes
ORDER BY code;

-- Expected 7 rows:
-- credit_note  | Credit Note | NULL   | true
-- debit_note   | Debit Note  | NULL   | true
-- journal      | Journal     | NULL   | true
-- payment      | Payment     | NULL   | true
-- purchase     | Purchase    | inward | true
-- receipt      | Receipt     | NULL   | true
-- sales        | Sales       | outward| true


-- =============================================================================
-- SECTION 4: LEARNING ENGINE VALIDATION
-- =============================================================================

SELECT '══════════════════════════════════════════════════' AS "";
SELECT 'SECTION 4A — LEARNING ENGINE: party_type distribution' AS "";
SELECT '══════════════════════════════════════════════════' AS "";

SELECT
    party_type,
    pref_source,
    ledger_type,
    COUNT(*)            AS row_count
FROM vendor_ledger_preferences
GROUP BY party_type, pref_source, ledger_type
ORDER BY party_type, pref_source, ledger_type;

-- Expected: all rows party_type='vendor', pref_source='learned'
-- customer rows must not exist in Phase 1


SELECT '══════════════════════════════════════════════════' AS "";
SELECT 'SECTION 4B — LEARNING ENGINE: UNIQUE constraint'   AS "";
SELECT '══════════════════════════════════════════════════' AS "";

-- Verify the unique constraint (company_id, vendor_key, ledger_type) still exists
SELECT
    con.conname         AS constraint_name,
    pg_get_constraintdef(con.oid) AS definition,
    'EXISTS'            AS status
FROM pg_constraint con
JOIN pg_class c ON c.oid = con.conrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname = 'vendor_ledger_preferences'
  AND con.contype = 'u';


SELECT '══════════════════════════════════════════════════' AS "";
SELECT 'SECTION 4C — LEARNING ENGINE: sample data intact'  AS "";
SELECT '══════════════════════════════════════════════════' AS "";

-- Sample last 10 learning records to confirm data is not corrupted
SELECT
    company_id,
    vendor_key,
    ledger_type,
    ledger_name,
    party_type,
    pref_source,
    created_at,
    updated_at
FROM vendor_ledger_preferences
ORDER BY updated_at DESC
LIMIT 10;


SELECT '══════════════════════════════════════════════════' AS "";
SELECT 'SECTION 4D — LEARNING ENGINE: no customer rows'    AS "";
SELECT '══════════════════════════════════════════════════' AS "";

SELECT
    COUNT(*) AS customer_rows_MUST_BE_0
FROM vendor_ledger_preferences
WHERE party_type = 'customer';


-- =============================================================================
-- SECTION 5: PURCHASE REGISTER SAFETY VALIDATION
-- =============================================================================

SELECT '══════════════════════════════════════════════════' AS "";
SELECT 'SECTION 5A — PURCHASE REGISTER: all historical invoices are purchase/inward' AS "";
SELECT '══════════════════════════════════════════════════' AS "";

SELECT
    COUNT(*)                                                AS total_invoices,
    COUNT(*) FILTER (WHERE voucher_class = 'purchase')      AS class_purchase,
    COUNT(*) FILTER (WHERE voucher_direction = 'inward')    AS direction_inward,
    COUNT(*) FILTER (WHERE voucher_class != 'purchase')     AS non_purchase_SHOULD_BE_0,
    COUNT(*) FILTER (WHERE voucher_direction != 'inward')   AS non_inward_SHOULD_BE_0
FROM invoices;


SELECT '══════════════════════════════════════════════════' AS "";
SELECT 'SECTION 5B — PURCHASE REGISTER: status distribution' AS "";
SELECT '══════════════════════════════════════════════════' AS "";

SELECT
    status,
    COUNT(*)    AS count
FROM invoices
WHERE voucher_class = 'purchase'
GROUP BY status
ORDER BY status;


SELECT '══════════════════════════════════════════════════' AS "";
SELECT 'SECTION 5C — PURCHASE REGISTER: readiness distribution' AS "";
SELECT '══════════════════════════════════════════════════' AS "";

SELECT
    readiness,
    COUNT(*)    AS count
FROM invoices
WHERE voucher_class = 'purchase'
GROUP BY readiness
ORDER BY readiness;


SELECT '══════════════════════════════════════════════════' AS "";
SELECT 'SECTION 5D — PURCHASE REGISTER: line_items JSON intact (sample 5)' AS "";
SELECT '══════════════════════════════════════════════════' AS "";

SELECT
    id,
    invoice_number,
    vendor_name,
    voucher_class,
    voucher_direction,
    jsonb_array_length(line_items) AS line_item_count,
    total
FROM invoices
WHERE line_items IS NOT NULL
  AND jsonb_array_length(line_items) > 0
ORDER BY created_at DESC
LIMIT 5;


SELECT '══════════════════════════════════════════════════' AS "";
SELECT 'SECTION 5E — PURCHASE REGISTER: accepted invoices have accepted_at' AS "";
SELECT '══════════════════════════════════════════════════' AS "";

SELECT
    COUNT(*)                                                        AS total_accepted,
    COUNT(*) FILTER (WHERE accepted_at IS NOT NULL)                 AS with_timestamp,
    COUNT(*) FILTER (WHERE accepted_at IS NULL)                     AS missing_timestamp_SHOULD_BE_0
FROM invoices
WHERE status = 'accepted';


SELECT '══════════════════════════════════════════════════' AS "";
SELECT 'SECTION 5F — PURCHASE REGISTER: batch relationships intact' AS "";
SELECT '══════════════════════════════════════════════════' AS "";

SELECT
    ib.id                               AS batch_id,
    ib.voucher_class                    AS batch_class,
    ib.source                           AS batch_source,
    COUNT(i.id)                         AS invoices_in_batch
FROM invoice_batches ib
LEFT JOIN invoices i ON i.batch_id = ib.id
GROUP BY ib.id, ib.voucher_class, ib.source
ORDER BY ib.created_at DESC
LIMIT 10;


-- =============================================================================
-- SECTION 6: ROLLBACK READINESS VALIDATION
-- =============================================================================

SELECT '══════════════════════════════════════════════════' AS "";
SELECT 'SECTION 6A — ROLLBACK: tables that will be dropped' AS "";
SELECT '══════════════════════════════════════════════════' AS "";

SELECT
    t.tbl                                       AS table_name,
    CASE WHEN it.table_name IS NOT NULL
         THEN 'EXISTS — DROP will succeed'
         ELSE '*** MISSING — already removed or never created ***'
    END                                         AS rollback_status,
    (SELECT COUNT(*) FROM information_schema.columns c2
     WHERE c2.table_schema='public' AND c2.table_name=t.tbl) AS column_count
FROM (VALUES
    ('voucher_classes'),
    ('customer_masters'),
    ('pos_import_profiles')
) AS t(tbl)
LEFT JOIN information_schema.tables it
    ON it.table_schema = 'public' AND it.table_name = t.tbl
ORDER BY t.tbl;


SELECT '══════════════════════════════════════════════════' AS "";
SELECT 'SECTION 6B — ROLLBACK: columns that will be dropped' AS "";
SELECT '══════════════════════════════════════════════════' AS "";

SELECT
    t.tbl                                       AS table_name,
    t.col                                       AS column_name,
    CASE WHEN c.column_name IS NOT NULL
         THEN 'EXISTS — DROP COLUMN will succeed'
         ELSE '*** MISSING — not found ***'
    END                                         AS rollback_status
FROM (VALUES
    ('vendor_ledger_preferences', 'party_type'),
    ('vendor_ledger_preferences', 'pref_source'),
    ('companies',                 'sales_ledger_config'),
    ('duties_taxes_masters',      'tax_direction'),
    ('rejection_archive',         'voucher_class'),
    ('rejection_archive',         'party_name'),
    ('rejection_archive',         'party_gstin'),
    ('invoice_batches',           'voucher_class'),
    ('invoice_batches',           'source'),
    ('invoice_batches',           'source_profile_id'),
    ('invoices',                  'voucher_class'),
    ('invoices',                  'voucher_direction'),
    ('invoices',                  'source'),
    ('invoices',                  'source_file_name'),
    ('invoices',                  'source_profile_id'),
    ('invoices',                  'source_sheet_name'),
    ('invoices',                  'exported_at')
) AS t(tbl, col)
LEFT JOIN information_schema.columns c
    ON  c.table_schema = 'public'
    AND c.table_name   = t.tbl
    AND c.column_name  = t.col
ORDER BY t.tbl, t.col;


SELECT '══════════════════════════════════════════════════' AS "";
SELECT 'SECTION 6C — ROLLBACK: indexes that will be dropped' AS "";
SELECT '══════════════════════════════════════════════════' AS "";

SELECT
    e.idx                                       AS index_name,
    CASE WHEN pi.indexname IS NOT NULL
         THEN 'EXISTS — DROP INDEX will succeed'
         ELSE '*** MISSING ***'
    END                                         AS rollback_status
FROM (VALUES
    ('invoices_company_class_status'),
    ('invoices_source_profile'),
    ('vendor_ledger_prefs_party_type')
) AS e(idx)
LEFT JOIN pg_indexes pi
    ON pi.schemaname = 'public' AND pi.indexname = e.idx
ORDER BY e.idx;


-- =============================================================================
-- SECTION 7: FINAL PASS/FAIL SUMMARY
-- =============================================================================

SELECT '══════════════════════════════════════════════════' AS "";
SELECT 'SECTION 7 — FINAL PASS/FAIL SUMMARY'              AS "";
SELECT '══════════════════════════════════════════════════' AS "";

WITH checks AS (

    -- 1. pos_import_profiles exists
    SELECT 1 AS seq, 'pos_import_profiles table exists' AS check_name,
        CASE WHEN EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='pos_import_profiles')
             THEN 'PASS' ELSE 'FAIL' END AS result,
        NULL::bigint AS detail

    UNION ALL

    -- 2. customer_masters exists
    SELECT 2, 'customer_masters table exists',
        CASE WHEN EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='customer_masters')
             THEN 'PASS' ELSE 'FAIL' END, NULL

    UNION ALL

    -- 3. voucher_classes exists
    SELECT 3, 'voucher_classes table exists',
        CASE WHEN EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='voucher_classes')
             THEN 'PASS' ELSE 'FAIL' END, NULL

    UNION ALL

    -- 4. voucher_classes has 7 rows
    SELECT 4, 'voucher_classes seeded with 7 rows',
        CASE WHEN (SELECT COUNT(*) FROM voucher_classes) = 7 THEN 'PASS' ELSE 'FAIL' END,
        (SELECT COUNT(*) FROM voucher_classes)

    UNION ALL

    -- 5. invoices.voucher_class column exists
    SELECT 5, 'invoices.voucher_class column exists',
        CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='invoices' AND column_name='voucher_class')
             THEN 'PASS' ELSE 'FAIL' END, NULL

    UNION ALL

    -- 6. invoices.voucher_direction column exists
    SELECT 6, 'invoices.voucher_direction column exists',
        CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='invoices' AND column_name='voucher_direction')
             THEN 'PASS' ELSE 'FAIL' END, NULL

    UNION ALL

    -- 7. invoices.source column exists
    SELECT 7, 'invoices.source column exists',
        CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='invoices' AND column_name='source')
             THEN 'PASS' ELSE 'FAIL' END, NULL

    UNION ALL

    -- 8. invoices.voucher_class backfill complete (no NULLs)
    SELECT 8, 'invoices.voucher_class — no NULL rows after backfill',
        CASE WHEN (SELECT COUNT(*) FROM invoices WHERE voucher_class IS NULL) = 0
             THEN 'PASS' ELSE 'FAIL' END,
        (SELECT COUNT(*) FROM invoices WHERE voucher_class IS NULL)

    UNION ALL

    -- 9. invoices.voucher_direction backfill complete
    SELECT 9, 'invoices.voucher_direction — no NULL rows after backfill',
        CASE WHEN (SELECT COUNT(*) FROM invoices WHERE voucher_direction IS NULL) = 0
             THEN 'PASS' ELSE 'FAIL' END,
        (SELECT COUNT(*) FROM invoices WHERE voucher_direction IS NULL)

    UNION ALL

    -- 10. invoices.source backfill complete
    SELECT 10, 'invoices.source — no NULL rows after backfill',
        CASE WHEN (SELECT COUNT(*) FROM invoices WHERE source IS NULL) = 0
             THEN 'PASS' ELSE 'FAIL' END,
        (SELECT COUNT(*) FROM invoices WHERE source IS NULL)

    UNION ALL

    -- 11. all invoices are purchase class
    SELECT 11, 'invoices — all historical rows are voucher_class=purchase',
        CASE WHEN (SELECT COUNT(*) FROM invoices WHERE voucher_class != 'purchase') = 0
             THEN 'PASS' ELSE 'FAIL' END,
        (SELECT COUNT(*) FROM invoices WHERE voucher_class != 'purchase')

    UNION ALL

    -- 12. all invoices are inward direction
    SELECT 12, 'invoices — all historical rows are voucher_direction=inward',
        CASE WHEN (SELECT COUNT(*) FROM invoices WHERE voucher_direction != 'inward') = 0
             THEN 'PASS' ELSE 'FAIL' END,
        (SELECT COUNT(*) FROM invoices WHERE voucher_direction != 'inward')

    UNION ALL

    -- 13. invoice_batches.voucher_class backfill complete
    SELECT 13, 'invoice_batches.voucher_class — no NULL rows after backfill',
        CASE WHEN (SELECT COUNT(*) FROM invoice_batches WHERE voucher_class IS NULL) = 0
             THEN 'PASS' ELSE 'FAIL' END,
        (SELECT COUNT(*) FROM invoice_batches WHERE voucher_class IS NULL)

    UNION ALL

    -- 14. invoice_batches.source backfill complete
    SELECT 14, 'invoice_batches.source — no NULL rows after backfill',
        CASE WHEN (SELECT COUNT(*) FROM invoice_batches WHERE source IS NULL) = 0
             THEN 'PASS' ELSE 'FAIL' END,
        (SELECT COUNT(*) FROM invoice_batches WHERE source IS NULL)

    UNION ALL

    -- 15. duties_taxes_masters.tax_direction backfill complete
    SELECT 15, 'duties_taxes_masters.tax_direction — no NULL rows after backfill',
        CASE WHEN (SELECT COUNT(*) FROM duties_taxes_masters WHERE tax_direction IS NULL) = 0
             THEN 'PASS' ELSE 'FAIL' END,
        (SELECT COUNT(*) FROM duties_taxes_masters WHERE tax_direction IS NULL)

    UNION ALL

    -- 16. vendor_ledger_preferences.party_type backfill complete
    SELECT 16, 'vendor_ledger_preferences.party_type — no NULL rows after backfill',
        CASE WHEN (SELECT COUNT(*) FROM vendor_ledger_preferences WHERE party_type IS NULL) = 0
             THEN 'PASS' ELSE 'FAIL' END,
        (SELECT COUNT(*) FROM vendor_ledger_preferences WHERE party_type IS NULL)

    UNION ALL

    -- 17. no customer learning rows (Phase 1 constraint)
    SELECT 17, 'vendor_ledger_preferences — zero customer rows (learning disabled in Phase 1)',
        CASE WHEN (SELECT COUNT(*) FROM vendor_ledger_preferences WHERE party_type = 'customer') = 0
             THEN 'PASS' ELSE 'FAIL — customer learning leak detected' END,
        (SELECT COUNT(*) FROM vendor_ledger_preferences WHERE party_type = 'customer')

    UNION ALL

    -- 18. unique constraint on vendor_ledger_preferences still exists
    SELECT 18, 'vendor_ledger_preferences UNIQUE constraint intact',
        CASE WHEN EXISTS (
            SELECT 1 FROM pg_constraint con
            JOIN pg_class c ON c.oid = con.conrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname='public' AND c.relname='vendor_ledger_preferences' AND con.contype='u'
        ) THEN 'PASS' ELSE 'FAIL' END, NULL

    UNION ALL

    -- 19. no orphaned invoices
    SELECT 19, 'invoices — no orphaned batch references',
        CASE WHEN (
            SELECT COUNT(*) FROM invoices i
            WHERE i.batch_id IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM invoice_batches ib WHERE ib.id = i.batch_id)
        ) = 0 THEN 'PASS' ELSE 'FAIL' END,
        (SELECT COUNT(*) FROM invoices i
         WHERE i.batch_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM invoice_batches ib WHERE ib.id = i.batch_id))

    UNION ALL

    -- 20. no invalid voucher_class values in invoices
    SELECT 20, 'invoices — no invalid voucher_class values',
        CASE WHEN (SELECT COUNT(*) FROM invoices WHERE voucher_class NOT IN
            ('purchase','sales','credit_note','debit_note','journal','receipt','payment')) = 0
             THEN 'PASS' ELSE 'FAIL' END,
        (SELECT COUNT(*) FROM invoices WHERE voucher_class NOT IN
            ('purchase','sales','credit_note','debit_note','journal','receipt','payment'))

    UNION ALL

    -- 21. no invalid voucher_direction values in invoices
    SELECT 21, 'invoices — no invalid voucher_direction values',
        CASE WHEN (SELECT COUNT(*) FROM invoices WHERE voucher_direction NOT IN ('inward','outward')) = 0
             THEN 'PASS' ELSE 'FAIL' END,
        (SELECT COUNT(*) FROM invoices WHERE voucher_direction NOT IN ('inward','outward'))

    UNION ALL

    -- 22. rejection_archive party_name backfilled from vendor_name
    SELECT 22, 'rejection_archive.party_name backfilled from vendor_name',
        CASE WHEN (
            SELECT COUNT(*) FROM rejection_archive
            WHERE vendor_name IS NOT NULL AND party_name IS NULL
        ) = 0 THEN 'PASS' ELSE 'FAIL' END,
        (SELECT COUNT(*) FROM rejection_archive WHERE vendor_name IS NOT NULL AND party_name IS NULL)

    UNION ALL

    -- 23. companies.sales_ledger_config exists
    SELECT 23, 'companies.sales_ledger_config column exists',
        CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='companies' AND column_name='sales_ledger_config')
             THEN 'PASS' ELSE 'FAIL' END, NULL

    UNION ALL

    -- 24. duties_taxes_masters all input (no non-input rows)
    SELECT 24, 'duties_taxes_masters — all existing rows are tax_direction=input',
        CASE WHEN (SELECT COUNT(*) FROM duties_taxes_masters WHERE tax_direction != 'input') = 0
             THEN 'PASS' ELSE 'FAIL' END,
        (SELECT COUNT(*) FROM duties_taxes_masters WHERE tax_direction != 'input')

)
SELECT
    seq                             AS "#",
    check_name                      AS "Check",
    result                          AS "Result",
    CASE WHEN detail IS NOT NULL THEN detail::text ELSE '—' END AS "Detail (0 = good for FAIL checks)"
FROM checks
ORDER BY seq;

-- Final aggregate
SELECT
    COUNT(*) FILTER (WHERE result = 'PASS')  AS checks_passed,
    COUNT(*) FILTER (WHERE result != 'PASS') AS checks_failed,
    COUNT(*)                                  AS total_checks,
    CASE WHEN COUNT(*) FILTER (WHERE result != 'PASS') = 0
         THEN '✓ ALL CHECKS PASSED — Phase 1 may be approved'
         ELSE '✗ FAILURES DETECTED — do not proceed to Phase 2'
    END AS verdict
FROM (
    -- re-run the same CTE inline for the aggregate
    SELECT CASE WHEN EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='pos_import_profiles') THEN 'PASS' ELSE 'FAIL' END AS result UNION ALL
    SELECT CASE WHEN EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='customer_masters')    THEN 'PASS' ELSE 'FAIL' END UNION ALL
    SELECT CASE WHEN EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='voucher_classes')     THEN 'PASS' ELSE 'FAIL' END UNION ALL
    SELECT CASE WHEN (SELECT COUNT(*) FROM voucher_classes) = 7                                                                        THEN 'PASS' ELSE 'FAIL' END UNION ALL
    SELECT CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='invoices' AND column_name='voucher_class')     THEN 'PASS' ELSE 'FAIL' END UNION ALL
    SELECT CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='invoices' AND column_name='voucher_direction') THEN 'PASS' ELSE 'FAIL' END UNION ALL
    SELECT CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='invoices' AND column_name='source')            THEN 'PASS' ELSE 'FAIL' END UNION ALL
    SELECT CASE WHEN (SELECT COUNT(*) FROM invoices WHERE voucher_class IS NULL) = 0                                                   THEN 'PASS' ELSE 'FAIL' END UNION ALL
    SELECT CASE WHEN (SELECT COUNT(*) FROM invoices WHERE voucher_direction IS NULL) = 0                                               THEN 'PASS' ELSE 'FAIL' END UNION ALL
    SELECT CASE WHEN (SELECT COUNT(*) FROM invoices WHERE source IS NULL) = 0                                                          THEN 'PASS' ELSE 'FAIL' END UNION ALL
    SELECT CASE WHEN (SELECT COUNT(*) FROM invoices WHERE voucher_class != 'purchase') = 0                                             THEN 'PASS' ELSE 'FAIL' END UNION ALL
    SELECT CASE WHEN (SELECT COUNT(*) FROM invoices WHERE voucher_direction != 'inward') = 0                                           THEN 'PASS' ELSE 'FAIL' END UNION ALL
    SELECT CASE WHEN (SELECT COUNT(*) FROM invoice_batches WHERE voucher_class IS NULL) = 0                                            THEN 'PASS' ELSE 'FAIL' END UNION ALL
    SELECT CASE WHEN (SELECT COUNT(*) FROM invoice_batches WHERE source IS NULL) = 0                                                   THEN 'PASS' ELSE 'FAIL' END UNION ALL
    SELECT CASE WHEN (SELECT COUNT(*) FROM duties_taxes_masters WHERE tax_direction IS NULL) = 0                                       THEN 'PASS' ELSE 'FAIL' END UNION ALL
    SELECT CASE WHEN (SELECT COUNT(*) FROM vendor_ledger_preferences WHERE party_type IS NULL) = 0                                     THEN 'PASS' ELSE 'FAIL' END UNION ALL
    SELECT CASE WHEN (SELECT COUNT(*) FROM vendor_ledger_preferences WHERE party_type = 'customer') = 0                               THEN 'PASS' ELSE 'FAIL' END UNION ALL
    SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='vendor_ledger_preferences' AND con.contype='u') THEN 'PASS' ELSE 'FAIL' END UNION ALL
    SELECT CASE WHEN (SELECT COUNT(*) FROM invoices i WHERE i.batch_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM invoice_batches ib WHERE ib.id=i.batch_id)) = 0 THEN 'PASS' ELSE 'FAIL' END UNION ALL
    SELECT CASE WHEN (SELECT COUNT(*) FROM invoices WHERE voucher_class NOT IN ('purchase','sales','credit_note','debit_note','journal','receipt','payment')) = 0 THEN 'PASS' ELSE 'FAIL' END UNION ALL
    SELECT CASE WHEN (SELECT COUNT(*) FROM invoices WHERE voucher_direction NOT IN ('inward','outward')) = 0                           THEN 'PASS' ELSE 'FAIL' END UNION ALL
    SELECT CASE WHEN (SELECT COUNT(*) FROM rejection_archive WHERE vendor_name IS NOT NULL AND party_name IS NULL) = 0                THEN 'PASS' ELSE 'FAIL' END UNION ALL
    SELECT CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='companies' AND column_name='sales_ledger_config') THEN 'PASS' ELSE 'FAIL' END UNION ALL
    SELECT CASE WHEN (SELECT COUNT(*) FROM duties_taxes_masters WHERE tax_direction != 'input') = 0                                    THEN 'PASS' ELSE 'FAIL' END
) AS results;
