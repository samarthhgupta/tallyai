// Company-wise Ledger Master — maps HSN/SAC code + GST rate to Tally purchase ledger names.
// Stored in localStorage. Keyed by companyId.

const KEY = 'tallyai_ledgers';

export interface LedgerMaster {
  id: string;
  company_id: string;
  hsn_sac: string;            // HSN or SAC code (optional — blank means "all codes at this rate")
  gst_percent: number;        // e.g. 18
  description: string;        // human label (e.g. "Electrical Goods")
  purchase_ledger: string;    // Tally purchase ledger (e.g. "Purchase @18%")
  cgst_ledger: string;        // e.g. "CGST @9%"
  sgst_ledger: string;        // e.g. "SGST @9%"
  igst_ledger: string;        // e.g. "IGST @18%"
  created_at: string;
  updated_at: string;
}

export interface LedgerImportRow {
  hsn_sac: string;
  gst_percent: string | number;
  description: string;
  purchase_ledger: string;
  cgst_ledger: string;
  sgst_ledger: string;
  igst_ledger: string;
}

export interface LedgerImportResult {
  inserted: number;
  updated: number;
  errors: Array<{ row: number; hsn: string; reason: string }>;
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
  params: Omit<LedgerMaster, 'id' | 'company_id' | 'created_at' | 'updated_at'>,
): LedgerMaster {
  const all = loadAll();
  const now = new Date().toISOString();
  const entry: LedgerMaster = {
    id: crypto.randomUUID(),
    company_id: companyId,
    ...params,
    created_at: now,
    updated_at: now,
  };
  all.push(entry);
  saveAll(all);
  return entry;
}

export function updateLedger(
  id: string,
  params: Partial<Omit<LedgerMaster, 'id' | 'company_id' | 'created_at' | 'updated_at'>>,
): void {
  const now = new Date().toISOString();
  const all = loadAll().map((l) => (l.id === id ? { ...l, ...params, updated_at: now } : l));
  saveAll(all);
}

export function deleteLedger(id: string): void {
  saveAll(loadAll().filter((l) => l.id !== id));
}

// Bulk upsert from Excel import. Key: company_id + hsn_sac + gst_percent.
export function bulkUpsertLedgers(
  companyId: string,
  rows: LedgerImportRow[],
): LedgerImportResult {
  const result: LedgerImportResult = { inserted: 0, updated: 0, errors: [] };
  const seenInFile = new Set<string>();
  const all = loadAll();
  const now = new Date().toISOString();

  rows.forEach((row, i) => {
    const rowNum = i + 2;
    const hsn = (row.hsn_sac ?? '').toString().trim();
    const rate = parseFloat((row.gst_percent ?? '').toString());
    const purchaseLedger = (row.purchase_ledger ?? '').trim();

    if (isNaN(rate) || rate < 0) {
      result.errors.push({ row: rowNum, hsn, reason: 'Invalid GST %' });
      return;
    }
    if (!purchaseLedger) {
      result.errors.push({ row: rowNum, hsn, reason: 'Purchase Ledger is required' });
      return;
    }
    const fileKey = `${hsn}__${rate}`;
    if (seenInFile.has(fileKey)) {
      result.errors.push({ row: rowNum, hsn, reason: 'Duplicate HSN+Rate in uploaded file' });
      return;
    }
    seenInFile.add(fileKey);

    const existingIdx = all.findIndex(
      (l) => l.company_id === companyId && l.hsn_sac === hsn && l.gst_percent === rate,
    );

    const payload = {
      hsn_sac: hsn,
      gst_percent: rate,
      description: (row.description ?? '').trim(),
      purchase_ledger: purchaseLedger,
      cgst_ledger: (row.cgst_ledger ?? '').trim(),
      sgst_ledger: (row.sgst_ledger ?? '').trim(),
      igst_ledger: (row.igst_ledger ?? '').trim(),
    };

    if (existingIdx !== -1) {
      all[existingIdx] = { ...all[existingIdx], ...payload, updated_at: now };
      result.updated++;
    } else {
      all.push({
        id: crypto.randomUUID(),
        company_id: companyId,
        ...payload,
        created_at: now,
        updated_at: now,
      });
      result.inserted++;
    }
  });

  saveAll(all);
  return result;
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
