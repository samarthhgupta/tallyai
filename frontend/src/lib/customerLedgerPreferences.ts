import { getSupabase } from './supabase';
import { resolvePartyKey } from './partyKey';

export type SalesLedgerType = 'sales' | 'CGST' | 'SGST' | 'IGST';

export async function upsertCustomerLedgerPreference(
  companyId: string,
  customerGstin: string | null | undefined,
  customerName: string | null | undefined,
  ledgerType: SalesLedgerType,
  ledgerName: string,
): Promise<void> {
  const key = resolvePartyKey(customerGstin, customerName);
  if (!key || !ledgerName.trim()) return;
  const sb = getSupabase();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (sb as any)
    .from('vendor_ledger_preferences')
    .upsert(
      {
        company_id: companyId,
        vendor_key: key,
        party_type: 'customer',
        ledger_type: ledgerType,
        ledger_name: ledgerName,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'company_id,vendor_key,ledger_type' },
    );
  if (error) console.warn('upsertCustomerLedgerPreference failed:', error.message);
}

export async function getCustomerLedgerPreferences(
  companyId: string,
  customerGstin: string | null | undefined,
  customerName: string | null | undefined,
): Promise<Partial<Record<SalesLedgerType, string>>> {
  const key = resolvePartyKey(customerGstin, customerName);
  if (!key) return {};
  const sb = getSupabase();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (sb as any)
    .from('vendor_ledger_preferences')
    .select('ledger_type, ledger_name')
    .eq('company_id', companyId)
    .eq('vendor_key', key)
    .eq('party_type', 'customer');
  if (error || !data) return {};
  const result: Partial<Record<SalesLedgerType, string>> = {};
  for (const row of data) {
    result[row.ledger_type as SalesLedgerType] = row.ledger_name;
  }
  return result;
}
