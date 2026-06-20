'use client';

import { useState, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { parseExcelSalesFile } from '@/lib/salesExtract';
import { createSalesBatch, insertAcceptedSalesExcelInvoices } from '@/lib/salesDb';
import { learnCustomerName } from '@/lib/customers';
import type { ExtractedInvoice } from '@/types/invoice';
import { formatINR } from '@/types/invoice';
import AppLayout from '@/components/AppLayout';
import FYPeriodSelector from '@/components/FYPeriodSelector';
import { currentFY } from '@/lib/fyPeriod';
import { useCompany } from '@/lib/companyContext';

function getErrMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'object' && e !== null && 'message' in e) return String((e as { message: unknown }).message);
  return 'Unknown error';
}

export default function SalesExcelImportPage() {
  const router = useRouter();
  const { company } = useCompany();
  const fileRef = useRef<HTMLInputElement>(null);

  const [fy, setFy] = useState(currentFY());
  const [invoices, setInvoices] = useState<ExtractedInvoice[]>([]);
  const [parseErrors, setParseErrors] = useState<Array<{ row: number; reason: string }>>([]);
  const [filename, setFilename] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const handleFile = useCallback(async (file: File) => {
    setLoading(true);
    setError(null);
    setInvoices([]);
    setParseErrors([]);
    try {
      const result = await parseExcelSalesFile(file);
      setFilename(file.name);
      setInvoices(result.invoices);
      setParseErrors(result.errors);
    } catch (e) {
      setError(`Failed to parse file: ${getErrMsg(e)}`);
    } finally {
      setLoading(false);
    }
  }, []);

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
    try {
      const session = await getSession();
      if (!session) { router.push('/login'); return; }
      if (!company) { router.push('/select-company'); return; }

      const batchId = await createSalesBatch(company.id, 1, fy, 'excel_import');
      const items = invoices.map((inv) => ({ inv, filename }));
      await insertAcceptedSalesExcelInvoices(company.id, batchId, items, fy);

      // Learn customer names for GSTIN-bearing invoices
      for (const inv of invoices) {
        if (inv.buyer_gstin && inv.buyer_name) {
          await learnCustomerName(company.id, inv.buyer_gstin, inv.buyer_name).catch(() => {});
        }
      }

      setSuccess(true);
      setTimeout(() => router.push('/sales/register'), 1200);
    } catch (e) {
      setError(getErrMsg(e));
    } finally {
      setSaving(false);
    }
  };

  const totalTaxable = invoices.reduce((s, inv) => s + (inv.subtotal ?? 0), 0);
  const totalGst = invoices.reduce((s, inv) => s + (inv.cgst ?? 0) + (inv.sgst ?? 0) + (inv.igst ?? 0), 0);
  const totalAmount = invoices.reduce((s, inv) => s + (inv.total ?? 0), 0);

  return (
    <AppLayout>
      <div className="max-w-5xl mx-auto px-4 py-8">
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
            ✓ {invoices.length} invoices imported. Redirecting to Sales Register…
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
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              className="hidden"
              onChange={handleFileInput}
            />
          </div>
        )}

        {loading && (
          <div className="text-center py-8 text-gray-500 dark:text-gray-400">
            Parsing file…
          </div>
        )}

        {/* Preview table */}
        {invoices.length > 0 && (
          <>
            <div className="mb-4 flex items-center justify-between">
              <div>
                <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                  {invoices.length} invoices from{' '}
                  <span className="font-mono text-xs bg-gray-100 dark:bg-gray-800 px-1 rounded">{filename}</span>
                </span>
              </div>
              <button
                onClick={() => { setInvoices([]); setParseErrors([]); setFilename(''); setError(null); }}
                className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
              >
                Clear
              </button>
            </div>

            <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700 mb-4">
              <table className="w-full text-xs">
                <thead className="bg-gray-50 dark:bg-gray-800">
                  <tr>
                    {['Invoice #', 'Date', 'Customer', 'GSTIN', 'Taxable', 'GST', 'Total', 'Items'].map((h) => (
                      <th key={h} className="px-3 py-2 text-left font-semibold text-gray-600 dark:text-gray-400">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                  {invoices.map((inv, i) => {
                    const gst = (inv.cgst ?? 0) + (inv.sgst ?? 0) + (inv.igst ?? 0);
                    return (
                      <tr key={i} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                        <td className="px-3 py-2 font-mono text-gray-900 dark:text-gray-100">{inv.invoice_number}</td>
                        <td className="px-3 py-2 text-gray-600 dark:text-gray-400">{inv.invoice_date}</td>
                        <td className="px-3 py-2 text-gray-900 dark:text-gray-100">{inv.buyer_name}</td>
                        <td className="px-3 py-2 font-mono text-gray-500 dark:text-gray-400">{inv.buyer_gstin || 'B2C'}</td>
                        <td className="px-3 py-2 text-right text-gray-900 dark:text-gray-100">{formatINR(inv.subtotal ?? 0)}</td>
                        <td className="px-3 py-2 text-right text-gray-600 dark:text-gray-400">{formatINR(gst)}</td>
                        <td className="px-3 py-2 text-right font-medium text-gray-900 dark:text-gray-100">{formatINR(inv.total ?? 0)}</td>
                        <td className="px-3 py-2 text-center text-gray-500 dark:text-gray-400">{inv.line_items?.length ?? 0}</td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot className="bg-gray-50 dark:bg-gray-800 font-semibold">
                  <tr>
                    <td colSpan={4} className="px-3 py-2 text-gray-600 dark:text-gray-400">Total ({invoices.length} invoices)</td>
                    <td className="px-3 py-2 text-right text-gray-900 dark:text-gray-100">{formatINR(totalTaxable)}</td>
                    <td className="px-3 py-2 text-right text-gray-600 dark:text-gray-400">{formatINR(totalGst)}</td>
                    <td className="px-3 py-2 text-right text-gray-900 dark:text-gray-100">{formatINR(totalAmount)}</td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>

            {parseErrors.length > 0 && (
              <div className="mb-4 p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg">
                <p className="text-xs font-semibold text-amber-700 dark:text-amber-400 mb-1">
                  {parseErrors.length} rows skipped:
                </p>
                <ul className="text-xs text-amber-700 dark:text-amber-400 space-y-0.5 max-h-32 overflow-y-auto">
                  {parseErrors.map((e, i) => (
                    <li key={i}>Row {e.row}: {e.reason}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className="flex items-center gap-3">
              <button
                onClick={handleImport}
                disabled={saving || success}
                className="px-5 py-2.5 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {saving ? 'Importing…' : `Import ${invoices.length} Invoice${invoices.length !== 1 ? 's' : ''}`}
              </button>
              <button
                onClick={() => fileRef.current?.click()}
                className="px-4 py-2.5 border border-gray-300 dark:border-gray-600 text-sm text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
              >
                Change File
              </button>
              <input
                ref={fileRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                className="hidden"
                onChange={handleFileInput}
              />
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
