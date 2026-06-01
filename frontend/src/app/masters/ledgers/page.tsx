'use client';

import { useState, useEffect } from 'react';
import AppSidebar from '@/components/AppSidebar';
import { loadCompanies, type LocalCompany } from '@/lib/companies';
import {
  loadLedgers,
  addLedger,
  updateLedger,
  deleteLedger,
  type LedgerMaster,
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

function defaultLedgerNames(gst: number, taxType?: 'cgst_sgst' | 'igst') {
  const half = gst / 2;
  return {
    purchase_ledger: `Purchase @${gst}%`,
    cgst_ledger: `CGST @${half}%`,
    sgst_ledger: `SGST @${half}%`,
    igst_ledger: `IGST @${gst}%`,
  };
}

export default function LedgerMastersPage() {
  const [companies, setCompanies] = useState<LocalCompany[]>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState('');
  const [ledgers, setLedgers] = useState<LedgerMaster[]>([]);

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formError, setFormError] = useState('');
  const [search, setSearch] = useState('');

  useEffect(() => {
    const list = loadCompanies();
    setCompanies(list);
    if (list.length === 1) setSelectedCompanyId(list[0].id);
  }, []);

  useEffect(() => {
    if (selectedCompanyId) setLedgers(loadLedgers(selectedCompanyId));
  }, [selectedCompanyId]);

  const refresh = () => {
    if (selectedCompanyId) setLedgers(loadLedgers(selectedCompanyId));
  };

  const openAdd = () => {
    setEditingId(null);
    const defaults = defaultLedgerNames(18);
    setForm({ ...EMPTY_FORM, ...defaults });
    setFormError('');
    setShowForm(true);
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
  };

  const handleGSTChange = (gst: number) => {
    const auto = defaultLedgerNames(gst);
    setForm((f) => ({ ...f, gst_percent: gst, ...auto }));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.hsn_sac.trim() || !form.purchase_ledger.trim()) {
      setFormError('HSN/SAC code and Purchase Ledger are required.');
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
    if (!confirm(`Delete ledger mapping for HSN "${hsn}"?`)) return;
    deleteLedger(id);
    refresh();
  };

  const filtered = ledgers.filter((l) => {
    const q = search.toLowerCase();
    return (
      !q ||
      l.hsn_sac.toLowerCase().includes(q) ||
      l.description.toLowerCase().includes(q) ||
      l.purchase_ledger.toLowerCase().includes(q)
    );
  });

  return (
    <div className="flex min-h-screen bg-gray-50">
      <AppSidebar />
      <main className="ml-60 flex-1 px-6 py-8">
        <div className="max-w-5xl">
          {/* Header */}
          <div className="flex items-center justify-between mb-1">
            <div>
              <h1 className="text-xl font-semibold text-gray-900">Ledger Master</h1>
              <p className="text-sm text-gray-500 mt-0.5">
                Maps HSN/SAC code + GST rate to Tally purchase and tax ledger names. Company-specific.
              </p>
            </div>
            <button
              onClick={openAdd}
              disabled={!selectedCompanyId}
              className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-md hover:bg-indigo-700 disabled:opacity-40 transition-colors"
            >
              + Add Mapping
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

            {selectedCompanyId && ledgers.length > 0 && (
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search HSN, description…"
                className="ml-auto text-sm border border-gray-300 rounded-md px-3 py-1.5 w-56 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            )}
          </div>

          {/* Form */}
          {showForm && (
            <form
              onSubmit={handleSubmit}
              className="mt-5 bg-white border border-gray-200 rounded-xl p-5 shadow-sm space-y-4"
            >
              <h2 className="text-sm font-semibold text-gray-900">
                {editingId ? 'Edit Ledger Mapping' : 'Add Ledger Mapping'}
              </h2>
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">HSN / SAC Code *</label>
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
                <p className="text-xs text-gray-400 mt-2">Names must match exactly as they appear in Tally — case and spaces matter.</p>
              </div>

              {formError && <p className="text-sm text-red-600">{formError}</p>}
              <div className="flex gap-2">
                <button
                  type="submit"
                  className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-md hover:bg-indigo-700 transition-colors"
                >
                  {editingId ? 'Save Changes' : 'Add Mapping'}
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
                {ledgers.length === 0
                  ? 'No mappings yet. Add one to link HSN/SAC codes to Tally purchase ledgers.'
                  : 'No mappings match your search.'}
              </p>
            </div>
          ) : (
            <div className="mt-6 bg-white border border-gray-200 rounded-xl overflow-hidden">
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
                      <td className="px-4 py-3 font-mono text-gray-700">{l.hsn_sac}</td>
                      <td className="px-4 py-3 text-gray-600">{l.gst_percent}%</td>
                      <td className="px-4 py-3 text-gray-700">{l.description || '—'}</td>
                      <td className="px-4 py-3 text-gray-900 font-medium">{l.purchase_ledger}</td>
                      <td className="px-4 py-3 text-gray-500 text-xs leading-5">
                        {l.cgst_ledger && <div>{l.cgst_ledger}</div>}
                        {l.sgst_ledger && <div>{l.sgst_ledger}</div>}
                        {l.igst_ledger && <div>{l.igst_ledger}</div>}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex gap-2 justify-end">
                          <button
                            onClick={() => openEdit(l)}
                            className="text-xs text-indigo-600 hover:text-indigo-800"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => handleDelete(l.id, l.hsn_sac)}
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
                {filtered.length} mapping{filtered.length !== 1 ? 's' : ''}
                {search && ` matching "${search}"`}
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
