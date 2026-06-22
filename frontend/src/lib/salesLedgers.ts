import { getSupabase } from './supabase';
import { resolvePartyKey } from './partyKey';

// Read-only suggestion: returns the most recently learned Sales ledger for a
// customer. Looks up by GSTIN key first, then by normalised name key.
export async function getHistoricalSalesLedger(
  companyId: string,
  customerGstin: string | null | undefined,
  customerName: string | null | undefined,
): Promise<string | null> {
  const key = resolvePartyKey(customerGstin, customerName);
  if (!key) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = getSupabase() as any;
  const { data } = await sb
    .from('vendor_ledger_preferences')
    .select('ledger_name')
    .eq('company_id', companyId)
    .eq('vendor_key', key)
    .eq('party_type', 'customer')
    .eq('ledger_type', 'sales')
    .order('updated_at', { ascending: false })
    .limit(1)
    .single();
  return data?.ledger_name ?? null;
}
