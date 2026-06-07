-- Store the Tally ledger values that were accepted for each invoice.
-- This allows the XML page to restore locked state after a page refresh.
-- The column is JSONB and stores the same shape as LockedInvoice in the frontend.

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS tally_ledger_acceptance jsonb DEFAULT NULL;
