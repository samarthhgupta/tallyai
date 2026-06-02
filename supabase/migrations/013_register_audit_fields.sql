-- Migration 013: Register Audit Fields
-- Adds last_modified tracking to invoices.
-- Adds moved_by_email and itc_status snapshot to rejection_archive.

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS last_modified_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_modified_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE rejection_archive
  ADD COLUMN IF NOT EXISTS moved_by_email text,
  ADD COLUMN IF NOT EXISTS itc_status text;
