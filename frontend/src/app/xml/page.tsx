'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { getMyCompanies, getPurchaseRegister, type Company } from '@/lib/db';
import { loadSuppliers } from '@/lib/suppliers';
import { loadDutiesTaxes } from '@/lib/dutiesTaxes';
import { loadStockItems } from '@/lib/stockItems';
import { loadExpenseLedgers } from '@/lib/expenseLedgers';
import { generateTallyXml, type PurchaseLedgerEntry } from '@/lib/xmlGenerator';
import type { StoredInvoice } from '@/types/invoice';
import AppSidebar from '@/components/AppSidebar';
import { getFYList, getMonthsForFY, currentFY, type MonthOption } from '@/lib/fyPeriod';

// ─── Purchase Ledger Mapping UI ───────────────────────────────────────────────

const COMMON_GST_RATES = [0, 5, 12, 18, 28];

interface PurchaseLedgerRowProps {
  entry: PurchaseLedgerEntry;
  onChange: (updated: PurchaseLedgerEntry) => void;
  onRemove: () => void;
}

function PurchaseLedgerRow({ entry, onChange, onRemove }: PurchaseLedgerRowProps) {
  return (
    <div className="flex items-center gap-3">
      <div className="w-36">
        <select
          value={entry.gst_percent ?? ''}
          onChange={(e) => onChange({ ...entry, gst_percent: e.target.value === '' ? null : Number(e.target.value) })}
          className="w-full border border-gray-200 rounded-md px-3 py-1.5 text-sm text-gray-900"
        >
          <option value="">All rates (fallback)</option>
          {COMMON_GST_RATES.map((r) => (
            <option key={r} value={r}>{r}% GST</option>
          ))}
          <option value="custom">Custom…</option>
        </select>
      </div>
      <div className="flex-1">
        <input
          type="text"
          value={entry.tally_ledger_name}
          onChange={(e) => onChange({ ...entry, tally_ledger_name: e.target.value })}
          placeholder="Tally purchase ledger name (exact)"
          className="w-full border border-gray-200 rounded-md px-3 py-1.5 text-sm font-mono text-gray-900"
        />
      </div>
      <button onClick={onRemove} className="text-gray-400 hover:text-red-500 transition-colors text-lg leading-none">×</button>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function XmlGeneratorPage() {
  const router = useRouter();

  const [companies, setCompanies] = useState<Company[]>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState('');

  const [fyList] = useState<string[]>(getFYList);
  const [selectedFY, setSelectedFY] = useState(currentFY);
  const [monthOptions, setMonthOptions] = useState<MonthOption[]>([]);
  const [selectedMonth, setSelectedMonth] = useState('');

  const [invoices, setInvoices] = useState<StoredInvoice[]>([]);
  const [loadingInvoices, setLoadingInvoices] = useState(false);

  const [purchaseLedgers, setPurchaseLedgers] = useState<PurchaseLedgerEntry[]>([
    { gst_percent: null, tally_ledger_name: '' },
  ]);

  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<{ xml: string; includedCount: number; skipped: Array<{ invoice_number: string; reason: string }>; warnings: Array<{ invoice_number: string; warning: string }> } | null>(null);
  const [loadError, setLoadError] = useState('');

  // Auth
  useEffect(() => {
    getSession().then(async (session) => {
      if (!session) { router.replace('/login'); return; }
      try {
        const list = await getMyCompanies();
        setCompanies(list);
        if (list.length === 1) setSelectedCompanyId(list[0].id);
      } catch { /* ignore */ }
    });
  }, [router]);

  // Months
  useEffect(() => {
    setMonthOptions(getMonthsForFY(selectedFY));
    setSelectedMonth('');
  }, [selectedFY]);

  // Load invoices on company/period change
  useEffect(() => {
    if (!selectedCompanyId) { setInvoices([]); return; }
    setLoadingInvoices(true);
    setLoadError('');
    getPurchaseRegister(selectedCompanyId, {
      financialYear: selectedFY || undefined,
      periodMonth: selectedMonth || undefined,
    })
      .then(setInvoices)
      .catch((e) => setLoadError(e.message ?? 'Failed to load invoices'))
      .finally(() => setLoadingInvoices(false));
  }, [selectedCompanyId, selectedFY, selectedMonth]);

  const selectedCompany = companies.find((c) => c.id === selectedCompanyId);

  const addPurchaseLedgerRow = () => {
    setPurchaseLedgers((prev) => [...prev, { gst_percent: null, tally_ledger_name: '' }]);
  };

  const updatePurchaseLedgerRow = (idx: number, updated: PurchaseLedgerEntry) => {
    setPurchaseLedgers((prev) => prev.map((r, i) => i === idx ? updated : r));
  };

  const removePurchaseLedgerRow = (idx: number) => {
    setPurchaseLedgers((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleGenerate = async () => {
    if (!selectedCompanyId || !selectedCompany) return;
    if (!selectedCompany.tally_company_name) {
      alert('This company is missing a Tally Company Name. Please update it in Companies settings first.');
      return;
    }
    const validLedgers = purchaseLedgers.filter((p) => p.tally_ledger_name.trim() !== '');
    if (validLedgers.length === 0) {
      alert('Please configure at least one purchase ledger mapping.');
      return;
    }
    if (invoices.length === 0) {
      alert('No accepted invoices found for the selected period.');
      return;
    }

    setGenerating(true);
    setResult(null);
    try {
      const [suppliers, dutiesTaxes, stockItems, expenseLedgers] = await Promise.all([
        loadSuppliers(selectedCompanyId),
        loadDutiesTaxes(selectedCompanyId),
        loadStockItems(selectedCompanyId),
        loadExpenseLedgers(selectedCompanyId),
      ]);

      const output = generateTallyXml({
        invoices,
        suppliers,
        dutiesTaxes,
        stockItems,
        expenseLedgers,
        purchaseLedgers: validLedgers,
        tallyCompanyName: selectedCompany.tally_company_name,
      });

      setResult({
        xml: output.xml,
        includedCount: output.includedCount,
        skipped: output.skippedInvoices,
        warnings: output.warnings,
      });
    } catch (e: unknown) {
      setLoadError(e instanceof Error ? e.message : 'XML generation failed');
    } finally {
      setGenerating(false);
    }
  };

  const handleDownload = () => {
    if (!result?.xml) return;
    const company = selectedCompany?.tally_company_name ?? selectedCompany?.name ?? 'export';
    const period = selectedMonth
      ? monthOptions.find((m) => m.period_month === selectedMonth)?.period_label ?? selectedMonth
      : selectedFY;
    const filename = `${company}_${period}_purchase.xml`
      .replace(/[^a-zA-Z0-9._-]/g, '_');
    const blob = new Blob([result.xml], { type: 'application/xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex min-h-screen bg-gray-50">
      <AppSidebar />
      <main className="ml-60 flex-1 p-8 max-w-4xl">
        <div className="mb-7">
          <h1 className="text-2xl font-bold text-gray-900">Generate Tally XML</h1>
          <p className="text-sm text-gray-500 mt-1">
            Exports accepted invoices as Tally-compatible purchase voucher XML. All ledger names are used exactly as stored in your masters.
          </p>
        </div>

        {/* Company + Period */}
        <div className="bg-white border border-gray-200 rounded-xl p-6 mb-5">
          <h2 className="text-sm font-semibold text-gray-700 mb-4">1. Select Company &amp; Period</h2>
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="block text-xs text-gray-500 mb-1.5">Company</label>
              <select
                value={selectedCompanyId}
                onChange={(e) => setSelectedCompanyId(e.target.value)}
                className="w-full border border-gray-200 rounded-md px-3 py-2 text-sm text-gray-900"
              >
                <option value="">Select company…</option>
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1.5">Financial Year</label>
              <select
                value={selectedFY}
                onChange={(e) => setSelectedFY(e.target.value)}
                className="w-full border border-gray-200 rounded-md px-3 py-2 text-sm text-gray-900"
              >
                {fyList.map((fy) => (
                  <option key={fy} value={fy}>{fy}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1.5">Month</label>
              <select
                value={selectedMonth}
                onChange={(e) => setSelectedMonth(e.target.value)}
                className="w-full border border-gray-200 rounded-md px-3 py-2 text-sm text-gray-900"
              >
                <option value="">All months</option>
                {monthOptions.map((m) => (
                  <option key={m.period_month} value={m.period_month}>{m.period_label}</option>
                ))}
              </select>
            </div>
          </div>

          {selectedCompanyId && !selectedCompany?.tally_company_name && (
            <div className="mt-3 flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-lg px-4 py-2.5 text-sm text-amber-800">
              <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
              </svg>
              <span>
                <strong>Tally Company Name is missing.</strong> The XML header requires this.{' '}
                <button onClick={() => router.push('/companies')} className="underline">Update in Companies</button>
              </span>
            </div>
          )}

          {selectedCompanyId && (
            <div className="mt-3 flex items-center gap-2 text-sm text-gray-500">
              {loadingInvoices ? (
                <span className="text-gray-400">Loading invoices…</span>
              ) : loadError ? (
                <span className="text-red-600">{loadError}</span>
              ) : (
                <span>
                  <span className="font-semibold text-gray-800">{invoices.length}</span> accepted invoice{invoices.length !== 1 ? 's' : ''} found
                </span>
              )}
            </div>
          )}
        </div>

        {/* Purchase Ledger Mapping */}
        <div className="bg-white border border-gray-200 rounded-xl p-6 mb-5">
          <div className="flex items-center justify-between mb-1">
            <h2 className="text-sm font-semibold text-gray-700">2. Purchase Ledger Mapping</h2>
          </div>
          <p className="text-xs text-gray-400 mb-4">
            Map each GST rate to the Tally purchase ledger that receives the taxable amount. Add a fallback row (no rate) to catch any unmapped rates.
          </p>
          <div className="space-y-2.5">
            {purchaseLedgers.map((entry, idx) => (
              <PurchaseLedgerRow
                key={idx}
                entry={entry}
                onChange={(u) => updatePurchaseLedgerRow(idx, u)}
                onRemove={() => removePurchaseLedgerRow(idx)}
              />
            ))}
          </div>
          <button
            onClick={addPurchaseLedgerRow}
            className="mt-3 text-sm text-indigo-600 hover:text-indigo-800 font-medium"
          >
            + Add row
          </button>
        </div>

        {/* Generate */}
        <div className="bg-white border border-gray-200 rounded-xl p-6 mb-5">
          <h2 className="text-sm font-semibold text-gray-700 mb-4">3. Generate &amp; Download</h2>
          <button
            onClick={handleGenerate}
            disabled={generating || !selectedCompanyId || invoices.length === 0}
            className="px-6 py-2.5 bg-indigo-600 text-white rounded-lg text-sm font-semibold hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {generating ? 'Generating…' : 'Generate XML'}
          </button>

          {result && (
            <div className="mt-5 space-y-4">
              {/* Summary */}
              <div className="flex items-center gap-4">
                <div className="flex items-center gap-2 bg-green-50 border border-green-200 rounded-lg px-4 py-2.5">
                  <svg className="w-4 h-4 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  <span className="text-sm font-semibold text-green-800">{result.includedCount} voucher{result.includedCount !== 1 ? 's' : ''} generated</span>
                </div>
                {result.skipped.length > 0 && (
                  <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-lg px-4 py-2.5">
                    <span className="text-sm font-semibold text-red-800">{result.skipped.length} skipped</span>
                  </div>
                )}
                {result.warnings.length > 0 && (
                  <div className="flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-lg px-4 py-2.5">
                    <span className="text-sm font-semibold text-amber-800">{result.warnings.length} warning{result.warnings.length !== 1 ? 's' : ''}</span>
                  </div>
                )}
              </div>

              {/* Skipped invoices */}
              {result.skipped.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-red-700 mb-1.5">Skipped — fix these and regenerate:</p>
                  <div className="border border-red-200 rounded-lg overflow-hidden">
                    {result.skipped.map((s, i) => (
                      <div key={i} className={`flex gap-3 px-4 py-2.5 text-sm ${i % 2 === 0 ? 'bg-red-50' : 'bg-white'}`}>
                        <span className="font-mono text-gray-700 shrink-0">{s.invoice_number}</span>
                        <span className="text-red-700">{s.reason}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Warnings */}
              {result.warnings.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-amber-700 mb-1.5">Warnings (these vouchers were still included):</p>
                  <div className="border border-amber-200 rounded-lg overflow-hidden">
                    {result.warnings.map((w, i) => (
                      <div key={i} className={`flex gap-3 px-4 py-2.5 text-sm ${i % 2 === 0 ? 'bg-amber-50' : 'bg-white'}`}>
                        <span className="font-mono text-gray-700 shrink-0">{w.invoice_number}</span>
                        <span className="text-amber-800">{w.warning}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Download */}
              {result.includedCount > 0 && (
                <button
                  onClick={handleDownload}
                  className="flex items-center gap-2 px-5 py-2.5 bg-gray-900 text-white rounded-lg text-sm font-semibold hover:bg-gray-800 transition-colors"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                  Download XML
                </button>
              )}
            </div>
          )}
        </div>

        {/* How-to info */}
        <div className="bg-blue-50 border border-blue-200 rounded-xl px-5 py-4 text-sm text-blue-800">
          <p className="font-semibold mb-1">How to import into Tally</p>
          <ol className="list-decimal list-inside space-y-1 text-blue-700">
            <li>Open Tally and select the company <strong>{selectedCompany?.tally_company_name ?? '—'}</strong></li>
            <li>Go to <em>Gateway of Tally → Import Data → Vouchers</em></li>
            <li>Select the downloaded XML file</li>
            <li>Tally will create purchase vouchers for all included invoices</li>
          </ol>
        </div>
      </main>
    </div>
  );
}
