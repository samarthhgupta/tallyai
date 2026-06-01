'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { getMyCompanies, createCompany, type Company } from '@/lib/db';
import { signOut } from '@/lib/auth';
import AppSidebar from '@/components/AppSidebar';

export default function CompaniesPage() {
  const router = useRouter();
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [form, setForm] = useState({
    name: '', gstin: '', tally_url: '', tally_port: '9000',
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await getMyCompanies();
      setCompanies(list);
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

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) return;
    setSaving(true);
    setFormError('');
    try {
      await createCompany({
        name: form.name.trim(),
        gstin: form.gstin.trim() || undefined,
        tally_url: form.tally_url.trim() || undefined,
        tally_port: parseInt(form.tally_port) || 9000,
      });
      setForm({ name: '', gstin: '', tally_url: '', tally_port: '9000' });
      setShowForm(false);
      await load();
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : 'Failed to add company');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex min-h-screen bg-gray-50">
      <AppSidebar />
      <main className="ml-60 flex-1 px-6 py-8">
        <div className="max-w-3xl">
          <div className="flex items-center justify-between mb-6">
            <h1 className="text-xl font-semibold text-gray-900">Companies</h1>
            <button
              onClick={() => setShowForm((v) => !v)}
              className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-md hover:bg-indigo-700 transition-colors"
            >
              + Add Company
            </button>
          </div>

          {showForm && (
            <form onSubmit={handleAdd} className="bg-white border border-gray-200 rounded-xl p-5 mb-6 shadow-sm space-y-4">
              <h2 className="text-sm font-semibold text-gray-900">New Company</h2>
              <div className="grid grid-cols-2 gap-4">
                <div className="col-span-2">
                  <label className="block text-xs font-medium text-gray-600 mb-1">Company Name *</label>
                  <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                    required className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    placeholder="e.g. Atul Udyog" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">GSTIN</label>
                  <input value={form.gstin} onChange={(e) => setForm({ ...form, gstin: e.target.value })}
                    className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    placeholder="27AABCU9603R1ZX" maxLength={15} />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Tally Port</label>
                  <input value={form.tally_port} onChange={(e) => setForm({ ...form, tally_port: e.target.value })}
                    type="number" className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    placeholder="9000" />
                </div>
                <div className="col-span-2">
                  <label className="block text-xs font-medium text-gray-600 mb-1">Tally URL / IP</label>
                  <input value={form.tally_url} onChange={(e) => setForm({ ...form, tally_url: e.target.value })}
                    className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    placeholder="http://192.168.1.10" />
                </div>
              </div>
              {formError && <p className="text-sm text-red-600">{formError}</p>}
              <div className="flex gap-2">
                <button type="submit" disabled={saving}
                  className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-md hover:bg-indigo-700 disabled:opacity-50 transition-colors">
                  {saving ? 'Saving…' : 'Save'}
                </button>
                <button type="button" onClick={() => setShowForm(false)}
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
              <p className="text-sm">No companies yet. Add your first firm to get started.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {companies.map((c) => (
                <div key={c.id} className="bg-white border border-gray-200 rounded-lg px-5 py-4 flex items-center justify-between">
                  <div>
                    <p className="font-medium text-gray-900 text-sm">{c.name}</p>
                    <div className="flex gap-3 mt-0.5 text-xs text-gray-500">
                      {c.gstin && <span>GSTIN: <span className="font-mono">{c.gstin}</span></span>}
                      {c.tally_url && <span>Tally: {c.tally_url}:{c.tally_port}</span>}
                    </div>
                  </div>
                  <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-medium">Active</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
