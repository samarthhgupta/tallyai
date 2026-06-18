-- Migration 041: Add missing audit columns to invoices and rejection_archive.
--
-- Migrations 013 and 014 were seeded as applied in migration 023 but
-- never actually executed — the columns were never created in production.
-- This migration re-applies the same DDL with IF NOT EXISTS (safe to run
-- multiple times if columns already exist on some environments).

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS last_modified_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_modified_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE rejection_archive
  ADD COLUMN IF NOT EXISTS moved_by_email text,
  ADD COLUMN IF NOT EXISTS itc_status      text;
