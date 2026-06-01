// Company-wise Ledger Master — maps HSN/SAC code + GST rate to Tally purchase ledger name.
// Stored in localStorage. Keyed by companyId.

const KEY = 'tallyai_ledgers';

export interface LedgerMaster {
  id: string;
  company_id: string;
  hsn_sac: string;            // HSN or SAC code
  gst_percent: number;        // e.g. 18
  description: string;        // human label (e.g. "Electrical Goods")
  purchase_ledger: string;    // Tally purchase ledger (e.g. "Purchase @18%")
  cgst_ledger: string;        // e.g. "CGST @9%"
  sgst_ledger: string;        // e.g. "SGST @9%"
  igst_ledger: string;        // e.g. "IGST @18%"
  created_at: string;
}

function loadAll(): LedgerMaster[] {
  if (typeof window === 'undefined') return [];
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]');
  } catch {
    return [];
  }
}

function saveAll(list: LedgerMaster[]): void {
  localStorage.setItem(KEY, JSON.stringify(list));
}

export function loadLedgers(companyId: string): LedgerMaster[] {
  return loadAll().filter((l) => l.company_id === companyId);
}

export function addLedger(
  companyId: string,
  params: Omit<LedgerMaster, 'id' | 'company_id' | 'created_at'>,
): LedgerMaster {
  const all = loadAll();
  const entry: LedgerMaster = {
    id: crypto.randomUUID(),
    company_id: companyId,
    ...params,
    created_at: new Date().toISOString(),
  };
  all.push(entry);
  saveAll(all);
  return entry;
}

export function updateLedger(
  id: string,
  params: Partial<Omit<LedgerMaster, 'id' | 'company_id' | 'created_at'>>,
): void {
  const all = loadAll().map((l) => (l.id === id ? { ...l, ...params } : l));
  saveAll(all);
}

export function deleteLedger(id: string): void {
  saveAll(loadAll().filter((l) => l.id !== id));
}

// Returns the ledger entry for a given HSN+rate, or null.
export function lookupLedger(
  companyId: string,
  hsnSac: string,
  gstPercent: number,
): LedgerMaster | null {
  const norm = (s: string) => s.replace(/[\s.]/g, '').toUpperCase();
  return (
    loadLedgers(companyId).find(
      (l) => norm(l.hsn_sac) === norm(hsnSac) && l.gst_percent === gstPercent,
    ) ?? null
  );
}
