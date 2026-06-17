-- Adds stock_item_mode to companies.
-- 'hsn_driven'  → match by HSN+GST rate only (e.g. "630419 @ 5%")
-- null / default → existing description-based waterfall unchanged
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS stock_item_mode TEXT
    CHECK (stock_item_mode IN ('hsn_driven'));

COMMENT ON COLUMN companies.stock_item_mode IS
  'Controls stock item matching strategy for XML generation. '
  'hsn_driven: match by HSN code + GST rate (skips alias/description matching). '
  'null: legacy description-based waterfall (default, backward-compatible).';
