-- ============================================================
-- TallyAI — Migration 034
-- Supplier Archival Columns
--
-- Adds supplier_* columns to the invoices table to preserve
-- AI-extracted financial values for audit purposes.
--
-- ARCHITECTURE NOTE:
--   Strict separation between Supplier Values and Derived Values.
--
--   supplier_cgst / supplier_sgst / supplier_igst / supplier_total / supplier_roundoff
--     → AI-extracted values from the original invoice PDF.
--     → Written ONCE at acceptance time. Never updated.
--     → MUST NOT drive any operational workflow.
--     → Used for audit/reconciliation only.
--
--   cgst / sgst / igst / total / round_off
--     → Derived by the canonical engine (deriveInvoiceFinancials).
--     → Written at acceptance time and on every save from Invoice Detail Panel.
--     → Drive ALL operational screens: Purchase Register, Invoice Detail Panel,
--       Export Preview, XML Generation, Tally Import, GST Reports, ITC Reports.
--
-- BACKWARD COMPATIBILITY:
--   Rows accepted before this migration (before the canonical-engine architecture)
--   will have supplier_* = NULL. This is intentional.
--   NULL means "accepted before supplier/derived separation was introduced".
--
--   WARNING FOR FUTURE REPORTING MODULES:
--   Historical rows (supplier_* IS NULL) may have stale cgst/sgst/igst values
--   in the derived columns, because the old acceptance pipeline used buildHsnSummary
--   (goods only, excluding taxable charges) rather than the canonical engine.
--   Do NOT assume derived columns are reliable for rows where supplier_* IS NULL
--   without re-deriving from line_items + charges at runtime.
-- ============================================================

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS supplier_cgst      numeric(14,2),
  ADD COLUMN IF NOT EXISTS supplier_sgst      numeric(14,2),
  ADD COLUMN IF NOT EXISTS supplier_igst      numeric(14,2),
  ADD COLUMN IF NOT EXISTS supplier_total     numeric(14,2),
  ADD COLUMN IF NOT EXISTS supplier_roundoff  numeric(14,2);

COMMENT ON COLUMN invoices.supplier_cgst     IS 'AI-extracted CGST. Archival only. Do not use for calculations. See derived cgst column.';
COMMENT ON COLUMN invoices.supplier_sgst     IS 'AI-extracted SGST. Archival only. Do not use for calculations. See derived sgst column.';
COMMENT ON COLUMN invoices.supplier_igst     IS 'AI-extracted IGST. Archival only. Do not use for calculations. See derived igst column.';
COMMENT ON COLUMN invoices.supplier_total    IS 'AI-extracted invoice total. Archival only. Do not use for calculations. See derived total column.';
COMMENT ON COLUMN invoices.supplier_roundoff IS 'AI-extracted round-off. Archival only. Do not use for calculations. See derived round_off column.';

COMMENT ON COLUMN invoices.cgst      IS 'Derived CGST from canonical engine (deriveInvoiceFinancials). Includes both line-item GST and taxable charge GST. Source of truth for all operational workflows.';
COMMENT ON COLUMN invoices.sgst      IS 'Derived SGST from canonical engine. Source of truth for all operational workflows.';
COMMENT ON COLUMN invoices.igst      IS 'Derived IGST from canonical engine. Source of truth for all operational workflows.';
COMMENT ON COLUMN invoices.total     IS 'Derived total from canonical engine: net_goods_taxable + all_charges + gst + round_off. Source of truth for all operational workflows.';
COMMENT ON COLUMN invoices.round_off IS 'User-editable round-off amount. Input to canonical engine, not derived from it.';
