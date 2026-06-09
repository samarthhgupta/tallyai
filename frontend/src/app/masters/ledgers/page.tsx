'use client';

import { useState, useEffect, useRef } from 'react';
import * as XLSX from 'xlsx';
import AppSidebar from '@/components/AppSidebar';
import { loadCompanies, type LocalCompany } from '@/lib/companies';
import {
  loadLedgers,
  addLedger,
  updateLedger,
  deleteLedger,
  bulkUpsertLedgers,
  type LedgerMaster,
  type LedgerImportResult,
} from '@/lib/ledgers';

const GST_RATES = [0, 5, 12, 18, 28];

const EMPTY_FORM = {
  hsn_sac: '',
  gst_percent: 18,
  description: '',
  purchase_ledger: '',
  cgst_ledger: '',
  sgst_ledger: '',
  igst_ledger: '',
};

type FormState = typeof EMPTY_FORM;
type Tab = 'list' | 'import';

function defaultLedgerNames(gst: number) {
  const half = gst / 2;
  return {
    purchase_ledger: `Purchase @${gst}%`,
    cgst_ledger: gst > 0 ? `CGST @${half}%` : '',
    sgst_ledger: gst > 0 ? `SGST @${half}%` : '',
    igst_ledger: gst > 0 ? `IGST @${gst}%` : '',
  };
}

export default function LedgerMastersPage() {
  const [companies, setCompanies] = useState<LocalCompany[]>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState('');
  const [ledgers, setLedgers] = useState<LedgerMaster[]>([]);
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<Tab>('list');

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formError, setFormError] = useState('');

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importResult, setImportResult] = useState<LedgerImportResult | null>(null);
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    const list = loadCompanies();
    setCompanies(list);
    if (list.length === 1) setSelectedCompanyId(list[0].id);
  }, []);

  useEffect(() => {
    if (selectedCompanyId) {
      setLedgers(loadLedgers(selectedCompanyId));
      setImportResult(null);
    }
  }, [selectedCompanyId]);

  const refresh = () => {
    if (selectedCompanyId) setLedgers(loadLedgers(selectedCompanyId));
  };

  // ── Manual form ──────────────────────────────────────────────────────────
  const openAdd = () => {
    setEditingId(null);
    setForm({ ...EMPTY_FORM, ...defaultLedgerNames(18) });
    setFormError('');
    setShowForm(true);
    setTab('list');
  };

  const openEdit = (l: LedgerMaster) => {
    setEditingId(l.id);
    setForm({
      hsn_sac: l.hsn_sac,
      gst_percent: l.gst_percent,
      description: l.description,
      purchase_ledger: l.purchase_ledger,
      cgst_ledger: l.cgst_ledger,
      sgst_ledger: l.sgst_ledger,
      igst_ledger: l.igst_ledger,
    });
    setFormError('');
    setShowForm(true);
    setTab('list');
  };

  const handleGSTChange = (gst: number) => {
    const auto = defaultLedgerNames(gst);
    setForm((f) => ({ ...f, gst_percent: gst, ...auto }));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.purchase_ledger.trim()) {
      setFormError('Purchase Ledger is required.');
      return;
    }
    if (editingId) {
      updateLedger(editingId, form);
    } else {
      addLedger(selectedCompanyId, form);
    }
    setShowForm(false);
    setEditingId(null);
    refresh();
  };

  const handleDelete = (id: string, hsn: string) => {
    if (!confirm(`Delete ledger mapping for HSN/SAC "${hsn || 'all'}"?`)) return;
    deleteLedger(id);
    refresh();
  };

  // ── Excel template download ──────────────────────────────────────────────
  const downloadTemplate = () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ['HSN/SAC Code', 'GST %', 'Description', 'Purchase Ledger', 'CGST Ledger', 'SGST Ledger', 'IGST Ledger'],
      ['8536', '18', 'Electrical Goods', 'Purchase @18%', 'CGST @9%', 'SGST @9%', 'IGST @18%'],
      ['44', '12', 'Paper & Stationery', 'Purchase @12%', 'CGST @6%', 'SGST @6%', 'IGST @12%'],
      ['998314', '18', 'IT Services', 'Purchase @18%', 'CGST @9%', 'SGST @9%', 'IGST @18%'],
    ]);
    ws['!cols'] = [{ wch: 16 }, { wch: 8 }, { wch: 25 }, { wch: 22 }, { wch: 16 }, { wch: 16 }, { wch: 16 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Ledger Master');
    XLSX.writeFile(wb, 'TallyAI_Ledger_Master_Template.xlsx');
  };

  // ── Excel import ─────────────────────────────────────────────────────────
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !selectedCompanyId) return;
    setImporting(true);
    setImportResult(null);
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const raw: string[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

      let headerIdx = 0;
      for (let i = 0; i < Math.min(5, raw.length); i++) {
        const row = raw[i].map((c) => String(c).toLowerCase());
        if (row.some((c) => c.includes('hsn') || c.includes('purchase') || c.includes('gst'))) {
          headerIdx = i;
          break;
        }
      }
      const headers = raw[headerIdx].map((h) => String(h).toLowerCase().trim());
      const col = (patterns: string[]) => {
        for (const p of patterns) {
          const idx = headers.findIndex((h) => h.includes(p));
          if (idx !== -1) return idx;
        }
        return -1;
      };

      const hsnCol = col(['hsn/sac', 'hsn', 'sac']);
      const gstCol = col(['gst %', 'gst%', 'gst rate', 'gst']);
      const descCol = col(['description', 'desc', 'category']);
      const purchaseCol = col(['purchase ledger', 'purchase']);
      const cgstCol = col(['cgst']);
      const sgstCol = col(['sgst']);
      const igstCol = col(['igst']);

      if (purchaseCol === -1) {
        setImportResult({
          inserted: 0, updated: 0,
          errors: [{ row: 0, hsn: '-', reason: 'Could not find a Purchase Ledger column in the file' }],
        });
        return;
      }

      const dataRows = raw.slice(headerIdx + 1).filter((r) =>
        r.some((c) => String(c).trim()),
      );

      const rows = dataRows.map((r) => ({
        hsn_sac: hsnCol !== -1 ? String(r[hsnCol] ?? '') : '',
        gst_percent: gstCol !== -1 ? String(r[gstCol] ?? '0') : '0',
        description: descCol !== -1 ? String(r[descCol] ?? '') : '',
        purchase_ledger: purchaseCol !== -1 ? String(r[purchaseCol] ?? '') : '',
        cgst_ledger: cgstCol !== -1 ? String(r[cgstCol] ?? '') : '',
        sgst_ledger: sgstCol !== -1 ? String(r[sgstCol] ?? '') : '',
        igst_ledger: igstCol !== -1 ? String(r[igstCol] ?? '') : '',
      }));

      const result = bulkUpsertLedgers(selectedCompanyId, rows);
      setImportResult(result);
      refresh();
    } catch {
      setImportResult({
        inserted: 0, updated: 0,
        errors: [{ row: 0, hsn: '-', reason: 'Failed to read file. Ensure it is a valid .xlsx or .xls file.' }],
      });
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  // ── Excel export ─────────────────────────────────────────────────────────
  const exportToExcel = () => {
    const rows = ledgers.map((l) => ({
      'HSN/SAC Code': l.hsn_sac,
      'GST %': l.gst_percent,
      'Description': l.description,
      'Purchase Ledger': l.purchase_ledger,
      'CGST Ledger': l.cgst_ledger,
      'SGST Ledger': l.sgst_ledger,
      'IGST Ledger': l.igst_ledger,
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    ws['!cols'] = [{ wch: 16 }, { wch: 8 }, { wch: 25 }, { wch: 22 }, { wch: 16 }, { wch: 16 }, { wch: 16 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Ledger Master');
    const company = companies.find((c) => c.id === selectedCompanyId);
    XLSX.writeFile(wb, `LedgerMaster_${company?.name ?? 'export'}.xlsx`);
  };

  // ── Filtered list ─────────────────────────────────────────────────────────
  const filtered = ledgers.filter((l) => {
    const q = search.toLowerCase();
    return (
      !q ||
      l.hsn_sac.toLowerCase().includes(q) ||
      l.description.toLowerCase().includes(q) ||
      l.purchase_ledger.toLowerCase().includes(q)
    );
  });

  const companyName = companies.find((c) => c.id === selectedCompanyId)?.name ?? '';

  return (
    <div className="flex min-h-screen bg-gray-50">
      <AppSidebar />
      <main className="ml-60 flex-1 px-6 py-8">
        <div className="max-w-5xl">

          {/* Header */}
          <div className="flex items-start justify-between mb-4">
            <div>
              <h1 className="text-xl font-semibold text-gray-900">Ledger Master</h1>
              <p className="text-sm text-gray-500 mt-0.5">
                Maps HSN/SAC code + GST rate to Tally purchase and tax ledger names. Company-specific.
              </p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={downloadTemplate}
                className="px-3 py-2 text-sm text-gray-600 border border-gray-300 rounded-md hover:bg-gray-50 transition-colors flex items-center gap-1.5"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                Template
              </button>
              <button
                onClick={() => { setTab('import'); setShowForm(false); }}
                disabled={!selectedCompanyId}
                className="px-3 py-2 text-sm text-indigo-700 border border-indigo-300 bg-indigo-50 rounded-md hover:bg-indigo-100 disabled:opacity-40 transition-colors flex items-center gap-1.5"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l4-4m0 0l4 4m-4-4v12" />
                </svg>
                Import Excel
              </button>
              <button
                onClick={openAdd}
                disabled={!selectedCompanyId}
                className="px-3 py-2 bg-indigo-600 text-white text-sm font-medium rounded-md hover:bg-indigo-700 disabled:opacity-40 transition-colors"
              >
                + Add Mapping
              </button>
            </div>
          </div>

          {/* Company selector */}
          <div className="flex items-center gap-3 mb-5">
            <label className="text-sm font-medium text-gray-700 shrink-0">Company</label>
            {companies.length === 0 ? (
              <span className="text-sm text-gray-400">No companies found. Add one first.</span>
            ) : (
              <select
                value={selectedCompanyId}
                onChange={(e) => { setSelectedCompanyId(e.target.value); setTab('list'); setShowForm(false); }}
                className="text-sm border border-gray-300 rounded-md px-3 py-1.5 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                <option value="" disabled>Select company…</option>
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            )}
            {selectedCompanyId && ledgers.length > 0 && tab === 'list' && (
              <>
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search HSN, description…"
                  className="ml-auto text-sm border border-gray-300 rounded-md px-3 py-1.5 w-56 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
                <button
                  onClick={exportToExcel}
                  className="text-sm text-gray-500 hover:text-gray-700 flex items-center gap-1"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                  Export
                </button>
              </>
            )}
          </div>

          {/* ── Import panel ── */}
          {tab === 'import' && selectedCompanyId && (
            <div className="bg-white border border-gray-200 rounded-xl p-6 mb-6 shadow-sm">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h2 className="text-sm font-semibold text-gray-900">Import Ledger Mappings from Excel</h2>
                  <p className="text-xs text-gray-500 mt-0.5">Importing into: <span className="font-medium text-gray-700">{companyName}</span></p>
                </div>
                <button onClick={() => setTab('list')} className="text-sm text-gray-400 hover:text-gray-600">✕ Close</button>
              </div>

              <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-xs text-amber-800 mb-4 space-y-1">
                <p className="font-semibold">Expected columns:</p>
                <p>• <strong>HSN/SAC Code</strong> - HSN or SAC code (can be blank for rate-only mappings)</p>
                <p>• <strong>GST %</strong> - GST rate (0, 5, 12, 18, 28)</p>
                <p>• <strong>Description</strong> - category label (optional)</p>
                <p>• <strong>Purchase Ledger</strong> - exact purchase ledger name in Tally (required)</p>
                <p>• <strong>CGST Ledger, SGST Ledger, IGST Ledger</strong> - exact tax ledger names in Tally</p>
              </div>

              <div
                className="border-2 border-dashed border-gray-200 rounded-lg p-8 text-center hover:border-indigo-300 transition-colors cursor-pointer"
                onClick={() => fileInputRef.current?.click()}
              >
                <svg className="w-8 h-8 text-gray-300 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 13h6m-3-3v6m5 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                <p className="text-sm text-gray-500">
                  {importing ? 'Processing…' : 'Click to upload .xlsx / .xls file'}
                </p>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xls"
                className="hidden"
                onChange={handleFileChange}
              />

              {importResult && (
                <div className="mt-4 space-y-3">
                  {(importResult.inserted > 0 || importResult.updated > 0) && (
                    <div className="flex gap-4 bg-green-50 border border-green-200 rounded-lg px-4 py-3 text-sm">
                      {importResult.inserted > 0 && (
                        <span className="text-green-700 font-medium">✓ {importResult.inserted} new mapping{importResult.inserted !== 1 ? 's' : ''} added</span>
                      )}
                      {importResult.updated > 0 && (
                        <span className="text-blue-700 font-medium">↻ {importResult.updated} existing record{importResult.updated !== 1 ? 's' : ''} updated</span>
                      )}
                    </div>
                  )}
                  {importResult.errors.length > 0 && (
                    <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3">
                      <p className="text-sm font-medium text-red-700 mb-2">{importResult.errors.length} row{importResult.errors.length !== 1 ? 's' : ''} skipped:</p>
                      <div className="space-y-1 max-h-48 overflow-y-auto">
                        {importResult.errors.map((e, i) => (
                          <p key={i} className="text-xs text-red-600">
                            Row {e.row}: <span className="font-mono">{e.hsn}</span> - {e.reason}
                          </p>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ── Manual form ── */}
          {showForm && tab === 'list' && (
            <form
              onSubmit={handleSubmit}
              className="mb-6 bg-white border border-gray-200 rounded-xl p-5 shadow-sm space-y-4"
            >
              <h2 className="text-sm font-semibold text-gray-900">
                {editingId ? 'Edit Ledger Mapping' : 'Add Ledger Mapping'}
              </h2>
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">HSN / SAC Code</label>
                  <input
                    value={form.hsn_sac}
                    onChange={(e) => setForm({ ...form, hsn_sac: e.target.value })}
                    className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    placeholder="e.g. 8536 or 998314"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">GST Rate %</label>
                  <select
                    value={form.gst_percent}
                    onChange={(e) => handleGSTChange(Number(e.target.value))}
                    className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  >
                    {GST_RATES.map((r) => (
                      <option key={r} value={r}>{r}%</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Description / Category</label>
                  <input
                    value={form.description}
                    onChange={(e) => setForm({ ...form, description: e.target.value })}
                    className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    placeholder="e.g. Electrical Goods"
                  />
                </div>
              </div>

              <div className="border-t border-gray-100 pt-4">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Tally Ledger Names</p>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Purchase Ledger *</label>
                    <input
                      value={form.purchase_ledger}
                      onChange={(e) => setForm({ ...form, purchase_ledger: e.target.value })}
                      className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      placeholder={`Purchase @${form.gst_percent}%`}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">IGST Ledger</label>
                    <input
                      value={form.igst_ledger}
                      onChange={(e) => setForm({ ...form, igst_ledger: e.target.value })}
                      className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      placeholder={`IGST @${form.gst_percent}%`}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">CGST Ledger</label>
                    <input
                      value={form.cgst_ledger}
                      onChange={(e) => setForm({ ...form, cgst_ledger: e.target.value })}
                      className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      placeholder={`CGST @${form.gst_percent / 2}%`}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">SGST Ledger</label>
                    <input
                      value={form.sgst_ledger}
                      onChange={(e) => setForm({ ...form, sgst_ledger: e.target.value })}
                      className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      placeholder={`SGST @${form.gst_percent / 2}%`}
                    />
                  </div>
                </div>
                <p className="text-xs text-gray-400 mt-2">Names must match exactly as they appear in Tally - case and spaces matter.</p>
              </div>

              {formError && <p className="text-sm text-red-600">{formError}</p>}
              <div className="flex gap-2">
                <button type="submit" className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-md hover:bg-indigo-700 transition-colors">
                  {editingId ? 'Save Changes' : 'Add Mapping'}
                </button>
                <button type="button" onClick={() => { setShowForm(false); setEditingId(null); }} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900">
                  Cancel
                </button>
              </div>
            </form>
          )}

          {/* ── Ledger table ── */}
          {!selectedCompanyId ? (
            <div className="bg-white border border-gray-200 rounded-xl p-10 text-center text-gray-400">
              <p className="text-sm">Select a company to view its ledger master.</p>
            </div>
          ) : filtered.length === 0 ? (
            <div className="bg-white border border-gray-200 rounded-xl p-10 text-center text-gray-400">
              <p className="text-sm">
                {ledgers.length === 0
                  ? 'No mappings yet. Import from Excel or add manually.'
                  : 'No mappings match your search.'}
              </p>
            </div>
          ) : (
            <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide w-24">HSN/SAC</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide w-16">GST%</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Description</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Purchase Ledger</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">CGST / SGST / IGST</th>
                    <th className="px-4 py-3 w-20" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {filtered.map((l) => (
                    <tr key={l.id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-4 py-3 font-mono text-gray-700">{l.hsn_sac || '-'}</td>
                      <td className="px-4 py-3 text-gray-600">{l.gst_percent}%</td>
                      <td className="px-4 py-3 text-gray-700">{l.description || '-'}</td>
                      <td className="px-4 py-3 text-gray-900 font-medium">{l.purchase_ledger}</td>
                      <td className="px-4 py-3 text-gray-500 text-xs leading-5">
                        {l.cgst_ledger && <div>{l.cgst_ledger}</div>}
                        {l.sgst_ledger && <div>{l.sgst_ledger}</div>}
                        {l.igst_ledger && <div>{l.igst_ledger}</div>}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex gap-2 justify-end">
                          <button onClick={() => openEdit(l)} className="text-xs text-indigo-600 hover:text-indigo-800">Edit</button>
                          <button onClick={() => handleDelete(l.id, l.hsn_sac)} className="text-xs text-red-500 hover:text-red-700">Delete</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="px-4 py-2 text-xs text-gray-400 border-t border-gray-100 flex items-center justify-between">
                <span>{filtered.length} mapping{filtered.length !== 1 ? 's' : ''}{search && ` matching "${search}"`}</span>
                <span className="text-gray-300">Data is strictly isolated to {companyName}</span>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
