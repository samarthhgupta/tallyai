// Stock Item Master - company-scoped, stored in Supabase.
// Maps invoice line item descriptions to exact Tally stock item names.
//
// KEY RULES (do not violate):
//   1. tally_item_name stored and output EXACTLY as entered - no trim, no normalisation.
//   2. alias_name is the invoice-side description used for matching - also stored as-is.
//   3. HSN code is optional - XML generation never depends on it.
//   4. Matching uses normalised comparison internally but never mutates stored values.

import { getSupabase } from './supabase';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => getSupabase() as any;

export interface StockItemMaster {
  id: string;
  company_id: string;
  tally_item_name: string; // sacred - stored and output exactly as entered
  alias_name: string | null;
  unit: string | null;
  hsn_code: string | null;
  gst_percent: number | null;  // total GST rate (e.g. 5, 12, 18); null = unknown
  created_at: string;
  updated_at: string;
}

export interface StockItemImportRow {
  tally_item_name: string;
  alias_name?: string;
  unit?: string;
  hsn_code?: string;
  gst_percent?: number | null;
}

export interface StockItemImportResult {
  inserted: number;
  updated: number;
  errors: Array<{ row: number; item: string; reason: string }>;
}

// ─── CRUD ────────────────────────────────────────────────────────────────────

export async function loadStockItems(companyId: string): Promise<StockItemMaster[]> {
  const { data, error } = await db()
    .from('stock_item_masters')
    .select('*')
    .eq('company_id', companyId)
    .order('tally_item_name');
  if (error) throw error;
  return (data ?? []) as StockItemMaster[];
}

export async function addStockItem(
  companyId: string,
  params: {
    tally_item_name: string; // stored EXACTLY as provided
    alias_name?: string;
    unit?: string;
    hsn_code?: string;
    gst_percent?: number | null;
  },
): Promise<StockItemMaster> {
  const user = (await getSupabase().auth.getUser()).data.user;
  const row = {
    company_id: companyId,
    created_by: user?.id,
    tally_item_name: params.tally_item_name, // NO trim
    alias_name: params.alias_name ?? null,
    unit: params.unit ?? null,
    hsn_code: params.hsn_code ?? null,
    gst_percent: params.gst_percent ?? null,
    updated_at: new Date().toISOString(),
  };

  const { data: inserted, error: insertErr } = await db()
    .from('stock_item_masters').insert(row).select().single();

  if (!insertErr) return inserted as StockItemMaster;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if ((insertErr as any).code !== '23505') throw insertErr;

  const { data: existing } = await db()
    .from('stock_item_masters').select('id')
    .eq('company_id', companyId).eq('tally_item_name', params.tally_item_name).single();

  if (existing?.id) {
    await db().from('stock_item_masters')
      .update({ alias_name: row.alias_name, unit: row.unit, hsn_code: row.hsn_code, gst_percent: row.gst_percent, updated_at: row.updated_at })
      .eq('id', existing.id);
  }

  const { data, error } = await db()
    .from('stock_item_masters').select()
    .eq('company_id', companyId).eq('tally_item_name', params.tally_item_name).single();
  if (error) throw error;
  return data as StockItemMaster;
}

export async function updateStockItem(
  id: string,
  params: Partial<Pick<StockItemMaster, 'tally_item_name' | 'alias_name' | 'unit' | 'hsn_code' | 'gst_percent'>>,
): Promise<void> {
  const { error } = await db()
    .from('stock_item_masters')
    .update({ ...params, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}

export async function deleteStockItem(id: string): Promise<void> {
  const { error } = await db().from('stock_item_masters').delete().eq('id', id);
  if (error) throw error;
}

// Bulk upsert from Excel import.
// tally_item_name stored EXACTLY as in Excel - no trim.
export async function bulkUpsertStockItems(
  companyId: string,
  rows: StockItemImportRow[],
): Promise<StockItemImportResult> {
  const result: StockItemImportResult = { inserted: 0, updated: 0, errors: [] };
  const seenInFile = new Set<string>();

  const existing = await loadStockItems(companyId);
  // Normalised name → record (for dedup check only - stored value never changes)
  const norm = (s: string) => s.toLowerCase().trim();
  const existingByName = new Map(existing.map((s) => [norm(s.tally_item_name), s]));

  const toInsert: object[] = [];
  const toUpdate: Array<{ id: string; payload: object }> = [];
  const user = (await getSupabase().auth.getUser()).data.user;
  const now = new Date().toISOString();

  rows.forEach((row, i) => {
    const rowNum = i + 2;
    const itemName = row.tally_item_name; // intentionally NOT trimmed

    if (!itemName || !itemName.trim()) {
      result.errors.push({ row: rowNum, item: '-', reason: 'Tally Stock Item Name is required' });
      return;
    }

    const dedupeKey = norm(itemName);
    if (seenInFile.has(dedupeKey)) {
      result.errors.push({ row: rowNum, item: itemName, reason: 'Duplicate item name in this file' });
      return;
    }
    seenInFile.add(dedupeKey);

    const payload = {
      tally_item_name: itemName, // NO trim - sacred
      alias_name: row.alias_name || null,
      unit: row.unit || null,
      hsn_code: row.hsn_code || null,
      gst_percent: row.gst_percent ?? null,
      updated_at: now,
    };

    const existingRecord = existingByName.get(dedupeKey);
    if (existingRecord) {
      toUpdate.push({ id: existingRecord.id, payload });
      result.updated++;
    } else {
      toInsert.push({ company_id: companyId, created_by: user?.id, ...payload });
      result.inserted++;
    }
  });

  if (toInsert.length) {
    const { error } = await db().from('stock_item_masters').insert(toInsert);
    if (error) throw new Error(`Insert failed: ${error.message}`);
  }
  for (const { id, payload } of toUpdate) {
    const { error } = await db().from('stock_item_masters').update(payload).eq('id', id);
    if (error) console.warn(`Update ${id} failed:`, error.message);
  }

  return result;
}

// Lookup: returns tally_item_name for a given invoice description.
// Tries exact match on alias_name first, then tally_item_name.
// Returns the sacred stored value - never modified.
export async function lookupStockItem(
  companyId: string,
  invoiceDescription: string,
): Promise<StockItemMaster | null> {
  const norm = (s: string) => s.toLowerCase().trim();
  const items = await loadStockItems(companyId);
  const q = norm(invoiceDescription);

  // 1. Exact match on alias_name
  const byAlias = items.find((s) => s.alias_name && norm(s.alias_name) === q);
  if (byAlias) return byAlias;

  // 2. Exact match on tally_item_name
  const byName = items.find((s) => norm(s.tally_item_name) === q);
  if (byName) return byName;

  // 3. Partial match on alias_name
  const partialAlias = items.find((s) => s.alias_name && (norm(s.alias_name).includes(q) || q.includes(norm(s.alias_name))));
  if (partialAlias) return partialAlias;

  return null;
}
