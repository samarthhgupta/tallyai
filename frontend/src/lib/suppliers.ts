// Company-wise Supplier Master — maps vendor GSTIN to Tally party ledger name.
// Stored in localStorage. Keyed by companyId.
// Unique constraint: company_id + vendor_gstin (enforced in upsertSupplier).

const KEY = 'tallyai_suppliers';

// GSTIN format: 2-digit state code + 10-char PAN + 1-digit entity + Z + 1 checksum
const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

export interface SupplierMaster {
  id: string;
  company_id: string;
  vendor_name: string;        // actual name from invoice (auto-learned)
  vendor_gstin: string;       // 15-char GSTIN — unique key within company
  tally_ledger_name: string;  // exact ledger name in Tally (never auto-updated)
  state_name: string;         // supplier's state
  created_at: string;
  updated_at: string;
}

export interface ImportRow {
  tally_ledger_name: string;
  vendor_gstin: string;
  state_name: string;
}

export interface ImportResult {
  inserted: number;
  updated: number;
  errors: Array<{ row: number; gstin: string; reason: string }>;
}

export function validateGstin(gstin: string): boolean {
  return GSTIN_REGEX.test(gstin.trim().toUpperCase());
}

function loadAll(): SupplierMaster[] {
  if (typeof window === 'undefined') return [];
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]');
  } catch {
    return [];
  }
}

function saveAll(list: SupplierMaster[]): void {
  localStorage.setItem(KEY, JSON.stringify(list));
}

export function loadSuppliers(companyId: string): SupplierMaster[] {
  return loadAll().filter((s) => s.company_id === companyId);
}

export function addSupplier(
  companyId: string,
  params: { vendor_name: string; vendor_gstin: string; tally_ledger_name: string; state_name: string },
): SupplierMaster {
  const all = loadAll();
  const now = new Date().toISOString();
  const gstin = params.vendor_gstin.trim().toUpperCase();
  // Enforce unique constraint within company
  const existing = all.find(
    (s) => s.company_id === companyId && s.vendor_gstin === gstin,
  );
  if (existing) {
    const updated = all.map((s) =>
      s.id === existing.id
        ? { ...s, ...params, vendor_gstin: gstin, updated_at: now }
        : s,
    );
    saveAll(updated);
    return updated.find((s) => s.id === existing.id)!;
  }
  const entry: SupplierMaster = {
    id: crypto.randomUUID(),
    company_id: companyId,
    vendor_name: params.vendor_name.trim(),
    vendor_gstin: gstin,
    tally_ledger_name: params.tally_ledger_name.trim(),
    state_name: params.state_name.trim(),
    created_at: now,
    updated_at: now,
  };
  all.push(entry);
  saveAll(all);
  return entry;
}

export function updateSupplier(
  id: string,
  params: Partial<Pick<SupplierMaster, 'vendor_name' | 'vendor_gstin' | 'tally_ledger_name' | 'state_name'>>,
): void {
  const now = new Date().toISOString();
  const all = loadAll().map((s) =>
    s.id === id ? { ...s, ...params, updated_at: now } : s,
  );
  saveAll(all);
}

export function deleteSupplier(id: string): void {
  saveAll(loadAll().filter((s) => s.id !== id));
}

// Auto-learn: update vendor_name from invoice extraction.
// NEVER touches tally_ledger_name. Scoped strictly to companyId.
export function learnVendorName(
  companyId: string,
  gstin: string,
  invoiceVendorName: string,
): void {
  if (!gstin || !invoiceVendorName) return;
  const norm = (s: string) => s.replace(/\s/g, '').toUpperCase();
  const all = loadAll();
  const idx = all.findIndex(
    (s) => s.company_id === companyId && norm(s.vendor_gstin) === norm(gstin),
  );
  if (idx === -1) return;
  all[idx] = {
    ...all[idx],
    vendor_name: invoiceVendorName.trim(),
    updated_at: new Date().toISOString(),
  };
  saveAll(all);
}

// Bulk upsert from Excel import. vendor_name defaults to tally_ledger_name.
export function bulkUpsertSuppliers(
  companyId: string,
  rows: ImportRow[],
): ImportResult {
  const result: ImportResult = { inserted: 0, updated: 0, errors: [] };
  const seenInFile = new Set<string>();
  const all = loadAll();
  const now = new Date().toISOString();

  rows.forEach((row, i) => {
    const rowNum = i + 2; // 1-indexed, row 1 = header
    const gstin = (row.vendor_gstin ?? '').trim().toUpperCase();
    const ledger = (row.tally_ledger_name ?? '').trim();
    const state = (row.state_name ?? '').trim();

    if (!ledger) {
      result.errors.push({ row: rowNum, gstin, reason: 'Tally Ledger Name is required' });
      return;
    }
    if (!gstin) {
      result.errors.push({ row: rowNum, gstin: '—', reason: 'GSTIN is required' });
      return;
    }
    if (!validateGstin(gstin)) {
      result.errors.push({ row: rowNum, gstin, reason: 'Invalid GSTIN format' });
      return;
    }
    if (!state) {
      result.errors.push({ row: rowNum, gstin, reason: 'State Name is required' });
      return;
    }
    if (seenInFile.has(gstin)) {
      result.errors.push({ row: rowNum, gstin, reason: 'Duplicate GSTIN in uploaded file' });
      return;
    }
    seenInFile.add(gstin);

    const existingIdx = all.findIndex(
      (s) => s.company_id === companyId && s.vendor_gstin === gstin,
    );
    if (existingIdx !== -1) {
      // Update tally_ledger_name + state_name. Keep vendor_name if already learned.
      all[existingIdx] = {
        ...all[existingIdx],
        tally_ledger_name: ledger,
        state_name: state,
        updated_at: now,
      };
      result.updated++;
    } else {
      all.push({
        id: crypto.randomUUID(),
        company_id: companyId,
        vendor_name: ledger, // default: same as tally ledger name
        vendor_gstin: gstin,
        tally_ledger_name: ledger,
        state_name: state,
        created_at: now,
        updated_at: now,
      });
      result.inserted++;
    }
  });

  saveAll(all);
  return result;
}

// Returns the Tally ledger name for a GSTIN within a company, or null.
export function lookupSupplierLedger(companyId: string, gstin: string): string | null {
  const norm = (s: string) => s.replace(/\s/g, '').toUpperCase();
  const match = loadSuppliers(companyId).find(
    (s) => norm(s.vendor_gstin) === norm(gstin),
  );
  return match?.tally_ledger_name ?? null;
}
