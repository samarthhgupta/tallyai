'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import * as XLSX from 'xlsx';
import AppSidebar from '@/components/AppSidebar';
import { getSession } from '@/lib/auth';
import { useCompany } from '@/lib/companyContext';
import {
  loadExpenseLedgers,
  addExpenseLedger,
  updateExpenseLedger,
  deleteExpenseLedger,
  bulkUpsertExpenseLedgers,
  COMMON_EXPENSES,
  type ExpenseLedgerMaster,
  type ExpenseLedgerImportResult,
} from '@/lib/expenseLedgers';

type Tab = 'list' | 'import';

const EMPTY_FORM = {
  tally_ledger_name: '',
  expense_keyword: '',
  sac_code: '',
};

export default function ExpenseLedgersPage() {
  const { company, loading: companyLoading } = useCompany();
  const router = useRouter();
  const [ledgers, setLedgers] = useState<ExpenseLedgerMaster[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<Tab>('list');

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importResult, setImportResult] = useState<ExpenseLedgerImportResult | null>(null);
  const [importing, setImporting] = useState(false);

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
    try {
      setLedgers(await loadExpenseLedgers(company.id));
    } finally {
      setLoading(false);
    }
  }, [company]);

  useEffect(() => { refresh(); }, [refresh]);

  // ── Manual form ──────────────────────────────────────────────────────────
  const openAdd = (prefill?: string) => {
    setEditingId(null);
    setForm({ ...EMPTY_FORM, tally_ledger_name: prefill ?? '' });
    setFormError('');
    setShowForm(true);
    setTab('list');
  };

  const openEdit = (l: ExpenseLedgerMaster) => {
    setEditingId(l.id);
    setForm({
      tally_ledger_name: l.tally_ledger_name,
      expense_keyword: l.expense_keyword ?? '',
      sac_code: l.sac_code ?? '',
    });
    setFormError('');
    setShowForm(true);
    setTab('list');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.tally_ledger_name) { setFormError('Tally Ledger Name is required.'); return; }
    setSaving(true);
    setFormError('');
    try {
      const params = {
        tally_ledger_name: form.tally_ledger_name, // stored exactly as typed
        expense_keyword: form.expense_keyword || undefined,
        sac_code: form.sac_code || undefined,
      };
      if (editingId) {
        await updateExpenseLedger(editingId, params);
      } else {
        await addExpenseLedger(company?.id ?? '', params);
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

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Delete expense ledger "${name}"?`)) return;
    try {
      await deleteExpenseLedger(id);
      await refresh();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Failed to delete.');
    }
  };

  // ── Excel template download ──────────────────────────────────────────────
  const downloadTemplate = () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ['Tally Ledger Name', 'Expense Keyword', 'SAC Code'],
      ['Freight Charges', 'freight', '996511'],
      ['Courier Charges', 'courier', '996812'],
      ['Packing Charges', 'packing', ''],
      ['Loading & Unloading', 'loading', ''],
      ['Insurance Charges', 'insurance', '997135'],
    ]);
    ws['!cols'] = [{ wch: 35 }, { wch: 25 }, { wch: 12 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Expense Ledgers');
    XLSX.writeFile(wb, 'TallyAI_ExpenseLedger_Master_Template.xlsx');
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

      let headerIdx = 0;
      for (let i = 0; i < Math.min(5, raw.length); i++) {
        const row = raw[i].map((c) => String(c).toLowerCase());
        if (row.some((c) => c.includes('ledger') || c.includes('expense') || c.includes('tally'))) {
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

      const ledgerCol = colIdx(['tally ledger name', 'ledger name', 'ledger', 'tally ledger', 'name', 'particulars']);
      const keywordCol = colIdx(['expense keyword', 'keyword', 'description', 'expense type']);
      const sacCol = colIdx(['sac code', 'sac', 'hsn/sac']);

      if (ledgerCol === -1) {
        setImportResult({ inserted: 0, updated: 0, errors: [{ row: 0, ledger: '—', reason: 'Could not find Tally Ledger Name column' }] });
        return;
      }

      const dataRows = raw.slice(headerIdx + 1).filter((r) => r.some((c) => String(c).trim()));
      const rows = dataRows.map((r) => ({
        tally_ledger_name: String(r[ledgerCol] ?? ''), // NOT trimmed
        expense_keyword: keywordCol !== -1 ? String(r[keywordCol] ?? '') : '',
        sac_code: sacCol !== -1 ? String(r[sacCol] ?? '') : '',
      }));

      const result = await bulkUpsertExpenseLedgers(company.id, rows);
      setImportResult(result);
      await refresh();
    } catch (err: unknown) {
      setImportResult({ inserted: 0, updated: 0, errors: [{ row: 0, ledger: '—', reason: err instanceof Error ? err.message : 'Failed to read file' }] });
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  // ── Excel export ─────────────────────────────────────────────────────────
  const exportToExcel = () => {
    const rows = ledgers.map((l) => ({
      'Tally Ledger Name': l.tally_ledger_name,
      'Expense Keyword': l.expense_keyword ?? '',
      'SAC Code': l.sac_code ?? '',
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    ws['!cols'] = [{ wch: 35 }, { wch: 25 }, { wch: 12 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Expense Ledgers');
    XLSX.writeFile(wb, `ExpenseLedgers_${company?.name ?? 'export'}.xlsx`);
  };

  const filtered = ledgers.filter((l) => {
    const q = search.toLowerCase();
    return !q ||
      l.tally_ledger_name.toLowerCase().includes(q) ||
      (l.expense_keyword ?? '').toLowerCase().includes(q);
  });

  // Which common expenses are not yet added
  const existingNames = new Set(ledgers.map((l) => l.tally_ledger_name.toLowerCase().trim()));
  const suggestedExpenses = COMMON_EXPENSES.filter((e) => !existingNames.has(e.toLowerCase()));

  const companyName = company?.name ?? '';

  return (
    <div className="flex min-h-screen bg-gray-50">
      <AppSidebar />
      <main className="ml-60 flex-1 px-6 py-8">
        <div className="max-w-4xl">

          {/* Header */}
          <div className="flex items-start justify-between mb-4">
            <div>
              <h1 className="text-xl font-semibold text-gray-900">Expense Ledger Master</h1>
              <p className="text-sm text-gray-500 mt-0.5">
                Maps freight, courier, packing and other charges to exact Tally expense ledger names.
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
              <button onClick={() => openAdd()} disabled={!company?.id}
                className="px-3 py-2 bg-indigo-600 text-white text-sm font-medium rounded-md hover:bg-indigo-700 disabled:opacity-40 transition-colors">
                + Add Ledger
              </button>
            </div>
          </div>

          {/* Search / export row */}
          <div className="flex items-center gap-3 mb-5">
            {company?.id && ledgers.length > 0 && tab === 'list' && (
              <>
                <input value={search} onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search ledgers…"
                  className="ml-auto text-sm border border-gray-300 rounded-md px-3 py-1.5 w-52 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                <button onClick={exportToExcel} className="text-sm text-gray-500 hover:text-gray-700 flex items-center gap-1">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                  Export
                </button>
              </>
            )}
          </div>

          {/* ── Quick-add suggestions ── */}
          {company?.id && !loading && suggestedExpenses.length > 0 && tab === 'list' && !showForm && (
            <div className="mb-5 bg-white border border-gray-200 rounded-xl px-4 py-3">
              <p className="text-xs font-medium text-gray-500 mb-2">Common expense ledgers not yet added — click to add:</p>
              <div className="flex flex-wrap gap-2">
                {suggestedExpenses.map((exp) => (
                  <button key={exp} onClick={() => openAdd(exp)}
                    className="text-xs px-3 py-1.5 rounded-full border border-gray-200 text-gray-600 hover:border-indigo-400 hover:text-indigo-600 hover:bg-indigo-50 transition-colors">
                    + {exp}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* ── Import panel ── */}
          {tab === 'import' && company?.id && (
            <div className="bg-white border border-gray-200 rounded-xl p-6 mb-6 shadow-sm">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h2 className="text-sm font-semibold text-gray-900">Import Expense Ledgers from Excel</h2>
                  <p className="text-xs text-gray-500 mt-0.5">Into: <span className="font-medium text-gray-700">{companyName}</span></p>
                </div>
                <button onClick={() => setTab('list')} className="text-sm text-gray-400 hover:text-gray-600">✕ Close</button>
              </div>

              <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-xs text-amber-800 mb-4 space-y-1">
                <p className="font-semibold">Expected columns:</p>
                <p>• <strong>Tally Ledger Name</strong> — exact expense ledger name as in Tally (required)</p>
                <p>• <strong>Expense Keyword</strong> — the word/phrase on invoices that maps to this ledger (optional)</p>
                <p>• <strong>SAC Code</strong> — optional, not required for XML generation</p>
                <p className="mt-1 text-amber-700">Ledger names are stored exactly as in your file — no changes are made.</p>
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
                      {importResult.inserted > 0 && <span className="text-green-700 font-medium">✓ {importResult.inserted} new ledger{importResult.inserted !== 1 ? 's' : ''} added</span>}
                      {importResult.updated > 0 && <span className="text-blue-700 font-medium">↻ {importResult.updated} existing record{importResult.updated !== 1 ? 's' : ''} updated</span>}
                    </div>
                  )}
                  {importResult.errors.length > 0 && (
                    <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3">
                      <p className="text-sm font-medium text-red-700 mb-2">{importResult.errors.length} row{importResult.errors.length !== 1 ? 's' : ''} skipped:</p>
                      <div className="space-y-1 max-h-48 overflow-y-auto">
                        {importResult.errors.map((e, i) => (
                          <p key={i} className="text-xs text-red-600">Row {e.row}: <span className="font-mono">{e.ledger}</span> — {e.reason}</p>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ── Manual form ── */}
          {showForm && tab === 'list' && (
            <form onSubmit={handleSubmit} className="mb-6 bg-white border border-gray-200 rounded-xl p-5 shadow-sm">
              <h2 className="text-sm font-semibold text-gray-900 mb-4">
                {editingId ? 'Edit Expense Ledger' : 'Add Expense Ledger'}
              </h2>
              <div className="grid grid-cols-3 gap-4">
                <div className="col-span-3">
                  <label className="block text-xs font-medium text-gray-600 mb-1">Tally Ledger Name *</label>
                  <input value={form.tally_ledger_name}
                    onChange={(e) => setForm({ ...form, tally_ledger_name: e.target.value })}
                    className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    placeholder="e.g. Freight Charges" />
                  <p className="text-xs text-gray-400 mt-1">Stored exactly as entered — must match Tally.</p>
                </div>
                <div className="col-span-2">
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    Expense Keyword
                    <span className="ml-1 text-gray-400 font-normal">(how it appears on invoices)</span>
                  </label>
                  <input value={form.expense_keyword}
                    onChange={(e) => setForm({ ...form, expense_keyword: e.target.value })}
                    className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    placeholder="e.g. freight" />
                  <p className="text-xs text-gray-400 mt-1">Used to auto-match invoice expense lines to this ledger.</p>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    SAC Code
                    <span className="ml-1 text-gray-400 font-normal">(optional)</span>
                  </label>
                  <input value={form.sac_code}
                    onChange={(e) => setForm({ ...form, sac_code: e.target.value })}
                    className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    placeholder="e.g. 996511" />
                </div>
              </div>
              {formError && <p className="text-sm text-red-600 mt-3">{formError}</p>}
              <div className="flex gap-2 mt-4">
                <button type="submit" disabled={saving}
                  className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-md hover:bg-indigo-700 disabled:opacity-50 transition-colors">
                  {saving ? 'Saving…' : editingId ? 'Save Changes' : 'Add'}
                </button>
                <button type="button" onClick={() => { setShowForm(false); setEditingId(null); }}
                  className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900">Cancel</button>
              </div>
            </form>
          )}

          {/* ── Table ── */}
          {loading ? (
            <div className="flex justify-center py-12"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-indigo-600" /></div>
          ) : filtered.length === 0 ? (
            <div className="bg-white border border-gray-200 rounded-xl p-10 text-center text-gray-400">
              <p className="text-sm">{ledgers.length === 0 ? 'No expense ledgers yet. Add from suggestions above or import from Excel.' : 'No ledgers match your search.'}</p>
            </div>
          ) : (
            <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Tally Ledger Name</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Expense Keyword</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide w-28">SAC</th>
                    <th className="px-4 py-3 w-20" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {filtered.map((l) => (
                    <tr key={l.id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-4 py-3 font-medium text-gray-900 font-mono text-xs">{l.tally_ledger_name}</td>
                      <td className="px-4 py-3 text-xs text-gray-500">
                        {l.expense_keyword
                          ? <span className="bg-gray-100 text-gray-600 px-2 py-0.5 rounded font-mono">{l.expense_keyword}</span>
                          : <span className="italic text-gray-300">—</span>
                        }
                      </td>
                      <td className="px-4 py-3 text-xs font-mono text-gray-500">{l.sac_code || '—'}</td>
                      <td className="px-4 py-3">
                        <div className="flex gap-2 justify-end">
                          <button onClick={() => openEdit(l)} className="text-xs text-indigo-600 hover:text-indigo-800">Edit</button>
                          <button onClick={() => handleDelete(l.id, l.tally_ledger_name)} className="text-xs text-red-500 hover:text-red-700">Delete</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="px-4 py-2 text-xs text-gray-400 border-t border-gray-100 flex justify-between">
                <span>{filtered.length} ledger{filtered.length !== 1 ? 's' : ''}{search && ` matching "${search}"`}</span>
                <span className="text-gray-300">Isolated to {companyName}</span>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
