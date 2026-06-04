-- Migration 023: Seed the _migrations tracking table with all previously applied migrations.
-- Migrations 001-014 ran successfully before the tracker was introduced.
-- This ensures the new workflow skips them instead of re-running them.

CREATE TABLE IF NOT EXISTS _migrations (
    name TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO _migrations (name) VALUES
  ('001_create_prompt_rules_and_logs.sql'),
  ('002_add_description_to_line_items_schema.sql'),
  ('003_purchase_register_schema.sql'),
  ('004_supplier_masters_redesign.sql'),
  ('005_duties_taxes_master.sql'),
  ('006_company_master_fields.sql'),
  ('007_stock_item_master.sql'),
  ('008_expense_ledger_master.sql'),
  ('009_fix_company_ownership.sql'),
  ('010_add_buyer_fields_to_invoices.sql'),
  ('012_inventory_voucher_mode.sql'),
  ('013_register_audit_fields.sql'),
  ('014_add_missing_audit_columns.sql')
ON CONFLICT DO NOTHING;
