'use client';

import { useState, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { parseExcelSalesFile } from '@/lib/salesExtract';
import { createSalesBatch, insertAcceptedSalesExcelInvoices, checkExcelDuplicates, computeSalesReadiness } from '@/lib/salesDb';
import { learnCustomerName } from '@/lib/customers';
import type { ExtractedInvoice } from '@/types/invoice';
import { formatINR } from '@/types/invoice';
import { deriveInvoiceFinancials } from '@/lib/invoiceCalculations';
import AppLayout from '@/components/AppLayout';
import { InvoiceEditPanel } from '@/components/InvoiceEditPanel';
import type { InvoiceEditData } from '@/components/InvoiceEditPanel';
import FYPeriodSelector from '@/components/FYPeriodSelector';
import { currentFY } from '@/lib/fyPeriod';
import { useCompany } from '@/lib/companyContext';
import { MAX_IMPORT_INVOICES } from '@/lib/importConstants';

function getErrMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'object' && e !== null && 'message' in e) return String((e as { message: unknown }).message);
  return 'Unknown error';
}

// ─── Readiness badge ───────────────────────────────────────────────────────────

function ReadinessBadge({ readiness }: { readiness: 'ready' | 'warning' | 'critical' }) {
  if (readiness === 'ready')
    return <span className="text-green-600 dark:text-green-400 font-semibold text-xs">✓</span>;
  if (readiness === 'warning')
    return <span className="text-amber-500 dark:text-amber-400 font-semibold text-xs">⚠</span>;
  return <span className="text-red-600 dark:text-red-400 font-semibold text-xs">✗</span>;
}

// ─── Over-limit popup ──────────────────────────────────────────────────────────

function OverLimitPopup({ total, limit, onProceed, onCancel }: {
  total: number; limit: number; onProceed: () => void; onCancel: () => void;
}) {
  const excess = total - limit;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white dark:bg-gray-900 rounded-xl shadow-2xl p-6 max-w-md w-full mx-4">
        <div className="text-4xl mb-3 text-center">⚠️</div>
        <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100 text-center mb-2">Import Limit Exceeded</h3>
        <p className="text-sm text-gray-600 dark:text-gray-400 text-center mb-4">
          This file contains <strong>{total.toLocaleString()}</strong> invoices.
          Only the first <strong>{limit.toLocaleString()}</strong> invoices will be imported.
          The remaining <strong>{excess.toLocaleString()}</strong> invoices will be excluded.
          Split the file to import them separately.
        </p>
        <div className="flex gap-2 justify-center">
          <button onClick={onProceed} className="px-5 py-2 bg-amber-600 text-white text-sm font-medium rounded-lg hover:bg-amber-700 transition-colors">
            Continue with first {limit.toLocaleString()}
          </button>
          <button onClick={onCancel} className="px-5 py-2 border border-gray-300 dark:border-gray-600 text-sm text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main page ─────────────────────────────────────────────────────────────────

export default function SalesExcelImportPage() {
  const router = useRouter();
  const { company } = useCompany();
  const fileRef = useRef<HTMLInputElement>(null);

  const [fy, setFy] = useState(currentFY());
  const [allParsedInvoices, setAllParsedInvoices] = useState<ExtractedInvoice[]>([]);
  const [invoices, setInvoices] = useState<ExtractedInvoice[]>([]);
  const [parseErrors, setParseErrors] = useState<Array<{ row: number; reason: string }>>([]);
  const [filename, setFilename] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Over-limit state
  const [showOverLimit, setShowOverLimit] = useState(false);
  const [pendingAll, setPendingAll] = useState<ExtractedInvoice[]>([]);

  // Duplicate detection
  const [duplicates, setDuplicates] = useState<string[]>([]);
  const [showDuplicateWarning, setShowDuplicateWarning] = useState(false);

  // Edit drawer
  const [editingIdx, setEditingIdx] = useState<number | null>(null);

  // Row-level selection (unchecked = excluded from import)
  // All rows start as accepted (checked). Use a Set of indices that are EXCLUDED.
  const [excludedIndices, setExcludedIndices] = useState<Set<number>>(new Set());

  const applyParsed = useCallback((all: ExtractedInvoice[], name: string) => {
    // Enrich vendor fields immediately so the preview and edit drawer show the correct
    // seller name/GSTIN — company is always the seller for sales invoices.
    const enriched = all.map((inv) => ({
      ...inv,
      vendor_name: inv.vendor_name || company?.name || '',
      vendor_gstin: inv.vendor_gstin || company?.gstin || '',
    }));
    setFilename(name);
    setAllParsedInvoices(enriched);
    setInvoices(enriched);
    // Pre-exclude rows beyond the import cap
    if (enriched.length > MAX_IMPORT_INVOICES) {
      const preExcluded = new Set<number>();
      for (let idx = MAX_IMPORT_INVOICES; idx < enriched.length; idx++) preExcluded.add(idx);
      setExcludedIndices(preExcluded);
      setPendingAll(enriched);
      setShowOverLimit(true);
    } else {
      setExcludedIndices(new Set());
    }
  }, [company]);

  const handleFile = useCallback(async (file: File) => {
    setLoading(true);
    setError(null);
    setInvoices([]);
    setAllParsedInvoices([]);
    setParseErrors([]);
    setDuplicates([]);
    setShowDuplicateWarning(false);
    setShowOverLimit(false);
    setExcludedIndices(new Set());
    try {
      const result = await parseExcelSalesFile(file);
      setParseErrors(result.errors);
      applyParsed(result.invoices, file.name);
    } catch (e) {
      setError(`Failed to parse file: ${getErrMsg(e)}`);
    } finally {
      setLoading(false);
    }
  }, [applyParsed]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  }, [handleFile]);

  // Checkbox helpers
  const acceptedIndices = invoices.map((_, i) => i).filter((i) => !excludedIndices.has(i));
  const acceptedCount = acceptedIndices.length;
  const allSelected = excludedIndices.size === 0 && invoices.length > 0;
  const someSelected = excludedIndices.size > 0 && excludedIndices.size < invoices.length;

  const toggleRow = (i: number) => {
    // Prevent un-excluding rows beyond the import cap
    if (i >= MAX_IMPORT_INVOICES) return;
    setExcludedIndices((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i); else next.add(i);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (allSelected) {
      // Deselect all
      setExcludedIndices(new Set(invoices.map((_, i) => i)));
    } else {
      // Select all
      setExcludedIndices(new Set());
    }
  };

  const handleImport = async () => {
    if (!acceptedCount) return;
    setSaving(true);
    setError(null);
    setDuplicates([]);
    setShowDuplicateWarning(false);
    try {
      const session = await getSession();
      if (!session) { router.push('/login'); return; }
      if (!company) { router.push('/select-company'); return; }

      const acceptedInvoices = acceptedIndices.map((i) => invoices[i]);
      const invoiceNumbers = acceptedInvoices.map((inv) => inv.invoice_number).filter(Boolean);
      const dupes = await checkExcelDuplicates(company.id, invoiceNumbers, fy);
      if (dupes.length > 0) {
        setDuplicates(dupes);
        setShowDuplicateWarning(true);
        setSaving(false);
        return;
      }
      await doImport(company.id, acceptedInvoices);
    } catch (e) {
      setError(getErrMsg(e));
    } finally {
      setSaving(false);
    }
  };

  const handleForceImport = async () => {
    if (!company) return;
    setSaving(true);
    setShowDuplicateWarning(false);
    setError(null);
    try {
      const acceptedInvoices = acceptedIndices.map((i) => invoices[i]);
      await doImport(company.id, acceptedInvoices);
    } catch (e) {
      setError(getErrMsg(e));
    } finally {
      setSaving(false);
    }
  };

  const doImport = async (companyId: string, toImport: ExtractedInvoice[]) => {
    const batchId = await createSalesBatch(companyId, 1, fy, 'excel_import');
    const enriched = toImport.map((inv) => ({
      ...inv,
      vendor_name: company!.name,
      vendor_gstin: company!.gstin ?? '',
    }));
    await insertAcceptedSalesExcelInvoices(companyId, batchId, enriched.map((inv) => ({ inv, filename })), fy);
    for (const inv of enriched) {
      if (inv.buyer_gstin && inv.buyer_name) {
        await learnCustomerName(companyId, inv.buyer_gstin, inv.buyer_name).catch(() => {});
      }
    }
    setSuccess(true);
    setTimeout(() => router.push('/sales/register'), 1200);
  };

  const handleEditSave = (idx: number, updated: ExtractedInvoice) => {
    const recomputed = {
      ...invoices[idx],
      ...updated,
    };
    const financials = deriveInvoiceFinancials(recomputed);
    setInvoices((prev) => prev.map((inv, i) => i === idx ? {
      ...recomputed,
      subtotal: financials.net_goods_taxable,
      cgst: financials.cgst,
      sgst: financials.sgst,
      igst: financials.igst,
      total: financials.total,
      round_off: financials.round_off,
    } : inv));
    setEditingIdx(null);
  };

  // Summary totals (only accepted invoices)
  const acceptedInvoices = acceptedIndices.map((i) => invoices[i]);
  const acceptedFinancials = acceptedInvoices.map((inv) => deriveInvoiceFinancials(inv));
  const totalTaxable = acceptedFinancials.reduce((s, f) => s + f.net_goods_taxable, 0);
  const totalCGST = acceptedFinancials.reduce((s, f) => s + f.cgst, 0);
  const totalSGST = acceptedFinancials.reduce((s, f) => s + f.sgst, 0);
  const totalIGST = acceptedFinancials.reduce((s, f) => s + f.igst, 0);
  const totalRoundOff = acceptedFinancials.reduce((s, f) => s + f.round_off, 0);
  const grandTotal = acceptedFinancials.reduce((s, f) => s + f.total, 0);

  const isOverLimit = allParsedInvoices.length > MAX_IMPORT_INVOICES;

  return (
    <AppLayout>
      {showOverLimit && (
        <OverLimitPopup
          total={pendingAll.length}
          limit={MAX_IMPORT_INVOICES}
          onProceed={() => setShowOverLimit(false)}
          onCancel={() => {
            setShowOverLimit(false);
            setInvoices([]);
            setAllParsedInvoices([]);
            setFilename('');
          }}
        />
      )}

      {editingIdx !== null && invoices[editingIdx] && (
        <InvoiceEditPanel
          perspective="sales"
          invoice={invoices[editingIdx]}
          onSave={(updated) => handleEditSave(editingIdx, updated as ExtractedInvoice)}
          onClose={() => setEditingIdx(null)}
        />
      )}

      <div className="max-w-7xl mx-auto px-4 py-8">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Sales Excel Import</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            Import sales invoices from a POS or billing system Excel export.
          </p>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-sm text-red-700 dark:text-red-400">
            {error}
          </div>
        )}

        {success && (
          <div className="mb-4 p-3 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg text-sm text-green-700 dark:text-green-400">
            ✓ {acceptedCount} invoice{acceptedCount !== 1 ? 's' : ''} imported. Redirecting to Sales Register…
          </div>
        )}

        {showDuplicateWarning && (
          <div className="mb-4 p-4 bg-amber-50 dark:bg-amber-900/20 border border-amber-300 dark:border-amber-700 rounded-lg">
            <p className="text-sm font-semibold text-amber-800 dark:text-amber-300 mb-1">
              {duplicates.length} invoice{duplicates.length !== 1 ? 's' : ''} already exist in Sales Register for FY {fy}
            </p>
            <p className="text-xs text-amber-700 dark:text-amber-400 mb-2">
              Importing will create duplicate records. Cancel to skip, or proceed to import anyway.
            </p>
            <div className="flex flex-wrap gap-1.5 mb-3 max-h-24 overflow-y-auto">
              {duplicates.map((num) => (
                <span key={num} className="inline-block px-2 py-0.5 bg-amber-100 dark:bg-amber-900 text-amber-800 dark:text-amber-300 text-xs font-mono rounded">
                  {num}
                </span>
              ))}
            </div>
            <div className="flex gap-2">
              <button onClick={handleForceImport} disabled={saving}
                className="px-4 py-2 bg-amber-600 text-white text-sm font-medium rounded-lg hover:bg-amber-700 disabled:opacity-50 transition-colors">
                Import Anyway
              </button>
              <button onClick={() => { setShowDuplicateWarning(false); setDuplicates([]); }}
                className="px-4 py-2 border border-amber-300 dark:border-amber-700 text-sm text-amber-700 dark:text-amber-300 rounded-lg hover:bg-amber-100 dark:hover:bg-amber-900/40 transition-colors">
                Cancel
              </button>
            </div>
          </div>
        )}

        <div className="mb-4">
          <FYPeriodSelector value={fy} onChange={(v) => setFy(v)} />
        </div>

        {/* Drop zone */}
        {!invoices.length && (
          <div
            onDrop={handleDrop}
            onDragOver={(e) => e.preventDefault()}
            className="border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-xl p-12 text-center hover:border-indigo-400 dark:hover:border-indigo-500 transition-colors cursor-pointer"
            onClick={() => fileRef.current?.click()}
          >
            <div className="text-4xl mb-3">📥</div>
            <p className="text-base font-medium text-gray-700 dark:text-gray-300">Drop your Excel file here</p>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">Supports .xlsx, .xls, .csv — click to browse</p>
            <p className="text-xs text-gray-400 dark:text-gray-500 mt-2">
              Maximum {MAX_IMPORT_INVOICES.toLocaleString()} invoices can be imported at one time.
            </p>
            <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleFileInput} />
          </div>
        )}

        {loading && <div className="text-center py-8 text-gray-500 dark:text-gray-400">Parsing file…</div>}

        {invoices.length > 0 && (
          <>
            {/* Summary bar */}
            <div className="mb-3 flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center gap-3 flex-wrap text-sm">
                <span className="font-medium text-gray-700 dark:text-gray-300">
                  {invoices.length.toLocaleString()} invoices
                  {isOverLimit && (
                    <span className="ml-2 text-xs text-amber-600 dark:text-amber-400 font-normal">
                      ({(invoices.length - MAX_IMPORT_INVOICES).toLocaleString()} beyond import cap — highlighted in amber)
                    </span>
                  )}
                  {' '}from{' '}
                  <span className="font-mono text-xs bg-gray-100 dark:bg-gray-800 px-1 rounded">{filename}</span>
                </span>
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  B2B: <strong>{invoices.filter((i) => i.buyer_gstin).length}</strong>
                  {' · '}
                  B2C: <strong>{invoices.filter((i) => !i.buyer_gstin).length}</strong>
                  {' · '}
                  Issues: <strong className="text-amber-600 dark:text-amber-400">
                    {invoices.filter((i) => computeSalesReadiness(i).readiness !== 'ready').length}
                  </strong>
                  {excludedIndices.size > 0 && (
                    <span className="ml-2 text-red-500 dark:text-red-400">
                      · {excludedIndices.size} excluded
                    </span>
                  )}
                </span>
              </div>
              <button
                onClick={() => { setInvoices([]); setAllParsedInvoices([]); setParseErrors([]); setFilename(''); setError(null); setDuplicates([]); setShowDuplicateWarning(false); setExcludedIndices(new Set()); }}
                className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
              >
                Clear
              </button>
            </div>

            {isOverLimit && (
              <div className="mb-3 p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-300 dark:border-amber-700 rounded-lg text-sm text-amber-700 dark:text-amber-400">
                <strong>Import cap applied.</strong> Only the first {MAX_IMPORT_INVOICES.toLocaleString()} invoices will be imported.
                The remaining {(invoices.length - MAX_IMPORT_INVOICES).toLocaleString()} invoices (highlighted in amber) are pre-excluded. Split the file to import them separately.
              </div>
            )}

            {/* Table — matches Sales Register column layout */}
            <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden mb-4">
              <table className="w-full text-xs">
                <thead className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
                  <tr>
                    <th className="px-3 py-2.5 w-8">
                      <input
                        type="checkbox"
                        checked={allSelected}
                        ref={(el) => { if (el) el.indeterminate = someSelected; }}
                        onChange={toggleSelectAll}
                        className="w-3.5 h-3.5 rounded border-gray-300 dark:border-gray-600 text-indigo-600 cursor-pointer"
                        title="Select all / deselect all"
                      />
                    </th>
                    <th className="text-left px-3 py-2.5 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide w-7">St.</th>
                    <th className="text-left px-3 py-2.5 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">#</th>
                    <th className="text-left px-3 py-2.5 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Invoice #</th>
                    <th className="text-left px-3 py-2.5 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Customer</th>
                    <th className="text-left px-3 py-2.5 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">GSTIN</th>
                    <th className="text-left px-3 py-2.5 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Date</th>
                    <th className="text-right px-3 py-2.5 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Taxable</th>
                    <th className="text-right px-3 py-2.5 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">CGST</th>
                    <th className="text-right px-3 py-2.5 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">SGST</th>
                    <th className="text-right px-3 py-2.5 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">IGST</th>
                    <th className="text-right px-3 py-2.5 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Rnd Off</th>
                    <th className="text-right px-3 py-2.5 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Items</th>
                    <th className="text-right px-3 py-2.5 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Total</th>
                    <th className="px-2 py-2.5 w-8" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                  {invoices.map((inv, i) => {
                    const isOverLimitRow = i >= MAX_IMPORT_INVOICES;
                    const isExcluded = excludedIndices.has(i);
                    const isDupe = duplicates.includes(inv.invoice_number);
                    const { readiness, flags } = computeSalesReadiness(inv);
                    const hasWarning = readiness !== 'ready';
                    const d = deriveInvoiceFinancials(inv);
                    return (
                      <>
                        <tr
                          key={`row-${i}`}
                          className={[
                            'transition-colors',
                            isOverLimitRow ? 'bg-amber-50 dark:bg-amber-900/10' :
                              isExcluded ? 'opacity-40 bg-gray-50 dark:bg-gray-900/50' : 'hover:bg-gray-50 dark:hover:bg-gray-700/50',
                            !isOverLimitRow && !isExcluded && isDupe ? 'bg-amber-50 dark:bg-amber-900/10' : '',
                          ].filter(Boolean).join(' ')}
                        >
                          <td className="px-3 py-2.5">
                            <input
                              type="checkbox"
                              checked={!isExcluded}
                              onChange={() => toggleRow(i)}
                              disabled={isOverLimitRow}
                              className="w-3.5 h-3.5 rounded border-gray-300 dark:border-gray-600 text-indigo-600 cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
                            />
                          </td>
                          <td className="px-3 py-2.5 text-center">
                            {isOverLimitRow
                              ? <span className="text-amber-500 dark:text-amber-400 font-semibold text-xs">Excl.</span>
                              : <ReadinessBadge readiness={readiness} />
                            }
                          </td>
                          <td className="px-3 py-2.5 text-gray-400 dark:text-gray-500 tabular-nums">{i + 1}</td>
                          <td className="px-3 py-2.5 whitespace-nowrap">
                            <span className="font-semibold text-gray-800 dark:text-gray-200 text-xs">
                              {inv.invoice_number || <span className="text-red-400 italic">missing</span>}
                            </span>
                            {isDupe && <span className="ml-1.5 text-amber-600 dark:text-amber-400 text-xs font-semibold">dup</span>}
                          </td>
                          <td className="px-3 py-2.5 text-gray-700 dark:text-gray-300 max-w-[150px] truncate" title={inv.buyer_name ?? undefined}>
                            {inv.buyer_name || <span className="text-red-400 italic">missing</span>}
                          </td>
                          <td className="px-3 py-2.5 font-mono text-gray-500 dark:text-gray-400 whitespace-nowrap">
                            {inv.buyer_gstin || <span className="text-gray-300 dark:text-gray-600 text-xs">N/A</span>}
                          </td>
                          <td className="px-3 py-2.5 text-gray-600 dark:text-gray-400 whitespace-nowrap">{inv.invoice_date}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-gray-800 dark:text-gray-200 whitespace-nowrap">{formatINR(d.net_goods_taxable)}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-gray-600 dark:text-gray-400 whitespace-nowrap">
                            {d.cgst > 0 ? formatINR(d.cgst) : <span className="text-gray-300 dark:text-gray-600">0.00</span>}
                          </td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-gray-600 dark:text-gray-400 whitespace-nowrap">
                            {d.sgst > 0 ? formatINR(d.sgst) : <span className="text-gray-300 dark:text-gray-600">0.00</span>}
                          </td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-gray-600 dark:text-gray-400 whitespace-nowrap">
                            {d.igst > 0 ? formatINR(d.igst) : <span className="text-gray-300 dark:text-gray-600">0.00</span>}
                          </td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-gray-500 dark:text-gray-400 whitespace-nowrap text-xs">
                            {d.round_off !== 0 ? (d.round_off > 0 ? '+' : '') + formatINR(d.round_off) : <span className="text-gray-200 dark:text-gray-600">0.00</span>}
                          </td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-gray-500 dark:text-gray-400">{inv.line_items?.length ?? 0}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums font-semibold text-gray-900 dark:text-gray-100 whitespace-nowrap">
                            ₹{formatINR(d.total)}
                          </td>
                          <td className="px-2 py-2.5">
                            <button
                              onClick={() => setEditingIdx(i)}
                              className="text-gray-400 hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors"
                              title="Edit invoice"
                            >
                              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                              </svg>
                            </button>
                          </td>
                        </tr>
                        {/* Validation warning row */}
                        {hasWarning && !isExcluded && !isOverLimitRow && (
                          <tr key={`warn-${i}`} className="border-t-0">
                            <td colSpan={3} />
                            <td colSpan={12} className="px-3 pb-1.5">
                              <div className="flex flex-wrap gap-1.5">
                                {flags.map((f) => (
                                  <span key={f} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${
                                    readiness === 'critical'
                                      ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                                      : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
                                  }`}>
                                    {f}
                                  </span>
                                ))}
                              </div>
                            </td>
                          </tr>
                        )}
                      </>
                    );
                  })}
                </tbody>

                {/* Totals footer (accepted invoices only) */}
                <tfoot className="bg-gray-50 dark:bg-gray-800 border-t-2 border-gray-200 dark:border-gray-700">
                  <tr>
                    <td colSpan={7} className="px-3 py-2.5 text-xs font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wide">
                      Total — {acceptedCount.toLocaleString()} invoice{acceptedCount !== 1 ? 's' : ''}
                      {excludedIndices.size > 0 && (
                        <span className="ml-2 font-normal text-red-500 dark:text-red-400 normal-case">({excludedIndices.size} excluded)</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums font-bold text-gray-900 dark:text-gray-100 whitespace-nowrap">{formatINR(totalTaxable)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums font-bold text-gray-900 dark:text-gray-100 whitespace-nowrap">{totalCGST > 0 ? formatINR(totalCGST) : '0.00'}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums font-bold text-gray-900 dark:text-gray-100 whitespace-nowrap">{totalSGST > 0 ? formatINR(totalSGST) : '0.00'}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums font-bold text-gray-900 dark:text-gray-100 whitespace-nowrap">{totalIGST > 0 ? formatINR(totalIGST) : '0.00'}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums font-bold text-gray-900 dark:text-gray-100 whitespace-nowrap text-xs">
                      {totalRoundOff !== 0 ? (totalRoundOff > 0 ? '+' : '') + formatINR(totalRoundOff) : '0.00'}
                    </td>
                    <td className="px-3 py-2.5" />
                    <td className="px-3 py-2.5 text-right tabular-nums font-bold text-gray-900 dark:text-gray-100 whitespace-nowrap">₹{formatINR(grandTotal)}</td>
                    <td className="px-2 py-2.5" />
                  </tr>
                </tfoot>
              </table>
            </div>

            {/* Parse error details */}
            {parseErrors.length > 0 && (
              <div className="mb-4 p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg">
                <p className="text-xs font-semibold text-amber-700 dark:text-amber-400 mb-1">
                  {parseErrors.length} rows skipped during parsing:
                </p>
                <ul className="text-xs text-amber-700 dark:text-amber-400 space-y-0.5 max-h-32 overflow-y-auto">
                  {parseErrors.map((e, i) => (
                    <li key={i}>Row {e.row}: {e.reason}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* Action bar */}
            <div className="flex items-center gap-3 flex-wrap">
              <button
                onClick={handleImport}
                disabled={saving || success || showDuplicateWarning || acceptedCount === 0}
                className="px-5 py-2.5 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {saving ? 'Checking…' : `Import ${acceptedCount.toLocaleString()} Invoice${acceptedCount !== 1 ? 's' : ''}${excludedIndices.size > 0 ? ` (${excludedIndices.size} excluded)` : ''}`}
              </button>
              {excludedIndices.size > 0 && (
                <button
                  onClick={() => setExcludedIndices(new Set())}
                  className="px-4 py-2.5 border border-gray-300 dark:border-gray-600 text-sm text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                >
                  Include All
                </button>
              )}
              <button
                onClick={() => fileRef.current?.click()}
                className="px-4 py-2.5 border border-gray-300 dark:border-gray-600 text-sm text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
              >
                Change File
              </button>
              <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleFileInput} />
            </div>
          </>
        )}

        {/* Column guide */}
        {!invoices.length && !loading && (
          <div className="mt-8 p-4 bg-gray-50 dark:bg-gray-800 rounded-lg">
            <p className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-2">Expected columns (case-insensitive):</p>
            <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-xs text-gray-500 dark:text-gray-400">
              <span>Invoice Number / Invoice No / Inv No</span>
              <span>Invoice Date / Date</span>
              <span>Customer Name / Party Name / Buyer Name</span>
              <span>Customer GSTIN / GSTIN / Buyer GSTIN</span>
              <span>Item Description / Description / Product</span>
              <span>HSN / HSN Code</span>
              <span>Quantity / Qty</span>
              <span>Rate / Unit Price</span>
              <span>Taxable Amount / Taxable Value</span>
              <span>CGST Amount / CGST</span>
              <span>SGST Amount / SGST</span>
              <span>IGST Amount / IGST</span>
              <span>Total / Grand Total / Invoice Total</span>
              <span></span>
            </div>
          </div>
        )}
      </div>
    </AppLayout>
  );
}
