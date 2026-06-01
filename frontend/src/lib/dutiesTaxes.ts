// Duties & Taxes Master — company-scoped, stored in Supabase.
//
// PURPOSE: answers "which Tally ledger receives this tax amount?"
// It does NOT calculate tax. It does NOT depend on HSN/SAC.
// The invoice extraction engine already extracts CGST/SGST/IGST/CESS amounts.
// This master only maps those extracted amounts to the correct Tally ledger.
//
// KEY RULES (do not violate):
//   1. tally_ledger_name stored and output EXACTLY as entered — no trim, no change.
//   2. Lookup is rate-specific first; falls back to consolidated (null rate) if no match.
//   3. Multiple rows per component are allowed (CGST@9%, CGST@2.5%, CGST consolidated).

import { getSupabase } from './supabase';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => getSupabase() as any;

export const TAX_COMPONENTS = [
  'CGST', 'SGST', 'IGST', 'CESS', 'TDS', 'TCS', 'GST TDS', 'GST TCS',
] as const;

export type TaxComponent = typeof TAX_COMPONENTS[number];

export interface DutiesTaxesMaster {
  id: string;
  company_id: string;
  tax_component: TaxComponent;
  tax_rate: number | null;     // null = consolidated (no rate distinction)
  tally_ledger_name: string;   // sacred — stored and output exactly as entered
  created_at: string;
  updated_at: string;
}

// ─── CRUD ────────────────────────────────────────────────────────────────────

export async function loadDutiesTaxes(companyId: string): Promise<DutiesTaxesMaster[]> {
  const { data, error } = await db()
    .from('duties_taxes_masters')
    .select('*')
    .eq('company_id', companyId)
    .order('tax_component')
    .order('tax_rate', { nullsFirst: false });
  if (error) throw error;
  return (data ?? []) as DutiesTaxesMaster[];
}

export async function addDutiesTaxes(
  companyId: string,
  params: {
    tax_component: TaxComponent;
    tax_rate: number | null;
    tally_ledger_name: string; // stored EXACTLY as provided — no trim
  },
): Promise<DutiesTaxesMaster> {
  const user = (await getSupabase().auth.getUser()).data.user;
  const { data, error } = await db()
    .from('duties_taxes_masters')
    .insert({
      company_id: companyId,
      created_by: user?.id,
      tax_component: params.tax_component,
      tax_rate: params.tax_rate,
      tally_ledger_name: params.tally_ledger_name, // NO trim
      updated_at: new Date().toISOString(),
    })
    .select()
    .single();
  if (error) throw error;
  return data as DutiesTaxesMaster;
}

export async function updateDutiesTaxes(
  id: string,
  params: Partial<Pick<DutiesTaxesMaster, 'tax_component' | 'tax_rate' | 'tally_ledger_name'>>,
): Promise<void> {
  const { error } = await db()
    .from('duties_taxes_masters')
    .update({ ...params, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}

export async function deleteDutiesTaxes(id: string): Promise<void> {
  const { error } = await db().from('duties_taxes_masters').delete().eq('id', id);
  if (error) throw error;
}

// ─── Lookup ───────────────────────────────────────────────────────────────────
// Returns the exact Tally ledger name for a given tax component and rate.
// Priority: rate-specific match → consolidated (null rate) fallback → null.
// The returned value is used verbatim in XML — never modified.

export async function lookupTaxLedger(
  companyId: string,
  component: TaxComponent,
  rate?: number | null,
): Promise<string | null> {
  const records = await loadDutiesTaxes(companyId);

  // 1. Rate-specific match
  if (rate != null) {
    const specific = records.find(
      (r) => r.tax_component === component && r.tax_rate === rate,
    );
    if (specific) return specific.tally_ledger_name;
  }

  // 2. Consolidated fallback (null rate)
  const consolidated = records.find(
    (r) => r.tax_component === component && r.tax_rate == null,
  );
  return consolidated?.tally_ledger_name ?? null;
}
