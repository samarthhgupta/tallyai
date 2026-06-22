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
import { InvoiceEditPanel, type InvoiceEditData } from '@/components/InvoiceEditPanel';

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

// ─── Ledger type badge ────────────────────────────────────────────────────────

const BADGE: Record<string, string> = {
  Customer:    'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
  Sales:       'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  CGST:        'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400',
  SGST:        'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400',
  IGST:        'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400',
  'Round Off': 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400',
};

function LedgerBadge({ type }: { type: string }) {
  return (
    <span className={`inline-block text-xs font-medium px-1.5 py-0.5 rounded ${BADGE[type] ?? 'bg-gray-100 text-gray-600'}`}>
      {type}
    </span>
  );
}

// ─── Readiness badge ──────────────────────────────────────────────────────────

function ReadinessBadge({ readiness, flags }: { readiness?: string | null; flags?: string[] | null }) {
  if (!readiness || readiness === 'ready') return null;
  const isCritical = readiness === 'critical';
  return (
    <span
      className={`inline-flex items-center gap-0.5 text-xs px-1.5 py-0.5 rounded font-medium ${
        isCritical
          ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
          : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
      }`}
      title={(flags ?? []).join('\n') || readiness}
    >
      {isCritical ? '⛔' : '⚠'} {isCritical ? 'Critical' : 'Warning'}
    </span>
  );
}

// ─── InlineCreateInput ────────────────────────────────────────────────────────

function InlineCreateInput({ placeholder, onConfirm, onCancel }: {
  placeholder: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}) {
  return (
    <input
      autoFocus
      type="text"
      placeholder={placeholder}
      className="border border-indigo-300 dark:border-indigo-800 rounded px-2 py-0.5 text-xs bg-indigo-50 dark:bg-indigo-900/30 dark:text-gray-100 w-full font-mono"
      onKeyDown={(e) => {
        if (e.key === 'Enter') { const v = e.currentTarget.value.trim(); if (v) onConfirm(v); else onCancel(); }
        if (e.key === 'Escape') onCancel();
      }}
      onBlur={(e) => {
        const v = e.currentTarget.value.trim();
        if (v) onConfirm(v);
      }}
    />
  );
}

// ─── CreatableLedgerDropdown (matches purchase preview component exactly) ─────

function CreatableLedgerDropdown({
  value, options, pendingOptions, suggested,
  freetext, createLabel,
  onSelect, onStartCreate, onConfirmCreate, onCancelCreate,
}: {
  value: string;
  options: string[];
  pendingOptions: string[];
  suggested: boolean;
  freetext: boolean;
  createLabel: string;
  onSelect: (v: string) => void;
  onStartCreate: () => void;
  onConfirmCreate: (v: string) => void;
  onCancelCreate: () => void;
}) {
  const allOpts = [...options, ...pendingOptions];
  const isGhost = value !== '' && !allOpts.includes(value);
  const cls = `border rounded px-2 py-1 text-xs w-full dark:text-gray-100 ${
    suggested
      ? 'border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20'
      : 'border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700'
  }`;

  if (freetext) {
    return (
      <InlineCreateInput
        placeholder={createLabel}
        onConfirm={onConfirmCreate}
        onCancel={onCancelCreate}
      />
    );
  }

  return (
    <div className="flex items-center gap-1">
      <select
        value={value}
        onChange={(e) => {
          if (e.target.value === '__new__') { onStartCreate(); return; }
          if (!e.target.value) return;
          onSelect(e.target.value);
        }}
        className={cls}
      >
        {isGhost && <option value={value}>{value}{suggested ? ' ✦' : ''}</option>}
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
        {pendingOptions.map((o) => <option key={`p_${o}`} value={o}>{o} (new)</option>)}
        <option value="__new__">+ Create new…</option>
      </select>
    </div>
  );
}

// ─── Locked mapping summary (read-only display after acceptance) ───────────────

function LockedMappingView({
  acc, inv, isCgstSgst, isIgst, onEdit, onUnmap,
}: {
  acc: SalesTallyAcceptance;
  inv: StoredInvoice;
  isCgstSgst: boolean;
  isIgst: boolean;
  onEdit: () => void;
  onUnmap: () => void;
}) {
  const d = deriveInvoiceFinancials(inv);
  return (
    <div className="bg-green-50/60 dark:bg-green-900/10 border-t border-green-200 dark:border-green-800/50 px-5 py-3">
      <div className="flex flex-wrap items-center gap-3 mb-3 text-xs">
        <span className="font-medium text-green-700 dark:text-green-400">✓ Mapping accepted</span>
        <span className="text-gray-500 dark:text-gray-400">Total: <strong className="text-gray-900 dark:text-gray-100">{formatINR(d.total)}</strong></span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 mb-3">
        {[
          { label: 'Customer', value: acc.customerLedger },
          { label: 'Sales', value: acc.salesLedger },
          isCgstSgst ? { label: 'CGST', value: acc.cgstLedger } : null,
          isCgstSgst ? { label: 'SGST', value: acc.sgstLedger } : null,
          isIgst     ? { label: 'IGST', value: acc.igstLedger } : null,
          acc.roLedger ? { label: 'Round Off', value: acc.roLedger } : null,
        ].filter(Boolean).map((item) => (
          <div key={item!.label}>
            <div className="mb-0.5"><LedgerBadge type={item!.label} /></div>
            <div className="text-xs text-gray-700 dark:text-gray-300 truncate font-mono" title={item!.value}>
              {item!.value || <span className="text-gray-400 italic">—</span>}
            </div>
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <button
          onClick={onEdit}
          className="px-3 py-1 text-xs border border-indigo-300 dark:border-indigo-700 text-indigo-700 dark:text-indigo-400 rounded hover:bg-indigo-50 dark:hover:bg-indigo-900/20 transition-colors"
        >
          Edit Mapping
        </button>
        <button
          onClick={onUnmap}
          className="px-3 py-1 text-xs border border-red-200 dark:border-red-800 text-red-600 dark:text-red-400 rounded hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
        >
          Unmap
        </button>
      </div>
    </div>
  );
}

// ─── Mapping panel ────────────────────────────────────────────────────────────

interface MappingPanelProps {
  inv: StoredInvoice;
  customers: CustomerMaster[];
  suppliers: SupplierMaster[];
  dutiesTaxes: DutiesTaxesMaster[];
  salesLedgerOptions: string[];
  pendingSalesLedgers: string[];
  companyId: string;
  companyState: string;
  initialAcc: SalesTallyAcceptance | null;
  onSave: (id: string, acc: SalesTallyAcceptance, newSalesLedger?: string) => void;
  onUnmapRequest: () => void;
}

function MappingPanel({
  inv, customers, suppliers, dutiesTaxes, salesLedgerOptions, pendingSalesLedgers,
  companyId, companyState, initialAcc, onSave, onUnmapRequest,
}: MappingPanelProps) {
  const d = deriveInvoiceFinancials(inv);
  const isCgstSgst = inv.tax_type === 'cgst_sgst';
  const isIgst     = inv.tax_type === 'igst';

  const resolvedLedger = useMemo(
    () => resolveCustomerLedger(inv, customers, suppliers),
    [inv, customers, suppliers],
  );

  const [customerLedger, setCustomerLedger] = useState(
    initialAcc?.customerLedger || resolvedLedger || inv.buyer_name || '',
  );
  const [salesLedger, setSalesLedger] = useState(initialAcc?.salesLedger ?? '');
  const [cgstLedger,  setCgstLedger]  = useState(initialAcc?.cgstLedger ?? '');
  const [sgstLedger,  setSgstLedger]  = useState(initialAcc?.sgstLedger ?? '');
  const [igstLedger,  setIgstLedger]  = useState(initialAcc?.igstLedger ?? '');
  const [roLedger,    setRoLedger]    = useState(initialAcc?.roLedger ?? '');
  const [saving,      setSaving]      = useState(false);
  const [err,         setErr]         = useState<string | null>(null);

  // Freetext create state (one per field)
  const [customerFree, setCustomerFree] = useState(false);
  const [salesFree,    setSalesFree]    = useState(false);
  const [roFree,       setRoFree]       = useState(false);

  // Pending new options created in this session
  const [pendingCustomers,  setPendingCustomers]  = useState<string[]>([]);
  const [pendingRoLedgers,  setPendingRoLedgers]  = useState<string[]>([]);

  // Lock state: start locked if already accepted, then user can click "Edit Mapping"
  const [editing, setEditing] = useState(!initialAcc);

  // Auto-fill from preferences on first open
  useEffect(() => {
    if (!editing) return;
    getCustomerLedgerPreferences(companyId, inv.buyer_gstin, inv.buyer_name).then((prefs) => {
      if (prefs.sales && !salesLedger) setSalesLedger(prefs.sales);
      if (prefs.CGST  && !cgstLedger)  setCgstLedger(prefs.CGST);
      if (prefs.SGST  && !sgstLedger)  setSgstLedger(prefs.SGST);
      if (prefs.IGST  && !igstLedger)  setIgstLedger(prefs.IGST);
      // Fall back to masters
      if (isCgstSgst) {
        const cgst = preferOutput(dutiesTaxes.filter((x) => x.tax_component === 'CGST'));
        const sgst = preferOutput(dutiesTaxes.filter((x) => x.tax_component === 'SGST'));
        if (cgst && !cgstLedger) setCgstLedger(cgst.tally_ledger_name);
        if (sgst && !sgstLedger) setSgstLedger(sgst.tally_ledger_name);
      } else if (isIgst) {
        const igst = preferOutput(dutiesTaxes.filter((x) => x.tax_component === 'IGST'));
        if (igst && !igstLedger) setIgstLedger(igst.tally_ledger_name);
      }
    }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, companyId, inv.buyer_gstin, inv.buyer_name, inv.tax_type]);

  const cgstOptions = outputOnly(dutiesTaxes, 'CGST').map((x) => x.tally_ledger_name);
  const sgstOptions = outputOnly(dutiesTaxes, 'SGST').map((x) => x.tally_ledger_name);
  const igstOptions = outputOnly(dutiesTaxes, 'IGST').map((x) => x.tally_ledger_name);
  const customerOptions = customers.map((c) => c.tally_ledger_name);

  // Suggest if not yet accepted
  const isSuggestedSales    = !initialAcc && salesLedgerOptions.length > 0;
  const isSuggestedCustomer = !initialAcc && !!resolvedLedger;

  const handleSave = async () => {
    if (isBlank(salesLedger)) { setErr('Sales ledger is required'); return; }
    setSaving(true); setErr(null);
    try {
      const acc: SalesTallyAcceptance = { customerLedger, salesLedger, cgstLedger, sgstLedger, igstLedger, roLedger };
      await saveSalesTallyAcceptance(companyId, inv.id, acc as unknown as Record<string, unknown>);

      // Customer master
      if (!isBlank(customerLedger)) {
        await addCustomer(companyId, {
          tally_ledger_name: customerLedger,
          customer_gstin: inv.buyer_gstin ?? '',
          customer_name: inv.buyer_name ?? customerLedger,
          companyState,
        }).catch(() => {});
      }
      // Sales ledger master
      if (!isBlank(salesLedger)) {
        await addSalesLedger(companyId, salesLedger).catch(() => {});
      }
      // Tax ledger masters
      const taxWrites: Array<[TaxComponent, string]> = [];
      if (isCgstSgst && !isBlank(cgstLedger)) taxWrites.push(['CGST', cgstLedger]);
      if (isCgstSgst && !isBlank(sgstLedger)) taxWrites.push(['SGST', sgstLedger]);
      if (isIgst     && !isBlank(igstLedger)) taxWrites.push(['IGST', igstLedger]);
      for (const [comp, ledger] of taxWrites) {
        await addDutiesTaxes(companyId, { tax_component: comp, tax_rate: null, tally_ledger_name: ledger }).catch(() => {});
      }

      // Learning: persist preferences per customer
      await upsertCustomerLedgerPreference(companyId, inv.buyer_gstin, inv.buyer_name, 'sales', salesLedger).catch(() => {});
      if (!isBlank(cgstLedger)) await upsertCustomerLedgerPreference(companyId, inv.buyer_gstin, inv.buyer_name, 'CGST', cgstLedger).catch(() => {});
      if (!isBlank(sgstLedger)) await upsertCustomerLedgerPreference(companyId, inv.buyer_gstin, inv.buyer_name, 'SGST', sgstLedger).catch(() => {});
      if (!isBlank(igstLedger)) await upsertCustomerLedgerPreference(companyId, inv.buyer_gstin, inv.buyer_name, 'IGST', igstLedger).catch(() => {});

      setEditing(false);
      onSave(inv.id, acc, pendingCustomers.includes(salesLedger) ? salesLedger : undefined);
    } catch (e) { setErr(getErrMsg(e)); }
    finally { setSaving(false); }
  };

  // ── Locked view ────────────────────────────────────────────────────────────
  if (!editing && initialAcc) {
    return (
      <LockedMappingView
        acc={initialAcc}
        inv={inv}
        isCgstSgst={isCgstSgst}
        isIgst={isIgst}
        onEdit={() => setEditing(true)}
        onUnmap={onUnmapRequest}
      />
    );
  }

  // ── Editable form ──────────────────────────────────────────────────────────
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
          <CreatableLedgerDropdown
            value={customerLedger}
            options={customerOptions}
            pendingOptions={pendingCustomers}
            suggested={isSuggestedCustomer}
            freetext={customerFree}
            createLabel="New customer ledger name…"
            onSelect={(v) => { setCustomerLedger(v); }}
            onStartCreate={() => setCustomerFree(true)}
            onConfirmCreate={(v) => { setCustomerLedger(v); setPendingCustomers((p) => [...p, v]); setCustomerFree(false); }}
            onCancelCreate={() => setCustomerFree(false)}
          />
          {!resolvedLedger && (
            <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
              Not found in master — saving will add this customer.
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
          <CreatableLedgerDropdown
            value={salesLedger}
            options={salesLedgerOptions}
            pendingOptions={pendingSalesLedgers}
            suggested={isSuggestedSales}
            freetext={salesFree}
            createLabel="New sales ledger name…"
            onSelect={(v) => setSalesLedger(v)}
            onStartCreate={() => setSalesFree(true)}
            onConfirmCreate={(v) => { setSalesLedger(v); setSalesFree(false); }}
            onCancelCreate={() => setSalesFree(false)}
          />
        </div>

        {/* Round-Off Ledger */}
        <div>
          <div className="flex items-center gap-1.5 mb-1">
            <LedgerBadge type="Round Off" />
            <label className="text-xs font-medium text-gray-600 dark:text-gray-400">Round-Off Ledger</label>
          </div>
          <CreatableLedgerDropdown
            value={roLedger}
            options={[]}
            pendingOptions={pendingRoLedgers}
            suggested={false}
            freetext={roFree}
            createLabel="Round off ledger name…"
            onSelect={(v) => setRoLedger(v)}
            onStartCreate={() => setRoFree(true)}
            onConfirmCreate={(v) => { setRoLedger(v); setPendingRoLedgers((p) => [...p, v]); setRoFree(false); }}
            onCancelCreate={() => setRoFree(false)}
          />
        </div>

        {/* CGST Ledger */}
        {isCgstSgst && d.cgst > 0 && (
          <div>
            <div className="flex items-center gap-1.5 mb-1">
              <LedgerBadge type="CGST" />
              <label className="text-xs font-medium text-gray-600 dark:text-gray-400">
                Output CGST ({formatINR(d.cgst)})
              </label>
            </div>
            <select
              value={cgstLedger}
              onChange={(e) => setCgstLedger(e.target.value)}
              className="w-full border border-gray-300 dark:border-gray-600 rounded px-2 py-1 text-xs bg-white dark:bg-gray-700 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            >
              <option value="">— select —</option>
              {cgstOptions.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          </div>
        )}

        {/* SGST Ledger */}
        {isCgstSgst && d.sgst > 0 && (
          <div>
            <div className="flex items-center gap-1.5 mb-1">
              <LedgerBadge type="SGST" />
              <label className="text-xs font-medium text-gray-600 dark:text-gray-400">
                Output SGST ({formatINR(d.sgst)})
              </label>
            </div>
            <select
              value={sgstLedger}
              onChange={(e) => setSgstLedger(e.target.value)}
              className="w-full border border-gray-300 dark:border-gray-600 rounded px-2 py-1 text-xs bg-white dark:bg-gray-700 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            >
              <option value="">— select —</option>
              {sgstOptions.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          </div>
        )}

        {/* IGST Ledger */}
        {isIgst && d.igst > 0 && (
          <div>
            <div className="flex items-center gap-1.5 mb-1">
              <LedgerBadge type="IGST" />
              <label className="text-xs font-medium text-gray-600 dark:text-gray-400">
                Output IGST ({formatINR(d.igst)})
              </label>
            </div>
            <select
              value={igstLedger}
              onChange={(e) => setIgstLedger(e.target.value)}
              className="w-full border border-gray-300 dark:border-gray-600 rounded px-2 py-1 text-xs bg-white dark:bg-gray-700 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            >
              <option value="">— select —</option>
              {igstOptions.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          </div>
        )}
      </div>

      {err && <p className="text-xs text-red-600 dark:text-red-400 mb-3">{err}</p>}

      <div className="flex items-center gap-2">
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-4 py-1.5 bg-indigo-600 text-white text-xs font-medium rounded hover:bg-indigo-700 disabled:opacity-50 transition-colors"
        >
          {saving ? 'Saving…' : 'Accept Mapping'}
        </button>
        {initialAcc && (
          <button
            onClick={() => setEditing(false)}
            className="px-3 py-1.5 text-xs border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-400 rounded hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
          >
            Cancel
          </button>
        )}
      </div>
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

  const [invoices,           setInvoices]           = useState<StoredInvoice[]>([]);
  const [customers,          setCustomers]           = useState<CustomerMaster[]>([]);
  const [suppliers,          setSuppliers]           = useState<SupplierMaster[]>([]);
  const [dutiesTaxes,        setDutiesTaxes]         = useState<DutiesTaxesMaster[]>([]);
  const [tallyCompanyName,   setTallyCompanyName]    = useState('');
  const [companyGstin,       setCompanyGstin]        = useState('');
  const [companyState,       setCompanyState]        = useState('');
  const [loading,            setLoading]             = useState(true);
  const [bulkMapping,        setBulkMapping]         = useState(false);
  const [bulkSaving,         setBulkSaving]          = useState(false);
  const [error,              setError]               = useState<string | null>(null);
  const [exportMsg,          setExportMsg]           = useState<string | null>(null);

  const [acceptedMap,        setAcceptedMap]         = useState<Record<string, SalesTallyAcceptance>>({});
  const [salesLedgerOptions, setSalesLedgerOptions]  = useState<string[]>([]);
  const [pendingSalesLedgers,setPendingSalesLedgers]  = useState<string[]>([]);
  const [expandedIds,        setExpandedIds]         = useState<Set<string>>(new Set());
  const [filterStatus,       setFilterStatus]        = useState<'all' | 'accepted' | 'pending'>('all');
  const [search,             setSearch]              = useState('');
  const [selectedInvoices,   setSelectedInvoices]    = useState<Set<string>>(new Set());
  const [editingInvoice,     setEditingInvoice]      = useState<StoredInvoice | null>(null);

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

  const handleSave = (id: string, acc: SalesTallyAcceptance, newSalesLedger?: string) => {
    setAcceptedMap((prev) => ({ ...prev, [id]: acc }));
    if (newSalesLedger && !salesLedgerOptions.includes(newSalesLedger)) {
      setSalesLedgerOptions((prev) => [...prev, newSalesLedger]);
      setPendingSalesLedgers((prev) => [...prev, newSalesLedger]);
    } else if (acc.salesLedger && !salesLedgerOptions.includes(acc.salesLedger)) {
      setSalesLedgerOptions((prev) => [...prev, acc.salesLedger]);
    }
    // Collapse after accepting
    setExpandedIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
  };

  const handleUnmap = async (invId: string) => {
    if (!company) return;
    try {
      await saveSalesTallyAcceptance(company.id, invId, null);
      setAcceptedMap((prev) => { const next = { ...prev }; delete next[invId]; return next; });
    } catch (e) { setError(getErrMsg(e)); }
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
        if (acceptedMap[inv.id]) continue;
        const prefs = await getCustomerLedgerPreferences(company.id, inv.buyer_gstin, inv.buyer_name).catch(() => ({} as Record<string, string>));
        const resolved = resolveCustomerLedger(inv, customers, suppliers);
        const custLedger = resolved || inv.buyer_name || '';
        const salesL = (prefs as Record<string, string>).sales || salesLedgerOptions[0] || '';
        if (!salesL) continue;

        let cgstL = (prefs as Record<string, string>).CGST || '';
        let sgstL = (prefs as Record<string, string>).SGST || '';
        let igstL = (prefs as Record<string, string>).IGST || '';
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

  // Bulk accept selected (uses same auto-map logic but only for selected)
  const handleBulkAcceptSelected = async () => {
    if (!company || selectedInvoices.size === 0) return;
    setBulkSaving(true);
    setError(null);
    let mapped = 0;
    try {
      const toMap = invoices.filter((inv) => selectedInvoices.has(inv.id) && !acceptedMap[inv.id]);
      for (const inv of toMap) {
        const prefs = await getCustomerLedgerPreferences(company.id, inv.buyer_gstin, inv.buyer_name).catch(() => ({} as Record<string, string>));
        const resolved = resolveCustomerLedger(inv, customers, suppliers);
        const custLedger = resolved || inv.buyer_name || '';
        const salesL = (prefs as Record<string, string>).sales || salesLedgerOptions[0] || '';
        if (!salesL) continue;

        let cgstL = (prefs as Record<string, string>).CGST || '';
        let sgstL = (prefs as Record<string, string>).SGST || '';
        let igstL = (prefs as Record<string, string>).IGST || '';
        if (!cgstL) cgstL = preferOutput(dutiesTaxes.filter((d) => d.tax_component === 'CGST'))?.tally_ledger_name ?? '';
        if (!sgstL) sgstL = preferOutput(dutiesTaxes.filter((d) => d.tax_component === 'SGST'))?.tally_ledger_name ?? '';
        if (!igstL) igstL = preferOutput(dutiesTaxes.filter((d) => d.tax_component === 'IGST'))?.tally_ledger_name ?? '';

        const acc: SalesTallyAcceptance = { customerLedger: custLedger, salesLedger: salesL, cgstLedger: cgstL, sgstLedger: sgstL, igstLedger: igstL, roLedger: '' };
        await saveSalesTallyAcceptance(company.id, inv.id, acc as unknown as Record<string, unknown>).catch(() => {});
        setAcceptedMap((prev) => ({ ...prev, [inv.id]: acc }));
        mapped++;
      }
      setSelectedInvoices(new Set());
      if (mapped > 0) setExportMsg(`✓ Accepted ${mapped} invoices.`);
    } catch (e) {
      setError(getErrMsg(e));
    } finally {
      setBulkSaving(false);
    }
  };

  // Bulk unmap selected accepted invoices
  const handleBulkUnmapSelected = async () => {
    if (!company) return;
    const toUnmap = invoices.filter((inv) => selectedInvoices.has(inv.id) && acceptedMap[inv.id]);
    if (!toUnmap.length) return;
    setBulkSaving(true);
    try {
      for (const inv of toUnmap) {
        await saveSalesTallyAcceptance(company.id, inv.id, null).catch(() => {});
        setAcceptedMap((prev) => { const next = { ...prev }; delete next[inv.id]; return next; });
      }
      setSelectedInvoices(new Set());
    } catch (e) { setError(getErrMsg(e)); }
    finally { setBulkSaving(false); }
  };

  const mappedInvoices = useMemo(
    () => invoices.filter((inv) => { const a = acceptedMap[inv.id]; return a && !isBlank(a.salesLedger); }),
    [invoices, acceptedMap],
  );

  const filteredInvoices = useMemo(() => {
    let list = invoices;
    if (filterStatus === 'accepted') list = list.filter((inv) => acceptedMap[inv.id] && !isBlank(acceptedMap[inv.id].salesLedger));
    if (filterStatus === 'pending')  list = list.filter((inv) => !acceptedMap[inv.id] || isBlank(acceptedMap[inv.id].salesLedger));
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

  // Invoices eligible for select/accept (unmapped in current filter)
  const selectableIds = useMemo(
    () => filteredInvoices.filter((inv) => !acceptedMap[inv.id]).map((inv) => inv.id),
    [filteredInvoices, acceptedMap],
  );
  const selectedAccepted = useMemo(
    () => new Set(Array.from(selectedInvoices).filter((id) => !!acceptedMap[id])),
    [selectedInvoices, acceptedMap],
  );
  const allPendingSelected = selectableIds.length > 0 && selectableIds.every((id) => selectedInvoices.has(id));

  const toggleSelectAll = () => {
    if (allPendingSelected) {
      setSelectedInvoices((prev) => { const next = new Set(prev); selectableIds.forEach((id) => next.delete(id)); return next; });
    } else {
      setSelectedInvoices((prev) => new Set([...Array.from(prev), ...selectableIds]));
    }
  };
  const toggleSelect = (id: string) => {
    setSelectedInvoices((prev) => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next; });
  };

  const totalCount    = invoices.length;
  const mappedCount   = mappedInvoices.length;
  const unmappedCount = totalCount - mappedCount;

  const totalTaxable = useMemo(() => filteredInvoices.reduce((s, inv) => { const d = deriveInvoiceFinancials(inv); return s + d.net_goods_taxable + d.taxable_charges_total; }, 0), [filteredInvoices]);
  const totalTax     = useMemo(() => filteredInvoices.reduce((s, inv) => { const d = deriveInvoiceFinancials(inv); return s + d.cgst + d.sgst + d.igst; }, 0), [filteredInvoices]);
  const grandTotal   = useMemo(() => filteredInvoices.reduce((s, inv) => { const d = deriveInvoiceFinancials(inv); return s + d.total; }, 0), [filteredInvoices]);

  const selectedPending   = useMemo(() => Array.from(selectedInvoices).filter((id) => !acceptedMap[id]).length,  [selectedInvoices, acceptedMap]);
  const selectedAccepted2 = useMemo(() => Array.from(selectedInvoices).filter((id) => !!acceptedMap[id]).length, [selectedInvoices, acceptedMap]);

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
            <StatCard label="Total Invoices"          value={totalCount.toLocaleString()}    color="gray"  onClick={() => setFilterStatus('all')}      active={filterStatus === 'all'} />
            <StatCard
              label="Accepted – Ready for Export"
              value={mappedCount.toLocaleString()}
              color="green"
              onClick={() => setFilterStatus('accepted')}
              active={filterStatus === 'accepted'}
              sub={mappedCount > 0 ? `${formatINR(mappedInvoices.reduce((s, i) => { const d = deriveInvoiceFinancials(i); return s + d.total; }, 0))} total` : undefined}
            />
            {unmappedCount > 0 && (
              <StatCard label="Pending Mapping" value={unmappedCount.toLocaleString()} color="amber" onClick={() => setFilterStatus('pending')} active={filterStatus === 'pending'} />
            )}
          </div>
        )}

        {/* Controls row */}
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <FYPeriodSelector value={fy} onChange={(v) => { setFy(v); setError(null); setExportMsg(null); }} />
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

        {/* Bulk action bar */}
        {!loading && totalCount > 0 && (
          <div className="flex items-center gap-3 mb-3 min-h-[32px]">
            {/* Select all checkbox */}
            {selectableIds.length > 0 && (
              <label className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-400 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={allPendingSelected}
                  onChange={toggleSelectAll}
                  className="w-3.5 h-3.5 rounded border-gray-300 dark:border-gray-600 text-indigo-600 focus:ring-indigo-500"
                />
                Select All Pending
              </label>
            )}

            {selectedPending > 0 && (
              <button
                onClick={handleBulkAcceptSelected}
                disabled={bulkSaving}
                className="px-3 py-1 text-xs bg-indigo-600 text-white font-medium rounded hover:bg-indigo-700 disabled:opacity-50 transition-colors"
              >
                {bulkSaving ? 'Accepting…' : `Accept ${selectedPending} invoice${selectedPending === 1 ? '' : 's'}`}
              </button>
            )}

            {selectedAccepted2 > 0 && (
              <button
                onClick={handleBulkUnmapSelected}
                disabled={bulkSaving}
                className="px-3 py-1 text-xs border border-red-300 dark:border-red-700 text-red-600 dark:text-red-400 font-medium rounded hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-50 transition-colors"
              >
                {bulkSaving ? 'Unmapping…' : `Unmap ${selectedAccepted2} invoice${selectedAccepted2 === 1 ? '' : 's'}`}
              </button>
            )}

            {selectedInvoices.size === 0 && unmappedCount > 0 && (
              <span className="text-xs text-gray-400 dark:text-gray-500">
                Select invoices to accept in bulk, or click a row to map manually.
              </span>
            )}
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
          <div className="rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
            {/* Table header */}
            <div className="grid grid-cols-[20px_32px_1fr_100px_60px_80px_120px_120px_120px_32px] items-center gap-2 px-4 py-2.5 bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 text-xs font-semibold text-gray-500 dark:text-gray-400">
              <span />
              <span />
              <span>Customer · Invoice #</span>
              <span className="text-center">Date</span>
              <span className="text-center">Type</span>
              <span className="text-center">Status</span>
              <span className="text-right">Taxable</span>
              <span className="text-right">Tax</span>
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
              const isSelected = selectedInvoices.has(inv.id);

              return (
                <React.Fragment key={inv.id}>
                  <div
                    className={[
                      'grid grid-cols-[20px_32px_1fr_100px_60px_80px_120px_120px_120px_32px]',
                      'items-center gap-2 px-4 py-2.5 border-b border-gray-100 dark:border-gray-800',
                      'cursor-pointer select-none transition-colors',
                      expanded ? 'bg-indigo-50/70 dark:bg-indigo-900/10' : '',
                      isMapped && !expanded ? 'bg-green-50/30 dark:bg-green-900/5' : '',
                      !isMapped && !expanded ? 'hover:bg-gray-50 dark:hover:bg-gray-800/50' : '',
                    ].join(' ')}
                    onClick={() => toggleExpand(inv.id)}
                  >
                    {/* Checkbox */}
                    <div onClick={(e) => { e.stopPropagation(); toggleSelect(inv.id); }}>
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleSelect(inv.id)}
                        className="w-3.5 h-3.5 rounded border-gray-300 dark:border-gray-600 text-indigo-600 focus:ring-indigo-500"
                      />
                    </div>

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
                        inv.tax_type === 'igst'      ? 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400' :
                        inv.tax_type === 'cgst_sgst' ? 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400' :
                        'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400'
                      }`}>
                        {inv.tax_type === 'igst' ? 'IGST' : inv.tax_type === 'cgst_sgst' ? 'C+S' : 'NIL'}
                      </span>
                    </div>

                    {/* Readiness badge */}
                    <div className="text-center">
                      {inv.readiness && inv.readiness !== 'ready'
                        ? <ReadinessBadge readiness={inv.readiness} flags={inv.readiness_flags as string[] | null} />
                        : <span className="text-xs text-green-600 dark:text-green-400">✓</span>
                      }
                    </div>

                    {/* Taxable */}
                    <div className="text-xs text-right text-gray-900 dark:text-gray-100 tabular-nums">
                      {formatINR(d.net_goods_taxable + d.taxable_charges_total)}
                    </div>

                    {/* Tax */}
                    <div className="text-xs text-right text-gray-500 dark:text-gray-400 tabular-nums">
                      {hasTax ? formatINR(d.cgst + d.sgst + d.igst) : '—'}
                    </div>

                    {/* Sales ledger badge or pending indicator */}
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

                    {/* Edit + expand */}
                    <div className="flex items-center justify-center gap-1">
                      <button
                        onClick={(e) => { e.stopPropagation(); setEditingInvoice(inv); }}
                        title="Edit invoice"
                        className="p-1 rounded hover:bg-indigo-100 dark:hover:bg-indigo-900/30 text-indigo-400 hover:text-indigo-600 dark:hover:text-indigo-300 transition-colors"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536M9 11l6.5-6.5a2 2 0 012.828 2.828L11.828 13.83A4 4 0 019.172 15H8v-1.172A4 4 0 019 11z" />
                        </svg>
                      </button>
                      <span className="text-gray-400 text-xs">{expanded ? '▲' : '▼'}</span>
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
                      pendingSalesLedgers={pendingSalesLedgers}
                      companyId={company!.id}
                      companyState={companyState}
                      initialAcc={acc ?? null}
                      onSave={handleSave}
                      onUnmapRequest={() => handleUnmap(inv.id)}
                    />
                  )}
                </React.Fragment>
              );
            })}

            {/* Footer totals */}
            {filteredInvoices.length > 0 && (
              <div className="grid grid-cols-[20px_32px_1fr_100px_60px_80px_120px_120px_120px_32px] items-center gap-2 px-4 py-2.5 bg-gray-50 dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700 text-xs font-semibold text-gray-700 dark:text-gray-300">
                <div /><div />
                <div>Total ({filteredInvoices.length.toLocaleString()} invoices)</div>
                <div className="col-span-3" />
                <div className="text-right tabular-nums">{formatINR(totalTaxable)}</div>
                <div className="text-right tabular-nums">{formatINR(totalTax)}</div>
                <div className="col-span-2" />
              </div>
            )}
          </div>
        )}
      </div>

      {editingInvoice && (
        <InvoiceEditPanel
          invoice={editingInvoice}
          perspective="sales"
          onClose={() => setEditingInvoice(null)}
          onSave={async (data: InvoiceEditData) => {
            const { deriveInvoiceFinancials: derive } = await import('@/lib/invoiceCalculations');
            const { computeSalesReadiness } = await import('@/lib/salesDb');
            const { updateAcceptedInvoice } = await import('@/lib/db');
            const d = derive(data);
            const r = computeSalesReadiness({ ...editingInvoice, ...data } as import('@/types/invoice').ExtractedInvoice);
            const patch = {
              invoice_number:       data.invoice_number ?? undefined,
              invoice_date:         data.invoice_date ?? null,
              vendor_name:          data.vendor_name ?? undefined,
              vendor_gstin:         data.vendor_gstin ?? null,
              buyer_name:           data.buyer_name ?? null,
              buyer_gstin:          data.buyer_gstin ?? null,
              tax_type:             data.tax_type,
              bill_discount_amount: data.bill_discount_amount ?? 0,
              round_off:            d.round_off,
              cgst:                 d.cgst,
              sgst:                 d.sgst,
              igst:                 d.igst,
              total:                d.total,
              line_items:           data.line_items,
              charges:              data.charges,
              readiness:            r.readiness,
              readiness_flags:      r.flags,
            };
            await updateAcceptedInvoice(editingInvoice!.id, patch);
            const updated: StoredInvoice = { ...editingInvoice!, ...patch } as StoredInvoice;
            setInvoices((prev) => prev.map((i) => i.id === updated.id ? updated : i));
            setEditingInvoice(null);
          }}
        />
      )}
    </AppLayout>
  );
}
