import { getSupabase } from './supabase';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => getSupabase() as any;

export interface SalesLedgerMaster {
  tally_ledger_name: string;
}

export async function loadSalesLedgers(companyId: string): Promise<SalesLedgerMaster[]> {
  const { data, error } = await db()
    .from('companies')
    .select('sales_ledger_config')
    .eq('id', companyId)
    .single();
  if (error) throw error;
  const config: { tally_ledger_name: string }[] = data?.sales_ledger_config ?? [];
  return config.map((c) => ({ tally_ledger_name: c.tally_ledger_name }));
}

export async function addSalesLedger(companyId: string, tallyLedgerName: string): Promise<void> {
  const existing = await loadSalesLedgers(companyId);
  if (existing.some((l) => l.tally_ledger_name.toLowerCase() === tallyLedgerName.toLowerCase())) return;
  const newConfig = [
    ...existing.map((l) => ({ tally_ledger_name: l.tally_ledger_name })),
    { tally_ledger_name: tallyLedgerName },
  ];
  const { error } = await db()
    .from('companies')
    .update({ sales_ledger_config: newConfig, updated_at: new Date().toISOString() })
    .eq('id', companyId);
  if (error) throw error;
}

export async function deleteSalesLedger(companyId: string, tallyLedgerName: string): Promise<void> {
  const existing = await loadSalesLedgers(companyId);
  const newConfig = existing
    .filter((l) => l.tally_ledger_name !== tallyLedgerName)
    .map((l) => ({ tally_ledger_name: l.tally_ledger_name }));
  const { error } = await db()
    .from('companies')
    .update({ sales_ledger_config: newConfig, updated_at: new Date().toISOString() })
    .eq('id', companyId);
  if (error) throw error;
}

export async function updateSalesLedger(companyId: string, oldName: string, newName: string): Promise<void> {
  const existing = await loadSalesLedgers(companyId);
  const newConfig = existing.map((l) => ({
    tally_ledger_name: l.tally_ledger_name === oldName ? newName : l.tally_ledger_name,
  }));
  const { error } = await db()
    .from('companies')
    .update({ sales_ledger_config: newConfig, updated_at: new Date().toISOString() })
    .eq('id', companyId);
  if (error) throw error;
}

// Returns the most frequently accepted Sales Ledger across ALL invoices for this company.
// Used as company-wide fallback when no customer-specific history exists.
// Validates result against currentMasters — returns null if the winning ledger no longer exists.
export async function getCompanyWideMostUsedSalesLedger(
  companyId: string,
  currentMasters: string[],
): Promise<string | null> {
  const { data, error } = await db()
    .from('sales_invoices')
    .select('tally_ledger_acceptance, accepted_at')
    .eq('company_id', companyId)
    .not('accepted_at', 'is', null)
    .not('tally_ledger_acceptance', 'is', null);
  if (error || !data || data.length === 0) return null;

  const freq: Record<string, { count: number; latest: string }> = {};
  for (const row of data) {
    const sl = row.tally_ledger_acceptance?.salesLedger;
    if (!sl || typeof sl !== 'string' || sl.trim().length === 0) continue;
    if (!freq[sl]) freq[sl] = { count: 0, latest: '' };
    freq[sl].count++;
    if (!freq[sl].latest || row.accepted_at > freq[sl].latest) freq[sl].latest = row.accepted_at;
  }

  const entries = Object.entries(freq);
  if (entries.length === 0) return null;
  entries.sort((a, b) =>
    b[1].count !== a[1].count ? b[1].count - a[1].count : b[1].latest.localeCompare(a[1].latest),
  );
  for (const [sl] of entries) {
    if (currentMasters.includes(sl)) return sl;
  }
  return null;
}

// Batch version: fetches ALL historical sales ledger data for a company in ONE query.
// Returns a map of buyerKey → most-frequently-used salesLedger.
// buyerKey = buyer_gstin if present, else `name:<lowercased buyer_name>`.
// Use this instead of calling getHistoricalSalesLedger N times.
export async function getBatchHistoricalSalesLedgers(
  companyId: string,
): Promise<Record<string, string>> {
  const { data, error } = await db()
    .from('sales_invoices')
    .select('buyer_gstin, buyer_name, tally_ledger_acceptance, accepted_at')
    .eq('company_id', companyId)
    .not('accepted_at', 'is', null)
    .not('tally_ledger_acceptance', 'is', null);
  if (error || !data || data.length === 0) return {};

  // Group by buyer key, track frequency + recency of each salesLedger value
  const byKey: Record<string, Record<string, { count: number; latest: string }>> = {};
  for (const row of data) {
    const sl = row.tally_ledger_acceptance?.salesLedger;
    if (!sl || typeof sl !== 'string' || sl.trim().length === 0) continue;
    const key = row.buyer_gstin
      ? row.buyer_gstin
      : `name:${(row.buyer_name ?? '').toLowerCase().trim()}`;
    if (!key) continue;
    if (!byKey[key]) byKey[key] = {};
    if (!byKey[key][sl]) byKey[key][sl] = { count: 0, latest: '' };
    byKey[key][sl].count++;
    if (!byKey[key][sl].latest || row.accepted_at > byKey[key][sl].latest)
      byKey[key][sl].latest = row.accepted_at;
  }

  const result: Record<string, string> = {};
  for (const [key, freqMap] of Object.entries(byKey)) {
    const entries = Object.entries(freqMap).sort((a, b) =>
      b[1].count !== a[1].count
        ? b[1].count - a[1].count
        : b[1].latest.localeCompare(a[1].latest),
    );
    if (entries.length > 0) result[key] = entries[0][0];
  }
  return result;
}

// Returns the most frequently accepted Sales Ledger for a specific buyer in this company.
// GSTIN is the primary key; buyer_name is a read-only fallback for B2C customers.
// Never writes to any preference table — this is a read-only suggestion layer.
export async function getHistoricalSalesLedger(
  companyId: string,
  buyerGstin: string | null,
  buyerName: string | null,
): Promise<string | null> {
  if (!buyerGstin && !buyerName) return null;
  let query = db()
    .from('sales_invoices')
    .select('tally_ledger_acceptance, accepted_at')
    .eq('company_id', companyId)
    .not('accepted_at', 'is', null)
    .not('tally_ledger_acceptance', 'is', null);

  if (buyerGstin) {
    query = query.eq('buyer_gstin', buyerGstin);
  } else {
    query = query.ilike('buyer_name', buyerName!.trim());
  }

  const { data, error } = await query;
  if (error || !data || data.length === 0) return null;

  const freq: Record<string, { count: number; latest: string }> = {};
  for (const row of data) {
    const sl = row.tally_ledger_acceptance?.salesLedger;
    if (!sl) continue;
    if (!freq[sl]) freq[sl] = { count: 0, latest: '' };
    freq[sl].count++;
    if (!freq[sl].latest || row.accepted_at > freq[sl].latest) freq[sl].latest = row.accepted_at;
  }

  const entries = Object.entries(freq);
  if (entries.length === 0) return null;
  entries.sort((a, b) =>
    b[1].count !== a[1].count ? b[1].count - a[1].count : b[1].latest.localeCompare(a[1].latest),
  );
  return entries[0][0];
}
