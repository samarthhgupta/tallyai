-- Migration 010: Add missing columns to invoices table
-- These columns exist in the codebase but were not in the initial schema.

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS buyer_name  text,
  ADD COLUMN IF NOT EXISTS buyer_gstin text;
