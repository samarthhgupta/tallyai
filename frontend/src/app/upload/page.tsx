'use client';

import { useState, useRef, useCallback } from 'react';
import { extractInvoices } from '@/lib/extract';
import type {
  ExtractedInvoice,
  FileResult,
  ExtractionResponse,
  LineItem,
  HsnRow,
} from '@/types/invoice';
import {
  formatINR,
  getStateFromGstin,
  calcLineAmount,
  buildHsnSummary,
} from '@/types/invoice';

// ─── Sidebar ──────────────────────────────────────────────────────────────────

function Sidebar() {
  return (
    <aside className="fixed top-0 left-0 h-full w-60 bg-white border-r border-gray-200 flex flex-col z-20">
      <div className="flex items-center gap-2 px-5 py-5 border-b border-gray-100">
        <div className="w-8 h-8 bg-indigo-600 rounded-md flex items-center justify-center shrink-0">
          <span className="text-white font-bold text-sm">T</span>
        </div>
        <span className="text-lg font-semibold text-gray-900">TallyAI</span>
      </div>
      <nav className="flex-1 px-3 py-4 space-y-1">
        <div className="w-full text-left px-3 py-2 rounded-md text-sm font-medium bg-indigo-50 text-indigo-700">
          Dashboard
        </div>
        <div className="w-full text-left px-3 py-2 rounded-md text-sm font-medium text-gray-400 cursor-not-allowed">
          History <span className="text-xs">(coming soon)</span>
        </div>
        <div className="w-full text-left px-3 py-2 rounded-md text-sm font-medium text-gray-400 cursor-not-allowed">
          Settings <span className="text-xs">(coming soon)</span>
        </div>
      </nav>
    </aside>
  );
}

// ─── Confidence ───────────────────────────────────────────────────────────────

function ConfidenceBadge({ score }: { score: number }) {
  const pct = Math.round(score * 100);
  if (pct >= 80) return (
    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-700">
      High {pct}%
    </span>
  );
  if (pct >= 60) return (
    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-700">
      Medium {pct}%
    </span>
  );
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-700">
      Low {pct}%
    </span>
  );
}

function ConfidenceBar({ score }: { score: number }) {
  const pct = Math.round(score * 100);
  const color = pct >= 80 ? 'bg-green-500' : pct >= 60 ? 'bg-amber-400' : 'bg-red-500';
  return (
    <div className="flex items-center gap-2">
      <div className="w-20 h-2 bg-gray-200 rounded-full overflow-hidden">
        <div className={`h-full ${color} rounded-full`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-gray-500">{pct}%</span>
    </div>
  );
}

// ─── Review Banner ────────────────────────────────────────────────────────────

function ReviewBanner({ computedTotal, invoiceTotal, autoDetectedDiscount, sourceUrl, onDismiss }: {
  computedTotal: number;
  invoiceTotal: number;
  autoDetectedDiscount?: boolean;
  sourceUrl?: string;
  onDismiss: () => void;
}) {
  const diff = Math.abs(computedTotal - invoiceTotal);
  return (
    <div className="mx-5 mt-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3">
      <div className="flex items-start gap-3">
        <svg className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
        </svg>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-amber-800">Human review required</p>
          {autoDetectedDiscount ? (
            <p className="text-sm text-amber-700 mt-0.5">
              A bill-level discount of <strong>₹{formatINR(diff)}</strong> was <strong>auto-detected</strong> from the total mismatch and applied automatically.
              Please verify against the original invoice — look for "Less", "Discount", or a "−" sign near this amount.
              If correct, approve it; if wrong, the extracted data needs manual correction.
            </p>
          ) : (
            <p className="text-sm text-amber-700 mt-0.5">
              Computed total <strong>₹{formatINR(computedTotal)}</strong> differs from invoice total <strong>₹{formatINR(invoiceTotal)}</strong> by <strong>₹{formatINR(diff)}</strong>.
              This could be a missed discount, a rounding difference, or an extraction error.
            </p>
          )}
          <p className="text-xs text-amber-600 mt-1">
            Please open the original invoice and verify each line item, any "Less" / discount rows, and the final total.
          </p>
          <div className="flex items-center gap-3 mt-2">
            {sourceUrl && (
              <a
                href={sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-800 underline hover:text-amber-900"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                </svg>
                Open original invoice
              </a>
            )}
            <button
              onClick={onDismiss}
              className="text-xs font-medium text-amber-700 hover:text-amber-900 underline"
            >
              Mark as reviewed ✓
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Invoice Card ─────────────────────────────────────────────────────────────

function InvoiceCard({ inv, sourceUrl }: { inv: ExtractedInvoice; sourceUrl?: string }) {
  const [reviewed, setReviewed] = useState(false);
  const vendorState = inv.vendor_gstin ? getStateFromGstin(inv.vendor_gstin) : null;
  const taxType = inv.tax_type;
  const computedSubtotal = inv.line_items.reduce((s, item) => s + calcLineAmount(item), 0);
  const billDiscount = inv.bill_discount_amount ?? 0;
  const hsnRows: HsnRow[] = buildHsnSummary(inv.line_items, taxType, billDiscount);
  const taxableValue = computedSubtotal - billDiscount;
  const computedTax = hsnRows.reduce((s, r) => s + r.cgst + r.sgst + r.igst, 0);
  const computedTotal = taxableValue + computedTax + (inv.round_off || 0);
  const needsReview = !reviewed && inv.total > 0 && Math.abs(computedTotal - inv.total) > 1;

  return (
    <div className={`bg-white rounded-lg border shadow-sm overflow-hidden ${needsReview ? 'border-amber-300' : 'border-gray-200'}`}>
      {/* Header */}
      <div className="px-5 py-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 flex-wrap">
              <span className="font-semibold text-gray-900">{inv.vendor_name || 'Unknown Vendor'}</span>
              <ConfidenceBadge score={inv.confidence} />
              {needsReview && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-700 border border-amber-300">
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                  </svg>
                  Needs Review
                </span>
              )}
              {sourceUrl && (
                <a
                  href={sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-indigo-600 hover:text-indigo-800 hover:underline"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                  </svg>
                  View original
                </a>
              )}
            </div>
            <div className="mt-1 flex items-center gap-2 flex-wrap text-sm text-gray-500">
              {inv.invoice_number && <span>Invoice #{inv.invoice_number}</span>}
              {inv.invoice_date && <span>· {inv.invoice_date}</span>}
              {inv.vendor_gstin && (
                <span>· GSTIN: <span className="font-mono text-xs">{inv.vendor_gstin}</span></span>
              )}
              {vendorState && vendorState !== 'Unknown' && (
                <span className="text-xs bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded">{vendorState}</span>
              )}
            </div>
          </div>
          <div className="shrink-0 text-right">
            <ConfidenceBar score={inv.confidence} />
            {inv.confidence_reasons && (
              <ul className="mt-1.5 space-y-0.5">
                {inv.confidence_reasons.map((r, i) => (
                  <li key={i} className={`text-xs ${r.includes('✓') ? 'text-green-600' : 'text-red-500'}`}>
                    {r.includes('✓') ? '' : '↓ '}{r}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>

      {/* Review Banner */}
      {needsReview && (
        <ReviewBanner
          computedTotal={computedTotal}
          invoiceTotal={inv.total}
          autoDetectedDiscount={inv.bill_discount_auto_detected}
          sourceUrl={sourceUrl}
          onDismiss={() => setReviewed(true)}
        />
      )}

      {/* Line Items */}
      {inv.line_items.length > 0 && (
        <div className="px-5 pb-3 border-t border-gray-100 pt-4">
          <h4 className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">Line Items</h4>
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="bg-gray-50">
                  {['HSN @ Rate%', 'UOM', 'Qty', 'Rate (ex-GST)', 'Disc%', 'Amount'].map((h) => (
                    <th key={h} className="text-left px-2 py-2 text-xs text-gray-500 font-medium border border-gray-200 whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {inv.line_items.map((item: LineItem, i: number) => (
                  <tr key={i} className="hover:bg-gray-50">
                    <td className="px-2 py-1.5 border border-gray-200 font-mono text-xs">
                      {item.hsn.replace(/[\s.]/g, '') || '—'} @ {item.gst_percent}%
                    </td>
                    <td className="px-2 py-1.5 border border-gray-200 text-xs">{item.uom || '—'}</td>
                    <td className="px-2 py-1.5 border border-gray-200 text-right">{item.qty}</td>
                    <td className="px-2 py-1.5 border border-gray-200 text-right">{formatINR(item.rate)}</td>
                    <td className="px-2 py-1.5 border border-gray-200 text-right">{item.disc_percent}%</td>
                    <td className="px-2 py-1.5 border border-gray-200 text-right font-medium">{formatINR(calcLineAmount(item))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* HSN Summary */}
      {hsnRows.length > 0 && (
        <div className="px-5 pb-3 pt-3 border-t border-gray-100">
          <h4 className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">HSN Summary</h4>
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="bg-gray-50">
                  {['HSN', 'GST%', 'Taxable', 'CGST', 'SGST', 'IGST', 'Status'].map((h) => (
                    <th key={h} className="text-left px-2 py-2 text-xs text-gray-500 font-medium border border-gray-200 whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {hsnRows.map((row: HsnRow, i: number) => {
                  const calcTax = row.cgst + row.sgst + row.igst;
                  // vendorTax: expected tax for this HSN group, applying discount share
                  const groupRawTaxable = inv.line_items
                    .filter((it) => it.hsn === row.hsn && it.gst_percent === row.gst_percent)
                    .reduce((s, it) => s + calcLineAmount(it), 0);
                  const discountShare = computedSubtotal > 0 && billDiscount > 0
                    ? billDiscount * (groupRawTaxable / computedSubtotal)
                    : 0;
                  const adjustedGroupTaxable = groupRawTaxable - discountShare;
                  const vendorTax = adjustedGroupTaxable * row.gst_percent / 100;
                  // Also flag mismatch if there's an unexplained total gap (e.g. 0% GST items)
                  const hasUnexplainedGap = needsReview && row.gst_percent === 0;
                  const match = !hasUnexplainedGap && Math.abs(calcTax - vendorTax) <= 1;
                  return (
                    <tr key={i} className="hover:bg-gray-50">
                      <td className="px-2 py-1.5 border border-gray-200 font-mono text-xs">{row.hsn}</td>
                      <td className="px-2 py-1.5 border border-gray-200 text-right">{row.gst_percent}%</td>
                      <td className="px-2 py-1.5 border border-gray-200 text-right">{formatINR(row.taxable)}</td>
                      <td className="px-2 py-1.5 border border-gray-200 text-right">{row.cgst > 0 ? formatINR(row.cgst) : '—'}</td>
                      <td className="px-2 py-1.5 border border-gray-200 text-right">{row.sgst > 0 ? formatINR(row.sgst) : '—'}</td>
                      <td className="px-2 py-1.5 border border-gray-200 text-right">{row.igst > 0 ? formatINR(row.igst) : '—'}</td>
                      <td className="px-2 py-1.5 border border-gray-200">
                        <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${match ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                          {match ? '✓ Match' : '✗ Mismatch'}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Totals */}
      <div className="px-5 py-3 bg-gray-50 border-t border-gray-200 flex flex-wrap items-center gap-4 text-sm">
        <span className="text-gray-600">Subtotal: <strong>{formatINR(computedSubtotal)}</strong></span>
        {billDiscount > 0 && (
          <span className="text-orange-600">
            Discount: <strong>−{formatINR(billDiscount)}</strong>
            {inv.bill_discount_percent != null && (
              <span className="text-xs ml-1">({inv.bill_discount_percent}%)</span>
            )}
            <span className="text-xs ml-1 text-gray-400">→ Discount Ledger</span>
          </span>
        )}
        {billDiscount > 0 && (
          <span className="text-gray-600">Taxable: <strong>{formatINR(taxableValue)}</strong></span>
        )}
        {taxType === 'cgst_sgst' ? (
          <>
            <span className="text-gray-600">CGST: <strong>{formatINR(computedTax / 2)}</strong></span>
            <span className="text-gray-600">SGST: <strong>{formatINR(computedTax / 2)}</strong></span>
          </>
        ) : (
          <span className="text-gray-600">IGST: <strong>{formatINR(computedTax)}</strong></span>
        )}
        {(inv.round_off ?? 0) !== 0 && (
          <span className="text-gray-400 text-xs">Round off: {formatINR(inv.round_off)}</span>
        )}
        <span className="ml-auto font-semibold text-gray-900 text-base">Total: ₹{formatINR(computedTotal)}</span>
      </div>
    </div>
  );
}

// ─── Main ──────────────────────────────────────────────────────────────────────

export default function UploadPage() {
  const [files, setFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [extractError, setExtractError] = useState('');
  const [result, setResult] = useState<ExtractionResponse | null>(null);
  const [fileUrls, setFileUrls] = useState<Record<string, string>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);

  const ACCEPT = '.pdf,.jpg,.jpeg,.png,.doc,.docx';

  const isValidFile = (f: File) => {
    const name = f.name.toLowerCase();
    return ['.pdf', '.jpg', '.jpeg', '.png', '.doc', '.docx'].some((ext) => name.endsWith(ext));
  };

  const addFiles = useCallback((incoming: FileList | File[]) => {
    const valid = Array.from(incoming).filter(isValidFile);
    if (!valid.length) return;
    setFiles((prev) => {
      const names = new Set(prev.map((f) => f.name));
      return [...prev, ...valid.filter((f) => !names.has(f.name))];
    });
    setExtractError('');
  }, []);

  const removeFile = (name: string) => setFiles((prev) => prev.filter((f) => f.name !== name));

  const handleDragOver = useCallback((e: React.DragEvent) => { e.preventDefault(); setDragging(true); }, []);
  const handleDragLeave = useCallback(() => setDragging(false), []);
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files);
  }, [addFiles]);
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) addFiles(e.target.files);
    e.target.value = '';
  };

  const formatBytes = (b: number) =>
    b < 1024 ? `${b} B` : b < 1024 * 1024 ? `${(b / 1024).toFixed(1)} KB` : `${(b / (1024 * 1024)).toFixed(1)} MB`;

  const handleExtract = async () => {
    if (!files.length) return;
    setExtracting(true);
    setExtractError('');
    setResult(null);
    // Build object URLs for previewing original files
    const urls: Record<string, string> = {};
    files.forEach((f) => { urls[f.name] = URL.createObjectURL(f); });
    setFileUrls(urls);
    try {
      const data = await extractInvoices(files);
      setResult(data);
    } catch (err: unknown) {
      setExtractError(err instanceof Error ? err.message : 'Extraction failed. Please try again.');
    } finally {
      setExtracting(false);
    }
  };

  return (
    <div className="flex min-h-screen bg-gray-50">
      <Sidebar />

      <main className="ml-60 flex-1 px-6 py-8">
        <div className="max-w-5xl">
          {/* Upload card */}
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 mb-8">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Upload Invoices</h2>

            {/* Drop zone */}
            <div
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              className={`border-2 border-dashed rounded-lg p-10 text-center cursor-pointer transition-colors ${
                dragging ? 'border-indigo-400 bg-indigo-50' : 'border-gray-300 hover:border-indigo-400 hover:bg-gray-50'
              }`}
            >
              <input ref={fileInputRef} type="file" multiple accept={ACCEPT} onChange={handleFileChange} className="hidden" />
              <svg className="w-10 h-10 text-gray-300 mx-auto mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
              </svg>
              <p className="text-sm text-gray-600">
                <span className="text-indigo-600 font-medium">Drop invoices here or click to browse</span>
              </p>
              <p className="text-xs text-gray-400 mt-1">PDF, JPG, PNG, DOC, DOCX &bull; Multiple files &bull; Multi-invoice files supported</p>
            </div>

            {/* File list */}
            {files.length > 0 && (
              <ul className="mt-3 space-y-1">
                {files.map((f) => (
                  <li key={f.name} className="flex items-center justify-between bg-gray-50 rounded-md px-3 py-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <svg className="w-4 h-4 text-indigo-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                      </svg>
                      <span className="text-sm text-gray-700 truncate">{f.name}</span>
                      <span className="text-xs text-gray-400 shrink-0">{formatBytes(f.size)}</span>
                    </div>
                    <button onClick={(e) => { e.stopPropagation(); removeFile(f.name); }} className="ml-2 text-gray-400 hover:text-red-500 text-lg leading-none shrink-0">×</button>
                  </li>
                ))}
              </ul>
            )}

            {/* Progress */}
            {extracting && (
              <div className="mt-4">
                <div className="w-full h-1.5 bg-gray-200 rounded-full overflow-hidden">
                  <div className="h-full bg-indigo-500 rounded-full animate-pulse w-full" />
                </div>
                <p className="text-xs text-gray-500 mt-1 text-center">Sending to Claude AI for extraction…</p>
              </div>
            )}

            {/* Error */}
            {extractError && (
              <div className="mt-3 bg-red-50 border border-red-200 rounded-md px-3 py-2 text-sm text-red-700">{extractError}</div>
            )}

            {/* Action */}
            <div className="mt-4">
              <button
                onClick={handleExtract}
                disabled={!files.length || extracting}
                className="px-6 py-2.5 bg-indigo-600 text-white text-sm font-medium rounded-md hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
              >
                {extracting ? (
                  <>
                    <svg className="animate-spin h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    Extracting…
                  </>
                ) : (
                  `Extract ${files.length > 0 ? `${files.length} file${files.length > 1 ? 's' : ''}` : 'All'}`
                )}
              </button>
            </div>
          </div>

          {/* Results */}
          {result && (
            <div className="space-y-8">
              <div className="flex items-center justify-between">
                <h3 className="text-base font-semibold text-gray-900">
                  Extraction Results
                  <span className="ml-2 text-sm font-normal text-gray-500">
                    {result.total_invoices} invoice{result.total_invoices !== 1 ? 's' : ''} found across {result.file_results.length} file{result.file_results.length !== 1 ? 's' : ''}
                  </span>
                </h3>
              </div>

              {result.file_results.map((fr: FileResult) => (
                <div key={fr.filename}>
                  <div className="flex items-center gap-3 mb-3">
                    <span className="font-medium text-gray-800 text-sm">{fr.filename}</span>
                    <span className="text-xs bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded-full font-medium">
                      {fr.invoices.length} invoice{fr.invoices.length !== 1 ? 's' : ''}
                    </span>
                  </div>
                  {fr.error && (
                    <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700 mb-3">
                      Error: {fr.error}
                    </div>
                  )}
                  <div className="space-y-4">
                    {fr.invoices.map((inv: ExtractedInvoice, idx: number) => (
                      <InvoiceCard key={idx} inv={inv} sourceUrl={fileUrls[fr.filename]} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
