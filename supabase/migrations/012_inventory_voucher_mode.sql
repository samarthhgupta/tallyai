-- Migration 012: Inventory Voucher Mode
-- Adds voucher_mode to companies (accounting_only vs inventory).
-- Also adds discount_ledger_name to companies for bill-level discount bookings.

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS voucher_mode text NOT NULL DEFAULT 'accounting_only',
  ADD COLUMN IF NOT EXISTS discount_ledger_name text;

COMMENT ON COLUMN companies.voucher_mode IS
  'accounting_only = HSN-aggregated purchase ledgers only; inventory = INVENTORYENTRIES.LIST with qty/rate/disc_percent';
COMMENT ON COLUMN companies.discount_ledger_name IS
  'Tally ledger for bill-level discounts (P&L side). Stored exactly as entered.';
