// Voucher Types Master — company-scoped, stored in Supabase.
//
// PURPOSE: answers "which Tally Voucher Type should this invoice use?"
// Tally requires VOUCHERTYPENAME to be an exact, pre-existing voucher type name.
//
// MAPPING RULES (applied per invoice at XML generation time):
//   1. Invoice has GST (CGST/SGST/IGST > 0)  → 'gst' category
//   2. Invoice has no GST and is non-GST/exempt → 'non_gst' category
//   3. Catch-all fallback                       → 'default' category
//   If no matching row is configured, falls back to 'Purchase' (Tally built-in).
//
// KEY RULES:
//   1. tally_voucher_type_name stored and output EXACTLY as entered — no trim, no change.
//   2. Each purchase_category has at most one row per company (UNIQUE constraint).

import { getSupabase } from './supabase';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => getSupabase() as any;

export const PURCHASE_CATEGORIES = ['gst', 'non_gst', 'default'] as const;
export type PurchaseCategory = typeof PURCHASE_CATEGORIES[number];

export const PURCHASE_CATEGORY_LABELS: Record<PurchaseCategory, string> = {
  gst:     'GST Purchase (CGST/SGST/IGST > 0)',
  non_gst: 'Non-GST / Exempt Purchase',
  default: 'Default / Fallback (all other)',
};

export interface VoucherTypeMaster {
  id: string;
  company_id: string;
  purchase_category: PurchaseCategory;
  tally_voucher_type_name: string; // sacred — stored and output exactly as entered
  created_at: string;
  updated_at: string;
}

// ─── CRUD ────────────────────────────────────────────────────────────────────

export async function loadVoucherTypes(companyId: string): Promise<VoucherTypeMaster[]> {
  const { data, error } = await db()
    .from('voucher_type_masters')
    .select('*')
    .eq('company_id', companyId)
    .order('purchase_category');
  if (error) throw error;
  return (data ?? []) as VoucherTypeMaster[];
}

export async function upsertVoucherType(
  companyId: string,
  params: {
    purchase_category: PurchaseCategory;
    tally_voucher_type_name: string; // stored EXACTLY as provided — no trim
  },
): Promise<VoucherTypeMaster> {
  const user = (await getSupabase().auth.getUser()).data.user;
  const { data, error } = await db()
    .from('voucher_type_masters')
    .upsert(
      {
        company_id: companyId,
        created_by: user?.id,
        purchase_category: params.purchase_category,
        tally_voucher_type_name: params.tally_voucher_type_name, // NO trim
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'company_id,purchase_category' },
    )
    .select()
    .single();
  if (error) throw error;
  return data as VoucherTypeMaster;
}

export async function deleteVoucherType(id: string): Promise<void> {
  const { error } = await db().from('voucher_type_masters').delete().eq('id', id);
  if (error) throw error;
}

// ─── Resolution ───────────────────────────────────────────────────────────────
// Returns the exact Tally voucher type name for an invoice.
// Falls back to 'Purchase' if no matching row configured.

export function resolveVoucherType(
  voucherTypes: VoucherTypeMaster[],
  hasGst: boolean,
): string {
  const category: PurchaseCategory = hasGst ? 'gst' : 'non_gst';
  const specific = voucherTypes.find((v) => v.purchase_category === category);
  if (specific) return specific.tally_voucher_type_name;
  const fallback = voucherTypes.find((v) => v.purchase_category === 'default');
  return fallback?.tally_voucher_type_name ?? 'Purchase';
}
