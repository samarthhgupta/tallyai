'use client';

import { useState, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { parseExcelSalesFile } from '@/lib/salesExtract';
import { createSalesBatch, insertAcceptedSalesExcelInvoices, checkExcelDuplicates, computeSalesReadiness } from '@/lib/salesDb';
import { learnCustomerName } from '@/lib/customers';
import type { ExtractedInvoice, LineItem } from '@/types/invoice';
import { formatINR } from '@/types/invoice';
import AppLayout from '@/components/AppLayout';
import FYPeriodSelector from '@/components/FYPeriodSelector';
import { currentFY } from '@/lib/fyPeriod';
import { useCompany } from '@/lib/companyContext';
import { MAX_IMPORT_INVOICES } from '@/lib/importConstants';

function getErrMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'object' && e !== null && 'message' in e) return String((e as { message: unknown }).message);
  return 'Unknown error';
}

// ─── Readiness badge ──────────────────────────────────────────────────────────

function ReadinessBadge({ readiness }: { readiness: 'ready' | 'warning' | 'critical' }) {
  if (readiness === 'ready')
    return <span className="text-green-600 dark:text-green-400 font-semibold text-xs">✓</span>;
  if (readiness === 'warning')
    return <span className="text-amber-500 dark:text-amber-400 font-semibold text-xs">⚠</span>;
  return <span className="text-red-600 dark:text-red-400 font-semibold text-xs">✗</span>;
}

// ─── Invoice edit drawer ──────────────────────────────────────────────────────

interface EditDrawerProps {
  inv: ExtractedInvoice;
  onSave: (updated: ExtractedInvoice) => void;
  onClose: () => void;
}

function EditDrawer({ inv, onSave, onClose }: EditDrawerProps) {
  const [invoiceNumber, setInvoiceNumber] = useState(inv.invoice_number ?? '');
  const [invoiceDate, setInvoiceDate] = useState(inv.invoice_date ?? '');
  const [buyerName, setBuyerName] = useState(inv.buyer_name ?? '');
  const [buyerGstin, setBuyerGstin] = useState(inv.buyer_gstin ?? '');
  const [lineItems, setLineItems] = useState<LineItem[]>(
    inv.line_items?.map((li) => ({ ...li })) ?? [],
  );

  const updateLineItem = (i: number, field: keyof LineItem, value: string | number) => {
    setLineItems((prev) => prev.map((li, idx) => idx === i ? { ...li, [field]: value } : li));
  };

  const handleSave = () => {
    // Recompute totals from line items
    const subtotal = lineItems.reduce((s, li) => s + (li.amount ?? 0), 0);
    const gstPct = lineItems[0]?.gst_percent ?? 0;
    const isIgst = (inv.tax_type === 'igst');
    const cgst = isIgst ? 0 : Math.round(subtotal * (gstPct / 2) / 100 * 100) / 100;
    const sgst = isIgst ? 0 : cgst;
    const igst = isIgst ? Math.round(subtotal * gstPct / 100 * 100) / 100 : 0;
    const total = subtotal + cgst + sgst + igst;
    onSave({
      ...inv,
      invoice_number: invoiceNumber,
      invoice_date: invoiceDate,
      buyer_name: buyerName,
      buyer_gstin: buyerGstin,
      line_items: lineItems,
      subtotal,
      cgst,
      sgst,
      igst,
      total,
    });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex" onClick={onClose}>
      <div className="flex-1 bg-black/40" />
      <div
        className="w-full max-w-lg bg-white dark:bg-gray-900 shadow-2xl overflow-y-auto flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 dark:border-gray-700">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Edit Invoice</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 text-lg leading-none">&times;</button>
        </div>

        <div className="flex-1 px-5 py-4 space-y-4">
          {/* Header fields */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Invoice Number</label>
              <input
                className="w-full px-2.5 py-1.5 text-xs border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                value={invoiceNumber}
                onChange={(e) => setInvoiceNumber(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Invoice Date</label>
              <input
                className="w-full px-2.5 py-1.5 text-xs border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                value={invoiceDate}
                onChange={(e) => setInvoiceDate(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Customer Name</label>
              <input
                className="w-full px-2.5 py-1.5 text-xs border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                value={buyerName}
                onChange={(e) => setBuyerName(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Customer GSTIN</label>
              <input
                className="w-full px-2.5 py-1.5 text-xs border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                value={buyerGstin}
                onChange={(e) => setBuyerGstin(e.target.value.toUpperCase())}
              />
            </div>
          </div>

          {/* Line items */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-semibold text-gray-700 dark:text-gray-300">Line Items</p>
              <button
                onClick={() => setLineItems((prev) => [...prev, { description: '', hsn: '', gst_percent: 0, uom: 'Nos', qty: 1, rate: 0, disc_percent: 0, amount: 0 }])}
                className="text-xs text-indigo-600 dark:text-indigo-400 hover:underline"
              >
                + Add item
              </button>
            </div>
            <div className="space-y-2">
              {lineItems.map((li, i) => (
                <div key={i} className="grid grid-cols-12 gap-1.5 items-start text-xs">
                  <div className="col-span-5">
                    <label className="block text-gray-400 mb-0.5">Description</label>
                    <input
                      className="w-full px-2 py-1 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                      value={li.description}
                      onChange={(e) => updateLineItem(i, 'description', e.target.value)}
                    />
                  </div>
                  <div className="col-span-2">
                    <label className="block text-gray-400 mb-0.5">HSN</label>
                    <input
                      className="w-full px-2 py-1 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                      value={li.hsn}
                      onChange={(e) => updateLineItem(i, 'hsn', e.target.value)}
                    />
                  </div>
                  <div className="col-span-2">
                    <label className="block text-gray-400 mb-0.5">GST %</label>
                    <input
                      type="number"
                      className="w-full px-2 py-1 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                      value={li.gst_percent}
                      onChange={(e) => updateLineItem(i, 'gst_percent', Number(e.target.value))}
                    />
                  </div>
                  <div className="col-span-2">
                    <label className="block text-gray-400 mb-0.5">Amount</label>
                    <input
                      type="number"
                      className="w-full px-2 py-1 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                      value={li.amount}
                      onChange={(e) => updateLineItem(i, 'amount', Number(e.target.value))}
                    />
                  </div>
                  <div className="col-span-1 flex items-end pb-0.5">
                    <button
                      onClick={() => setLineItems((prev) => prev.filter((_, idx) => idx !== i))}
                      className="text-red-400 hover:text-red-600 text-base leading-none mt-4"
                      title="Remove"
                    >×</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="px-5 py-4 border-t border-gray-200 dark:border-gray-700 flex gap-2">
          <button
            onClick={handleSave}
            className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors"
          >
            Save Changes
          </button>
          <button
            onClick={onClose}
            className="px-4 py-2 border border-gray-300 dark:border-gray-600 text-sm text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Over-limit popup ─────────────────────────────────────────────────────────

interface OverLimitPopupProps {
  total: number;
  limit: number;
  onProceed: () => void;
  onCancel: () => void;
}

function OverLimitPopup({ total, limit, onProceed, onCancel }: OverLimitPopupProps) {
  const excess = total - limit;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white dark:bg-gray-900 rounded-xl shadow-2xl p-6 max-w-md w-full mx-4">
        <div className="text-4xl mb-3 text-center">⚠️</div>
        <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100 text-center mb-2">
          Import Limit Exceeded
        </h3>
        <p className="text-sm text-gray-600 dark:text-gray-400 text-center mb-4">
          This file contains <strong>{total.toLocaleString()}</strong> invoices.
          Only the first <strong>{limit.toLocaleString()}</strong> invoices will be imported.
          The remaining <strong>{excess.toLocaleString()}</strong> invoices (highlighted in yellow below)
          will be excluded from this import.
        </p>
        <div className="flex gap-2 justify-center">
          <button
            onClick={onProceed}
            className="px-5 py-2 bg-amber-600 text-white text-sm font-medium rounded-lg hover:bg-amber-700 transition-colors"
          >
            Continue with first {limit.toLocaleString()}
          </button>
          <button
            onClick={onCancel}
            className="px-5 py-2 border border-gray-300 dark:border-gray-600 text-sm text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

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

  const applyParsed = useCallback((all: ExtractedInvoice[], name: string) => {
    setFilename(name);
    setAllParsedInvoices(all);
    const capped = all.slice(0, MAX_IMPORT_INVOICES);
    setInvoices(capped);
    if (all.length > MAX_IMPORT_INVOICES) {
      setPendingAll(all);
      setShowOverLimit(true);
    }
  }, []);

  const handleFile = useCallback(async (file: File) => {
    setLoading(true);
    setError(null);
    setInvoices([]);
    setAllParsedInvoices([]);
    setParseErrors([]);
    setDuplicates([]);
    setShowDuplicateWarning(false);
    setShowOverLimit(false);
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

  const handleImport = async () => {
    if (!invoices.length) return;
    setSaving(true);
    setError(null);
    setDuplicates([]);
    setShowDuplicateWarning(false);
    try {
      const session = await getSession();
      if (!session) { router.push('/login'); return; }
      if (!company) { router.push('/select-company'); return; }

      const invoiceNumbers = invoices.map((inv) => inv.invoice_number).filter(Boolean);
      const dupes = await checkExcelDuplicates(company.id, invoiceNumbers, fy);
      if (dupes.length > 0) {
        setDuplicates(dupes);
        setShowDuplicateWarning(true);
        setSaving(false);
        return;
      }
      await doImport(company.id);
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
      await doImport(company.id);
    } catch (e) {
      setError(getErrMsg(e));
    } finally {
      setSaving(false);
    }
  };

  const doImport = async (companyId: string) => {
    const batchId = await createSalesBatch(companyId, 1, fy, 'excel_import');
    const enrichedInvoices = invoices.map((inv) => ({
      ...inv,
      vendor_name: company!.name,
      vendor_gstin: company!.gstin ?? '',
    }));
    const items = enrichedInvoices.map((inv) => ({ inv, filename }));
    await insertAcceptedSalesExcelInvoices(companyId, batchId, items, fy);
    for (const inv of enrichedInvoices) {
      if (inv.buyer_gstin && inv.buyer_name) {
        await learnCustomerName(companyId, inv.buyer_gstin, inv.buyer_name).catch(() => {});
      }
    }
    setSuccess(true);
    setTimeout(() => router.push('/sales/register'), 1200);
  };

  const handleEditSave = (idx: number, updated: ExtractedInvoice) => {
    setInvoices((prev) => prev.map((inv, i) => i === idx ? updated : inv));
    setEditingIdx(null);
  };

  // Summary totals (only importable invoices)
  const totalTaxable = invoices.reduce((s, inv) => s + (inv.subtotal ?? 0), 0);
  const totalGst = invoices.reduce((s, inv) => s + (inv.cgst ?? 0) + (inv.sgst ?? 0) + (inv.igst ?? 0), 0);
  const totalAmount = invoices.reduce((s, inv) => s + (inv.total ?? 0), 0);

  const isOverLimit = allParsedInvoices.length > MAX_IMPORT_INVOICES;
  const importableCount = invoices.length;

  return (
    <AppLayout>
      {/* Over-limit popup */}
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

      {/* Edit drawer */}
      {editingIdx !== null && invoices[editingIdx] && (
        <EditDrawer
          inv={invoices[editingIdx]}
          onSave={(updated) => handleEditSave(editingIdx, updated)}
          onClose={() => setEditingIdx(null)}
        />
      )}

      <div className="max-w-6xl mx-auto px-4 py-8">
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
            ✓ {importableCount} invoices imported. Redirecting to Sales Register…
          </div>
        )}

        {/* Duplicate warning */}
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

        {/* FY Selector */}
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
            <p className="text-base font-medium text-gray-700 dark:text-gray-300">
              Drop your Excel file here
            </p>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
              Supports .xlsx, .xls, .csv — click to browse
            </p>
            <p className="text-xs text-gray-400 dark:text-gray-500 mt-2">
              Maximum {MAX_IMPORT_INVOICES.toLocaleString()} invoices can be imported at one time.
            </p>
            <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleFileInput} />
          </div>
        )}

        {loading && (
          <div className="text-center py-8 text-gray-500 dark:text-gray-400">Parsing file…</div>
        )}

        {/* Preview table */}
        {invoices.length > 0 && (
          <>
            {/* Summary bar */}
            <div className="mb-4 flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center gap-3 flex-wrap text-sm">
                <span className="font-medium text-gray-700 dark:text-gray-300">
                  {importableCount.toLocaleString()} invoices
                  {isOverLimit && (
                    <span className="ml-2 text-xs text-amber-600 dark:text-amber-400 font-normal">
                      (of {allParsedInvoices.length.toLocaleString()} detected — capped at {MAX_IMPORT_INVOICES.toLocaleString()})
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
                </span>
              </div>
              <button
                onClick={() => { setInvoices([]); setAllParsedInvoices([]); setParseErrors([]); setFilename(''); setError(null); setDuplicates([]); setShowDuplicateWarning(false); }}
                className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
              >
                Clear
              </button>
            </div>

            {/* Over-limit warning banner */}
            {isOverLimit && (
              <div className="mb-4 p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-300 dark:border-amber-700 rounded-lg text-sm text-amber-700 dark:text-amber-400">
                <strong>Import cap applied.</strong> Only the first {MAX_IMPORT_INVOICES.toLocaleString()} invoices are shown and will be imported.
                The remaining {(allParsedInvoices.length - MAX_IMPORT_INVOICES).toLocaleString()} invoices from this file are excluded.
                Split the file to import them separately.
              </div>
            )}

            {/* Register-style preview table */}
            <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700 mb-4">
              <table className="w-full text-xs">
                <thead className="bg-gray-50 dark:bg-gray-800 sticky top-0">
                  <tr>
                    <th className="px-3 py-2 text-center text-gray-500 dark:text-gray-400 w-8">St.</th>
                    <th className="px-3 py-2 text-left font-semibold text-gray-600 dark:text-gray-400">Invoice #</th>
                    <th className="px-3 py-2 text-left font-semibold text-gray-600 dark:text-gray-400">Date</th>
                    <th className="px-3 py-2 text-left font-semibold text-gray-600 dark:text-gray-400">Customer</th>
                    <th className="px-3 py-2 text-left font-semibold text-gray-600 dark:text-gray-400">GSTIN</th>
                    <th className="px-3 py-2 text-right font-semibold text-gray-600 dark:text-gray-400">Taxable</th>
                    <th className="px-3 py-2 text-right font-semibold text-gray-600 dark:text-gray-400">GST</th>
                    <th className="px-3 py-2 text-right font-semibold text-gray-600 dark:text-gray-400">Total</th>
                    <th className="px-3 py-2 text-center font-semibold text-gray-600 dark:text-gray-400">Items</th>
                    <th className="px-3 py-2 text-center font-semibold text-gray-600 dark:text-gray-400">Edit</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                  {invoices.map((inv, i) => {
                    const gst = (inv.cgst ?? 0) + (inv.sgst ?? 0) + (inv.igst ?? 0);
                    const isDupe = duplicates.includes(inv.invoice_number);
                    const { readiness, flags } = computeSalesReadiness(inv);
                    const hasWarning = readiness !== 'ready';
                    return (
                      <>
                        <tr
                          key={`row-${i}`}
                          className={[
                            'hover:bg-gray-50 dark:hover:bg-gray-800/50',
                            isDupe ? 'bg-amber-50 dark:bg-amber-900/10' : '',
                            hasWarning ? 'bg-amber-50/50 dark:bg-amber-900/5' : '',
                          ].join(' ')}
                        >
                          <td className="px-3 py-2 text-center">
                            <ReadinessBadge readiness={readiness} />
                          </td>
                          <td className="px-3 py-2 font-mono text-gray-900 dark:text-gray-100">
                            {inv.invoice_number || <span className="text-red-400 italic">missing</span>}
                            {isDupe && <span className="ml-1.5 text-amber-600 dark:text-amber-400 text-xs font-semibold">dup</span>}
                          </td>
                          <td className="px-3 py-2 text-gray-600 dark:text-gray-400">{inv.invoice_date}</td>
                          <td className="px-3 py-2 text-gray-900 dark:text-gray-100 max-w-[180px] truncate" title={inv.buyer_name ?? undefined}>
                            {inv.buyer_name || <span className="text-red-400 italic">missing</span>}
                          </td>
                          <td className="px-3 py-2 font-mono text-gray-500 dark:text-gray-400">
                            {inv.buyer_gstin || <span className="text-gray-400 italic">B2C</span>}
                          </td>
                          <td className="px-3 py-2 text-right text-gray-900 dark:text-gray-100">{formatINR(inv.subtotal ?? 0)}</td>
                          <td className="px-3 py-2 text-right text-gray-600 dark:text-gray-400">{formatINR(gst)}</td>
                          <td className="px-3 py-2 text-right font-medium text-gray-900 dark:text-gray-100">{formatINR(inv.total ?? 0)}</td>
                          <td className="px-3 py-2 text-center text-gray-500 dark:text-gray-400">{inv.line_items?.length ?? 0}</td>
                          <td className="px-3 py-2 text-center">
                            <button
                              onClick={() => setEditingIdx(i)}
                              className="text-indigo-500 hover:text-indigo-700 dark:hover:text-indigo-300 font-medium"
                              title="Edit invoice"
                            >
                              ✏
                            </button>
                          </td>
                        </tr>
                        {/* Validation warning row */}
                        {hasWarning && (
                          <tr key={`warn-${i}`} className="bg-amber-50/50 dark:bg-amber-900/5 border-t-0">
                            <td className="px-3 pb-1.5" />
                            <td colSpan={9} className="px-3 pb-1.5">
                              <div className="flex flex-wrap gap-2">
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
                <tfoot className="bg-gray-50 dark:bg-gray-800 font-semibold">
                  <tr>
                    <td />
                    <td colSpan={4} className="px-3 py-2 text-gray-600 dark:text-gray-400">
                      Total ({importableCount.toLocaleString()} invoices)
                    </td>
                    <td className="px-3 py-2 text-right text-gray-900 dark:text-gray-100">{formatINR(totalTaxable)}</td>
                    <td className="px-3 py-2 text-right text-gray-600 dark:text-gray-400">{formatINR(totalGst)}</td>
                    <td className="px-3 py-2 text-right text-gray-900 dark:text-gray-100">{formatINR(totalAmount)}</td>
                    <td colSpan={2} />
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

            {/* Action buttons */}
            <div className="flex items-center gap-3">
              <button
                onClick={handleImport}
                disabled={saving || success || showDuplicateWarning}
                className="px-5 py-2.5 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {saving ? 'Checking…' : `Import ${importableCount.toLocaleString()} Invoice${importableCount !== 1 ? 's' : ''}`}
              </button>
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
