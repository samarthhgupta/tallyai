-- Migration 032: Add gst_percent to stock_item_masters
-- Purpose: store the item's GST rate so GSTDETAILS.LIST can be emitted
--          in the Tally XML without needing a live invoice in scope.
-- Notes:
--   - gst_percent is the TOTAL GST rate (e.g. 5, 12, 18, 28)
--   - CGST = SGST = gst_percent / 2; IGST = gst_percent
--   - null = unknown / omit rate entries from GSTDETAILS.LIST

ALTER TABLE stock_item_masters
  ADD COLUMN IF NOT EXISTS gst_percent numeric(5,2) DEFAULT NULL;
