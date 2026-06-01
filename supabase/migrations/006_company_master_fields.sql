-- Migration 006: Company Master — add tally_company_name and state fields
-- tally_company_name: exact company name as configured in Tally (used in XML header)
-- state_name: derived from company GSTIN first 2 digits (auto, never user-entered)

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS tally_company_name  text,
  ADD COLUMN IF NOT EXISTS state_name          text,
  ADD COLUMN IF NOT EXISTS updated_at          timestamptz DEFAULT now();

-- Back-fill state_name from existing state_code where possible
-- (state_code was stored as 2-digit string e.g. '27')
-- We leave this as null for existing rows — user will fill on next edit.
