-- Migration 014: Add missing audit columns (safe re-run of 013)
-- Migration 013 failed to apply. This migration adds the same columns
-- using IF NOT EXISTS so it is safe to run multiple times.

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS last_modified_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_modified_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE rejection_archive
  ADD COLUMN IF NOT EXISTS moved_by_email text,
  ADD COLUMN IF NOT EXISTS itc_status text;
