-- Migration H: Extend vendor_ledger_preferences with party_type and versioning columns.
--
-- Strategy: EXTEND, do not replace or rename.
-- The table rename to party_ledger_preferences is deferred to a future release
-- migration after all dependent queries have been audited and updated.
--
-- Phase 1 adds:
--   party_type   — 'vendor' (existing) or 'customer' (future Sales Register)
--   pref_source  — how the preference was set: manual | learned | imported
--   created_at   — already exists in table; added here as no-op guard
--   updated_at   — already exists in table; added here as no-op guard
--
-- Safeguard (Phase 1): Customer learning (party_type='customer') is schema-ready
-- but NO application code writes customer preferences in Phase 1.
-- Customer learning will be enabled in Phase 2 after Sales Register validation.
--
-- All existing rows are vendor preferences — backfill party_type='vendor' explicitly.

DO $$
DECLARE
  v_start timestamptz := clock_timestamp();
  v_prefs_before integer;
  v_backfill_party_type integer;
  v_backfill_pref_source integer;
BEGIN

  SELECT COUNT(*) INTO v_prefs_before FROM vendor_ledger_preferences;

  -- party_type: 'vendor' for all existing rows, 'customer' for future Sales rows
  ALTER TABLE vendor_ledger_preferences
    ADD COLUMN IF NOT EXISTS party_type text NOT NULL DEFAULT 'vendor'
      CHECK (party_type IN ('vendor', 'customer'));

  -- pref_source: how this preference was established
  ALTER TABLE vendor_ledger_preferences
    ADD COLUMN IF NOT EXISTS pref_source text NOT NULL DEFAULT 'learned'
      CHECK (pref_source IN ('manual', 'learned', 'imported'));

  -- created_at and updated_at already exist per migration 042; guard with IF NOT EXISTS
  ALTER TABLE vendor_ledger_preferences
    ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

  ALTER TABLE vendor_ledger_preferences
    ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

  -- Explicit backfill of all historical rows
  UPDATE vendor_ledger_preferences
  SET party_type = 'vendor'
  WHERE party_type IS NULL OR party_type = '';
  GET DIAGNOSTICS v_backfill_party_type = ROW_COUNT;

  UPDATE vendor_ledger_preferences
  SET pref_source = 'learned'
  WHERE pref_source IS NULL OR pref_source = '';
  GET DIAGNOSTICS v_backfill_pref_source = ROW_COUNT;

  -- Index to support future customer-side queries without full table scan
  CREATE INDEX IF NOT EXISTS vendor_ledger_prefs_party_type
    ON vendor_ledger_preferences (company_id, party_type);

  RAISE NOTICE '------------------------------------------------------------';
  RAISE NOTICE 'Migration H: vendor_ledger_preferences party_type + versioning';
  RAISE NOTICE '------------------------------------------------------------';
  RAISE NOTICE 'Preferences before:        %', v_prefs_before;
  RAISE NOTICE 'party_type backfilled:     %', v_backfill_party_type;
  RAISE NOTICE 'pref_source backfilled:    %', v_backfill_pref_source;
  RAISE NOTICE 'NOTE: Table rename to party_ledger_preferences deferred to future release.';
  RAISE NOTICE 'NOTE: Customer learning (party_type=customer) is schema-ready but DISABLED in Phase 1.';
  RAISE NOTICE 'Completed in: % ms',
    EXTRACT(MILLISECONDS FROM (clock_timestamp() - v_start))::integer;
  RAISE NOTICE '------------------------------------------------------------';

END $$;
