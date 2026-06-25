'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { getCompany, updateCompany } from '@/lib/db';
import { getSalesRegister, saveSalesTallyAcceptance } from '@/lib/salesDb';
import { loadCustomers, addCustomer } from '@/lib/customers';
import { loadSuppliers } from '@/lib/suppliers';
import { loadDutiesTaxes, addDutiesTaxes } from '@/lib/dutiesTaxes';
import { loadStockItems, addStockItem } from '@/lib/stockItems';
import { loadExpenseLedgers, addExpenseLedger, type ExpenseLedgerMaster } from '@/lib/expenseLedgers';
import { loadSalesLedgers, addSalesLedger, getBatchHistoricalSalesLedgers, getCompanyWideMostUsedSalesLedger } from '@/lib/salesLedgerConfig';
import { generateSalesVouchers, generateSalesMastersXml, buildSalesPreview, type SalesMasterType } from '@/lib/salesXmlGenerator';
import { findExpenseLedger } from '@/lib/xmlGenerator';
import { deriveInvoiceFinancials } from '@/lib/invoiceCalculations';
import type { StoredInvoice } from '@/types/invoice';
import { calcLineAmount } from '@/types/invoice';
import AppLayout from '@/components/AppLayout';
import { currentFY } from '@/lib/fyPeriod';
import { useCompany } from '@/lib/companyContext';
import FYPeriodSelector from '@/components/FYPeriodSelector';
import { normalizeUom } from '@/lib/uomRegistry';
import type { CustomerMaster } from '@/lib/customers';
import type { SupplierMaster } from '@/lib/suppliers';
import type { DutiesTaxesMaster } from '@/lib/dutiesTaxes';
import type { StockItemMaster } from '@/lib/stockItems';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isBlank(v?: string | null): boolean {
  return !v || v.trim().length === 0 || v === '-';
}

function getErrMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'object' && e !== null && 'message' in e) return String((e as { message: unknown }).message);
  return 'Unknown error';
}

const normalizeUomDisplay = (raw: string | null | undefined): string =>
  normalizeUom(raw).canonical;

// ─── Types ────────────────────────────────────────────────────────────────────

interface SalesAcceptPayload {
  invoiceNo: string;
  invoiceId: string;
  customerName: string;
  customerGstin: string;
  customerLedger: string;
  salesLedger: string;
  stockItems: Array<{ desc: string; hsn: string; uom: string; gst_percent?: number; tallyName: string }>;
  charges: Array<{ keyword: string; tallyName: string }>;
  cgstLedger: string;
  sgstLedger: string;
  igstLedger: string;
  roLedger: string;
  taxType: 'cgst_sgst' | 'igst' | 'none';
  lockedStock: Record<string, string>;
}

interface LockedSalesInvoice {
  customerLedger: string;
  salesLedger: string;
  cgstLedger: string;
  sgstLedger: string;
  igstLedger: string;
  roLedger: string;
  stock: Record<string, string>;
  charges: Record<string, string>;
}

// ─── LedgerWarning ────────────────────────────────────────────────────────────

interface LedgerWarning {
  reason: string;
  meaning: string;
  action: string;
}

function InfoIcon({ warning }: { warning: LedgerWarning }) {
  const tip = `Reason: ${warning.reason}\n\nMeaning: ${warning.meaning}\n\nAction Required: ${warning.action}`;
  return (
    <span
      className="shrink-0 text-amber-500 dark:text-amber-400 cursor-help text-sm select-none"
      title={tip}
    >
      ⓘ
    </span>
  );
}

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

function CreatableLedgerDropdown({
  value, options, pendingOptions, suggested, warning,
  freetext, createLabel,
  onSelect, onStartCreate, onConfirmCreate, onCancelCreate,
}: {
  value: string;
  options: string[];
  pendingOptions: string[];
  suggested: boolean;
  warning?: LedgerWarning;
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
        {isGhost && (
          <option value={value}>{value}{suggested && !warning ? ' ✦' : ''}</option>
        )}
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
        {pendingOptions.map((o) => <option key={`p_${o}`} value={o}>{o} (new)</option>)}
        <option value="__new__">+ Create new…</option>
      </select>
      {warning && suggested && !isGhost && <InfoIcon warning={warning} />}
    </div>
  );
}

// ─── SalesFlatDisplayRow ──────────────────────────────────────────────────────

interface SalesFlatDisplayRow {
  invoiceDate: string;
  invoiceNo: string;
  invoiceId: string;
  buyerName: string;
  gstin: string;
  taxType: 'cgst_sgst' | 'igst' | 'none';
  customerLedger: string;
  customerSuggested: boolean;
  salesLedger: string;
  salesLedgerSuggested: boolean;
  salesLedgerCase: 1 | 2 | 3 | 4;
  cgstLedger: string; cgstSuggested: boolean;
  sgstLedger: string; sgstSuggested: boolean;
  igstLedger: string; igstSuggested: boolean;
  itemDesc: string;
  lineIdx: number;
  hsn: string;
  stockItem: string;
  stockItemSuggested: boolean;
  taxRate: number | null;
  qty: number | null;
  uom: string;
  rate: number | null;
  disc: number | null;
  amount: number;
  cgstAmt: number;
  sgstAmt: number;
  igstAmt: number;
  isFirst: boolean;
  charges: Array<{ desc: string; ledger: string; suggested: boolean; amount: number }>;
  roLedger: string; roSuggested: boolean; roAmt: number;
}

// ─── SalesFlatTable ───────────────────────────────────────────────────────────

function SalesFlatTable({
  invoices, customers, suppliers, dutiesTaxes, stockItems, stockItemMode,
  salesLedgerMasters, historicalSalesLedgers, companyWideSalesLedger,
  initialLockedInvoices, companyId, voucherMode, expenseLedgers,
  onAcceptInvoices, onDownloadExcel,
}: {
  invoices: StoredInvoice[];
  customers: CustomerMaster[];
  suppliers: SupplierMaster[];
  dutiesTaxes: DutiesTaxesMaster[];
  stockItems: StockItemMaster[];
  stockItemMode?: 'hsn_driven' | null;
  salesLedgerMasters: string[];
  historicalSalesLedgers: Record<string, string>;
  companyWideSalesLedger: string | null;
  initialLockedInvoices: Record<string, LockedSalesInvoice>;
  companyId: string;
  voucherMode: 'accounting_only' | 'inventory';
  expenseLedgers: ExpenseLedgerMaster[];
  onAcceptInvoices: (payloads: SalesAcceptPayload[]) => Promise<void>;
  onDownloadExcel: () => void;
}) {
  const isInventoryMode = voucherMode === 'inventory';

  const [customerEdits, setCustomerEdits] = React.useState<Record<string, string>>({});
  const [salesLedgerEdits, setSalesLedgerEdits] = React.useState<Record<string, string>>({});
  const [stockItemEdits, setStockItemEdits] = React.useState<Record<string, string>>({});
  const [chargeEdits, setChargeEdits] = React.useState<Record<string, string>>({});
  const [chargeFreetext, setChargeFreetext] = React.useState<Record<string, boolean>>({});
  const [taxLedgerEdits, setTaxLedgerEdits] = React.useState<{ cgst?: string; sgst?: string; igst?: string }>({});
  const [roLedgerEdits, setRoLedgerEdits] = React.useState<Record<string, string>>({});
  const [pendingSalesLedgers, setPendingSalesLedgers] = React.useState<string[]>([]);
  const [salesLedgerCreating, setSalesLedgerCreating] = React.useState<Record<string, boolean>>({});
  const [customerFreetext, setCustomerFreetext] = React.useState<Record<string, boolean>>({});
  const [pendingCustomers, setPendingCustomers] = React.useState<string[]>([]);
  const [stockItemFreetext, setStockItemFreetext] = React.useState<Record<string, boolean>>({});
  const [pendingStockItems, setPendingStockItems] = React.useState<string[]>([]);
  const [cgstFreetext, setCgstFreetext] = React.useState<Record<string, boolean>>({});
  const [sgstFreetext, setSgstFreetext] = React.useState<Record<string, boolean>>({});
  const [igstFreetext, setIgstFreetext] = React.useState<Record<string, boolean>>({});
  const [pendingCgst, setPendingCgst] = React.useState<string[]>([]);
  const [pendingSgst, setPendingSgst] = React.useState<string[]>([]);
  const [pendingIgst, setPendingIgst] = React.useState<string[]>([]);
  const [roFreetext, setRoFreetext] = React.useState<Record<string, boolean>>({});
  const [pendingRo, setPendingRo] = React.useState<string[]>([]);

  const [cardFilter, setCardFilter] = React.useState<'accepted' | 'pending_review' | null>(null);
  const [statusFilter, setStatusFilter] = React.useState<'all' | 'accepted' | 'pending_review'>('all');
  const [customerFilter, setCustomerFilter] = React.useState('');
  const [invoiceFilter, setInvoiceFilter] = React.useState('');
  const [gstinFilter, setGstinFilter] = React.useState('');
  const [mappingFilter, setMappingFilter] = React.useState<'all' | 'ai_suggested_new'>('all');

  const [selectedRows, setSelectedRows] = React.useState<Set<string>>(new Set());
  const [selectedLockedInvoices, setSelectedLockedInvoices] = React.useState<Set<string>>(new Set());
  const [bulkSaving, setBulkSaving] = React.useState(false);

  const [lockedInvoices, setLockedInvoices] = React.useState<Record<string, LockedSalesInvoice>>(initialLockedInvoices);

  const [stockConfirm, setStockConfirm] = React.useState<{
    invoiceNo: string; itemDesc: string; lineIdx: number; hsn: string; gstPct: number | null; chosenName: string;
  } | null>(null);
  const [visibleInvoiceCount, setVisibleInvoiceCount] = React.useState(100);

  // ── Build invoice index + display rows (memoized — avoids recompute on every render) ──
  const { invoiceOrder, byInvoice, displayRows } = React.useMemo(() => {
  const invoiceOrder: string[] = [];
  const byInvoice = new Map<string, StoredInvoice>();
  for (const inv of invoices) {
    if (!byInvoice.has(inv.invoice_number)) {
      invoiceOrder.push(inv.invoice_number);
      byInvoice.set(inv.invoice_number, inv);
    }
  }

  // ── Helper: resolve customer ledger ──
  function resolveCustomerLedger(inv: StoredInvoice): { ledger: string; suggested: boolean } {
    const gstin = inv.buyer_gstin;
    const name = inv.buyer_name ?? '';
    if (gstin) {
      const g = gstin.toLowerCase().trim();
      const byGstin = customers.find((c) => (c.customer_gstin ?? '').toLowerCase().trim() === g);
      if (byGstin) return { ledger: byGstin.tally_ledger_name, suggested: false };
    }
    const n = name.toLowerCase().trim();
    const byName = customers.find(
      (c) => c.customer_name.toLowerCase().trim() === n || c.tally_ledger_name.toLowerCase().trim() === n
    );
    if (byName) return { ledger: byName.tally_ledger_name, suggested: false };
    if (gstin) {
      const g = gstin.toLowerCase().trim();
      const supByGstin = suppliers.find((s) => (s.vendor_gstin ?? '').toLowerCase().trim() === g);
      if (supByGstin) return { ledger: supByGstin.tally_ledger_name, suggested: true };
    }
    const supByName = suppliers.find((s) => s.vendor_name.toLowerCase().trim() === n);
    if (supByName) return { ledger: supByName.tally_ledger_name, suggested: true };
    return { ledger: name, suggested: true };
  }

  // ── Helper: output tax ledger ──
  function findOutputTaxLedger(component: string): string {
    const comp = component.toUpperCase();
    const consolidated = dutiesTaxes.filter((d) => d.tax_component === comp && d.tax_rate == null);
    if (consolidated.length === 0) return '';
    const output = consolidated.find((d) => d.tally_ledger_name.toLowerCase().startsWith('output'));
    return (output ?? consolidated[0]).tally_ledger_name;
  }

  // ── Build display rows ──
  const displayRows: SalesFlatDisplayRow[] = [];

  for (const invNo of invoiceOrder) {
    const inv = byInvoice.get(invNo)!;
    const { ledger: customerLedger, suggested: customerSuggested } = resolveCustomerLedger(inv);
    const lockedInv = lockedInvoices[invNo];

    // Sales ledger 4-case hierarchy
    let salesLedger: string;
    let salesLedgerCase: 1 | 2 | 3 | 4;
    if (lockedInv) {
      salesLedger = lockedInv.salesLedger;
      salesLedgerCase = 1;
    } else {
      const buyerKey = inv.buyer_gstin
        ? inv.buyer_gstin
        : `name:${(inv.buyer_name ?? '').toLowerCase().trim()}`;
      const historical = historicalSalesLedgers[buyerKey];
      const validHistorical = historical && salesLedgerMasters.includes(historical) ? historical : null;
      if (validHistorical) {
        salesLedger = validHistorical;
        salesLedgerCase = 2;
      } else if (salesLedgerMasters.length === 0) {
        salesLedger = 'Sales';
        salesLedgerCase = 1;
      } else if (companyWideSalesLedger) {
        salesLedger = companyWideSalesLedger;
        salesLedgerCase = 3;
      } else {
        salesLedger = salesLedgerMasters[0];
        salesLedgerCase = 4;
      }
    }
    const salesLedgerSuggested = !lockedInv;

    const invTaxType = (inv.tax_type ?? 'none') as 'cgst_sgst' | 'igst' | 'none';
    const cgstLedger = lockedInv?.cgstLedger ?? findOutputTaxLedger('CGST');
    const sgstLedger = lockedInv?.sgstLedger ?? findOutputTaxLedger('SGST');
    const igstLedger = lockedInv?.igstLedger ?? findOutputTaxLedger('IGST');
    const cgstSuggested = !lockedInv;
    const sgstSuggested = !lockedInv;
    const igstSuggested = !lockedInv;

    const invFinancials = deriveInvoiceFinancials(inv as Parameters<typeof deriveInvoiceFinancials>[0]);
    const cgstAmt = invFinancials.cgst;
    const sgstAmt = invFinancials.sgst;
    const igstAmt = invFinancials.igst;
    const roAmt = invFinancials.round_off;
    const defaultRoLedger = findExpenseLedger(expenseLedgers, 'Round Off') ?? findExpenseLedger(expenseLedgers, 'Rounding Off') ?? '';
    const roLedger = lockedInv?.roLedger ?? defaultRoLedger;
    const roSuggested = !lockedInv && !!defaultRoLedger;

    const charges: SalesFlatDisplayRow['charges'] = (inv.charges ?? []).map((ch) => {
      const keyword = ch.description ?? '';
      const ledger = lockedInv?.charges?.[keyword] ?? '';
      return { desc: keyword, ledger, suggested: !lockedInv, amount: ch.amount ?? 0 };
    });

    const invoiceTail = { charges, roLedger, roSuggested, roAmt };
    const emptyTail = { charges: [], roLedger: '', roSuggested: false, roAmt: 0 };

    const base = {
      invoiceDate: inv.invoice_date ?? '',
      invoiceNo: invNo,
      invoiceId: inv.id,
      buyerName: inv.buyer_name ?? '',
      gstin: inv.buyer_gstin ?? '',
      taxType: invTaxType,
      customerLedger, customerSuggested,
      salesLedger, salesLedgerSuggested, salesLedgerCase,
      cgstLedger, cgstSuggested,
      sgstLedger, sgstSuggested,
      igstLedger, igstSuggested,
    };

    const lineItems = inv.line_items ?? [];

    if (lineItems.length === 0) {
      displayRows.push({
        ...base, isFirst: true, ...invoiceTail,
        itemDesc: '', lineIdx: 0, hsn: '', stockItem: '', stockItemSuggested: false,
        taxRate: null, qty: null, uom: '', rate: null, disc: null,
        amount: Math.abs(invFinancials.total),
        cgstAmt, sgstAmt, igstAmt,
      });
      continue;
    }

    lineItems.forEach((item, idx) => {
      const desc = item.description ?? '';
      let stockItemName = '';
      let stockItemSuggested = false;

      if (isInventoryMode) {
        const lockedStockName = lockedInv?.stock?.[desc];
        if (lockedStockName) {
          stockItemName = lockedStockName;
          stockItemSuggested = false;
        } else if (stockItemMode === 'hsn_driven' && item.hsn) {
          const cleanHsn = item.hsn.replace(/[\s.]/g, '');
          const match = stockItems.find(
            (s) => s.hsn_code && s.hsn_code.replace(/[\s.]/g, '') === cleanHsn && s.gst_percent === item.gst_percent,
          ) ?? stockItems.find(
            (s) => s.hsn_code && s.hsn_code.replace(/[\s.]/g, '') === cleanHsn,
          );
          if (match) { stockItemName = match.tally_item_name; stockItemSuggested = false; }
          else { stockItemName = item.hsn ? `${item.hsn} @ ${item.gst_percent ?? 0}%` : desc; stockItemSuggested = true; }
        } else {
          const n = desc.toLowerCase().trim();
          const byAlias = stockItems.find((s) => s.alias_name && s.alias_name.toLowerCase().trim() === n);
          const byName = stockItems.find((s) => s.tally_item_name.toLowerCase().trim() === n);
          const match = byAlias ?? byName;
          if (match) { stockItemName = match.tally_item_name; stockItemSuggested = false; }
          else { stockItemName = item.hsn ? `${item.hsn} @ ${item.gst_percent ?? 0}%` : desc; stockItemSuggested = true; }
        }
      }

      displayRows.push({
        ...base,
        isFirst: idx === 0,
        ...(idx === 0 ? invoiceTail : emptyTail),
        itemDesc: desc,
        lineIdx: idx,
        hsn: item.hsn ?? '',
        stockItem: stockItemName,
        stockItemSuggested,
        taxRate: item.gst_percent ?? null,
        qty: item.qty ?? null,
        uom: normalizeUomDisplay(item.uom),
        rate: item.rate ?? null,
        disc: (item.disc_percent ?? 0) > 0 ? item.disc_percent : null,
        amount: calcLineAmount(item),
        cgstAmt: idx === 0 ? cgstAmt : 0,
        sgstAmt: idx === 0 ? sgstAmt : 0,
        igstAmt: idx === 0 ? igstAmt : 0,
      });
    });
  }

  return { invoiceOrder, byInvoice, displayRows };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoices, lockedInvoices, customers, suppliers, dutiesTaxes, stockItems, stockItemMode,
      salesLedgerMasters, historicalSalesLedgers, companyWideSalesLedger, voucherMode, expenseLedgers]);

  const maxCharges = Math.max(0, ...displayRows.map((r) => r.charges.length));

  // ── Filter ──
  const filteredInvoiceNos = React.useMemo(() => {
    const effectiveStatus = cardFilter ?? statusFilter;
    return new Set(invoiceOrder.filter((invNo) => {
      const inv = byInvoice.get(invNo);
      const isAccepted = !!lockedInvoices[invNo];
      if (effectiveStatus === 'accepted' && !isAccepted) return false;
      if (effectiveStatus === 'pending_review' && isAccepted) return false;
      if (customerFilter && !(inv?.buyer_name ?? '').toLowerCase().includes(customerFilter.toLowerCase())) return false;
      if (invoiceFilter && !invNo.toLowerCase().includes(invoiceFilter.toLowerCase())) return false;
      if (gstinFilter && !(inv?.buyer_gstin ?? '').toLowerCase().includes(gstinFilter.toLowerCase())) return false;
      if (mappingFilter === 'ai_suggested_new') {
        const row = displayRows.find((r) => r.invoiceNo === invNo && r.isFirst);
        if (!row) return false;
        if (!row.customerSuggested && !row.salesLedgerSuggested) return false;
      }
      return true;
    }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardFilter, statusFilter, customerFilter, invoiceFilter, gstinFilter, mappingFilter, lockedInvoices]);

  // ── Select ──
  const suggestableInvoices: string[] = [];
  {
    const seen = new Set<string>();
    for (const row of displayRows) {
      if (!seen.has(row.invoiceNo)) {
        seen.add(row.invoiceNo);
        if (!lockedInvoices[row.invoiceNo]) suggestableInvoices.push(row.invoiceNo);
      }
    }
  }

  const allSelected = suggestableInvoices.length > 0 && suggestableInvoices.every((inv) => selectedRows.has(inv));
  const toggleAll = () => {
    if (allSelected) setSelectedRows(new Set());
    else setSelectedRows(new Set(suggestableInvoices));
  };
  const toggleInvoice = (invNo: string) => setSelectedRows((prev) => {
    const s = new Set(prev); s.has(invNo) ? s.delete(invNo) : s.add(invNo); return s;
  });
  const toggleLockedInvoice = (invNo: string) => setSelectedLockedInvoices((prev) => {
    const s = new Set(prev); s.has(invNo) ? s.delete(invNo) : s.add(invNo); return s;
  });

  // ── Bulk accept ──
  const handleBulkAccept = async () => {
    setBulkSaving(true);
    const payloads: SalesAcceptPayload[] = [];

    for (const invNo of Array.from(selectedRows)) {
      const invRows = displayRows.filter((r) => r.invoiceNo === invNo);
      const firstRow = invRows.find((r) => r.isFirst);
      if (!firstRow) continue;
      const inv = byInvoice.get(invNo);
      if (!inv) continue;

      const customerLedger = customerEdits[firstRow.buyerName] ?? firstRow.customerLedger;
      const salesLedger = salesLedgerEdits[invNo] ?? firstRow.salesLedger;
      const cgstLedger = taxLedgerEdits.cgst ?? firstRow.cgstLedger;
      const sgstLedger = taxLedgerEdits.sgst ?? firstRow.sgstLedger;
      const igstLedger = taxLedgerEdits.igst ?? firstRow.igstLedger;

      const stockItemsPayload: SalesAcceptPayload['stockItems'] = [];
      const lockedStock: Record<string, string> = {};
      if (isInventoryMode) {
        for (const r of invRows) {
          if (r.itemDesc) {
            const tallyName = stockItemEdits[`${invNo}_${r.lineIdx}`] ?? r.stockItem;
            if (tallyName) {
              stockItemsPayload.push({ desc: r.itemDesc, hsn: r.hsn, uom: r.uom, gst_percent: r.taxRate ?? undefined, tallyName });
              lockedStock[r.itemDesc] = tallyName;
            }
          }
        }
      }

      const charges: SalesAcceptPayload['charges'] = (firstRow.charges ?? []).map((ch) => ({
        keyword: ch.desc,
        tallyName: chargeEdits[ch.desc] ?? ch.ledger,
      }));

      const roLedger = roLedgerEdits[invNo] ?? firstRow.roLedger;

      payloads.push({
        invoiceNo: invNo,
        invoiceId: inv.id,
        customerName: firstRow.buyerName,
        customerGstin: firstRow.gstin,
        customerLedger,
        salesLedger,
        stockItems: stockItemsPayload,
        charges,
        cgstLedger, sgstLedger, igstLedger,
        roLedger,
        taxType: firstRow.taxType,
        lockedStock,
      });
    }

    // Validate
    const validationErrors: string[] = [];
    for (const p of payloads) {
      const errs: string[] = [];
      if (isBlank(p.customerLedger)) errs.push('Customer Ledger is empty');
      if (isBlank(p.salesLedger)) errs.push('Sales Ledger is empty');
      if (p.taxType === 'cgst_sgst') {
        if (isBlank(p.cgstLedger)) errs.push('CGST Ledger is empty');
        if (isBlank(p.sgstLedger)) errs.push('SGST Ledger is empty');
      }
      if (p.taxType === 'igst') {
        if (isBlank(p.igstLedger)) errs.push('IGST Ledger is empty');
      }
      const firstRow = displayRows.find((r) => r.invoiceNo === p.invoiceNo && r.isFirst);
      if (firstRow && Math.abs(firstRow.roAmt) > 0.001 && isBlank(p.roLedger)) {
        errs.push('Round Off Ledger is empty');
      }
      if (isInventoryMode) {
        for (const si of p.stockItems) {
          if (isBlank(si.tallyName)) errs.push(`Stock Item "${si.desc}" is empty`);
        }
      }
      if (errs.length) validationErrors.push(`Invoice ${p.invoiceNo}:\n• ${errs.join('\n• ')}`);
    }
    if (validationErrors.length) {
      alert(validationErrors.join('\n\n'));
      setBulkSaving(false);
      return;
    }

    try {
      await onAcceptInvoices(payloads);
      setLockedInvoices((prev) => {
        const next = { ...prev };
        for (const p of payloads) {
          const chargesLocked: Record<string, string> = {};
          p.charges.forEach((ch) => { chargesLocked[ch.keyword] = ch.tallyName; });
          next[p.invoiceNo] = {
            customerLedger: p.customerLedger,
            salesLedger: p.salesLedger,
            cgstLedger: p.cgstLedger,
            sgstLedger: p.sgstLedger,
            igstLedger: p.igstLedger,
            roLedger: p.roLedger,
            stock: p.lockedStock,
            charges: chargesLocked,
          };
        }
        return next;
      });
      setSelectedRows(new Set());
    } finally {
      setBulkSaving(false);
    }
  };

  // ── Bulk unaccept ──
  const handleBulkUnaccept = async () => {
    if (selectedLockedInvoices.size === 0) return;
    setBulkSaving(true);
    const errs: string[] = [];
    for (const invNo of Array.from(selectedLockedInvoices)) {
      const inv = byInvoice.get(invNo);
      if (!inv) continue;
      try {
        await saveSalesTallyAcceptance(companyId, inv.id, null);
      } catch (e) { errs.push(`${invNo}: ${e instanceof Error ? e.message : String(e)}`); }
    }
    setLockedInvoices((prev) => {
      const next = { ...prev };
      selectedLockedInvoices.forEach((invNo) => delete next[invNo]);
      return next;
    });
    setSelectedLockedInvoices(new Set());
    setBulkSaving(false);
    if (errs.length) alert(`Some failed:\n${errs.join('\n')}`);
  };

  // ── Dual scroll ──
  const tableContainerRef = React.useRef<HTMLDivElement>(null);
  const topScrollRef = React.useRef<HTMLDivElement>(null);
  const [tableScrollWidth, setTableScrollWidth] = React.useState(0);
  React.useEffect(() => {
    const el = tableContainerRef.current;
    if (!el) return;
    const update = () => setTableScrollWidth(el.scrollWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [displayRows]);
  const onTableScroll = () => {
    if (topScrollRef.current && tableContainerRef.current)
      topScrollRef.current.scrollLeft = tableContainerRef.current.scrollLeft;
  };
  const onTopScroll = () => {
    if (tableContainerRef.current && topScrollRef.current)
      tableContainerRef.current.scrollLeft = topScrollRef.current.scrollLeft;
  };

  // ── Dashboard counts ──
  const dashTotalCount = invoiceOrder.length;
  const dashAcceptedCount = Object.keys(lockedInvoices).length;
  const dashPendingCount = invoiceOrder.filter((invNo) => !lockedInvoices[invNo]).length;

  const TH = ({ children, right }: { children: React.ReactNode; right?: boolean }) => (
    <th className={`px-3 py-2.5 border-b border-gray-200 dark:border-gray-700 font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide whitespace-nowrap text-[11px] bg-gray-50 dark:bg-gray-800 ${right ? 'text-right' : 'text-left'}`}>
      {children}
    </th>
  );

  return (
    <div className="space-y-3">
      {/* Dashboard cards */}
      <div className="flex flex-wrap items-start gap-3">
        <button
          onClick={() => { setCardFilter(null); setStatusFilter('all'); }}
          className={`flex flex-col items-start px-4 py-3 rounded-xl border transition-colors text-left ${cardFilter === null && statusFilter === 'all' ? 'bg-gray-100 dark:bg-gray-700 border-gray-400 dark:border-gray-500' : 'bg-gray-50 dark:bg-gray-900/40 border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-700'}`}
        >
          <span className="text-xl font-bold text-gray-900 dark:text-gray-100">{dashTotalCount}</span>
          <span className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">Total Invoices</span>
        </button>
        <button
          onClick={() => setCardFilter((p) => p === 'accepted' ? null : 'accepted')}
          className={`flex flex-col items-start px-4 py-3 rounded-xl border transition-colors text-left ${cardFilter === 'accepted' ? 'bg-green-100 dark:bg-green-900/40 border-green-400 dark:border-green-600' : 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800 hover:bg-green-100 dark:hover:bg-green-900/30'}`}
        >
          <span className="text-xl font-bold text-green-800 dark:text-green-400">{dashAcceptedCount}</span>
          <span className="text-xs text-green-700 dark:text-green-500 mt-0.5">Accepted – Ready for Export</span>
        </button>
        {dashPendingCount > 0 && (
          <button
            onClick={() => setCardFilter((p) => p === 'pending_review' ? null : 'pending_review')}
            className={`flex flex-col items-start px-4 py-3 rounded-xl border transition-colors text-left ${cardFilter === 'pending_review' ? 'bg-amber-100 dark:bg-amber-900/40 border-amber-400 dark:border-amber-600' : 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-700 hover:bg-amber-100 dark:hover:bg-amber-900/30'}`}
          >
            <span className="text-xl font-bold text-amber-800 dark:text-amber-300">{dashPendingCount}</span>
            <span className="text-xs text-amber-700 dark:text-amber-500 mt-0.5">Pending Mapping Reviews</span>
          </button>
        )}
        <button
          onClick={onDownloadExcel}
          className="flex items-center gap-2 px-4 py-2 border border-gray-200 dark:border-gray-700 rounded-lg text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors self-start"
        >
          <svg className="w-4 h-4 text-green-600 dark:text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
          Download as Excel
        </button>
      </div>

      {cardFilter && (
        <div className="flex items-center gap-2 px-3 py-1.5 bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-200 dark:border-indigo-700 rounded-lg text-sm w-fit">
          <span className="text-indigo-700 dark:text-indigo-300 font-medium">
            Filter: {cardFilter === 'accepted' ? 'Accepted – Ready for Export' : 'Pending Mapping Reviews'}
          </span>
          <button onClick={() => setCardFilter(null)} className="text-indigo-400 hover:text-indigo-600 dark:hover:text-indigo-200 ml-1 font-bold leading-none">×</button>
        </div>
      )}

      <div className="rounded-lg border border-gray-200 dark:border-gray-700 shadow-sm">
        {/* Action bar */}
        {(suggestableInvoices.length > 0 || selectedLockedInvoices.size > 0) && (
          <div className="flex items-center gap-3 px-4 py-2.5 bg-amber-50 dark:bg-amber-900/20 border-b border-amber-200 dark:border-amber-700 flex-wrap">
            <label className="flex items-center gap-2 text-xs font-medium text-gray-700 dark:text-gray-300 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={toggleAll}
                className="rounded border-gray-300 dark:border-gray-600 text-indigo-600 focus:ring-indigo-500"
              />
              Select All
            </label>
            {selectedRows.size > 0 && (
              <button
                onClick={handleBulkAccept}
                disabled={bulkSaving}
                className="px-4 py-1.5 bg-indigo-600 text-white rounded-lg text-xs font-semibold hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {bulkSaving ? 'Saving…' : `Accept ${selectedRows.size} invoice${selectedRows.size !== 1 ? 's' : ''}`}
              </button>
            )}
            {selectedLockedInvoices.size > 0 && (
              <button
                onClick={handleBulkUnaccept}
                disabled={bulkSaving}
                className="px-4 py-1.5 border border-red-300 dark:border-red-800 text-red-600 dark:text-red-400 rounded-lg text-xs font-semibold hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {bulkSaving ? 'Saving…' : `Unaccept ${selectedLockedInvoices.size} invoice${selectedLockedInvoices.size !== 1 ? 's' : ''}`}
              </button>
            )}
            {selectedRows.size === 0 && selectedLockedInvoices.size === 0 && (
              <span className="text-xs text-amber-700 dark:text-amber-400">
                ✦ Amber fields are AI suggestions — edit if needed, then accept to save to masters
              </span>
            )}
          </div>
        )}

        {/* Filter bar */}
        <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 border-b border-gray-200 dark:border-gray-700 bg-gray-50/60 dark:bg-gray-800/60">
          <div className="flex rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden text-xs">
            {(['all', 'accepted', 'pending_review'] as const).map((s) => {
              const isActive = cardFilter === null ? statusFilter === s
                : (s === 'accepted' && cardFilter === 'accepted') || (s === 'pending_review' && cardFilter === 'pending_review');
              return (
                <button
                  key={s}
                  onClick={() => { setStatusFilter(s); setCardFilter(null); }}
                  className={`px-3 py-1.5 font-medium transition-colors ${isActive ? 'bg-indigo-600 text-white' : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'}`}
                >
                  {s === 'all' ? 'All' : s === 'accepted' ? 'Accepted' : 'Pending Review'}
                </button>
              );
            })}
          </div>
          <select
            value={customerFilter}
            onChange={(e) => setCustomerFilter(e.target.value)}
            className="border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1.5 text-xs bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 max-w-[180px]"
          >
            <option value="">All Customers</option>
            {Array.from(new Set(displayRows.map((r) => r.buyerName))).sort().map((v) => (
              <option key={v} value={v}>{v}</option>
            ))}
          </select>
          <input
            type="text"
            placeholder="Invoice No…"
            value={invoiceFilter}
            onChange={(e) => setInvoiceFilter(e.target.value)}
            className="border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1.5 text-xs bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 w-28"
          />
          <input
            type="text"
            placeholder="GSTIN…"
            value={gstinFilter}
            onChange={(e) => setGstinFilter(e.target.value)}
            className="border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1.5 text-xs bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 w-36"
          />
          <div className="flex rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden text-xs">
            {([['all', 'All'], ['ai_suggested_new', '✦ AI Suggested']] as const).map(([m, label]) => (
              <button
                key={m}
                onClick={() => setMappingFilter(m)}
                className={`px-3 py-1.5 font-medium transition-colors ${mappingFilter === m ? 'bg-amber-500 text-white' : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'}`}
              >
                {label}
              </button>
            ))}
          </div>
          {filteredInvoiceNos.size !== invoiceOrder.length && (
            <span className="text-xs text-gray-500 dark:text-gray-400">
              Showing {filteredInvoiceNos.size} of {invoiceOrder.length}
            </span>
          )}
          {(cardFilter || statusFilter !== 'all' || customerFilter || invoiceFilter || gstinFilter || mappingFilter !== 'all') && (
            <button
              onClick={() => { setCardFilter(null); setStatusFilter('all'); setCustomerFilter(''); setInvoiceFilter(''); setGstinFilter(''); setMappingFilter('all'); }}
              className="text-xs text-indigo-600 dark:text-indigo-400 hover:underline"
            >
              Clear all
            </button>
          )}
        </div>

        {/* Top scrollbar */}
        <div ref={topScrollRef} onScroll={onTopScroll} className="overflow-x-auto" style={{ height: 12 }}>
          <div style={{ width: tableScrollWidth, height: 1 }} />
        </div>

        {/* Table */}
        <div ref={tableContainerRef} onScroll={onTableScroll} className="overflow-x-auto max-h-[70vh] overflow-y-auto">
          <table className="min-w-max text-xs border-collapse">
            <thead className="bg-gray-50 dark:bg-gray-800 sticky top-0 z-10">
              <tr>
                <TH> </TH>
                <TH>Date</TH>
                <TH>Invoice No</TH>
                <TH>Voucher</TH>
                <TH>Customer (Invoice)</TH>
                <TH>Customer Ledger (Tally)</TH>
                <TH>GSTIN</TH>
                <TH>Sales Ledger (Tally)</TH>
                {isInventoryMode && <TH>Item (Invoice)</TH>}
                {isInventoryMode && <TH>Stock Item (Tally)</TH>}
                {isInventoryMode && <TH right>Tax Rate %</TH>}
                {isInventoryMode && <TH right>Qty</TH>}
                {isInventoryMode && <TH>UOM</TH>}
                {isInventoryMode && <TH right>Rate (₹)</TH>}
                {isInventoryMode && <TH right>Disc %</TH>}
                <TH right>Amount (₹)</TH>
                {Array.from({ length: maxCharges }, (_, ci) => (
                  <React.Fragment key={`ch${ci}`}>
                    <TH>Charge {ci + 1} (Invoice)</TH>
                    <TH>Charge {ci + 1} Ledger (Tally)</TH>
                    <TH right>Charge {ci + 1} Amt (₹)</TH>
                  </React.Fragment>
                ))}
                <TH>CGST Ledger (Tally)</TH>
                <TH right>CGST Amt (₹)</TH>
                <TH>SGST Ledger (Tally)</TH>
                <TH right>SGST Amt (₹)</TH>
                <TH>IGST Ledger (Tally)</TH>
                <TH right>IGST Amt (₹)</TH>
                <TH>Round Off Ledger (Tally)</TH>
                <TH right>Round Off Amt (₹)</TH>
              </tr>
            </thead>
            <tbody>
              {(() => {
                // Paginate: only render rows for the first N unique invoices that pass the filter.
                // This prevents the browser from building 1000+ DOM rows at once.
                const visibleInvoiceNos = new Set(
                  invoiceOrder
                    .filter((invNo) => filteredInvoiceNos.has(invNo))
                    .slice(0, visibleInvoiceCount)
                );
                return displayRows.map((row, i) => {
                if (!visibleInvoiceNos.has(row.invoiceNo)) return null;
                const prevRow = displayRows[i - 1];
                const isNewInvoice = !prevRow || prevRow.invoiceNo !== row.invoiceNo;
                const locked = lockedInvoices[row.invoiceNo];
                const isLocked = !!locked;
                const rowBg = isLocked
                  ? 'bg-green-50/30 dark:bg-green-900/20'
                  : isNewInvoice
                  ? 'bg-white dark:bg-gray-800'
                  : 'bg-blue-50/20 dark:bg-blue-900/20';
                const borderTop = isNewInvoice && i > 0
                  ? 'border-t-2 border-gray-300 dark:border-gray-600'
                  : 'border-t border-gray-100 dark:border-gray-700';
                const isChecked = selectedRows.has(row.invoiceNo);

                const effectiveCustomerLedger = locked?.customerLedger ?? (customerEdits[row.buyerName] ?? row.customerLedger);
                const effectiveSalesLedger = locked?.salesLedger ?? (salesLedgerEdits[row.invoiceNo] ?? row.salesLedger);
                const effectiveStockItem = locked?.stock?.[row.itemDesc] ?? (stockItemEdits[`${row.invoiceNo}_${row.lineIdx}`] ?? row.stockItem);
                const effectiveCgst = locked?.cgstLedger ?? (taxLedgerEdits.cgst ?? row.cgstLedger);
                const effectiveSgst = locked?.sgstLedger ?? (taxLedgerEdits.sgst ?? row.sgstLedger);
                const effectiveIgst = locked?.igstLedger ?? (taxLedgerEdits.igst ?? row.igstLedger);
                const effectiveRo = locked?.roLedger ?? (roLedgerEdits[row.invoiceNo] ?? row.roLedger);

                return (
                  <tr key={i} className={`${rowBg} ${borderTop} hover:bg-yellow-50/40 dark:hover:bg-gray-700/50 transition-colors`}>
                    {/* Checkbox */}
                    <td className="px-2 py-2 w-12 text-center">
                      {row.isFirst && isLocked && (
                        <label className="flex items-center justify-center gap-1 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={selectedLockedInvoices.has(row.invoiceNo)}
                            onChange={() => toggleLockedInvoice(row.invoiceNo)}
                            className="rounded border-gray-300 dark:border-gray-600 text-red-500 focus:ring-red-400"
                          />
                          <span title="Accepted" className="text-green-600 dark:text-green-400 text-sm font-bold leading-none">✓</span>
                        </label>
                      )}
                      {row.isFirst && !isLocked && (
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => toggleInvoice(row.invoiceNo)}
                          className="rounded border-gray-300 dark:border-gray-600 text-indigo-600 focus:ring-indigo-500"
                        />
                      )}
                    </td>
                    {/* Date */}
                    <td className="px-3 py-2 whitespace-nowrap font-mono text-gray-600 dark:text-gray-400">{row.invoiceDate}</td>
                    {/* Invoice No */}
                    <td className="px-3 py-2 whitespace-nowrap font-mono font-semibold text-gray-800 dark:text-gray-200">{row.invoiceNo}</td>
                    {/* Voucher Type */}
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span className="inline-block font-mono text-[11px] px-2 py-0.5 rounded bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300">Sales</span>
                    </td>
                    {/* Customer Name */}
                    <td className="px-3 py-2 max-w-[160px] truncate text-gray-700 dark:text-gray-300" title={row.buyerName}>{row.buyerName}</td>
                    {/* Customer Ledger */}
                    <td className="px-3 py-2 min-w-[180px]">
                      {isLocked ? (
                        <span className="font-mono font-medium text-purple-800 dark:text-purple-300">{effectiveCustomerLedger || '-'}</span>
                      ) : (
                        <CreatableLedgerDropdown
                          value={customerEdits[row.buyerName] ?? row.customerLedger}
                          options={customers.map((c) => c.tally_ledger_name)}
                          pendingOptions={pendingCustomers}
                          suggested={row.customerSuggested}
                          freetext={customerFreetext[`${row.invoiceNo}_${row.lineIdx}`] ?? false}
                          createLabel="New customer ledger name…"
                          onSelect={(v) => setCustomerEdits((p) => ({ ...p, [row.buyerName]: v }))}
                          onStartCreate={() => setCustomerFreetext((p) => ({ ...p, [`${row.invoiceNo}_${row.lineIdx}`]: true }))}
                          onConfirmCreate={(v) => {
                            setPendingCustomers((p) => p.includes(v) ? p : [...p, v]);
                            setCustomerEdits((p) => ({ ...p, [row.buyerName]: v }));
                            setCustomerFreetext((p) => ({ ...p, [`${row.invoiceNo}_${row.lineIdx}`]: false }));
                          }}
                          onCancelCreate={() => setCustomerFreetext((p) => ({ ...p, [`${row.invoiceNo}_${row.lineIdx}`]: false }))}
                        />
                      )}
                    </td>
                    {/* GSTIN */}
                    <td className="px-3 py-2 font-mono text-gray-400 dark:text-gray-500 whitespace-nowrap text-[11px]">{row.gstin || '-'}</td>
                    {/* Sales Ledger */}
                    <td className="px-3 py-2 min-w-[200px]">
                      {isLocked ? (
                        <span className="font-mono font-medium text-blue-800 dark:text-blue-300">{effectiveSalesLedger || '-'}</span>
                      ) : salesLedgerCreating[`${row.invoiceNo}_${row.lineIdx}`] ? (
                        <InlineCreateInput
                          placeholder="New sales ledger name…"
                          onConfirm={(v) => {
                            setPendingSalesLedgers((p) => p.includes(v) ? p : [...p, v]);
                            setSalesLedgerEdits((p) => ({ ...p, [row.invoiceNo]: v }));
                            setSalesLedgerCreating((p) => ({ ...p, [`${row.invoiceNo}_${row.lineIdx}`]: false }));
                          }}
                          onCancel={() => setSalesLedgerCreating((p) => ({ ...p, [`${row.invoiceNo}_${row.lineIdx}`]: false }))}
                        />
                      ) : (
                        <div className="flex items-center gap-1">
                          <select
                            value={salesLedgerEdits[row.invoiceNo] ?? row.salesLedger}
                            onChange={(e) => {
                              if (e.target.value === '__new__') {
                                setSalesLedgerCreating((p) => ({ ...p, [`${row.invoiceNo}_${row.lineIdx}`]: true }));
                                return;
                              }
                              if (!e.target.value) return;
                              setSalesLedgerEdits((p) => ({ ...p, [row.invoiceNo]: e.target.value }));
                            }}
                            className={`border rounded px-2 py-1 text-xs w-full dark:text-gray-100 ${
                              row.salesLedgerCase !== 2
                                ? 'border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20'
                                : 'border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700'
                            }`}
                          >
                            {(() => {
                              const cur = salesLedgerEdits[row.invoiceNo] ?? row.salesLedger;
                              const allOpts = [...salesLedgerMasters, ...pendingSalesLedgers];
                              if (cur && !allOpts.includes(cur)) {
                                return <option value={cur}>{cur}{row.salesLedgerCase !== 2 ? ' ✦' : ''}</option>;
                              }
                              return null;
                            })()}
                            {salesLedgerMasters.map((name) => <option key={name} value={name}>{name}</option>)}
                            {pendingSalesLedgers.map((name) => <option key={`pending_${name}`} value={name}>{name} (new)</option>)}
                            <option value="__new__">+ Create new…</option>
                          </select>
                          {(row.salesLedgerCase === 3 || row.salesLedgerCase === 4 || row.salesLedgerCase === 1) && (
                            <span
                              className="shrink-0 text-amber-500 dark:text-amber-400 cursor-help text-sm"
                              title={
                                row.salesLedgerCase === 1
                                  ? 'No sales ledgers configured yet. Using placeholder. Add a Sales Ledger in masters first.'
                                  : row.salesLedgerCase === 3
                                  ? 'Multiple Sales Ledgers are configured. Suggesting the most frequently used company-wide ledger. Please verify before accepting.'
                                  : 'Showing first-configured Sales Ledger. No prior invoices found for this customer. Please verify before accepting.'
                              }
                            >
                              ⓘ
                            </span>
                          )}
                        </div>
                      )}
                    </td>
                    {/* Inventory: Item */}
                    {isInventoryMode && (
                      <td className="px-3 py-2 max-w-[220px]">
                        <div className="truncate text-gray-800 dark:text-gray-200" title={row.itemDesc}>{row.itemDesc || '-'}</div>
                        {row.hsn && <div className="text-gray-400 dark:text-gray-500 font-mono text-[10px]">HSN: {row.hsn}</div>}
                      </td>
                    )}
                    {/* Inventory: Stock Item */}
                    {isInventoryMode && (
                      <td className="px-3 py-2 min-w-[180px]">
                        {isLocked ? (
                          <span className="font-mono text-indigo-700 dark:text-indigo-300">{effectiveStockItem || '-'}</span>
                        ) : (stockItems.length > 0 || pendingStockItems.length > 0) ? (
                          <CreatableLedgerDropdown
                            value={stockItemEdits[`${row.invoiceNo}_${row.lineIdx}`] ?? row.stockItem}
                            options={stockItems.map((s) => s.tally_item_name)}
                            pendingOptions={pendingStockItems}
                            suggested={row.stockItemSuggested}
                            freetext={stockItemFreetext[`${row.invoiceNo}_${row.lineIdx}`] ?? false}
                            createLabel="New Tally stock item name…"
                            onSelect={(v) => {
                              const expectedPattern = row.hsn
                                ? `${row.hsn} @ ${row.taxRate ?? 0}%`
                                : `${row.itemDesc} @ ${row.taxRate ?? 0}%`;
                              const isPatternMatch = v.trim() === expectedPattern.trim();
                              const otherSameInvoice = displayRows.some((r) =>
                                r.invoiceNo === row.invoiceNo && r.lineIdx !== row.lineIdx &&
                                r.itemDesc && r.stockItemSuggested && !stockItemEdits[`${r.invoiceNo}_${r.lineIdx}`]
                              );
                              const otherGlobal = displayRows.some((r) =>
                                !(r.invoiceNo === row.invoiceNo && r.lineIdx === row.lineIdx) &&
                                r.itemDesc && r.stockItemSuggested && !lockedInvoices[r.invoiceNo] &&
                                !stockItemEdits[`${r.invoiceNo}_${r.lineIdx}`]
                              );
                              if (isPatternMatch && (otherSameInvoice || otherGlobal)) {
                                setStockConfirm({ invoiceNo: row.invoiceNo, itemDesc: row.itemDesc, lineIdx: row.lineIdx, hsn: row.hsn, gstPct: row.taxRate, chosenName: v });
                              } else {
                                setStockItemEdits((p) => ({ ...p, [`${row.invoiceNo}_${row.lineIdx}`]: v }));
                              }
                            }}
                            onStartCreate={() => setStockItemFreetext((p) => ({ ...p, [`${row.invoiceNo}_${row.lineIdx}`]: true }))}
                            onConfirmCreate={(v) => {
                              setPendingStockItems((p) => p.includes(v) ? p : [...p, v]);
                              setStockItemFreetext((p) => ({ ...p, [`${row.invoiceNo}_${row.lineIdx}`]: false }));
                              setStockItemEdits((p) => ({ ...p, [`${row.invoiceNo}_${row.lineIdx}`]: v }));
                            }}
                            onCancelCreate={() => setStockItemFreetext((p) => ({ ...p, [`${row.invoiceNo}_${row.lineIdx}`]: false }))}
                          />
                        ) : (
                          <span className="font-mono text-indigo-700 dark:text-indigo-300">{row.stockItem || ''}</span>
                        )}
                      </td>
                    )}
                    {isInventoryMode && (
                      <td className="px-3 py-2 text-right text-gray-600 dark:text-gray-400">
                        {row.taxRate != null ? `${row.taxRate}%` : '-'}
                      </td>
                    )}
                    {isInventoryMode && (
                      <td className="px-3 py-2 text-right font-mono text-gray-700 dark:text-gray-300">
                        {row.qty != null ? row.qty : '-'}
                      </td>
                    )}
                    {isInventoryMode && (
                      <td className="px-3 py-2 text-gray-500 dark:text-gray-400">{row.uom || '-'}</td>
                    )}
                    {isInventoryMode && (
                      <td className="px-3 py-2 text-right font-mono text-gray-700 dark:text-gray-300">
                        {row.rate != null ? row.rate.toFixed(2) : '-'}
                      </td>
                    )}
                    {isInventoryMode && (
                      <td className="px-3 py-2 text-right text-gray-500 dark:text-gray-400">
                        {row.disc != null && row.disc > 0 ? `${row.disc}%` : '-'}
                      </td>
                    )}
                    {/* Amount */}
                    <td className="px-3 py-2 text-right font-mono font-semibold text-gray-900 dark:text-gray-100">
                      {row.amount.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </td>
                    {/* Charges */}
                    {Array.from({ length: maxCharges }, (_, ci) => {
                      const ch = row.isFirst ? row.charges[ci] : undefined;
                      return (
                        <React.Fragment key={`ch${ci}`}>
                          <td className="px-3 py-2 text-gray-600 dark:text-gray-400">{ch?.desc ?? ''}</td>
                          <td className="px-3 py-2 min-w-[160px]">
                            {ch && (
                              isLocked ? (
                                <span className="font-mono text-orange-700 dark:text-orange-300">
                                  {(locked?.charges?.[ch.desc] ?? ch.ledger) || '-'}
                                </span>
                              ) : chargeFreetext[`${row.invoiceNo}_${ci}`] ? (
                                <InlineCreateInput
                                  placeholder="New charge ledger name…"
                                  onConfirm={(v) => {
                                    setChargeEdits((p) => ({ ...p, [ch.desc]: v }));
                                    setChargeFreetext((p) => ({ ...p, [`${row.invoiceNo}_${ci}`]: false }));
                                  }}
                                  onCancel={() => setChargeFreetext((p) => ({ ...p, [`${row.invoiceNo}_${ci}`]: false }))}
                                />
                              ) : (
                                <select
                                  value={chargeEdits[ch.desc] ?? ch.ledger}
                                  onChange={(e) => {
                                    if (e.target.value === '__new__') {
                                      setChargeFreetext((p) => ({ ...p, [`${row.invoiceNo}_${ci}`]: true }));
                                      return;
                                    }
                                    if (!e.target.value) return;
                                    setChargeEdits((p) => ({ ...p, [ch.desc]: e.target.value }));
                                  }}
                                  className={`border rounded px-2 py-1 text-xs w-full dark:text-gray-100 ${
                                    ch.suggested
                                      ? 'border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20'
                                      : 'border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700'
                                  }`}
                                >
                                  {(chargeEdits[ch.desc] ?? ch.ledger) && (
                                    <option value={chargeEdits[ch.desc] ?? ch.ledger}>
                                      {chargeEdits[ch.desc] ?? ch.ledger}{ch.suggested ? ' ✦' : ''}
                                    </option>
                                  )}
                                  <option value="__new__">+ Create new ledger…</option>
                                </select>
                              )
                            )}
                          </td>
                          <td className="px-3 py-2 text-right font-mono text-gray-700 dark:text-gray-300">
                            {ch ? ch.amount.toLocaleString('en-IN', { minimumFractionDigits: 2 }) : ''}
                          </td>
                        </React.Fragment>
                      );
                    })}
                    {/* CGST */}
                    <td className="px-3 py-2 min-w-[160px]">
                      {row.taxType === 'cgst_sgst' && row.isFirst && (() => {
                        const opts = dutiesTaxes.filter((d) => d.tax_component === 'CGST').map((d) => d.tally_ledger_name);
                        return isLocked
                          ? <span className="font-mono font-medium text-teal-700 dark:text-teal-300">{effectiveCgst || '-'}</span>
                          : <CreatableLedgerDropdown
                              value={taxLedgerEdits.cgst ?? row.cgstLedger}
                              options={opts}
                              pendingOptions={pendingCgst}
                              suggested={row.cgstSuggested}
                              freetext={cgstFreetext[`${row.invoiceNo}_${row.lineIdx}`] ?? false}
                              createLabel="New CGST ledger name…"
                              onSelect={(v) => setTaxLedgerEdits((p) => ({ ...p, cgst: v }))}
                              onStartCreate={() => setCgstFreetext((p) => ({ ...p, [`${row.invoiceNo}_${row.lineIdx}`]: true }))}
                              onConfirmCreate={(v) => {
                                setPendingCgst((p) => p.includes(v) ? p : [...p, v]);
                                setTaxLedgerEdits((p) => ({ ...p, cgst: v }));
                                setCgstFreetext((p) => ({ ...p, [`${row.invoiceNo}_${row.lineIdx}`]: false }));
                              }}
                              onCancelCreate={() => setCgstFreetext((p) => ({ ...p, [`${row.invoiceNo}_${row.lineIdx}`]: false }))}
                            />;
                      })()}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-gray-700 dark:text-gray-300">
                      {row.taxType === 'cgst_sgst' && row.cgstAmt !== 0 ? row.cgstAmt.toFixed(2) : ''}
                    </td>
                    {/* SGST */}
                    <td className="px-3 py-2 min-w-[160px]">
                      {row.taxType === 'cgst_sgst' && row.isFirst && (() => {
                        const opts = dutiesTaxes.filter((d) => d.tax_component === 'SGST').map((d) => d.tally_ledger_name);
                        return isLocked
                          ? <span className="font-mono font-medium text-teal-700 dark:text-teal-300">{effectiveSgst || '-'}</span>
                          : <CreatableLedgerDropdown
                              value={taxLedgerEdits.sgst ?? row.sgstLedger}
                              options={opts}
                              pendingOptions={pendingSgst}
                              suggested={row.sgstSuggested}
                              freetext={sgstFreetext[`${row.invoiceNo}_${row.lineIdx}`] ?? false}
                              createLabel="New SGST ledger name…"
                              onSelect={(v) => setTaxLedgerEdits((p) => ({ ...p, sgst: v }))}
                              onStartCreate={() => setSgstFreetext((p) => ({ ...p, [`${row.invoiceNo}_${row.lineIdx}`]: true }))}
                              onConfirmCreate={(v) => {
                                setPendingSgst((p) => p.includes(v) ? p : [...p, v]);
                                setTaxLedgerEdits((p) => ({ ...p, sgst: v }));
                                setSgstFreetext((p) => ({ ...p, [`${row.invoiceNo}_${row.lineIdx}`]: false }));
                              }}
                              onCancelCreate={() => setSgstFreetext((p) => ({ ...p, [`${row.invoiceNo}_${row.lineIdx}`]: false }))}
                            />;
                      })()}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-gray-700 dark:text-gray-300">
                      {row.taxType === 'cgst_sgst' && row.sgstAmt !== 0 ? row.sgstAmt.toFixed(2) : ''}
                    </td>
                    {/* IGST */}
                    <td className="px-3 py-2 min-w-[160px]">
                      {row.taxType === 'igst' && row.isFirst && (() => {
                        const opts = dutiesTaxes.filter((d) => d.tax_component === 'IGST').map((d) => d.tally_ledger_name);
                        return isLocked
                          ? <span className="font-mono font-medium text-cyan-700 dark:text-cyan-300">{effectiveIgst || '-'}</span>
                          : <CreatableLedgerDropdown
                              value={taxLedgerEdits.igst ?? row.igstLedger}
                              options={opts}
                              pendingOptions={pendingIgst}
                              suggested={row.igstSuggested}
                              freetext={igstFreetext[`${row.invoiceNo}_${row.lineIdx}`] ?? false}
                              createLabel="New IGST ledger name…"
                              onSelect={(v) => setTaxLedgerEdits((p) => ({ ...p, igst: v }))}
                              onStartCreate={() => setIgstFreetext((p) => ({ ...p, [`${row.invoiceNo}_${row.lineIdx}`]: true }))}
                              onConfirmCreate={(v) => {
                                setPendingIgst((p) => p.includes(v) ? p : [...p, v]);
                                setTaxLedgerEdits((p) => ({ ...p, igst: v }));
                                setIgstFreetext((p) => ({ ...p, [`${row.invoiceNo}_${row.lineIdx}`]: false }));
                              }}
                              onCancelCreate={() => setIgstFreetext((p) => ({ ...p, [`${row.invoiceNo}_${row.lineIdx}`]: false }))}
                            />;
                      })()}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-gray-700 dark:text-gray-300">
                      {row.taxType === 'igst' && row.igstAmt !== 0 ? row.igstAmt.toFixed(2) : ''}
                    </td>
                    {/* Round Off */}
                    <td className="px-3 py-2 min-w-[160px]">
                      {row.isFirst && row.roAmt !== 0 && (() => {
                        const roOpts = expenseLedgers
                          .filter((e) => e.expense_keyword && ['round off', 'rounding off'].includes(e.expense_keyword.toLowerCase().trim()))
                          .map((e) => e.tally_ledger_name);
                        return isLocked
                          ? <span className="font-mono font-medium text-gray-600 dark:text-gray-400">{effectiveRo || '-'}</span>
                          : <CreatableLedgerDropdown
                              value={roLedgerEdits[row.invoiceNo] ?? row.roLedger}
                              options={roOpts}
                              pendingOptions={pendingRo}
                              suggested={row.roSuggested}
                              freetext={roFreetext[row.invoiceNo] ?? false}
                              createLabel="New round off ledger name…"
                              onSelect={(v) => setRoLedgerEdits((p) => ({ ...p, [row.invoiceNo]: v }))}
                              onStartCreate={() => setRoFreetext((p) => ({ ...p, [row.invoiceNo]: true }))}
                              onConfirmCreate={(v) => {
                                setPendingRo((p) => p.includes(v) ? p : [...p, v]);
                                setRoLedgerEdits((p) => ({ ...p, [row.invoiceNo]: v }));
                                setRoFreetext((p) => ({ ...p, [row.invoiceNo]: false }));
                              }}
                              onCancelCreate={() => setRoFreetext((p) => ({ ...p, [row.invoiceNo]: false }))}
                            />;
                      })()}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-gray-500 dark:text-gray-400">
                      {row.isFirst && row.roAmt !== 0 ? row.roAmt.toFixed(2) : ''}
                    </td>
                  </tr>
                );
              });
              })()}
            </tbody>
          </table>
        </div>
        {(() => {
          const totalVisible = invoiceOrder.filter((invNo) => filteredInvoiceNos.has(invNo)).length;
          return totalVisible > visibleInvoiceCount ? (
            <div className="flex justify-center mt-4">
              <button
                onClick={() => setVisibleInvoiceCount((c) => c + 100)}
                className="px-4 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
              >
                Show 100 more (showing {visibleInvoiceCount} of {totalVisible})
              </button>
            </div>
          ) : null;
        })()}

        {/* Stock item naming pattern popup */}
        {stockConfirm && (() => {
          const sameInvoiceCandidates = displayRows.filter((r) =>
            r.invoiceNo === stockConfirm.invoiceNo && r.lineIdx !== stockConfirm.lineIdx &&
            r.itemDesc && r.stockItemSuggested && !stockItemEdits[`${r.invoiceNo}_${r.lineIdx}`]
          );
          const globalCandidateInvoiceNos = new Set(
            displayRows.filter((r) =>
              !(r.invoiceNo === stockConfirm.invoiceNo && r.lineIdx === stockConfirm.lineIdx) &&
              r.itemDesc && r.stockItemSuggested && !lockedInvoices[r.invoiceNo] &&
              !stockItemEdits[`${r.invoiceNo}_${r.lineIdx}`]
            ).map((r) => r.invoiceNo)
          );
          const applyPatternToRows = (targets: SalesFlatDisplayRow[]) => {
            targets.forEach((r) => {
              const inv = byInvoice.get(r.invoiceNo);
              const li = inv?.line_items.find((l) => l.description === r.itemDesc);
              if (li) {
                const name = li.hsn ? `${li.hsn} @ ${li.gst_percent ?? 0}%` : `${li.description} @ ${li.gst_percent ?? 0}%`;
                setStockItemEdits((p) => ({ ...p, [`${r.invoiceNo}_${r.lineIdx}`]: name }));
              }
            });
          };
          return (
            <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center">
              <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl p-6 max-w-md w-full mx-4">
                <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-2">Apply HSN naming pattern to all?</h3>
                <p className="text-sm text-gray-600 dark:text-gray-400 mb-1">
                  You confirmed stock item: <span className="font-mono font-semibold text-indigo-700 dark:text-indigo-300">{stockConfirm.chosenName}</span>
                </p>
                <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
                  Would you like to apply <span className="font-mono font-semibold">HSN @ GST%</span> naming to other AI-suggested stock items?
                </p>
                <div className="flex flex-col gap-2">
                  <button
                    onClick={() => {
                      setStockItemEdits((p) => ({ ...p, [`${stockConfirm.invoiceNo}_${stockConfirm.lineIdx}`]: stockConfirm.chosenName }));
                      applyPatternToRows(sameInvoiceCandidates);
                      setStockConfirm(null);
                    }}
                    className="w-full text-left px-4 py-3 rounded-lg border border-gray-200 dark:border-gray-600 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 transition-colors"
                  >
                    <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">Apply to this invoice only</div>
                    <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                      {sameInvoiceCandidates.length === 0
                        ? 'No other suggested items on this invoice'
                        : `${sameInvoiceCandidates.length} other item${sameInvoiceCandidates.length !== 1 ? 's' : ''} on this invoice will be updated`}
                    </div>
                  </button>
                  <button
                    onClick={() => {
                      const allCandidates = displayRows.filter((r) =>
                        !(r.invoiceNo === stockConfirm.invoiceNo && r.lineIdx === stockConfirm.lineIdx) &&
                        r.itemDesc && r.stockItemSuggested && !lockedInvoices[r.invoiceNo] &&
                        !stockItemEdits[`${r.invoiceNo}_${r.lineIdx}`]
                      );
                      setStockItemEdits((p) => ({ ...p, [`${stockConfirm.invoiceNo}_${stockConfirm.lineIdx}`]: stockConfirm.chosenName }));
                      applyPatternToRows(allCandidates);
                      setStockConfirm(null);
                    }}
                    disabled={globalCandidateInvoiceNos.size === 0}
                    className="w-full text-left px-4 py-3 rounded-lg border border-gray-200 dark:border-gray-600 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <div className={`text-sm font-semibold ${globalCandidateInvoiceNos.size > 0 ? 'text-indigo-700 dark:text-indigo-300' : 'text-gray-400 dark:text-gray-500'}`}>
                      Apply to all {globalCandidateInvoiceNos.size} loaded unaccepted invoice{globalCandidateInvoiceNos.size !== 1 ? 's' : ''}
                    </div>
                    <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">Session-scoped. All other suggested stock items across all unaccepted invoices are updated.</div>
                  </button>
                  <button
                    onClick={() => {
                      setStockItemEdits((p) => ({ ...p, [`${stockConfirm.invoiceNo}_${stockConfirm.lineIdx}`]: stockConfirm.chosenName }));
                      setStockConfirm(null);
                    }}
                    className="w-full text-left px-4 py-3 rounded-lg border border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
                  >
                    <div className="text-sm font-semibold text-gray-700 dark:text-gray-300">No – map individually</div>
                    <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">Only this item is updated.</div>
                  </button>
                  <button
                    onClick={() => setStockConfirm(null)}
                    className="w-full text-left px-4 py-3 rounded-lg border border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
                  >
                    <div className="text-sm font-medium text-gray-500 dark:text-gray-400">Cancel</div>
                  </button>
                </div>
              </div>
            </div>
          );
        })()}
      </div>
    </div>
  );
}

// ─── Helpers for main page ────────────────────────────────────────────────────

function downloadXmlFile(xml: string, filename: string) {
  const utf16 = new Uint16Array(xml.length);
  for (let i = 0; i < xml.length; i++) utf16[i] = xml.charCodeAt(i);
  const bom = new Uint8Array([0xff, 0xfe]);
  const body = new Uint8Array(utf16.buffer);
  const merged = new Uint8Array(bom.length + body.length);
  merged.set(bom, 0);
  merged.set(body, bom.length);
  const blob = new Blob([merged], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

interface CachedMasters {
  customers: CustomerMaster[];
  suppliers: SupplierMaster[];
  dutiesTaxes: DutiesTaxesMaster[];
  stockItems: StockItemMaster[];
  salesLedgerMasters: string[];
  expenseLedgers: ExpenseLedgerMaster[];
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function SalesXmlPage() {
  const router = useRouter();
  const { company, loading: companyLoading } = useCompany();

  const [selectedFY, setSelectedFY] = useState<string>(currentFY);
  const [invoices, setInvoices] = useState<StoredInvoice[]>([]);
  const [loadingInvoices, setLoadingInvoices] = useState(false);
  const [loadError, setLoadError] = useState('');

  const [cachedMasters, setCachedMasters] = useState<CachedMasters | null>(null);
  const [cachedHistoricalSL, setCachedHistoricalSL] = useState<Record<string, string> | null>(null);
  const [cachedCompanyWideSL, setCachedCompanyWideSL] = useState<string | null>(null);

  const [voucherMode, setVoucherMode] = useState<'accounting_only' | 'inventory'>('accounting_only');

  const [previewing, setPreviewing] = useState(false);
  const [previewShown, setPreviewShown] = useState(false);
  const [previewError, setPreviewError] = useState('');

  const [generatingXml, setGeneratingXml] = useState(false);
  const [lastXmlFilename, setLastXmlFilename] = useState('');

  // Auth
  useEffect(() => {
    if (companyLoading) return;
    getSession().then((session) => {
      if (!session) { router.replace('/login'); return; }
      if (!company) router.replace('/select-company');
    });
  }, [company, companyLoading, router]);

  // Load voucher mode from DB
  useEffect(() => {
    if (!company?.id) return;
    getCompany(company.id).then((fresh) => {
      if (fresh.voucher_mode) setVoucherMode(fresh.voucher_mode);
    }).catch(() => {});
  }, [company?.id]);

  // Load invoices on company/FY change
  useEffect(() => {
    setPreviewShown(false);
    setCachedMasters(null);
    if (!company?.id) { setInvoices([]); return; }
    setLoadingInvoices(true);
    setLoadError('');
    getSalesRegister(company.id, { financialYear: selectedFY || undefined })
      .then(setInvoices)
      .catch((e) => setLoadError((e as Error).message ?? 'Failed to load invoices'))
      .finally(() => setLoadingInvoices(false));
  }, [company?.id, selectedFY]);

  // Build initialLockedInvoices from loaded invoices
  const initialLockedInvoices = useMemo<Record<string, LockedSalesInvoice>>(() => {
    const out: Record<string, LockedSalesInvoice> = {};
    for (const inv of invoices) {
      if (inv.tally_ledger_acceptance) {
        const acc = inv.tally_ledger_acceptance as unknown as Record<string, unknown>;
        out[inv.invoice_number] = {
          customerLedger: (acc.customerLedger as string) ?? '',
          salesLedger: (acc.salesLedger as string) ?? '',
          cgstLedger: (acc.cgstLedger as string) ?? '',
          sgstLedger: (acc.sgstLedger as string) ?? '',
          igstLedger: (acc.igstLedger as string) ?? '',
          roLedger: (acc.roLedger as string) ?? '',
          stock: (acc.stock as Record<string, string>) ?? {},
          charges: (acc.charges as Record<string, string>) ?? {},
        };
      }
    }
    return out;
  }, [invoices]);

  const fileBase = `${company?.tally_company_name ?? company?.name ?? 'export'}_${selectedFY}`
    .replace(/[^a-zA-Z0-9._-]/g, '_');

  // ── Preview ──
  const handlePreview = async () => {
    if (!company) { alert('No company selected.'); return; }
    if (invoices.length === 0) { alert('No accepted invoices found for the selected period.'); return; }

    setPreviewing(true);
    setPreviewError('');
    try {
      const [customers, suppliers, dutiesTaxes, stockItems, salesLedgerRaw, expenseLedgers] = await Promise.all([
        loadCustomers(company.id),
        loadSuppliers(company.id),
        loadDutiesTaxes(company.id),
        loadStockItems(company.id),
        loadSalesLedgers(company.id),
        loadExpenseLedgers(company.id),
      ]);
      const salesLedgerMasters = salesLedgerRaw.map((l) => l.tally_ledger_name);

      const historicalSL = await getBatchHistoricalSalesLedgers(company.id);

      const companyWideSL = salesLedgerMasters.length > 1
        ? await getCompanyWideMostUsedSalesLedger(company.id, salesLedgerMasters)
        : null;

      setCachedMasters({ customers, suppliers, dutiesTaxes, stockItems, salesLedgerMasters, expenseLedgers });
      setCachedHistoricalSL(historicalSL);
      setCachedCompanyWideSL(companyWideSL);
      setPreviewShown(true);
    } catch (e: unknown) {
      setPreviewError(e instanceof Error ? e.message : 'Preview failed');
    } finally {
      setPreviewing(false);
    }
  };

  // ── Download Excel (preview CSV) ──
  const handleDownloadExcel = () => {
    if (!cachedMasters) return;
    const rows = buildSalesPreview({
      invoices,
      customers: cachedMasters.customers,
      dutiesTaxes: cachedMasters.dutiesTaxes,
      stockItems: cachedMasters.stockItems,
      expenseLedgers: cachedMasters.expenseLedgers,
      tallyCompanyName: company?.tally_company_name ?? '',
      voucherMode,
      stockItemMode: company?.stock_item_mode,
    });
    const header = 'Invoice No,Date,Buyer Name,Ledger Type,Tally Ledger,Amount,Status\n';
    const csvRows = rows.map((r) =>
      [r.invoice_number, r.invoice_date, r.buyer_name, r.ledger_type, r.tally_ledger_name, r.amount, r.status].join(',')
    ).join('\n');
    const blob = new Blob([header + csvRows], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `${fileBase}_preview.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  // ── onAcceptInvoices ──
  const onAcceptInvoices = async (payloads: SalesAcceptPayload[]) => {
    if (!company?.id) return;
    const errs: string[] = [];
    const seenCustomer = new Set<string>();
    const seenSL = new Set<string>();
    const seenStock = new Set<string>();
    let seenCgst = false;
    let seenSgst = false;
    let seenIgst = false;
    const seenRo = new Set<string>();

    for (const p of payloads) {
      if (!isBlank(p.customerLedger) && !seenCustomer.has(p.customerName)) {
        seenCustomer.add(p.customerName);
        try {
          await addCustomer(company.id, {
            customer_name: p.customerName,
            customer_gstin: p.customerGstin || '',
            tally_ledger_name: p.customerLedger,
          });
        } catch (e) { errs.push(`Customer "${p.customerName}": ${getErrMsg(e)}`); }
      }
      if (!isBlank(p.salesLedger) && !seenSL.has(p.salesLedger)) {
        seenSL.add(p.salesLedger);
        try { await addSalesLedger(company.id, p.salesLedger); }
        catch (e) { errs.push(`Sales ledger: ${getErrMsg(e)}`); }
      }
      for (const si of p.stockItems) {
        if (!isBlank(si.tallyName) && !seenStock.has(si.desc)) {
          seenStock.add(si.desc);
          try {
            await addStockItem(company.id, {
              tally_item_name: si.tallyName,
              alias_name: si.desc,
              hsn_code: si.hsn || undefined,
              unit: si.uom || undefined,
              gst_percent: si.gst_percent ?? null,
            });
          } catch (e) { errs.push(`Stock "${si.desc}": ${getErrMsg(e)}`); }
        }
      }
      if (p.taxType === 'cgst_sgst') {
        if (!isBlank(p.cgstLedger) && !seenCgst) {
          seenCgst = true;
          try { await addDutiesTaxes(company.id, { tax_component: 'CGST', tax_rate: null, tally_ledger_name: p.cgstLedger }); }
          catch (e) { errs.push(`CGST: ${getErrMsg(e)}`); }
        }
        if (!isBlank(p.sgstLedger) && !seenSgst) {
          seenSgst = true;
          try { await addDutiesTaxes(company.id, { tax_component: 'SGST', tax_rate: null, tally_ledger_name: p.sgstLedger }); }
          catch (e) { errs.push(`SGST: ${getErrMsg(e)}`); }
        }
      } else if (p.taxType === 'igst') {
        if (!isBlank(p.igstLedger) && !seenIgst) {
          seenIgst = true;
          try { await addDutiesTaxes(company.id, { tax_component: 'IGST', tax_rate: null, tally_ledger_name: p.igstLedger }); }
          catch (e) { errs.push(`IGST: ${getErrMsg(e)}`); }
        }
      }
      if (!isBlank(p.roLedger) && !seenRo.has(p.roLedger)) {
        seenRo.add(p.roLedger);
        try { await addExpenseLedger(company.id, { tally_ledger_name: p.roLedger, expense_keyword: 'Round Off' }); }
        catch (e) { errs.push(`Round Off: ${getErrMsg(e)}`); }
      }
    }

    for (const p of payloads) {
      const chargesLocked: Record<string, string> = {};
      p.charges.forEach((ch) => { chargesLocked[ch.keyword] = ch.tallyName; });
      const acceptance = {
        customerLedger: p.customerLedger,
        salesLedger: p.salesLedger,
        cgstLedger: p.cgstLedger,
        sgstLedger: p.sgstLedger,
        igstLedger: p.igstLedger,
        roLedger: p.roLedger,
        stock: p.lockedStock,
        charges: chargesLocked,
      };
      try { await saveSalesTallyAcceptance(company.id, p.invoiceId, acceptance); }
      catch (e) { errs.push(`Save acceptance for ${p.invoiceNo}: ${getErrMsg(e)}`); }
    }
    if (errs.length) alert(`Some items failed to save:\n${errs.join('\n')}`);
  };

  // ── Build XML input ──
  const buildXmlInput = async () => {
    if (!company) throw new Error('No company');
    const fresh = await getCompany(company.id);
    const [customers, dutiesTaxes, stockItems, expenseLedgers] = await Promise.all([
      loadCustomers(company.id),
      loadDutiesTaxes(company.id),
      loadStockItems(company.id),
      loadExpenseLedgers(company.id),
    ]);
    return {
      invoices,
      customers,
      dutiesTaxes,
      stockItems,
      expenseLedgers,
      tallyCompanyName: company.tally_company_name ?? '',
      financialYear: selectedFY,
      voucherMode,
      companyGstin: fresh.gstin ?? undefined,
      companyState: undefined,
      stockItemMode: fresh.stock_item_mode,
    };
  };

  // ── Download Masters XML ──
  const handleDownloadMastersXml = async (type: SalesMasterType, label: string) => {
    if (!company) { alert('No company selected.'); return; }
    if (!company.tally_company_name) { alert('Tally Company Name is missing - update it in Companies first.'); return; }
    if (invoices.length === 0) { alert('No accepted invoices found for the selected period.'); return; }
    setGeneratingXml(true);
    try {
      const input = await buildXmlInput();
      const xml = generateSalesMastersXml(input, type);
      const filename = `${fileBase}_masters_${type}.xml`;
      downloadXmlFile(xml, filename);
      setLastXmlFilename(filename);
    } catch (e: unknown) {
      alert(`Error generating ${label} XML: ${getErrMsg(e)}`);
    } finally {
      setGeneratingXml(false);
    }
  };

  // ── Download Vouchers XML ──
  const handleDownloadVouchersXml = async () => {
    if (!company) { alert('No company selected.'); return; }
    if (!company.tally_company_name) { alert('Tally Company Name is missing - update it in Companies first.'); return; }
    if (invoices.length === 0) { alert('No accepted invoices found for the selected period.'); return; }
    if (voucherMode === 'inventory' && !company.gstin) {
      const proceed = window.confirm(
        'Warning: Company GSTIN is not set.\n\nWithout GSTIN, Tally cannot link this voucher to a Company Tax Unit, which is required for GST compliance in inventory mode.\n\nDo you want to continue anyway?'
      );
      if (!proceed) return;
    }
    setGeneratingXml(true);
    try {
      const input = await buildXmlInput();
      const output = generateSalesVouchers(input);
      const filename = `${fileBase}_vouchers.xml`;
      downloadXmlFile(output.xml, filename);
      setLastXmlFilename(filename);
      if (output.skippedInvoices.length > 0) {
        const msgs = output.skippedInvoices.map((s: { invoice_number: string; reason: string }) => `• ${s.invoice_number}: ${s.reason}`).join('\n');
        alert(`XML generated. ${output.includedCount} voucher(s) included.\n\n${output.skippedInvoices.length} skipped:\n${msgs}`);
      }
    } catch (e: unknown) {
      alert(`Error generating vouchers XML: ${getErrMsg(e)}`);
    } finally {
      setGeneratingXml(false);
    }
  };

  return (
    <AppLayout>
      <main className="flex-1 p-8" style={{ maxWidth: '100%' }}>
        <div className="mb-7">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Sales Export to Tally</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            Analyse ledger assignments and resolve exceptions, then download the XML for import into Tally.
          </p>
        </div>

        {/* ── Step 1: Period + Settings ── */}
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-6 mb-5">
          <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-4">
            <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-indigo-600 text-white text-xs mr-2">1</span>
            Select Period &amp; Settings
          </h2>
          <div className="flex items-center gap-4 mb-5">
            <div>
              <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1.5">Financial Year</label>
              <FYPeriodSelector value={selectedFY} onChange={setSelectedFY} />
            </div>
            <div className="pt-5 text-sm text-gray-500 dark:text-gray-400">
              {loadingInvoices ? (
                <span className="text-gray-400 dark:text-gray-500">Loading…</span>
              ) : loadError ? (
                <span className="text-red-600 dark:text-red-400">{loadError}</span>
              ) : (
                <span>
                  <span className="font-semibold text-gray-800 dark:text-gray-200">{invoices.length}</span>{' '}
                  accepted invoice{invoices.length !== 1 ? 's' : ''}
                </span>
              )}
            </div>
          </div>

          {company && !company.tally_company_name && (
            <div className="mb-4 flex items-center gap-2 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 rounded-lg px-4 py-2.5 text-sm text-amber-800 dark:text-amber-300">
              <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
              </svg>
              <span>
                <strong>Tally Company Name is missing.</strong>{' '}
                <button onClick={() => router.push('/companies')} className="underline">Update in Companies</button>
              </span>
            </div>
          )}

          <div className="border-t border-gray-100 dark:border-gray-700 pt-4">
            <p className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-2">Voucher Mode</p>
            <div className="flex gap-3">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio" name="salesVoucherMode" value="accounting_only"
                  checked={voucherMode === 'accounting_only'}
                  onChange={() => { setVoucherMode('accounting_only'); if (company) updateCompany(company.id, { voucher_mode: 'accounting_only' }).catch(() => {}); }}
                  className="accent-indigo-600"
                />
                <span className="text-sm text-gray-700 dark:text-gray-300">
                  Accounting only <span className="text-xs text-gray-400 dark:text-gray-500">(HSN-aggregated, no stock items)</span>
                </span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio" name="salesVoucherMode" value="inventory"
                  checked={voucherMode === 'inventory'}
                  onChange={() => { setVoucherMode('inventory'); if (company) updateCompany(company.id, { voucher_mode: 'inventory' }).catch(() => {}); }}
                  className="accent-indigo-600"
                />
                <span className="text-sm text-gray-700 dark:text-gray-300">
                  Inventory <span className="text-xs text-gray-400 dark:text-gray-500">(item-level qty, rate, discount)</span>
                </span>
              </label>
            </div>
          </div>
        </div>

        {/* ── Step 2: Preview ── */}
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-6 mb-5">
          <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-1">
            <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-indigo-600 text-white text-xs mr-2">2</span>
            Preview Ledger Assignments
          </h2>
          <p className="text-xs text-gray-400 dark:text-gray-500 mb-4">
            The system analyses your accepted sales invoices and shows every ledger entry that will be created in Tally.
            Accept invoices to lock in the mapping.
          </p>

          <button
            onClick={handlePreview}
            disabled={previewing || !company || invoices.length === 0}
            className="px-5 py-2 bg-indigo-600 text-white rounded-lg text-sm font-semibold hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {previewing ? 'Analysing…' : 'Preview'}
          </button>

          {previewError && (
            <p className="mt-3 text-sm text-red-600 dark:text-red-400">{previewError}</p>
          )}

          {previewShown && cachedMasters && (
            <div className="mt-5">
              <SalesFlatTable
                invoices={invoices}
                customers={cachedMasters.customers}
                suppliers={cachedMasters.suppliers}
                dutiesTaxes={cachedMasters.dutiesTaxes}
                stockItems={cachedMasters.stockItems}
                stockItemMode={company?.stock_item_mode}
                salesLedgerMasters={cachedMasters.salesLedgerMasters}
                historicalSalesLedgers={cachedHistoricalSL ?? {}}
                companyWideSalesLedger={cachedCompanyWideSL}
                initialLockedInvoices={initialLockedInvoices}
                companyId={company!.id}
                voucherMode={voucherMode}
                expenseLedgers={cachedMasters.expenseLedgers}
                onAcceptInvoices={onAcceptInvoices}
                onDownloadExcel={handleDownloadExcel}
              />
            </div>
          )}
        </div>

        {/* ── Step 3: Generate XML ── */}
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-6 mb-5">
          <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-1">
            <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-indigo-600 text-white text-xs mr-2">3</span>
            Generate &amp; Download XML
          </h2>
          <p className="text-xs text-gray-400 dark:text-gray-500 mb-4">
            Import masters first (each type separately), then import vouchers. Each button downloads one XML file.
          </p>

          <div className="mb-4">
            <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">Masters (import in order)</p>
            <div className="flex flex-wrap gap-2">
              {([
                { type: 'stock_items'  as SalesMasterType, label: 'Stock Items',           color: 'bg-indigo-600 hover:bg-indigo-700' },
                { type: 'sales_ledgers' as SalesMasterType, label: 'Sales Ledgers',         color: 'bg-blue-600 hover:bg-blue-700' },
                { type: 'duties_taxes' as SalesMasterType, label: 'Duties & Taxes',         color: 'bg-teal-600 hover:bg-teal-700' },
                { type: 'customers'    as SalesMasterType, label: 'Sundry Debtors',         color: 'bg-purple-600 hover:bg-purple-700' },
                { type: 'ledgers_only' as SalesMasterType, label: 'All Ledgers (Combined)', color: 'bg-gray-700 hover:bg-gray-800' },
              ]).map(({ type, label, color }) => (
                <button
                  key={type}
                  onClick={() => handleDownloadMastersXml(type, label)}
                  disabled={generatingXml || !company || invoices.length === 0}
                  className={`flex items-center gap-2 px-4 py-2 ${color} text-white rounded-lg text-xs font-semibold disabled:opacity-50 disabled:cursor-not-allowed transition-colors`}
                >
                  <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                  {generatingXml ? '…' : label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">Vouchers (import after all masters succeed)</p>
            <button
              onClick={handleDownloadVouchersXml}
              disabled={generatingXml || !company || invoices.length === 0}
              className="flex items-center gap-2 px-5 py-2.5 bg-gray-900 text-white rounded-lg text-sm font-semibold hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              {generatingXml ? 'Generating…' : 'Download Vouchers XML'}
            </button>
          </div>

          {lastXmlFilename && (
            <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
              Last downloaded: <span className="font-mono">{lastXmlFilename}</span>
            </p>
          )}
        </div>

        {/* How-to */}
        <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-xl px-5 py-4 text-sm text-blue-800 dark:text-blue-200">
          <p className="font-semibold mb-2">How to import into Tally</p>
          <p className="text-xs text-blue-700 dark:text-blue-300 mb-2">
            Import each master type separately first, then import vouchers. Safe to re-import — Tally silently skips masters that already exist.
          </p>
          <ol className="list-decimal list-inside space-y-1.5 text-blue-700 dark:text-blue-300 text-xs">
            <li>Open Tally &rarr; select company <strong>{company?.tally_company_name ?? '-'}</strong></li>
            <li>
              <strong>Import each master:</strong> Gateway of Tally &rarr; Import Data &rarr; Masters &rarr; select the file
              <span className="block ml-5 mt-0.5 text-blue-600 dark:text-blue-400">
                Order: Stock Items &rarr; Sales Ledgers &rarr; Duties &amp; Taxes &rarr; Sundry Debtors
              </span>
            </li>
            <li>
              <strong>Import Vouchers</strong> only after all masters succeed: Import Data &rarr; Vouchers &rarr; select <em>…_vouchers.xml</em>
            </li>
          </ol>
        </div>
      </main>
    </AppLayout>
  );
}
