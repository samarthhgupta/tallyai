import { getSupabase } from './supabase';

// Sales-side ledger learning. Clone of vendorLedgerPreferences.ts but scoped to
// party_type='customer' in the shared vendor_ledger_preferences table.
//
// GSTIN-only learning (same intentional architecture as the purchase side):
// preferences are durable and a wrong write poisons every future suggestion, so
// we only learn when a valid GSTIN is present. Name-based learning is disabled.

export type SalesLedgerType = 'sales' | 'CGST' | 'SGST' | 'IGST';

function isValidGstin(gstin: string | null | undefined): boolean {
  if (!gstin?.trim()) return false;
  return /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/.test(gstin.trim().toUpperCase());
}

function normaliseGstin(gstin: string): string {
  return gstin.trim().toUpperCase();
}

export async function upsertCustomerLedgerPreference(
  companyId: string,
  customerGstin: string | null | undefined,
  _customerName: string | null | undefined, // accepted for call-site compatibility but never used
  ledgerType: SalesLedgerType,
  ledgerName: string,
): Promise<void> {
  if (!isValidGstin(customerGstin) || !ledgerName.trim()) return;
  const key = normaliseGstin(customerGstin!);
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
  _customerName: string | null | undefined, // accepted for call-site compatibility but never used
): Promise<Partial<Record<SalesLedgerType, string>>> {
  if (!isValidGstin(customerGstin)) return {};
  const key = normaliseGstin(customerGstin!);
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
