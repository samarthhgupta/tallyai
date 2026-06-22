import { getSupabase } from './supabase';
import { resolvePartyKey } from './partyKey';

export type LedgerType = 'purchase' | 'CGST' | 'SGST' | 'IGST' | 'CESS';

export async function upsertVendorLedgerPreference(
  companyId: string,
  vendorGstin: string | null | undefined,
  vendorName: string | null | undefined,
  ledgerType: LedgerType,
  ledgerName: string,
): Promise<void> {
  const key = resolvePartyKey(vendorGstin, vendorName);
  if (!key || !ledgerName.trim()) return;
  const sb = getSupabase();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
  vendorName: string | null | undefined,
): Promise<Partial<Record<LedgerType, string>>> {
  const key = resolvePartyKey(vendorGstin, vendorName);
  if (!key) return {};
  const sb = getSupabase();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
