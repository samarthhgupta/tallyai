import { getSupabase } from './supabase';

export type LedgerType = 'purchase' | 'CGST' | 'SGST' | 'IGST' | 'CESS';

// ─── INTENTIONAL ARCHITECTURE: GSTIN-ONLY LEARNING ───────────────────────────
//
// Case 1 (this module — vendor_ledger_preferences table) is GSTIN-only because
// it creates durable learned behavior that persists across sessions. Writing a
// wrong preference silently poisons every future suggestion for that vendor.
// GSTIN is the only reliable vendor identity in Indian GST workflows: vendor
// names degrade through OCR errors, abbreviations, and punctuation differences.
//
// Case 2 (getHistoricalPurchaseLedger in purchaseLedgers.ts) is a read-only
// suggestion layer and intentionally allows vendor-name fallback when GSTIN is
// unavailable. A wrong name-matched suggestion costs the accountant one dropdown
// correction. It does NOT create preferences and must NOT be interpreted as
// vendor learning.
//
// Future developers: do not add name-based writes to this module. The split
// between GSTIN-only writes (Case 1) and GSTIN-first/name-fallback reads
// (Case 2) is a deliberate design decision, not an oversight.
// ─────────────────────────────────────────────────────────────────────────────

// GSTIN validation: 15-character alphanumeric in standard Indian GST format.
// If GSTIN is absent or fails validation, no preference is written or read —
// the caller falls through to Case 2 (historical frequency) or Case 3 (default).
function isValidGstin(gstin: string | null | undefined): boolean {
  if (!gstin?.trim()) return false;
  return /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/.test(gstin.trim().toUpperCase());
}

function normaliseGstin(gstin: string): string {
  return gstin.trim().toUpperCase();
}

export async function upsertVendorLedgerPreference(
  companyId: string,
  vendorGstin: string | null | undefined,
  _vendorName: string | null | undefined,   // accepted for call-site compatibility but never used
  ledgerType: LedgerType,
  ledgerName: string,
): Promise<void> {
  // Only learn when a valid GSTIN is present. Name-based learning is disabled.
  if (!isValidGstin(vendorGstin) || !ledgerName.trim()) return;
  const key = normaliseGstin(vendorGstin!);
  const sb = getSupabase();
  const { error } = await (sb as any)
    .from('vendor_ledger_preferences')
    .upsert(
      {
        company_id: companyId,
        vendor_key: key,
        ledger_type: ledgerType,
        ledger_name: ledgerName,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'company_id,vendor_key,ledger_type' },
    );
  if (error) console.warn('upsertVendorLedgerPreference failed:', error.message);
}

export async function getVendorLedgerPreferences(
  companyId: string,
  vendorGstin: string | null | undefined,
  _vendorName: string | null | undefined,   // accepted for call-site compatibility but never used
): Promise<Partial<Record<LedgerType, string>>> {
  // Only look up preferences by GSTIN. If GSTIN is absent or invalid, skip Case 1
  // and fall through to historical frequency (Case 2) or company-wide (Case 3).
  if (!isValidGstin(vendorGstin)) return {};
  const key = normaliseGstin(vendorGstin!);
  const sb = getSupabase();
  const { data, error } = await (sb as any)
    .from('vendor_ledger_preferences')
    .select('ledger_type, ledger_name')
    .eq('company_id', companyId)
    .eq('vendor_key', key);
  if (error || !data) return {};
  const result: Partial<Record<LedgerType, string>> = {};
  for (const row of data) {
    result[row.ledger_type as LedgerType] = row.ledger_name;
  }
  return result;
}
