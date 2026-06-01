// Company-wise Supplier Master — maps vendor GSTIN to Tally party ledger name.
// Stored in localStorage. Keyed by companyId.

const KEY = 'tallyai_suppliers';

export interface SupplierMaster {
  id: string;
  company_id: string;
  vendor_name: string;        // display name (from invoice)
  vendor_gstin: string;       // 15-char GSTIN
  tally_ledger_name: string;  // exact name in Tally
  created_at: string;         // ISO
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
  params: { vendor_name: string; vendor_gstin: string; tally_ledger_name: string },
): SupplierMaster {
  const all = loadAll();
  const entry: SupplierMaster = {
    id: crypto.randomUUID(),
    company_id: companyId,
    vendor_name: params.vendor_name.trim(),
    vendor_gstin: params.vendor_gstin.trim().toUpperCase(),
    tally_ledger_name: params.tally_ledger_name.trim(),
    created_at: new Date().toISOString(),
  };
  all.push(entry);
  saveAll(all);
  return entry;
}

export function updateSupplier(
  id: string,
  params: Partial<Pick<SupplierMaster, 'vendor_name' | 'vendor_gstin' | 'tally_ledger_name'>>,
): void {
  const all = loadAll().map((s) =>
    s.id === id ? { ...s, ...params } : s,
  );
  saveAll(all);
}

export function deleteSupplier(id: string): void {
  saveAll(loadAll().filter((s) => s.id !== id));
}

// Returns the Tally ledger name for a GSTIN, or null if not mapped.
export function lookupSupplierLedger(companyId: string, gstin: string): string | null {
  const norm = (s: string) => s.replace(/\s/g, '').toUpperCase();
  const match = loadSuppliers(companyId).find(
    (s) => norm(s.vendor_gstin) === norm(gstin),
  );
  return match?.tally_ledger_name ?? null;
}
