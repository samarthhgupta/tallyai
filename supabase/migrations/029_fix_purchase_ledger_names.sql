-- Rename "Purchases ..." → "Purchase ..." in purchase_ledger_config JSON
-- Affects all companies that have auto-suggested ledger names with the old plural form.

UPDATE companies
SET purchase_ledger_config = (
  SELECT jsonb_agg(
    jsonb_set(
      entry,
      '{tally_ledger_name}',
      to_jsonb(
        regexp_replace(
          entry->>'tally_ledger_name',
          '^Purchases(\s|$)',
          'Purchase\1'
        )
      )
    )
  )
  FROM jsonb_array_elements(purchase_ledger_config::jsonb) AS entry
)
WHERE purchase_ledger_config IS NOT NULL
  AND purchase_ledger_config::text LIKE '%Purchases%';
