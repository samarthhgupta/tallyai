// Customer Master - company-scoped, stored in Supabase.
// Clone of suppliers.ts adapted for the customer_masters table (Sales Register).
//
// KEY RULES (mirror suppliers.ts):
//   1. tally_ledger_name is stored and output EXACTLY as imported - no trim, no normalisation.
//   2. Matching/dedup uses normalised comparison internally but never mutates the stored value.
//   3. State is ALWAYS auto-derived - never entered by user.
//   4. Invalid GSTIN format is allowed - import proceeds, gstin_valid = false.
//   5. learnCustomerName() updates customer_name only - never touches tally_ledger_name.
//   6. B2C customers: customer_gstin = '' and is_b2c = true.

import { getSupabase } from './supabase';
import { deriveStateFromGstin, validateGstin, normaliseGstin } from './suppliers';

export { deriveStateFromGstin, validateGstin, normaliseGstin };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => getSupabase() as any;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CustomerMaster {
  id: string;
  company_id: string;
  tally_ledger_name: string; // sacred - stored and output exactly as imported
  customer_gstin: string;    // '' for B2C
  customer_name: string;     // auto = tally_ledger_name initially; updated by invoice learning
  trade_name: string;        // optional trade/display name
  state_name: string;        // auto-derived - never user-entered
  is_b2c: boolean;
  gstin_valid: boolean;
  created_at: string;
  updated_at: string;
}

export interface CustomerImportRow {
  tally_ledger_name: string; // raw from Excel - stored as-is
  customer_gstin: string;    // raw from Excel - normalised for lookup only
}

export interface CustomerImportResult {
  inserted: number;
  updated: number;
  errors: Array<{ row: number; identifier: string; reason: string }>;
}

export function isB2C(c: CustomerMaster): boolean {
  return c.is_b2c;
}

// ─── Supabase CRUD ───────────────────────────────────────────────────────────

export async function loadCustomers(companyId: string): Promise<CustomerMaster[]> {
  const { data, error } = await db()
    .from('customer_masters')
    .select('*')
    .eq('company_id', companyId)
    .order('tally_ledger_name');
  if (error) throw error;
  return (data ?? []) as CustomerMaster[];
}

export async function addCustomer(
  companyId: string,
  params: {
    tally_ledger_name: string; // stored exactly as provided
    customer_gstin: string;
    customer_name?: string;
    trade_name?: string;
    companyState?: string;     // used for B2C state fallback
  },
): Promise<CustomerMaster> {
  const gstin = normaliseGstin(params.customer_gstin);
  const b2c = !gstin;
  const gstinValid = gstin ? validateGstin(gstin) : true;

  const stateName = gstin
    ? (deriveStateFromGstin(gstin) ?? '')
    : (params.companyState ?? '');

  const payload = {
    company_id: companyId,
    tally_ledger_name: params.tally_ledger_name, // NO trim - stored exactly as-is
    customer_gstin: gstin,
    customer_name: params.customer_name ?? params.tally_ledger_name,
    trade_name: params.trade_name ?? '',
    state_name: stateName,
    is_b2c: b2c,
    gstin_valid: gstinValid,
    updated_at: new Date().toISOString(),
  };

  const { data: inserted, error: insertErr } = await db()
    .from('customer_masters')
    .insert(payload)
    .select()
    .single();

  if (!insertErr) return inserted as CustomerMaster;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if ((insertErr as any).code !== '23505') throw insertErr;

  const matchCol = b2c ? 'tally_ledger_name' : 'customer_gstin';
  const matchVal = b2c ? params.tally_ledger_name : gstin;
  const { data: existing } = await db()
    .from('customer_masters')
    .select('id')
    .eq('company_id', companyId)
    .eq(matchCol, matchVal)
    .single();

  if (existing?.id) {
    await db()
      .from('customer_masters')
      .update({ tally_ledger_name: params.tally_ledger_name, state_name: stateName, gstin_valid: gstinValid, updated_at: payload.updated_at })
      .eq('id', existing.id);
  }

  const { data, error } = await db()
    .from('customer_masters')
    .select()
    .eq('company_id', companyId)
    .eq(matchCol, matchVal)
    .single();
  if (error) throw error;
  return data as CustomerMaster;
}

export async function updateCustomer(
  id: string,
  params: Partial<Pick<CustomerMaster, 'customer_name' | 'customer_gstin' | 'tally_ledger_name' | 'trade_name'>>,
  companyState?: string,
): Promise<void> {
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if (params.tally_ledger_name !== undefined) {
    updates.tally_ledger_name = params.tally_ledger_name; // NO trim
  }
  if (params.customer_name !== undefined) {
    updates.customer_name = params.customer_name;
  }
  if (params.trade_name !== undefined) {
    updates.trade_name = params.trade_name;
  }
  if (params.customer_gstin !== undefined) {
    const gstin = normaliseGstin(params.customer_gstin);
    updates.customer_gstin = gstin;
    updates.is_b2c = !gstin;
    updates.gstin_valid = gstin ? validateGstin(gstin) : true;
    updates.state_name = gstin
      ? (deriveStateFromGstin(gstin) ?? '')
      : (companyState ?? '');
  }

  const { error } = await db()
    .from('customer_masters')
    .update(updates)
    .eq('id', id);
  if (error) throw error;
}

export async function deleteCustomer(id: string): Promise<void> {
  const { error } = await db().from('customer_masters').delete().eq('id', id);
  if (error) throw error;
}

// Word-overlap similarity check - prevents learnCustomerName from overwriting
// customer_name with an unrelated business name when the GSTIN is wrong.
function namesAreSimilar(a: string, b: string): boolean {
  const words = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2);
  const wa = words(a);
  const wb = words(b);
  if (!wa.length || !wb.length) return true;
  const shorter = wa.length <= wb.length ? wa : wb;
  const longer  = wa.length <= wb.length ? wb : wa;
  const hits = shorter.filter((w) => longer.some((lw) => lw.includes(w) || w.includes(lw)));
  return hits.length >= 1;
}

// Auto-learn: called when a sales invoice is accepted.
// Updates customer_name from invoice if GSTIN matches AND the invoice name is similar.
// NEVER touches tally_ledger_name.
export async function learnCustomerName(
  companyId: string,
  gstin: string,
  invoiceCustomerName: string,
): Promise<void> {
  if (!gstin || !invoiceCustomerName) return;
  const normGstin = normaliseGstin(gstin);
  if (!normGstin) return;

  const { data: existing } = await db()
    .from('customer_masters')
    .select('tally_ledger_name, customer_name')
    .eq('company_id', companyId)
    .eq('customer_gstin', normGstin)
    .single();

  if (!existing) return;

  if (!namesAreSimilar(invoiceCustomerName, existing.tally_ledger_name)) {
    console.warn(
      `learnCustomerName: skipped - invoice name "${invoiceCustomerName}" shares no words with ledger "${existing.tally_ledger_name}" (GSTIN ${normGstin}).`,
    );
    return;
  }

  const { error } = await db()
    .from('customer_masters')
    .update({ customer_name: invoiceCustomerName, updated_at: new Date().toISOString() })
    .eq('company_id', companyId)
    .eq('customer_gstin', normGstin);
  if (error) console.warn('learnCustomerName failed silently:', error.message);
}

// Bulk upsert from Excel import. tally_ledger_name stored EXACTLY as in Excel.
export async function bulkUpsertCustomers(
  companyId: string,
  rows: CustomerImportRow[],
  companyState: string,
): Promise<CustomerImportResult> {
  const result: CustomerImportResult = { inserted: 0, updated: 0, errors: [] };
  const seenInFile = new Set<string>();

  const existing = await loadCustomers(companyId);
  const existingByGstin = new Map(
    existing.filter((c) => c.customer_gstin).map((c) => [c.customer_gstin, c]),
  );
  const existingByLedger = new Map(
    existing.filter((c) => !c.customer_gstin).map((c) => [c.tally_ledger_name, c]),
  );

  const toInsert: object[] = [];
  const toUpdate: Array<{ id: string; payload: object }> = [];

  rows.forEach((row, i) => {
    const rowNum = i + 2;
    const ledger = row.tally_ledger_name; // intentionally NOT trimmed
    const gstin = normaliseGstin(row.customer_gstin);
    const b2c = !gstin;

    if (!ledger || !ledger.trim()) {
      result.errors.push({ row: rowNum, identifier: '-', reason: 'Tally Ledger Name is required' });
      return;
    }

    const dedupeKey = b2c ? `B2C__${ledger}` : gstin;
    if (seenInFile.has(dedupeKey)) {
      result.errors.push({ row: rowNum, identifier: gstin || ledger, reason: 'Duplicate entry in this file' });
      return;
    }
    seenInFile.add(dedupeKey);

    const gstinValid = gstin ? validateGstin(gstin) : true;
    const stateName = gstin
      ? (deriveStateFromGstin(gstin) ?? companyState)
      : companyState;

    const payload = {
      company_id: companyId,
      tally_ledger_name: ledger, // NO trim - sacred
      customer_gstin: gstin,
      customer_name: ledger,
      trade_name: '',
      state_name: stateName,
      is_b2c: b2c,
      gstin_valid: gstinValid,
      updated_at: new Date().toISOString(),
    };

    const existingRecord = b2c
      ? existingByLedger.get(ledger)
      : existingByGstin.get(gstin);

    if (existingRecord) {
      toUpdate.push({
        id: existingRecord.id,
        payload: {
          tally_ledger_name: ledger,
          state_name: stateName,
          gstin_valid: gstinValid,
          updated_at: new Date().toISOString(),
        },
      });
      result.updated++;
    } else {
      toInsert.push(payload);
      result.inserted++;
    }
  });

  if (toInsert.length) {
    const { error } = await db().from('customer_masters').insert(toInsert);
    if (error) throw new Error(`Insert failed: ${error.message}`);
  }
  for (const { id, payload } of toUpdate) {
    const { error } = await db().from('customer_masters').update(payload).eq('id', id);
    if (error) console.warn(`Update ${id} failed:`, error.message);
  }

  return result;
}

// Returns the Tally ledger name for a customer GSTIN within a company, or null.
export async function lookupCustomerLedger(
  companyId: string,
  gstin: string,
): Promise<string | null> {
  const normGstin = normaliseGstin(gstin);
  if (!normGstin) return null;
  const { data } = await db()
    .from('customer_masters')
    .select('tally_ledger_name')
    .eq('company_id', companyId)
    .eq('customer_gstin', normGstin)
    .single();
  return data?.tally_ledger_name ?? null;
}
