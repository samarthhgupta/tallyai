'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { getCompany } from '@/lib/db';
import { getSalesRegister, saveSalesTallyAcceptance } from '@/lib/salesDb';
import { loadCustomers } from '@/lib/customers';
import { loadSuppliers } from '@/lib/suppliers';
import { loadDutiesTaxes } from '@/lib/dutiesTaxes';
import { upsertCustomerLedgerPreference, getCustomerLedgerPreferences } from '@/lib/customerLedgerPreferences';
import { loadSalesLedgers } from '@/lib/salesLedgerConfig';
import { generateSalesVouchersXml, generateSalesMastersXml } from '@/lib/salesXmlGenerator';
import type { CustomerMaster } from '@/lib/customers';
import type { SupplierMaster } from '@/lib/suppliers';
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

// Write UTF-16 LE + BOM file download
function downloadXmlFile(xml: string, filename: string) {
  const bom = '﻿';
  const content = bom + xml;
  const bytes = new Uint8Array(content.length * 2 + 2);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, 0xFEFF, true);
  for (let i = 0; i < content.length; i++) {
    view.setUint16((i + 1) * 2, content.charCodeAt(i), true);
  }
  const blob = new Blob([bytes], { type: 'text/xml;charset=utf-16le' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// ─── Per-invoice ledger acceptance ───────────────────────────────────────────

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

// ─── Resolve customer ledger from masters ─────────────────────────────────────
// Resolution order: Sundry Debtors by GSTIN → Debtors by name →
//                   Sundry Creditors by GSTIN → Creditors by name (cross-role)

function resolveCustomerLedger(
  inv: StoredInvoice,
  customers: CustomerMaster[],
  suppliers: SupplierMaster[],
): string | null {
  const g = (inv.buyer_gstin ?? '').trim().toUpperCase();
  const n = (inv.buyer_name ?? '').toLowerCase().trim();
  if (g) {
    const byGstin = customers.find((c) => (c.customer_gstin ?? '').toUpperCase() === g);
    if (byGstin) return byGstin.tally_ledger_name;
    const credByGstin = suppliers.find((s) => (s.vendor_gstin ?? '').toUpperCase() === g);
    if (credByGstin) return credByGstin.tally_ledger_name;
  }
  const byName = customers.find((c) =>
    c.tally_ledger_name.toLowerCase() === n || (c.customer_name ?? '').toLowerCase() === n,
  );
  if (byName) return byName.tally_ledger_name;
  const credByName = suppliers.find((s) =>
    s.tally_ledger_name.toLowerCase() === n || (s.vendor_name ?? '').toLowerCase() === n,
  );
  if (credByName) return credByName.tally_ledger_name;
  return null;
}

// ─── Output-GST helpers ───────────────────────────────────────────────────────

function preferOutput(list: DutiesTaxesMaster[]): DutiesTaxesMaster | undefined {
  return list.find((d) => d.tally_ledger_name.toLowerCase().includes('output')) ?? list[0];
}

function outputOnly(list: DutiesTaxesMaster[], component: string): DutiesTaxesMaster[] {
  const all = list.filter((d) => d.tax_component === component);
  const out = all.filter((d) => d.tally_ledger_name.toLowerCase().includes('output'));
  return out.length ? out : all;
}

// ─── Row types ────────────────────────────────────────────────────────────────

type RowStatus = 'mapped' | 'ready' | 'needs_mapping';

function rowStatus(acc: SalesTallyAcceptance | null, salesLedger: string): RowStatus {
  if (acc && !isBlank(acc.salesLedger)) return 'mapped';
  if (!isBlank(salesLedger)) return 'ready';
  return 'needs_mapping';
}

// ─── Expanded mapping panel (inside the flat table) ───────────────────────────

interface MappingPanelProps {
  inv: StoredInvoice;
  customers: CustomerMaster[];
  suppliers: SupplierMaster[];
  dutiesTaxes: DutiesTaxesMaster[];
  salesLedgerOptions: string[];
  companyId: string;
  initialAcc: SalesTallyAcceptance | null;
  onSave: (id: string, acc: SalesTallyAcceptance) => void;
}

function MappingPanel({ inv, customers, suppliers, dutiesTaxes, salesLedgerOptions, companyId, initialAcc, onSave }: MappingPanelProps) {
  const d = deriveInvoiceFinancials(inv);
  const resolvedLedger = useMemo(
    () => resolveCustomerLedger(inv, customers, suppliers),
    [inv, customers, suppliers],
  );

  const [customerLedger, setCustomerLedger] = useState(initialAcc?.customerLedger || resolvedLedger || inv.buyer_name || '');
  const [salesLedger, setSalesLedger] = useState(initialAcc?.salesLedger ?? '');
  const [cgstLedger, setCgstLedger] = useState(initialAcc?.cgstLedger ?? '');
  const [sgstLedger, setSgstLedger] = useState(initialAcc?.sgstLedger ?? '');
  const [igstLedger, setIgstLedger] = useState(initialAcc?.igstLedger ?? '');
  const [roLedger, setRoLedger] = useState(initialAcc?.roLedger ?? '');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(!!initialAcc);
  const [err, setErr] = useState<string | null>(null);

  // Load per-customer preferences and auto-fill tax ledgers from masters
  useEffect(() => {
    if (saved) return;
    getCustomerLedgerPreferences(companyId, inv.buyer_gstin, inv.buyer_name).then((prefs) => {
      if (prefs.sales && !salesLedger) setSalesLedger(prefs.sales);
      if (prefs.CGST && !cgstLedger) setCgstLedger(prefs.CGST);
      if (prefs.SGST && !sgstLedger) setSgstLedger(prefs.SGST);
      if (prefs.IGST && !igstLedger) setIgstLedger(prefs.IGST);
      // Auto-fill tax ledgers from masters if not in prefs
      if (inv.tax_type === 'cgst_sgst') {
        const cgst = preferOutput(dutiesTaxes.filter((x) => x.tax_component === 'CGST'));
        const sgst = preferOutput(dutiesTaxes.filter((x) => x.tax_component === 'SGST'));
        if (cgst && !cgstLedger) setCgstLedger(cgst.tally_ledger_name);
        if (sgst && !sgstLedger) setSgstLedger(sgst.tally_ledger_name);
      } else if (inv.tax_type === 'igst') {
        const igst = preferOutput(dutiesTaxes.filter((x) => x.tax_component === 'IGST'));
        if (igst && !igstLedger) setIgstLedger(igst.tally_ledger_name);
      }
    }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, inv.buyer_gstin, inv.buyer_name, inv.tax_type]);

  const cgstOptions = outputOnly(dutiesTaxes, 'CGST');
  const sgstOptions = outputOnly(dutiesTaxes, 'SGST');
  const igstOptions = outputOnly(dutiesTaxes, 'IGST');

  const isCgstSgst = inv.tax_type === 'cgst_sgst';
  const isIgst = inv.tax_type === 'igst';

  const handleSave = async () => {
    if (isBlank(salesLedger)) { setErr('Sales ledger is required'); return; }
    setSaving(true); setErr(null);
    try {
      const acc: SalesTallyAcceptance = { customerLedger, salesLedger, cgstLedger, sgstLedger, igstLedger, roLedger };
      await saveSalesTallyAcceptance(companyId, inv.id, acc as unknown as Record<string, unknown>);
      // Learn preferences for this customer
      await upsertCustomerLedgerPreference(companyId, inv.buyer_gstin, inv.buyer_name, 'sales', salesLedger).catch(() => {});
      if (cgstLedger) await upsertCustomerLedgerPreference(companyId, inv.buyer_gstin, inv.buyer_name, 'CGST', cgstLedger).catch(() => {});
      if (sgstLedger) await upsertCustomerLedgerPreference(companyId, inv.buyer_gstin, inv.buyer_name, 'SGST', sgstLedger).catch(() => {});
      if (igstLedger) await upsertCustomerLedgerPreference(companyId, inv.buyer_gstin, inv.buyer_name, 'IGST', igstLedger).catch(() => {});
      setSaved(true);
      onSave(inv.id, acc);
    } catch (e) { setErr(getErrMsg(e)); }
    finally { setSaving(false); }
  };

  return (
    <div className="bg-gray-50 dark:bg-gray-800/50 border-t border-gray-200 dark:border-gray-700 px-4 py-3">
      {/* Header summary */}
      <div className="flex flex-wrap items-center gap-4 mb-3 text-xs text-gray-600 dark:text-gray-400">
        <span><strong className="text-gray-900 dark:text-gray-100">{inv.buyer_name ?? '—'}</strong>
          {inv.buyer_gstin ? ` · ${inv.buyer_gstin}` : ' · B2C'}</span>
        <span>Taxable: <strong>{formatINR(d.net_goods_taxable + d.taxable_charges_total)}</strong></span>
        {(d.cgst + d.sgst) > 0 && <span>CGST+SGST: <strong>{formatINR(d.cgst + d.sgst)}</strong></span>}
        {d.igst > 0 && <span>IGST: <strong>{formatINR(d.igst)}</strong></span>}
        <span>Total: <strong>{formatINR(d.total)}</strong></span>
      </div>

      {/* Ledger mapping grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-3">
        {/* Customer Ledger */}
        <div>
          <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
            Customer Ledger{resolvedLedger ? ' ✓' : ' ⚠'}
          </label>
          <input
            value={customerLedger}
            onChange={(e) => { setCustomerLedger(e.target.value); setSaved(false); }}
            className="w-full border border-gray-300 dark:border-gray-600 rounded px-2 py-1 text-xs bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
            placeholder="Customer ledger in Tally"
          />
          {!resolvedLedger && (
            <p className="text-xs text-amber-600 dark:text-amber-400 mt-0.5">Not in customer master — verify ledger name.</p>
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
              className="w-full border border-gray-300 dark:border-gray-600 rounded px-2 py-1 text-xs bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
            >
              <option value="">— select —</option>
              {salesLedgerOptions.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          ) : (
            <input
              value={salesLedger}
              onChange={(e) => { setSalesLedger(e.target.value); setSaved(false); }}
              className="w-full border border-gray-300 dark:border-gray-600 rounded px-2 py-1 text-xs bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
              placeholder="e.g. Sales @ 5%"
            />
          )}
        </div>

        {/* Round-off Ledger */}
        <div>
          <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Round-Off Ledger</label>
          <input
            value={roLedger}
            onChange={(e) => { setRoLedger(e.target.value); setSaved(false); }}
            className="w-full border border-gray-300 dark:border-gray-600 rounded px-2 py-1 text-xs bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
            placeholder="Round Off (optional)"
          />
        </div>

        {/* CGST Ledger */}
        {isCgstSgst && d.cgst > 0 && (
          <div>
            <label className="block text-xs font-medium text-teal-700 dark:text-teal-400 mb-1">
              Output CGST Ledger ({formatINR(d.cgst)})
            </label>
            <select
              value={cgstLedger}
              onChange={(e) => { setCgstLedger(e.target.value); setSaved(false); }}
              className="w-full border border-gray-300 dark:border-gray-600 rounded px-2 py-1 text-xs bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
            >
              <option value="">— select —</option>
              {cgstOptions.map((d) => <option key={d.id} value={d.tally_ledger_name}>{d.tally_ledger_name}</option>)}
            </select>
          </div>
        )}

        {/* SGST Ledger */}
        {isCgstSgst && d.sgst > 0 && (
          <div>
            <label className="block text-xs font-medium text-teal-700 dark:text-teal-400 mb-1">
              Output SGST Ledger ({formatINR(d.sgst)})
            </label>
            <select
              value={sgstLedger}
              onChange={(e) => { setSgstLedger(e.target.value); setSaved(false); }}
              className="w-full border border-gray-300 dark:border-gray-600 rounded px-2 py-1 text-xs bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
            >
              <option value="">— select —</option>
              {sgstOptions.map((d) => <option key={d.id} value={d.tally_ledger_name}>{d.tally_ledger_name}</option>)}
            </select>
          </div>
        )}

        {/* IGST Ledger */}
        {isIgst && d.igst > 0 && (
          <div>
            <label className="block text-xs font-medium text-cyan-700 dark:text-cyan-400 mb-1">
              Output IGST Ledger ({formatINR(d.igst)})
            </label>
            <select
              value={igstLedger}
              onChange={(e) => { setIgstLedger(e.target.value); setSaved(false); }}
              className="w-full border border-gray-300 dark:border-gray-600 rounded px-2 py-1 text-xs bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
            >
              <option value="">— select —</option>
              {igstOptions.map((d) => <option key={d.id} value={d.tally_ledger_name}>{d.tally_ledger_name}</option>)}
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

// ─── Main page ────────────────────────────────────────────────────────────────

export default function SalesXmlPage() {
  const router = useRouter();
  const { company } = useCompany();
  const [fy, setFy] = useState(currentFY());

  const [invoices, setInvoices] = useState<StoredInvoice[]>([]);
  const [customers, setCustomers] = useState<CustomerMaster[]>([]);
  const [suppliers, setSuppliers] = useState<SupplierMaster[]>([]);
  const [dutiesTaxes, setDutiesTaxes] = useState<DutiesTaxesMaster[]>([]);
  const [tallyCompanyName, setTallyCompanyName] = useState('');
  const [companyGstin, setCompanyGstin] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exportMsg, setExportMsg] = useState<string | null>(null);

  // Track accepted invoices client-side for immediate UI update
  const [acceptedMap, setAcceptedMap] = useState<Record<string, SalesTallyAcceptance>>({});
  const [salesLedgerOptions, setSalesLedgerOptions] = useState<string[]>([]);

  // Which invoice rows are expanded
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  // Filter state
  const [filterStatus, setFilterStatus] = useState<'all' | 'mapped' | 'needs_mapping'>('all');

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      const session = await getSession();
      if (!session) { router.push('/login'); return; }
      if (!company) { router.push('/select-company'); return; }
      try {
        const [invData, custData, suppData, dtData, comp, importedSalesLedgers] = await Promise.all([
          getSalesRegister(company.id, { financialYear: fy }),
          loadCustomers(company.id),
          loadSuppliers(company.id),
          loadDutiesTaxes(company.id),
          getCompany(company.id),
          loadSalesLedgers(company.id),
        ]);
        setInvoices(invData);
        setCustomers(custData);
        setSuppliers(suppData);
        setDutiesTaxes(dtData);
        setTallyCompanyName(comp.tally_company_name ?? comp.name);
        setCompanyGstin(comp.gstin ?? '');

        const ledgerSet = new Set<string>(importedSalesLedgers.map((l) => l.tally_ledger_name));
        for (const inv of invData) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const a = inv.tally_ledger_acceptance as any;
          if (a?.salesLedger) ledgerSet.add(a.salesLedger);
        }
        setSalesLedgerOptions(Array.from(ledgerSet));

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
    if (acc.salesLedger && !salesLedgerOptions.includes(acc.salesLedger)) {
      setSalesLedgerOptions((prev) => [...prev, acc.salesLedger]);
    }
  };

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const mappedInvoices = useMemo(
    () => invoices.filter((inv) => { const a = acceptedMap[inv.id]; return a && !isBlank(a.salesLedger); }),
    [invoices, acceptedMap],
  );

  const filteredInvoices = useMemo(() => {
    if (filterStatus === 'all') return invoices;
    if (filterStatus === 'mapped') return invoices.filter((inv) => acceptedMap[inv.id] && !isBlank(acceptedMap[inv.id].salesLedger));
    return invoices.filter((inv) => !acceptedMap[inv.id] || isBlank(acceptedMap[inv.id].salesLedger));
  }, [invoices, acceptedMap, filterStatus]);

  const handleExportVouchers = () => {
    if (!mappedInvoices.length) { setExportMsg('No invoices with complete mapping to export.'); return; }
    setExportMsg(null);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const enriched = mappedInvoices.map((inv) => ({ ...inv, tally_ledger_acceptance: acceptedMap[inv.id] as unknown as any })) as StoredInvoice[];
      const xml = generateSalesVouchersXml({ invoices: enriched, customers, dutiesTaxes, stockItems: [], expenseLedgers: [], tallyCompanyName, financialYear: fy, companyGstin });
      downloadXmlFile(xml, `sales_vouchers_${fy}.xml`);
      setExportMsg(`✓ Exported ${mappedInvoices.length} vouchers.`);
    } catch (e) { setExportMsg(`Export failed: ${getErrMsg(e)}`); }
  };

  const handleExportMasters = () => {
    if (!mappedInvoices.length) { setExportMsg('No mapped invoices to generate masters for.'); return; }
    setExportMsg(null);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const enriched = mappedInvoices.map((inv) => ({ ...inv, tally_ledger_acceptance: acceptedMap[inv.id] as unknown as any })) as StoredInvoice[];
      const xml = generateSalesMastersXml({ invoices: enriched, customers, dutiesTaxes, stockItems: [], expenseLedgers: [], tallyCompanyName, financialYear: fy, companyGstin });
      downloadXmlFile(xml, `sales_masters_${fy}.xml`);
      setExportMsg('✓ Masters XML downloaded.');
    } catch (e) { setExportMsg(`Export failed: ${getErrMsg(e)}`); }
  };

  const mappedCount = mappedInvoices.length;
  const totalCount = invoices.length;
  const needsCount = totalCount - mappedCount;

  return (
    <AppLayout>
      <div className="max-w-6xl mx-auto px-4 py-8">
        {/* Page header */}
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Sales Export to Tally</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            Map ledgers for each invoice and export Sales vouchers to Tally XML.
          </p>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-sm text-red-700 dark:text-red-400">{error}</div>
        )}

        {/* Controls row */}
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <FYPeriodSelector value={fy} onChange={(v) => { setFy(v); setError(null); }} />

          {/* Filter chips */}
          <div className="flex gap-1.5">
            {(['all', 'needs_mapping', 'mapped'] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilterStatus(f)}
                className={`px-3 py-1 text-xs rounded-full font-medium transition-colors ${
                  filterStatus === f
                    ? 'bg-indigo-600 text-white'
                    : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700'
                }`}
              >
                {f === 'all' ? `All (${totalCount})` : f === 'mapped' ? `Mapped (${mappedCount})` : `Needs Mapping (${needsCount})`}
              </button>
            ))}
          </div>

          <div className="flex gap-2 ml-auto">
            <button
              onClick={handleExportMasters}
              disabled={mappedCount === 0}
              className="px-4 py-2 text-sm border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Masters XML
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
          <div className={`mb-4 p-3 rounded-lg text-sm ${exportMsg.startsWith('✓')
            ? 'bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 text-green-700 dark:text-green-400'
            : 'bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-400'}`}>
            {exportMsg}
          </div>
        )}

        {loading ? (
          <div className="text-center py-16 text-gray-400">Loading…</div>
        ) : invoices.length === 0 ? (
          <div className="text-center py-16">
            <div className="text-4xl mb-3">📭</div>
            <p className="text-gray-600 dark:text-gray-400 font-medium">No sales invoices found for {fy}</p>
            <p className="text-sm text-gray-400 dark:text-gray-500 mt-1">Upload and import sales invoices first.</p>
          </div>
        ) : (
          <div className="rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
            {/* Table header */}
            <div className="grid grid-cols-[auto_1fr_auto_auto_auto_auto_auto_auto_auto] items-center gap-2 px-4 py-2 bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 text-xs font-semibold text-gray-500 dark:text-gray-400">
              <span className="w-8 text-center">St.</span>
              <span>Customer · Invoice</span>
              <span className="w-24 text-center">Date</span>
              <span className="w-16 text-center">Type</span>
              <span className="w-28 text-right">Taxable</span>
              <span className="w-28 text-right">Tax</span>
              <span className="w-28 text-right">Total</span>
              <span className="w-24 text-center">Sales Ledger</span>
              <span className="w-8" />
            </div>

            {/* Invoice rows */}
            {filteredInvoices.map((inv) => {
              const acc = acceptedMap[inv.id];
              const d = deriveInvoiceFinancials(inv);
              const status = rowStatus(acc ?? null, acc?.salesLedger ?? '');
              const expanded = expandedIds.has(inv.id);
              const hasTax = d.cgst + d.sgst + d.igst > 0;

              const statusBadge = status === 'mapped'
                ? <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">Mapped</span>
                : status === 'ready'
                ? <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">Ready</span>
                : <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">Map →</span>;

              return (
                <React.Fragment key={inv.id}>
                  {/* Summary row */}
                  <div
                    className={`grid grid-cols-[auto_1fr_auto_auto_auto_auto_auto_auto_auto] items-center gap-2 px-4 py-2.5 border-b border-gray-100 dark:border-gray-800 cursor-pointer select-none transition-colors ${
                      expanded ? 'bg-indigo-50 dark:bg-indigo-900/10' : 'hover:bg-gray-50 dark:hover:bg-gray-800/50'
                    }`}
                    onClick={() => toggleExpand(inv.id)}
                  >
                    {/* Status */}
                    <div className="w-8 text-center text-base">
                      {status === 'mapped' ? '✅' : status === 'ready' ? '🔵' : '🟡'}
                    </div>

                    {/* Customer + invoice */}
                    <div>
                      <div className="text-xs font-medium text-gray-900 dark:text-gray-100 truncate max-w-xs">
                        {inv.buyer_name ?? '—'}
                      </div>
                      <div className="text-xs font-mono text-gray-500 dark:text-gray-400">{inv.invoice_number}</div>
                    </div>

                    {/* Date */}
                    <div className="w-24 text-xs text-center text-gray-600 dark:text-gray-400">{inv.invoice_date ?? '—'}</div>

                    {/* Tax type */}
                    <div className="w-16 text-center">
                      <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 font-mono">
                        {inv.tax_type === 'igst' ? 'IGST' : inv.tax_type === 'cgst_sgst' ? 'C+S' : 'NIL'}
                      </span>
                    </div>

                    {/* Taxable */}
                    <div className="w-28 text-right text-xs text-gray-900 dark:text-gray-100">
                      {formatINR(d.net_goods_taxable + d.taxable_charges_total)}
                    </div>

                    {/* Tax */}
                    <div className="w-28 text-right text-xs text-gray-600 dark:text-gray-400">
                      {hasTax ? formatINR(d.cgst + d.sgst + d.igst) : '—'}
                    </div>

                    {/* Total */}
                    <div className="w-28 text-right text-xs font-semibold text-gray-900 dark:text-gray-100">
                      {formatINR(d.total)}
                    </div>

                    {/* Sales ledger chip */}
                    <div className="w-24 text-center">
                      {acc?.salesLedger ? (
                        <span className="text-xs text-green-700 dark:text-green-400 truncate block max-w-[90px]" title={acc.salesLedger}>
                          {acc.salesLedger}
                        </span>
                      ) : statusBadge}
                    </div>

                    {/* Expand chevron */}
                    <div className="w-8 text-center text-gray-400 text-xs">
                      {expanded ? '▲' : '▼'}
                    </div>
                  </div>

                  {/* Expanded mapping panel */}
                  {expanded && (
                    <MappingPanel
                      inv={inv}
                      customers={customers}
                      suppliers={suppliers}
                      dutiesTaxes={dutiesTaxes}
                      salesLedgerOptions={salesLedgerOptions}
                      companyId={company!.id}
                      initialAcc={acc ?? null}
                      onSave={handleSave}
                    />
                  )}
                </React.Fragment>
              );
            })}

            {/* Footer totals */}
            {filteredInvoices.length > 0 && (() => {
              const totalTaxable = filteredInvoices.reduce((s, inv) => {
                const d = deriveInvoiceFinancials(inv);
                return s + d.net_goods_taxable + d.taxable_charges_total;
              }, 0);
              const totalTax = filteredInvoices.reduce((s, inv) => {
                const d = deriveInvoiceFinancials(inv);
                return s + d.cgst + d.sgst + d.igst;
              }, 0);
              const grandTotal = filteredInvoices.reduce((s, inv) => {
                const d = deriveInvoiceFinancials(inv);
                return s + d.total;
              }, 0);
              return (
                <div className="grid grid-cols-[auto_1fr_auto_auto_auto_auto_auto_auto_auto] items-center gap-2 px-4 py-2.5 bg-gray-50 dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700 text-xs font-semibold text-gray-700 dark:text-gray-300">
                  <div className="w-8" />
                  <div>Total ({filteredInvoices.length} invoices)</div>
                  <div className="w-24" />
                  <div className="w-16" />
                  <div className="w-28 text-right">{formatINR(totalTaxable)}</div>
                  <div className="w-28 text-right">{formatINR(totalTax)}</div>
                  <div className="w-28 text-right">{formatINR(grandTotal)}</div>
                  <div className="w-24" />
                  <div className="w-8" />
                </div>
              );
            })()}
          </div>
        )}
      </div>
    </AppLayout>
  );
}
