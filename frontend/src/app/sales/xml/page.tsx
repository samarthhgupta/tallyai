'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { getCompany } from '@/lib/db';
import { getSalesRegister, saveSalesTallyAcceptance } from '@/lib/salesDb';
import { loadCustomers } from '@/lib/customers';
import { loadDutiesTaxes } from '@/lib/dutiesTaxes';
import { loadStockItems } from '@/lib/stockItems';
import { loadExpenseLedgers } from '@/lib/expenseLedgers';
import { upsertCustomerLedgerPreference, getCustomerLedgerPreferences } from '@/lib/customerLedgerPreferences';
import { loadSalesLedgers } from '@/lib/salesLedgerConfig';
import { generateSalesVouchersXml, generateSalesMastersXml } from '@/lib/salesXmlGenerator';
import type { CustomerMaster } from '@/lib/customers';
import type { DutiesTaxesMaster } from '@/lib/dutiesTaxes';
import type { StoredInvoice } from '@/types/invoice';
import { formatINR } from '@/types/invoice';
import { deriveInvoiceFinancials } from '@/lib/invoiceCalculations';
import AppLayout from '@/components/AppLayout';
import { currentFY } from '@/lib/fyPeriod';
import { useCompany } from '@/lib/companyContext';
import FYPeriodSelector from '@/components/FYPeriodSelector';

function getErrMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'object' && e !== null && 'message' in e) return String((e as { message: unknown }).message);
  return 'Unknown error';
}

function isBlank(v?: string | null) { return !v || v.trim() === '' || v === '-'; }

// Write UTF-16 LE + BOM file download (same as purchase XML page)
function downloadXmlFile(xml: string, filename: string) {
  const bom = '﻿';
  const content = bom + xml;
  const bytes = new Uint8Array(content.length * 2 + 2);
  const view = new DataView(bytes.buffer);
  // BOM
  view.setUint16(0, 0xFEFF, true);
  for (let i = 0; i < content.length; i++) {
    view.setUint16((i + 1) * 2, content.charCodeAt(i), true);
  }
  const blob = new Blob([bytes], { type: 'text/xml;charset=utf-16le' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Per-invoice acceptance shape for sales
interface SalesTallyAcceptance {
  customerLedger: string;
  salesLedger: string;
  cgstLedger: string;
  sgstLedger: string;
  igstLedger: string;
  roLedger: string;
}

function parseSalesAcceptance(inv: StoredInvoice): SalesTallyAcceptance | null {
  if (!inv.tally_ledger_acceptance) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const a = inv.tally_ledger_acceptance as any;
  if (!a.salesLedger && !a.customerLedger) return null;
  return {
    customerLedger: a.customerLedger ?? '',
    salesLedger: a.salesLedger ?? '',
    cgstLedger: a.cgstLedger ?? '',
    sgstLedger: a.sgstLedger ?? '',
    igstLedger: a.igstLedger ?? '',
    roLedger: a.roLedger ?? '',
  };
}

function isExported(acc: SalesTallyAcceptance | null): boolean {
  return !!acc && !isBlank(acc.salesLedger);
}

// ─── InvoiceRow — per-invoice ledger mapping UI ───────────────────────────────

interface InvoiceRowProps {
  inv: StoredInvoice;
  customers: CustomerMaster[];
  dutiesTaxes: DutiesTaxesMaster[];
  salesLedgerOptions: string[];
  companyId: string;
  onSave: (id: string, acc: SalesTallyAcceptance) => void;
}

function InvoiceRow({ inv, customers, dutiesTaxes, salesLedgerOptions, companyId, onSave }: InvoiceRowProps) {
  const d = deriveInvoiceFinancials(inv);
  const existing = parseSalesAcceptance(inv);

  // Find the customer master record
  const customerMaster = useMemo(() => {
    const g = (inv.buyer_gstin ?? '').toLowerCase().trim();
    if (g) return customers.find((c) => (c.customer_gstin ?? '').toLowerCase() === g) ?? null;
    const n = (inv.buyer_name ?? '').toLowerCase().trim();
    return customers.find((c) => c.tally_ledger_name.toLowerCase() === n || c.customer_name.toLowerCase() === n) ?? null;
  }, [inv, customers]);

  const defaultCustomerLedger = customerMaster?.tally_ledger_name ?? (inv.buyer_name ?? '');

  const [customerLedger, setCustomerLedger] = useState(existing?.customerLedger || defaultCustomerLedger);
  const [salesLedger, setSalesLedger] = useState(existing?.salesLedger ?? '');
  const [cgstLedger, setCgstLedger] = useState(existing?.cgstLedger ?? '');
  const [sgstLedger, setSgstLedger] = useState(existing?.sgstLedger ?? '');
  const [igstLedger, setIgstLedger] = useState(existing?.igstLedger ?? '');
  const [roLedger, setRoLedger] = useState(existing?.roLedger ?? '');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(!!existing);
  const [err, setErr] = useState<string | null>(null);

  // Load historical ledger preferences for this customer
  useEffect(() => {
    if (saved) return;
    getCustomerLedgerPreferences(companyId, inv.buyer_gstin, inv.buyer_name).then((prefs) => {
      if (prefs.sales && !salesLedger) setSalesLedger(prefs.sales);
      // Auto-populate tax ledgers from duties/taxes
      if (inv.tax_type === 'cgst_sgst') {
        const cgst = dutiesTaxes.find((d) => d.tax_component === 'CGST');
        const sgst = dutiesTaxes.find((d) => d.tax_component === 'SGST');
        if (cgst && !cgstLedger) setCgstLedger(cgst.tally_ledger_name);
        if (sgst && !sgstLedger) setSgstLedger(sgst.tally_ledger_name);
      } else if (inv.tax_type === 'igst') {
        const igst = dutiesTaxes.find((d) => d.tax_component === 'IGST');
        if (igst && !igstLedger) setIgstLedger(igst.tally_ledger_name);
      }
    }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, inv.buyer_gstin, inv.buyer_name, inv.tax_type]);

  const cgstDt = dutiesTaxes.filter((d) => d.tax_component === 'CGST');
  const sgstDt = dutiesTaxes.filter((d) => d.tax_component === 'SGST');
  const igstDt = dutiesTaxes.filter((d) => d.tax_component === 'IGST');

  const handleSave = async () => {
    if (isBlank(salesLedger)) { setErr('Sales ledger is required'); return; }
    setSaving(true);
    setErr(null);
    try {
      const acc: SalesTallyAcceptance = {
        customerLedger: customerLedger || defaultCustomerLedger,
        salesLedger,
        cgstLedger,
        sgstLedger,
        igstLedger,
        roLedger,
      };
      await saveSalesTallyAcceptance(companyId, inv.id, acc as unknown as Record<string, unknown>);
      // Learn: save sales ledger preference (GSTIN-keyed only)
      await upsertCustomerLedgerPreference(companyId, inv.buyer_gstin, inv.buyer_name, 'sales', salesLedger).catch(() => {});
      if (cgstLedger) await upsertCustomerLedgerPreference(companyId, inv.buyer_gstin, inv.buyer_name, 'CGST', cgstLedger).catch(() => {});
      if (sgstLedger) await upsertCustomerLedgerPreference(companyId, inv.buyer_gstin, inv.buyer_name, 'SGST', sgstLedger).catch(() => {});
      if (igstLedger) await upsertCustomerLedgerPreference(companyId, inv.buyer_gstin, inv.buyer_name, 'IGST', igstLedger).catch(() => {});
      setSaved(true);
      onSave(inv.id, acc);
    } catch (e) {
      setErr(getErrMsg(e));
    } finally {
      setSaving(false);
    }
  };

  const isCgstSgst = inv.tax_type === 'cgst_sgst';
  const isIgst = inv.tax_type === 'igst';
  const hasTax = isCgstSgst || isIgst;

  const statusCls = saved
    ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
    : isBlank(salesLedger)
    ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
    : 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400';
  const statusLabel = saved ? 'Mapped' : isBlank(salesLedger) ? 'Needs Mapping' : 'Ready';

  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-4 mb-3 bg-white dark:bg-gray-900">
      {/* Invoice header */}
      <div className="flex flex-wrap items-start justify-between gap-2 mb-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm font-semibold text-gray-900 dark:text-gray-100">{inv.invoice_number}</span>
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusCls}`}>{statusLabel}</span>
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
            {inv.invoice_date} · {inv.buyer_name ?? '-'} {inv.buyer_gstin ? `(${inv.buyer_gstin})` : '(B2C)'}
          </div>
        </div>
        <div className="text-right text-xs">
          <div className="font-semibold text-gray-900 dark:text-gray-100">{formatINR(d.total)}</div>
          <div className="text-gray-500 dark:text-gray-400">
            Taxable: {formatINR(d.net_goods_taxable + d.taxable_charges_total)}
            {hasTax && ` · Tax: ${formatINR(d.cgst + d.sgst + d.igst)}`}
          </div>
        </div>
      </div>

      {/* Ledger mapping grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
        {/* Customer Ledger */}
        <div>
          <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
            Customer Ledger {customerMaster ? '✓' : ''}
          </label>
          <input
            value={customerLedger}
            onChange={(e) => { setCustomerLedger(e.target.value); setSaved(false); }}
            className="w-full border border-gray-300 dark:border-gray-600 rounded px-2 py-1 text-xs bg-white dark:bg-gray-700 dark:text-gray-100"
            placeholder="Customer ledger in Tally"
          />
          {!customerMaster && (
            <p className="text-xs text-amber-600 dark:text-amber-400 mt-0.5">
              Not in customer master — add to masters for XML export to work correctly.
            </p>
          )}
        </div>

        {/* Sales Ledger */}
        <div>
          <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
            Sales Ledger <span className="text-red-500">*</span>
          </label>
          {salesLedgerOptions.length > 0 ? (
            <select
              value={salesLedger}
              onChange={(e) => { setSalesLedger(e.target.value); setSaved(false); }}
              className="w-full border border-gray-300 dark:border-gray-600 rounded px-2 py-1 text-xs bg-white dark:bg-gray-700 dark:text-gray-100"
            >
              <option value="">— select —</option>
              {salesLedgerOptions.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          ) : (
            <input
              value={salesLedger}
              onChange={(e) => { setSalesLedger(e.target.value); setSaved(false); }}
              className="w-full border border-gray-300 dark:border-gray-600 rounded px-2 py-1 text-xs bg-white dark:bg-gray-700 dark:text-gray-100"
              placeholder="Sales ledger in Tally"
            />
          )}
        </div>

        {/* CGST Ledger */}
        {isCgstSgst && d.cgst > 0 && (
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
              CGST Ledger ({formatINR(d.cgst)})
            </label>
            <select
              value={cgstLedger}
              onChange={(e) => { setCgstLedger(e.target.value); setSaved(false); }}
              className="w-full border border-gray-300 dark:border-gray-600 rounded px-2 py-1 text-xs bg-white dark:bg-gray-700 dark:text-gray-100"
            >
              <option value="">— select —</option>
              {cgstDt.map((d) => <option key={d.id} value={d.tally_ledger_name}>{d.tally_ledger_name}</option>)}
            </select>
          </div>
        )}

        {/* SGST Ledger */}
        {isCgstSgst && d.sgst > 0 && (
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
              SGST Ledger ({formatINR(d.sgst)})
            </label>
            <select
              value={sgstLedger}
              onChange={(e) => { setSgstLedger(e.target.value); setSaved(false); }}
              className="w-full border border-gray-300 dark:border-gray-600 rounded px-2 py-1 text-xs bg-white dark:bg-gray-700 dark:text-gray-100"
            >
              <option value="">— select —</option>
              {sgstDt.map((d) => <option key={d.id} value={d.tally_ledger_name}>{d.tally_ledger_name}</option>)}
            </select>
          </div>
        )}

        {/* IGST Ledger */}
        {isIgst && d.igst > 0 && (
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
              IGST Ledger ({formatINR(d.igst)})
            </label>
            <select
              value={igstLedger}
              onChange={(e) => { setIgstLedger(e.target.value); setSaved(false); }}
              className="w-full border border-gray-300 dark:border-gray-600 rounded px-2 py-1 text-xs bg-white dark:bg-gray-700 dark:text-gray-100"
            >
              <option value="">— select —</option>
              {igstDt.map((d) => <option key={d.id} value={d.tally_ledger_name}>{d.tally_ledger_name}</option>)}
            </select>
          </div>
        )}
      </div>

      {err && <p className="text-xs text-red-600 dark:text-red-400 mb-2">{err}</p>}

      <button
        onClick={handleSave}
        disabled={saving}
        className="px-3 py-1.5 bg-indigo-600 text-white text-xs font-medium rounded hover:bg-indigo-700 disabled:opacity-50 transition-colors"
      >
        {saving ? 'Saving…' : saved ? 'Update Mapping' : 'Save Mapping'}
      </button>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function SalesXmlPage() {
  const router = useRouter();
  const { company } = useCompany();
  const [fy, setFy] = useState(currentFY());

  const [invoices, setInvoices] = useState<StoredInvoice[]>([]);
  const [customers, setCustomers] = useState<CustomerMaster[]>([]);
  const [dutiesTaxes, setDutiesTaxes] = useState<DutiesTaxesMaster[]>([]);
  const [tallyCompanyName, setTallyCompanyName] = useState('');
  const [companyGstin, setCompanyGstin] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exportMsg, setExportMsg] = useState<string | null>(null);

  // Track accepted invoices client-side so UI updates immediately
  const [acceptedMap, setAcceptedMap] = useState<Record<string, SalesTallyAcceptance>>({});

  const [salesLedgerOptions, setSalesLedgerOptions] = useState<string[]>([]);

  useEffect(() => {
    const load = async () => {
      const session = await getSession();
      if (!session) { router.push('/login'); return; }
      if (!company) { router.push('/select-company'); return; }
      try {
        const [invData, custData, dtData, comp, importedSalesLedgers] = await Promise.all([
          getSalesRegister(company.id, { financialYear: fy }),
          loadCustomers(company.id),
          loadDutiesTaxes(company.id),
          getCompany(company.id),
          loadSalesLedgers(company.id),
        ]);
        setInvoices(invData);
        setCustomers(custData);
        setDutiesTaxes(dtData);
        setTallyCompanyName(comp.tally_company_name ?? comp.name);
        setCompanyGstin(comp.gstin ?? '');

        // Sales ledger options: imported masters first, then any learned from prior acceptances.
        const salesLedgers = new Set<string>(importedSalesLedgers.map((l) => l.tally_ledger_name));
        for (const inv of invData) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const acc = inv.tally_ledger_acceptance as any;
          if (acc?.salesLedger) salesLedgers.add(acc.salesLedger);
        }
        setSalesLedgerOptions(Array.from(salesLedgers));

        // Initialize accepted map from DB
        const map: Record<string, SalesTallyAcceptance> = {};
        for (const inv of invData) {
          const acc = parseSalesAcceptance(inv);
          if (acc) map[inv.id] = acc;
        }
        setAcceptedMap(map);
      } catch (e) {
        setError(getErrMsg(e));
      } finally {
        setLoading(false);
      }
    };
    load();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company, fy]);

  const handleSave = (id: string, acc: SalesTallyAcceptance) => {
    setAcceptedMap((prev) => ({ ...prev, [id]: acc }));
    // Add sales ledger to options if new
    if (acc.salesLedger && !salesLedgerOptions.includes(acc.salesLedger)) {
      setSalesLedgerOptions((prev) => [...prev, acc.salesLedger]);
    }
  };

  const mappedInvoices = useMemo(() => {
    return invoices.filter((inv) => {
      const acc = acceptedMap[inv.id];
      return acc && !isBlank(acc.salesLedger);
    });
  }, [invoices, acceptedMap]);

  const handleExportVouchers = () => {
    if (!mappedInvoices.length) { setExportMsg('No invoices with complete mapping to export.'); return; }
    setExportMsg(null);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const enrichedInvoices = mappedInvoices.map((inv) => ({
        ...inv,
        tally_ledger_acceptance: acceptedMap[inv.id] as unknown as any,
      })) as StoredInvoice[];
      const xml = generateSalesVouchersXml({
        invoices: enrichedInvoices,
        customers,
        dutiesTaxes,
        stockItems: [],
        expenseLedgers: [],
        tallyCompanyName,
        financialYear: fy,
        companyGstin,
      });
      downloadXmlFile(xml, `sales_vouchers_${fy}.xml`);
      setExportMsg(`✓ Exported ${mappedInvoices.length} vouchers.`);
    } catch (e) {
      setExportMsg(`Export failed: ${getErrMsg(e)}`);
    }
  };

  const handleExportMasters = () => {
    if (!mappedInvoices.length) { setExportMsg('No mapped invoices to generate masters for.'); return; }
    setExportMsg(null);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const enrichedInvoices = mappedInvoices.map((inv) => ({
        ...inv,
        tally_ledger_acceptance: acceptedMap[inv.id] as unknown as any,
      })) as StoredInvoice[];
      const xml = generateSalesMastersXml({
        invoices: enrichedInvoices,
        customers,
        dutiesTaxes,
        stockItems: [],
        expenseLedgers: [],
        tallyCompanyName,
        financialYear: fy,
        companyGstin,
      });
      downloadXmlFile(xml, `sales_masters_${fy}.xml`);
      setExportMsg('✓ Masters XML downloaded.');
    } catch (e) {
      setExportMsg(`Export failed: ${getErrMsg(e)}`);
    }
  };

  const mappedCount = mappedInvoices.length;
  const totalCount = invoices.length;

  return (
    <AppLayout>
      <div className="max-w-4xl mx-auto px-4 py-8">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Sales Export to Tally</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            Map ledgers and export Sales vouchers to Tally XML format.
          </p>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-sm text-red-700 dark:text-red-400">
            {error}
          </div>
        )}

        {/* Controls row */}
        <div className="flex flex-wrap items-center gap-3 mb-6">
          <FYPeriodSelector value={fy} onChange={(v) => { setFy(v); setLoading(true); }} />
          <div className="flex gap-2 ml-auto">
            <button
              onClick={handleExportMasters}
              disabled={mappedCount === 0}
              className="px-4 py-2 text-sm border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Export Masters XML
            </button>
            <button
              onClick={handleExportVouchers}
              disabled={mappedCount === 0}
              className="px-4 py-2 text-sm bg-indigo-600 text-white font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Export {mappedCount > 0 ? `${mappedCount} ` : ''}Vouchers XML
            </button>
          </div>
        </div>

        {exportMsg && (
          <div className={`mb-4 p-3 rounded-lg text-sm ${
            exportMsg.startsWith('✓')
              ? 'bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 text-green-700 dark:text-green-400'
              : 'bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-400'
          }`}>
            {exportMsg}
          </div>
        )}

        {/* Summary bar */}
        {!loading && totalCount > 0 && (
          <div className="mb-4 flex items-center gap-4 text-sm">
            <span className="text-gray-600 dark:text-gray-400">{totalCount} invoices</span>
            <span className="text-green-600 dark:text-green-400">✓ {mappedCount} mapped</span>
            {totalCount - mappedCount > 0 && (
              <span className="text-amber-600 dark:text-amber-400">{totalCount - mappedCount} need mapping</span>
            )}
          </div>
        )}

        {loading ? (
          <div className="text-center py-16 text-gray-400">Loading…</div>
        ) : invoices.length === 0 ? (
          <div className="text-center py-16">
            <div className="text-4xl mb-3">📭</div>
            <p className="text-gray-600 dark:text-gray-400 font-medium">No sales invoices found for {fy}</p>
            <p className="text-sm text-gray-400 dark:text-gray-500 mt-1">
              Upload and accept sales invoices first.
            </p>
          </div>
        ) : (
          <div>
            {invoices.map((inv) => (
              <InvoiceRow
                key={inv.id}
                inv={inv}
                customers={customers}
                dutiesTaxes={dutiesTaxes}
                salesLedgerOptions={salesLedgerOptions}
                companyId={company!.id}
                onSave={handleSave}
              />
            ))}
          </div>
        )}
      </div>
    </AppLayout>
  );
}
