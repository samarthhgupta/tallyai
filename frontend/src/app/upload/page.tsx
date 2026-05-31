'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { extractInvoices } from '@/lib/extract';
import { loadCompanies, saveCompany, type LocalCompany } from '@/lib/companies';
import { findDuplicate, recordInvoice, type InvoiceFingerprint } from '@/lib/invoiceHistory';
import type { ExtractedInvoice, FileResult, ExtractionResponse } from '@/types/invoice';
import { InvoiceCard } from '@/components/InvoiceCard';
import { downloadBulkExcel } from '@/lib/exportExcel';

// ─── Sidebar ──────────────────────────────────────────────────────────────────

function Sidebar() {
  const router = useRouter();
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
          Upload
        </div>
        <button onClick={() => router.push('/companies')}
          className="w-full text-left px-3 py-2 rounded-md text-sm font-medium text-gray-600 hover:bg-gray-50">
          Companies
        </button>
        <div className="w-full text-left px-3 py-2 rounded-md text-sm font-medium text-gray-400 cursor-not-allowed">
          History <span className="text-xs">(coming soon)</span>
        </div>
      </nav>
    </aside>
  );
}

// ─── Main ──────────────────────────────────────────────────────────────────────

export default function UploadPage() {
  const router = useRouter();
  const [files, setFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [extractError, setExtractError] = useState('');
  const [result, setResult] = useState<ExtractionResponse | null>(null);
  const [fileUrls, setFileUrls] = useState<Record<string, string>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Company state
  const [companies, setCompanies] = useState<LocalCompany[]>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState<string>('');
  const [savedBatchId, setSavedBatchId] = useState<string | null>(null);

  const [rejectedInvoices, setRejectedInvoices] = useState<Set<string>>(new Set());
  const [currentBatchKeys, setCurrentBatchKeys] = useState<Set<string>>(new Set());
  const [invoiceOverrides, setInvoiceOverrides] = useState<Map<string, ExtractedInvoice>>(new Map());

  function handleInvoiceSave(key: string, updated: ExtractedInvoice) {
    setInvoiceOverrides((prev) => new Map(prev).set(key, updated));
  }

  // Add-company form
  const [showAddCompany, setShowAddCompany] = useState(false);
  const [newName, setNewName] = useState('');
  const [newGstin, setNewGstin] = useState('');

  useEffect(() => {
    const list = loadCompanies();
    setCompanies(list);
    if (list.length === 1) setSelectedCompanyId(list[0].id);
  }, []);

  const handleAddCompany = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;
    const c = saveCompany(newName, newGstin);
    const updated = loadCompanies();
    setCompanies(updated);
    setSelectedCompanyId(c.id);
    setNewName('');
    setNewGstin('');
    setShowAddCompany(false);
  };

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
    setSavedBatchId(null);
    const urls: Record<string, string> = {};
    files.forEach((f) => { urls[f.name] = URL.createObjectURL(f); });
    setFileUrls(urls);
    try {
      const data = await extractInvoices(files);
      const batchKeys = new Set<string>();
      data.file_results.forEach((fr) => {
        fr.invoices.forEach((inv) => {
          if (inv.invoice_number && !inv.duplicate_of) {
            // Record to history for future sessions BEFORE rendering,
            // but track the keys so we don't flag them as history duplicates right now
            recordInvoice(inv.invoice_number, inv.vendor_name, inv.invoice_date, inv.total);
            batchKeys.add(`${inv.invoice_number}__${inv.vendor_name}`);
          }
        });
      });
      setCurrentBatchKeys(batchKeys);
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

            {/* Company selector + add */}
            <div className="mb-5">
              <div className="flex items-center justify-between mb-1">
                <label className="block text-sm font-medium text-gray-700">Company</label>
                <button
                  type="button"
                  onClick={() => setShowAddCompany((v) => !v)}
                  className="text-xs text-indigo-600 hover:text-indigo-800 font-medium"
                >
                  {showAddCompany ? 'Cancel' : '+ Add company'}
                </button>
              </div>

              {showAddCompany && (
                <form onSubmit={handleAddCompany} className="mb-3 bg-indigo-50 border border-indigo-200 rounded-lg p-4 space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="col-span-2 sm:col-span-1">
                      <label className="block text-xs font-medium text-gray-600 mb-1">Company Name *</label>
                      <input
                        value={newName}
                        onChange={(e) => setNewName(e.target.value)}
                        required
                        autoFocus
                        placeholder="e.g. Atul Udyog"
                        className="w-full border border-gray-300 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      />
                    </div>
                    <div className="col-span-2 sm:col-span-1">
                      <label className="block text-xs font-medium text-gray-600 mb-1">GSTIN</label>
                      <input
                        value={newGstin}
                        onChange={(e) => setNewGstin(e.target.value.toUpperCase())}
                        placeholder="27AABCU9603R1ZX"
                        maxLength={15}
                        className="w-full border border-gray-300 rounded-md px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      />
                    </div>
                  </div>
                  <button type="submit" className="px-4 py-1.5 bg-indigo-600 text-white text-sm font-medium rounded-md hover:bg-indigo-700 transition-colors">
                    Save Company
                  </button>
                </form>
              )}

              <select
                value={selectedCompanyId}
                onChange={(e) => setSelectedCompanyId(e.target.value)}
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white"
              >
                <option value="">— Select a company —</option>
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}{c.gstin ? ` · ${c.gstin}` : ''}
                  </option>
                ))}
              </select>
              {companies.length === 0 && (
                <p className="text-xs text-gray-400 mt-1">Add a company above to enable invoice matching.</p>
              )}
            </div>

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
              <div className="flex items-center justify-between flex-wrap gap-2">
                <h3 className="text-base font-semibold text-gray-900">
                  Extraction Results
                  <span className="ml-2 text-sm font-normal text-gray-500">
                    {result.total_invoices} invoice{result.total_invoices !== 1 ? 's' : ''} found across {result.file_results.length} file{result.file_results.length !== 1 ? 's' : ''}
                  </span>
                </h3>
                <div className="flex items-center gap-3 flex-wrap">
                  {selectedCompanyId && companies.find((c) => c.id === selectedCompanyId) && (
                    <span className="text-xs text-gray-500 bg-gray-100 px-2.5 py-1 rounded-full">
                      Matching against: <strong>{companies.find((c) => c.id === selectedCompanyId)?.name}</strong>
                    </span>
                  )}
                  <button
                    onClick={() => {
                      const overridden = result.file_results.map((fr) => ({
                        ...fr,
                        invoices: fr.invoices.map((inv, idx) => invoiceOverrides.get(`${fr.filename}:${idx}`) ?? inv),
                      }));
                      downloadBulkExcel(overridden);
                    }}
                    className="inline-flex items-center gap-1.5 text-sm text-white bg-green-600 hover:bg-green-700 px-3 py-1.5 rounded-md font-medium transition-colors"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                    </svg>
                    Download All (Excel)
                  </button>
                </div>
              </div>

              {result.file_results.map((fr: FileResult) => {
                const isSkipped = fr.error?.startsWith('Skipped (no invoice content)');
                const isError = fr.error && !isSkipped;
                return (
                  <div key={fr.filename}>
                    <div className="flex items-center gap-3 mb-3">
                      <span className="font-medium text-gray-800 text-sm">{fr.filename}</span>
                      {isSkipped ? (
                        <span className="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full font-medium">Skipped</span>
                      ) : (
                        <span className="text-xs bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded-full font-medium">
                          {fr.invoices.length} invoice{fr.invoices.length !== 1 ? 's' : ''}
                        </span>
                      )}
                    </div>
                    {isSkipped && (
                      <div className="bg-gray-50 border border-gray-200 rounded-lg px-4 py-3 flex items-center gap-3 mb-3">
                        <svg className="w-5 h-5 text-gray-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                        </svg>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-gray-600">No invoice content detected — file appears blank or is not an invoice document. No AI tokens were used.</p>
                          {fileUrls[fr.filename] && (
                            <a href={fileUrls[fr.filename]} target="_blank" rel="noopener noreferrer"
                              className="text-xs text-indigo-600 hover:underline mt-0.5 inline-block">
                              Open file to verify →
                            </a>
                          )}
                        </div>
                      </div>
                    )}
                    {isError && (
                      <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700 mb-3">
                        Error: {fr.error}
                      </div>
                    )}
                    <div className="space-y-4">
                      {fr.invoices
                        .filter((_, idx) => !rejectedInvoices.has(`${fr.filename}:${idx}`))
                        .map((inv: ExtractedInvoice, idx: number) => {
                          const key = `${fr.filename}:${idx}`;
                          const historyMatch = findDuplicate(inv.invoice_number, inv.vendor_name);
                          return (
                            <InvoiceCard
                              key={key}
                              inv={inv}
                              sourceUrl={fileUrls[fr.filename]}
                              company={companies.find((c) => c.id === selectedCompanyId)}
                              historyMatch={historyMatch}
                              isBatchNew={currentBatchKeys.has(`${inv.invoice_number}__${inv.vendor_name}`)}
                              onReject={() => setRejectedInvoices((prev) => new Set(Array.from(prev).concat(key)))}
                              onSave={(updated) => handleInvoiceSave(key, updated)}
                            />
                          );
                        })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
