'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import AppSidebar from '@/components/AppSidebar';
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

// Common rate options — user can also type a custom value
const COMMON_RATES = [0, 0.1, 0.25, 1, 1.5, 2, 2.5, 5, 6, 7.5, 9, 12, 14, 18, 28];

const EMPTY_FORM = {
  tax_component: 'CGST' as TaxComponent,
  tax_rate_str: '',        // '' = consolidated (no rate)
  tally_ledger_name: '',
};

// Suggested ledger name based on component + rate
function suggestLedgerName(component: TaxComponent, rateStr: string): string {
  const rate = rateStr === '' ? null : parseFloat(rateStr);
  if (rate == null) return `Input ${component}`;
  return `Input ${component} @ ${rate}%`;
}

// Group rows by tax_component for display
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

  // Auto-fill ledger name suggestion only when field is still empty or matches previous suggestion
  const [ledgerAutoFilled, setLedgerAutoFilled] = useState(false);

  useEffect(() => {
    if (companyLoading) return;
    getSession().then((session) => {
      if (!session && !company) router.replace('/select-company');
    });
  }, [company, companyLoading, router]);

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

  // When component or rate changes, update suggestion if user hasn't typed their own name
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
    setLedgerAutoFilled(false); // user typed their own name — stop auto-filling
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
          tally_ledger_name: form.tally_ledger_name, // stored exactly as typed
        });
      } else {
        await addDutiesTaxes(company?.id ?? '', {
          tax_component: form.tax_component,
          tax_rate: taxRate,
          tally_ledger_name: form.tally_ledger_name, // stored exactly as typed
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
      await refresh();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Failed to delete.');
    }
  };

  const grouped = groupByComponent(records);
  const companyName = company?.name ?? '';

  // Component colour chips
  const componentColour: Record<string, string> = {
    CGST: 'bg-blue-100 text-blue-700',
    SGST: 'bg-indigo-100 text-indigo-700',
    IGST: 'bg-purple-100 text-purple-700',
    CESS: 'bg-orange-100 text-orange-700',
    TDS: 'bg-red-100 text-red-700',
    TCS: 'bg-pink-100 text-pink-700',
    'GST TDS': 'bg-rose-100 text-rose-700',
    'GST TCS': 'bg-fuchsia-100 text-fuchsia-700',
  };

  return (
    <div className="flex min-h-screen bg-gray-50">
      <AppSidebar />
      <main className="ml-60 flex-1 px-6 py-8">
        <div className="max-w-3xl">

          {/* Header */}
          <div className="flex items-start justify-between mb-4">
            <div>
              <h1 className="text-xl font-semibold text-gray-900">Duties & Taxes Master</h1>
              <p className="text-sm text-gray-500 mt-0.5">
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
            <div className="bg-blue-50 border border-blue-200 rounded-lg px-4 py-3 mb-5 text-xs text-blue-800 space-y-1">
              <p className="font-semibold">How this works:</p>
              <p>When an invoice is accepted, the system already knows the CGST, SGST, IGST amounts from extraction.</p>
              <p>This master tells TallyAI <strong>which Tally ledger to credit those amounts to</strong> when generating XML.</p>
              <p className="mt-1">Add one row per ledger. Use <strong>Tax Rate blank</strong> if your Tally uses consolidated ledgers (e.g. "Input CGST"), or enter the rate if you use rate-wise ledgers (e.g. "Input CGST @ 9%").</p>
            </div>
          )}

          {/* ── Form ── */}
          {showForm && (
            <form onSubmit={handleSubmit} className="mb-6 bg-white border border-gray-200 rounded-xl p-5 shadow-sm">
              <h2 className="text-sm font-semibold text-gray-900 mb-4">
                {editingId ? 'Edit Mapping' : 'Add Mapping'}
              </h2>
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Tax Component *</label>
                  <select value={form.tax_component}
                    onChange={(e) => handleComponentChange(e.target.value as TaxComponent)}
                    className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500">
                    {TAX_COMPONENTS.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    Tax Rate %
                    <span className="ml-1 text-gray-400 font-normal">(blank = consolidated)</span>
                  </label>
                  <div className="flex gap-1">
                    <input
                      value={form.tax_rate_str}
                      onChange={(e) => handleRateChange(e.target.value)}
                      className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      placeholder="e.g. 9 or 2.5"
                    />
                  </div>
                  {/* Quick-pick rate buttons */}
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    {[2.5, 5, 9, 14, 18, 28].map((r) => (
                      <button key={r} type="button"
                        onClick={() => handleRateChange(String(r))}
                        className={`text-xs px-1.5 py-0.5 rounded border transition-colors ${
                          form.tax_rate_str === String(r)
                            ? 'bg-indigo-600 text-white border-indigo-600'
                            : 'border-gray-300 text-gray-500 hover:border-indigo-400 hover:text-indigo-600'
                        }`}>{r}%</button>
                    ))}
                    <button type="button"
                      onClick={() => handleRateChange('')}
                      className={`text-xs px-1.5 py-0.5 rounded border transition-colors ${
                        form.tax_rate_str === ''
                          ? 'bg-gray-700 text-white border-gray-700'
                          : 'border-gray-300 text-gray-500 hover:border-gray-500'
                      }`}>Consolidated</button>
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Tally Ledger Name *</label>
                  <input
                    value={form.tally_ledger_name}
                    onChange={(e) => handleLedgerChange(e.target.value)}
                    className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    placeholder={suggestLedgerName(form.tax_component, form.tax_rate_str)}
                  />
                  <p className="text-xs text-gray-400 mt-1">Must match Tally exactly — case and spaces matter.</p>
                </div>
              </div>
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

          {/* ── Records ── */}
          {loading ? (
            <div className="flex justify-center py-12"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-indigo-600" /></div>
          ) : records.length === 0 ? (
            <div className="bg-white border border-gray-200 rounded-xl p-10 text-center text-gray-400">
              <p className="text-sm">No mappings yet. Add your tax ledgers above.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {Array.from(grouped.entries()).map(([component, rows]) => (
                <div key={component} className="bg-white border border-gray-200 rounded-xl overflow-hidden">
                  <div className="px-4 py-2.5 bg-gray-50 border-b border-gray-100 flex items-center gap-2">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold ${componentColour[component] ?? 'bg-gray-100 text-gray-600'}`}>
                      {component}
                    </span>
                    <span className="text-xs text-gray-400">{rows.length} ledger{rows.length !== 1 ? 's' : ''}</span>
                  </div>
                  <table className="w-full text-sm">
                    <tbody className="divide-y divide-gray-50">
                      {rows.map((r) => (
                        <tr key={r.id} className="hover:bg-gray-50 transition-colors">
                          <td className="px-4 py-3 w-28">
                            {r.tax_rate != null ? (
                              <span className="text-xs font-mono text-gray-600 bg-gray-100 px-2 py-0.5 rounded">{r.tax_rate}%</span>
                            ) : (
                              <span className="text-xs text-gray-400 italic">Consolidated</span>
                            )}
                          </td>
                          <td className="px-4 py-3 font-medium text-gray-900 font-mono text-xs">
                            {r.tally_ledger_name}
                          </td>
                          <td className="px-4 py-3 w-20">
                            <div className="flex gap-2 justify-end">
                              <button onClick={() => openEdit(r)} className="text-xs text-indigo-600 hover:text-indigo-800">Edit</button>
                              <button onClick={() => handleDelete(r.id, r.tally_ledger_name)} className="text-xs text-red-500 hover:text-red-700">Delete</button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
              <p className="text-xs text-gray-400 text-right px-1">
                {records.length} mapping{records.length !== 1 ? 's' : ''} · Isolated to {companyName}
              </p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
