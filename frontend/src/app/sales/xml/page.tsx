'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { getCompany } from '@/lib/db';
import { getSalesRegister, saveSalesTallyAcceptance } from '@/lib/salesDb';
import { loadCustomers, addCustomer } from '@/lib/customers';
import { loadSuppliers } from '@/lib/suppliers';
import { loadDutiesTaxes, addDutiesTaxes } from '@/lib/dutiesTaxes';
import { upsertCustomerLedgerPreference, getCustomerLedgerPreferences } from '@/lib/customerLedgerPreferences';
import { loadSalesLedgers, addSalesLedger } from '@/lib/salesLedgerConfig';
import { generateSalesVouchersXml, generateSalesMastersXml } from '@/lib/salesXmlGenerator';
import type { CustomerMaster } from '@/lib/customers';
import type { SupplierMaster } from '@/lib/suppliers';
import type { DutiesTaxesMaster } from '@/lib/dutiesTaxes';
import type { TaxComponent } from '@/lib/dutiesTaxes';
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

// ─── Types ────────────────────────────────────────────────────────────────────

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
    salesLedger:    a.salesLedger ?? '',
    cgstLedger:     a.cgstLedger ?? '',
    sgstLedger:     a.sgstLedger ?? '',
    igstLedger:     a.igstLedger ?? '',
    roLedger:       a.roLedger ?? '',
  };
}

// ─── Master resolution ────────────────────────────────────────────────────────

function resolveCustomerLedger(inv: StoredInvoice, customers: CustomerMaster[], suppliers: SupplierMaster[]): string | null {
  const g = (inv.buyer_gstin ?? '').trim().toUpperCase();
  const n = (inv.buyer_name ?? '').toLowerCase().trim();
  if (g) {
    const c = customers.find((x) => (x.customer_gstin ?? '').toUpperCase() === g);
    if (c) return c.tally_ledger_name;
    const s = suppliers.find((x) => (x.vendor_gstin ?? '').toUpperCase() === g);
    if (s) return s.tally_ledger_name;
  }
  const c2 = customers.find((x) => x.tally_ledger_name.toLowerCase() === n || (x.customer_name ?? '').toLowerCase() === n);
  if (c2) return c2.tally_ledger_name;
  const s2 = suppliers.find((x) => x.tally_ledger_name.toLowerCase() === n || (x.vendor_name ?? '').toLowerCase() === n);
  if (s2) return s2.tally_ledger_name;
  return null;
}

// ─── Output GST helpers ───────────────────────────────────────────────────────

function preferOutput(list: DutiesTaxesMaster[]): DutiesTaxesMaster | undefined {
  return list.find((d) => d.tally_ledger_name.toLowerCase().includes('output')) ?? list[0];
}

function outputOnly(all: DutiesTaxesMaster[], component: string): DutiesTaxesMaster[] {
  const comp = all.filter((d) => d.tax_component === component);
  const out = comp.filter((d) => d.tally_ledger_name.toLowerCase().includes('output'));
  return out.length ? out : comp;
}

// ─── Ledger type badge colors (mirrors purchase preview) ─────────────────────

const BADGE: Record<string, string> = {
  Customer:   'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
  Sales:      'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  CGST:       'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400',
  SGST:       'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400',
  IGST:       'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400',
  'Round Off':'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400',
};

function LedgerBadge({ type }: { type: string }) {
  return (
    <span className={`inline-block text-xs font-medium px-1.5 py-0.5 rounded ${BADGE[type] ?? 'bg-gray-100 text-gray-600'}`}>
      {type}
    </span>
  );
}

// ─── Mapping panel (expanded inline below each invoice row) ───────────────────

interface MappingPanelProps {
  inv: StoredInvoice;
  customers: CustomerMaster[];
  suppliers: SupplierMaster[];
  dutiesTaxes: DutiesTaxesMaster[];
  salesLedgerOptions: string[];
  companyId: string;
  companyState: string;
  initialAcc: SalesTallyAcceptance | null;
  onSave: (id: string, acc: SalesTallyAcceptance) => void;
}

function MappingPanel({
  inv, customers, suppliers, dutiesTaxes, salesLedgerOptions,
  companyId, companyState, initialAcc, onSave,
}: MappingPanelProps) {
  const d = deriveInvoiceFinancials(inv);

  const resolvedLedger = useMemo(
    () => resolveCustomerLedger(inv, customers, suppliers),
    [inv, customers, suppliers],
  );

  const [customerLedger, setCustomerLedger] = useState(
    initialAcc?.customerLedger || resolvedLedger || inv.buyer_name || '',
  );
  const [salesLedger, setSalesLedger]   = useState(initialAcc?.salesLedger ?? '');
  const [cgstLedger,  setCgstLedger]    = useState(initialAcc?.cgstLedger ?? '');
  const [sgstLedger,  setSgstLedger]    = useState(initialAcc?.sgstLedger ?? '');
  const [igstLedger,  setIgstLedger]    = useState(initialAcc?.igstLedger ?? '');
  const [roLedger,    setRoLedger]      = useState(initialAcc?.roLedger ?? '');
  const [saving,      setSaving]        = useState(false);
  const [saved,       setSaved]         = useState(!!initialAcc);
  const [err,         setErr]           = useState<string | null>(null);

  // Load per-customer preferences + auto-fill tax ledgers from masters
  useEffect(() => {
    if (saved) return;
    getCustomerLedgerPreferences(companyId, inv.buyer_gstin, inv.buyer_name).then((prefs) => {
      if (prefs.sales && !salesLedger) setSalesLedger(prefs.sales);
      if (prefs.CGST  && !cgstLedger)  setCgstLedger(prefs.CGST);
      if (prefs.SGST  && !sgstLedger)  setSgstLedger(prefs.SGST);
      if (prefs.IGST  && !igstLedger)  setIgstLedger(prefs.IGST);
      // Fall back to masters if no persisted preference
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
  const isCgstSgst  = inv.tax_type === 'cgst_sgst';
  const isIgst      = inv.tax_type === 'igst';

  const handleSave = async () => {
    if (isBlank(salesLedger)) { setErr('Sales ledger is required'); return; }
    setSaving(true); setErr(null);
    try {
      const acc: SalesTallyAcceptance = { customerLedger, salesLedger, cgstLedger, sgstLedger, igstLedger, roLedger };
      await saveSalesTallyAcceptance(companyId, inv.id, acc as unknown as Record<string, unknown>);

      // ── Master writes (mirrors purchase acceptance) ──────────────────────
      // 1. Customer master: ensure the customer exists
      if (!isBlank(customerLedger)) {
        await addCustomer(companyId, {
          tally_ledger_name: customerLedger,
          customer_gstin: inv.buyer_gstin ?? '',
          customer_name: inv.buyer_name ?? customerLedger,
          companyState,
        }).catch(() => {});
      }
      // 2. Sales ledger master
      if (!isBlank(salesLedger)) {
        await addSalesLedger(companyId, salesLedger).catch(() => {});
      }
      // 3. Duties & Taxes master (output tax ledgers)
      const taxWrites: Array<[TaxComponent, string]> = [];
      if (isCgstSgst && !isBlank(cgstLedger)) taxWrites.push(['CGST', cgstLedger]);
      if (isCgstSgst && !isBlank(sgstLedger)) taxWrites.push(['SGST', sgstLedger]);
      if (isIgst     && !isBlank(igstLedger)) taxWrites.push(['IGST', igstLedger]);
      for (const [comp, ledger] of taxWrites) {
        await addDutiesTaxes(companyId, { tax_component: comp, tax_rate: null, tally_ledger_name: ledger }).catch(() => {});
      }

      // ── Preference learning ──────────────────────────────────────────────
      await upsertCustomerLedgerPreference(companyId, inv.buyer_gstin, inv.buyer_name, 'sales', salesLedger).catch(() => {});
      if (!isBlank(cgstLedger)) await upsertCustomerLedgerPreference(companyId, inv.buyer_gstin, inv.buyer_name, 'CGST', cgstLedger).catch(() => {});
      if (!isBlank(sgstLedger)) await upsertCustomerLedgerPreference(companyId, inv.buyer_gstin, inv.buyer_name, 'SGST', sgstLedger).catch(() => {});
      if (!isBlank(igstLedger)) await upsertCustomerLedgerPreference(companyId, inv.buyer_gstin, inv.buyer_name, 'IGST', igstLedger).catch(() => {});

      setSaved(true);
      onSave(inv.id, acc);
    } catch (e) { setErr(getErrMsg(e)); }
    finally { setSaving(false); }
  };

  return (
    <div className="bg-gray-50 dark:bg-gray-800/50 border-t border-indigo-100 dark:border-indigo-900/40 px-5 py-4">
      {/* Summary line */}
      <div className="flex flex-wrap items-center gap-4 mb-4 text-xs text-gray-600 dark:text-gray-400">
        <span>
          <strong className="text-gray-900 dark:text-gray-100">{inv.buyer_name ?? '—'}</strong>
          {inv.buyer_gstin ? ` · ${inv.buyer_gstin}` : ' · B2C'}
        </span>
        <span>Taxable: <strong>{formatINR(d.net_goods_taxable + d.taxable_charges_total)}</strong></span>
        {(d.cgst + d.sgst) > 0 && <span>CGST+SGST: <strong>{formatINR(d.cgst + d.sgst)}</strong></span>}
        {d.igst > 0 && <span>IGST: <strong>{formatINR(d.igst)}</strong></span>}
        <span>Total: <strong>{formatINR(d.total)}</strong></span>
        {resolvedLedger && (
          <span className="text-green-700 dark:text-green-400">
            ✓ Found in {customers.some((c) => (c.customer_gstin ?? '').toUpperCase() === (inv.buyer_gstin ?? '').toUpperCase()) ? 'customer' : 'supplier'} master
          </span>
        )}
      </div>

      {/* Ledger mapping grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-4">

        {/* Customer Ledger */}
        <div>
          <div className="flex items-center gap-1.5 mb-1">
            <LedgerBadge type="Customer" />
            <label className="text-xs font-medium text-gray-600 dark:text-gray-400">
              Customer Ledger{!resolvedLedger && ' ⚠'}
            </label>
          </div>
          <input
            value={customerLedger}
            onChange={(e) => { setCustomerLedger(e.target.value); setSaved(false); }}
            className="w-full border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 text-xs bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            placeholder="Customer ledger in Tally"
          />
          {!resolvedLedger && (
            <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
              Not found in customer or supplier master — verify ledger name.
              Saving will add this customer to master.
            </p>
          )}
        </div>

        {/* Sales Ledger */}
        <div>
          <div className="flex items-center gap-1.5 mb-1">
            <LedgerBadge type="Sales" />
            <label className="text-xs font-medium text-gray-600 dark:text-gray-400">
              Sales Ledger <span className="text-red-500">*</span>
            </label>
          </div>
          {salesLedgerOptions.length > 0 ? (
            <select
              value={salesLedger}
              onChange={(e) => { setSalesLedger(e.target.value); setSaved(false); }}
              className="w-full border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 text-xs bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            >
              <option value="">— select —</option>
              {salesLedgerOptions.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          ) : (
            <input
              value={salesLedger}
              onChange={(e) => { setSalesLedger(e.target.value); setSaved(false); }}
              className="w-full border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 text-xs bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              placeholder="e.g. Sales @ 5%"
            />
          )}
        </div>

        {/* Round-Off Ledger */}
        <div>
          <div className="flex items-center gap-1.5 mb-1">
            <LedgerBadge type="Round Off" />
            <label className="text-xs font-medium text-gray-600 dark:text-gray-400">Round-Off Ledger</label>
          </div>
          <input
            value={roLedger}
            onChange={(e) => { setRoLedger(e.target.value); setSaved(false); }}
            className="w-full border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 text-xs bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            placeholder="Round Off (optional)"
          />
        </div>

        {/* CGST Ledger */}
        {isCgstSgst && d.cgst > 0 && (
          <div>
            <div className="flex items-center gap-1.5 mb-1">
              <LedgerBadge type="CGST" />
              <label className="text-xs font-medium text-gray-600 dark:text-gray-400">
                Output CGST Ledger ({formatINR(d.cgst)})
              </label>
            </div>
            <select
              value={cgstLedger}
              onChange={(e) => { setCgstLedger(e.target.value); setSaved(false); }}
              className="w-full border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 text-xs bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            >
              <option value="">— select —</option>
              {cgstOptions.map((x) => <option key={x.id} value={x.tally_ledger_name}>{x.tally_ledger_name}</option>)}
            </select>
          </div>
        )}

        {/* SGST Ledger */}
        {isCgstSgst && d.sgst > 0 && (
          <div>
            <div className="flex items-center gap-1.5 mb-1">
              <LedgerBadge type="SGST" />
              <label className="text-xs font-medium text-gray-600 dark:text-gray-400">
                Output SGST Ledger ({formatINR(d.sgst)})
              </label>
            </div>
            <select
              value={sgstLedger}
              onChange={(e) => { setSgstLedger(e.target.value); setSaved(false); }}
              className="w-full border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 text-xs bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            >
              <option value="">— select —</option>
              {sgstOptions.map((x) => <option key={x.id} value={x.tally_ledger_name}>{x.tally_ledger_name}</option>)}
            </select>
          </div>
        )}

        {/* IGST Ledger */}
        {isIgst && d.igst > 0 && (
          <div>
            <div className="flex items-center gap-1.5 mb-1">
              <LedgerBadge type="IGST" />
              <label className="text-xs font-medium text-gray-600 dark:text-gray-400">
                Output IGST Ledger ({formatINR(d.igst)})
              </label>
            </div>
            <select
              value={igstLedger}
              onChange={(e) => { setIgstLedger(e.target.value); setSaved(false); }}
              className="w-full border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 text-xs bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            >
              <option value="">— select —</option>
              {igstOptions.map((x) => <option key={x.id} value={x.tally_ledger_name}>{x.tally_ledger_name}</option>)}
            </select>
          </div>
        )}
      </div>

      {err && <p className="text-xs text-red-600 dark:text-red-400 mb-3">{err}</p>}

      <button
        onClick={handleSave}
        disabled={saving}
        className="px-4 py-1.5 bg-indigo-600 text-white text-xs font-medium rounded hover:bg-indigo-700 disabled:opacity-50 transition-colors"
      >
        {saving ? 'Saving…' : saved ? '✓ Update Mapping' : 'Save Mapping'}
      </button>
    </div>
  );
}

// ─── Dashboard stat card ───────────────────────────────────────────────────────

function StatCard({
  label, value, sub, color, onClick, active,
}: {
  label: string; value: string | number; sub?: string;
  color: 'gray' | 'green' | 'amber' | 'indigo';
  onClick?: () => void; active?: boolean;
}) {
  const border = {
    gray:   'border-gray-200 dark:border-gray-700',
    green:  'border-green-200 dark:border-green-800',
    amber:  'border-amber-200 dark:border-amber-800',
    indigo: 'border-indigo-200 dark:border-indigo-800',
  }[color];
  const textColor = {
    gray:   'text-gray-900 dark:text-gray-100',
    green:  'text-green-700 dark:text-green-400',
    amber:  'text-amber-700 dark:text-amber-400',
    indigo: 'text-indigo-700 dark:text-indigo-400',
  }[color];
  return (
    <button
      onClick={onClick}
      className={`flex-1 min-w-[120px] p-3 rounded-lg border text-left transition-colors ${border} ${
        active ? 'ring-2 ring-indigo-500' : ''
      } ${onClick ? 'cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/50' : 'cursor-default'} bg-white dark:bg-gray-900`}
    >
      <div className={`text-xl font-bold ${textColor}`}>{value}</div>
      <div className="text-xs font-medium text-gray-700 dark:text-gray-300">{label}</div>
      {sub && <div className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">{sub}</div>}
    </button>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function SalesXmlPage() {
  const router = useRouter();
  const { company } = useCompany();
  const [fy, setFy] = useState(currentFY());

  const [invoices,          setInvoices]          = useState<StoredInvoice[]>([]);
  const [customers,         setCustomers]          = useState<CustomerMaster[]>([]);
  const [suppliers,         setSuppliers]          = useState<SupplierMaster[]>([]);
  const [dutiesTaxes,       setDutiesTaxes]        = useState<DutiesTaxesMaster[]>([]);
  const [tallyCompanyName,  setTallyCompanyName]   = useState('');
  const [companyGstin,      setCompanyGstin]       = useState('');
  const [companyState,      setCompanyState]       = useState('');
  const [loading,           setLoading]            = useState(true);
  const [bulkMapping,       setBulkMapping]        = useState(false);
  const [error,             setError]              = useState<string | null>(null);
  const [exportMsg,         setExportMsg]          = useState<string | null>(null);

  const [acceptedMap,       setAcceptedMap]        = useState<Record<string, SalesTallyAcceptance>>({});
  const [salesLedgerOptions,setSalesLedgerOptions] = useState<string[]>([]);
  const [expandedIds,       setExpandedIds]        = useState<Set<string>>(new Set());
  const [filterStatus,      setFilterStatus]       = useState<'all' | 'mapped' | 'unmapped'>('all');
  const [search,            setSearch]             = useState('');

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
        setCompanyState(comp.state_name ?? '');

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
    if (!isBlank(acc.salesLedger) && !salesLedgerOptions.includes(acc.salesLedger)) {
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

  // Auto-map all unmapped invoices using preferences + masters
  const handleAutoMapAll = async () => {
    if (!company || invoices.length === 0) return;
    setBulkMapping(true);
    setError(null);
    let mapped = 0;
    try {
      for (const inv of invoices) {
        if (acceptedMap[inv.id]) continue; // skip already mapped
        const prefs = await getCustomerLedgerPreferences(company.id, inv.buyer_gstin, inv.buyer_name).catch(() => ({} as Record<string, string>));
        const resolved = resolveCustomerLedger(inv, customers, suppliers);
        const custLedger = resolved || inv.buyer_name || '';
        const salesL = (prefs as Record<string, string>).sales || salesLedgerOptions[0] || '';
        if (!salesL) continue; // can't auto-map without a sales ledger

        let cgstL = (prefs as Record<string, string>).CGST || '';
        let sgstL = (prefs as Record<string, string>).SGST || '';
        let igstL = (prefs as Record<string, string>).IGST || '';
        // Fall back to first output ledger from masters
        if (!cgstL) cgstL = preferOutput(dutiesTaxes.filter((d) => d.tax_component === 'CGST'))?.tally_ledger_name ?? '';
        if (!sgstL) sgstL = preferOutput(dutiesTaxes.filter((d) => d.tax_component === 'SGST'))?.tally_ledger_name ?? '';
        if (!igstL) igstL = preferOutput(dutiesTaxes.filter((d) => d.tax_component === 'IGST'))?.tally_ledger_name ?? '';

        const acc: SalesTallyAcceptance = { customerLedger: custLedger, salesLedger: salesL, cgstLedger: cgstL, sgstLedger: sgstL, igstLedger: igstL, roLedger: '' };
        await saveSalesTallyAcceptance(company.id, inv.id, acc as unknown as Record<string, unknown>).catch(() => {});
        setAcceptedMap((prev) => ({ ...prev, [inv.id]: acc }));
        mapped++;
      }
      setExportMsg(`✓ Auto-mapped ${mapped} invoices.`);
    } catch (e) {
      setError(getErrMsg(e));
    } finally {
      setBulkMapping(false);
    }
  };

  const mappedInvoices = useMemo(
    () => invoices.filter((inv) => { const a = acceptedMap[inv.id]; return a && !isBlank(a.salesLedger); }),
    [invoices, acceptedMap],
  );

  const filteredInvoices = useMemo(() => {
    let list = invoices;
    if (filterStatus === 'mapped') list = list.filter((inv) => acceptedMap[inv.id] && !isBlank(acceptedMap[inv.id].salesLedger));
    if (filterStatus === 'unmapped') list = list.filter((inv) => !acceptedMap[inv.id] || isBlank(acceptedMap[inv.id].salesLedger));
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((inv) =>
        (inv.invoice_number ?? '').toLowerCase().includes(q) ||
        (inv.buyer_name ?? '').toLowerCase().includes(q) ||
        (inv.buyer_gstin ?? '').toLowerCase().includes(q),
      );
    }
    return list;
  }, [invoices, acceptedMap, filterStatus, search]);

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

  const totalCount   = invoices.length;
  const mappedCount  = mappedInvoices.length;
  const unmappedCount = totalCount - mappedCount;

  const totalTaxable = useMemo(() => filteredInvoices.reduce((s, inv) => { const d = deriveInvoiceFinancials(inv); return s + d.net_goods_taxable + d.taxable_charges_total; }, 0), [filteredInvoices]);
  const totalTax     = useMemo(() => filteredInvoices.reduce((s, inv) => { const d = deriveInvoiceFinancials(inv); return s + d.cgst + d.sgst + d.igst; }, 0), [filteredInvoices]);
  const grandTotal   = useMemo(() => filteredInvoices.reduce((s, inv) => { const d = deriveInvoiceFinancials(inv); return s + d.total; }, 0), [filteredInvoices]);

  return (
    <AppLayout>
      <div className="max-w-7xl mx-auto px-4 py-8">
        {/* Page header */}
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Sales Export to Tally</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            Map ledgers for each invoice, then export Sales vouchers and Masters to Tally XML.
          </p>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-sm text-red-700 dark:text-red-400">{error}</div>
        )}

        {exportMsg && (
          <div className={`mb-4 p-3 rounded-lg text-sm ${exportMsg.startsWith('✓')
            ? 'bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 text-green-700 dark:text-green-400'
            : 'bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-400'}`}>
            {exportMsg}
          </div>
        )}

        {/* Dashboard stat cards */}
        {!loading && totalCount > 0 && (
          <div className="flex flex-wrap gap-3 mb-6">
            <StatCard label="Total"   value={totalCount.toLocaleString()}   color="gray"   onClick={() => setFilterStatus('all')}     active={filterStatus === 'all'} />
            <StatCard label="Mapped"  value={mappedCount.toLocaleString()}  color="green"  onClick={() => setFilterStatus('mapped')}   active={filterStatus === 'mapped'}
              sub={mappedCount > 0 ? `${formatINR(mappedInvoices.reduce((s, i) => { const d = deriveInvoiceFinancials(i); return s + d.total; }, 0))} total` : undefined} />
            <StatCard label="Unmapped" value={unmappedCount.toLocaleString()} color="amber" onClick={() => setFilterStatus('unmapped')} active={filterStatus === 'unmapped'} />
          </div>
        )}

        {/* Controls row */}
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <FYPeriodSelector value={fy} onChange={(v) => { setFy(v); setError(null); setExportMsg(null); }} />

          {/* Search */}
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search invoice # / customer / GSTIN…"
            className="px-3 py-1.5 text-xs border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 w-64 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          />

          <div className="flex gap-2 ml-auto">
            <button
              onClick={handleAutoMapAll}
              disabled={bulkMapping || unmappedCount === 0}
              className="px-4 py-2 text-sm border border-indigo-300 dark:border-indigo-700 text-indigo-700 dark:text-indigo-400 rounded-lg hover:bg-indigo-50 dark:hover:bg-indigo-900/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {bulkMapping ? 'Mapping…' : `Auto-Map ${unmappedCount} Remaining`}
            </button>
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

        {loading ? (
          <div className="text-center py-16 text-gray-400">Loading…</div>
        ) : invoices.length === 0 ? (
          <div className="text-center py-16">
            <div className="text-4xl mb-3">📭</div>
            <p className="text-gray-600 dark:text-gray-400 font-medium">No sales invoices found for {fy}</p>
            <p className="text-sm text-gray-400 dark:text-gray-500 mt-1">Upload and import sales invoices first.</p>
          </div>
        ) : (
          <div className="rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
            {/* Table header */}
            <div className="grid grid-cols-[32px_1fr_100px_60px_120px_120px_120px_120px_32px] items-center gap-2 px-4 py-2.5 bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 text-xs font-semibold text-gray-500 dark:text-gray-400">
              <span />
              <span>Customer · Invoice #</span>
              <span className="text-center">Date</span>
              <span className="text-center">Type</span>
              <span className="text-right">Taxable</span>
              <span className="text-right">Tax</span>
              <span className="text-right">Total</span>
              <span className="text-center">Sales Ledger</span>
              <span />
            </div>

            {/* Invoice rows */}
            {filteredInvoices.map((inv) => {
              const acc      = acceptedMap[inv.id];
              const d        = deriveInvoiceFinancials(inv);
              const isMapped = acc && !isBlank(acc.salesLedger);
              const expanded = expandedIds.has(inv.id);
              const hasTax   = d.cgst + d.sgst + d.igst > 0;

              return (
                <React.Fragment key={inv.id}>
                  <div
                    className={[
                      'grid grid-cols-[32px_1fr_100px_60px_120px_120px_120px_120px_32px]',
                      'items-center gap-2 px-4 py-2.5 border-b border-gray-100 dark:border-gray-800',
                      'cursor-pointer select-none transition-colors',
                      expanded   ? 'bg-indigo-50/70 dark:bg-indigo-900/10'    : '',
                      isMapped   ? 'bg-green-50/30 dark:bg-green-900/5'       : '',
                      !isMapped && !expanded ? 'hover:bg-gray-50 dark:hover:bg-gray-800/50' : '',
                    ].join(' ')}
                    onClick={() => toggleExpand(inv.id)}
                  >
                    {/* Status dot */}
                    <div className="text-center text-base leading-none">
                      {isMapped ? '✅' : '🟡'}
                    </div>

                    {/* Customer + invoice */}
                    <div className="min-w-0">
                      <div className="text-xs font-medium text-gray-900 dark:text-gray-100 truncate">
                        {inv.buyer_name ?? '—'}
                      </div>
                      <div className="text-xs font-mono text-gray-500 dark:text-gray-400">{inv.invoice_number}</div>
                    </div>

                    {/* Date */}
                    <div className="text-xs text-center text-gray-500 dark:text-gray-400 tabular-nums">{inv.invoice_date ?? '—'}</div>

                    {/* Tax type badge */}
                    <div className="text-center">
                      <span className={`text-xs px-1.5 py-0.5 rounded font-mono font-medium ${
                        inv.tax_type === 'igst'     ? 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400' :
                        inv.tax_type === 'cgst_sgst' ? 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400' :
                        'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400'
                      }`}>
                        {inv.tax_type === 'igst' ? 'IGST' : inv.tax_type === 'cgst_sgst' ? 'C+S' : 'NIL'}
                      </span>
                    </div>

                    {/* Taxable */}
                    <div className="text-xs text-right text-gray-900 dark:text-gray-100 tabular-nums">
                      {formatINR(d.net_goods_taxable + d.taxable_charges_total)}
                    </div>

                    {/* Tax */}
                    <div className="text-xs text-right text-gray-500 dark:text-gray-400 tabular-nums">
                      {hasTax ? formatINR(d.cgst + d.sgst + d.igst) : '—'}
                    </div>

                    {/* Total */}
                    <div className="text-xs text-right font-semibold text-gray-900 dark:text-gray-100 tabular-nums">
                      {formatINR(d.total)}
                    </div>

                    {/* Sales ledger badge or Map button */}
                    <div className="text-center">
                      {acc?.salesLedger ? (
                        <span className="inline-block text-xs text-green-700 dark:text-green-400 font-medium truncate max-w-[108px]" title={acc.salesLedger}>
                          {acc.salesLedger}
                        </span>
                      ) : (
                        <span className="inline-block text-xs px-2 py-0.5 rounded-full font-medium bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
                          Map →
                        </span>
                      )}
                    </div>

                    {/* Expand chevron */}
                    <div className="text-center text-gray-400 text-xs">{expanded ? '▲' : '▼'}</div>
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
                      companyState={companyState}
                      initialAcc={acc ?? null}
                      onSave={handleSave}
                    />
                  )}
                </React.Fragment>
              );
            })}

            {/* Footer totals */}
            {filteredInvoices.length > 0 && (
              <div className="grid grid-cols-[32px_1fr_100px_60px_120px_120px_120px_120px_32px] items-center gap-2 px-4 py-2.5 bg-gray-50 dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700 text-xs font-semibold text-gray-700 dark:text-gray-300">
                <div />
                <div>Total ({filteredInvoices.length.toLocaleString()} invoices)</div>
                <div className="col-span-2" />
                <div className="text-right tabular-nums">{formatINR(totalTaxable)}</div>
                <div className="text-right tabular-nums">{formatINR(totalTax)}</div>
                <div className="text-right tabular-nums">{formatINR(grandTotal)}</div>
                <div className="col-span-2" />
              </div>
            )}
          </div>
        )}
      </div>
    </AppLayout>
  );
}
