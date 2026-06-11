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
