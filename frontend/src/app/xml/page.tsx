'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { getPurchaseRegister, getCompany, updateCompany, saveInvoiceTallyAcceptance } from '@/lib/db';
import { loadSuppliers, addSupplier } from '@/lib/suppliers';
import { loadDutiesTaxes, addDutiesTaxes } from '@/lib/dutiesTaxes';
import { loadStockItems, addStockItem } from '@/lib/stockItems';
import { loadExpenseLedgers, addExpenseLedger, getExpenseDefaults } from '@/lib/expenseLedgers';
import { loadPurchaseLedgers, addPurchaseLedger, getHistoricalPurchaseLedger, getCompanyWideMostUsedPurchaseLedger } from '@/lib/purchaseLedgers';
import { loadVoucherTypes } from '@/lib/voucherTypes';
import { generateTallyXml, generateMastersXml, buildTallyPreview, type PreviewRow, type MasterType } from '@/lib/xmlGenerator';
import type { StoredInvoice } from '@/types/invoice';
import { calcLineAmount } from '@/types/invoice';
import AppLayout from '@/components/AppLayout';
import { currentFY } from '@/lib/fyPeriod';
import { useCompany } from '@/lib/companyContext';
import FYPeriodSelector from '@/components/FYPeriodSelector';
import * as XLSX from 'xlsx';
import { normalizeUom } from '@/lib/uomRegistry';

// Accounting mode has no stock master — show normalised invoice UOM
const normalizeUomDisplay = (raw: string | null | undefined): string =>
  normalizeUom(raw).canonical;

// ─── Constants ────────────────────────────────────────────────────────────────


const LEDGER_TYPE_COLORS: Record<PreviewRow['ledger_type'], string> = {
  Party:       'bg-purple-100 text-purple-700',
  Purchase:    'bg-blue-100 text-blue-700',
  CGST:        'bg-teal-100 text-teal-700',
  SGST:        'bg-teal-100 text-teal-700',
  IGST:        'bg-cyan-100 text-cyan-700',
  Expense:     'bg-orange-100 text-orange-700',
  'Round Off': 'bg-gray-100 text-gray-600',
  Inventory:   'bg-indigo-100 text-indigo-700',
  Discount:    'bg-pink-100 text-pink-700',
};

// ─── Sub-components ───────────────────────────────────────────────────────────

// ─── Shared types ────────────────────────────────────────────────────────────

function getErrMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'object' && e !== null && 'message' in e) return String((e as { message: unknown }).message);
  return 'Unknown error';
}

// A value is blank if it is empty, whitespace-only, or the UI sentinel '-'.
// Used to guard acceptance and master writes.
function isBlank(v?: string | null): boolean {
  return !v || v.trim().length === 0 || v === '-';
}

// ─── LedgerWarning — generic structured tooltip for yellow-without-✦ states ──

interface LedgerWarning {
  reason: string;
  meaning: string;
  action: string;
}

// ⓘ icon rendered beside a dropdown when the mapping is amber but not ✦
// (ledger exists in master but could not be auto-confirmed)
function InfoIcon({ warning }: { warning: LedgerWarning }) {
  const tip = `Reason: ${warning.reason}\n\nMeaning: ${warning.meaning}\n\nAction Required: ${warning.action}`;
  return (
    <span
      className="shrink-0 text-amber-500 dark:text-amber-400 cursor-help text-sm select-none"
      title={tip}
    >ⓘ</span>
  );
}

// Inline text input shown when user selects "+ Create new…" in a ledger dropdown
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
        // Only confirm on non-empty blur. Never auto-cancel on empty blur —
        // autoFocus causes the browser to lose focus immediately after mounting
        // (select-unmount timing), so we keep the input alive until Escape or Enter.
        const v = e.currentTarget.value.trim();
        if (v) onConfirm(v);
      }}
    />
  );
}

// Reusable dropdown with "+ Create new…" inline creation, ghost-option support,
// and optional ⓘ warning for amber-but-confirmed states.
// freetext state is lifted to parent so it survives across re-renders.
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
      {/* ⓘ only when amber + value exists in master (no ghost) = unconfirmed mapping */}
      {warning && suggested && !isGhost && <InfoIcon warning={warning} />}
    </div>
  );
}

type SuggestionItem =
  | { kind: 'vendor';  vendorName: string; gstin: string;  ledger: string }
  | { kind: 'stock';   desc: string;       hsn: string;    tallyName: string }
  | { kind: 'expense'; keyword: string;    tallyName: string };

// Per-invoice accept payload - everything that should be saved when the user accepts an invoice
interface InvoiceAcceptPayload {
  invoiceNo: string;
  vendorName: string; vendorGstin: string; vendorLedger: string;
  purchaseLedger: string;
  stockItems: Array<{ desc: string; hsn: string; uom: string; gst_percent?: number; tallyName: string }>;
  charges: Array<{ keyword: string; tallyName: string; gst_percent?: number; sac_code?: string }>;
  cgstLedger: string; sgstLedger: string; igstLedger: string;
  roLedger: string;
  taxType: 'cgst_sgst' | 'igst' | 'none';
  // Locked values to freeze in the UI after accept (keyed by itemDesc for stock items)
  lockedStock: Record<string, string>;
}

// Per-invoice locked field values (set after accept, used to freeze display)
interface LockedInvoice {
  vendorLedger: string; purchaseLedger: string;
  cgstLedger: string; sgstLedger: string; igstLedger: string;
  roLedger: string;
  stock: Record<string, string>; // itemDesc → tallyName
  charges: Record<string, string>; // charge desc → tally ledger name
}

// ─── Flat Preview Table (one row per line item, Excel format) ─────────────────

import type { SupplierMaster } from '@/lib/suppliers';

interface FlatDisplayRow {
  // invoice-level (repeated on every row)
  invoiceDate: string;
  invoiceNo: string;
  voucherType: string;
  vendorName: string;
  vendorLedger: string;
  vendorSuggested: boolean;
  vendorWarning?: LedgerWarning;
  gstin: string;
  gstRegType: string;
  // invoice-level tax ledgers (same for all rows in this invoice)
  taxType: 'cgst_sgst' | 'igst' | 'none';
  cgstLedger: string; cgstSuggested: boolean;
  sgstLedger: string; sgstSuggested: boolean;
  igstLedger: string; igstSuggested: boolean;
  // item-level
  purchaseLedger: string;
  purchaseLedgerSuggested: boolean;
  purchaseLedgerCase: 1 | 2 | 3 | 4;
  purchaseLedgerHistoricalMissing: boolean;
  itemDesc: string;
  lineIdx: number; // 0-based index within this invoice's line items — unique row key
  hsn: string;
  stockItem: string;
  stockItemSuggested: boolean;
  taxRate: number | null;
  qty: number | null;
  uom: string;
  rate: number | null;
  disc: number | null;
  amount: number;
  // per-item tax amounts (computed from item taxable × gst rate)
  cgstAmt: number;
  sgstAmt: number;
  igstAmt: number;
  // invoice-level - only on first row
  isFirst: boolean;
  charges: Array<{ desc: string; ledger: string; suggested: boolean; amount: number; gst_percent?: number; sac_code?: string; isDiscount?: boolean }>;
  roLedger: string; roSuggested: boolean; roAmt: number;
}

function FlatPreviewTable({
  rows, invoices, suppliers, expenseLedgers, stockItems,
  initialLockedInvoices,
  purchaseLedgerMasters, historicalPurchaseLedgers, companyWidePurchaseLedger,
  dutiesTaxesMasters, stockItemMode,
  onMapExpense, onMapSupplier, onMapStockItem, onMapTaxLedger, onAcceptInvoices, onDownloadExcel, companyId,
}: {
  rows: PreviewRow[];
  invoices: StoredInvoice[];
  suppliers: SupplierMaster[];
  expenseLedgers: { tally_ledger_name: string; expense_keyword?: string | null }[];
  stockItems: { tally_item_name: string; hsn_code?: string | null; gst_percent?: number | null }[];
  stockItemMode?: 'hsn_driven' | null;
  initialLockedInvoices: Record<string, LockedInvoice>;
  purchaseLedgerMasters: string[];
  historicalPurchaseLedgers: Record<string, string>;
  companyWidePurchaseLedger: string | null;
  dutiesTaxesMasters: { tax_component: string; tally_ledger_name: string }[];
  companyId: string;
  onMapExpense: (description: string, ledgerName: string) => void;
  onMapSupplier: (vendorName: string, ledgerName: string) => void;
  onMapStockItem: (description: string, tallyItemName: string) => void;
  onMapTaxLedger: (type: 'CGST' | 'SGST' | 'IGST', name: string) => void;
  onAcceptInvoices: (payloads: InvoiceAcceptPayload[]) => Promise<void>;
  onDownloadExcel: () => void;
}) {
  const isInventoryMode = rows.some((r) => r.ledger_type === 'Inventory');

  // Local editable overrides (keyed as needed)
  const [vendorEdits, setVendorEdits] = React.useState<Record<string, string>>({});
  const [purchaseLedgerEdits, setPurchaseLedgerEdits] = React.useState<Record<string, string>>({}); // keyed by invoiceNo
  const [stockItemEdits, setStockItemEdits] = React.useState<Record<string, string>>({});
  const [chargeEdits, setChargeEdits] = React.useState<Record<string, string>>({});
  const [chargeFreetext, setChargeFreetext] = React.useState<Record<string, boolean>>({}); // desc → show freetext input
  const [taxLedgerEdits, setTaxLedgerEdits] = React.useState<{ cgst?: string; sgst?: string; igst?: string }>({});
  const [roLedgerEdits, setRoLedgerEdits] = React.useState<Record<string, string>>({}); // keyed by invoiceNo
  const [pendingPurchaseLedgers, setPendingPurchaseLedgers] = React.useState<string[]>([]);
  const [purchaseLedgerCreating, setPurchaseLedgerCreating] = React.useState<Record<string, boolean>>({}); // keyed by invoiceNo
  // Create-new state for ledger types that previously lacked inline creation
  const [supplierFreetext, setSupplierFreetext] = React.useState<Record<string, boolean>>({}); // keyed by vendorName
  const [pendingSuppliers, setPendingSuppliers] = React.useState<string[]>([]);
  const [stockItemFreetext, setStockItemFreetext] = React.useState<Record<string, boolean>>({}); // keyed by `${invoiceNo}_${lineIdx}`
  const [pendingStockItems, setPendingStockItems] = React.useState<string[]>([]);
  const [cgstFreetext, setCgstFreetext] = React.useState<Record<string, boolean>>({});
  const [sgstFreetext, setSgstFreetext] = React.useState<Record<string, boolean>>({});
  const [igstFreetext, setIgstFreetext] = React.useState<Record<string, boolean>>({});
  const [pendingCgst, setPendingCgst] = React.useState<string[]>([]);
  const [pendingSgst, setPendingSgst] = React.useState<string[]>([]);
  const [pendingIgst, setPendingIgst] = React.useState<string[]>([]);
  const [roFreetext, setRoFreetext] = React.useState<Record<string, boolean>>({}); // keyed by invoiceNo
  const [pendingRo, setPendingRo] = React.useState<string[]>([]);

  // Filter / dashboard state
  const [cardFilter, setCardFilter] = React.useState<'accepted' | 'pending_review' | null>(null);
  const [statusFilter, setStatusFilter] = React.useState<'all' | 'accepted' | 'pending_review'>('all');
  const [vendorFilter, setVendorFilter] = React.useState('');
  const [invoiceFilter, setInvoiceFilter] = React.useState('');
  const [gstinFilter, setGstinFilter] = React.useState('');
  const [mappingFilter, setMappingFilter] = React.useState<'all' | 'ai_suggested_new' | 'new_stock_items'>('all');

  // Bulk-select state for inline accept / unaccept
  const [selectedRows, setSelectedRows] = React.useState<Set<number>>(new Set());
  const [selectedLockedInvoices, setSelectedLockedInvoices] = React.useState<Set<string>>(new Set());
  const [bulkSaving, setBulkSaving] = React.useState(false);

  // Accepted invoices - once accepted, fields are locked in the UI (initialised from DB on mount)
  const [lockedInvoices, setLockedInvoices] = React.useState<Record<string, LockedInvoice>>(initialLockedInvoices);

  // Stock item "apply to all" popup state
  const [stockConfirm, setStockConfirm] = React.useState<{
    invoiceNo: string; itemDesc: string; lineIdx: number; hsn: string; gstPct: number | null; suggestedName: string; chosenName: string;
  } | null>(null);

  // Group rows by invoice number, preserving order
  const invoiceOrder: string[] = [];
  const byInvoice = new Map<string, PreviewRow[]>();
  rows.forEach((r) => {
    if (!byInvoice.has(r.invoice_number)) { invoiceOrder.push(r.invoice_number); byInvoice.set(r.invoice_number, []); }
    byInvoice.get(r.invoice_number)!.push(r);
  });

  // Build one flat row per line item
  const displayRows: FlatDisplayRow[] = [];

  for (const invNo of invoiceOrder) {
    const invRows = byInvoice.get(invNo)!;
    const partyRow   = invRows.find((r) => r.ledger_type === 'Party');
    const invRows2   = invRows.filter((r) => r.ledger_type === 'Inventory');
    const purchRows  = invRows.filter((r) => r.ledger_type === 'Purchase');
    const chargeRows = invRows.filter((r) => r.ledger_type === 'Expense');
    const discountPreviewRow = invRows.find((r) => r.ledger_type === 'Discount');
    const cgst = invRows.find((r) => r.ledger_type === 'CGST');
    const sgst = invRows.find((r) => r.ledger_type === 'SGST');
    const igst = invRows.find((r) => r.ledger_type === 'IGST');
    const ro   = invRows.find((r) => r.ledger_type === 'Round Off');

    const invoice  = invoices.find((i) => i.invoice_number === invNo);
    const supplier = suppliers.find((s) => s.tally_ledger_name === partyRow?.party_ledger);

    // Defect 5 fix: use '' instead of '-' so the isBlank guard catches it at acceptance.
    // The display cell already renders '-' for empty strings via `effectiveVendorLedger || '-'`.
    const vendorLedger    = partyRow?.tally_ledger_name ?? '';
    const vendorSuggested = partyRow?.status === 'Suggested';
    // Yellow-without-✦ warning: supplier name exists in master but GSTIN on invoice didn't match.
    // findSupplier returns null (suggested=true) and falls back to inv.vendor_name as ledger.
    // If that name happens to be in the master under a different/no GSTIN, the value IS in the
    // dropdown list so no ✦ ghost option renders — user needs an ⓘ explanation instead.
    const vendorExistsInMaster = vendorSuggested && suppliers.some((s) => s.tally_ledger_name === vendorLedger);
    const vendorWarning: LedgerWarning | undefined = vendorExistsInMaster ? {
      reason: invoice?.vendor_gstin
        ? `A supplier ledger "${vendorLedger}" exists in the master, but the GSTIN on this invoice (${invoice.vendor_gstin}) does not match the GSTIN stored against that supplier.`
        : `A supplier ledger "${vendorLedger}" exists in the master, but the system could not automatically confirm this is the correct mapping.`,
      meaning: 'The system cannot automatically verify this is the correct supplier ledger, so the mapping is flagged for manual review.',
      action: invoice?.vendor_gstin
        ? `Update this supplier's GSTIN in the Suppliers master to "${invoice.vendor_gstin}", or manually confirm the selected ledger is correct before accepting.`
        : 'Manually confirm the selected ledger is the correct Tally supplier ledger for this vendor before accepting.',
    } : undefined;

    // ONE purchase ledger per invoice — 4-case logic per approved P2 design
    // Case 3 hierarchy (multiple masters, no supplier history):
    //   1. Company-wide most-used PL (companyWidePurchaseLedger) if available
    //   2. First-configured PL (purchaseLedgerMasters[0]) as final fallback
    //   Never blank.
    let invPlLedger: string;
    let invPlCase: 1 | 2 | 3 | 4;
    let invPlHistoricalMissing = false;
    if (invoice?.tally_ledger_acceptance?.purchaseLedger) {
      // Locked: restore the accepted value
      invPlLedger = invoice.tally_ledger_acceptance.purchaseLedger;
      invPlCase = 4;
    } else {
      const supplierKey = invoice?.vendor_gstin
        ? invoice.vendor_gstin
        : `name:${(invoice?.vendor_name ?? '').toLowerCase().trim()}`;
      const rawHistorical = historicalPurchaseLedgers[supplierKey] ?? null;
      // Validate: historical ledger must still exist in current master
      const validHistorical = rawHistorical && purchaseLedgerMasters.includes(rawHistorical) ? rawHistorical : null;
      invPlHistoricalMissing = !!rawHistorical && !validHistorical;
      if (validHistorical) {
        invPlLedger = validHistorical;
        invPlCase = 4;
      } else if (purchaseLedgerMasters.length === 0) {
        invPlLedger = 'Purchase'; // Case 1: bootstrap default
        invPlCase = 1;
      } else if (purchaseLedgerMasters.length === 1) {
        invPlLedger = purchaseLedgerMasters[0]; // Case 2: unambiguous
        invPlCase = 2;
      } else {
        // Case 3: multiple masters, no supplier history.
        // Suggest company-wide most-used PL, falling back to first-configured.
        // Never blank — user can always override via dropdown.
        invPlLedger = companyWidePurchaseLedger ?? purchaseLedgerMasters[0];
        invPlCase = 3;
      }
    }
    const invPlSuggested = !invoice?.tally_ledger_acceptance?.purchaseLedger;

    const charges: FlatDisplayRow['charges'] = chargeRows.map((c) => ({
      desc: c.item_description ?? c.tally_ledger_name,
      ledger: c.tally_ledger_name,
      suggested: c.is_suggested === true,
      amount: c.amount,
      gst_percent: c.charge_gst_percent,
      sac_code: c.charge_sac_code,
    }));
    if (discountPreviewRow && (invoice?.bill_discount_amount ?? 0) > 0) {
      const discountSuggested = discountPreviewRow.is_suggested === true;
      charges.push({
        desc: 'Discount',
        ledger: discountPreviewRow.tally_ledger_name,
        suggested: discountSuggested,
        amount: discountPreviewRow.amount,
        gst_percent: discountPreviewRow.charge_gst_percent,
        isDiscount: true,
      });
    }

    // Tax ledger info lives in base (repeats every row); amounts computed per item
    const invTaxType = (invoice?.tax_type ?? 'none') as 'cgst_sgst' | 'igst' | 'none';
    const invoiceTail = {
      charges,
      roLedger: ro?.tally_ledger_name ?? '',
      roSuggested: ro?.is_suggested === true,
      roAmt:  ro?.amount ?? 0,
    };
    const emptyTail = { charges: [], roLedger: '', roSuggested: false, roAmt: 0 };

    const base = {
      invoiceDate: partyRow?.invoice_date ?? (invoice?.invoice_date ?? ''),
      invoiceNo: invNo,
      voucherType: partyRow?.voucher_type_name ?? '',
      vendorName: partyRow?.vendor_name ?? (invoice?.vendor_name ?? ''),
      vendorLedger,
      vendorSuggested,
      vendorWarning,
      gstin: invoice?.vendor_gstin ?? '',
      gstRegType: supplier ? (supplier.is_unregistered ? 'Unregistered' : 'Regular') : '',
      taxType: invTaxType,
      cgstLedger: cgst?.tally_ledger_name?.startsWith('-') ? '' : (cgst?.tally_ledger_name ?? ''),
      cgstSuggested: cgst?.is_suggested === true,
      sgstLedger: sgst?.tally_ledger_name?.startsWith('-') ? '' : (sgst?.tally_ledger_name ?? ''),
      sgstSuggested: sgst?.is_suggested === true,
      igstLedger: igst?.tally_ledger_name?.startsWith('-') ? '' : (igst?.tally_ledger_name ?? ''),
      igstSuggested: igst?.is_suggested === true,
    };

    const plBase = {
      purchaseLedger: invPlLedger, purchaseLedgerSuggested: invPlSuggested,
      purchaseLedgerCase: invPlCase, purchaseLedgerHistoricalMissing: invPlHistoricalMissing,
    };

    if (isInventoryMode) {
      if (invRows2.length === 0) {
        displayRows.push({
          ...base, isFirst: true, ...invoiceTail, ...plBase,
          itemDesc: '', lineIdx: 0, hsn: '', stockItem: '', stockItemSuggested: false,
          taxRate: null, qty: null, uom: '', rate: null, disc: null,
          amount: Math.abs(partyRow?.amount ?? 0),
          cgstAmt: 0, sgstAmt: 0, igstAmt: 0,
        });
        continue;
      }
      invRows2.forEach((row, idx) => {
        const lineItem = invoice?.line_items.find((li) => li.description === row.item_description);
        displayRows.push({
          ...base,
          isFirst: idx === 0,
          ...(idx === 0 ? invoiceTail : emptyTail),
          ...plBase,
          itemDesc: row.item_description ?? '',
          lineIdx: idx,
          hsn: lineItem?.hsn ?? '',
          stockItem: row.tally_ledger_name ?? '',
          stockItemSuggested: row.is_suggested === true,
          taxRate: lineItem?.gst_percent ?? null,
          cgstAmt: idx === 0 ? (cgst?.amount ?? 0) : 0,
          sgstAmt: idx === 0 ? (sgst?.amount ?? 0) : 0,
          igstAmt: idx === 0 ? (igst?.amount ?? 0) : 0,
          qty:  row.qty ?? null,
          uom:  row.uom ?? '',
          rate: row.rate ?? null,
          disc: row.disc_percent ?? null,
          amount: row.amount,
        });
      });
    } else {
      const lineItems = invoice?.line_items ?? [];
      if (lineItems.length === 0) {
        displayRows.push({
          ...base, isFirst: true, ...invoiceTail, ...plBase,
          itemDesc: '', lineIdx: 0, hsn: '', stockItem: '', stockItemSuggested: false,
          taxRate: null, qty: null, uom: '', rate: null, disc: null,
          amount: Math.abs(partyRow?.amount ?? 0),
          cgstAmt: 0, sgstAmt: 0, igstAmt: 0,
        });
        continue;
      }
      lineItems.forEach((item, idx) => {
        const hsnSuggestion = item.hsn ? `${item.hsn} @ ${item.gst_percent ?? 0}%` : '';
        // For HSN-driven companies, resolve stock item from master by HSN+GST rate
        let resolvedStockItem = hsnSuggestion;
        let resolvedSuggested = !!hsnSuggestion;
        if (stockItemMode === 'hsn_driven' && item.hsn) {
          const cleanHsn = item.hsn.replace(/[\s.]/g, '');
          const match = stockItems.find((s) =>
            s.hsn_code && s.hsn_code.replace(/[\s.]/g, '') === cleanHsn && s.gst_percent === item.gst_percent,
          ) ?? stockItems.find((s) =>
            s.hsn_code && s.hsn_code.replace(/[\s.]/g, '') === cleanHsn,
          );
          if (match) { resolvedStockItem = match.tally_item_name; resolvedSuggested = false; }
        }
        const itemAmt = calcLineAmount(item);
        displayRows.push({
          ...base,
          isFirst: idx === 0,
          ...(idx === 0 ? invoiceTail : emptyTail),
          ...plBase,
          itemDesc: item.description ?? '',
          lineIdx: idx,
          hsn: item.hsn ?? '',
          stockItem: resolvedStockItem,
          stockItemSuggested: resolvedSuggested,
          taxRate: item.gst_percent ?? null,
          qty:  item.qty ?? null,
          uom:  normalizeUomDisplay(item.uom),
          rate: item.rate ?? null,
          disc: (item.disc_percent ?? 0) > 0 ? item.disc_percent : null,
          amount: itemAmt,
          cgstAmt: idx === 0 ? (cgst?.amount ?? 0) : 0,
          sgstAmt: idx === 0 ? (sgst?.amount ?? 0) : 0,
          igstAmt: idx === 0 ? (igst?.amount ?? 0) : 0,
        });
      });
    }
  }

  const maxCharges = Math.max(0, ...displayRows.map((r) => r.charges.length));

  // Filtered invoice set — drives which invoices appear in the table
  const filteredInvoiceNos = React.useMemo(() => {
    const effectiveStatus = cardFilter ?? statusFilter;
    return new Set(invoiceOrder.filter(invNo => {
      const invRows = byInvoice.get(invNo) ?? [];
      const invoice = invoices.find(i => i.invoice_number === invNo);
      const isAccepted = !!lockedInvoices[invNo];
      if (effectiveStatus === 'accepted' && !isAccepted) return false;
      if (effectiveStatus === 'pending_review' && isAccepted) return false;
      if (vendorFilter && !invRows[0]?.vendor_name?.toLowerCase().includes(vendorFilter.toLowerCase())) return false;
      if (invoiceFilter && !invNo.toLowerCase().includes(invoiceFilter.toLowerCase())) return false;
      if (gstinFilter && !(invoice?.vendor_gstin ?? '').toLowerCase().includes(gstinFilter.toLowerCase())) return false;
      if (mappingFilter === 'ai_suggested_new' && !invRows.some(r => r.is_suggested && r.status === 'Suggested')) return false;
      if (mappingFilter === 'new_stock_items' && !displayRows.some(r =>
        r.invoiceNo === invNo && r.itemDesc &&
        pendingStockItems.includes(stockItemEdits[`${invNo}_${r.lineIdx}`] ?? '')
      )) return false;
      return true;
    }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardFilter, statusFilter, vendorFilter, invoiceFilter, gstinFilter, mappingFilter,
      rows, lockedInvoices, pendingStockItems, stockItemEdits]);

  // One checkbox per INVOICE - only for invoices that have at least one suggested field.
  // All unlocked invoices can be selected for acceptance (not just ones with suggestions)
  const suggestableInvoices: string[] = [];
  {
    const seen = new Set<string>();
    for (const row of displayRows) {
      if (!seen.has(row.invoiceNo)) {
        seen.add(row.invoiceNo);
        const hasSuggestions = rows.some((r) => r.invoice_number === row.invoiceNo && r.is_suggested);
        if (!lockedInvoices[row.invoiceNo] || hasSuggestions) suggestableInvoices.push(row.invoiceNo);
      }
    }
  }

  // selectedRows now holds a Set<string> of invoice numbers (re-using state but typed via cast)
  const selectedInvoices = selectedRows as unknown as Set<string>;
  const setSelectedInvoices = setSelectedRows as unknown as React.Dispatch<React.SetStateAction<Set<string>>>;

  const allSelected = suggestableInvoices.length > 0 && suggestableInvoices.every((inv) => selectedInvoices.has(inv));
  const toggleAll = () => {
    if (allSelected) { setSelectedInvoices(new Set()); }
    else { setSelectedInvoices(new Set(suggestableInvoices)); }
  };
  const toggleInvoice = (invNo: string) => setSelectedInvoices((prev) => {
    const s = new Set(prev); s.has(invNo) ? s.delete(invNo) : s.add(invNo); return s;
  });

  const handleBulkAccept = async () => {
    setBulkSaving(true);
    const payloads: InvoiceAcceptPayload[] = [];

    for (const invNo of Array.from(selectedInvoices)) {
      const invRows = displayRows.filter((r) => r.invoiceNo === invNo);
      const firstRow = invRows.find((r) => r.isFirst);
      if (!firstRow) continue;

      const vendorLedger = vendorEdits[firstRow.vendorName] ?? firstRow.vendorLedger;
      const purchaseLedger = purchaseLedgerEdits[invNo] ?? firstRow.purchaseLedger;
      const cgstLedger = taxLedgerEdits.cgst ?? firstRow.cgstLedger;
      const sgstLedger = taxLedgerEdits.sgst ?? firstRow.sgstLedger;
      const igstLedger = taxLedgerEdits.igst ?? firstRow.igstLedger;

      const stockItems: InvoiceAcceptPayload['stockItems'] = [];
      const lockedStock: Record<string, string> = {};
      for (const r of invRows) {
        if (r.itemDesc) {
          const tallyName = stockItemEdits[`${invNo}_${r.lineIdx}`] ?? r.stockItem;
          if (tallyName) {
            stockItems.push({ desc: r.itemDesc, hsn: r.hsn, uom: r.uom, gst_percent: r.taxRate ?? undefined, tallyName });
            lockedStock[r.itemDesc] = tallyName;
          }
        }
      }

      const charges: InvoiceAcceptPayload['charges'] = (firstRow.charges ?? []).map((ch) => ({
        keyword: ch.desc,
        tallyName: chargeEdits[ch.desc] ?? ch.ledger,
        gst_percent: ch.gst_percent,
        sac_code: ch.sac_code,
      }));

      const roLedger = roLedgerEdits[invNo] ?? firstRow.roLedger;

      payloads.push({
        invoiceNo: invNo,
        vendorName: firstRow.vendorName, vendorGstin: firstRow.gstin, vendorLedger,
        purchaseLedger,
        stockItems, charges, lockedStock,
        cgstLedger, sgstLedger, igstLedger,
        roLedger,
        taxType: firstRow.taxType,
      });
    }

    // Defect 4 fix: validate all payloads before any write.
    // Blank, whitespace-only, and '-' values must never be accepted.
    const validationErrors: string[] = [];
    for (const p of payloads) {
      const errsForInv: string[] = [];
      if (isBlank(p.vendorLedger))   errsForInv.push('Vendor Ledger is empty');
      if (isBlank(p.purchaseLedger)) errsForInv.push('Purchase Ledger is empty');
      for (const si of p.stockItems) {
        if (isBlank(si.tallyName)) errsForInv.push(`Stock Item "${si.desc}" is empty`);
      }
      for (const ch of p.charges) {
        if (isBlank(ch.tallyName)) errsForInv.push(`Expense Ledger "${ch.keyword}" is empty`);
      }
      if (p.taxType === 'cgst_sgst') {
        if (isBlank(p.cgstLedger)) errsForInv.push('CGST Ledger is empty');
        if (isBlank(p.sgstLedger)) errsForInv.push('SGST Ledger is empty');
      }
      if (p.taxType === 'igst') {
        if (isBlank(p.igstLedger)) errsForInv.push('IGST Ledger is empty');
      }
      const firstRow = displayRows.find((r) => r.invoiceNo === p.invoiceNo && r.isFirst);
      if (firstRow && Math.abs(firstRow.roAmt) > 0.001 && isBlank(p.roLedger)) {
        errsForInv.push('Round Off Ledger is empty');
      }
      if (errsForInv.length) {
        validationErrors.push(`Invoice ${p.invoiceNo} could not be accepted because:\n• ${errsForInv.join('\n• ')}`);
      }
    }
    if (validationErrors.length) {
      alert(validationErrors.join('\n\n'));
      setBulkSaving(false);
      return;
    }

    try {
      await onAcceptInvoices(payloads);
      // Lock fields locally - no full preview refresh
      setLockedInvoices((prev) => {
        const next = { ...prev };
        for (const p of payloads) {
          const chargesLocked: Record<string, string> = {};
          p.charges.forEach((ch) => { chargesLocked[ch.keyword] = ch.tallyName; });
          next[p.invoiceNo] = {
            vendorLedger: p.vendorLedger,
            purchaseLedger: p.purchaseLedger,
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
      setSelectedInvoices(new Set());
    } finally {
      setBulkSaving(false);
    }
  };

  // Dual-scroll: sync top scrollbar with table scroll
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

  const TH = ({ children, right }: { children: React.ReactNode; right?: boolean }) => (
    <th className={`px-3 py-2.5 border-b border-gray-200 dark:border-gray-700 font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide whitespace-nowrap text-[11px] bg-gray-50 dark:bg-gray-800 ${right ? 'text-right' : 'text-left'}`}>
      {children}
    </th>
  );

  const toggleLockedInvoice = (invNo: string) => setSelectedLockedInvoices((prev) => {
    const s = new Set(prev); s.has(invNo) ? s.delete(invNo) : s.add(invNo); return s;
  });

  const handleBulkUnaccept = async () => {
    if (selectedLockedInvoices.size === 0) return;
    setBulkSaving(true);
    const errs: string[] = [];
    for (const invNo of Array.from(selectedLockedInvoices)) {
      try {
        await saveInvoiceTallyAcceptance(companyId, invNo, null);
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

  // Dashboard counts — computed inside FlatPreviewTable where lockedInvoices state lives
  const dashTotalCount = new Set(rows.map(r => r.invoice_number)).size;
  const dashAcceptedCount = Object.keys(lockedInvoices).length;
  const dashPendingCount = invoiceOrder.filter(invNo => !lockedInvoices[invNo]).length;
  const dashBlockedCount = new Set(rows.filter(r => r.status === 'Skipped').map(r => r.invoice_number)).size;

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
        onClick={() => setCardFilter(p => p === 'accepted' ? null : 'accepted')}
        className={`flex flex-col items-start px-4 py-3 rounded-xl border transition-colors text-left ${cardFilter === 'accepted' ? 'bg-green-100 dark:bg-green-900/40 border-green-400 dark:border-green-600' : 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800 hover:bg-green-100 dark:hover:bg-green-900/30'}`}
      >
        <span className="text-xl font-bold text-green-800 dark:text-green-400">{dashAcceptedCount}</span>
        <span className="text-xs text-green-700 dark:text-green-500 mt-0.5">Accepted – Ready for Export</span>
      </button>
      {dashPendingCount > 0 && (
        <button
          onClick={() => setCardFilter(p => p === 'pending_review' ? null : 'pending_review')}
          className={`flex flex-col items-start px-4 py-3 rounded-xl border transition-colors text-left ${cardFilter === 'pending_review' ? 'bg-amber-100 dark:bg-amber-900/40 border-amber-400 dark:border-amber-600' : 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-700 hover:bg-amber-100 dark:hover:bg-amber-900/30'}`}
        >
          <span className="text-xl font-bold text-amber-800 dark:text-amber-300">{dashPendingCount}</span>
          <span className="text-xs text-amber-700 dark:text-amber-500 mt-0.5">Pending Mapping Reviews</span>
        </button>
      )}
      {dashBlockedCount > 0 && (
        <div className="flex flex-col items-start px-4 py-3 rounded-xl border bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800">
          <span className="text-xl font-bold text-red-800 dark:text-red-400">{dashBlockedCount}</span>
          <span className="text-xs text-red-600 dark:text-red-500 mt-0.5">Blocked</span>
        </div>
      )}
      <div className="flex items-center self-center text-xs text-gray-400 dark:text-gray-500 gap-1 ml-1">
        <span className="font-mono">{dashAcceptedCount} accepted</span>
        <span>+</span>
        <span className="font-mono">{dashPendingCount} pending</span>
        {dashBlockedCount > 0 && <><span>+</span><span className="font-mono">{dashBlockedCount} blocked</span></>}
        <span>=</span>
        <span className="font-mono font-semibold text-gray-600 dark:text-gray-300">{dashTotalCount} total</span>
      </div>
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
    {/* Active card filter pill */}
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
          {selectedInvoices.size > 0 && (
            <button
              onClick={handleBulkAccept}
              disabled={bulkSaving}
              className="px-4 py-1.5 bg-indigo-600 text-white rounded-lg text-xs font-semibold hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {bulkSaving ? 'Saving…' : `Accept ${selectedInvoices.size} invoice${selectedInvoices.size !== 1 ? 's' : ''}`}
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
          {selectedInvoices.size === 0 && selectedLockedInvoices.size === 0 && (
            <span className="text-xs text-amber-700 dark:text-amber-400">✦ Amber fields are AI suggestions — edit if needed, then accept to save to masters</span>
          )}
        </div>
      )}
      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 border-b border-gray-200 dark:border-gray-700 bg-gray-50/60 dark:bg-gray-800/60">
        {/* Status pills */}
        <div className="flex rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden text-xs">
          {(['all', 'accepted', 'pending_review'] as const).map(s => {
            const isActive = cardFilter === null
              ? statusFilter === s
              : (s === 'accepted' && cardFilter === 'accepted') || (s === 'pending_review' && cardFilter === 'pending_review') || (s === 'all' && false);
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
        {/* Vendor filter */}
        <select
          value={vendorFilter}
          onChange={e => setVendorFilter(e.target.value)}
          className="border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1.5 text-xs bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 max-w-[180px]"
        >
          <option value="">All Vendors</option>
          {Array.from(new Set(displayRows.map(r => r.vendorName))).sort().map(v => (
            <option key={v} value={v}>{v}</option>
          ))}
        </select>
        {/* Invoice number filter */}
        <input
          type="text"
          placeholder="Invoice No…"
          value={invoiceFilter}
          onChange={e => setInvoiceFilter(e.target.value)}
          className="border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1.5 text-xs bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 w-28"
        />
        {/* GSTIN filter */}
        <input
          type="text"
          placeholder="GSTIN…"
          value={gstinFilter}
          onChange={e => setGstinFilter(e.target.value)}
          className="border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1.5 text-xs bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 w-36"
        />
        {/* Mapping filter pills */}
        <div className="flex rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden text-xs">
          {([['all', 'All'], ['ai_suggested_new', '✦ AI Suggested New'], ['new_stock_items', 'New Stock Items']] as const).map(([m, label]) => (
            <button
              key={m}
              onClick={() => setMappingFilter(m)}
              className={`px-3 py-1.5 font-medium transition-colors ${mappingFilter === m ? 'bg-amber-500 text-white' : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'}`}
            >
              {label}
            </button>
          ))}
        </div>
        {/* Result count + clear */}
        {filteredInvoiceNos.size !== invoiceOrder.length && (
          <span className="text-xs text-gray-500 dark:text-gray-400">
            Showing {filteredInvoiceNos.size} of {invoiceOrder.length}
          </span>
        )}
        {(cardFilter || statusFilter !== 'all' || vendorFilter || invoiceFilter || gstinFilter || mappingFilter !== 'all') && (
          <button
            onClick={() => { setCardFilter(null); setStatusFilter('all'); setVendorFilter(''); setInvoiceFilter(''); setGstinFilter(''); setMappingFilter('all'); }}
            className="text-xs text-indigo-600 dark:text-indigo-400 hover:underline"
          >
            Clear all
          </button>
        )}
      </div>
      {/* Top scrollbar mirror */}
      <div ref={topScrollRef} onScroll={onTopScroll} className="overflow-x-auto" style={{ height: 12 }}>
        <div style={{ width: tableScrollWidth, height: 1 }} />
      </div>
      {/* Table with sticky header */}
      <div ref={tableContainerRef} onScroll={onTableScroll} className="overflow-x-auto max-h-[70vh] overflow-y-auto">
        <table className="min-w-max text-xs border-collapse">
          <thead className="bg-gray-50 dark:bg-gray-800 sticky top-0 z-10">
            <tr>
              <TH> </TH>
              <TH>Date</TH>
              <TH>Invoice No</TH>
              <TH>Voucher Type</TH>
              <TH>Vendor (Invoice)</TH>
              <TH>Vendor Ledger (Tally)</TH>
              <TH>GSTIN</TH>
              <TH>GST Reg Type</TH>
              <TH>Purchase Ledger (Tally)</TH>
              <TH>Item Name + HSN (Invoice)</TH>
              <TH>Stock Item (Tally)</TH>
              <TH right>Tax Rate %</TH>
              <TH right>Qty</TH>
              <TH>UOM</TH>
              <TH right>Rate (₹)</TH>
              <TH right>Discount %</TH>
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
            {displayRows.map((row, i) => {
              if (!filteredInvoiceNos.has(row.invoiceNo)) return null;
              const prevRow = displayRows[i - 1];
              const isNewInvoice = !prevRow || prevRow.invoiceNo !== row.invoiceNo;
              const locked = lockedInvoices[row.invoiceNo];
              // If any preview row for this invoice has a fresh AI suggestion, treat it as
              // needing re-acceptance even if it was previously accepted.
              const invHasSuggestions = rows.some(
                (r: PreviewRow) => r.invoice_number === row.invoiceNo && r.is_suggested
              );
              const isLocked = !!locked && !invHasSuggestions;
              const rowBg = isLocked ? 'bg-green-50/30 dark:bg-green-900/20' : (isNewInvoice ? 'bg-white dark:bg-gray-800' : 'bg-blue-50/20 dark:bg-blue-900/20');
              const borderTop = isNewInvoice && i > 0 ? 'border-t-2 border-gray-300 dark:border-gray-600' : 'border-t border-gray-100 dark:border-gray-700';
              const isInvSuggestable = !isLocked && suggestableInvoices.includes(row.invoiceNo);
              const isChecked = selectedInvoices.has(row.invoiceNo);

              // For vendor ledger: if the fresh supplier master lookup is definitive (GSTIN matched,
              // not suggested), always use the fresh value - even for locked invoices. This ensures
              // that if the supplier master was corrected after acceptance, the preview and XML reflect
              // the current master, not a stale acceptance snapshot.
              // For all other fields: frozen accepted values take precedence when invoice is locked.
              const effectiveVendorLedger = !row.vendorSuggested
                ? row.vendorLedger
                : (locked?.vendorLedger ?? (vendorEdits[row.vendorName] ?? row.vendorLedger));
              const effectivePurchaseLedger = locked?.purchaseLedger ?? (purchaseLedgerEdits[row.invoiceNo] ?? row.purchaseLedger);
              const effectiveStockItem      = locked?.stock[row.itemDesc] ?? (stockItemEdits[`${row.invoiceNo}_${row.lineIdx}`] ?? row.stockItem);
              const effectiveCgst           = locked?.cgstLedger ?? (taxLedgerEdits.cgst ?? row.cgstLedger);
              const effectiveSgst           = locked?.sgstLedger ?? (taxLedgerEdits.sgst ?? row.sgstLedger);
              const effectiveIgst           = locked?.igstLedger ?? (taxLedgerEdits.igst ?? row.igstLedger);
              const effectiveRo             = locked?.roLedger ?? (roLedgerEdits[row.invoiceNo] ?? row.roLedger);

              // Editable input for any suggested Tally field
              const EditableField = ({ value, suggested, color, onSave, placeholder }: {
                value: string; suggested: boolean; color: string;
                onSave: (v: string) => void; placeholder?: string;
              }) => {
                const [draft, setDraft] = React.useState(value);
                if (!suggested) return <span className={`font-mono font-medium ${color}`}>{value || '-'}</span>;
                return (
                  <div className="flex items-center gap-1 min-w-[140px]">
                    <input
                      type="text"
                      value={draft}
                      placeholder={placeholder ?? 'Enter Tally name…'}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.currentTarget.blur(); } }}
                      onBlur={() => { const v = draft.trim(); if (v) onSave(v); }}
                      className={`border border-amber-300 dark:border-amber-700 rounded px-2 py-0.5 text-xs bg-amber-50 dark:bg-amber-900/20 dark:text-gray-100 focus:ring-1 focus:ring-indigo-400 flex-1 font-mono min-w-0`}
                      title="AI suggestion ✦ - edit and press Enter or click away to save"
                    />
                    <button
                      type="button"
                      onClick={() => { const v = draft.trim(); if (v) onSave(v); }}
                      className="shrink-0 w-5 h-5 flex items-center justify-center rounded bg-indigo-600 text-white text-[10px] hover:bg-indigo-700"
                      title="Save"
                    >✓</button>
                  </div>
                );
              };

              // Vendor ledger: dropdown if master exists, input otherwise
              const editedVendor = vendorEdits[row.vendorName];
              const vendorDisplayVal = editedVendor ?? row.vendorLedger;

              // Per-row tax ledger display values (shared across all rows via taxLedgerEdits)
              const cgstDisplay = taxLedgerEdits.cgst ?? row.cgstLedger;
              const sgstDisplay = taxLedgerEdits.sgst ?? row.sgstLedger;
              const igstDisplay = taxLedgerEdits.igst ?? row.igstLedger;

              return (
                <tr key={i} className={`${rowBg} ${borderTop} hover:bg-yellow-50/40 dark:hover:bg-gray-700/50 transition-colors`}>
                  {/* Checkbox / accepted badge - one per invoice, on the first row only */}
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
                    {row.isFirst && !isLocked && isInvSuggestable && (
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
                    <span className="inline-block font-mono text-[11px] px-2 py-0.5 rounded bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300">{row.voucherType}</span>
                  </td>
                  {/* Vendor Name */}
                  <td className="px-3 py-2 max-w-[160px] truncate text-gray-700 dark:text-gray-300" title={row.vendorName}>{row.vendorName}</td>
                  {/* Vendor Ledger — dropdown with create-new + ⓘ warning */}
                  <td className="px-3 py-2 min-w-[180px]">
                    {isLocked ? (
                      <span className="font-mono font-medium text-purple-800">{effectiveVendorLedger || '-'}</span>
                    ) : (
                      <CreatableLedgerDropdown
                        value={vendorEdits[row.vendorName] ?? row.vendorLedger}
                        options={suppliers.map((s) => s.tally_ledger_name)}
                        pendingOptions={pendingSuppliers}
                        suggested={row.vendorSuggested}
                        warning={row.vendorWarning}
                        freetext={supplierFreetext[`${row.invoiceNo}_${row.lineIdx}`] ?? false}
                        createLabel="New supplier ledger name…"
                        onSelect={(v) => setVendorEdits((p) => ({ ...p, [row.vendorName]: v }))}
                        onStartCreate={() => setSupplierFreetext((p) => ({ ...p, [`${row.invoiceNo}_${row.lineIdx}`]: true }))}
                        onConfirmCreate={(v) => {
                          setPendingSuppliers((p) => p.includes(v) ? p : [...p, v]);
                          setVendorEdits((p) => ({ ...p, [row.vendorName]: v }));
                          setSupplierFreetext((p) => ({ ...p, [`${row.invoiceNo}_${row.lineIdx}`]: false }));
                        }}
                        onCancelCreate={() => setSupplierFreetext((p) => ({ ...p, [`${row.invoiceNo}_${row.lineIdx}`]: false }))}
                      />
                    )}
                  </td>
                  {/* GSTIN */}
                  <td className="px-3 py-2 font-mono text-gray-400 dark:text-gray-500 whitespace-nowrap text-[11px]">{row.gstin || '-'}</td>
                  {/* Reg Type */}
                  <td className="px-3 py-2 whitespace-nowrap">
                    {row.gstRegType && (
                      <span className={`inline-block text-[11px] px-1.5 py-0.5 rounded font-medium ${row.gstRegType === 'Unregistered' ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400' : 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400'}`}>
                        {row.gstRegType}
                      </span>
                    )}
                  </td>
                  {/* Purchase Ledger — dropdown with 4-case logic */}
                  <td className="px-3 py-2 min-w-[200px]">
                    {isLocked ? (
                      <span className="font-mono font-medium text-blue-800">{effectivePurchaseLedger || '-'}</span>
                    ) : purchaseLedgerCreating[`${row.invoiceNo}_${row.lineIdx}`] ? (
                      // Inline create-new input
                      <div className="flex items-center gap-1">
                        <input
                          autoFocus
                          type="text"
                          placeholder="New ledger name…"
                          className="border border-indigo-300 dark:border-indigo-800 rounded px-2 py-0.5 text-xs bg-indigo-50 dark:bg-indigo-900/30 dark:text-gray-100 flex-1 font-mono"
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              const v = e.currentTarget.value.trim();
                              if (v) {
                                setPendingPurchaseLedgers((p) => p.includes(v) ? p : [...p, v]);
                                setPurchaseLedgerEdits((p) => ({ ...p, [row.invoiceNo]: v }));
                                setPurchaseLedgerCreating((p) => ({ ...p, [`${row.invoiceNo}_${row.lineIdx}`]: false }));
                              }
                            }
                            if (e.key === 'Escape') setPurchaseLedgerCreating((p) => ({ ...p, [`${row.invoiceNo}_${row.lineIdx}`]: false }));
                          }}
                          onBlur={(e) => {
                            // Only confirm on non-empty blur; never auto-cancel on empty.
                            const v = e.currentTarget.value.trim();
                            if (v) {
                              setPendingPurchaseLedgers((p) => p.includes(v) ? p : [...p, v]);
                              setPurchaseLedgerEdits((p) => ({ ...p, [row.invoiceNo]: v }));
                              setPurchaseLedgerCreating((p) => ({ ...p, [`${row.invoiceNo}_${row.lineIdx}`]: false }));
                            }
                          }}
                        />
                      </div>
                    ) : (
                      <div className="flex items-center gap-1">
                        <select
                          value={purchaseLedgerEdits[row.invoiceNo] ?? row.purchaseLedger}
                          onChange={(e) => {
                            if (e.target.value === '__new__') {
                              setPurchaseLedgerCreating((p) => ({ ...p, [`${row.invoiceNo}_${row.lineIdx}`]: true }));
                              return;
                            }
                            // Defect 1 fix: never store blank from dropdown (e.g. if browser resets selection)
                            if (!e.target.value) return;
                            setPurchaseLedgerEdits((p) => ({ ...p, [row.invoiceNo]: e.target.value }));
                          }}
                          className={`border rounded px-2 py-1 text-xs w-full dark:text-gray-100 ${
                            row.purchaseLedgerCase === 3 || row.purchaseLedgerCase === 4 || row.purchaseLedgerCase === 1
                              ? 'border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20' : 'border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700'
                          }`}
                        >
                          {/* No placeholder option — Case 3 always has a suggestion pre-selected */}
                          {/* Show current value if not in master or pending list */}
                          {(() => {
                            const cur = purchaseLedgerEdits[row.invoiceNo] ?? row.purchaseLedger;
                            const allOpts = [...purchaseLedgerMasters, ...pendingPurchaseLedgers];
                            if (cur && !allOpts.includes(cur)) {
                              return <option value={cur}>{cur}{row.purchaseLedgerCase !== 2 ? ' ✦' : ''}</option>;
                            }
                            return null;
                          })()}
                          {purchaseLedgerMasters.map((name) => <option key={name} value={name}>{name}</option>)}
                          {pendingPurchaseLedgers.map((name) => <option key={`pending_${name}`} value={name}>{name} (new)</option>)}
                          <option value="__new__">+ Create new…</option>
                        </select>
                        {(row.purchaseLedgerCase === 3 || row.purchaseLedgerCase === 4 || row.purchaseLedgerHistoricalMissing) && (
                          <span
                            className="shrink-0 text-amber-500 dark:text-amber-400 cursor-help text-sm"
                            title={
                              row.purchaseLedgerHistoricalMissing
                                ? 'The previously used Purchase Ledger for this supplier no longer exists in the master. Showing the most-used company-wide ledger as a fallback. Please verify.'
                                : row.purchaseLedgerCase === 3
                                ? (companyWidePurchaseLedger
                                    ? 'Multiple Purchase Ledgers are configured. No prior invoices found for this supplier. This suggestion is the most frequently accepted Purchase Ledger across your company\'s invoices. Please verify before accepting.'
                                    : 'Multiple Purchase Ledgers are configured. No accepted invoice history found to guide a suggestion. Showing the first-configured ledger. Please verify before accepting.')
                                : 'Selected based on historical mapping for this supplier. Please verify.'
                            }
                          >ⓘ</span>
                        )}
                      </div>
                    )}
                  </td>
                  {/* Item Name + HSN */}
                  <td className="px-3 py-2 max-w-[220px]">
                    <div className="truncate text-gray-800 dark:text-gray-200" title={row.itemDesc}>{row.itemDesc || '-'}</div>
                    {row.hsn && <div className="text-gray-400 dark:text-gray-500 font-mono text-[10px]">HSN: {row.hsn}</div>}
                  </td>
                  {/* Stock Item — dropdown with create-new in inventory mode */}
                  <td className="px-3 py-2 min-w-[180px]">
                    {isLocked ? (
                      <span className="font-mono text-indigo-700">{effectiveStockItem || '-'}</span>
                    ) : isInventoryMode && (stockItems.length > 0 || pendingStockItems.length > 0) ? (
                      <CreatableLedgerDropdown
                        value={stockItemEdits[`${row.invoiceNo}_${row.lineIdx}`] ?? row.stockItem}
                        options={stockItems.map((s) => s.tally_item_name)}
                        pendingOptions={pendingStockItems}
                        suggested={row.stockItemSuggested}
                        freetext={stockItemFreetext[`${row.invoiceNo}_${row.lineIdx}`] ?? false}
                        createLabel="New Tally stock item name…"
                        onSelect={(v) => {
                          // Determine if the chosen name is the HSN@GST% pattern for THIS item.
                          // Only show the propagation dialog when the pattern matches exactly.
                          const expectedPattern = row.hsn
                            ? `${row.hsn} @ ${row.taxRate ?? 0}%`
                            : `${row.itemDesc} @ ${row.taxRate ?? 0}%`;
                          const isPatternMatch = v.trim() === expectedPattern.trim();
                          // Check whether other unresolved candidates exist (same invoice or global).
                          const otherSameInvoice = displayRows.some(r =>
                            r.invoiceNo === row.invoiceNo &&
                            r.lineIdx !== row.lineIdx &&
                            r.itemDesc &&
                            r.stockItemSuggested &&
                            !stockItemEdits[`${r.invoiceNo}_${r.lineIdx}`]
                          );
                          const otherGlobal = displayRows.some(r =>
                            !(r.invoiceNo === row.invoiceNo && r.lineIdx === row.lineIdx) &&
                            r.itemDesc && r.stockItemSuggested &&
                            !lockedInvoices[r.invoiceNo] &&
                            !stockItemEdits[`${r.invoiceNo}_${r.lineIdx}`]
                          );
                          if (isPatternMatch && (otherSameInvoice || otherGlobal)) {
                            // Defer the write — dialog will commit it when user chooses.
                            setStockConfirm({ invoiceNo: row.invoiceNo, itemDesc: row.itemDesc, lineIdx: row.lineIdx, hsn: row.hsn, gstPct: row.taxRate, suggestedName: row.stockItem, chosenName: v });
                          } else {
                            // No dialog needed — write immediately.
                            setStockItemEdits((p) => ({ ...p, [`${row.invoiceNo}_${row.lineIdx}`]: v }));
                          }
                        }}
                        onStartCreate={() => setStockItemFreetext((p) => ({ ...p, [`${row.invoiceNo}_${row.lineIdx}`]: true }))}
                        onConfirmCreate={(v) => {
                          setPendingStockItems((p) => p.includes(v) ? p : [...p, v]);
                          setStockItemFreetext((p) => ({ ...p, [`${row.invoiceNo}_${row.lineIdx}`]: false }));
                          // Apply the same pattern-match check as onSelect — user may type the HSN pattern.
                          const expectedPattern = row.hsn
                            ? `${row.hsn} @ ${row.taxRate ?? 0}%`
                            : `${row.itemDesc} @ ${row.taxRate ?? 0}%`;
                          const isPatternMatch = v.trim() === expectedPattern.trim();
                          const otherSameInvoice = displayRows.some(r =>
                            r.invoiceNo === row.invoiceNo && r.lineIdx !== row.lineIdx &&
                            r.itemDesc && r.stockItemSuggested && !stockItemEdits[`${r.invoiceNo}_${r.lineIdx}`]
                          );
                          const otherGlobal = displayRows.some(r =>
                            !(r.invoiceNo === row.invoiceNo && r.lineIdx === row.lineIdx) && r.itemDesc && r.stockItemSuggested &&
                            !lockedInvoices[r.invoiceNo] && !stockItemEdits[`${r.invoiceNo}_${r.lineIdx}`]
                          );
                          if (isPatternMatch && (otherSameInvoice || otherGlobal)) {
                            setStockConfirm({ invoiceNo: row.invoiceNo, itemDesc: row.itemDesc, lineIdx: row.lineIdx, hsn: row.hsn, gstPct: row.taxRate, suggestedName: row.stockItem, chosenName: v });
                          } else {
                            setStockItemEdits((p) => ({ ...p, [`${row.invoiceNo}_${row.lineIdx}`]: v }));
                          }
                        }}
                        onCancelCreate={() => setStockItemFreetext((p) => ({ ...p, [`${row.invoiceNo}_${row.lineIdx}`]: false }))}
                      />
                    ) : isInventoryMode ? (
                      <EditableField
                        value={stockItemEdits[`${row.invoiceNo}_${row.lineIdx}`] ?? row.stockItem}
                        suggested={row.stockItemSuggested} color="text-indigo-700"
                        onSave={(v) => {
                          const expectedPattern = row.hsn
                            ? `${row.hsn} @ ${row.taxRate ?? 0}%`
                            : `${row.itemDesc} @ ${row.taxRate ?? 0}%`;
                          const otherSameInvoice = displayRows.some(r =>
                            r.invoiceNo === row.invoiceNo && r.lineIdx !== row.lineIdx && r.itemDesc &&
                            r.stockItemSuggested && !stockItemEdits[`${r.invoiceNo}_${r.lineIdx}`]
                          );
                          const otherGlobal = displayRows.some(r =>
                            !(r.invoiceNo === row.invoiceNo && r.lineIdx === row.lineIdx) &&
                            r.itemDesc && r.stockItemSuggested && !lockedInvoices[r.invoiceNo] &&
                            !stockItemEdits[`${r.invoiceNo}_${r.lineIdx}`]
                          );
                          if (v.trim() === expectedPattern.trim() && (otherSameInvoice || otherGlobal)) {
                            setStockConfirm({ invoiceNo: row.invoiceNo, itemDesc: row.itemDesc, lineIdx: row.lineIdx, hsn: row.hsn, gstPct: row.taxRate, suggestedName: row.stockItem, chosenName: v });
                          } else {
                            setStockItemEdits((p) => ({ ...p, [`${row.invoiceNo}_${row.lineIdx}`]: v }));
                          }
                        }} />
                    ) : (
                      <span className="font-mono text-indigo-700">{row.stockItem || ''}</span>
                    )}
                  </td>
                  {/* Tax Rate */}
                  <td className="px-3 py-2 text-right text-gray-600 dark:text-gray-400">{row.taxRate != null ? `${row.taxRate}%` : '-'}</td>
                  {/* Qty */}
                  <td className="px-3 py-2 text-right font-mono text-gray-700 dark:text-gray-300">{row.qty != null ? row.qty : '-'}</td>
                  {/* UOM */}
                  <td className="px-3 py-2 text-gray-500 dark:text-gray-400">{row.uom || '-'}</td>
                  {/* Rate */}
                  <td className="px-3 py-2 text-right font-mono text-gray-700 dark:text-gray-300">{row.rate != null ? row.rate.toFixed(2) : '-'}</td>
                  {/* Disc */}
                  <td className="px-3 py-2 text-right text-gray-500 dark:text-gray-400">{row.disc != null && row.disc > 0 ? `${row.disc}%` : '-'}</td>
                  {/* Amount */}
                  <td className="px-3 py-2 text-right font-mono font-semibold text-gray-900 dark:text-gray-100">
                    {row.amount.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </td>
                  {/* Charges - only on first row of invoice */}
                  {Array.from({ length: maxCharges }, (_, ci) => {
                    const ch = row.isFirst ? row.charges[ci] : undefined;
                    return (
                      <React.Fragment key={`ch${ci}`}>
                        <td className="px-3 py-2 text-gray-600 dark:text-gray-400">{ch?.desc ?? ''}</td>
                        <td className="px-3 py-2 min-w-[160px]">
                          {ch && (
                            isLocked ? (
                              // C9 fix: read locked value from tally_ledger_acceptance.charges
                              <span className={`font-mono ${ch.isDiscount ? 'text-pink-700' : 'text-orange-700'}`}>
                                {(locked?.charges?.[ch.desc] ?? ch.ledger) || '-'}
                              </span>
                            ) : chargeFreetext[ch.desc] ? (
                              <InlineCreateInput
                                placeholder="New charge ledger name…"
                                onConfirm={(v) => { setChargeEdits((p) => ({ ...p, [ch.desc]: v })); setChargeFreetext((p) => ({ ...p, [ch.desc]: false })); }}
                                onCancel={() => setChargeFreetext((p) => ({ ...p, [ch.desc]: false }))}
                              />
                            ) : expenseLedgers.length > 0 ? (
                              // C6: always show dropdown before acceptance
                              <select
                                value={chargeEdits[ch.desc] ?? ch.ledger}
                                onChange={(e) => {
                                  if (e.target.value === '__new__') {
                                    setChargeFreetext((p) => ({ ...p, [ch.desc]: true }));
                                    return;
                                  }
                                  if (!e.target.value) return;
                                  setChargeEdits((p) => ({ ...p, [ch.desc]: e.target.value }));
                                }}
                                className={`border rounded px-2 py-1 text-xs w-full dark:text-gray-100 ${ch.suggested ? 'border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20' : 'border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700'}`}
                              >
                                {!expenseLedgers.some((l) => l.tally_ledger_name === (chargeEdits[ch.desc] ?? ch.ledger)) && (
                                  <option value={chargeEdits[ch.desc] ?? ch.ledger}>
                                    {chargeEdits[ch.desc] ?? ch.ledger}{ch.suggested ? ' ✦' : ''}
                                  </option>
                                )}
                                {expenseLedgers.map((l) => <option key={l.tally_ledger_name} value={l.tally_ledger_name}>{l.tally_ledger_name}</option>)}
                                <option value="__new__">+ Create new ledger…</option>
                              </select>
                            ) : (
                              <EditableField value={chargeEdits[ch.desc] ?? ch.ledger} suggested={ch.suggested}
                                color={ch.isDiscount ? 'text-pink-700' : 'text-orange-700'}
                                onSave={(v) => { setChargeEdits((p) => ({ ...p, [ch.desc]: v })); }} />
                            )
                          )}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-gray-700 dark:text-gray-300">
                          {ch ? ch.amount.toLocaleString('en-IN', { minimumFractionDigits: 2 }) : ''}
                        </td>
                      </React.Fragment>
                    );
                  })}
                  {/* CGST — dropdown with create-new */}
                  <td className="px-3 py-2 min-w-[160px]">
                    {row.taxType === 'cgst_sgst' && (() => {
                      const cgstOpts = dutiesTaxesMasters.filter((d) => d.tax_component === 'CGST').map((d) => d.tally_ledger_name);
                      return isLocked
                        ? <span className="font-mono font-medium text-teal-700">{effectiveCgst || '-'}</span>
                        : <CreatableLedgerDropdown
                            value={taxLedgerEdits.cgst ?? row.cgstLedger}
                            options={cgstOpts}
                            pendingOptions={pendingCgst}
                            suggested={row.cgstSuggested}
                            freetext={cgstFreetext[`${row.invoiceNo}_${row.lineIdx}`] ?? false}
                            createLabel="New CGST ledger name…"
                            onSelect={(v) => { setTaxLedgerEdits((p) => ({ ...p, cgst: v })); onMapTaxLedger('CGST', v); }}
                            onStartCreate={() => setCgstFreetext((p) => ({ ...p, [`${row.invoiceNo}_${row.lineIdx}`]: true }))}
                            onConfirmCreate={(v) => {
                              setPendingCgst((p) => p.includes(v) ? p : [...p, v]);
                              setTaxLedgerEdits((p) => ({ ...p, cgst: v }));
                              onMapTaxLedger('CGST', v);
                              setCgstFreetext((p) => ({ ...p, [`${row.invoiceNo}_${row.lineIdx}`]: false }));
                            }}
                            onCancelCreate={() => setCgstFreetext((p) => ({ ...p, [`${row.invoiceNo}_${row.lineIdx}`]: false }))}
                          />;
                    })()}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-gray-700 dark:text-gray-300">
                    {row.taxType === 'cgst_sgst' && row.cgstAmt !== 0 ? row.cgstAmt.toFixed(2) : ''}
                  </td>
                  {/* SGST — dropdown with create-new */}
                  <td className="px-3 py-2 min-w-[160px]">
                    {row.taxType === 'cgst_sgst' && (() => {
                      const sgstOpts = dutiesTaxesMasters.filter((d) => d.tax_component === 'SGST').map((d) => d.tally_ledger_name);
                      return isLocked
                        ? <span className="font-mono font-medium text-teal-700">{effectiveSgst || '-'}</span>
                        : <CreatableLedgerDropdown
                            value={taxLedgerEdits.sgst ?? row.sgstLedger}
                            options={sgstOpts}
                            pendingOptions={pendingSgst}
                            suggested={row.sgstSuggested}
                            freetext={sgstFreetext[`${row.invoiceNo}_${row.lineIdx}`] ?? false}
                            createLabel="New SGST ledger name…"
                            onSelect={(v) => { setTaxLedgerEdits((p) => ({ ...p, sgst: v })); onMapTaxLedger('SGST', v); }}
                            onStartCreate={() => setSgstFreetext((p) => ({ ...p, [`${row.invoiceNo}_${row.lineIdx}`]: true }))}
                            onConfirmCreate={(v) => {
                              setPendingSgst((p) => p.includes(v) ? p : [...p, v]);
                              setTaxLedgerEdits((p) => ({ ...p, sgst: v }));
                              onMapTaxLedger('SGST', v);
                              setSgstFreetext((p) => ({ ...p, [`${row.invoiceNo}_${row.lineIdx}`]: false }));
                            }}
                            onCancelCreate={() => setSgstFreetext((p) => ({ ...p, [`${row.invoiceNo}_${row.lineIdx}`]: false }))}
                          />;
                    })()}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-gray-700 dark:text-gray-300">
                    {row.taxType === 'cgst_sgst' && row.sgstAmt !== 0 ? row.sgstAmt.toFixed(2) : ''}
                  </td>
                  {/* IGST — dropdown with create-new */}
                  <td className="px-3 py-2 min-w-[160px]">
                    {row.taxType === 'igst' && (() => {
                      const igstOpts = dutiesTaxesMasters.filter((d) => d.tax_component === 'IGST').map((d) => d.tally_ledger_name);
                      return isLocked
                        ? <span className="font-mono font-medium text-cyan-700">{effectiveIgst || '-'}</span>
                        : <CreatableLedgerDropdown
                            value={taxLedgerEdits.igst ?? row.igstLedger}
                            options={igstOpts}
                            pendingOptions={pendingIgst}
                            suggested={row.igstSuggested}
                            freetext={igstFreetext[`${row.invoiceNo}_${row.lineIdx}`] ?? false}
                            createLabel="New IGST ledger name…"
                            onSelect={(v) => { setTaxLedgerEdits((p) => ({ ...p, igst: v })); onMapTaxLedger('IGST', v); }}
                            onStartCreate={() => setIgstFreetext((p) => ({ ...p, [`${row.invoiceNo}_${row.lineIdx}`]: true }))}
                            onConfirmCreate={(v) => {
                              setPendingIgst((p) => p.includes(v) ? p : [...p, v]);
                              setTaxLedgerEdits((p) => ({ ...p, igst: v }));
                              onMapTaxLedger('IGST', v);
                              setIgstFreetext((p) => ({ ...p, [`${row.invoiceNo}_${row.lineIdx}`]: false }));
                            }}
                            onCancelCreate={() => setIgstFreetext((p) => ({ ...p, [`${row.invoiceNo}_${row.lineIdx}`]: false }))}
                          />;
                    })()}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-gray-700 dark:text-gray-300">
                    {row.taxType === 'igst' && row.igstAmt !== 0 ? row.igstAmt.toFixed(2) : ''}
                  </td>
                  {/* Round Off — dropdown with create-new */}
                  <td className="px-3 py-2 min-w-[160px]">
                    {row.isFirst && row.roAmt !== 0 && (() => {
                      const roOpts = expenseLedgers.filter((e) => e.expense_keyword === 'Round Off' || e.expense_keyword === 'round off').map((e) => e.tally_ledger_name);
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
                  <td className="px-3 py-2 text-right font-mono text-gray-500 dark:text-gray-400">{row.isFirst && row.roAmt !== 0 ? row.roAmt.toFixed(2) : ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Stock item naming pattern popup */}
      {stockConfirm && (() => {
        const sameInvoiceCandidates = displayRows.filter(r =>
          r.invoiceNo === stockConfirm.invoiceNo &&
          r.lineIdx !== stockConfirm.lineIdx &&
          r.itemDesc &&
          r.stockItemSuggested &&
          !stockItemEdits[`${r.invoiceNo}_${r.lineIdx}`]
        );
        const globalCandidateInvoiceNos = new Set(
          displayRows.filter(r =>
            !(r.invoiceNo === stockConfirm.invoiceNo && r.lineIdx === stockConfirm.lineIdx) &&
            r.itemDesc &&
            r.stockItemSuggested &&
            !lockedInvoices[r.invoiceNo] &&
            !stockItemEdits[`${r.invoiceNo}_${r.lineIdx}`]
          ).map(r => r.invoiceNo)
        );
        const applyPatternToRows = (targets: typeof displayRows) => {
          targets.forEach(r => {
            const inv = invoices.find(i => i.invoice_number === r.invoiceNo);
            const li = inv?.line_items.find(l => l.description === r.itemDesc);
            if (li) {
              const name = li.hsn ? `${li.hsn} @ ${li.gst_percent ?? 0}%` : `${li.description} @ ${li.gst_percent ?? 0}%`;
              setStockItemEdits(p => ({ ...p, [`${r.invoiceNo}_${r.lineIdx}`]: name }));
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
                    // Write the current item first, then apply pattern to same-invoice candidates.
                    setStockItemEdits(p => ({ ...p, [`${stockConfirm.invoiceNo}_${stockConfirm.lineIdx}`]: stockConfirm.chosenName }));
                    applyPatternToRows(sameInvoiceCandidates);
                    setStockConfirm(null);
                  }}
                  className="w-full text-left px-4 py-3 rounded-lg border border-gray-200 dark:border-gray-600 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 transition-colors"
                >
                  <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">Apply to this invoice only</div>
                  <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                    {sameInvoiceCandidates.length === 0
                      ? 'No other suggested items on this invoice'
                      : `${sameInvoiceCandidates.length} other suggested item${sameInvoiceCandidates.length !== 1 ? 's' : ''} on this invoice will be updated`}
                  </div>
                </button>
                <button
                  onClick={() => {
                    const allCandidates = displayRows.filter(r =>
                      !(r.invoiceNo === stockConfirm.invoiceNo && r.lineIdx === stockConfirm.lineIdx) &&
                      r.itemDesc &&
                      r.stockItemSuggested &&
                      !lockedInvoices[r.invoiceNo] &&
                      !stockItemEdits[`${r.invoiceNo}_${r.lineIdx}`]
                    );
                    // Write the current item first, then apply pattern globally.
                    setStockItemEdits(p => ({ ...p, [`${stockConfirm.invoiceNo}_${stockConfirm.lineIdx}`]: stockConfirm.chosenName }));
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
                    // Write ONLY this item — no propagation.
                    setStockItemEdits(p => ({ ...p, [`${stockConfirm.invoiceNo}_${stockConfirm.lineIdx}`]: stockConfirm.chosenName }));
                    setStockConfirm(null);
                  }}
                  className="w-full text-left px-4 py-3 rounded-lg border border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
                >
                  <div className="text-sm font-semibold text-gray-700 dark:text-gray-300">No – map individually</div>
                  <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">Only this item is updated. Other suggested items remain unchanged.</div>
                </button>
                <button
                  onClick={() => {
                    // Discard the pending selection — nothing is written.
                    setStockConfirm(null);
                  }}
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


// ─── Suggestions panel (unused - kept for reference) ─────────────────────────

function SuggestionsPanel({
  previewRows, invoices, onAccept,
}: {
  previewRows: import('@/lib/xmlGenerator').PreviewRow[];
  invoices: StoredInvoice[];
  onAccept: (items: SuggestionItem[]) => Promise<void>;
}) {
  // Deduplicate suggestions from preview rows
  const suggestions = React.useMemo<SuggestionItem[]>(() => {
    const vendorSeen = new Set<string>();
    const stockSeen  = new Set<string>();
    const expSeen    = new Set<string>();
    const out: SuggestionItem[] = [];

    for (const r of previewRows) {
      if (!r.is_suggested) continue;
      if (r.ledger_type === 'Party') {
        if (!vendorSeen.has(r.vendor_name)) {
          vendorSeen.add(r.vendor_name);
          const inv = invoices.find((i) => i.vendor_name === r.vendor_name);
          out.push({ kind: 'vendor', vendorName: r.vendor_name, gstin: inv?.vendor_gstin ?? '', ledger: r.tally_ledger_name });
        }
      } else if (r.ledger_type === 'Inventory') {
        const key = r.item_description ?? '';
        if (key && !stockSeen.has(key)) {
          stockSeen.add(key);
          out.push({ kind: 'stock', desc: key, hsn: r.tally_ledger_name.split(' @ ')[0] ?? '', tallyName: r.tally_ledger_name });
        }
      } else if (r.ledger_type === 'Expense') {
        const key = r.tally_ledger_name;
        if (key && !expSeen.has(key)) {
          expSeen.add(key);
          out.push({ kind: 'expense', keyword: key, tallyName: key });
        }
      }
    }
    return out;
  }, [previewRows, invoices]);

  // Per-item editable names (key = index)
  const [names, setNames] = React.useState<Record<number, string>>({});
  const [selected, setSelected] = React.useState<Set<number>>(new Set());
  const [saving, setSaving] = React.useState(false);
  const [savedCount, setSavedCount] = React.useState(0);

  // Reset when suggestions change
  React.useEffect(() => {
    setNames({});
    const all = new Set(suggestions.map((_, i) => i));
    setSelected(all);
    setSavedCount(0);
  }, [suggestions.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const allChecked = selected.size === suggestions.length && suggestions.length > 0;
  const toggleAll = () => setSelected(allChecked ? new Set() : new Set(suggestions.map((_, i) => i)));
  const toggleOne = (i: number) => setSelected((prev) => { const s = new Set(prev); s.has(i) ? s.delete(i) : s.add(i); return s; });

  const handleAccept = async () => {
    setSaving(true);
    const items: SuggestionItem[] = [];
    selected.forEach((i) => {
      const base = suggestions[i];
      const override = names[i]?.trim();
      if (!override && !base) return;
      if (base.kind === 'vendor')  items.push({ ...base, ledger:    override || base.ledger });
      if (base.kind === 'stock')   items.push({ ...base, tallyName: override || base.tallyName });
      if (base.kind === 'expense') items.push({ ...base, tallyName: override || base.tallyName });
    });
    try { await onAccept(items); setSavedCount(items.length); }
    finally { setSaving(false); }
  };

  if (suggestions.length === 0) return null;

  const vendors  = suggestions.filter((s) => s.kind === 'vendor');
  const stocks   = suggestions.filter((s) => s.kind === 'stock');
  const expenses = suggestions.filter((s) => s.kind === 'expense');

  const Section = ({ title, color, items }: { title: string; color: string; items: SuggestionItem[] }) => {
    if (items.length === 0) return null;
    return (
      <div>
        <p className={`text-xs font-semibold uppercase tracking-wide mb-1 ${color}`}>{title}</p>
        <div className="space-y-1">
          {items.map((item) => {
            const idx = suggestions.indexOf(item);
            const checked = selected.has(idx);
            const editedName = names[idx];
            const defaultName = item.kind === 'vendor' ? item.ledger : item.tallyName;
            const invoiceName = item.kind === 'vendor' ? item.vendorName : item.kind === 'stock' ? item.desc : item.keyword;
            return (
              <div key={idx} className="flex items-center gap-2">
                <input type="checkbox" checked={checked} onChange={() => toggleOne(idx)}
                  className="rounded border-gray-300 dark:border-gray-600 text-indigo-600 focus:ring-indigo-500 shrink-0" />
                <span className="text-gray-500 dark:text-gray-400 text-xs w-40 truncate shrink-0" title={invoiceName}>{invoiceName}</span>
                <span className="text-gray-400 dark:text-gray-500 text-xs">→</span>
                <input
                  type="text"
                  defaultValue={defaultName}
                  onChange={(e) => setNames((prev) => ({ ...prev, [idx]: e.target.value }))}
                  className="flex-1 border border-amber-200 dark:border-amber-700 rounded px-2 py-0.5 text-xs font-mono bg-amber-50 dark:bg-amber-900/20 dark:text-gray-100 focus:ring-1 focus:ring-indigo-400 min-w-0"
                  placeholder="Tally name…"
                />
                {editedName && editedName !== defaultName && (
                  <span className="text-[10px] text-amber-600 dark:text-amber-400 shrink-0">edited</span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <div className="border border-amber-200 dark:border-amber-700 rounded-xl bg-amber-50/50 dark:bg-amber-900/20 px-5 py-4 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold text-amber-800 dark:text-amber-300">
            ✦ {suggestions.length} AI suggestion{suggestions.length !== 1 ? 's' : ''} - review and accept to save to masters
          </span>
          {savedCount > 0 && (
            <span className="text-xs text-green-700 dark:text-green-400 bg-green-100 dark:bg-green-900/30 border border-green-200 dark:border-green-800 rounded px-2 py-0.5">{savedCount} saved ✓</span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-400 cursor-pointer select-none">
            <input type="checkbox" checked={allChecked} onChange={toggleAll}
              className="rounded border-gray-300 dark:border-gray-600 text-indigo-600 focus:ring-indigo-500" />
            Select all
          </label>
          <button
            onClick={handleAccept}
            disabled={saving || selected.size === 0}
            className="px-4 py-1.5 bg-indigo-600 text-white rounded-lg text-xs font-semibold hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {saving ? 'Saving…' : `Accept Selected (${selected.size})`}
          </button>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Section title={`Vendor Ledgers (${vendors.length})`}  color="text-purple-700" items={vendors} />
        <Section title={`Stock Items (${stocks.length})`}      color="text-indigo-700 dark:text-indigo-300" items={stocks} />
        <Section title={`Expense Ledgers (${expenses.length})`} color="text-orange-700" items={expenses} />
      </div>
    </div>
  );
}

// ─── Shared master loader ─────────────────────────────────────────────────────

async function loadMasters(companyId: string) {
  const [suppliers, dutiesTaxes, stockItems, expenseLedgers, voucherTypes, purchaseLedgerMasters] = await Promise.all([
    loadSuppliers(companyId),
    loadDutiesTaxes(companyId),
    loadStockItems(companyId),
    loadExpenseLedgers(companyId),
    loadVoucherTypes(companyId),
    loadPurchaseLedgers(companyId),
  ]);
  return { suppliers, dutiesTaxes, stockItems, expenseLedgers, voucherTypes, purchaseLedgerMasters };
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function XmlGeneratorPage() {
  const router = useRouter();
  const { company, loading: companyLoading } = useCompany();

  const [selectedFY, setSelectedFY] = useState<string>(currentFY);
  const [invoices, setInvoices] = useState<StoredInvoice[]>([]);
  const [loadingInvoices, setLoadingInvoices] = useState(false);
  const [cachedMasters, setCachedMasters] = useState<Awaited<ReturnType<typeof loadMasters>> | null>(null);
  const [cachedHistoricalPL, setCachedHistoricalPL] = useState<Record<string, string> | null>(null);
  const [cachedCompanyWidePL, setCachedCompanyWidePL] = useState<string | null>(null);


  const [voucherMode, setVoucherMode] = useState<'accounting_only' | 'inventory'>('accounting_only');
  const [showSuggestionDrillDown, setShowSuggestionDrillDown] = useState(false);
  const [showWarningDrillDown, setShowWarningDrillDown] = useState(false);

  const [previewing, setPreviewing] = useState(false);
  const [previewRows, setPreviewRows] = useState<PreviewRow[] | null>(null);
  const [previewError, setPreviewError] = useState('');

  const [generatingXml, setGeneratingXml] = useState(false);
  const [xmlBlob, setXmlBlob] = useState<Blob | null>(null);
  const [xmlFilename, setXmlFilename] = useState('');

  const [loadError, setLoadError] = useState('');

  // Auth
  useEffect(() => {
    if (companyLoading) return;
    getSession().then((session) => {
      if (!session) { router.replace('/login'); return; }
      if (!company) router.replace('/select-company');
    });
  }, [company, companyLoading, router]);

  // Load voucher mode from DB when company changes
  useEffect(() => {
    if (!company?.id) return;
    getCompany(company.id).then((fresh) => {
      if (fresh.voucher_mode) setVoucherMode(fresh.voucher_mode);
    }).catch(() => {});
  }, [company?.id]);

  // Load invoices on company/FY change - also clear preview
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

  // Restore locked invoice state from DB on invoice load
  const initialLockedInvoices = useMemo<Record<string, LockedInvoice>>(() => {
    const out: Record<string, LockedInvoice> = {};
    for (const inv of invoices) {
      if (inv.tally_ledger_acceptance) {
        out[inv.invoice_number] = inv.tally_ledger_acceptance as LockedInvoice;
      }
    }
    return out;
  }, [invoices]);

  const fileBase = `${company?.tally_company_name ?? company?.name ?? 'export'}_${selectedFY}`
    .replace(/[^a-zA-Z0-9._-]/g, '_');

  function validateForPreview(): string | null {
    if (!company) return 'No company selected.';
    if (!company.tally_company_name) return 'Tally Company Name is missing - update it in Companies first.';
    if (invoices.length === 0) return 'No accepted invoices found for the selected period.';
    return null;
  }

  function validateForXml(): string | null {
    return validateForPreview();
  }

  // ── Step 2: Preview ──
  const handlePreview = async () => {
    const err = validateForPreview();
    if (err) { alert(err); return; }

    setPreviewing(true);
    setPreviewRows(null);
    setPreviewError('');
    setXmlBlob(null);

    try {
      const masters = await loadMasters(company!.id);
      setCachedMasters(masters);
      const fresh = await getCompany(company!.id);

      // Build historical purchase ledger map keyed by vendor_gstin or 'name:normalized_name'
      const supplierKeySet: Record<string, true> = {};
      for (const inv of invoices) {
        const k = inv.vendor_gstin ? inv.vendor_gstin : `name:${(inv.vendor_name ?? '').toLowerCase().trim()}`;
        if (k) supplierKeySet[k] = true;
      }
      const uniqueSupplierKeys = Object.keys(supplierKeySet);
      const historicalEntries = await Promise.all(
        uniqueSupplierKeys.map(async (key) => {
          const isGstin = !key.startsWith('name:');
          const result = await getHistoricalPurchaseLedger(
            company!.id,
            isGstin ? key : null,
            isGstin ? null : key.slice(5),
          );
          return [key, result] as [string, string | null];
        })
      );
      const historicalPL: Record<string, string> = {};
      for (const [key, val] of historicalEntries) { if (val) historicalPL[key] = val; }
      setCachedHistoricalPL(historicalPL);

      // Fetch company-wide most-used PL for Case 3 suggestion (multiple masters, no supplier history)
      const plMasterNames = masters.purchaseLedgerMasters.map((l) => l.tally_ledger_name);
      const companyWidePL = plMasterNames.length > 1
        ? await getCompanyWideMostUsedPurchaseLedger(company!.id, plMasterNames)
        : null;
      setCachedCompanyWidePL(companyWidePL);

      const rows = buildTallyPreview({
        invoices, ...masters,
        purchaseLedgers: masters.purchaseLedgerMasters.map((l) => ({ gst_percent: null as null, tally_ledger_name: l.tally_ledger_name })),
        tallyCompanyName: company!.tally_company_name!,
        voucherMode,
        discountLedgerName: fresh.discount_ledger_name,
        stockItemMode: fresh.stock_item_mode,
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
        r.invoice_number, r.invoice_date, r.vendor_name, r.party_ledger,
        r.ledger_type, r.tally_ledger_name, r.amount, r.status,
        r.skip_reason ?? r.warning ?? '',
      ]),
    ];
    const ws = XLSX.utils.aoa_to_sheet(wsData);
    ws['!cols'] = [{ wch: 18 }, { wch: 12 }, { wch: 30 }, { wch: 30 }, { wch: 10 }, { wch: 35 }, { wch: 16 }, { wch: 8 }, { wch: 40 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Tally Preview');
    const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    const blob = new Blob([wbout], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${fileBase}_preview.xlsx`;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(url);
  };

  const buildXmlInput = async () => {
    const masters = await loadMasters(company!.id);
    const fresh = await getCompany(company!.id);
    return {
      invoices, ...masters,
      purchaseLedgers: masters.purchaseLedgerMasters.map((l) => ({ gst_percent: null as null, tally_ledger_name: l.tally_ledger_name })),
      tallyCompanyName: company!.tally_company_name!,
      financialYear: selectedFY,
      voucherMode,
      discountLedgerName: fresh.discount_ledger_name,
      companyGstin: fresh.gstin ?? undefined,
      stockItemMode: fresh.stock_item_mode,
    };
  };

  const triggerDownload = (xml: string, filename: string) => {
    // Tally requires UTF-16 LE with BOM - UTF-8 files are rejected at import
    const utf16 = new Uint16Array(xml.length);
    for (let i = 0; i < xml.length; i++) utf16[i] = xml.charCodeAt(i);
    const bom = new Uint8Array([0xff, 0xfe]);
    const body = new Uint8Array(utf16.buffer);
    const merged = new Uint8Array(bom.length + body.length);
    merged.set(bom, 0);
    merged.set(body, bom.length);
    const blob = new Blob([merged], { type: 'application/octet-stream' });
    setXmlBlob(blob);
    setXmlFilename(filename);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleDownloadMastersXml = async (type: MasterType, label: string) => {
    const err = validateForXml();
    if (err) { alert(err); return; }
    setGeneratingXml(true);
    try {
      const input = await buildXmlInput();
      const xml = generateMastersXml(input, type);
      triggerDownload(xml, `${fileBase}_masters_${type}.xml`);
    } catch (e: unknown) {
      alert(`Error generating ${label} XML: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setGeneratingXml(false);
    }
  };

  const handleDownloadVouchersXml = async () => {
    const err = validateForXml();
    if (err) { alert(err); return; }
    if (voucherMode === 'inventory' && !company?.gstin) {
      const proceed = window.confirm(
        'Warning: Company GSTIN is not set.\n\nWithout GSTIN, Tally cannot link this voucher to a Company Tax Unit, which is required for GST compliance in inventory mode.\n\nDo you want to continue anyway?'
      );
      if (!proceed) return;
    }
    setGeneratingXml(true);
    setXmlBlob(null);
    try {
      const input = await buildXmlInput();
      const output = generateTallyXml(input);
      triggerDownload(output.xml, `${fileBase}_vouchers.xml`);
      if (output.skippedInvoices.length > 0) {
        const msgs = output.skippedInvoices.map((s) => `• ${s.invoice_number}: ${s.reason}`).join('\n');
        alert(`XML generated. ${output.includedCount} voucher(s) included.\n\n${output.skippedInvoices.length} skipped:\n${msgs}`);
      }
    } catch (e: unknown) {
      alert(`Error generating vouchers XML: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setGeneratingXml(false);
    }
  };

  // Counts for drill-down panels (page-level, previewRows-based)
  const previewSkippedCount  = previewRows
    ? new Set(previewRows.filter((r) => r.status === 'Skipped').map((r) => r.invoice_number)).size
    : 0;
  const previewSuggestedCount = previewRows
    ? new Set(previewRows.filter((r) => r.status === 'Suggested').map((r) => r.invoice_number)).size
    : 0;
  const previewWarningCount  = previewRows
    ? new Set(previewRows.filter((r) => r.warning).map((r) => r.invoice_number)).size
    : 0;

  // Drill-down data for suggestion and warning badges
  const suggestionDrillDown: { invoiceNo: string; field: string; value: string }[] = previewRows
    ? (() => {
        const seen = new Set<string>();
        return previewRows
          .filter((r) => r.status === 'Suggested')
          .filter((r) => { const k = `${r.invoice_number}|${r.ledger_type}`; if (seen.has(k)) return false; seen.add(k); return true; })
          .map((r) => ({
            invoiceNo: r.invoice_number,
            field: r.ledger_type === 'Party' ? 'Vendor Ledger'
              : r.ledger_type === 'Purchase' ? 'Purchase Ledger'
              : r.ledger_type === 'CGST' ? 'CGST Ledger'
              : r.ledger_type === 'SGST' ? 'SGST Ledger'
              : r.ledger_type === 'IGST' ? 'IGST Ledger'
              : r.ledger_type === 'Expense' ? `Charge Ledger (${r.item_description ?? ''})`
              : r.ledger_type === 'Discount' ? 'Discount Ledger'
              : r.ledger_type === 'Round Off' ? 'Round Off Ledger'
              : r.ledger_type === 'Inventory' ? `Stock Item (${r.item_description ?? ''})`
              : r.ledger_type,
            value: r.tally_ledger_name,
          }));
      })()
    : [];

  const warningDrillDown: { invoiceNo: string; warning: string; severity: 'Blocking' | 'Informational' }[] = previewRows
    ? (() => {
        const seen = new Set<string>();
        return previewRows
          .filter((r) => r.warning)
          .filter((r) => { const k = `${r.invoice_number}|${r.warning}`; if (seen.has(k)) return false; seen.add(k); return true; })
          .map((r) => ({
            invoiceNo: r.invoice_number,
            warning: r.warning!,
            severity: r.warning!.startsWith('No purchase ledger') ? 'Blocking' : 'Informational',
          }));
      })()
    : [];

  return (
    <AppLayout>
      <main className="flex-1 p-8" style={{ maxWidth: '100%' }}>
        <div className="mb-7">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Export to Tally</h1>
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

          {/* Voucher mode */}
          <div className="border-t border-gray-100 dark:border-gray-700 pt-4 mb-4">
            <p className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-2">Voucher Mode</p>
            <div className="flex gap-3">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="radio" name="voucherMode" value="accounting_only" checked={voucherMode === 'accounting_only'} onChange={() => { setVoucherMode('accounting_only'); if (company) updateCompany(company.id, { voucher_mode: 'accounting_only' }).catch(() => {}); }} className="accent-indigo-600" />
                <span className="text-sm text-gray-700 dark:text-gray-300">Accounting only <span className="text-xs text-gray-400 dark:text-gray-500">(HSN-aggregated, no stock items)</span></span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="radio" name="voucherMode" value="inventory" checked={voucherMode === 'inventory'} onChange={() => { setVoucherMode('inventory'); if (company) updateCompany(company.id, { voucher_mode: 'inventory' }).catch(() => {}); }} className="accent-indigo-600" />
                <span className="text-sm text-gray-700 dark:text-gray-300">Inventory <span className="text-xs text-gray-400 dark:text-gray-500">(item-level qty, rate, discount)</span></span>
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
            The system analyses your accepted invoices and shows every ledger entry that will be created in Tally.
            Red rows indicate issues that will cause that invoice to be skipped.
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

          {previewRows && (
            <div className="mt-5 space-y-4">

              {/* AI Suggestions drill-down */}
              {showSuggestionDrillDown && suggestionDrillDown.length > 0 && (
                <div className="border border-amber-200 dark:border-amber-700 rounded-lg overflow-hidden">
                  <div className="bg-amber-50 dark:bg-amber-900/20 px-4 py-2.5 flex items-center justify-between">
                    <span className="text-sm font-semibold text-amber-800 dark:text-amber-300">AI Suggestions — fields auto-filled by TallyAI, verify before export</span>
                    <button onClick={() => setShowSuggestionDrillDown(false)} className="text-amber-500 dark:text-amber-400 hover:text-amber-700 text-lg leading-none">×</button>
                  </div>
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 dark:bg-gray-800 border-b border-amber-100 dark:border-amber-800">
                      <tr>
                        <th className="px-4 py-2 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Invoice No</th>
                        <th className="px-4 py-2 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Field</th>
                        <th className="px-4 py-2 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">AI Suggested Value</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 dark:divide-gray-700 bg-white dark:bg-gray-800">
                      {suggestionDrillDown.map((s, i) => (
                        <tr key={i} className="hover:bg-amber-50/40 dark:hover:bg-gray-700/50">
                          <td className="px-4 py-2 font-medium text-gray-900 dark:text-gray-100 whitespace-nowrap">{s.invoiceNo}</td>
                          <td className="px-4 py-2 text-gray-600 dark:text-gray-400">{s.field}</td>
                          <td className="px-4 py-2 text-gray-800 dark:text-gray-200 font-mono text-xs">{s.value}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Warnings drill-down */}
              {showWarningDrillDown && warningDrillDown.length > 0 && (
                <div className="border border-orange-200 dark:border-orange-800 rounded-lg overflow-hidden">
                  <div className="bg-orange-50 dark:bg-orange-900/20 px-4 py-2.5 flex items-center justify-between">
                    <span className="text-sm font-semibold text-orange-800 dark:text-orange-400">Warnings — review before downloading XML</span>
                    <button onClick={() => setShowWarningDrillDown(false)} className="text-orange-400 dark:text-orange-500 hover:text-orange-600 text-lg leading-none">×</button>
                  </div>
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 dark:bg-gray-800 border-b border-orange-100 dark:border-orange-800">
                      <tr>
                        <th className="px-4 py-2 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Invoice No</th>
                        <th className="px-4 py-2 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Warning</th>
                        <th className="px-4 py-2 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Severity</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 dark:divide-gray-700 bg-white dark:bg-gray-800">
                      {warningDrillDown.map((w, i) => (
                        <tr key={i} className="hover:bg-orange-50/40 dark:hover:bg-gray-700/50">
                          <td className="px-4 py-2 font-medium text-gray-900 dark:text-gray-100 whitespace-nowrap">{w.invoiceNo}</td>
                          <td className="px-4 py-2 text-gray-700 dark:text-gray-300">{w.warning}</td>
                          <td className="px-4 py-2">
                            <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                              w.severity === 'Blocking' ? 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400' : 'bg-yellow-100 dark:bg-yellow-900/20 text-yellow-700 dark:text-yellow-300'
                            }`}>
                              {w.severity}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Auto-suggest notice */}

              {/* Flat preview table - one row per line item, with inline bulk-accept checkboxes */}
              <FlatPreviewTable
                rows={previewRows}
                invoices={invoices}
                suppliers={cachedMasters?.suppliers ?? []}
                expenseLedgers={cachedMasters?.expenseLedgers ?? []}
                stockItems={cachedMasters?.stockItems ?? []}
                stockItemMode={company?.stock_item_mode}
                purchaseLedgerMasters={(cachedMasters?.purchaseLedgerMasters ?? []).map((l) => l.tally_ledger_name)}
                historicalPurchaseLedgers={cachedHistoricalPL ?? {}}
                companyWidePurchaseLedger={cachedCompanyWidePL}
                dutiesTaxesMasters={(cachedMasters?.dutiesTaxes ?? []).map((d) => ({ tax_component: d.tax_component, tally_ledger_name: d.tally_ledger_name }))}
                initialLockedInvoices={initialLockedInvoices}
                companyId={company!.id}
                onDownloadExcel={handleDownloadExcel}
                onMapExpense={async (description, ledgerName) => {
                  if (!company?.id) return;
                  if (description === 'Discount') {
                    try {
                      await updateCompany(company.id, { discount_ledger_name: ledgerName });
                      handlePreview();
                    } catch (e: unknown) { alert(getErrMsg(e)); }
                    return;
                  }
                  try {
                    const defaults = getExpenseDefaults(description);
                    await addExpenseLedger(company.id, {
                      tally_ledger_name: ledgerName,
                      expense_keyword: description,
                      sac_code: defaults?.sac_code || undefined,
                      gst_percent: defaults?.gst_percent ?? null,
                    });
                    handlePreview();
                  }
                  catch (e: unknown) { alert(getErrMsg(e)); }
                }}
                onMapSupplier={async (vendorName, ledgerName) => {
                  if (!company?.id) return;
                  try {
                    const inv = invoices.find((i) => i.vendor_name === vendorName);
                    await addSupplier(company.id, { vendor_name: vendorName, vendor_gstin: inv?.vendor_gstin ?? '', tally_ledger_name: ledgerName });
                    handlePreview();
                  } catch (e: unknown) { alert(getErrMsg(e)); }
                }}
                onMapStockItem={async (description, tallyItemName) => {
                  if (!company?.id) return;
                  try { await addStockItem(company.id, { tally_item_name: tallyItemName, alias_name: description }); handlePreview(); }
                  catch (e: unknown) { alert(getErrMsg(e)); }
                }}
                onMapTaxLedger={(_type, _name) => {
                  // Tax ledger edits are local to the preview - persist in Duties & Taxes master
                }}
                onAcceptInvoices={async (payloads) => {
                  if (!company?.id) return;
                  const errs: string[] = [];
                  const seenVendor = new Set<string>();
                  const seenStock  = new Set<string>();
                  const seenExp    = new Set<string>();
                  let seenCgst   = false;
                  let seenSgst   = false;
                  let seenIgst   = false;
                  const seenRo     = new Set<string>();

                  for (const p of payloads) {
                    // 1. Vendor ledger → supplier_masters
                    if (!isBlank(p.vendorLedger) && !seenVendor.has(p.vendorName)) {
                      seenVendor.add(p.vendorName);
                      try { await addSupplier(company.id, { vendor_name: p.vendorName, vendor_gstin: p.vendorGstin, tally_ledger_name: p.vendorLedger }); }
                      catch (e) { errs.push(`Vendor "${p.vendorName}": ${getErrMsg(e)}`); }
                    }
                    // 1b. Purchase ledger → purchase_ledger_config
                    if (!isBlank(p.purchaseLedger)) {
                      try { await addPurchaseLedger(company.id, p.purchaseLedger); }
                      catch (e) { errs.push(`Purchase ledger: ${getErrMsg(e)}`); }
                    }
                    // 2. Stock items → stock_item_masters
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
                        }
                        catch (e) { errs.push(`Stock "${si.desc}": ${getErrMsg(e)}`); }
                      }
                    }
                    // 3. Expense/charge ledgers → expense_ledger_masters (Discount → company setting)
                    for (const ch of p.charges) {
                      // Key by keyword+rate so Freight@0% and Freight@5% both get saved
                      const expKey = `${ch.keyword}__${ch.gst_percent ?? 'null'}`;
                      if (!isBlank(ch.tallyName) && !seenExp.has(expKey)) {
                        seenExp.add(expKey);
                        // Use extracted GST/SAC from invoice; fall back to built-in lookup
                        const defaults = getExpenseDefaults(ch.keyword);
                        const gstPct = ch.gst_percent != null
                          ? ch.gst_percent
                          : (defaults?.gst_percent ?? null);
                        const sacCode = ch.sac_code || defaults?.sac_code || undefined;
                        // Discount: also persist to company.discount_ledger_name
                        if (ch.keyword === 'Discount') {
                          try { await updateCompany(company.id, { discount_ledger_name: ch.tallyName }); }
                          catch (e) { errs.push(`Discount ledger: ${getErrMsg(e)}`); }
                        }
                        try {
                          await addExpenseLedger(company.id, {
                            tally_ledger_name: ch.tallyName,
                            expense_keyword: ch.keyword,
                            gst_percent: gstPct,
                            sac_code: sacCode,
                          });
                        }
                        catch (e) { errs.push(`Expense "${ch.keyword}": ${getErrMsg(e)}`); }
                      }
                    }
                    // 4. Tax ledgers → duties_taxes_masters (consolidated, null rate)
                    if (p.taxType === 'cgst_sgst') {
                      if (!isBlank(p.cgstLedger) && !seenCgst) {
                        seenCgst = true;
                        try { await addDutiesTaxes(company.id, { tax_component: 'CGST', tax_rate: null, tally_ledger_name: p.cgstLedger }); }
                        catch (e) { errs.push(`CGST ledger: ${getErrMsg(e)}`); }
                      }
                      if (!isBlank(p.sgstLedger) && !seenSgst) {
                        seenSgst = true;
                        try { await addDutiesTaxes(company.id, { tax_component: 'SGST', tax_rate: null, tally_ledger_name: p.sgstLedger }); }
                        catch (e) { errs.push(`SGST ledger: ${getErrMsg(e)}`); }
                      }
                    } else if (p.taxType === 'igst') {
                      if (!isBlank(p.igstLedger) && !seenIgst) {
                        seenIgst = true;
                        try { await addDutiesTaxes(company.id, { tax_component: 'IGST', tax_rate: null, tally_ledger_name: p.igstLedger }); }
                        catch (e) { errs.push(`IGST ledger: ${getErrMsg(e)}`); }
                      }
                    }
                    // 5. Round off ledger → expense_ledger_masters
                    if (!isBlank(p.roLedger) && !seenRo.has(p.roLedger)) {
                      seenRo.add(p.roLedger);
                      try { await addExpenseLedger(company.id, { tally_ledger_name: p.roLedger, expense_keyword: 'Round Off' }); }
                      catch (e) { errs.push(`Round Off ledger: ${getErrMsg(e)}`); }
                    }
                  }
                  // 7. Persist accepted ledger values to DB so they survive page refresh
                  for (const p of payloads) {
                    const chargesLocked: Record<string, string> = {};
                    p.charges.forEach((ch) => { chargesLocked[ch.keyword] = ch.tallyName; });
                    const acceptance: StoredInvoice['tally_ledger_acceptance'] = {
                      vendorLedger: p.vendorLedger,
                      purchaseLedger: p.purchaseLedger,
                      cgstLedger: p.cgstLedger,
                      sgstLedger: p.sgstLedger,
                      igstLedger: p.igstLedger,
                      roLedger: p.roLedger,
                      stock: p.lockedStock,
                      charges: chargesLocked,
                    };
                    try { await saveInvoiceTallyAcceptance(company.id, p.invoiceNo, acceptance); }
                    catch (e) { errs.push(`Save acceptance for ${p.invoiceNo}: ${getErrMsg(e)}`); }
                  }
                  if (errs.length) alert(`Some items failed to save:\n${errs.join('\n')}`);
                  // Do NOT refresh preview - fields are locked locally per invoice
                }}
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

          {/* Master XML buttons - one per master type */}
          <div className="mb-4">
            <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">Masters (import in order)</p>
            <div className="flex flex-wrap gap-2">
              {([
                { type: 'stock_items'      as MasterType, label: 'Stock Items',             color: 'bg-indigo-600 hover:bg-indigo-700' },
                { type: 'purchase_ledgers' as MasterType, label: 'Purchase Ledgers',        color: 'bg-blue-600 hover:bg-blue-700' },
                { type: 'expense_ledgers'  as MasterType, label: 'Expense / Charge Ledgers', color: 'bg-orange-600 hover:bg-orange-700' },
                { type: 'duties_taxes'     as MasterType, label: 'Duties & Taxes',           color: 'bg-teal-600 hover:bg-teal-700' },
                { type: 'suppliers'        as MasterType, label: 'Sundry Creditors',         color: 'bg-purple-600 hover:bg-purple-700' },
                { type: 'all'              as MasterType, label: 'All Ledgers (Combined)',   color: 'bg-gray-700 hover:bg-gray-800' },
              ] as const).map(({ type, label, color }) => (
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

          {/* Vouchers button */}
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

          {xmlBlob && (
            <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
              Last downloaded: <span className="font-mono">{xmlFilename}</span>
            </p>
          )}
        </div>

        {/* How-to */}
        <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-xl px-5 py-4 text-sm text-blue-800 dark:text-blue-200">
          <p className="font-semibold mb-2">How to import into Tally</p>
          <p className="text-xs text-blue-700 dark:text-blue-300 mb-2">
            Import each master type separately first, then import vouchers. Safe to re-import - Tally silently skips masters that already exist.
          </p>
          <ol className="list-decimal list-inside space-y-1.5 text-blue-700 dark:text-blue-300 text-xs">
            <li>Open Tally → select company <strong>{company?.tally_company_name ?? '-'}</strong></li>
            <li>
              <strong>Import each master:</strong> Gateway of Tally → Import Data → Masters → select the file
              <span className="block ml-5 mt-0.5 text-blue-600 dark:text-blue-400">Order: Stock Items → Purchase Ledgers → Expense Ledgers → Duties &amp; Taxes → Sundry Creditors</span>
            </li>
            <li>
              <strong>Import Vouchers</strong> only after all masters succeed: Import Data → Vouchers → select <em>…_vouchers.xml</em>
            </li>
          </ol>
        </div>
      </main>
    </AppLayout>
  );
}
