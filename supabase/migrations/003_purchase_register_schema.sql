-- ============================================================
-- TallyAI — Migration 003
-- Purchase Register Architecture
--
-- This migration is idempotent (safe to re-run).
--
-- Creates or extends:
--   1. companies          — ensure base table exists with all fields
--   2. invoice_batches    — add period fields
--   3. invoices           — add status, readiness, ITC, audit fields
--   4. supplier_masters   — new: vendor GSTIN → Tally party ledger
--   5. ledger_masters     — new: HSN/SAC + rate → Tally purchase ledgers
--   6. rejection_archive  — new: audit trail for rejected invoices
--   7. Indexes            — for register queries (company + period + status)
-- ============================================================


-- ── 1. companies ─────────────────────────────────────────────
-- Base table may already exist from manual setup.
-- CREATE IF NOT EXISTS is safe; existing data is untouched.

CREATE TABLE IF NOT EXISTS companies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at  timestamptz DEFAULT now(),
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  name        text NOT NULL,
  gstin       text,
  state_code  text,          -- derived from first 2 chars of GSTIN
  tally_url   text,
  tally_port  integer DEFAULT 9000
);

ALTER TABLE companies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "owner full access" ON companies;
CREATE POLICY "owner full access" ON companies
  USING (created_by = auth.uid())
  WITH CHECK (created_by = auth.uid());


-- ── 2. invoice_batches ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS invoice_batches (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at     timestamptz DEFAULT now(),
  company_id     uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  uploaded_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  file_count     integer DEFAULT 0,
  invoice_count  integer DEFAULT 0
);

-- Period fields (added by this migration)
ALTER TABLE invoice_batches
  ADD COLUMN IF NOT EXISTS financial_year text,   -- 'FY 2024-25'
  ADD COLUMN IF NOT EXISTS period_month   text,   -- '2024-10'
  ADD COLUMN IF NOT EXISTS period_label   text;   -- 'October-24'

ALTER TABLE invoice_batches ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "company owner access" ON invoice_batches;
CREATE POLICY "company owner access" ON invoice_batches
  USING (
    company_id IN (
      SELECT id FROM companies WHERE created_by = auth.uid()
    )
  )
  WITH CHECK (
    company_id IN (
      SELECT id FROM companies WHERE created_by = auth.uid()
    )
  );


-- ── 3. invoices ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS invoices (
  id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at                   timestamptz DEFAULT now(),
  batch_id                     uuid REFERENCES invoice_batches(id) ON DELETE SET NULL,
  company_id                   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  -- File info
  filename                     text,

  -- Extracted invoice fields
  vendor_name                  text,
  vendor_gstin                 text,
  vendor_address               text,
  buyer_name                   text,
  buyer_gstin                  text,
  invoice_number               text,
  invoice_date                 text,
  tax_type                     text,   -- 'cgst_sgst' | 'igst'
  subtotal                     numeric(14,2),
  bill_discount_amount         numeric(14,2) DEFAULT 0,
  bill_discount_percent        numeric(7,4),
  cgst                         numeric(14,2) DEFAULT 0,
  sgst                         numeric(14,2) DEFAULT 0,
  igst                         numeric(14,2) DEFAULT 0,
  round_off                    numeric(14,2) DEFAULT 0,
  total                        numeric(14,2),
  confidence                   numeric(5,4),
  confidence_reasons           jsonb,        -- array of strings
  line_items                   jsonb,
  charges                      jsonb,
  needs_review                 boolean DEFAULT false,
  bill_discount_auto_detected  boolean DEFAULT false
);

-- Status & readiness (core of the Purchase Register workflow)
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS status         text NOT NULL DEFAULT 'pending_review',
  -- 'pending_review' | 'accepted' | 'rejected'

  ADD COLUMN IF NOT EXISTS readiness      text NOT NULL DEFAULT 'ready',
  -- 'ready' | 'warning' | 'critical'

  ADD COLUMN IF NOT EXISTS readiness_flags jsonb;
  -- array of strings, e.g. ["Missing vendor GSTIN", "Low confidence (68%)"]

-- Period (inherited from batch, storable per-invoice for the register)
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS financial_year text,   -- 'FY 2024-25'
  ADD COLUMN IF NOT EXISTS period_month   text,   -- '2024-10'
  ADD COLUMN IF NOT EXISTS period_label   text;   -- 'October-24'

-- ITC tracking
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS itc_status     text,
  -- 'eligible' | 'potentially_ineligible' | 'not_applicable'

  ADD COLUMN IF NOT EXISTS itc_remark     text;
  -- e.g. 'Recipient GSTIN Missing'

-- Audit trail
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS original_filename   text,
  ADD COLUMN IF NOT EXISTS upload_date         date,
  ADD COLUMN IF NOT EXISTS upload_time         timestamptz,
  ADD COLUMN IF NOT EXISTS accepted_at         timestamptz,
  ADD COLUMN IF NOT EXISTS accepted_by         uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS rejected_at         timestamptz,
  ADD COLUMN IF NOT EXISTS rejected_by         uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS rejection_reason    text;

-- Non-GST conversion
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS converted_to_nongst      boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS converted_nongst_ledger   text;

-- Master references (populated when masters are linked)
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS supplier_master_id  uuid,
  ADD COLUMN IF NOT EXISTS ledger_master_id    uuid;

-- Status check constraint
ALTER TABLE invoices
  DROP CONSTRAINT IF EXISTS invoices_status_check;
ALTER TABLE invoices
  ADD CONSTRAINT invoices_status_check
  CHECK (status IN ('pending_review', 'accepted', 'rejected'));

-- Readiness check constraint
ALTER TABLE invoices
  DROP CONSTRAINT IF EXISTS invoices_readiness_check;
ALTER TABLE invoices
  ADD CONSTRAINT invoices_readiness_check
  CHECK (readiness IN ('ready', 'warning', 'critical'));

ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "company owner access" ON invoices;
CREATE POLICY "company owner access" ON invoices
  USING (
    company_id IN (
      SELECT id FROM companies WHERE created_by = auth.uid()
    )
  )
  WITH CHECK (
    company_id IN (
      SELECT id FROM companies WHERE created_by = auth.uid()
    )
  );


-- ── 4. supplier_masters ──────────────────────────────────────

CREATE TABLE IF NOT EXISTS supplier_masters (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at         timestamptz DEFAULT now(),
  company_id         uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  created_by         uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  vendor_name        text NOT NULL,
  vendor_gstin       text NOT NULL,
  tally_ledger_name  text NOT NULL,
  UNIQUE (company_id, vendor_gstin)
);

ALTER TABLE supplier_masters ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "company owner access" ON supplier_masters;
CREATE POLICY "company owner access" ON supplier_masters
  USING (
    company_id IN (
      SELECT id FROM companies WHERE created_by = auth.uid()
    )
  )
  WITH CHECK (
    company_id IN (
      SELECT id FROM companies WHERE created_by = auth.uid()
    )
  );


-- ── 5. ledger_masters ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ledger_masters (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at       timestamptz DEFAULT now(),
  company_id       uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  created_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  hsn_sac          text NOT NULL,
  gst_percent      numeric(5,2) NOT NULL,
  description      text,
  purchase_ledger  text NOT NULL,
  cgst_ledger      text,
  sgst_ledger      text,
  igst_ledger      text,
  UNIQUE (company_id, hsn_sac, gst_percent)
);

ALTER TABLE ledger_masters ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "company owner access" ON ledger_masters;
CREATE POLICY "company owner access" ON ledger_masters
  USING (
    company_id IN (
      SELECT id FROM companies WHERE created_by = auth.uid()
    )
  )
  WITH CHECK (
    company_id IN (
      SELECT id FROM companies WHERE created_by = auth.uid()
    )
  );


-- ── 6. rejection_archive ─────────────────────────────────────
-- Separate audit table so rejection history survives even if
-- the invoice row is later purged.

CREATE TABLE IF NOT EXISTS rejection_archive (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at        timestamptz DEFAULT now(),
  invoice_id        uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  company_id        uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  batch_id          uuid REFERENCES invoice_batches(id) ON DELETE SET NULL,
  rejected_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  rejected_at       timestamptz DEFAULT now(),
  rejection_reason  text,

  -- Denormalized snapshot at rejection time (audit immutability)
  invoice_number    text,
  vendor_name       text,
  vendor_gstin      text,
  invoice_date      text,
  total             numeric(14,2),
  original_filename text,
  financial_year    text,
  period_month      text,
  period_label      text,
  readiness         text,
  readiness_flags   jsonb
);

ALTER TABLE rejection_archive ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "company owner access" ON rejection_archive;
CREATE POLICY "company owner access" ON rejection_archive
  USING (
    company_id IN (
      SELECT id FROM companies WHERE created_by = auth.uid()
    )
  )
  WITH CHECK (
    company_id IN (
      SELECT id FROM companies WHERE created_by = auth.uid()
    )
  );


-- ── 7. Indexes ───────────────────────────────────────────────
-- Purchase Register primary query: company + status + period
CREATE INDEX IF NOT EXISTS idx_invoices_register
  ON invoices (company_id, status, financial_year, period_month);

-- Upload Queue query: company + pending
CREATE INDEX IF NOT EXISTS idx_invoices_pending
  ON invoices (company_id, status)
  WHERE status = 'pending_review';

-- Batch lookup
CREATE INDEX IF NOT EXISTS idx_invoices_batch
  ON invoices (batch_id);

-- Supplier lookup by GSTIN per company
CREATE INDEX IF NOT EXISTS idx_supplier_masters_gstin
  ON supplier_masters (company_id, vendor_gstin);

-- Ledger lookup by HSN+rate per company
CREATE INDEX IF NOT EXISTS idx_ledger_masters_hsn
  ON ledger_masters (company_id, hsn_sac, gst_percent);

-- Rejection archive by company + period
CREATE INDEX IF NOT EXISTS idx_rejection_archive_company
  ON rejection_archive (company_id, period_month);


-- ── 8. Helper: stamp upload_date/time on insert ──────────────
CREATE OR REPLACE FUNCTION stamp_invoice_upload_time()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.upload_time IS NULL THEN
    NEW.upload_time := NOW();
  END IF;
  IF NEW.upload_date IS NULL THEN
    NEW.upload_date := CURRENT_DATE;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS invoices_stamp_upload_time ON invoices;
CREATE TRIGGER invoices_stamp_upload_time
  BEFORE INSERT ON invoices
  FOR EACH ROW EXECUTE FUNCTION stamp_invoice_upload_time();
