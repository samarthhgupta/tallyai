'use client';

import { useState, useEffect } from 'react';
import AppSidebar from '@/components/AppSidebar';
import { loadCompanies, type LocalCompany } from '@/lib/companies';
import {
  loadSuppliers,
  addSupplier,
  updateSupplier,
  deleteSupplier,
  type SupplierMaster,
} from '@/lib/suppliers';

const EMPTY_FORM = { vendor_name: '', vendor_gstin: '', tally_ledger_name: '' };

export default function SupplierMastersPage() {
  const [companies, setCompanies] = useState<LocalCompany[]>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState('');
  const [suppliers, setSuppliers] = useState<SupplierMaster[]>([]);

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formError, setFormError] = useState('');

  const [search, setSearch] = useState('');

  useEffect(() => {
    const list = loadCompanies();
    setCompanies(list);
    if (list.length === 1) setSelectedCompanyId(list[0].id);
  }, []);

  useEffect(() => {
    if (selectedCompanyId) setSuppliers(loadSuppliers(selectedCompanyId));
  }, [selectedCompanyId]);

  const refresh = () => {
    if (selectedCompanyId) setSuppliers(loadSuppliers(selectedCompanyId));
  };

  const openAdd = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setFormError('');
    setShowForm(true);
  };

  const openEdit = (s: SupplierMaster) => {
    setEditingId(s.id);
    setForm({
      vendor_name: s.vendor_name,
      vendor_gstin: s.vendor_gstin,
      tally_ledger_name: s.tally_ledger_name,
    });
    setFormError('');
    setShowForm(true);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.vendor_name.trim() || !form.tally_ledger_name.trim()) {
      setFormError('Vendor name and Tally ledger name are required.');
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

  const filtered = suppliers.filter((s) => {
    const q = search.toLowerCase();
    return (
      !q ||
      s.vendor_name.toLowerCase().includes(q) ||
      s.vendor_gstin.toLowerCase().includes(q) ||
      s.tally_ledger_name.toLowerCase().includes(q)
    );
  });

  return (
    <div className="flex min-h-screen bg-gray-50">
      <AppSidebar />
      <main className="ml-60 flex-1 px-6 py-8">
        <div className="max-w-4xl">
          {/* Header */}
          <div className="flex items-center justify-between mb-1">
            <div>
              <h1 className="text-xl font-semibold text-gray-900">Supplier Master</h1>
              <p className="text-sm text-gray-500 mt-0.5">
                Maps vendor GSTIN to Tally party ledger name. Company-specific.
              </p>
            </div>
            <button
              onClick={openAdd}
              disabled={!selectedCompanyId}
              className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-md hover:bg-indigo-700 disabled:opacity-40 transition-colors"
            >
              + Add Supplier
            </button>
          </div>

          {/* Company selector */}
          <div className="mt-4 flex items-center gap-3">
            <label className="text-sm font-medium text-gray-700">Company</label>
            {companies.length === 0 ? (
              <span className="text-sm text-gray-400">No companies. Add one first.</span>
            ) : (
              <select
                value={selectedCompanyId}
                onChange={(e) => setSelectedCompanyId(e.target.value)}
                className="text-sm border border-gray-300 rounded-md px-3 py-1.5 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                <option value="" disabled>Select company…</option>
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            )}

            {selectedCompanyId && suppliers.length > 0 && (
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search suppliers…"
                className="ml-auto text-sm border border-gray-300 rounded-md px-3 py-1.5 w-56 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            )}
          </div>

          {/* Add / Edit form */}
          {showForm && (
            <form
              onSubmit={handleSubmit}
              className="mt-5 bg-white border border-gray-200 rounded-xl p-5 shadow-sm space-y-4"
            >
              <h2 className="text-sm font-semibold text-gray-900">
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
                  <label className="block text-xs font-medium text-gray-600 mb-1">Vendor GSTIN</label>
                  <input
                    value={form.vendor_gstin}
                    onChange={(e) => setForm({ ...form, vendor_gstin: e.target.value.toUpperCase() })}
                    maxLength={15}
                    className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    placeholder="27AABCU9603R1ZX"
                  />
                </div>
                <div className="col-span-2">
                  <label className="block text-xs font-medium text-gray-600 mb-1">Tally Ledger Name *</label>
                  <input
                    value={form.tally_ledger_name}
                    onChange={(e) => setForm({ ...form, tally_ledger_name: e.target.value })}
                    className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    placeholder="e.g. Sai Electricals (exact name in Tally)"
                  />
                  <p className="text-xs text-gray-400 mt-1">Must match exactly as it appears in Tally — case and spaces matter.</p>
                </div>
              </div>
              {formError && <p className="text-sm text-red-600">{formError}</p>}
              <div className="flex gap-2">
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

          {/* Table */}
          {!selectedCompanyId ? null : filtered.length === 0 ? (
            <div className="mt-6 bg-white border border-gray-200 rounded-xl p-10 text-center text-gray-400">
              <p className="text-sm">
                {suppliers.length === 0
                  ? 'No suppliers yet. Add one to start mapping vendor GSTINs to Tally ledgers.'
                  : 'No suppliers match your search.'}
              </p>
            </div>
          ) : (
            <div className="mt-6 bg-white border border-gray-200 rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide w-[28%]">Vendor Name</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide w-[28%]">GSTIN</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Tally Ledger</th>
                    <th className="px-4 py-3 w-20" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {filtered.map((s) => (
                    <tr key={s.id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-4 py-3 font-medium text-gray-900">{s.vendor_name}</td>
                      <td className="px-4 py-3 font-mono text-gray-600">{s.vendor_gstin || '—'}</td>
                      <td className="px-4 py-3 text-gray-700">{s.tally_ledger_name}</td>
                      <td className="px-4 py-3">
                        <div className="flex gap-2 justify-end">
                          <button
                            onClick={() => openEdit(s)}
                            className="text-xs text-indigo-600 hover:text-indigo-800"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => handleDelete(s.id, s.vendor_name)}
                            className="text-xs text-red-500 hover:text-red-700"
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="px-4 py-2 text-xs text-gray-400 border-t border-gray-100">
                {filtered.length} supplier{filtered.length !== 1 ? 's' : ''}
                {search && ` matching "${search}"`}
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
