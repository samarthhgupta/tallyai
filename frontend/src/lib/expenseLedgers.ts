// Expense Ledger Master - company-scoped, stored in Supabase.
// Maps expense descriptions on invoices to exact Tally expense ledger names.
//
// KEY RULES (do not violate):
//   1. tally_ledger_name stored and output EXACTLY as entered - no trim, no normalisation.
//   2. expense_keyword is the invoice-side term used for matching - also stored as-is.
//   3. SAC code is optional - XML generation never depends on it.
//   4. No GST rate logic stored here - only maps description to ledger.

import { getSupabase } from './supabase';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => getSupabase() as any;

export interface ExpenseLedgerMaster {
  id: string;
  company_id: string;
  tally_ledger_name: string;  // sacred - stored and output exactly as entered
  expense_keyword: string | null;
  sac_code: string | null;
  gst_percent: number | null;  // total GST rate (e.g. 18); null = omit GSTDETAILS.LIST
  created_at: string;
  updated_at: string;
}

export interface ExpenseLedgerImportRow {
  tally_ledger_name: string;
  expense_keyword?: string;
  sac_code?: string;
  gst_percent?: number | null;
}

export interface ExpenseLedgerImportResult {
  inserted: number;
  updated: number;
  errors: Array<{ row: number; ledger: string; reason: string }>;
}

// Built-in defaults for common expense types - used to auto-fill SAC + GST %
// when no extracted data is available (fallback lookup).
export const EXPENSE_DEFAULTS: Record<string, { sac_code: string; gst_percent: number }> = {
  'freight':           { sac_code: '996511', gst_percent: 5  },
  'freight charges':   { sac_code: '996511', gst_percent: 5  },
  'freight & forwarding': { sac_code: '996511', gst_percent: 5 },
  'freight forwarding': { sac_code: '996511', gst_percent: 5 },
  'delivery charges':  { sac_code: '996511', gst_percent: 5  },
  'transport':         { sac_code: '996511', gst_percent: 5  },
  'transportation':    { sac_code: '996511', gst_percent: 5  },
  'transportation charges': { sac_code: '996511', gst_percent: 5 },
  'courier':           { sac_code: '996812', gst_percent: 18 },
  'courier charges':   { sac_code: '996812', gst_percent: 18 },
  'postage':           { sac_code: '996811', gst_percent: 18 },
  'postage & telegram': { sac_code: '996811', gst_percent: 18 },
  'packing':           { sac_code: '998540', gst_percent: 18 },
  'packing charges':   { sac_code: '998540', gst_percent: 18 },
  'packaging charges': { sac_code: '998540', gst_percent: 18 },
  'loading':           { sac_code: '996719', gst_percent: 18 },
  'unloading':         { sac_code: '996719', gst_percent: 18 },
  'loading charges':   { sac_code: '996719', gst_percent: 18 },
  'loading & unloading': { sac_code: '996719', gst_percent: 18 },
  'handling charges':  { sac_code: '996719', gst_percent: 18 },
  'insurance':         { sac_code: '997135', gst_percent: 18 },
  'insurance charges': { sac_code: '997135', gst_percent: 18 },
  'labour':            { sac_code: '998519', gst_percent: 18 },
  'labour charges':    { sac_code: '998519', gst_percent: 18 },
  'accounting charges': { sac_code: '998211', gst_percent: 18 },
  'round off':         { sac_code: '',        gst_percent: 0  },
  'rounding off':      { sac_code: '',        gst_percent: 0  },
};

export function getExpenseDefaults(description: string | null | undefined): { sac_code: string; gst_percent: number } | null {
  if (!description) return null;
  const key = description.toLowerCase().trim();
  // 1. Exact match
  if (EXPENSE_DEFAULTS[key]) return EXPENSE_DEFAULTS[key];
  // 2. Key is a substring of description (e.g. "freight & forwarding" within "freight & forwarding charges")
  for (const k of Object.keys(EXPENSE_DEFAULTS)) {
    if (key.includes(k)) return EXPENSE_DEFAULTS[k];
  }
  // 3. Description is a substring of a key
  for (const k of Object.keys(EXPENSE_DEFAULTS)) {
    if (k.includes(key)) return EXPENSE_DEFAULTS[k];
  }
  return null;
}

// Resolve the best SAC code for a charge: use stored value first, then fall back to defaults.
export function resolveChargeSac(description: string | null | undefined, storedSac?: string | null): string | undefined {
  if (storedSac && storedSac.trim()) return storedSac.trim();
  if (!description) return undefined;
  const d = getExpenseDefaults(description);
  return d?.sac_code || undefined;
}

// Common expense types shown as quick-add suggestions in the UI
export const COMMON_EXPENSES = [
  'Freight Charges', 'Courier Charges', 'Packing Charges',
  'Loading Charges', 'Unloading Charges', 'Insurance Charges',
  'Labour Charges', 'Handling Charges', 'Transportation Charges',
  'Postage & Telegram',
];

// ─── CRUD ────────────────────────────────────────────────────────────────────

export async function loadExpenseLedgers(companyId: string): Promise<ExpenseLedgerMaster[]> {
  const { data, error } = await db()
    .from('expense_ledger_masters')
    .select('*')
    .eq('company_id', companyId)
    .order('tally_ledger_name');
  if (error) throw error;
  return (data ?? []) as ExpenseLedgerMaster[];
}

export async function addExpenseLedger(
  companyId: string,
  params: {
    tally_ledger_name: string; // stored EXACTLY as provided - no trim
    expense_keyword?: string;
    sac_code?: string;
    gst_percent?: number | null;
  },
): Promise<ExpenseLedgerMaster> {
  const user = (await getSupabase().auth.getUser()).data.user;
  const row = {
    company_id: companyId,
    created_by: user?.id,
    tally_ledger_name: params.tally_ledger_name, // NO trim
    expense_keyword: params.expense_keyword ?? null,
    sac_code: params.sac_code ?? null,
    gst_percent: params.gst_percent ?? null,
    updated_at: new Date().toISOString(),
  };

  const { data: inserted, error: insertErr } = await db()
    .from('expense_ledger_masters').insert(row).select().single();

  if (!insertErr) return inserted as ExpenseLedgerMaster;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if ((insertErr as any).code !== '23505') throw insertErr;

  const { data: existing } = await db()
    .from('expense_ledger_masters').select('id')
    .eq('company_id', companyId).eq('tally_ledger_name', params.tally_ledger_name).single();

  if (existing?.id) {
    await db().from('expense_ledger_masters')
      .update({ expense_keyword: row.expense_keyword, sac_code: row.sac_code, gst_percent: row.gst_percent, updated_at: row.updated_at })
      .eq('id', existing.id);
  }

  const { data, error } = await db()
    .from('expense_ledger_masters').select()
    .eq('company_id', companyId).eq('tally_ledger_name', params.tally_ledger_name).single();
  if (error) throw error;
  return data as ExpenseLedgerMaster;
}

export async function updateExpenseLedger(
  id: string,
  params: Partial<Pick<ExpenseLedgerMaster, 'tally_ledger_name' | 'expense_keyword' | 'sac_code' | 'gst_percent'>>,
): Promise<void> {
  const { error } = await db()
    .from('expense_ledger_masters')
    .update({ ...params, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}

export async function deleteExpenseLedger(id: string): Promise<void> {
  const { error } = await db().from('expense_ledger_masters').delete().eq('id', id);
  if (error) throw error;
}

// Bulk upsert from Excel import.
// tally_ledger_name stored EXACTLY as in Excel - no trim.
export async function bulkUpsertExpenseLedgers(
  companyId: string,
  rows: ExpenseLedgerImportRow[],
): Promise<ExpenseLedgerImportResult> {
  const result: ExpenseLedgerImportResult = { inserted: 0, updated: 0, errors: [] };
  const seenInFile = new Set<string>();

  const existing = await loadExpenseLedgers(companyId);
  const norm = (s: string) => s.toLowerCase().trim();
  const existingByName = new Map(existing.map((e) => [norm(e.tally_ledger_name), e]));

  const toInsert: object[] = [];
  const toUpdate: Array<{ id: string; payload: object }> = [];
  const user = (await getSupabase().auth.getUser()).data.user;
  const now = new Date().toISOString();

  rows.forEach((row, i) => {
    const rowNum = i + 2;
    const ledger = row.tally_ledger_name; // intentionally NOT trimmed

    if (!ledger || !ledger.trim()) {
      result.errors.push({ row: rowNum, ledger: '-', reason: 'Tally Ledger Name is required' });
      return;
    }

    const dedupeKey = norm(ledger);
    if (seenInFile.has(dedupeKey)) {
      result.errors.push({ row: rowNum, ledger, reason: 'Duplicate ledger name in this file' });
      return;
    }
    seenInFile.add(dedupeKey);

    const payload = {
      tally_ledger_name: ledger, // NO trim - sacred
      expense_keyword: row.expense_keyword || null,
      sac_code: row.sac_code || null,
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
    const { error } = await db().from('expense_ledger_masters').insert(toInsert);
    if (error) throw new Error(`Insert failed: ${error.message}`);
  }
  for (const { id, payload } of toUpdate) {
    const { error } = await db().from('expense_ledger_masters').update(payload).eq('id', id);
    if (error) console.warn(`Update ${id} failed:`, error.message);
  }

  return result;
}

// Lookup: returns the expense ledger for a given invoice description.
// Tries keyword match first, then tally_ledger_name match.
// Returns the sacred stored value - never modified.
export async function lookupExpenseLedger(
  companyId: string,
  invoiceDescription: string,
): Promise<ExpenseLedgerMaster | null> {
  const norm = (s: string) => s.toLowerCase().trim();
  const ledgers = await loadExpenseLedgers(companyId);
  const q = norm(invoiceDescription);

  // 1. Exact keyword match
  const byKeyword = ledgers.find(
    (l) => l.expense_keyword && norm(l.expense_keyword) === q,
  );
  if (byKeyword) return byKeyword;

  // 2. Partial keyword match (description contains keyword or keyword contains description)
  const partialKeyword = ledgers.find(
    (l) => l.expense_keyword && (q.includes(norm(l.expense_keyword)) || norm(l.expense_keyword).includes(q)),
  );
  if (partialKeyword) return partialKeyword;

  // 3. Exact tally_ledger_name match
  const byName = ledgers.find((l) => norm(l.tally_ledger_name) === q);
  if (byName) return byName;

  return null;
}
