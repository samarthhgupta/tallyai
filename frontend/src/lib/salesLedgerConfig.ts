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
