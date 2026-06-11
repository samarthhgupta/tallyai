'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import AppSidebar from '@/components/AppSidebar';
import { getSession } from '@/lib/auth';
import { useCompany } from '@/lib/companyContext';
import {
  loadPurchaseLedgers,
  addPurchaseLedger,
  deletePurchaseLedger,
  updatePurchaseLedger,
  type PurchaseLedgerMaster,
} from '@/lib/purchaseLedgers';

export default function PurchaseLedgerPage() {
  const { company, loading: companyLoading } = useCompany();
  const router = useRouter();
  const [ledgers, setLedgers] = useState<PurchaseLedgerMaster[]>([]);
  const [loading, setLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [formName, setFormName] = useState('');
  const [editingName, setEditingName] = useState<string | null>(null);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (companyLoading) return;
    getSession().then((session) => {
      if (!session) { router.replace('/login'); return; }
      if (!company) router.replace('/select-company');
    });
  }, [company, companyLoading, router]);

  const refresh = useCallback(async () => {
    if (!company?.id) return;
    setLoading(true);
    try { setLedgers(await loadPurchaseLedgers(company.id)); }
    finally { setLoading(false); }
  }, [company]);

  useEffect(() => { refresh(); }, [refresh]);

  const openAdd = () => {
    setEditingName(null);
    setFormName('');
    setFormError('');
    setShowForm(true);
  };

  const openEdit = (name: string) => {
    setEditingName(name);
    setFormName(name);
    setFormError('');
    setShowForm(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = formName.trim();
    if (!name) { setFormError('Tally Ledger Name is required.'); return; }
    setSaving(true);
    setFormError('');
    try {
      if (editingName) {
        await updatePurchaseLedger(company!.id, editingName, name);
      } else {
        await addPurchaseLedger(company!.id, name);
      }
      setShowForm(false);
      setEditingName(null);
      await refresh();
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : 'Failed to save.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (name: string) => {
    if (!confirm(`Delete purchase ledger "${name}"?`)) return;
    try { await deletePurchaseLedger(company!.id, name); await refresh(); }
    catch (err: unknown) { alert(err instanceof Error ? err.message : 'Failed to delete.'); }
  };

  return (
    <div className="flex min-h-screen bg-gray-50">
      <AppSidebar />
      <main className="ml-60 flex-1 px-6 py-8">
        <div className="max-w-2xl">

          <div className="flex items-start justify-between mb-6">
            <div>
              <h1 className="text-xl font-semibold text-gray-900">Purchase Ledger Master</h1>
              <p className="text-sm text-gray-500 mt-0.5">
                Maps purchase invoices to Tally purchase ledger names. The first entry is used as the default suggestion in Export Preview.
              </p>
            </div>
            <button onClick={openAdd} disabled={!company?.id}
              className="px-3 py-2 bg-indigo-600 text-white text-sm font-medium rounded-md hover:bg-indigo-700 disabled:opacity-40 transition-colors">
              + Add Ledger
            </button>
          </div>

          {showForm && (
            <form onSubmit={handleSubmit} className="mb-6 bg-white border border-gray-200 rounded-xl p-5 shadow-sm">
              <h2 className="text-sm font-semibold text-gray-900 mb-4">
                {editingName ? 'Edit Purchase Ledger' : 'Add Purchase Ledger'}
              </h2>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Tally Ledger Name *</label>
                <input
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  autoFocus
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  placeholder="e.g. Purchase"
                />
                <p className="text-xs text-gray-400 mt-1">Stored exactly as entered — must match Tally.</p>
              </div>
              {formError && <p className="text-sm text-red-600 mt-3">{formError}</p>}
              <div className="flex gap-2 mt-4">
                <button type="submit" disabled={saving}
                  className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-md hover:bg-indigo-700 disabled:opacity-50 transition-colors">
                  {saving ? 'Saving…' : editingName ? 'Save Changes' : 'Add'}
                </button>
                <button type="button" onClick={() => { setShowForm(false); setEditingName(null); }}
                  className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900">Cancel</button>
              </div>
            </form>
          )}

          {loading ? (
            <div className="flex justify-center py-12"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-indigo-600" /></div>
          ) : ledgers.length === 0 ? (
            <div className="bg-white border border-gray-200 rounded-xl p-10 text-center text-gray-400">
              <p className="text-sm">No purchase ledgers yet.</p>
              <p className="text-xs mt-1 text-gray-300">Ledgers are added automatically when you accept a Purchase Ledger (Tally) suggestion in Export Preview, or add one manually above.</p>
            </div>
          ) : (
            <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Tally Ledger Name</th>
                    <th className="px-4 py-3 w-24" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {ledgers.map((l, i) => (
                    <tr key={l.tally_ledger_name} className="hover:bg-gray-50 transition-colors">
                      <td className="px-4 py-3 font-medium text-gray-900 font-mono text-xs flex items-center gap-2">
                        {i === 0 && (
                          <span className="bg-blue-100 text-blue-700 text-[10px] font-semibold px-1.5 py-0.5 rounded">DEFAULT</span>
                        )}
                        {l.tally_ledger_name}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex gap-2 justify-end">
                          <button onClick={() => openEdit(l.tally_ledger_name)} className="text-xs text-indigo-600 hover:text-indigo-800">Edit</button>
                          <button onClick={() => handleDelete(l.tally_ledger_name)} className="text-xs text-red-500 hover:text-red-700">Delete</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="px-4 py-2 text-xs text-gray-400 border-t border-gray-100">
                {ledgers.length} ledger{ledgers.length !== 1 ? 's' : ''} — first entry is the default suggestion
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
