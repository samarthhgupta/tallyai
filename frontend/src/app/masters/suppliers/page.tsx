'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import * as XLSX from 'xlsx';
import AppSidebar from '@/components/AppSidebar';
import { getSession } from '@/lib/auth';
import { useCompany } from '@/lib/companyContext';
import {
  loadSuppliers,
  addSupplier,
  updateSupplier,
  deleteSupplier,
  bulkUpsertSuppliers,
  validateGstin,
  normaliseGstin,
  deriveStateFromGstin,
  isUnregistered,
  type SupplierMaster,
  type ImportResult,
} from '@/lib/suppliers';

const EMPTY_FORM = { tally_ledger_name: '', vendor_gstin: '' };
type Tab = 'list' | 'import';

export default function SupplierMastersPage() {
  const { company, loading: companyLoading } = useCompany();
  const router = useRouter();
  const [companyState, setCompanyState] = useState('');
  const [suppliers, setSuppliers] = useState<SupplierMaster[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<Tab>('list');

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    if (companyLoading) return;
    getSession().then((session) => {
      if (!session) { router.replace('/login'); return; }
      if (!company) router.replace('/select-company');
    });
  }, [company, companyLoading, router]);

  // When company changes, derive its state from GSTIN
  useEffect(() => {
    if (!company?.id) return;
    const gstin = 'gstin' in company ? (company.gstin ?? '') : '';
    const state = gstin ? (deriveStateFromGstin(gstin) ?? '') : '';
    setCompanyState(state);
    setImportResult(null);
  }, [company]);

  const refresh = useCallback(async () => {
    if (!company?.id) return;
    setLoading(true);
    try {
      const list = await loadSuppliers(company.id);
      setSuppliers(list);
    } finally {
      setLoading(false);
    }
  }, [company]);

  useEffect(() => { refresh(); }, [refresh]);

  // ── Manual form ──────────────────────────────────────────────────────────
  const openAdd = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setFormError('');
    setShowForm(true);
    setTab('list');
  };

  const openEdit = (s: SupplierMaster) => {
    setEditingId(s.id);
    setForm({ tally_ledger_name: s.tally_ledger_name, vendor_gstin: s.vendor_gstin });
    setFormError('');
    setShowForm(true);
    setTab('list');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.tally_ledger_name) {
      setFormError('Tally Ledger Name is required.');
      return;
    }
    setSaving(true);
    setFormError('');
    try {
      if (editingId) {
        await updateSupplier(editingId, {
          tally_ledger_name: form.tally_ledger_name,
          vendor_gstin: form.vendor_gstin,
        }, companyState);
      } else {
        await addSupplier(company?.id ?? '', {
          tally_ledger_name: form.tally_ledger_name,
          vendor_gstin: form.vendor_gstin,
          companyState,
        });
      }
      setShowForm(false);
      setForm(EMPTY_FORM);
      setEditingId(null);
      await refresh();
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : 'Failed to save.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Delete supplier "${name}"?`)) return;
    try {
      await deleteSupplier(id);
      await refresh();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Failed to delete.');
    }
  };

  // ── Excel template download ──────────────────────────────────────────────
  const downloadTemplate = () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ['Tally Ledger Name', 'GSTIN'],
      ['ABC Enterprises Pvt Ltd', '27AABCU9603R1ZX'],
      ['XYZ Traders', '29AADCB2230M1ZV'],
      ['Local Supplier (Unregistered)', ''],
    ]);
    ws['!cols'] = [{ wch: 40 }, { wch: 20 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Supplier Master');
    XLSX.writeFile(wb, 'TallyAI_Supplier_Master_Template.xlsx');
  };

  // ── Excel import ─────────────────────────────────────────────────────────
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !company?.id) return;
    setImporting(true);
    setImportResult(null);
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const raw: string[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

      // Find header row
      let headerIdx = 0;
      for (let i = 0; i < Math.min(5, raw.length); i++) {
        const row = raw[i].map((c) => String(c).toLowerCase());
        if (row.some((c) => c.includes('gstin') || c.includes('ledger'))) {
          headerIdx = i;
          break;
        }
      }
      const headers = raw[headerIdx].map((h) => String(h).toLowerCase().trim());
      const colIdx = (patterns: string[]) => {
        for (const p of patterns) {
          const idx = headers.findIndex((h) => h.includes(p));
          if (idx !== -1) return idx;
        }
        return -1;
      };

      const ledgerCol = colIdx(['tally ledger name', 'ledger name', 'ledger', 'name', 'particulars']);
      const gstinCol = colIdx(['gstin/uin', 'gstin', 'gst', 'tin']);

      if (ledgerCol === -1) {
        setImportResult({ inserted: 0, updated: 0, errors: [{ row: 0, identifier: '—', reason: 'Could not find Tally Ledger Name column' }] });
        return;
      }

      const dataRows = raw.slice(headerIdx + 1).filter((r) => r.some((c) => String(c).trim()));

      const rows = dataRows.map((r) => ({
        tally_ledger_name: String(r[ledgerCol] ?? ''), // NOT trimmed — preserve exactly
        vendor_gstin: gstinCol !== -1 ? String(r[gstinCol] ?? '') : '',
      }));

      const result = await bulkUpsertSuppliers(company?.id ?? '', rows, companyState);
      setImportResult(result);
      await refresh();
    } catch (err: unknown) {
      setImportResult({ inserted: 0, updated: 0, errors: [{ row: 0, identifier: '—', reason: err instanceof Error ? err.message : 'Failed to read file' }] });
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  // ── Excel export ─────────────────────────────────────────────────────────
  const exportToExcel = () => {
    const rows = suppliers.map((s) => ({
      'Tally Ledger Name': s.tally_ledger_name,
      'GSTIN': s.vendor_gstin || 'UNREGISTERED',
      'Vendor Name': s.vendor_name,
      'State': s.state_name,
      'Status': s.is_unregistered ? 'Unregistered' : s.gstin_valid ? 'Registered' : 'Invalid GSTIN',
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    ws['!cols'] = [{ wch: 40 }, { wch: 20 }, { wch: 35 }, { wch: 20 }, { wch: 16 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Supplier Master');
    XLSX.writeFile(wb, `SupplierMaster_${company?.name ?? 'export'}.xlsx`);
  };

  // ── Preview: derived state for current GSTIN input ───────────────────────
  const previewGstin = normaliseGstin(form.vendor_gstin);
  const previewState = previewGstin
    ? (deriveStateFromGstin(previewGstin) ?? null)
    : null;
  const previewUnregistered = !previewGstin;
  const previewInvalid = previewGstin && !validateGstin(previewGstin);

  // ── Filtered list ─────────────────────────────────────────────────────────
  const filtered = suppliers.filter((s) => {
    const q = search.toLowerCase();
    return (
      !q ||
      s.vendor_name.toLowerCase().includes(q) ||
      s.vendor_gstin.toLowerCase().includes(q) ||
      s.tally_ledger_name.toLowerCase().includes(q) ||
      s.state_name.toLowerCase().includes(q)
    );
  });

  const companyName = company?.name ?? '';
  const unregCount = filtered.filter(isUnregistered).length;

  return (
    <div className="flex min-h-screen bg-gray-50">
      <AppSidebar />
      <main className="ml-60 flex-1 px-6 py-8">
        <div className="max-w-5xl">

          {/* Header */}
          <div className="flex items-start justify-between mb-4">
            <div>
              <h1 className="text-xl font-semibold text-gray-900">Supplier Master</h1>
              <p className="text-sm text-gray-500 mt-0.5">
                Maps vendor GSTIN to Tally party ledger name. State is auto-derived from GSTIN.
              </p>
            </div>
            <div className="flex gap-2">
              <button onClick={downloadTemplate}
                className="px-3 py-2 text-sm text-gray-600 border border-gray-300 rounded-md hover:bg-gray-50 transition-colors flex items-center gap-1.5">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                Template
              </button>
              <button onClick={() => { setTab('import'); setShowForm(false); }} disabled={!company?.id}
                className="px-3 py-2 text-sm text-indigo-700 border border-indigo-300 bg-indigo-50 rounded-md hover:bg-indigo-100 disabled:opacity-40 transition-colors flex items-center gap-1.5">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l4-4m0 0l4 4m-4-4v12" />
                </svg>
                Import Excel
              </button>
              <button onClick={openAdd} disabled={!company?.id}
                className="px-3 py-2 bg-indigo-600 text-white text-sm font-medium rounded-md hover:bg-indigo-700 disabled:opacity-40 transition-colors">
                + Add Supplier
              </button>
            </div>
          </div>

          {/* Search / export row */}
          <div className="flex items-center gap-3 mb-5">
            {companyState && (
              <span className="text-xs text-gray-500 bg-gray-100 px-2 py-1 rounded-md">{companyState}</span>
            )}
            {company?.id && suppliers.length > 0 && tab === 'list' && (
              <>
                <input value={search} onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search suppliers…"
                  className="ml-auto text-sm border border-gray-300 rounded-md px-3 py-1.5 w-56 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                <button onClick={exportToExcel} className="text-sm text-gray-500 hover:text-gray-700 flex items-center gap-1">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                  Export
                </button>
              </>
            )}
          </div>

          {/* ── Import panel ── */}
          {tab === 'import' && company?.id && (
            <div className="bg-white border border-gray-200 rounded-xl p-6 mb-6 shadow-sm">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h2 className="text-sm font-semibold text-gray-900">Import Suppliers from Excel</h2>
                  <p className="text-xs text-gray-500 mt-0.5">Into: <span className="font-medium text-gray-700">{companyName}</span></p>
                </div>
                <button onClick={() => setTab('list')} className="text-sm text-gray-400 hover:text-gray-600">✕ Close</button>
              </div>

              <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-xs text-amber-800 mb-4 space-y-1">
                <p className="font-semibold">Expected columns (from Tally Sundry Creditors export):</p>
                <p>• <strong>Tally Ledger Name</strong> — exact ledger name as in Tally</p>
                <p>• <strong>GSTIN</strong> — 15-character GSTIN (blank or "UNREGISTERED" for unregistered parties)</p>
                <p className="mt-1 text-amber-700">State is derived automatically from GSTIN. No state column needed.</p>
                <p className="text-amber-700">Ledger names are stored exactly as in your file — no changes are made.</p>
              </div>

              <div className="border-2 border-dashed border-gray-200 rounded-lg p-8 text-center hover:border-indigo-300 transition-colors cursor-pointer"
                onClick={() => fileInputRef.current?.click()}>
                <svg className="w-8 h-8 text-gray-300 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 13h6m-3-3v6m5 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                <p className="text-sm text-gray-500">{importing ? 'Processing…' : 'Click to upload .xlsx / .xls file'}</p>
              </div>
              <input ref={fileInputRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={handleFileChange} />

              {importResult && (
                <div className="mt-4 space-y-3">
                  {(importResult.inserted > 0 || importResult.updated > 0) && (
                    <div className="flex gap-4 bg-green-50 border border-green-200 rounded-lg px-4 py-3 text-sm">
                      {importResult.inserted > 0 && <span className="text-green-700 font-medium">✓ {importResult.inserted} new supplier{importResult.inserted !== 1 ? 's' : ''} added</span>}
                      {importResult.updated > 0 && <span className="text-blue-700 font-medium">↻ {importResult.updated} existing record{importResult.updated !== 1 ? 's' : ''} updated</span>}
                    </div>
                  )}
                  {importResult.errors.length > 0 && (
                    <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3">
                      <p className="text-sm font-medium text-red-700 mb-2">{importResult.errors.length} row{importResult.errors.length !== 1 ? 's' : ''} skipped:</p>
                      <div className="space-y-1 max-h-48 overflow-y-auto">
                        {importResult.errors.map((e, i) => (
                          <p key={i} className="text-xs text-red-600">Row {e.row}: <span className="font-mono">{e.identifier}</span> — {e.reason}</p>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ── Manual add/edit form ── */}
          {showForm && tab === 'list' && (
            <form onSubmit={handleSubmit} className="mb-6 bg-white border border-gray-200 rounded-xl p-5 shadow-sm">
              <h2 className="text-sm font-semibold text-gray-900 mb-4">
                {editingId ? 'Edit Supplier' : 'Add Supplier'}
              </h2>
              <div className="grid grid-cols-2 gap-4">
                <div className="col-span-2">
                  <label className="block text-xs font-medium text-gray-600 mb-1">Tally Ledger Name *</label>
                  <input value={form.tally_ledger_name}
                    onChange={(e) => setForm({ ...form, tally_ledger_name: e.target.value })}
                    className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    placeholder="e.g. ABC Traders" />
                  <p className="text-xs text-gray-400 mt-1">Stored exactly as entered — case, spaces and all.</p>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    GSTIN
                    <span className="ml-1.5 text-gray-400 font-normal">(leave blank if unregistered)</span>
                  </label>
                  <input value={form.vendor_gstin}
                    onChange={(e) => setForm({ ...form, vendor_gstin: e.target.value.toUpperCase() })}
                    maxLength={15}
                    className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    placeholder="27AABCU9603R1ZX" />
                </div>
                {/* Auto-derived state — read only */}
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">State <span className="font-normal text-gray-400">(auto-derived)</span></label>
                  <div className="w-full border border-gray-200 rounded-md px-3 py-2 text-sm bg-gray-50 text-gray-600 min-h-[38px] flex items-center">
                    {previewUnregistered
                      ? <span className="text-amber-600">{companyState || 'Set company GSTIN to derive'} <span className="text-xs text-gray-400">(company state — unregistered)</span></span>
                      : previewState
                        ? <span className="text-green-700">{previewState}</span>
                        : previewInvalid
                          ? <span className="text-amber-600">Could not derive — invalid GSTIN</span>
                          : <span className="text-gray-400">Enter GSTIN to derive</span>
                    }
                  </div>
                </div>
              </div>
              {previewInvalid && (
                <p className="text-xs text-amber-600 mt-2">⚠ Invalid GSTIN format — supplier will be saved but flagged</p>
              )}
              {formError && <p className="text-sm text-red-600 mt-3">{formError}</p>}
              <div className="flex gap-2 mt-4">
                <button type="submit" disabled={saving}
                  className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-md hover:bg-indigo-700 disabled:opacity-50 transition-colors">
                  {saving ? 'Saving…' : editingId ? 'Save Changes' : 'Add'}
                </button>
                <button type="button" onClick={() => { setShowForm(false); setEditingId(null); }}
                  className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900">
                  Cancel
                </button>
              </div>
            </form>
          )}

          {/* ── Supplier table ── */}
          {loading ? (
            <div className="flex justify-center py-12"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-indigo-600" /></div>
          ) : filtered.length === 0 ? (
            <div className="bg-white border border-gray-200 rounded-xl p-10 text-center text-gray-400">
              <p className="text-sm">{suppliers.length === 0 ? 'No suppliers yet. Import from Excel or add manually.' : 'No suppliers match your search.'}</p>
            </div>
          ) : (
            <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Tally Ledger Name</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">GSTIN</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">State</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Vendor Name</th>
                    <th className="px-4 py-3 w-20" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {filtered.map((s) => (
                    <tr key={s.id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-4 py-3 font-medium text-gray-900 font-mono text-xs">{s.tally_ledger_name}</td>
                      <td className="px-4 py-3 text-xs">
                        {isUnregistered(s) ? (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700">Unregistered</span>
                        ) : !s.gstin_valid ? (
                          <span className="inline-flex items-center gap-1">
                            <span className="font-mono text-red-600">{s.vendor_gstin}</span>
                            <span className="relative group cursor-default">
                              <span className="w-4 h-4 rounded-full bg-red-100 text-red-600 text-[10px] font-bold flex items-center justify-center">i</span>
                              <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 w-max bg-gray-900 text-white text-xs rounded px-2 py-1 opacity-0 group-hover:opacity-100 pointer-events-none z-10">
                                Invalid GSTIN format
                              </span>
                            </span>
                          </span>
                        ) : (
                          <span className="font-mono text-gray-600">{s.vendor_gstin}</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-500">{s.state_name || '—'}</td>
                      <td className="px-4 py-3 text-xs text-gray-700">
                        {s.vendor_name}
                        {s.vendor_name !== s.tally_ledger_name && (
                          <span className="ml-1.5 text-indigo-400 text-[10px]">learned</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex gap-2 justify-end">
                          <button onClick={() => openEdit(s)} className="text-xs text-indigo-600 hover:text-indigo-800">Edit</button>
                          <button onClick={() => handleDelete(s.id, s.tally_ledger_name)} className="text-xs text-red-500 hover:text-red-700">Delete</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="px-4 py-2 text-xs text-gray-400 border-t border-gray-100 flex items-center justify-between">
                <span>
                  {filtered.length} supplier{filtered.length !== 1 ? 's' : ''}
                  {!search && unregCount > 0 && ` · ${unregCount} unregistered`}
                  {search && ` matching "${search}"`}
                </span>
                <span className="text-gray-300">Isolated to {companyName}</span>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
