'use client';

import { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { getPurchaseRegister } from '@/lib/db';
import { loadSuppliers } from '@/lib/suppliers';
import { loadDutiesTaxes } from '@/lib/dutiesTaxes';
import { loadStockItems } from '@/lib/stockItems';
import { loadExpenseLedgers } from '@/lib/expenseLedgers';
import { generateTallyXml, buildTallyPreview, type PurchaseLedgerEntry, type PreviewRow } from '@/lib/xmlGenerator';
import type { StoredInvoice } from '@/types/invoice';
import AppSidebar from '@/components/AppSidebar';
import { getFYList, currentFY } from '@/lib/fyPeriod';
import { useCompany } from '@/lib/companyContext';
import FYPeriodSelector from '@/components/FYPeriodSelector';
import * as XLSX from 'xlsx';

// ─── Constants ────────────────────────────────────────────────────────────────

const COMMON_GST_RATES = [0, 5, 12, 18, 28];

const LEDGER_TYPE_COLORS: Record<PreviewRow['ledger_type'], string> = {
  Party:      'bg-purple-100 text-purple-700',
  Purchase:   'bg-blue-100 text-blue-700',
  CGST:       'bg-teal-100 text-teal-700',
  SGST:       'bg-teal-100 text-teal-700',
  IGST:       'bg-cyan-100 text-cyan-700',
  Expense:    'bg-orange-100 text-orange-700',
  'Round Off':'bg-gray-100 text-gray-600',
};

// ─── Sub-components ───────────────────────────────────────────────────────────

function PurchaseLedgerRow({
  entry, onChange, onRemove,
}: {
  entry: PurchaseLedgerEntry;
  onChange: (u: PurchaseLedgerEntry) => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <div className="w-44">
        <select
          value={entry.gst_percent ?? ''}
          onChange={(e) =>
            onChange({ ...entry, gst_percent: e.target.value === '' ? null : Number(e.target.value) })
          }
          className="w-full border border-gray-200 rounded-md px-3 py-1.5 text-sm text-gray-900"
        >
          <option value="">All rates (fallback)</option>
          {COMMON_GST_RATES.map((r) => (
            <option key={r} value={r}>{r}% GST</option>
          ))}
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
      <button
        onClick={onRemove}
        className="text-gray-400 hover:text-red-500 transition-colors text-xl leading-none"
      >
        ×
      </button>
    </div>
  );
}

// ─── Preview table ────────────────────────────────────────────────────────────

function PreviewTable({ rows }: { rows: PreviewRow[] }) {
  // Group by invoice for zebra striping across invoices
  const invoiceOrder: string[] = [];
  const seen = new Set<string>();
  rows.forEach((r) => {
    if (!seen.has(r.invoice_number)) {
      seen.add(r.invoice_number);
      invoiceOrder.push(r.invoice_number);
    }
  });
  const invoiceIndex = new Map(invoiceOrder.map((n, i) => [n, i]));

  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200">
      <table className="min-w-full text-sm">
        <thead>
          <tr className="bg-gray-50 border-b border-gray-200 text-xs font-semibold text-gray-500 uppercase tracking-wide">
            <th className="px-4 py-3 text-left whitespace-nowrap">Invoice No</th>
            <th className="px-4 py-3 text-left whitespace-nowrap">Date</th>
            <th className="px-4 py-3 text-left whitespace-nowrap">Vendor (Invoice)</th>
            <th className="px-4 py-3 text-left whitespace-nowrap">Type</th>
            <th className="px-4 py-3 text-left whitespace-nowrap">Tally Ledger Name</th>
            <th className="px-4 py-3 text-right whitespace-nowrap">Amount (₹)</th>
            <th className="px-4 py-3 text-left whitespace-nowrap">Notes</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map((row, i) => {
            const invIdx = invoiceIndex.get(row.invoice_number) ?? 0;
            const bg = row.status === 'Skipped'
              ? 'bg-red-50'
              : invIdx % 2 === 0 ? 'bg-white' : 'bg-gray-50/60';
            const amountColor = row.amount < 0 ? 'text-red-600' : 'text-gray-900';

            return (
              <tr key={i} className={bg}>
                <td className="px-4 py-2.5 font-mono text-xs text-gray-600 whitespace-nowrap">
                  {row.invoice_number}
                </td>
                <td className="px-4 py-2.5 text-gray-500 whitespace-nowrap text-xs">
                  {row.invoice_date}
                </td>
                <td className="px-4 py-2.5 text-gray-700 max-w-[180px] truncate" title={row.vendor_name}>
                  {row.vendor_name}
                </td>
                <td className="px-4 py-2.5 whitespace-nowrap">
                  <span className={`inline-block text-xs font-medium px-2 py-0.5 rounded-full ${LEDGER_TYPE_COLORS[row.ledger_type]}`}>
                    {row.ledger_type}
                  </span>
                </td>
                <td className="px-4 py-2.5 font-mono text-xs max-w-[260px]">
                  {row.status === 'Skipped' ? (
                    <span className="text-red-600 font-semibold">{row.tally_ledger_name}</span>
                  ) : (
                    <span className="text-gray-900">{row.tally_ledger_name}</span>
                  )}
                </td>
                <td className={`px-4 py-2.5 text-right font-mono text-xs whitespace-nowrap ${amountColor}`}>
                  {row.amount.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </td>
                <td className="px-4 py-2.5 text-xs max-w-[200px]">
                  {row.skip_reason && (
                    <span className="text-red-600">{row.skip_reason}</span>
                  )}
                  {row.warning && !row.skip_reason && (
                    <span className="text-amber-600">{row.warning}</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── Shared master loader ─────────────────────────────────────────────────────

async function loadMasters(companyId: string) {
  const [suppliers, dutiesTaxes, stockItems, expenseLedgers] = await Promise.all([
    loadSuppliers(companyId),
    loadDutiesTaxes(companyId),
    loadStockItems(companyId),
    loadExpenseLedgers(companyId),
  ]);
  return { suppliers, dutiesTaxes, stockItems, expenseLedgers };
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function XmlGeneratorPage() {
  const router = useRouter();
  const { company } = useCompany();

  const [selectedFY, setSelectedFY] = useState<string>(currentFY);
  const [invoices, setInvoices] = useState<StoredInvoice[]>([]);
  const [loadingInvoices, setLoadingInvoices] = useState(false);

  const [purchaseLedgers, setPurchaseLedgers] = useState<PurchaseLedgerEntry[]>([
    { gst_percent: null, tally_ledger_name: '' },
  ]);

  const [previewing, setPreviewing] = useState(false);
  const [previewRows, setPreviewRows] = useState<PreviewRow[] | null>(null);
  const [previewError, setPreviewError] = useState('');

  const [generatingXml, setGeneratingXml] = useState(false);
  const [xmlBlob, setXmlBlob] = useState<Blob | null>(null);
  const [xmlFilename, setXmlFilename] = useState('');

  const [loadError, setLoadError] = useState('');

  // Auth
  useEffect(() => {
    getSession().then((session) => {
      if (!session && !company) router.replace('/select-company');
    });
  }, [company, router]);

  // Load invoices on company/FY change — also clear preview
  useEffect(() => {
    setPreviewRows(null);
    setXmlBlob(null);
    if (!company?.id) { setInvoices([]); return; }
    setLoadingInvoices(true);
    setLoadError('');
    getPurchaseRegister(company.id, { financialYear: selectedFY || undefined })
      .then(setInvoices)
      .catch((e) => setLoadError(e.message ?? 'Failed to load invoices'))
      .finally(() => setLoadingInvoices(false));
  }, [company?.id, selectedFY]);

  useEffect(() => {
    setPreviewRows(null);
    setXmlBlob(null);
  }, [purchaseLedgers]);

  const selectedCompany = company;

  const validLedgers = useMemo(
    () => purchaseLedgers.filter((p) => p.tally_ledger_name.trim() !== ''),
    [purchaseLedgers],
  );

  const fileBase = `${company?.tally_company_name ?? company?.name ?? 'export'}_${selectedFY}`
    .replace(/[^a-zA-Z0-9._-]/g, '_');

  function validate(): string | null {
    if (!company) return 'No company selected.';
    if (!company.tally_company_name) return 'Tally Company Name is missing — update it in Companies first.';
    if (validLedgers.length === 0) return 'Configure at least one purchase ledger mapping.';
    if (invoices.length === 0) return 'No accepted invoices found for the selected period.';
    return null;
  }

  // ── Step 2: Preview ──
  const handlePreview = async () => {
    const err = validate();
    if (err) { alert(err); return; }
    setPreviewing(true);
    setPreviewRows(null);
    setPreviewError('');
    setXmlBlob(null);
    try {
      const masters = await loadMasters(company!.id);
      const rows = buildTallyPreview({
        invoices,
        ...masters,
        purchaseLedgers: validLedgers,
        tallyCompanyName: company!.tally_company_name!,
      });
      setPreviewRows(rows);
    } catch (e: unknown) {
      setPreviewError(e instanceof Error ? e.message : 'Preview failed');
    } finally {
      setPreviewing(false);
    }
  };

  // ── Download preview as Excel ──
  const handleDownloadExcel = () => {
    if (!previewRows) return;
    const wsData = [
      ['Invoice No', 'Date', 'Vendor (as on invoice)', 'Party Ledger', 'Entry Type', 'Tally Ledger Name', 'Amount (Dr+/Cr-)', 'Status', 'Notes'],
      ...previewRows.map((r) => [
        r.invoice_number,
        r.invoice_date,
        r.vendor_name,
        r.party_ledger,
        r.ledger_type,
        r.tally_ledger_name,
        r.amount,
        r.status,
        r.skip_reason ?? r.warning ?? '',
      ]),
    ];
    const ws = XLSX.utils.aoa_to_sheet(wsData);
    ws['!cols'] = [
      { wch: 18 }, { wch: 12 }, { wch: 30 }, { wch: 30 }, { wch: 10 },
      { wch: 35 }, { wch: 16 }, { wch: 8 }, { wch: 40 },
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Tally Preview');
    const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    const blob = new Blob([wbout], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${fileBase}_preview.xlsx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // ── Step 3: Generate and download XML ──
  const handleGenerateXml = async () => {
    const err = validate();
    if (err) { alert(err); return; }
    setGeneratingXml(true);
    setXmlBlob(null);
    try {
      const masters = await loadMasters(company!.id);
      const output = generateTallyXml({
        invoices,
        ...masters,
        purchaseLedgers: validLedgers,
        tallyCompanyName: selectedCompany!.tally_company_name!,
      });
      const blob = new Blob([output.xml], { type: 'application/xml' });
      setXmlBlob(blob);
      setXmlFilename(`${fileBase}_purchase.xml`);

      // Trigger download immediately
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${fileBase}_purchase.xml`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : 'XML generation failed');
    } finally {
      setGeneratingXml(false);
    }
  };

  // Preview summary counts
  const previewSkippedCount = previewRows?.filter((r) => r.status === 'Skipped').length ?? 0;
  const previewWarningCount = previewRows?.filter((r) => r.warning).length ?? 0;
  const previewInvoiceCount = previewRows
    ? new Set(previewRows.filter((r) => r.status === 'OK').map((r) => r.invoice_number)).size
    : 0;

  return (
    <div className="flex min-h-screen bg-gray-50">
      <AppSidebar />
      <main className="ml-60 flex-1 p-8" style={{ maxWidth: '100%' }}>
        <div className="mb-7">
          <h1 className="text-2xl font-bold text-gray-900">Export to Tally</h1>
          <p className="text-sm text-gray-500 mt-1">
            Preview ledger assignments and amounts, then download the XML for import into Tally.
          </p>
        </div>

        {/* ── Step 1: Period + Purchase Ledger mapping ── */}
        <div className="bg-white border border-gray-200 rounded-xl p-6 mb-5">
          <h2 className="text-sm font-semibold text-gray-700 mb-4">
            <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-indigo-600 text-white text-xs mr-2">1</span>
            Financial Year &amp; Purchase Ledgers
          </h2>

          <div className="flex items-center gap-4 mb-5">
            <div>
              <label className="block text-xs text-gray-500 mb-1.5">Financial Year</label>
              <FYPeriodSelector value={selectedFY} onChange={setSelectedFY} />
            </div>
            <div className="pt-5 text-sm text-gray-500">
              {loadingInvoices ? (
                <span className="text-gray-400">Loading…</span>
              ) : loadError ? (
                <span className="text-red-600">{loadError}</span>
              ) : (
                <span>
                  <span className="font-semibold text-gray-800">{invoices.length}</span>{' '}
                  accepted invoice{invoices.length !== 1 ? 's' : ''}
                </span>
              )}
            </div>
          </div>

          {company && !company.tally_company_name && (
            <div className="mb-4 flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-lg px-4 py-2.5 text-sm text-amber-800">
              <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
              </svg>
              <span>
                <strong>Tally Company Name is missing.</strong>{' '}
                <button onClick={() => router.push('/companies')} className="underline">Update in Companies</button>
              </span>
            </div>
          )}

          {/* Purchase ledger mapping */}
          <div className="border-t border-gray-100 pt-4">
            <p className="text-xs font-semibold text-gray-600 mb-1">Purchase Ledger Mapping</p>
            <p className="text-xs text-gray-400 mb-3">
              Map each GST rate to the corresponding Tally purchase ledger. Add a fallback row (no rate) to catch unmapped rates.
            </p>
            <div className="space-y-2.5">
              {purchaseLedgers.map((entry, idx) => (
                <PurchaseLedgerRow
                  key={idx}
                  entry={entry}
                  onChange={(u) =>
                    setPurchaseLedgers((prev) => prev.map((r, i) => (i === idx ? u : r)))
                  }
                  onRemove={() =>
                    setPurchaseLedgers((prev) => prev.filter((_, i) => i !== idx))
                  }
                />
              ))}
            </div>
            <button
              onClick={() =>
                setPurchaseLedgers((prev) => [...prev, { gst_percent: null, tally_ledger_name: '' }])
              }
              className="mt-3 text-sm text-indigo-600 hover:text-indigo-800 font-medium"
            >
              + Add row
            </button>
          </div>
        </div>

        {/* ── Step 2: Preview ── */}
        <div className="bg-white border border-gray-200 rounded-xl p-6 mb-5">
          <h2 className="text-sm font-semibold text-gray-700 mb-1">
            <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-indigo-600 text-white text-xs mr-2">2</span>
            Preview Ledger Assignments
          </h2>
          <p className="text-xs text-gray-400 mb-4">
            Review every ledger name and amount before generating the XML. Red rows indicate issues that will cause that invoice to be skipped.
          </p>

          <button
            onClick={handlePreview}
            disabled={previewing || !company || invoices.length === 0}
            className="px-5 py-2 bg-indigo-600 text-white rounded-lg text-sm font-semibold hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {previewing ? 'Building preview…' : 'Preview'}
          </button>

          {previewError && (
            <p className="mt-3 text-sm text-red-600">{previewError}</p>
          )}

          {previewRows && (
            <div className="mt-5 space-y-4">
              {/* Summary bar */}
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-2 bg-green-50 border border-green-200 rounded-lg px-4 py-2">
                  <svg className="w-4 h-4 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  <span className="text-sm font-semibold text-green-800">
                    {previewInvoiceCount} invoice{previewInvoiceCount !== 1 ? 's' : ''} ready
                  </span>
                </div>
                {previewSkippedCount > 0 && (
                  <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-2">
                    <span className="text-sm font-semibold text-red-800">
                      {previewSkippedCount} row{previewSkippedCount !== 1 ? 's' : ''} with errors (invoices will be skipped)
                    </span>
                  </div>
                )}
                {previewWarningCount > 0 && (
                  <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-2">
                    <span className="text-sm font-semibold text-amber-800">
                      {previewWarningCount} warning{previewWarningCount !== 1 ? 's' : ''}
                    </span>
                  </div>
                )}
                <button
                  onClick={handleDownloadExcel}
                  className="ml-auto flex items-center gap-2 px-4 py-2 border border-gray-200 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
                >
                  <svg className="w-4 h-4 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                  Download as Excel
                </button>
              </div>

              {/* Table */}
              <PreviewTable rows={previewRows} />
            </div>
          )}
        </div>

        {/* ── Step 3: Generate XML ── */}
        <div className="bg-white border border-gray-200 rounded-xl p-6 mb-5">
          <h2 className="text-sm font-semibold text-gray-700 mb-1">
            <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-indigo-600 text-white text-xs mr-2">3</span>
            Generate &amp; Download XML
          </h2>
          <p className="text-xs text-gray-400 mb-4">
            Once you're satisfied with the preview, generate the Tally XML file. The file downloads automatically.
          </p>

          <div className="flex items-center gap-4">
            <button
              onClick={handleGenerateXml}
              disabled={generatingXml || !company || invoices.length === 0}
              className="flex items-center gap-2 px-6 py-2.5 bg-gray-900 text-white rounded-lg text-sm font-semibold hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              {generatingXml ? 'Generating…' : 'Download XML'}
            </button>

            {xmlBlob && (
              <span className="text-sm text-gray-500">
                Downloaded as <span className="font-mono text-gray-700">{xmlFilename}</span>
              </span>
            )}
          </div>
        </div>

        {/* How-to */}
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
