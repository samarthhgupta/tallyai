import { getSupabase } from './supabase';

// Read-only suggestion: returns the most recently learned Sales ledger for a
// customer (party_type='customer', ledger_type='sales'). GSTIN-keyed only.
export async function getHistoricalSalesLedger(
  companyId: string,
  customerGstin: string | null | undefined,
  customerName: string | null | undefined,
): Promise<string | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = getSupabase() as any;
  if (customerGstin?.trim()) {
    const { data } = await sb
      .from('vendor_ledger_preferences')
      .select('ledger_name')
      .eq('company_id', companyId)
      .eq('vendor_key', customerGstin.trim().toUpperCase())
      .eq('party_type', 'customer')
      .eq('ledger_type', 'sales')
      .order('updated_at', { ascending: false })
      .limit(1)
      .single();
    if (data?.ledger_name) return data.ledger_name;
  }
  void customerName;
  return null;
}
