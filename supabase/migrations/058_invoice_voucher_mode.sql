-- Add per-invoice voucher mode so Inventory and Accounting vouchers can coexist in one batch.
-- Defaults to 'inventory' to preserve existing behaviour for all current records.
-- NULL is treated as 'inventory' in application code.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS invoice_voucher_mode text DEFAULT 'inventory';
