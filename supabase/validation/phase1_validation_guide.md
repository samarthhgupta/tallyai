# Phase 1 Validation Guide

## Overview

This guide covers how to run `phase1_validate.sql`, interpret its output, and verify rollback readiness after applying Phase 1 migrations (043–051).

---

## Prerequisites

- Migrations 043–051 have been applied via `supabase db push` or the Supabase SQL Editor.
- You have access to the Supabase SQL Editor or a `psql` connection with the service role key.

---

## How to Run

### Option A — Supabase SQL Editor (recommended)

1. Open your Supabase project dashboard.
2. Navigate to **SQL Editor** in the left sidebar.
3. Click **New query**.
4. Open `supabase/validation/phase1_validate.sql` from your local file system.
5. Copy the entire file contents and paste into the SQL Editor.
6. Click **Run** (or press `Ctrl+Enter` / `Cmd+Enter`).
7. The editor will return multiple result sets. Scroll through each one.

### Option B — psql

```bash
psql "$DATABASE_URL" -f supabase/validation/phase1_validate.sql
```

Where `DATABASE_URL` is your Supabase direct connection string (found in Project Settings → Database → Connection string → URI).

---

## Expected Outputs

The script produces 7 sections. Below is what each section should return when Phase 1 is correctly applied.

### Section 1A — New Tables

| table_name            | status |
|-----------------------|--------|
| customer_masters      | EXISTS |
| pos_import_profiles   | EXISTS |
| voucher_classes       | EXISTS |

**Failure**: Any row showing `*** MISSING ***` means the corresponding migration did not run. Re-run the specific migration file.

---

### Section 1B — New Columns: invoices

All 7 columns must show `EXISTS`:

| column_name        | expected_type                  | status |
|--------------------|-------------------------------|--------|
| exported_at        | timestamp with time zone       | EXISTS |
| source             | text                           | EXISTS |
| source_file_name   | text                           | EXISTS |
| source_profile_id  | uuid                           | EXISTS |
| source_sheet_name  | text                           | EXISTS |
| voucher_class      | text                           | EXISTS |
| voucher_direction  | text                           | EXISTS |

---

### Section 1C–1G — New Columns on Other Tables

Same pattern. All expected columns must show `EXISTS`. Any `*** MISSING ***` identifies which migration to re-run:

| Section | Table                         | Migration |
|---------|-------------------------------|-----------|
| 1C      | invoice_batches               | 045       |
| 1D      | rejection_archive             | 046       |
| 1E      | duties_taxes_masters          | 047       |
| 1F      | companies                     | 048       |
| 1G      | vendor_ledger_preferences     | 050       |

---

### Section 1H — CHECK Constraints

All CHECK constraints added by Phase 1 migrations must appear. The list includes constraints on `voucher_class`, `voucher_direction`, `source`, `tax_direction`, `party_type`, `pref_source`, `default_voucher_class`.

**Failure**: Missing constraints mean the column was added without the CHECK clause. The column must be dropped and re-added with the correct definition, or the constraint added separately:
```sql
ALTER TABLE invoices
  ADD CONSTRAINT invoices_voucher_class_check
  CHECK (voucher_class IN ('purchase','sales','credit_note','debit_note','journal','receipt','payment'));
```

---

### Section 1I — Indexes

All 6 indexes must show `EXISTS`:

| index_name                          |
|-------------------------------------|
| customer_masters_b2c_ledger_unique  |
| customer_masters_gstin_unique       |
| customer_masters_is_b2c             |
| invoices_company_class_status       |
| invoices_source_profile             |
| vendor_ledger_prefs_party_type      |

---

### Section 2 — Backfill Validation

**Section 2A — invoices**

Expected: `null_voucher_class = 0`, `null_voucher_direction = 0`, `null_source = 0`.

Also expected: `total_rows = class_purchase = direction_inward = source_pdf` (all historical invoices are purchase PDFs).

**Failure interpretation**:
- If `null_voucher_class > 0`: The backfill UPDATE in migration 044 did not run or was partial. Run:
  ```sql
  UPDATE invoices SET voucher_class = 'purchase' WHERE voucher_class IS NULL;
  UPDATE invoices SET voucher_direction = 'inward' WHERE voucher_direction IS NULL;
  UPDATE invoices SET source = 'pdf_extraction' WHERE source IS NULL;
  ```
- If `class_purchase < total_rows`: Some rows have an unexpected `voucher_class`. Investigate with:
  ```sql
  SELECT voucher_class, COUNT(*) FROM invoices GROUP BY voucher_class;
  ```

**Sections 2B–2D**: Same pattern for `invoice_batches`, `duties_taxes_masters`, `vendor_ledger_preferences`.

---

### Section 3 — Data Integrity

**Section 3A — Row Counts**

Expected:
- `pos_import_profiles`: 0 (new table, no data yet)
- `customer_masters`: 0 (new table, no data yet)
- `voucher_classes`: 7 (seeded by migration 051)
- All other tables: same counts as before the migration run

**Section 3B — Orphan Check**

Expected: `orphaned_invoices_SHOULD_BE_0 = 0`

**Failure**: Invoices referencing deleted batches existed before Phase 1. These are pre-existing data quality issues, not caused by Phase 1 migrations. Document them and handle separately.

**Section 3C/3D — Invalid Values**

Expected: all counts = 0. If non-zero, a row bypassed the CHECK constraint (possible if constraint was added after data insert without validation). Investigate individual rows:
```sql
SELECT id, voucher_class FROM invoices
WHERE voucher_class NOT IN ('purchase','sales','credit_note','debit_note','journal','receipt','payment');
```

**Section 3E — voucher_classes Seed Data**

Expected 7 rows:

| code        | display_name | default_direction |
|-------------|-------------|-------------------|
| credit_note | Credit Note  | NULL              |
| debit_note  | Debit Note   | NULL              |
| journal     | Journal      | NULL              |
| payment     | Payment      | NULL              |
| purchase    | Purchase     | inward            |
| receipt     | Receipt      | NULL              |
| sales       | Sales        | outward           |

---

### Section 4 — Learning Engine

**Section 4A — party_type distribution**

Expected: all rows show `party_type = 'vendor'`. No `customer` rows.

**Section 4B — UNIQUE constraint**

Expected: one row returned showing the `(company_id, vendor_key, ledger_type)` unique constraint.

**Failure**: If no row returned, the constraint was dropped (should not happen with additive migrations). Re-add with:
```sql
ALTER TABLE vendor_ledger_preferences
  ADD CONSTRAINT vendor_ledger_preferences_company_id_vendor_key_ledger_type_key
  UNIQUE (company_id, vendor_key, ledger_type);
```

**Section 4D — Customer rows = 0**

**CRITICAL**: This must be 0 in Phase 1. If non-zero, customer learning code has been deployed ahead of schedule. Identify the source and remove those rows before proceeding.

---

### Section 5 — Purchase Register Safety

**Section 5A**

Expected: `non_purchase_SHOULD_BE_0 = 0`, `non_inward_SHOULD_BE_0 = 0`.

**Section 5B — Status Distribution**

Compare to pre-migration counts. The distribution must not have changed. Typical expected values:
- `pending_review`: majority of rows
- `accepted`: rows that were accepted before migration
- `rejected`: rows that were rejected before migration

**Section 5D — line_items JSON**

5 recent invoices with line items are shown. Visually confirm `line_item_count` is a reasonable number (1–50). If `line_item_count = 0` for all rows, the JSON may have been corrupted (very unlikely with additive migrations).

**Section 5E — accepted_at timestamp**

Expected: `missing_timestamp_SHOULD_BE_0 = 0`. All accepted invoices should have an `accepted_at` timestamp.

---

### Section 6 — Rollback Readiness

All tables, columns, and indexes must show `EXISTS — DROP will succeed` / `EXISTS — DROP COLUMN will succeed` / `EXISTS — DROP INDEX will succeed`.

Any `MISSING` entry means either:
1. The migration that created it failed — Phase 1 is incomplete.
2. Something else already removed it — investigate before rollback.

---

### Section 7 — Final Pass/Fail Summary

The summary table shows 24 binary checks. The final aggregate row shows the verdict:

```
✓ ALL CHECKS PASSED — Phase 1 may be approved
```

or

```
✗ FAILURES DETECTED — do not proceed to Phase 2
```

**If any check fails**: Use the `Detail` column (shows null-count or row-count). Cross-reference with the detailed section that covers that check to identify the root cause.

---

## How to Interpret Failures

| Failure pattern | Likely cause | Remediation |
|-----------------|-------------|-------------|
| Table `*** MISSING ***` | Migration A/G/I did not run | Re-run the specific migration file |
| Column `*** MISSING ***` | Migration B/C/D/E/F/H did not run | Re-run the specific migration file |
| `null_X > 0` | Backfill UPDATE did not execute | Run explicit UPDATE manually (see Section 2 above) |
| `customer_rows_MUST_BE_0 > 0` | Customer learning deployed early | Remove rows; audit what wrote them |
| UNIQUE constraint missing | Constraint was dropped externally | Re-add constraint (see Section 4 above) |
| Orphaned invoices | Pre-existing data quality issue | Document; does not block Phase 2 |
| Invalid voucher_class values | CHECK constraint not enforced at insert | Investigate individual rows |

---

## Rollback Instructions

If validation reveals critical failures and you need to reverse all Phase 1 migrations:

1. Confirm no customer learning rows exist (must be 0 before rollback):
   ```sql
   SELECT COUNT(*) FROM vendor_ledger_preferences WHERE party_type = 'customer';
   ```
2. Open `supabase/rollbacks/phase1_rollback.sql`.
3. Run it in the Supabase SQL Editor.
4. The script runs in a single transaction (BEGIN / COMMIT). If any statement fails, the entire rollback is rolled back — no partial state.
5. Re-run `phase1_validate.sql` after rollback to confirm all `*** MISSING ***` entries are expected (all Phase 1 objects gone).

**Data loss on rollback**: No historical data is lost. The rollback drops new columns (which contain only default values or NULL for new rows) and drops new tables (which are empty in Phase 1). `vendor_ledger_preferences` loses the `party_type` and `pref_source` columns, but `party_type` was always `'vendor'` (derivable) and `pref_source` was always `'learned'` (derivable).
