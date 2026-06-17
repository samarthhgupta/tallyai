'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import AppLayout from '@/components/AppLayout';
import { getSession } from '@/lib/auth';
import { useCompany } from '@/lib/companyContext';
import {
  loadDutiesTaxes,
  addDutiesTaxes,
  updateDutiesTaxes,
  deleteDutiesTaxes,
  TAX_COMPONENTS,
  type DutiesTaxesMaster,
  type TaxComponent,
} from '@/lib/dutiesTaxes';

const EMPTY_FORM = {
  tax_component: 'CGST' as TaxComponent,
  tax_rate_str: '',
  tally_ledger_name: '',
};

function suggestLedgerName(component: TaxComponent, rateStr: string): string {
  const rate = rateStr === '' ? null : parseFloat(rateStr);
  if (rate == null) return `Input ${component}`;
  return `Input ${component} @ ${rate}%`;
}

function groupByComponent(rows: DutiesTaxesMaster[]): Map<string, DutiesTaxesMaster[]> {
  const map = new Map<string, DutiesTaxesMaster[]>();
  for (const r of rows) {
    const existing = map.get(r.tax_component) ?? [];
    existing.push(r);
    map.set(r.tax_component, existing);
  }
  return map;
}

export default function DutiesTaxesPage() {
  const { company, loading: companyLoading } = useCompany();
  const router = useRouter();
  const [records, setRecords] = useState<DutiesTaxesMaster[]>([]);
  const [loading, setLoading] = useState(false);

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const [ledgerAutoFilled, setLedgerAutoFilled] = useState(false);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
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

  useEffect(() => { setSelectedIds(new Set()); }, [company?.id]);

  const refresh = useCallback(async () => {
    if (!company?.id) return;
    setLoading(true);
    try {
      setRecords(await loadDutiesTaxes(company.id));
    } finally {
      setLoading(false);
    }
  }, [company]);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    if (!selectAllRef.current) return;
    const some = selectedIds.size > 0 && selectedIds.size < records.length;
    selectAllRef.current.indeterminate = some;
  }, [selectedIds, records.length]);

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === records.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(records.map((r) => r.id)));
    }
  };

  const handleBulkDelete = async () => {
    setBulkDeleting(true);
    try {
      await Promise.all([...selectedIds].map((id) => deleteDutiesTaxes(id)));
      setSelectedIds(new Set());
      setShowBulkConfirm(false);
      await refresh();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Failed to delete some records.');
      setShowBulkConfirm(false);
      await refresh();
    } finally {
      setBulkDeleting(false);
    }
  };

  // ── Form helpers ─────────────────────────────────────────────────────────
  const openAdd = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setLedgerAutoFilled(true);
    setFormError('');
    setShowForm(true);
  };

  const openEdit = (r: DutiesTaxesMaster) => {
    setEditingId(r.id);
    setForm({
      tax_component: r.tax_component,
      tax_rate_str: r.tax_rate != null ? String(r.tax_rate) : '',
      tally_ledger_name: r.tally_ledger_name,
    });
    setLedgerAutoFilled(false);
    setFormError('');
    setShowForm(true);
  };

  const handleComponentChange = (component: TaxComponent) => {
    const next = { ...form, tax_component: component };
    if (ledgerAutoFilled) {
      next.tally_ledger_name = suggestLedgerName(component, form.tax_rate_str);
    }
    setForm(next);
  };

  const handleRateChange = (rateStr: string) => {
    const next = { ...form, tax_rate_str: rateStr };
    if (ledgerAutoFilled) {
      next.tally_ledger_name = suggestLedgerName(form.tax_component, rateStr);
    }
    setForm(next);
  };

  const handleLedgerChange = (val: string) => {
    setLedgerAutoFilled(false);
    setForm({ ...form, tally_ledger_name: val });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.tally_ledger_name) {
      setFormError('Tally Ledger Name is required.');
      return;
    }
    const taxRate = form.tax_rate_str === '' ? null : parseFloat(form.tax_rate_str);
    if (form.tax_rate_str !== '' && isNaN(taxRate!)) {
      setFormError('Tax rate must be a number (e.g. 9 or 2.5), or leave blank for consolidated.');
      return;
    }
    setSaving(true);
    setFormError('');
    try {
      if (editingId) {
        await updateDutiesTaxes(editingId, {
          tax_component: form.tax_component,
          tax_rate: taxRate,
          tally_ledger_name: form.tally_ledger_name,
        });
      } else {
        await addDutiesTaxes(company?.id ?? '', {
          tax_component: form.tax_component,
          tax_rate: taxRate,
          tally_ledger_name: form.tally_ledger_name,
        });
      }
      setShowForm(false);
      setEditingId(null);
      await refresh();
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : 'Failed to save.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string, label: string) => {
    if (!confirm(`Delete mapping "${label}"?`)) return;
    try {
      await deleteDutiesTaxes(id);
      setSelectedIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
      await refresh();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Failed to delete.');
    }
  };

  const grouped = groupByComponent(records);
  const companyName = company?.name ?? '';

  const componentColour: Record<string, string> = {
    CGST: 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300',
    SGST: 'bg-indigo-100 dark:bg-indigo-800 text-indigo-700 dark:text-indigo-300',
    IGST: 'bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300',
    CESS: 'bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-400',
    TDS: 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400',
    TCS: 'bg-pink-100 dark:bg-pink-900/30 text-pink-700 dark:text-pink-300',
    'GST TDS': 'bg-rose-100 dark:bg-rose-900/30 text-rose-700 dark:text-rose-300',
    'GST TCS': 'bg-fuchsia-100 dark:bg-fuchsia-900/30 text-fuchsia-700 dark:text-fuchsia-300',
  };

  return (
    <AppLayout>
      <main className="flex-1 px-6 py-8">
        <div className="max-w-3xl">

          {/* Header */}
          <div className="flex items-start justify-between mb-4">
            <div>
              <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">Duties & Taxes Master</h1>
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
                Maps tax components to exact Tally tax ledger names. Used during XML generation.
              </p>
            </div>
            <button onClick={openAdd} disabled={!company?.id}
              className="px-3 py-2 bg-indigo-600 text-white text-sm font-medium rounded-md hover:bg-indigo-700 disabled:opacity-40 transition-colors">
              + Add Mapping
            </button>
          </div>

          {/* Info banner */}
          {company?.id && records.length === 0 && !loading && (
            <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg px-4 py-3 mb-5 text-xs text-blue-800 dark:text-blue-200 space-y-1">
              <p className="font-semibold">How this works:</p>
              <p>When an invoice is accepted, the system already knows the CGST, SGST, IGST amounts from extraction.</p>
              <p>This master tells TallyAI <strong>which Tally ledger to credit those amounts to</strong> when generating XML.</p>
              <p className="mt-1">Add one row per ledger. Use <strong>Tax Rate blank</strong> if your Tally uses consolidated ledgers (e.g. "Input CGST"), or enter the rate if you use rate-wise ledgers (e.g. "Input CGST @ 9%").</p>
            </div>
          )}

          {/* ── Form ── */}
          {showForm && (
            <form onSubmit={handleSubmit} className="mb-6 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-5 shadow-sm">
              <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-4">
                {editingId ? 'Edit Mapping' : 'Add Mapping'}
              </h2>
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Tax Component *</label>
                  <select value={form.tax_component}
                    onChange={(e) => handleComponentChange(e.target.value as TaxComponent)}
                    className="w-full border border-gray-300 dark:border-gray-600 rounded-md px-3 py-2 text-sm bg-white dark:bg-gray-700 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500">
                    {TAX_COMPONENTS.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                    Tax Rate %
                    <span className="ml-1 text-gray-400 dark:text-gray-500 font-normal">(blank = consolidated)</span>
                  </label>
                  <div className="flex gap-1">
                    <input
                      value={form.tax_rate_str}
                      onChange={(e) => handleRateChange(e.target.value)}
                      className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 dark:placeholder-gray-400 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      placeholder="e.g. 9 or 2.5"
                    />
                  </div>
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    {[2.5, 5, 9, 14, 18, 28].map((r) => (
                      <button key={r} type="button"
                        onClick={() => handleRateChange(String(r))}
                        className={`text-xs px-1.5 py-0.5 rounded border transition-colors ${
                          form.tax_rate_str === String(r)
                            ? 'bg-indigo-600 text-white border-indigo-600'
                            : 'border-gray-300 dark:border-gray-600 text-gray-500 dark:text-gray-400 hover:border-indigo-400 hover:text-indigo-600 dark:hover:text-indigo-400'
                        }`}>{r}%</button>
                    ))}
                    <button type="button"
                      onClick={() => handleRateChange('')}
                      className={`text-xs px-1.5 py-0.5 rounded border transition-colors ${
                        form.tax_rate_str === ''
                          ? 'bg-gray-700 text-white border-gray-700'
                          : 'border-gray-300 dark:border-gray-600 text-gray-500 dark:text-gray-400 hover:border-gray-500'
                      }`}>Consolidated</button>
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Tally Ledger Name *</label>
                  <input
                    value={form.tally_ledger_name}
                    onChange={(e) => handleLedgerChange(e.target.value)}
                    className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 dark:placeholder-gray-400 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    placeholder={suggestLedgerName(form.tax_component, form.tax_rate_str)}
                  />
                  <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">Must match Tally exactly - case and spaces matter.</p>
                </div>
              </div>
              {formError && <p className="text-sm text-red-600 dark:text-red-400 mt-3">{formError}</p>}
              <div className="flex gap-2 mt-4">
                <button type="submit" disabled={saving}
                  className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-md hover:bg-indigo-700 disabled:opacity-50 transition-colors">
                  {saving ? 'Saving…' : editingId ? 'Save Changes' : 'Add'}
                </button>
                <button type="button" onClick={() => { setShowForm(false); setEditingId(null); }}
                  className="px-4 py-2 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100">
                  Cancel
                </button>
              </div>
            </form>
          )}

          {/* ── Bulk action bar ── */}
          {selectedIds.size > 0 && (
            <div className="flex items-center gap-3 mb-3 px-4 py-2.5 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
              <span className="text-sm text-red-700 dark:text-red-400 font-medium">{selectedIds.size} selected</span>
              <button onClick={() => setShowBulkConfirm(true)}
                className="text-sm text-red-600 dark:text-red-400 hover:text-red-800 font-medium">
                Delete Selected ({selectedIds.size})
              </button>
              <button onClick={() => setSelectedIds(new Set())}
                className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 ml-auto">
                Cancel
              </button>
            </div>
          )}

          {/* ── Records ── */}
          {loading ? (
            <div className="flex justify-center py-12"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-indigo-600" /></div>
          ) : records.length === 0 ? (
            <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-10 text-center text-gray-400 dark:text-gray-500">
              <p className="text-sm">No mappings yet. Add your tax ledgers above.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {/* Select all row */}
              <div className="flex items-center gap-2 px-1">
                <input
                  ref={selectAllRef}
                  type="checkbox"
                  checked={selectedIds.size === records.length && records.length > 0}
                  onChange={toggleSelectAll}
                  className="rounded border-gray-300 dark:border-gray-600 text-indigo-600 focus:ring-indigo-500"
                />
                <span className="text-xs text-gray-400 dark:text-gray-500">Select all {records.length} mapping{records.length !== 1 ? 's' : ''}</span>
              </div>

              {Array.from(grouped.entries()).map(([component, rows]) => (
                <div key={component} className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
                  <div className="px-4 py-2.5 bg-gray-50 dark:bg-gray-800 border-b border-gray-100 dark:border-gray-700 flex items-center gap-2">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold ${componentColour[component] ?? 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400'}`}>
                      {component}
                    </span>
                    <span className="text-xs text-gray-400 dark:text-gray-500">{rows.length} ledger{rows.length !== 1 ? 's' : ''}</span>
                  </div>
                  <table className="w-full text-sm">
                    <tbody className="divide-y divide-gray-50 dark:divide-gray-700">
                      {rows.map((r) => (
                        <tr key={r.id} className={`hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors ${selectedIds.has(r.id) ? 'bg-red-50 dark:bg-red-900/20' : ''}`}>
                          <td className="px-4 py-3 w-8">
                            <input
                              type="checkbox"
                              checked={selectedIds.has(r.id)}
                              onChange={() => toggleSelect(r.id)}
                              className="rounded border-gray-300 dark:border-gray-600 text-indigo-600 focus:ring-indigo-500"
                            />
                          </td>
                          <td className="px-4 py-3 w-28">
                            {r.tax_rate != null ? (
                              <span className="text-xs font-mono text-gray-600 dark:text-gray-400 bg-gray-100 dark:bg-gray-700 px-2 py-0.5 rounded">{r.tax_rate}%</span>
                            ) : (
                              <span className="text-xs text-gray-400 dark:text-gray-500 italic">Consolidated</span>
                            )}
                          </td>
                          <td className="px-4 py-3 font-medium text-gray-900 dark:text-gray-100 font-mono text-xs">
                            {r.tally_ledger_name}
                          </td>
                          <td className="px-4 py-3 w-20">
                            <div className="flex gap-2 justify-end">
                              <button onClick={() => openEdit(r)} className="text-xs text-indigo-600 dark:text-indigo-400 hover:text-indigo-800">Edit</button>
                              <button onClick={() => handleDelete(r.id, r.tally_ledger_name)} className="text-xs text-red-500 dark:text-red-400 hover:text-red-700">Delete</button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
              <p className="text-xs text-gray-400 dark:text-gray-500 text-right px-1">
                {records.length} mapping{records.length !== 1 ? 's' : ''} · Isolated to {companyName}
              </p>
            </div>
          )}
        </div>
      </main>

      {/* ── Bulk delete confirmation modal ── */}
      {showBulkConfirm && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 px-4">
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl w-full max-w-sm p-6">
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-2">Delete {selectedIds.size} mapping{selectedIds.size !== 1 ? 's' : ''}?</h2>
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
