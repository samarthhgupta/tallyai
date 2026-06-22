// Customer Master - company-scoped, stored in Supabase.
// Unique constraints: company_id + customer_gstin (B2B) | company_id + tally_ledger_name (B2C)
//
// KEY RULES (do not violate):
//   1. tally_ledger_name is stored and output EXACTLY as imported - no trim, no normalisation.
//   2. Matching/dedup uses normalised comparison internally but never mutates the stored value.
//   3. State is ALWAYS auto-derived - never entered by user.
//   4. Invalid GSTIN format is allowed - import proceeds, gstin_valid = false.
//   5. learnCustomerName() updates customer_name only - never touches tally_ledger_name.

import { getSupabase } from './supabase';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => getSupabase() as any;

const STATE_CODES: Record<string, string> = {
  '01': 'Jammu & Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab',
  '04': 'Chandigarh', '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi',
  '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim',
  '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram',
  '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal',
  '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh',
  '24': 'Gujarat', '26': 'Dadra & Nagar Haveli and Daman & Diu', '27': 'Maharashtra',
  '28': 'Andhra Pradesh', '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep',
  '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry', '35': 'Andaman & Nicobar Islands',
  '36': 'Telangana', '37': 'Andhra Pradesh (New)', '38': 'Ladakh',
  '97': 'Other Territory', '99': 'Centre Jurisdiction',
};

export function deriveStateFromCustomerGstin(gstin: string): string | null {
  const code = gstin.trim().substring(0, 2);
  return STATE_CODES[code] ?? null;
}

const UNREGISTERED_MARKERS = new Set([
  'UNREGISTERED', 'URD', 'N/A', 'NA', 'NIL', 'NOT APPLICABLE', 'NOT REGISTERED', '-', '',
]);

const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

export function validateCustomerGstin(gstin: string): boolean {
  return GSTIN_REGEX.test(gstin.trim().toUpperCase());
}

export function normaliseCustomerGstin(raw: string): string {
  const up = (raw ?? '').trim().toUpperCase();
  return UNREGISTERED_MARKERS.has(up) ? '' : up;
}

export interface CustomerMaster {
  id: string;
  company_id: string;
  tally_ledger_name: string; // sacred
  customer_gstin: string;    // '' for B2C
  customer_name: string;
  trade_name: string | null;
  state_name: string;
  is_b2c: boolean;
  gstin_valid: boolean;
  created_at: string;
  updated_at: string;
}

export interface CustomerImportRow {
  tally_ledger_name: string;
  customer_gstin: string;
}

export interface CustomerImportResult {
  inserted: number;
  updated: number;
  errors: Array<{ row: number; identifier: string; reason: string }>;
}

// Aliases for backward compatibility with generated page imports
export const validateGstin = validateCustomerGstin;
export const normaliseGstin = normaliseCustomerGstin;
export const deriveStateFromGstin = deriveStateFromCustomerGstin;

export function isB2C(c: CustomerMaster): boolean {
  return c.is_b2c;
}

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
    tally_ledger_name: string;
    customer_gstin: string;
    customer_name?: string;
    companyState?: string;
  },
): Promise<CustomerMaster> {
  const gstin = normaliseCustomerGstin(params.customer_gstin);
  const b2c = !gstin;
  const gstinValid = gstin ? validateCustomerGstin(gstin) : true;
  const stateName = gstin
    ? (deriveStateFromCustomerGstin(gstin) ?? '')
    : (params.companyState ?? '');

  const payload = {
    company_id: companyId,
    tally_ledger_name: params.tally_ledger_name,
    customer_gstin: gstin,
    customer_name: params.customer_name ?? params.tally_ledger_name,
    trade_name: null,
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
  params: Partial<Pick<CustomerMaster, 'customer_name' | 'customer_gstin' | 'tally_ledger_name'>>,
  companyState?: string,
): Promise<void> {
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (params.tally_ledger_name !== undefined) updates.tally_ledger_name = params.tally_ledger_name;
  if (params.customer_name !== undefined) updates.customer_name = params.customer_name;
  if (params.customer_gstin !== undefined) {
    const gstin = normaliseCustomerGstin(params.customer_gstin);
    updates.customer_gstin = gstin;
    updates.is_b2c = !gstin;
    updates.gstin_valid = gstin ? validateCustomerGstin(gstin) : true;
    updates.state_name = gstin ? (deriveStateFromCustomerGstin(gstin) ?? '') : (companyState ?? '');
  }
  const { error } = await db().from('customer_masters').update(updates).eq('id', id);
  if (error) throw error;
}

export async function deleteCustomer(id: string): Promise<void> {
  const { error } = await db().from('customer_masters').delete().eq('id', id);
  if (error) throw error;
}

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

export async function learnCustomerName(
  companyId: string,
  gstin: string,
  invoiceCustomerName: string,
): Promise<void> {
  if (!gstin || !invoiceCustomerName) return;
  const normGstin = normaliseCustomerGstin(gstin);
  if (!normGstin) return;

  const { data: existing } = await db()
    .from('customer_masters')
    .select('tally_ledger_name, customer_name')
    .eq('company_id', companyId)
    .eq('customer_gstin', normGstin)
    .single();

  if (!existing) return;
  if (!namesAreSimilar(invoiceCustomerName, existing.tally_ledger_name)) {
    console.warn(`learnCustomerName: skipped - invoice name "${invoiceCustomerName}" shares no words with ledger "${existing.tally_ledger_name}" (GSTIN ${normGstin}).`);
    return;
  }

  const { error } = await db()
    .from('customer_masters')
    .update({ customer_name: invoiceCustomerName, updated_at: new Date().toISOString() })
    .eq('company_id', companyId)
    .eq('customer_gstin', normGstin);
  if (error) console.warn('learnCustomerName failed silently:', error.message);
}

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
    const ledger = row.tally_ledger_name;
    const gstin = normaliseCustomerGstin(row.customer_gstin);
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

    const gstinValid = gstin ? validateCustomerGstin(gstin) : true;
    const stateName = gstin ? (deriveStateFromCustomerGstin(gstin) ?? companyState) : companyState;

    const payload = {
      company_id: companyId,
      tally_ledger_name: ledger,
      customer_gstin: gstin,
      customer_name: ledger,
      trade_name: null,
      state_name: stateName,
      is_b2c: b2c,
      gstin_valid: gstinValid,
      updated_at: new Date().toISOString(),
    };

    const existingRecord = b2c ? existingByLedger.get(ledger) : existingByGstin.get(gstin);

    if (existingRecord) {
      toUpdate.push({
        id: existingRecord.id,
        payload: { tally_ledger_name: ledger, state_name: stateName, gstin_valid: gstinValid, updated_at: new Date().toISOString() },
      });
      result.updated++;
    } else {
      toInsert.push(payload);
      result.inserted++;
    }
  });

  if (toInsert.length) {
    // B2B rows: conflict on (company_id, customer_gstin)
    const b2bRows = toInsert.filter((r: any) => (r as any).customer_gstin);
    if (b2bRows.length) {
      const { error } = await db()
        .from('customer_masters')
        .upsert(b2bRows, { onConflict: 'company_id,customer_gstin' });
      if (error) throw new Error(`Insert failed: ${error.message}`);
    }
    // B2C rows (no GSTIN): conflict on (company_id, tally_ledger_name)
    const b2cRows = toInsert.filter((r: any) => !(r as any).customer_gstin);
    if (b2cRows.length) {
      const { error } = await db()
        .from('customer_masters')
        .upsert(b2cRows, { onConflict: 'company_id,tally_ledger_name' });
      if (error) throw new Error(`Insert failed: ${error.message}`);
    }
  }
  for (const { id, payload } of toUpdate) {
    const { error } = await db().from('customer_masters').update(payload).eq('id', id);
    if (error) console.warn(`Update ${id} failed:`, error.message);
  }

  return result;
}

export async function lookupCustomerLedger(
  companyId: string,
  gstin: string,
): Promise<string | null> {
  const normGstin = normaliseCustomerGstin(gstin);
  if (!normGstin) return null;

  // 1. Search customer_masters first (primary for sales flow)
  const { data: custData } = await db()
    .from('customer_masters')
    .select('tally_ledger_name')
    .eq('company_id', companyId)
    .eq('customer_gstin', normGstin)
    .single();
  if (custData?.tally_ledger_name) return custData.tally_ledger_name;

  // 2. Cross-search supplier_masters (same party may appear on purchase side)
  const { data: suppData } = await db()
    .from('supplier_masters')
    .select('tally_ledger_name')
    .eq('company_id', companyId)
    .eq('vendor_gstin', normGstin)
    .single();
  return suppData?.tally_ledger_name ?? null;
}
