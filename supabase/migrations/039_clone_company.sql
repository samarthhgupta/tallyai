-- Migration 039: Company clone metadata + clone_company() function
--
-- Adds three audit columns to companies (no effect on business logic, XML, or exports).
-- Adds a single clone_company() RPC that performs a full point-in-time behavioural snapshot.

-- ── Clone metadata columns ────────────────────────────────────────────────────

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS is_test_company          BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS cloned_from_company_id   UUID REFERENCES companies(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cloned_from_company_name TEXT,
  ADD COLUMN IF NOT EXISTS cloned_at                TIMESTAMPTZ;

-- ── clone_company() ───────────────────────────────────────────────────────────
--
-- Creates a full behavioural clone of source_id under new_name.
-- Returns the UUID of the newly created company.
-- Entire operation is one atomic transaction — partial clones cannot occur.

CREATE OR REPLACE FUNCTION clone_company(source_id UUID, new_name TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  new_id         UUID := gen_random_uuid();
  src            companies%ROWTYPE;

  -- id-mapping tables (old → new)
  batch_map      JSONB := '{}'::JSONB;
  invoice_map    JSONB := '{}'::JSONB;

  old_batch_id   UUID;
  new_batch_id   UUID;
  old_inv_id     UUID;
  new_inv_id     UUID;
BEGIN
  -- ── 0. Load source company ─────────────────────────────────────────────────
  SELECT * INTO src FROM companies WHERE id = source_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Source company % not found', source_id;
  END IF;

  IF EXISTS (SELECT 1 FROM companies WHERE LOWER(TRIM(name)) = LOWER(TRIM(new_name))) THEN
    RAISE EXCEPTION 'A company named "%" already exists', new_name;
  END IF;

  -- ── 1. Clone companies row ─────────────────────────────────────────────────
  INSERT INTO companies (
    id, created_at, created_by,
    name, gstin, state_code, state_name,
    tally_company_name, tally_url, tally_port,
    updated_at,
    purchase_ledger_config, voucher_mode, discount_ledger_name, stock_item_mode,
    is_test_company, cloned_from_company_id, cloned_from_company_name, cloned_at
  )
  VALUES (
    new_id, NOW(), src.created_by,
    new_name, src.gstin, src.state_code, src.state_name,
    src.tally_company_name, src.tally_url, src.tally_port,
    NOW(),
    src.purchase_ledger_config, src.voucher_mode, src.discount_ledger_name, src.stock_item_mode,
    TRUE, source_id, src.name, NOW()
  );

  -- ── 2. Clone invoice_batches (build id map) ────────────────────────────────
  FOR old_batch_id IN
    SELECT id FROM invoice_batches WHERE company_id = source_id
  LOOP
    new_batch_id := gen_random_uuid();
    batch_map := batch_map || jsonb_build_object(old_batch_id::TEXT, new_batch_id::TEXT);

    INSERT INTO invoice_batches (id, created_at, company_id, uploaded_by, file_count, invoice_count, financial_year, period_month, period_label)
    SELECT new_batch_id, created_at, new_id, uploaded_by, file_count, invoice_count, financial_year, period_month, period_label
    FROM invoice_batches WHERE id = old_batch_id;
  END LOOP;

  -- ── 3. Clone invoices (build id map) ──────────────────────────────────────
  FOR old_inv_id IN
    SELECT id FROM invoices WHERE company_id = source_id
  LOOP
    new_inv_id := gen_random_uuid();
    invoice_map := invoice_map || jsonb_build_object(old_inv_id::TEXT, new_inv_id::TEXT);

    INSERT INTO invoices (
      id, created_at, company_id, batch_id,
      filename, original_filename, upload_date, upload_time,
      vendor_name, vendor_gstin, vendor_address,
      buyer_name, buyer_gstin,
      invoice_number, invoice_date, tax_type,
      subtotal, bill_discount_amount, bill_discount_percent,
      cgst, sgst, igst, round_off, total,
      confidence, confidence_reasons,
      line_items, charges,
      needs_review, bill_discount_auto_detected,
      status, readiness, readiness_flags,
      financial_year, period_month, period_label,
      itc_status, itc_remark,
      accepted_at, accepted_by, rejected_at, rejected_by, rejection_reason,
      last_modified_at, last_modified_by,
      converted_to_nongst, converted_nongst_ledger,
      supplier_master_id, ledger_master_id,
      tally_ledger_acceptance
    )
    SELECT
      new_inv_id, created_at, new_id,
      CASE WHEN batch_id IS NOT NULL THEN (batch_map->>(batch_id::TEXT))::UUID ELSE NULL END,
      filename, original_filename, upload_date, upload_time,
      vendor_name, vendor_gstin, vendor_address,
      buyer_name, buyer_gstin,
      invoice_number, invoice_date, tax_type,
      subtotal, bill_discount_amount, bill_discount_percent,
      cgst, sgst, igst, round_off, total,
      confidence, confidence_reasons,
      line_items, charges,
      needs_review, bill_discount_auto_detected,
      status, readiness, readiness_flags,
      financial_year, period_month, period_label,
      itc_status, itc_remark,
      accepted_at, accepted_by, rejected_at, rejected_by, rejection_reason,
      last_modified_at, last_modified_by,
      converted_to_nongst, converted_nongst_ledger,
      NULL, NULL,  -- supplier_master_id / ledger_master_id: re-resolved against new master ids post-clone
      tally_ledger_acceptance
    FROM invoices WHERE id = old_inv_id;
  END LOOP;

  -- ── 4. Clone rejection_archive ─────────────────────────────────────────────
  INSERT INTO rejection_archive (
    id, created_at, company_id, invoice_id, batch_id,
    vendor_name, vendor_gstin, invoice_number, invoice_date,
    total, financial_year, period_month, period_label,
    original_filename, readiness, readiness_flags,
    rejected_at, rejected_by, rejection_reason
  )
  SELECT
    gen_random_uuid(), created_at, new_id,
    (invoice_map->>(invoice_id::TEXT))::UUID,
    CASE WHEN batch_id IS NOT NULL THEN (batch_map->>(batch_id::TEXT))::UUID ELSE NULL END,
    vendor_name, vendor_gstin, invoice_number, invoice_date,
    total, financial_year, period_month, period_label,
    original_filename, readiness, readiness_flags,
    rejected_at, rejected_by, rejection_reason
  FROM rejection_archive
  WHERE company_id = source_id;

  -- ── 5. Clone supplier_masters ──────────────────────────────────────────────
  INSERT INTO supplier_masters (
    id, created_at, company_id, created_by,
    vendor_name, vendor_gstin, tally_ledger_name,
    state_name, is_unregistered, gstin_valid, updated_at
  )
  SELECT
    gen_random_uuid(), created_at, new_id, created_by,
    vendor_name, vendor_gstin, tally_ledger_name,
    state_name, is_unregistered, gstin_valid, updated_at
  FROM supplier_masters WHERE company_id = source_id;

  -- ── 6. Clone stock_item_masters ────────────────────────────────────────────
  INSERT INTO stock_item_masters (
    id, created_at, updated_at, company_id, created_by,
    tally_item_name, alias_name, unit, hsn_code, gst_percent
  )
  SELECT
    gen_random_uuid(), created_at, updated_at, new_id, created_by,
    tally_item_name, alias_name, unit, hsn_code, gst_percent
  FROM stock_item_masters WHERE company_id = source_id;

  -- ── 7. Clone duties_taxes_masters ──────────────────────────────────────────
  INSERT INTO duties_taxes_masters (
    id, created_at, updated_at, company_id, created_by,
    tax_component, tax_rate, tally_ledger_name
  )
  SELECT
    gen_random_uuid(), created_at, updated_at, new_id, created_by,
    tax_component, tax_rate, tally_ledger_name
  FROM duties_taxes_masters WHERE company_id = source_id;

  -- ── 8. Clone expense_ledger_masters ────────────────────────────────────────
  INSERT INTO expense_ledger_masters (
    id, created_at, updated_at, company_id, created_by,
    tally_ledger_name, expense_keyword, sac_code, gst_percent
  )
  SELECT
    gen_random_uuid(), created_at, updated_at, new_id, created_by,
    tally_ledger_name, expense_keyword, sac_code, gst_percent
  FROM expense_ledger_masters WHERE company_id = source_id;

  -- ── 9. Clone voucher_type_masters ──────────────────────────────────────────
  INSERT INTO voucher_type_masters (
    id, created_at, updated_at, company_id, created_by,
    purchase_category, tally_voucher_type_name
  )
  SELECT
    gen_random_uuid(), created_at, updated_at, new_id, created_by,
    purchase_category, tally_voucher_type_name
  FROM voucher_type_masters WHERE company_id = source_id;

  -- ── 10. Clone ledger_masters (deprecated but may contain data) ─────────────
  INSERT INTO ledger_masters (
    id, created_at, company_id, created_by,
    hsn_sac, gst_percent, description,
    purchase_ledger, cgst_ledger, sgst_ledger, igst_ledger
  )
  SELECT
    gen_random_uuid(), created_at, new_id, created_by,
    hsn_sac, gst_percent, description,
    purchase_ledger, cgst_ledger, sgst_ledger, igst_ledger
  FROM ledger_masters WHERE company_id = source_id;

  -- ── 11. Clone uom_alias (company-scoped rows only) ─────────────────────────
  INSERT INTO uom_alias (
    id, created_at, company_id, canonical_id, alias
  )
  SELECT
    gen_random_uuid(), created_at, new_id, canonical_id, alias
  FROM uom_alias WHERE company_id = source_id;

  -- ── 12. Clone uom_pending_review ───────────────────────────────────────────
  INSERT INTO uom_pending_review (
    id, created_at, company_id, invoice_id,
    raw_value, suggested_canonical_id, status, resolved_by, resolved_at
  )
  SELECT
    gen_random_uuid(), created_at, new_id,
    (invoice_map->>(invoice_id::TEXT))::UUID,
    raw_value, suggested_canonical_id, status, resolved_by, resolved_at
  FROM uom_pending_review WHERE company_id = source_id;

  RETURN new_id;
END;
$$;
