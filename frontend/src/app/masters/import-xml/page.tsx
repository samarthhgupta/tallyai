'use client';

import { useState, useCallback, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import AppSidebar from '@/components/AppSidebar';
import { getSession } from '@/lib/auth';
import { useCompany } from '@/lib/companyContext';
import { bulkUpsertStockItems, type StockItemImportRow } from '@/lib/stockItems';
import { bulkUpsertSuppliers, type ImportRow as SupplierRow } from '@/lib/suppliers';
import { addPurchaseLedger } from '@/lib/purchaseLedgers';
import { bulkUpsertExpenseLedgers } from '@/lib/expenseLedgers';
import { addDutiesTaxes, TAX_COMPONENTS, type TaxComponent } from '@/lib/dutiesTaxes';
import { upsertVoucherType, type PurchaseCategory } from '@/lib/voucherTypes';

// ── Types ────────────────────────────────────────────────────────────────────

interface DutyRow {
  component: TaxComponent;
  rate: number | null;
  ledgerName: string;
}

interface VoucherTypeRow {
  name: string;
  category: PurchaseCategory;
}

interface ParsedData {
  stockItems: StockItemImportRow[];
  suppliers: SupplierRow[];
  purchaseLedgers: string[];
  expenseLedgers: Array<{ tally_ledger_name: string }>;
  dutiesTaxes: DutyRow[];
  voucherTypes: VoucherTypeRow[];
  skipped: number;
  fileName: string;
}

interface ImportResults {
  stockItems: { inserted: number; updated: number; errors: number };
  suppliers: { inserted: number; updated: number; errors: number };
  purchaseLedgers: { added: number; skipped: number };
  expenseLedgers: { inserted: number; updated: number; errors: number };
  dutiesTaxes: { added: number; errors: number };
  voucherTypes: { added: number; errors: number };
}

// ── XML Parsing ───────────────────────────────────────────────────────────────

function stripTallyControlChars(xml: string): string {
  // Remove Tally's &#4; and other control character references (< 0x20, except tab/LF/CR)
  return xml.replace(/&#(\d+);/g, (_, n) => {
    const code = parseInt(n, 10);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) return '';
    return `&#${n};`;
  });
}

function getText(el: Element, tag: string): string {
  return el.getElementsByTagName(tag)[0]?.textContent?.trim() ?? '';
}

function parseTallyXml(rawContent: string, fileName: string): ParsedData {
  const result: ParsedData = {
    stockItems: [],
    suppliers: [],
    purchaseLedgers: [],
    expenseLedgers: [],
    dutiesTaxes: [],
    voucherTypes: [],
    skipped: 0,
    fileName,
  };

  const cleaned = stripTallyControlChars(rawContent);
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(cleaned, 'text/xml');
  } catch {
    return result;
  }

  // ── Stock Items ───────────────────────────────────────────────────────────
  const stockEls = doc.getElementsByTagName('STOCKITEM');
  for (let i = 0; i < stockEls.length; i++) {
    const el = stockEls[i];
    const name = el.getAttribute('NAME') ?? getText(el, 'NAME');
    if (!name || name.includes('Not Applicable')) continue;

    const hsn = getText(el, 'HSNCODE').replace(/Not Applicable/i, '').trim() || undefined;
    const unit = getText(el, 'BASEUNITS').replace(/Not Applicable/i, '').trim() || undefined;
    const gstRateRaw = getText(el, 'GSTRATE');
    const halfRate = gstRateRaw ? parseFloat(gstRateRaw) : NaN;
    const gstPercent = !isNaN(halfRate) && halfRate > 0 ? halfRate * 2 : null;

    result.stockItems.push({ tally_item_name: name, hsn_code: hsn, unit, gst_percent: gstPercent });
  }

  // ── Ledgers (route by parent group) ──────────────────────────────────────
  const ledgerEls = doc.getElementsByTagName('LEDGER');
  for (let i = 0; i < ledgerEls.length; i++) {
    const el = ledgerEls[i];
    const name = el.getAttribute('NAME') ?? getText(el, 'NAME');
    if (!name || name.includes('Not Applicable')) continue;

    const parent = getText(el, 'PARENT');
    const parentLower = parent.toLowerCase();

    if (parent === 'Sundry Creditors') {
      const gstin = getText(el, 'GSTREGISTRATIONNUMBER');
      result.suppliers.push({ tally_ledger_name: name, vendor_gstin: gstin });
    } else if (parent === 'Purchase Accounts' || parent === 'Purchase') {
      if (!result.purchaseLedgers.includes(name)) result.purchaseLedgers.push(name);
    } else if (parentLower.includes('expense') || parentLower.includes('expenditure')) {
      result.expenseLedgers.push({ tally_ledger_name: name });
    } else if (parent === 'Duties & Taxes') {
      const parsed = parseDutyLedger(name);
      if (parsed) result.dutiesTaxes.push({ ...parsed, ledgerName: name });
      else result.skipped++;
    } else {
      result.skipped++;
    }
  }

  // ── Voucher Types ─────────────────────────────────────────────────────────
  const vtEls = doc.getElementsByTagName('VOUCHERTYPE');
  for (let i = 0; i < vtEls.length; i++) {
    const el = vtEls[i];
    const name = el.getAttribute('NAME') ?? getText(el, 'NAME');
    if (!name) continue;
    const parent = getText(el, 'PARENT');
    if (parent !== 'Purchase') continue;

    const nameLower = name.toLowerCase();
    const category: PurchaseCategory = nameLower.includes('gst') ? 'gst' : 'default';
    result.voucherTypes.push({ name, category });
  }

  return result;
}

function parseDutyLedger(name: string): { component: TaxComponent; rate: number | null } | null {
  const upper = name.toUpperCase();

  let component: TaxComponent | null = null;
  for (const c of TAX_COMPONENTS) {
    if (upper.includes(c)) { component = c; break; }
  }
  if (!component) return null;

  // Extract rate from patterns like "@9%", "@9", "9%", " 18"
  const rateMatch = name.match(/@\s*([\d.]+)|(\d+(?:\.\d+)?)\s*%/);
  const rate = rateMatch ? parseFloat(rateMatch[1] ?? rateMatch[2]) : null;

  return { component, rate };
}

// ── File reading ──────────────────────────────────────────────────────────────

async function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const buf = e.target?.result as ArrayBuffer;
      // Try UTF-16 first (Tally default), fall back to UTF-8
      try {
        const text = new TextDecoder('utf-16').decode(buf);
        if (text.includes('<')) { resolve(text); return; }
      } catch { /* ignore */ }
      resolve(new TextDecoder('utf-8').decode(buf));
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

// ── Summary helpers ───────────────────────────────────────────────────────────

function totalItems(d: ParsedData) {
  return d.stockItems.length + d.suppliers.length + d.purchaseLedgers.length +
    d.expenseLedgers.length + d.dutiesTaxes.length + d.voucherTypes.length;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function ImportXmlPage() {
  const { company, loading: companyLoading } = useCompany();
  const router = useRouter();

  const [parsed, setParsed] = useState<ParsedData[]>([]);
  const [parsing, setParsing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [results, setResults] = useState<ImportResults | null>(null);
  const [importError, setImportError] = useState('');

  useEffect(() => {
    if (companyLoading) return;
    getSession().then((session) => {
      if (!session) { router.replace('/login'); return; }
      if (!company) router.replace('/select-company');
    });
  }, [company, companyLoading, router]);

  const handleFiles = useCallback(async (files: FileList | null) => {
    if (!files?.length) return;
    setParsing(true);
    setResults(null);
    setImportError('');
    try {
      const results: ParsedData[] = [];
      for (let i = 0; i < files.length; i++) {
        const text = await readFileAsText(files[i]);
        results.push(parseTallyXml(text, files[i].name));
      }
      setParsed(results);
    } finally {
      setParsing(false);
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    handleFiles(e.dataTransfer.files);
  }, [handleFiles]);

  const merged = {
    stockItems:     parsed.flatMap((p) => p.stockItems),
    suppliers:      parsed.flatMap((p) => p.suppliers),
    purchaseLedgers: Array.from(new Set(parsed.flatMap((p) => p.purchaseLedgers))),
    expenseLedgers: parsed.flatMap((p) => p.expenseLedgers),
    dutiesTaxes:    parsed.flatMap((p) => p.dutiesTaxes),
    voucherTypes:   parsed.flatMap((p) => p.voucherTypes),
  };

  const handleImport = async () => {
    if (!company?.id) return;
    setImporting(true);
    setImportError('');
    const res: ImportResults = {
      stockItems:     { inserted: 0, updated: 0, errors: 0 },
      suppliers:      { inserted: 0, updated: 0, errors: 0 },
      purchaseLedgers: { added: 0, skipped: 0 },
      expenseLedgers: { inserted: 0, updated: 0, errors: 0 },
      dutiesTaxes:    { added: 0, errors: 0 },
      voucherTypes:   { added: 0, errors: 0 },
    };

    try {
      if (merged.stockItems.length) {
        const r = await bulkUpsertStockItems(company.id, merged.stockItems);
        res.stockItems = { inserted: r.inserted, updated: r.updated, errors: r.errors.length };
      }

      if (merged.suppliers.length) {
        const r = await bulkUpsertSuppliers(company.id, merged.suppliers, company.state_name ?? '');
        res.suppliers = { inserted: r.inserted, updated: r.updated, errors: r.errors.length };
      }

      for (const name of merged.purchaseLedgers) {
        try {
          await addPurchaseLedger(company.id, name);
          res.purchaseLedgers.added++;
        } catch {
          res.purchaseLedgers.skipped++;
        }
      }

      if (merged.expenseLedgers.length) {
        const r = await bulkUpsertExpenseLedgers(company.id, merged.expenseLedgers);
        res.expenseLedgers = { inserted: r.inserted, updated: r.updated, errors: r.errors.length };
      }

      for (const d of merged.dutiesTaxes) {
        try {
          await addDutiesTaxes(company.id, { tax_component: d.component, tax_rate: d.rate, tally_ledger_name: d.ledgerName });
          res.dutiesTaxes.added++;
        } catch {
          res.dutiesTaxes.errors++;
        }
      }

      for (const v of merged.voucherTypes) {
        try {
          await upsertVoucherType(company.id, { purchase_category: v.category, tally_voucher_type_name: v.name });
          res.voucherTypes.added++;
        } catch {
          res.voucherTypes.errors++;
        }
      }

      setResults(res);
      setParsed([]);
    } catch (err: unknown) {
      setImportError(err instanceof Error ? err.message : 'Import failed. Please try again.');
    } finally {
      setImporting(false);
    }
  };

  const totalParsed = merged.stockItems.length + merged.suppliers.length +
    merged.purchaseLedgers.length + merged.expenseLedgers.length +
    merged.dutiesTaxes.length + merged.voucherTypes.length;

  return (
    <div className="flex min-h-screen bg-gray-50">
      <AppSidebar />
      <main className="ml-60 flex-1 p-8 max-w-3xl">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-gray-900">Import from Tally XML</h1>
          <p className="text-sm text-gray-500 mt-1">
            Upload Tally &ldquo;All Masters&rdquo; XML exports. Records are auto-routed to the correct master based on their type.
          </p>
        </div>

        {/* How it works */}
        <div className="bg-blue-50 border border-blue-200 rounded-xl px-5 py-4 text-xs text-blue-800 mb-6">
          <p className="font-semibold text-sm mb-1">What gets imported</p>
          <ul className="list-disc list-inside space-y-1 text-blue-700">
            <li><strong>Stock Items</strong> — with HSN code, GST rate, and unit of measure</li>
            <li><strong>Suppliers</strong> — Sundry Creditors with GSTIN</li>
            <li><strong>Purchase Ledgers</strong> — ledgers under &ldquo;Purchase Accounts&rdquo;</li>
            <li><strong>Expense Ledgers</strong> — ledgers under expense groups</li>
            <li><strong>Duties &amp; Taxes</strong> — CGST/SGST/IGST/CESS ledgers with rates</li>
            <li><strong>Voucher Types</strong> — Purchase voucher types</li>
          </ul>
          <p className="mt-2 text-blue-600">All other ledger groups are skipped. Existing records are updated, not duplicated.</p>
        </div>

        {/* Drop zone */}
        {!parsed.length && !results && (
          <div
            onDrop={handleDrop}
            onDragOver={(e) => e.preventDefault()}
            className="border-2 border-dashed border-gray-300 rounded-xl p-12 text-center hover:border-indigo-400 transition-colors bg-white"
          >
            <div className="text-4xl mb-3">📂</div>
            <p className="text-sm font-medium text-gray-700 mb-1">Drop Tally XML files here</p>
            <p className="text-xs text-gray-400 mb-4">or click to select files — multiple files supported</p>
            <label className="cursor-pointer px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-md hover:bg-indigo-700 transition-colors">
              Select XML Files
              <input
                type="file"
                accept=".xml"
                multiple
                className="hidden"
                onChange={(e) => handleFiles(e.target.files)}
              />
            </label>
            {parsing && (
              <div className="mt-6 flex justify-center">
                <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-indigo-600" />
              </div>
            )}
          </div>
        )}

        {/* Preview */}
        {parsed.length > 0 && !results && (
          <div>
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-base font-semibold text-gray-900">
                Preview — {parsed.length} file{parsed.length !== 1 ? 's' : ''} analysed
              </h2>
              <button
                onClick={() => { setParsed([]); setImportError(''); }}
                className="text-sm text-gray-500 hover:text-gray-700"
              >
                ✕ Clear
              </button>
            </div>

            {/* Per-file breakdown */}
            <div className="space-y-3 mb-5">
              {parsed.map((p) => (
                <div key={p.fileName} className="bg-white border border-gray-200 rounded-xl p-4">
                  <p className="text-xs font-semibold text-gray-500 mb-2 font-mono truncate">{p.fileName}</p>
                  <div className="grid grid-cols-3 gap-2 text-xs">
                    <Stat label="Stock Items" count={p.stockItems.length} />
                    <Stat label="Suppliers" count={p.suppliers.length} />
                    <Stat label="Purchase Ledgers" count={p.purchaseLedgers.length} />
                    <Stat label="Expense Ledgers" count={p.expenseLedgers.length} />
                    <Stat label="Duties & Taxes" count={p.dutiesTaxes.length} />
                    <Stat label="Voucher Types" count={p.voucherTypes.length} />
                  </div>
                  {p.skipped > 0 && (
                    <p className="text-xs text-gray-400 mt-2">{p.skipped} ledger{p.skipped !== 1 ? 's' : ''} skipped (unrecognised groups)</p>
                  )}
                </div>
              ))}
            </div>

            {/* Totals */}
            {parsed.length > 1 && (
              <div className="bg-indigo-50 border border-indigo-200 rounded-xl p-4 mb-5">
                <p className="text-xs font-semibold text-indigo-700 mb-2">Combined total across all files</p>
                <div className="grid grid-cols-3 gap-2 text-xs">
                  <Stat label="Stock Items" count={merged.stockItems.length} />
                  <Stat label="Suppliers" count={merged.suppliers.length} />
                  <Stat label="Purchase Ledgers" count={merged.purchaseLedgers.length} />
                  <Stat label="Expense Ledgers" count={merged.expenseLedgers.length} />
                  <Stat label="Duties & Taxes" count={merged.dutiesTaxes.length} />
                  <Stat label="Voucher Types" count={merged.voucherTypes.length} />
                </div>
              </div>
            )}

            {importError && (
              <p className="text-sm text-red-600 mb-3">{importError}</p>
            )}

            <div className="flex gap-3">
              {totalParsed > 0 ? (
                <button
                  onClick={handleImport}
                  disabled={importing || !company?.id}
                  className="px-5 py-2.5 bg-indigo-600 text-white text-sm font-semibold rounded-lg hover:bg-indigo-700 disabled:opacity-40 transition-colors"
                >
                  {importing ? 'Importing…' : `Import ${totalParsed} records into ${company?.name ?? 'company'}`}
                </button>
              ) : (
                <p className="text-sm text-gray-500 py-2">No importable records found in the selected files.</p>
              )}
              <button
                onClick={() => { setParsed([]); setImportError(''); }}
                disabled={importing}
                className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Results */}
        {results && (
          <div>
            <div className="flex items-center gap-2 mb-5">
              <span className="text-xl">✅</span>
              <h2 className="text-base font-semibold text-gray-900">Import complete</h2>
            </div>
            <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Master</th>
                    <th className="px-4 py-3 text-xs font-semibold text-green-600 uppercase tracking-wide text-right">Inserted</th>
                    <th className="px-4 py-3 text-xs font-semibold text-blue-600 uppercase tracking-wide text-right">Updated</th>
                    <th className="px-4 py-3 text-xs font-semibold text-red-500 uppercase tracking-wide text-right">Errors</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 text-xs">
                  <ResultRow label="Stock Items" inserted={results.stockItems.inserted} updated={results.stockItems.updated} errors={results.stockItems.errors} />
                  <ResultRow label="Suppliers" inserted={results.suppliers.inserted} updated={results.suppliers.updated} errors={results.suppliers.errors} />
                  <tr>
                    <td className="px-4 py-3 font-medium text-gray-700">Purchase Ledgers</td>
                    <td className="px-4 py-3 text-right text-green-700">{results.purchaseLedgers.added}</td>
                    <td className="px-4 py-3 text-right text-gray-400">—</td>
                    <td className="px-4 py-3 text-right text-gray-400">{results.purchaseLedgers.skipped > 0 ? `${results.purchaseLedgers.skipped} dup` : '—'}</td>
                  </tr>
                  <ResultRow label="Expense Ledgers" inserted={results.expenseLedgers.inserted} updated={results.expenseLedgers.updated} errors={results.expenseLedgers.errors} />
                  <tr>
                    <td className="px-4 py-3 font-medium text-gray-700">Duties &amp; Taxes</td>
                    <td className="px-4 py-3 text-right text-green-700">{results.dutiesTaxes.added}</td>
                    <td className="px-4 py-3 text-right text-gray-400">—</td>
                    <td className="px-4 py-3 text-right text-red-500">{results.dutiesTaxes.errors || '—'}</td>
                  </tr>
                  <tr>
                    <td className="px-4 py-3 font-medium text-gray-700">Voucher Types</td>
                    <td className="px-4 py-3 text-right text-green-700">{results.voucherTypes.added}</td>
                    <td className="px-4 py-3 text-right text-gray-400">—</td>
                    <td className="px-4 py-3 text-right text-red-500">{results.voucherTypes.errors || '—'}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div className="mt-4 flex gap-3">
              <button
                onClick={() => setResults(null)}
                className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-md hover:bg-indigo-700 transition-colors"
              >
                Import another file
              </button>
              <button
                onClick={() => router.push('/masters/suppliers')}
                className="px-4 py-2 text-sm text-indigo-600 hover:text-indigo-800 font-medium"
              >
                View Masters →
              </button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function Stat({ label, count }: { label: string; count: number }) {
  return (
    <div className={`px-3 py-2 rounded-lg text-center ${count > 0 ? 'bg-indigo-50 text-indigo-700' : 'bg-gray-50 text-gray-400'}`}>
      <div className="font-bold text-base">{count}</div>
      <div className="text-[10px] leading-tight mt-0.5">{label}</div>
    </div>
  );
}

function ResultRow({ label, inserted, updated, errors }: { label: string; inserted: number; updated: number; errors: number }) {
  return (
    <tr>
      <td className="px-4 py-3 font-medium text-gray-700">{label}</td>
      <td className="px-4 py-3 text-right text-green-700">{inserted || '—'}</td>
      <td className="px-4 py-3 text-right text-blue-700">{updated || '—'}</td>
      <td className="px-4 py-3 text-right text-red-500">{errors || '—'}</td>
    </tr>
  );
}
