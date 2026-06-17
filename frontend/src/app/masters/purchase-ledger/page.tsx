'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import AppLayout from '@/components/AppLayout';
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

  const [selectedNames, setSelectedNames] = useState<Set<string>>(new Set());
  const [showBulkConfirm, setShowBulkConfirm] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const selectAllRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (companyLoading) return;
    getSession().then((session) => {
      if (!session) { router.replace('/login'); return; }
      if (!company) router.replace('/select-company');
    });
  }, [company, companyLoading, router]);

  useEffect(() => { setSelectedNames(new Set()); }, [company?.id]);

  const refresh = useCallback(async () => {
    if (!company?.id) return;
    setLoading(true);
    try { setLedgers(await loadPurchaseLedgers(company.id)); }
    finally { setLoading(false); }
  }, [company]);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    if (!selectAllRef.current) return;
    const some = selectedNames.size > 0 && selectedNames.size < ledgers.length;
    selectAllRef.current.indeterminate = some;
  }, [selectedNames, ledgers.length]);

  const toggleSelect = (name: string) => {
    setSelectedNames((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedNames.size === ledgers.length) {
      setSelectedNames(new Set());
    } else {
      setSelectedNames(new Set(ledgers.map((l) => l.tally_ledger_name)));
    }
  };

  const handleBulkDelete = async () => {
    if (!company?.id) return;
    setBulkDeleting(true);
    try {
      await Promise.all([...selectedNames].map((name) => deletePurchaseLedger(company!.id, name)));
      setSelectedNames(new Set());
      setShowBulkConfirm(false);
      await refresh();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Failed to delete some ledgers.');
      setShowBulkConfirm(false);
      await refresh();
    } finally {
      setBulkDeleting(false);
    }
  };

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
    try {
      await deletePurchaseLedger(company!.id, name);
      setSelectedNames((prev) => { const next = new Set(prev); next.delete(name); return next; });
      await refresh();
    }
    catch (err: unknown) { alert(err instanceof Error ? err.message : 'Failed to delete.'); }
  };

  return (
    <AppLayout>
      <main className="flex-1 px-6 py-8">
        <div className="max-w-2xl">

          <div className="flex items-start justify-between mb-6">
            <div>
              <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">Purchase Ledger Master</h1>
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
                Maps purchase invoices to Tally purchase ledger names. The first entry is used as the default suggestion in Export Preview.
              </p>
            </div>
            <button onClick={openAdd} disabled={!company?.id}
              className="px-3 py-2 bg-indigo-600 text-white text-sm font-medium rounded-md hover:bg-indigo-700 disabled:opacity-40 transition-colors">
              + Add Ledger
            </button>
          </div>

          {showForm && (
            <form onSubmit={handleSubmit} className="mb-6 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5 shadow-sm">
              <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-4">
                {editingName ? 'Edit Purchase Ledger' : 'Add Purchase Ledger'}
              </h2>
              <div>
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Tally Ledger Name *</label>
                <input
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  autoFocus
                  className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 dark:placeholder-gray-400 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  placeholder="e.g. Purchase"
                />
                <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">Stored exactly as entered — must match Tally.</p>
              </div>
              {formError && <p className="text-sm text-red-600 dark:text-red-400 mt-3">{formError}</p>}
              <div className="flex gap-2 mt-4">
                <button type="submit" disabled={saving}
                  className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-md hover:bg-indigo-700 disabled:opacity-50 transition-colors">
                  {saving ? 'Saving…' : editingName ? 'Save Changes' : 'Add'}
                </button>
                <button type="button" onClick={() => { setShowForm(false); setEditingName(null); }}
                  className="px-4 py-2 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100">Cancel</button>
              </div>
            </form>
          )}

          {/* ── Bulk action bar ── */}
          {selectedNames.size > 0 && (
            <div className="flex items-center gap-3 mb-3 px-4 py-2.5 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
              <span className="text-sm text-red-700 dark:text-red-400 font-medium">{selectedNames.size} selected</span>
              <button onClick={() => setShowBulkConfirm(true)}
                className="text-sm text-red-600 dark:text-red-400 hover:text-red-800 font-medium">
                Delete Selected ({selectedNames.size})
              </button>
              <button onClick={() => setSelectedNames(new Set())}
                className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 ml-auto">
                Cancel
              </button>
            </div>
          )}

          {loading ? (
            <div className="flex justify-center py-12"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-indigo-600" /></div>
          ) : ledgers.length === 0 ? (
            <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-10 text-center text-gray-400 dark:text-gray-500">
              <p className="text-sm">No purchase ledgers yet.</p>
              <p className="text-xs mt-1 text-gray-300 dark:text-gray-600">Ledgers are added automatically when you accept a Purchase Ledger (Tally) suggestion in Export Preview, or add one manually above.</p>
            </div>
          ) : (
            <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
                  <tr>
                    <th className="px-4 py-3 w-8">
                      <input
                        ref={selectAllRef}
                        type="checkbox"
                        checked={selectedNames.size === ledgers.length && ledgers.length > 0}
                        onChange={toggleSelectAll}
                        className="rounded border-gray-300 dark:border-gray-600 text-indigo-600 focus:ring-indigo-500"
                      />
                    </th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Tally Ledger Name</th>
                    <th className="px-4 py-3 w-24" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                  {ledgers.map((l, i) => (
                    <tr key={l.tally_ledger_name} className={`hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors ${selectedNames.has(l.tally_ledger_name) ? 'bg-red-50 dark:bg-red-900/20' : ''}`}>
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          checked={selectedNames.has(l.tally_ledger_name)}
                          onChange={() => toggleSelect(l.tally_ledger_name)}
                          className="rounded border-gray-300 dark:border-gray-600 text-indigo-600 focus:ring-indigo-500"
                        />
                      </td>
                      <td className="px-4 py-3 font-medium text-gray-900 dark:text-gray-100 font-mono text-xs flex items-center gap-2">
                        {i === 0 && (
                          <span className="bg-blue-100 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 text-[10px] font-semibold px-1.5 py-0.5 rounded">DEFAULT</span>
                        )}
                        {l.tally_ledger_name}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex gap-2 justify-end">
                          <button onClick={() => openEdit(l.tally_ledger_name)} className="text-xs text-indigo-600 dark:text-indigo-400 hover:text-indigo-800">Edit</button>
                          <button onClick={() => handleDelete(l.tally_ledger_name)} className="text-xs text-red-500 dark:text-red-400 hover:text-red-700">Delete</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="px-4 py-2 text-xs text-gray-400 dark:text-gray-500 border-t border-gray-100 dark:border-gray-700">
                {ledgers.length} ledger{ledgers.length !== 1 ? 's' : ''} — first entry is the default suggestion
              </div>
            </div>
          )}
        </div>
      </main>

      {/* ── Bulk delete confirmation modal ── */}
      {showBulkConfirm && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 px-4">
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl w-full max-w-sm p-6">
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-2">Delete {selectedNames.size} ledger{selectedNames.size !== 1 ? 's' : ''}?</h2>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-5">This action cannot be undone.</p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setShowBulkConfirm(false)} disabled={bulkDeleting}
                className="px-4 py-2 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100">
                Cancel
              </button>
              <button onClick={handleBulkDelete} disabled={bulkDeleting}
                className="px-4 py-2 bg-red-600 text-white text-sm font-medium rounded-md hover:bg-red-700 disabled:opacity-50 transition-colors">
                {bulkDeleting ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </AppLayout>
  );
}
