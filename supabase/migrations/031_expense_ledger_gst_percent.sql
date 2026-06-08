-- Migration 031: Add gst_percent to expense_ledger_masters
-- Purpose: store GST rate for expense/indirect-expense ledgers so that
--          GSTDETAILS.LIST can be emitted in the Tally XML import file.
-- Notes:
--   - gst_percent is the TOTAL GST rate (e.g. 18 for 18% GST)
--   - CGST = SGST = gst_percent / 2; IGST = gst_percent
--   - null means unknown / omit GSTDETAILS.LIST from XML

ALTER TABLE expense_ledger_masters
  ADD COLUMN IF NOT EXISTS gst_percent numeric(5,2) DEFAULT NULL;
