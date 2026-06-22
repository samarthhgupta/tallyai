import { getSupabase } from './supabase';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => getSupabase() as any;

export interface FixedAssetMaster {
  id: string;
  company_id: string;
  tally_ledger_name: string;
  asset_group: string;
  hsn_code: string | null;
  gst_percent: number | null;
  gst_applicable: boolean;
  type_of_supply: 'Goods' | 'Services' | 'Not Applicable';
  state_name: string | null;
  created_at: string;
  updated_at: string;
}

export type FixedAssetInsert = Omit<FixedAssetMaster, 'id' | 'created_at' | 'updated_at'>;

export async function loadFixedAssets(companyId: string): Promise<FixedAssetMaster[]> {
  const { data, error } = await db()
    .from('fixed_asset_masters')
    .select('*')
    .eq('company_id', companyId)
    .order('tally_ledger_name');
  if (error) throw error;
  return data ?? [];
}

export async function upsertFixedAssets(rows: FixedAssetInsert[]): Promise<void> {
  if (!rows.length) return;
  const { error } = await db()
    .from('fixed_asset_masters')
    .upsert(rows, { onConflict: 'company_id,tally_ledger_name' });
  if (error) throw error;
}

export async function deleteFixedAsset(companyId: string, tallyLedgerName: string): Promise<void> {
  const { error } = await db()
    .from('fixed_asset_masters')
    .delete()
    .eq('company_id', companyId)
    .eq('tally_ledger_name', tallyLedgerName);
  if (error) throw error;
}

export async function updateFixedAsset(
  companyId: string,
  tallyLedgerName: string,
  updates: Partial<Pick<FixedAssetMaster, 'asset_group' | 'hsn_code' | 'gst_percent' | 'gst_applicable' | 'type_of_supply' | 'state_name'>>,
): Promise<void> {
  const { error } = await db()
    .from('fixed_asset_masters')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('company_id', companyId)
    .eq('tally_ledger_name', tallyLedgerName);
  if (error) throw error;
}
