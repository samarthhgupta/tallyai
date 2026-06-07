// Supplier Master — company-scoped, stored in Supabase.
// Unique constraints: company_id + vendor_gstin (registered) | company_id + tally_ledger_name (unregistered)
//
// KEY RULES (do not violate):
//   1. tally_ledger_name is stored and output EXACTLY as imported — no trim, no normalisation.
//   2. Matching/dedup uses normalised comparison internally but never mutates the stored value.
//   3. State is ALWAYS auto-derived — never entered by user.
//   4. Invalid GSTIN format is allowed — import proceeds, gstin_valid = false.
//   5. learnVendorName() updates vendor_name only — never touches tally_ledger_name.

import { getSupabase } from './supabase';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => getSupabase() as any;

// ─── GSTIN state code map ────────────────────────────────────────────────────
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

export function deriveStateFromGstin(gstin: string): string | null {
  const code = gstin.trim().substring(0, 2);
  return STATE_CODES[code] ?? null;
}

// Tally exports these values for unregistered parties — normalise all to ''
const UNREGISTERED_MARKERS = new Set([
  'UNREGISTERED', 'URD', 'N/A', 'NA', 'NIL', 'NOT APPLICABLE', 'NOT REGISTERED', '-', '—', '',
]);

const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

export function validateGstin(gstin: string): boolean {
  return GSTIN_REGEX.test(gstin.trim().toUpperCase());
}

export function normaliseGstin(raw: string): string {
  const up = (raw ?? '').trim().toUpperCase();
  return UNREGISTERED_MARKERS.has(up) ? '' : up;
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SupplierMaster {
  id: string;
  company_id: string;
  tally_ledger_name: string; // sacred — stored and output exactly as imported
  vendor_gstin: string;      // '' for unregistered
  vendor_name: string;       // auto = tally_ledger_name initially; updated by invoice learning
  state_name: string;        // auto-derived — never user-entered
  is_unregistered: boolean;
  gstin_valid: boolean;
  created_at: string;
  updated_at: string;
}

export interface ImportRow {
  tally_ledger_name: string; // raw from Excel — stored as-is
  vendor_gstin: string;      // raw from Excel — normalised for lookup only
}

export interface ImportResult {
  inserted: number;
  updated: number;
  errors: Array<{ row: number; identifier: string; reason: string }>;
}

export function isUnregistered(s: SupplierMaster): boolean {
  return s.is_unregistered;
}

// ─── Supabase CRUD ───────────────────────────────────────────────────────────

export async function loadSuppliers(companyId: string): Promise<SupplierMaster[]> {
  const { data, error } = await db()
    .from('supplier_masters')
    .select('*')
    .eq('company_id', companyId)
    .order('tally_ledger_name');
  if (error) throw error;
  return (data ?? []) as SupplierMaster[];
}

export async function addSupplier(
  companyId: string,
  params: {
    tally_ledger_name: string; // stored exactly as provided
    vendor_gstin: string;
    vendor_name?: string;
    companyState?: string;     // used for unregistered state fallback
  },
): Promise<SupplierMaster> {
  const gstin = normaliseGstin(params.vendor_gstin);
  const unregistered = !gstin;
  const gstinValid = gstin ? validateGstin(gstin) : true;

  const stateName = gstin
    ? (deriveStateFromGstin(gstin) ?? '')
    : (params.companyState ?? '');

  const payload = {
    company_id: companyId,
    tally_ledger_name: params.tally_ledger_name, // NO trim — stored exactly as-is
    vendor_gstin: gstin,
    vendor_name: params.vendor_name ?? params.tally_ledger_name,
    state_name: stateName,
    is_unregistered: unregistered,
    gstin_valid: gstinValid,
    updated_at: new Date().toISOString(),
  };

  // Try insert first; if duplicate (23505), find existing and update tally_ledger_name
  const { data: inserted, error: insertErr } = await db()
    .from('supplier_masters')
    .insert(payload)
    .select()
    .single();

  if (!insertErr) return inserted as SupplierMaster;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if ((insertErr as any).code !== '23505') throw insertErr;

  // Duplicate — find existing row and update
  const matchCol = unregistered ? 'tally_ledger_name' : 'vendor_gstin';
  const matchVal = unregistered ? params.tally_ledger_name : gstin;
  const { data: existing } = await db()
    .from('supplier_masters')
    .select('id')
    .eq('company_id', companyId)
    .eq(matchCol, matchVal)
    .single();

  if (existing?.id) {
    await db()
      .from('supplier_masters')
      .update({ tally_ledger_name: params.tally_ledger_name, state_name: stateName, gstin_valid: gstinValid, updated_at: payload.updated_at })
      .eq('id', existing.id);
  }

  const { data, error } = await db()
    .from('supplier_masters')
    .select()
    .eq('company_id', companyId)
    .eq(matchCol, matchVal)
    .single();
  if (error) throw error;
  return data as SupplierMaster;
}

export async function updateSupplier(
  id: string,
  params: Partial<Pick<SupplierMaster, 'vendor_name' | 'vendor_gstin' | 'tally_ledger_name'>>,
  companyState?: string,
): Promise<void> {
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if (params.tally_ledger_name !== undefined) {
    updates.tally_ledger_name = params.tally_ledger_name; // NO trim
  }
  if (params.vendor_name !== undefined) {
    updates.vendor_name = params.vendor_name;
  }
  if (params.vendor_gstin !== undefined) {
    const gstin = normaliseGstin(params.vendor_gstin);
    updates.vendor_gstin = gstin;
    updates.is_unregistered = !gstin;
    updates.gstin_valid = gstin ? validateGstin(gstin) : true;
    updates.state_name = gstin
      ? (deriveStateFromGstin(gstin) ?? '')
      : (companyState ?? '');
  }

  const { error } = await db()
    .from('supplier_masters')
    .update(updates)
    .eq('id', id);
  if (error) throw error;
}

export async function deleteSupplier(id: string): Promise<void> {
  const { error } = await db().from('supplier_masters').delete().eq('id', id);
  if (error) throw error;
}

// Auto-learn: called when invoice is accepted.
// Updates vendor_name from invoice if GSTIN matches.
// NEVER touches tally_ledger_name.
export async function learnVendorName(
  companyId: string,
  gstin: string,
  invoiceVendorName: string,
): Promise<void> {
  if (!gstin || !invoiceVendorName) return;
  const normGstin = normaliseGstin(gstin);
  if (!normGstin) return;

  const { error } = await db()
    .from('supplier_masters')
    .update({ vendor_name: invoiceVendorName, updated_at: new Date().toISOString() })
    .eq('company_id', companyId)
    .eq('vendor_gstin', normGstin);
  if (error) console.warn('learnVendorName failed silently:', error.message);
}

// Bulk upsert from Excel import.
// tally_ledger_name stored EXACTLY as in Excel — no trim.
// State derived automatically — no state column in import.
export async function bulkUpsertSuppliers(
  companyId: string,
  rows: ImportRow[],
  companyState: string,
): Promise<ImportResult> {
  const result: ImportResult = { inserted: 0, updated: 0, errors: [] };
  const seenInFile = new Set<string>();

  // Fetch existing records once for comparison
  const existing = await loadSuppliers(companyId);
  const existingByGstin = new Map(
    existing.filter((s) => s.vendor_gstin).map((s) => [s.vendor_gstin, s]),
  );
  const existingByLedger = new Map(
    existing.filter((s) => !s.vendor_gstin).map((s) => [s.tally_ledger_name, s]),
  );

  const toInsert: object[] = [];
  const toUpdate: Array<{ id: string; payload: object }> = [];

  rows.forEach((row, i) => {
    const rowNum = i + 2;
    const ledger = row.tally_ledger_name; // intentionally NOT trimmed
    const gstin = normaliseGstin(row.vendor_gstin);
    const unregistered = !gstin;

    if (!ledger || !ledger.trim()) {
      result.errors.push({ row: rowNum, identifier: '—', reason: 'Tally Ledger Name is required' });
      return;
    }

    const dedupeKey = unregistered ? `UNREG__${ledger}` : gstin;
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
      tally_ledger_name: ledger, // NO trim — sacred
      vendor_gstin: gstin,
      vendor_name: ledger,       // default = tally_ledger_name; overwritten by learning later
      state_name: stateName,
      is_unregistered: unregistered,
      gstin_valid: gstinValid,
      updated_at: new Date().toISOString(),
    };

    const existingRecord = unregistered
      ? existingByLedger.get(ledger)
      : existingByGstin.get(gstin);

    if (existingRecord) {
      // Update tally_ledger_name + state. Preserve vendor_name if already learned.
      toUpdate.push({
        id: existingRecord.id,
        payload: {
          tally_ledger_name: ledger, // NO trim
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

  // Execute in batches
  if (toInsert.length) {
    const { error } = await db().from('supplier_masters').insert(toInsert);
    if (error) throw new Error(`Insert failed: ${error.message}`);
  }
  for (const { id, payload } of toUpdate) {
    const { error } = await db().from('supplier_masters').update(payload).eq('id', id);
    if (error) console.warn(`Update ${id} failed:`, error.message);
  }

  return result;
}

// Returns the Tally ledger name for a GSTIN within a company, or null.
// Uses normalised GSTIN for lookup but returns the sacred stored value.
export async function lookupSupplierLedger(
  companyId: string,
  gstin: string,
): Promise<string | null> {
  const normGstin = normaliseGstin(gstin);
  if (!normGstin) return null;
  const { data } = await db()
    .from('supplier_masters')
    .select('tally_ledger_name')
    .eq('company_id', companyId)
    .eq('vendor_gstin', normGstin)
    .single();
  return data?.tally_ledger_name ?? null;
}
