// Purchase Ledger Master - stores accepted purchase ledger names in company.purchase_ledger_config.
// Each entry is { gst_percent: null, tally_ledger_name: string } - rate is null (consolidated).
// The first entry is used as the default suggestion when none is accepted per-invoice.

import { getSupabase } from './supabase';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => getSupabase() as any;

export interface PurchaseLedgerMaster {
  tally_ledger_name: string;  // sacred
}

export async function loadPurchaseLedgers(companyId: string): Promise<PurchaseLedgerMaster[]> {
  const { data, error } = await db()
    .from('companies')
    .select('purchase_ledger_config')
    .eq('id', companyId)
    .single();
  if (error) throw error;
  const config: { gst_percent: number | null; tally_ledger_name: string }[] = data?.purchase_ledger_config ?? [];
  return config.map((c) => ({ tally_ledger_name: c.tally_ledger_name }));
}

export async function addPurchaseLedger(companyId: string, tallyLedgerName: string): Promise<void> {
  const existing = await loadPurchaseLedgers(companyId);
  // Skip if already present (case-insensitive)
  if (existing.some((l) => l.tally_ledger_name.toLowerCase() === tallyLedgerName.toLowerCase())) return;
  const newConfig = [
    ...existing.map((l) => ({ gst_percent: null as null, tally_ledger_name: l.tally_ledger_name })),
    { gst_percent: null as null, tally_ledger_name: tallyLedgerName },
  ];
  const { error } = await db()
    .from('companies')
    .update({ purchase_ledger_config: newConfig, updated_at: new Date().toISOString() })
    .eq('id', companyId);
  if (error) throw error;
}

export async function deletePurchaseLedger(companyId: string, tallyLedgerName: string): Promise<void> {
  const existing = await loadPurchaseLedgers(companyId);
  const newConfig = existing
    .filter((l) => l.tally_ledger_name !== tallyLedgerName)
    .map((l) => ({ gst_percent: null as null, tally_ledger_name: l.tally_ledger_name }));
  const { error } = await db()
    .from('companies')
    .update({ purchase_ledger_config: newConfig, updated_at: new Date().toISOString() })
    .eq('id', companyId);
  if (error) throw error;
}

export async function updatePurchaseLedger(companyId: string, oldName: string, newName: string): Promise<void> {
  const existing = await loadPurchaseLedgers(companyId);
  const newConfig = existing.map((l) => ({
    gst_percent: null as null,
    tally_ledger_name: l.tally_ledger_name === oldName ? newName : l.tally_ledger_name,
  }));
  const { error } = await db()
    .from('companies')
    .update({ purchase_ledger_config: newConfig, updated_at: new Date().toISOString() })
    .eq('id', companyId);
  if (error) throw error;
}

// Returns the most frequently accepted Purchase Ledger across ALL invoices for this company.
// Used as Case 3 fallback when no supplier-specific history exists.
// Tie-break: most recently accepted. Only considers genuinely accepted invoices.
// Validates result against currentMasters — returns null if the winning ledger no longer exists.
export async function getCompanyWideMostUsedPurchaseLedger(
  companyId: string,
  currentMasters: string[],
): Promise<string | null> {
  const { data, error } = await db()
    .from('invoices')
    .select('tally_ledger_acceptance, accepted_at')
    .eq('company_id', companyId)
    .not('accepted_at', 'is', null)
    .not('tally_ledger_acceptance', 'is', null);
  if (error || !data || data.length === 0) return null;

  const freq: Record<string, { count: number; latest: string }> = {};
  for (const row of data) {
    const pl = row.tally_ledger_acceptance?.purchaseLedger;
    if (!pl || typeof pl !== 'string' || pl.trim().length === 0) continue;
    if (!freq[pl]) freq[pl] = { count: 0, latest: '' };
    freq[pl].count++;
    if (!freq[pl].latest || row.accepted_at > freq[pl].latest) freq[pl].latest = row.accepted_at;
  }

  const entries = Object.entries(freq);
  if (entries.length === 0) return null;
  entries.sort((a, b) =>
    b[1].count !== a[1].count ? b[1].count - a[1].count : b[1].latest.localeCompare(a[1].latest),
  );

  // Return the winner only if it still exists in the current master
  for (const [pl] of entries) {
    if (currentMasters.includes(pl)) return pl;
  }
  return null;
}

// ─── INTENTIONAL ARCHITECTURE: GSTIN-FIRST WITH NAME FALLBACK (Case 2) ──────
//
// This function is Case 2 in the suggestion hierarchy. Unlike Case 1
// (vendorLedgerPreferences.ts), this is a READ-ONLY suggestion layer.
// It does not create preferences, does not write anything, and does not
// constitute vendor learning.
//
// The vendor-name fallback (ilike) is intentional and must be preserved.
// It provides historical suggestions for:
//   - Unregistered vendors (no GSTIN by law)
//   - Composition scheme vendors
//   - Local/petty cash suppliers
// Without it, these vendors always fall to Case 3 (company-wide) or Case 4
// (default), losing all invoice-specific history regardless of how many times
// they have been previously accepted.
//
// A name-matched wrong suggestion costs one dropdown correction.
// A name-based WRITE to the preference table would be far more harmful — which
// is why Case 1 (vendorLedgerPreferences.ts) is GSTIN-only.
//
// Future developers: do not change the ilike fallback to GSTIN-only here.
// If you want GSTIN-only lookups, use Case 1 (getVendorLedgerPreferences).
// ─────────────────────────────────────────────────────────────────────────────

// Returns the most frequently accepted Purchase Ledger for a supplier in this company.
// Tie-break: most recently accepted. Only considers genuinely accepted invoices
// (accepted_at IS NOT NULL). Returns null if no history found.
export async function getHistoricalPurchaseLedger(
  companyId: string,
  vendorGstin: string | null,
  vendorName: string | null,
): Promise<string | null> {
  if (!vendorGstin && !vendorName) return null;
  let query = db()
    .from('invoices')
    .select('tally_ledger_acceptance, accepted_at')
    .eq('company_id', companyId)
    .not('accepted_at', 'is', null)
    .not('tally_ledger_acceptance', 'is', null);

  if (vendorGstin) {
    query = query.eq('vendor_gstin', vendorGstin);   // Case 2a: GSTIN exact match
  } else {
    query = query.ilike('vendor_name', vendorName!.trim()); // Case 2b: name fallback (read-only, not learning)
  }

  const { data, error } = await query;
  if (error || !data || data.length === 0) return null;

  const freq: Record<string, { count: number; latest: string }> = {};
  for (const row of data) {
    const pl = row.tally_ledger_acceptance?.purchaseLedger;
    if (!pl) continue;
    if (!freq[pl]) freq[pl] = { count: 0, latest: '' };
    freq[pl].count++;
    if (!freq[pl].latest || row.accepted_at > freq[pl].latest) freq[pl].latest = row.accepted_at;
  }

  const entries = Object.entries(freq);
  if (entries.length === 0) return null;
  entries.sort((a, b) =>
    b[1].count !== a[1].count ? b[1].count - a[1].count : b[1].latest.localeCompare(a[1].latest),
  );
  return entries[0][0];
}
