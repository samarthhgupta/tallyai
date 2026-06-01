'use client';

import { useState, useEffect, useRef } from 'react';
import * as XLSX from 'xlsx';
import AppSidebar from '@/components/AppSidebar';
import { loadCompanies, type LocalCompany } from '@/lib/companies';
import {
  loadSuppliers,
  addSupplier,
  updateSupplier,
  deleteSupplier,
  bulkUpsertSuppliers,
  validateGstin,
  isUnregistered,
  type SupplierMaster,
  type ImportResult,
} from '@/lib/suppliers';

const INDIAN_STATES = [
  'Andaman & Nicobar Islands', 'Andhra Pradesh', 'Arunachal Pradesh', 'Assam',
  'Bihar', 'Chandigarh', 'Chhattisgarh', 'Dadra & Nagar Haveli and Daman & Diu',
  'Delhi', 'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jammu & Kashmir',
  'Jharkhand', 'Karnataka', 'Kerala', 'Ladakh', 'Lakshadweep', 'Madhya Pradesh',
  'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha',
  'Puducherry', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana',
  'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
];

const EMPTY_FORM = {
  vendor_name: '',
  vendor_gstin: '',
  tally_ledger_name: '',
  state_name: '',
};

type Tab = 'list' | 'import';

export default function SupplierMastersPage() {
  const [companies, setCompanies] = useState<LocalCompany[]>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState('');
  const [suppliers, setSuppliers] = useState<SupplierMaster[]>([]);
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<Tab>('list');

  // Manual add/edit form
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formError, setFormError] = useState('');

  // Excel import
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    const list = loadCompanies();
    setCompanies(list);
    if (list.length === 1) setSelectedCompanyId(list[0].id);
  }, []);

  useEffect(() => {
    if (selectedCompanyId) {
      setSuppliers(loadSuppliers(selectedCompanyId));
      setImportResult(null);
    }
  }, [selectedCompanyId]);

  const refresh = () => {
    if (selectedCompanyId) setSuppliers(loadSuppliers(selectedCompanyId));
  };

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
    setForm({
      vendor_name: s.vendor_name,
      vendor_gstin: s.vendor_gstin,
      tally_ledger_name: s.tally_ledger_name,
      state_name: s.state_name,
    });
    setFormError('');
    setShowForm(true);
    setTab('list');
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.vendor_name.trim()) {
      setFormError('Vendor Name is required.');
      return;
    }
    // GSTIN optional — blank means unregistered supplier
    if (form.vendor_gstin.trim() && !validateGstin(form.vendor_gstin)) {
      setFormError('Invalid GSTIN format (must be 15 characters, e.g. 27AABCU9603R1ZX).');
      return;
    }
    if (!form.state_name.trim()) {
      setFormError('State Name is required.');
      return;
    }
    if (!form.tally_ledger_name.trim()) {
      setFormError('Tally Ledger Name is required.');
      return;
    }
    if (editingId) {
      updateSupplier(editingId, form);
    } else {
      addSupplier(selectedCompanyId, form);
    }
    setShowForm(false);
    setForm(EMPTY_FORM);
    setEditingId(null);
    refresh();
  };

  const handleDelete = (id: string, name: string) => {
    if (!confirm(`Delete supplier "${name}"?`)) return;
    deleteSupplier(id);
    refresh();
  };

  // ── Excel template download ──────────────────────────────────────────────
  const downloadTemplate = () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ['Tally Ledger Name', 'GSTIN', 'State Name'],
      ['ABC Enterprises Pvt Ltd', '27AABCU9603R1ZX', 'Maharashtra'],
      ['XYZ Traders', '29AADCB2230M1ZV', 'Karnataka'],
    ]);
    ws['!cols'] = [{ wch: 35 }, { wch: 20 }, { wch: 25 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Supplier Master');
    XLSX.writeFile(wb, 'TallyAI_Supplier_Master_Template.xlsx');
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

      // Find header row (look for "GSTIN" or "Tally Ledger")
      let headerIdx = 0;
      for (let i = 0; i < Math.min(5, raw.length); i++) {
        const row = raw[i].map((c) => String(c).toLowerCase());
        if (row.some((c) => c.includes('gstin') || c.includes('ledger'))) {
          headerIdx = i;
          break;
        }
      }
      const headers = raw[headerIdx].map((h) => String(h).toLowerCase().trim());
      const col = (name: string) => {
        const patterns: Record<string, string[]> = {
          tally_ledger_name: ['tally ledger name', 'ledger name', 'ledger', 'tally ledger', 'name'],
          vendor_gstin: ['gstin', 'gstin/uin', 'gst', 'tin'],
          state_name: ['state name', 'state'],
        };
        for (const p of patterns[name] ?? []) {
          const idx = headers.findIndex((h) => h.includes(p));
          if (idx !== -1) return idx;
        }
        return -1;
      };

      const ledgerCol = col('tally_ledger_name');
      const gstinCol = col('vendor_gstin');
      const stateCol = col('state_name');

      if (gstinCol === -1) {
        setImportResult({
          inserted: 0, updated: 0,
          errors: [{ row: 0, gstin: '—', reason: 'Could not find a GSTIN column in the file' }],
        });
        return;
      }

      const dataRows = raw.slice(headerIdx + 1).filter((r) =>
        r.some((c) => String(c).trim()),
      );

      const rows = dataRows.map((r) => ({
        tally_ledger_name: ledgerCol !== -1 ? String(r[ledgerCol] ?? '') : '',
        vendor_gstin: String(r[gstinCol] ?? ''),
        state_name: stateCol !== -1 ? String(r[stateCol] ?? '') : '',
      }));

      const result = bulkUpsertSuppliers(selectedCompanyId, rows);
      setImportResult(result);
      refresh();
    } catch {
      setImportResult({
        inserted: 0, updated: 0,
        errors: [{ row: 0, gstin: '—', reason: 'Failed to read file. Ensure it is a valid .xlsx or .xls file.' }],
      });
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  // ── Excel export ─────────────────────────────────────────────────────────
  const exportToExcel = () => {
    const rows = suppliers.map((s) => ({
      'Vendor Name': s.vendor_name,
      'GSTIN': s.vendor_gstin,
      'State Name': s.state_name,
      'Tally Ledger Name': s.tally_ledger_name,
      'Created At': s.created_at,
      'Updated At': s.updated_at,
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    ws['!cols'] = [{ wch: 35 }, { wch: 20 }, { wch: 25 }, { wch: 35 }, { wch: 22 }, { wch: 22 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Supplier Master');
    const company = companies.find((c) => c.id === selectedCompanyId);
    XLSX.writeFile(wb, `SupplierMaster_${company?.name ?? 'export'}.xlsx`);
  };

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

  const companyName = companies.find((c) => c.id === selectedCompanyId)?.name ?? '';

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
                Maps vendor GSTIN to Tally party ledger name. Data is isolated per company.
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
                + Add Supplier
              </button>
            </div>
          </div>

          {/* Company selector + search */}
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
            {selectedCompanyId && suppliers.length > 0 && tab === 'list' && (
              <>
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search suppliers…"
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
                  <h2 className="text-sm font-semibold text-gray-900">Import Suppliers from Excel</h2>
                  <p className="text-xs text-gray-500 mt-0.5">Importing into: <span className="font-medium text-gray-700">{companyName}</span></p>
                </div>
                <button onClick={() => setTab('list')} className="text-sm text-gray-400 hover:text-gray-600">✕ Close</button>
              </div>

              <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-xs text-amber-800 mb-4 space-y-1">
                <p className="font-semibold">Expected columns (from Tally Sundry Creditors export):</p>
                <p>• <strong>Tally Ledger Name</strong> — exact ledger name as in Tally</p>
                <p>• <strong>GSTIN</strong> — 15-character GSTIN (leave blank for unregistered parties)</p>
                <p>• <strong>State Name</strong> — supplier's state</p>
                <p className="mt-1 text-amber-700">Vendor Name will default to Tally Ledger Name and auto-update as invoices are processed.</p>
              </div>

              <div className="border-2 border-dashed border-gray-200 rounded-lg p-8 text-center hover:border-indigo-300 transition-colors cursor-pointer"
                onClick={() => fileInputRef.current?.click()}>
                <svg className="w-8 h-8 text-gray-300 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 13h6m-3-3v6m5 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                <p className="text-sm text-gray-500">
                  {importing ? 'Processing…' : 'Click to upload .xlsx / .xls file'}
                </p>
                <p className="text-xs text-gray-400 mt-1">Supports files with hundreds or thousands of rows</p>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xls"
                className="hidden"
                onChange={handleFileChange}
              />

              {/* Import result */}
              {importResult && (
                <div className="mt-4 space-y-3">
                  {(importResult.inserted > 0 || importResult.updated > 0) && (
                    <div className="flex gap-4 bg-green-50 border border-green-200 rounded-lg px-4 py-3 text-sm">
                      {importResult.inserted > 0 && (
                        <span className="text-green-700 font-medium">✓ {importResult.inserted} new supplier{importResult.inserted !== 1 ? 's' : ''} added</span>
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
                            Row {e.row}: <span className="font-mono">{e.gstin}</span> — {e.reason}
                          </p>
                        ))}
                      </div>
                    </div>
                  )}
                  {importResult.errors.length === 0 && importResult.inserted === 0 && importResult.updated === 0 && (
                    <p className="text-sm text-gray-500">No rows were processed.</p>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ── Manual add/edit form ── */}
          {showForm && tab === 'list' && (
            <form
              onSubmit={handleSubmit}
              className="mb-6 bg-white border border-gray-200 rounded-xl p-5 shadow-sm"
            >
              <h2 className="text-sm font-semibold text-gray-900 mb-4">
                {editingId ? 'Edit Supplier' : 'Add Supplier'}
              </h2>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Vendor Name *</label>
                  <input
                    value={form.vendor_name}
                    onChange={(e) => setForm({ ...form, vendor_name: e.target.value })}
                    className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    placeholder="e.g. Sai Electricals"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    Vendor GSTIN
                    <span className="ml-1.5 text-gray-400 font-normal">(leave blank if unregistered)</span>
                  </label>
                  <input
                    value={form.vendor_gstin}
                    onChange={(e) => setForm({ ...form, vendor_gstin: e.target.value.toUpperCase() })}
                    maxLength={15}
                    className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    placeholder="27AABCU9603R1ZX"
                  />
                  {form.vendor_gstin.length > 0 && form.vendor_gstin.length < 15 && (
                    <p className="text-xs text-gray-400 mt-1">{15 - form.vendor_gstin.length} characters remaining</p>
                  )}
                  {form.vendor_gstin.length === 15 && !validateGstin(form.vendor_gstin) && (
                    <p className="text-xs text-red-500 mt-1">Invalid GSTIN format</p>
                  )}
                  {!form.vendor_gstin && (
                    <p className="text-xs text-amber-600 mt-1">Will be treated as unregistered party</p>
                  )}
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">State Name *</label>
                  <select
                    value={form.state_name}
                    onChange={(e) => setForm({ ...form, state_name: e.target.value })}
                    className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  >
                    <option value="">Select state…</option>
                    {INDIAN_STATES.map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Tally Ledger Name *</label>
                  <input
                    value={form.tally_ledger_name}
                    onChange={(e) => setForm({ ...form, tally_ledger_name: e.target.value })}
                    className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    placeholder="e.g. Sai Electricals (exact name in Tally)"
                  />
                  <p className="text-xs text-gray-400 mt-1">Must match exactly as in Tally — case and spaces matter.</p>
                </div>
              </div>
              {formError && <p className="text-sm text-red-600 mt-3">{formError}</p>}
              <div className="flex gap-2 mt-4">
                <button
                  type="submit"
                  className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-md hover:bg-indigo-700 transition-colors"
                >
                  {editingId ? 'Save Changes' : 'Add'}
                </button>
                <button
                  type="button"
                  onClick={() => { setShowForm(false); setEditingId(null); }}
                  className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900"
                >
                  Cancel
                </button>
              </div>
            </form>
          )}

          {/* ── Supplier table ── */}
          {!selectedCompanyId ? (
            <div className="bg-white border border-gray-200 rounded-xl p-10 text-center text-gray-400">
              <p className="text-sm">Select a company to view its supplier master.</p>
            </div>
          ) : filtered.length === 0 ? (
            <div className="bg-white border border-gray-200 rounded-xl p-10 text-center text-gray-400">
              <p className="text-sm">
                {suppliers.length === 0
                  ? 'No suppliers yet. Import from Excel or add manually.'
                  : 'No suppliers match your search.'}
              </p>
            </div>
          ) : (
            <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Vendor Name</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">GSTIN</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">State</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Tally Ledger</th>
                    <th className="px-4 py-3 w-20" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {filtered.map((s) => (
                    <tr key={s.id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-4 py-3">
                        <p className="font-medium text-gray-900">{s.vendor_name}</p>
                        {s.vendor_name !== s.tally_ledger_name && (
                          <p className="text-xs text-indigo-500 mt-0.5">Learned from invoice</p>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs">
                        {isUnregistered(s) ? (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700">
                            Unregistered
                          </span>
                        ) : (
                          <span className="font-mono text-gray-600">{s.vendor_gstin}</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-gray-600 text-xs">{s.state_name || '—'}</td>
                      <td className="px-4 py-3 text-gray-700">{s.tally_ledger_name}</td>
                      <td className="px-4 py-3">
                        <div className="flex gap-2 justify-end">
                          <button onClick={() => openEdit(s)} className="text-xs text-indigo-600 hover:text-indigo-800">Edit</button>
                          <button onClick={() => handleDelete(s.id, s.vendor_name)} className="text-xs text-red-500 hover:text-red-700">Delete</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="px-4 py-2 text-xs text-gray-400 border-t border-gray-100 flex items-center justify-between">
                <span>
                  {filtered.length} supplier{filtered.length !== 1 ? 's' : ''}
                  {search && ` matching "${search}"`}
                  {!search && (() => {
                    const unreg = filtered.filter(isUnregistered).length;
                    return unreg > 0 ? ` · ${unreg} unregistered` : '';
                  })()}
                </span>
                <span className="text-gray-300">Data is strictly isolated to {companyName}</span>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
