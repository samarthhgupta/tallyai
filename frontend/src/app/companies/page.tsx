'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { getMyCompanies, createCompany, updateCompany, type Company } from '@/lib/db';
import { validateGstin, deriveStateFromGstin } from '@/lib/suppliers';
import AppSidebar from '@/components/AppSidebar';

const EMPTY_FORM = {
  name: '',
  gstin: '',
  tally_company_name: '',
  tally_url: '',
  tally_port: '9000',
};

export default function CompaniesPage() {
  const router = useRouter();
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setCompanies(await getMyCompanies());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    getSession().then((s) => {
      if (!s) { router.replace('/login'); return; }
      load();
    });
  }, [router, load]);

  const openAdd = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setFormError('');
    setShowForm(true);
  };

  const openEdit = (c: Company) => {
    setEditingId(c.id);
    setForm({
      name: c.name,
      gstin: c.gstin ?? '',
      tally_company_name: c.tally_company_name ?? '',
      tally_url: c.tally_url ?? '',
      tally_port: String(c.tally_port ?? 9000),
    });
    setFormError('');
    setShowForm(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) { setFormError('Company Name is required.'); return; }
    if (!form.gstin.trim()) { setFormError('GSTIN is required.'); return; }
    if (!validateGstin(form.gstin)) { setFormError('Invalid GSTIN format.'); return; }
    if (!form.tally_company_name.trim()) { setFormError('Tally Company Name is required.'); return; }

    setSaving(true);
    setFormError('');
    try {
      const params = {
        name: form.name.trim(),
        gstin: form.gstin.trim().toUpperCase(),
        tally_company_name: form.tally_company_name, // stored exactly as typed
        tally_url: form.tally_url.trim() || undefined,
        tally_port: parseInt(form.tally_port) || 9000,
      };
      if (editingId) {
        await updateCompany(editingId, params);
      } else {
        await createCompany(params);
      }
      setShowForm(false);
      setEditingId(null);
      await load();
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : 'Failed to save company');
    } finally {
      setSaving(false);
    }
  };

  // Live state derivation in form
  const gstin = form.gstin.trim().toUpperCase();
  const derivedState = gstin.length >= 2 ? (deriveStateFromGstin(gstin) ?? null) : null;
  const gstinValid = gstin.length === 15 ? validateGstin(gstin) : null;

  return (
    <div className="flex min-h-screen bg-gray-50">
      <AppSidebar />
      <main className="ml-60 flex-1 px-6 py-8">
        <div className="max-w-3xl">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h1 className="text-xl font-semibold text-gray-900">Companies</h1>
              <p className="text-sm text-gray-500 mt-0.5">Each company's data is fully isolated.</p>
            </div>
            <button onClick={openAdd}
              className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-md hover:bg-indigo-700 transition-colors">
              + Add Company
            </button>
          </div>

          {showForm && (
            <form onSubmit={handleSubmit} className="bg-white border border-gray-200 rounded-xl p-5 mb-6 shadow-sm">
              <h2 className="text-sm font-semibold text-gray-900 mb-4">
                {editingId ? 'Edit Company' : 'New Company'}
              </h2>
              <div className="grid grid-cols-2 gap-4">

                {/* Company Name */}
                <div className="col-span-2">
                  <label className="block text-xs font-medium text-gray-600 mb-1">Company Name *</label>
                  <input value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    placeholder="e.g. Sahar Stationers" />
                </div>

                {/* GSTIN */}
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Company GSTIN *</label>
                  <input value={form.gstin}
                    onChange={(e) => setForm({ ...form, gstin: e.target.value.toUpperCase() })}
                    maxLength={15}
                    className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    placeholder="27AABCS1234C1ZX" />
                  {gstinValid === false && (
                    <p className="text-xs text-red-500 mt-1">Invalid GSTIN format</p>
                  )}
                </div>

                {/* State — auto-derived, read only */}
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">State <span className="font-normal text-gray-400">(auto-derived)</span></label>
                  <div className="w-full border border-gray-200 bg-gray-50 rounded-md px-3 py-2 text-sm min-h-[38px] flex items-center">
                    {derivedState
                      ? <span className="text-green-700 font-medium">{derivedState}</span>
                      : <span className="text-gray-400">Enter GSTIN to derive</span>
                    }
                  </div>
                </div>

                {/* Tally Company Name */}
                <div className="col-span-2">
                  <label className="block text-xs font-medium text-gray-600 mb-1">Tally Company Name *</label>
                  <input value={form.tally_company_name}
                    onChange={(e) => setForm({ ...form, tally_company_name: e.target.value })}
                    className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    placeholder="Exact company name as in Tally" />
                  <p className="text-xs text-gray-400 mt-1">Must match exactly as configured in Tally — used in XML generation header.</p>
                </div>

                {/* Tally URL */}
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Tally URL / IP <span className="font-normal text-gray-400">(optional)</span></label>
                  <input value={form.tally_url}
                    onChange={(e) => setForm({ ...form, tally_url: e.target.value })}
                    className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    placeholder="http://192.168.1.10" />
                </div>

                {/* Tally Port */}
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Tally Port <span className="font-normal text-gray-400">(optional)</span></label>
                  <input value={form.tally_port}
                    onChange={(e) => setForm({ ...form, tally_port: e.target.value })}
                    type="number"
                    className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    placeholder="9000" />
                </div>

              </div>
              {formError && <p className="text-sm text-red-600 mt-3">{formError}</p>}
              <div className="flex gap-2 mt-4">
                <button type="submit" disabled={saving}
                  className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-md hover:bg-indigo-700 disabled:opacity-50 transition-colors">
                  {saving ? 'Saving…' : editingId ? 'Save Changes' : 'Save'}
                </button>
                <button type="button" onClick={() => { setShowForm(false); setEditingId(null); }}
                  className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900">
                  Cancel
                </button>
              </div>
            </form>
          )}

          {loading ? (
            <div className="flex justify-center py-12">
              <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-indigo-600" />
            </div>
          ) : companies.length === 0 ? (
            <div className="bg-white border border-gray-200 rounded-xl p-10 text-center text-gray-400">
              <p className="text-sm">No companies yet. Add your first company to get started.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {companies.map((c) => (
                <div key={c.id} className="bg-white border border-gray-200 rounded-lg px-5 py-4">
                  <div className="flex items-start justify-between">
                    <div>
                      <p className="font-semibold text-gray-900 text-sm">{c.name}</p>
                      {c.tally_company_name && c.tally_company_name !== c.name && (
                        <p className="text-xs text-gray-400 mt-0.5">Tally: <span className="font-mono">{c.tally_company_name}</span></p>
                      )}
                      <div className="flex flex-wrap gap-3 mt-1.5 text-xs text-gray-500">
                        {c.gstin && (
                          <span>GSTIN: <span className="font-mono text-gray-700">{c.gstin}</span></span>
                        )}
                        {c.state_name && (
                          <span className="text-gray-500">{c.state_name}</span>
                        )}
                        {c.tally_url && (
                          <span>Tally: {c.tally_url}:{c.tally_port}</span>
                        )}
                      </div>
                      {!c.gstin && (
                        <p className="text-xs text-amber-600 mt-1">⚠ GSTIN not set — required for XML generation and state derivation</p>
                      )}
                      {!c.tally_company_name && (
                        <p className="text-xs text-amber-600 mt-1">⚠ Tally Company Name not set — required for XML generation</p>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0 ml-4">
                      <button onClick={() => openEdit(c)}
                        className="text-xs text-indigo-600 hover:text-indigo-800 font-medium">
                        Edit
                      </button>
                      <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-medium">Active</span>
                    </div>
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
