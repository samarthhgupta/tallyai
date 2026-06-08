-- Migration 033: Three fixes
--
-- 1. Deduplicate duties_taxes_masters and add unique constraint
-- 2. Backfill stock_item_masters hsn_code + gst_percent from tally_item_name
-- 3. Backfill expense_ledger_masters gst_percent + sac_code from known defaults

-- ─── 1. Duties & Taxes dedup + unique constraint ──────────────────────────────
-- Keep the oldest row per (company_id, tax_component, tax_rate, tally_ledger_name)
DELETE FROM duties_taxes_masters
WHERE id NOT IN (
  SELECT DISTINCT ON (company_id, tax_component, COALESCE(tax_rate::text, 'NULL'), tally_ledger_name)
    id
  FROM duties_taxes_masters
  ORDER BY company_id, tax_component, COALESCE(tax_rate::text, 'NULL'), tally_ledger_name, created_at ASC
);

-- Add unique constraint so this can never happen again
ALTER TABLE duties_taxes_masters
  DROP CONSTRAINT IF EXISTS uq_duties_taxes_per_company;

ALTER TABLE duties_taxes_masters
  ADD CONSTRAINT uq_duties_taxes_per_company
  UNIQUE (company_id, tax_component, tax_rate, tally_ledger_name);

-- ─── 2. Backfill stock items: parse "HSN @ RATE%" from tally_item_name ────────
-- tally_item_name patterns: "63049999 @12%", "63049999 @ 12%", "3918 @18%", etc.
UPDATE stock_item_masters
SET
  hsn_code = CASE
    WHEN tally_item_name ~ '^\S+ @\s*\d'
    THEN trim(split_part(tally_item_name, '@', 1))
    ELSE hsn_code
  END,
  gst_percent = CASE
    WHEN tally_item_name ~ '@\s*\d+(\.\d+)?%'
    THEN (regexp_match(tally_item_name, '@\s*(\d+(?:\.\d+)?)%'))[1]::numeric
    ELSE gst_percent
  END
WHERE
  (hsn_code IS NULL OR gst_percent IS NULL)
  AND tally_item_name ~ '@\s*\d+(\.\d+)?%';

-- ─── 3. Backfill expense ledgers from common defaults ─────────────────────────
UPDATE expense_ledger_masters
SET
  gst_percent = v.gst_percent,
  sac_code    = COALESCE(NULLIF(expense_ledger_masters.sac_code, ''), v.sac_code)
FROM (VALUES
  ('freight',                    5.00,  '996511'),
  ('freight charges',            5.00,  '996511'),
  ('freight & forwarding charges', 5.00, '996511'),
  ('freight & forwarding',       5.00,  '996511'),
  ('freight forwarding',         5.00,  '996511'),
  ('delivery charges',           5.00,  '996511'),
  ('transport',                  5.00,  '996511'),
  ('transportation',             5.00,  '996511'),
  ('transportation charges',     5.00,  '996511'),
  ('courier',                    18.00, '996812'),
  ('courier charges',            18.00, '996812'),
  ('postage',                    18.00, '996811'),
  ('postage & telegram',         18.00, '996811'),
  ('packing',                    18.00, '998540'),
  ('packing charges',            18.00, '998540'),
  ('packaging charges',          18.00, '998540'),
  ('loading',                    18.00, '996719'),
  ('unloading',                  18.00, '996719'),
  ('loading charges',            18.00, '996719'),
  ('loading & unloading',        18.00, '996719'),
  ('handling charges',           18.00, '996719'),
  ('insurance',                  18.00, '997135'),
  ('insurance charges',          18.00, '997135'),
  ('labour',                     18.00, '998519'),
  ('labour charges',             18.00, '998519'),
  ('accounting charges',         18.00, '998211')
) AS v(keyword, gst_percent, sac_code)
WHERE
  (expense_ledger_masters.gst_percent IS NULL)
  AND lower(trim(expense_ledger_masters.tally_ledger_name)) = v.keyword;
