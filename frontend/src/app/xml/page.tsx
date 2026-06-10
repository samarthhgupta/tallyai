'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { getPurchaseRegister, getCompany, updateCompany, saveInvoiceTallyAcceptance } from '@/lib/db';
import { loadSuppliers, addSupplier } from '@/lib/suppliers';
import { loadDutiesTaxes, addDutiesTaxes } from '@/lib/dutiesTaxes';
import { loadStockItems, addStockItem } from '@/lib/stockItems';
import { loadExpenseLedgers, addExpenseLedger, getExpenseDefaults } from '@/lib/expenseLedgers';
import { loadVoucherTypes } from '@/lib/voucherTypes';
import { generateTallyXml, generateMastersXml, buildTallyPreview, type PreviewRow, type MasterType } from '@/lib/xmlGenerator';
import type { StoredInvoice } from '@/types/invoice';
import { calcLineAmount } from '@/types/invoice';
import AppSidebar from '@/components/AppSidebar';
import { currentFY } from '@/lib/fyPeriod';
import { useCompany } from '@/lib/companyContext';
import FYPeriodSelector from '@/components/FYPeriodSelector';
import * as XLSX from 'xlsx';

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
  itemDesc: string;
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
  onMapExpense, onMapSupplier, onMapStockItem, onMapTaxLedger, onAcceptInvoices, companyId,
}: {
  rows: PreviewRow[];
  invoices: StoredInvoice[];
  suppliers: SupplierMaster[];
  expenseLedgers: { tally_ledger_name: string }[];
  stockItems: { tally_item_name: string }[];
  initialLockedInvoices: Record<string, LockedInvoice>;
  companyId: string;
  onMapExpense: (description: string, ledgerName: string) => void;
  onMapSupplier: (vendorName: string, ledgerName: string) => void;
  onMapStockItem: (description: string, tallyItemName: string) => void;
  onMapTaxLedger: (type: 'CGST' | 'SGST' | 'IGST', name: string) => void;
  onAcceptInvoices: (payloads: InvoiceAcceptPayload[]) => Promise<void>;
}) {
  const isInventoryMode = rows.some((r) => r.ledger_type === 'Inventory');

  // Local editable overrides (keyed as needed)
  const [vendorEdits, setVendorEdits] = React.useState<Record<string, string>>({});
  const [purchaseLedgerEdits, setPurchaseLedgerEdits] = React.useState<Record<string, string>>({}); // keyed by invoiceNo
  const [stockItemEdits, setStockItemEdits] = React.useState<Record<string, string>>({});
  const [chargeEdits, setChargeEdits] = React.useState<Record<string, string>>({});
  const [taxLedgerEdits, setTaxLedgerEdits] = React.useState<{ cgst?: string; sgst?: string; igst?: string }>({});
  const [roLedgerEdits, setRoLedgerEdits] = React.useState<Record<string, string>>({}); // keyed by invoiceNo

  // Bulk-select state for inline accept / unaccept
  const [selectedRows, setSelectedRows] = React.useState<Set<number>>(new Set());
  const [selectedLockedInvoices, setSelectedLockedInvoices] = React.useState<Set<string>>(new Set());
  const [bulkSaving, setBulkSaving] = React.useState(false);

  // Accepted invoices - once accepted, fields are locked in the UI (initialised from DB on mount)
  const [lockedInvoices, setLockedInvoices] = React.useState<Record<string, LockedInvoice>>(initialLockedInvoices);

  // Stock item "apply to all" popup state
  const [stockConfirm, setStockConfirm] = React.useState<{
    itemDesc: string; hsn: string; gstPct: number | null; suggestedName: string; chosenName: string;
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

    const vendorLedger    = partyRow?.tally_ledger_name ?? '-';
    const vendorSuggested = partyRow?.status === 'Suggested';

    // ONE purchase ledger per invoice - read from accepted invoice, else empty (user must set it)
    const invPlLedger = invoice?.tally_ledger_acceptance?.purchaseLedger ?? '';
    const invPlSuggested = !invPlLedger;

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

    // Helper: per-item tax from taxable amount and gst rate
    const itemTax = (taxable: number, gstPct: number | null) => {
      const pct = gstPct ?? 0;
      return {
        cgstAmt: invTaxType === 'cgst_sgst' ? Math.round(taxable * (pct / 2) / 100 * 100) / 100 : 0,
        sgstAmt: invTaxType === 'cgst_sgst' ? Math.round(taxable * (pct / 2) / 100 * 100) / 100 : 0,
        igstAmt: invTaxType === 'igst'       ? Math.round(taxable * pct / 100 * 100) / 100 : 0,
      };
    };

    if (isInventoryMode) {
      if (invRows2.length === 0) {
        displayRows.push({
          ...base, isFirst: true, ...invoiceTail,
          purchaseLedger: invPlLedger, purchaseLedgerSuggested: invPlSuggested,
          itemDesc: '', hsn: '', stockItem: '', stockItemSuggested: false,
          taxRate: null, qty: null, uom: '', rate: null, disc: null,
          amount: Math.abs(partyRow?.amount ?? 0),
          cgstAmt: 0, sgstAmt: 0, igstAmt: 0,
        });
        continue;
      }
      invRows2.forEach((row, idx) => {
        const lineItem = invoice?.line_items.find((li) => li.description === row.item_description);
        const tax = itemTax(row.amount, lineItem?.gst_percent ?? null);
        displayRows.push({
          ...base,
          isFirst: idx === 0,
          ...(idx === 0 ? invoiceTail : emptyTail),
          purchaseLedger: invPlLedger,
          purchaseLedgerSuggested: invPlSuggested,
          itemDesc: row.item_description ?? '',
          hsn: lineItem?.hsn ?? '',
          stockItem: row.tally_ledger_name ?? '',
          stockItemSuggested: row.is_suggested === true,
          taxRate: lineItem?.gst_percent ?? null,
          ...tax,
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
          ...base, isFirst: true, ...invoiceTail,
          purchaseLedger: invPlLedger, purchaseLedgerSuggested: invPlSuggested,
          itemDesc: '', hsn: '', stockItem: '', stockItemSuggested: false,
          taxRate: null, qty: null, uom: '', rate: null, disc: null,
          amount: Math.abs(partyRow?.amount ?? 0),
          cgstAmt: 0, sgstAmt: 0, igstAmt: 0,
        });
        continue;
      }
      lineItems.forEach((item, idx) => {
        const hsnSuggestion = item.hsn ? `${item.hsn} @ ${item.gst_percent ?? 0}%` : '';
        const itemAmt = calcLineAmount(item);
        const tax = itemTax(itemAmt, item.gst_percent ?? null);
        displayRows.push({
          ...base,
          isFirst: idx === 0,
          ...(idx === 0 ? invoiceTail : emptyTail),
          purchaseLedger: invPlLedger,
          purchaseLedgerSuggested: invPlSuggested,
          itemDesc: item.description ?? '',
          hsn: item.hsn ?? '',
          stockItem: hsnSuggestion,
          stockItemSuggested: !!hsnSuggestion,
          taxRate: item.gst_percent ?? null,
          qty:  item.qty ?? null,
          uom:  item.uom ?? '',
          rate: item.rate ?? null,
          disc: (item.disc_percent ?? 0) > 0 ? item.disc_percent : null,
          amount: itemAmt,
          ...tax,
        });
      });
    }
  }

  const maxCharges = Math.max(0, ...displayRows.map((r) => r.charges.length));

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
          const tallyName = stockItemEdits[`${invNo}_${r.itemDesc}`] ?? r.stockItem;
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
    <th className={`px-3 py-2.5 border-b border-gray-200 font-semibold text-gray-500 uppercase tracking-wide whitespace-nowrap text-[11px] bg-gray-50 ${right ? 'text-right' : 'text-left'}`}>
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

  return (
    <div className="rounded-lg border border-gray-200 shadow-sm">
      {/* Action bar */}
      {(suggestableInvoices.length > 0 || selectedLockedInvoices.size > 0) && (
        <div className="flex items-center gap-3 px-4 py-2.5 bg-amber-50 border-b border-amber-200 flex-wrap">
          <label className="flex items-center gap-2 text-xs font-medium text-gray-700 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={toggleAll}
              className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
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
              className="px-4 py-1.5 border border-red-300 text-red-600 rounded-lg text-xs font-semibold hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {bulkSaving ? 'Saving…' : `Unaccept ${selectedLockedInvoices.size} invoice${selectedLockedInvoices.size !== 1 ? 's' : ''}`}
            </button>
          )}
          {selectedInvoices.size === 0 && selectedLockedInvoices.size === 0 && (
            <span className="text-xs text-amber-700">✦ Amber fields are AI suggestions — edit if needed, then accept to save to masters</span>
          )}
        </div>
      )}
      {/* Top scrollbar mirror */}
      <div ref={topScrollRef} onScroll={onTopScroll} className="overflow-x-auto" style={{ height: 12 }}>
        <div style={{ width: tableScrollWidth, height: 1 }} />
      </div>
      {/* Table with sticky header */}
      <div ref={tableContainerRef} onScroll={onTableScroll} className="overflow-x-auto max-h-[70vh] overflow-y-auto">
        <table className="min-w-max text-xs border-collapse">
          <thead className="bg-gray-50 sticky top-0 z-10">
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
              const prevRow = displayRows[i - 1];
              const isNewInvoice = !prevRow || prevRow.invoiceNo !== row.invoiceNo;
              const locked = lockedInvoices[row.invoiceNo];
              // If any preview row for this invoice has a fresh AI suggestion, treat it as
              // needing re-acceptance even if it was previously accepted.
              const invHasSuggestions = rows.some(
                (r: PreviewRow) => r.invoice_number === row.invoiceNo && r.is_suggested
              );
              const isLocked = !!locked && !invHasSuggestions;
              const rowBg = isLocked ? 'bg-green-50/30' : (isNewInvoice ? 'bg-white' : 'bg-blue-50/20');
              const borderTop = isNewInvoice && i > 0 ? 'border-t-2 border-gray-300' : 'border-t border-gray-100';
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
              const effectiveStockItem      = locked?.stock[row.itemDesc] ?? (stockItemEdits[`${row.invoiceNo}_${row.itemDesc}`] ?? row.stockItem);
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
                      className={`border border-amber-300 rounded px-2 py-0.5 text-xs bg-amber-50 focus:ring-1 focus:ring-indigo-400 flex-1 font-mono min-w-0`}
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
                <tr key={i} className={`${rowBg} ${borderTop} hover:bg-yellow-50/40 transition-colors`}>
                  {/* Checkbox / accepted badge - one per invoice, on the first row only */}
                  <td className="px-2 py-2 w-12 text-center">
                    {row.isFirst && isLocked && (
                      <label className="flex items-center justify-center gap-1 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={selectedLockedInvoices.has(row.invoiceNo)}
                          onChange={() => toggleLockedInvoice(row.invoiceNo)}
                          className="rounded border-gray-300 text-red-500 focus:ring-red-400"
                        />
                        <span title="Accepted" className="text-green-600 text-sm font-bold leading-none">✓</span>
                      </label>
                    )}
                    {row.isFirst && !isLocked && isInvSuggestable && (
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => toggleInvoice(row.invoiceNo)}
                        className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                      />
                    )}
                  </td>
                  {/* Date */}
                  <td className="px-3 py-2 whitespace-nowrap font-mono text-gray-600">{row.invoiceDate}</td>
                  {/* Invoice No */}
                  <td className="px-3 py-2 whitespace-nowrap font-mono font-semibold text-gray-800">{row.invoiceNo}</td>
                  {/* Voucher Type */}
                  <td className="px-3 py-2 whitespace-nowrap">
                    <span className="inline-block font-mono text-[11px] px-2 py-0.5 rounded bg-gray-100 text-gray-700">{row.voucherType}</span>
                  </td>
                  {/* Vendor Name */}
                  <td className="px-3 py-2 max-w-[160px] truncate text-gray-700" title={row.vendorName}>{row.vendorName}</td>
                  {/* Vendor Ledger */}
                  <td className="px-3 py-2 min-w-[180px]">
                    {isLocked ? (
                      <span className="font-mono font-medium text-purple-800">{effectiveVendorLedger || '-'}</span>
                    ) : row.vendorSuggested ? (
                      suppliers.length > 0 ? (
                        <select value={editedVendor ?? ''} onChange={(e) => {
                          if (!e.target.value) return;
                          setVendorEdits((p) => ({ ...p, [row.vendorName]: e.target.value }));
                          onMapSupplier(row.vendorName, e.target.value);
                        }} className="border border-amber-300 rounded px-2 py-1 text-xs bg-amber-50 w-full">
                          <option value="">{vendorDisplayVal} (suggested) ✦</option>
                          {suppliers.map((s) => <option key={s.tally_ledger_name} value={s.tally_ledger_name}>{s.tally_ledger_name}</option>)}
                        </select>
                      ) : (
                        <EditableField value={vendorDisplayVal} suggested color="text-purple-800"
                          onSave={(v) => { setVendorEdits((p) => ({ ...p, [row.vendorName]: v })); onMapSupplier(row.vendorName, v); }} />
                      )
                    ) : (
                      <span className="font-mono font-medium text-purple-800">{row.vendorLedger}</span>
                    )}
                  </td>
                  {/* GSTIN */}
                  <td className="px-3 py-2 font-mono text-gray-400 whitespace-nowrap text-[11px]">{row.gstin || '-'}</td>
                  {/* Reg Type */}
                  <td className="px-3 py-2 whitespace-nowrap">
                    {row.gstRegType && (
                      <span className={`inline-block text-[11px] px-1.5 py-0.5 rounded font-medium ${row.gstRegType === 'Unregistered' ? 'bg-amber-100 text-amber-700' : 'bg-green-100 text-green-700'}`}>
                        {row.gstRegType}
                      </span>
                    )}
                  </td>
                  {/* Purchase Ledger */}
                  <td className="px-3 py-2 min-w-[180px]">
                    {isLocked ? (
                      <span className="font-mono font-medium text-blue-800">{effectivePurchaseLedger || '-'}</span>
                    ) : (
                      <EditableField value={purchaseLedgerEdits[row.invoiceNo] ?? row.purchaseLedger} suggested={row.purchaseLedgerSuggested} color="text-blue-800"
                        onSave={(v) => setPurchaseLedgerEdits((p) => ({ ...p, [row.invoiceNo]: v }))} />
                    )}
                  </td>
                  {/* Item Name + HSN */}
                  <td className="px-3 py-2 max-w-[220px]">
                    <div className="truncate text-gray-800" title={row.itemDesc}>{row.itemDesc || '-'}</div>
                    {row.hsn && <div className="text-gray-400 font-mono text-[10px]">HSN: {row.hsn}</div>}
                  </td>
                  {/* Stock Item */}
                  <td className="px-3 py-2 min-w-[180px]">
                    {isLocked ? (
                      <span className="font-mono text-indigo-700">{effectiveStockItem || '-'}</span>
                    ) : row.stockItemSuggested ? (
                      isInventoryMode && stockItems.length > 0 ? (
                        <select defaultValue="" onChange={(e) => {
                          if (!e.target.value) return;
                          const chosen = e.target.value;
                          setStockItemEdits((p) => ({ ...p, [`${row.invoiceNo}_${row.itemDesc}`]: chosen }));
                          setStockConfirm({ itemDesc: row.itemDesc, hsn: row.hsn, gstPct: row.taxRate, suggestedName: row.stockItem, chosenName: chosen });
                          onMapStockItem(row.itemDesc, chosen);
                        }} className="border border-amber-300 rounded px-2 py-1 text-xs bg-amber-50 w-full">
                          <option value="">{stockItemEdits[`${row.invoiceNo}_${row.itemDesc}`] ?? row.stockItem} ✦</option>
                          {stockItems.map((s) => <option key={s.tally_item_name} value={s.tally_item_name}>{s.tally_item_name}</option>)}
                        </select>
                      ) : (
                        <EditableField
                          value={stockItemEdits[`${row.invoiceNo}_${row.itemDesc}`] ?? row.stockItem}
                          suggested color="text-indigo-700"
                          onSave={(v) => {
                            setStockItemEdits((p) => ({ ...p, [`${row.invoiceNo}_${row.itemDesc}`]: v }));
                            if (isInventoryMode) {
                              setStockConfirm({ itemDesc: row.itemDesc, hsn: row.hsn, gstPct: row.taxRate, suggestedName: row.stockItem, chosenName: v });
                              onMapStockItem(row.itemDesc, v);
                            }
                          }} />
                      )
                    ) : (
                      <span className="font-mono text-indigo-700">{row.stockItem || (isInventoryMode ? '-' : '')}</span>
                    )}
                  </td>
                  {/* Tax Rate */}
                  <td className="px-3 py-2 text-right text-gray-600">{row.taxRate != null ? `${row.taxRate}%` : '-'}</td>
                  {/* Qty */}
                  <td className="px-3 py-2 text-right font-mono text-gray-700">{row.qty != null ? row.qty : '-'}</td>
                  {/* UOM */}
                  <td className="px-3 py-2 text-gray-500">{row.uom || '-'}</td>
                  {/* Rate */}
                  <td className="px-3 py-2 text-right font-mono text-gray-700">{row.rate != null ? row.rate.toFixed(2) : '-'}</td>
                  {/* Disc */}
                  <td className="px-3 py-2 text-right text-gray-500">{row.disc != null && row.disc > 0 ? `${row.disc}%` : '-'}</td>
                  {/* Amount */}
                  <td className="px-3 py-2 text-right font-mono font-semibold text-gray-900">
                    {row.amount.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </td>
                  {/* Charges - only on first row of invoice */}
                  {Array.from({ length: maxCharges }, (_, ci) => {
                    const ch = row.isFirst ? row.charges[ci] : undefined;
                    return (
                      <React.Fragment key={`ch${ci}`}>
                        <td className="px-3 py-2 text-gray-600">{ch?.desc ?? ''}</td>
                        <td className="px-3 py-2 min-w-[160px]">
                          {ch && (
                            ch.suggested ? (
                              expenseLedgers.length > 0 ? (
                                <select defaultValue="" onChange={(e) => {
                                  if (!e.target.value) return;
                                  setChargeEdits((p) => ({ ...p, [ch.desc]: e.target.value }));
                                  onMapExpense(ch.desc, e.target.value);
                                }} className="border border-amber-300 rounded px-2 py-1 text-xs bg-amber-50 w-full">
                                  <option value="">{chargeEdits[ch.desc] ?? ch.ledger} ✦</option>
                                  {expenseLedgers.map((l) => <option key={l.tally_ledger_name} value={l.tally_ledger_name}>{l.tally_ledger_name}</option>)}
                                </select>
                              ) : (
                                <EditableField value={chargeEdits[ch.desc] ?? ch.ledger} suggested color={ch.isDiscount ? 'text-pink-700' : 'text-orange-700'}
                                  onSave={(v) => { setChargeEdits((p) => ({ ...p, [ch.desc]: v })); onMapExpense(ch.desc, v); }} />
                              )
                            ) : (
                              <span className={`font-mono ${ch.isDiscount ? 'text-pink-700' : 'text-orange-700'}`}>{ch.ledger}</span>
                            )
                          )}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-gray-700">
                          {ch ? ch.amount.toLocaleString('en-IN', { minimumFractionDigits: 2 }) : ''}
                        </td>
                      </React.Fragment>
                    );
                  })}
                  {/* CGST */}
                  <td className="px-3 py-2 min-w-[160px]">
                    {row.taxType === 'cgst_sgst' && (
                      isLocked
                        ? <span className="font-mono font-medium text-teal-700">{effectiveCgst || '-'}</span>
                        : <EditableField value={effectiveCgst} suggested={row.cgstSuggested} color="text-teal-700"
                            onSave={(v) => { setTaxLedgerEdits((p) => ({ ...p, cgst: v })); onMapTaxLedger('CGST', v); }} />
                    )}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-gray-700">
                    {row.taxType === 'cgst_sgst' && row.cgstAmt !== 0 ? row.cgstAmt.toFixed(2) : ''}
                  </td>
                  {/* SGST */}
                  <td className="px-3 py-2 min-w-[160px]">
                    {row.taxType === 'cgst_sgst' && (
                      isLocked
                        ? <span className="font-mono font-medium text-teal-700">{effectiveSgst || '-'}</span>
                        : <EditableField value={effectiveSgst} suggested={row.sgstSuggested} color="text-teal-700"
                            onSave={(v) => { setTaxLedgerEdits((p) => ({ ...p, sgst: v })); onMapTaxLedger('SGST', v); }} />
                    )}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-gray-700">
                    {row.taxType === 'cgst_sgst' && row.sgstAmt !== 0 ? row.sgstAmt.toFixed(2) : ''}
                  </td>
                  {/* IGST */}
                  <td className="px-3 py-2 min-w-[160px]">
                    {row.taxType === 'igst' && (
                      isLocked
                        ? <span className="font-mono font-medium text-cyan-700">{effectiveIgst || '-'}</span>
                        : <EditableField value={effectiveIgst} suggested={row.igstSuggested} color="text-cyan-700"
                            onSave={(v) => { setTaxLedgerEdits((p) => ({ ...p, igst: v })); onMapTaxLedger('IGST', v); }} />
                    )}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-gray-700">
                    {row.taxType === 'igst' && row.igstAmt !== 0 ? row.igstAmt.toFixed(2) : ''}
                  </td>
                  {/* Round Off - first row only */}
                  <td className="px-3 py-2 min-w-[160px]">
                    {row.isFirst && row.roAmt !== 0 && (
                      isLocked
                        ? <span className="font-mono font-medium text-gray-600">{effectiveRo || '-'}</span>
                        : <EditableField value={effectiveRo} suggested={row.roSuggested} color="text-gray-600"
                            onSave={(v) => setRoLedgerEdits((p) => ({ ...p, [row.invoiceNo]: v }))} />
                    )}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-gray-500">{row.isFirst && row.roAmt !== 0 ? row.roAmt.toFixed(2) : ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Stock item "apply to all" confirm popup */}
      {stockConfirm && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center">
          <div className="bg-white rounded-xl shadow-xl p-6 max-w-md w-full mx-4">
            <h3 className="text-base font-semibold text-gray-900 mb-2">Apply naming pattern to all?</h3>
            <p className="text-sm text-gray-600 mb-1">
              You confirmed stock item: <span className="font-mono font-semibold text-indigo-700">{stockConfirm.chosenName}</span>
            </p>
            <p className="text-sm text-gray-600 mb-4">
              Would you like to use <span className="font-mono font-semibold">HSN @ Rate%</span> as the naming pattern for all other AI-suggested stock items too?
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => {
                  // Apply HSN @ Rate% format to all suggested stock items across all invoices
                  rows
                    .filter((r) => r.ledger_type === 'Inventory' && r.is_suggested)
                    .forEach((r) => {
                      const inv = invoices.find((i) => i.invoice_number === r.invoice_number);
                      const li = inv?.line_items.find((l) => l.description === r.item_description);
                      if (li) {
                        const name = li.hsn ? `${li.hsn} @ ${li.gst_percent ?? 0}%` : `${li.description} @ ${li.gst_percent ?? 0}%`;
                        onMapStockItem(r.item_description ?? '', name);
                      }
                    });
                  setStockConfirm(null);
                }}
                className="flex-1 px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-semibold hover:bg-indigo-700 transition-colors"
              >
                Yes, use HSN @ Rate% for all
              </button>
              <button
                onClick={() => setStockConfirm(null)}
                className="flex-1 px-4 py-2 border border-gray-200 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
              >
                No, map individually
              </button>
            </div>
          </div>
        </div>
      )}
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
                  className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500 shrink-0" />
                <span className="text-gray-500 text-xs w-40 truncate shrink-0" title={invoiceName}>{invoiceName}</span>
                <span className="text-gray-400 text-xs">→</span>
                <input
                  type="text"
                  defaultValue={defaultName}
                  onChange={(e) => setNames((prev) => ({ ...prev, [idx]: e.target.value }))}
                  className="flex-1 border border-amber-200 rounded px-2 py-0.5 text-xs font-mono bg-amber-50 focus:ring-1 focus:ring-indigo-400 min-w-0"
                  placeholder="Tally name…"
                />
                {editedName && editedName !== defaultName && (
                  <span className="text-[10px] text-amber-600 shrink-0">edited</span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <div className="border border-amber-200 rounded-xl bg-amber-50/50 px-5 py-4 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold text-amber-800">
            ✦ {suggestions.length} AI suggestion{suggestions.length !== 1 ? 's' : ''} - review and accept to save to masters
          </span>
          {savedCount > 0 && (
            <span className="text-xs text-green-700 bg-green-100 border border-green-200 rounded px-2 py-0.5">{savedCount} saved ✓</span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer select-none">
            <input type="checkbox" checked={allChecked} onChange={toggleAll}
              className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500" />
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
        <Section title={`Stock Items (${stocks.length})`}      color="text-indigo-700" items={stocks} />
        <Section title={`Expense Ledgers (${expenses.length})`} color="text-orange-700" items={expenses} />
      </div>
    </div>
  );
}

// ─── Shared master loader ─────────────────────────────────────────────────────

async function loadMasters(companyId: string) {
  const [suppliers, dutiesTaxes, stockItems, expenseLedgers, voucherTypes] = await Promise.all([
    loadSuppliers(companyId),
    loadDutiesTaxes(companyId),
    loadStockItems(companyId),
    loadExpenseLedgers(companyId),
    loadVoucherTypes(companyId),
  ]);
  return { suppliers, dutiesTaxes, stockItems, expenseLedgers, voucherTypes };
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function XmlGeneratorPage() {
  const router = useRouter();
  const { company, loading: companyLoading } = useCompany();

  const [selectedFY, setSelectedFY] = useState<string>(currentFY);
  const [invoices, setInvoices] = useState<StoredInvoice[]>([]);
  const [loadingInvoices, setLoadingInvoices] = useState(false);
  const [cachedMasters, setCachedMasters] = useState<Awaited<ReturnType<typeof loadMasters>> | null>(null);


  const [voucherMode, setVoucherMode] = useState<'accounting_only' | 'inventory'>('accounting_only');

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

      const rows = buildTallyPreview({
        invoices, ...masters,
        tallyCompanyName: company!.tally_company_name!,
        voucherMode,
        discountLedgerName: fresh.discount_ledger_name,
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
      tallyCompanyName: company!.tally_company_name!,
      financialYear: selectedFY,
      voucherMode,
      discountLedgerName: fresh.discount_ledger_name,
      companyGstin: fresh.gstin ?? undefined,
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

  const previewSkippedCount  = previewRows?.filter((r) => r.status === 'Skipped').length ?? 0;
  const previewSuggestedCount = previewRows?.filter((r) => r.status === 'Suggested').length ?? 0;
  const previewWarningCount  = previewRows?.filter((r) => r.warning).length ?? 0;
  // An invoice is "ready" if it has no Skipped rows (Suggested rows are AI-filled and included in XML)
  const previewInvoiceCount  = previewRows
    ? new Set(
        previewRows
          .filter((r) => r.status !== 'Skipped')
          .map((r) => r.invoice_number)
          .filter((n) => !previewRows.some((r) => r.invoice_number === n && r.status === 'Skipped'))
      ).size
    : 0;

  return (
    <div className="flex min-h-screen bg-gray-50">
      <AppSidebar />
      <main className="ml-60 flex-1 p-8" style={{ maxWidth: '100%' }}>
        <div className="mb-7">
          <h1 className="text-2xl font-bold text-gray-900">Export to Tally</h1>
          <p className="text-sm text-gray-500 mt-1">
            Analyse ledger assignments and resolve exceptions, then download the XML for import into Tally.
          </p>
        </div>

        {/* ── Step 1: Period + Settings ── */}
        <div className="bg-white border border-gray-200 rounded-xl p-6 mb-5">
          <h2 className="text-sm font-semibold text-gray-700 mb-4">
            <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-indigo-600 text-white text-xs mr-2">1</span>
            Select Period &amp; Settings
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

          {/* Voucher mode */}
          <div className="border-t border-gray-100 pt-4 mb-4">
            <p className="text-xs font-semibold text-gray-600 mb-2">Voucher Mode</p>
            <div className="flex gap-3">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="radio" name="voucherMode" value="accounting_only" checked={voucherMode === 'accounting_only'} onChange={() => { setVoucherMode('accounting_only'); if (company) updateCompany(company.id, { voucher_mode: 'accounting_only' }).catch(() => {}); }} className="accent-indigo-600" />
                <span className="text-sm text-gray-700">Accounting only <span className="text-xs text-gray-400">(HSN-aggregated, no stock items)</span></span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="radio" name="voucherMode" value="inventory" checked={voucherMode === 'inventory'} onChange={() => { setVoucherMode('inventory'); if (company) updateCompany(company.id, { voucher_mode: 'inventory' }).catch(() => {}); }} className="accent-indigo-600" />
                <span className="text-sm text-gray-700">Inventory <span className="text-xs text-gray-400">(item-level qty, rate, discount)</span></span>
              </label>
            </div>
          </div>

        </div>

        {/* ── Step 2: Preview ── */}
        <div className="bg-white border border-gray-200 rounded-xl p-6 mb-5">
          <h2 className="text-sm font-semibold text-gray-700 mb-1">
            <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-indigo-600 text-white text-xs mr-2">2</span>
            Preview Ledger Assignments
          </h2>
          <p className="text-xs text-gray-400 mb-4">
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
                {previewSuggestedCount > 0 && (
                  <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-2">
                    <span className="text-sm font-semibold text-amber-800">
                      {previewSuggestedCount} AI suggestion{previewSuggestedCount !== 1 ? 's' : ''} - verify ✦
                    </span>
                  </div>
                )}
                {previewSkippedCount > 0 && (
                  <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-2">
                    <span className="text-sm font-semibold text-red-800">
                      {previewSkippedCount} row{previewSkippedCount !== 1 ? 's' : ''} with errors
                    </span>
                  </div>
                )}
                {previewWarningCount > 0 && (
                  <div className="bg-gray-50 border border-gray-200 rounded-lg px-4 py-2">
                    <span className="text-sm font-semibold text-gray-600">
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

              {/* Auto-suggest notice */}

              {/* Flat preview table - one row per line item, with inline bulk-accept checkboxes */}
              <FlatPreviewTable
                rows={previewRows}
                invoices={invoices}
                suppliers={cachedMasters?.suppliers ?? []}
                expenseLedgers={cachedMasters?.expenseLedgers ?? []}
                stockItems={cachedMasters?.stockItems ?? []}
                initialLockedInvoices={initialLockedInvoices}
                companyId={company!.id}
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
                    if (p.vendorLedger && !seenVendor.has(p.vendorName)) {
                      seenVendor.add(p.vendorName);
                      try { await addSupplier(company.id, { vendor_name: p.vendorName, vendor_gstin: p.vendorGstin, tally_ledger_name: p.vendorLedger }); }
                      catch (e) { errs.push(`Vendor "${p.vendorName}": ${getErrMsg(e)}`); }
                    }
                    // 2. Stock items → stock_item_masters
                    for (const si of p.stockItems) {
                      if (si.tallyName && !seenStock.has(si.desc)) {
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
                      if (ch.tallyName && !seenExp.has(expKey)) {
                        seenExp.add(expKey);
                        if (ch.keyword === 'Discount') {
                          try { await updateCompany(company.id, { discount_ledger_name: ch.tallyName }); }
                          catch (e) { errs.push(`Discount ledger: ${getErrMsg(e)}`); }
                          continue;
                        }
                        // Use the actual charge GST rate (even 0%); only fall back to defaults if null
                        const defaults = getExpenseDefaults(ch.keyword);
                        const gstPct = ch.gst_percent != null
                          ? ch.gst_percent
                          : (defaults?.gst_percent ?? null);
                        const sacCode = ch.sac_code || defaults?.sac_code || undefined;
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
                      if (p.cgstLedger && !seenCgst) {
                        seenCgst = true;
                        try { await addDutiesTaxes(company.id, { tax_component: 'CGST', tax_rate: null, tally_ledger_name: p.cgstLedger }); }
                        catch (e) { errs.push(`CGST ledger: ${getErrMsg(e)}`); }
                      }
                      if (p.sgstLedger && !seenSgst) {
                        seenSgst = true;
                        try { await addDutiesTaxes(company.id, { tax_component: 'SGST', tax_rate: null, tally_ledger_name: p.sgstLedger }); }
                        catch (e) { errs.push(`SGST ledger: ${getErrMsg(e)}`); }
                      }
                    } else if (p.taxType === 'igst') {
                      if (p.igstLedger && !seenIgst) {
                        seenIgst = true;
                        try { await addDutiesTaxes(company.id, { tax_component: 'IGST', tax_rate: null, tally_ledger_name: p.igstLedger }); }
                        catch (e) { errs.push(`IGST ledger: ${getErrMsg(e)}`); }
                      }
                    }
                    // 5. Round off ledger → expense_ledger_masters
                    if (p.roLedger && !seenRo.has(p.roLedger)) {
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
        <div className="bg-white border border-gray-200 rounded-xl p-6 mb-5">
          <h2 className="text-sm font-semibold text-gray-700 mb-1">
            <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-indigo-600 text-white text-xs mr-2">3</span>
            Generate &amp; Download XML
          </h2>
          <p className="text-xs text-gray-400 mb-4">
            Import masters first (each type separately), then import vouchers. Each button downloads one XML file.
          </p>

          {/* Master XML buttons - one per master type */}
          <div className="mb-4">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Masters (import in order)</p>
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
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Vouchers (import after all masters succeed)</p>
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
            <p className="mt-3 text-xs text-gray-500">
              Last downloaded: <span className="font-mono">{xmlFilename}</span>
            </p>
          )}
        </div>

        {/* How-to */}
        <div className="bg-blue-50 border border-blue-200 rounded-xl px-5 py-4 text-sm text-blue-800">
          <p className="font-semibold mb-2">How to import into Tally</p>
          <p className="text-xs text-blue-700 mb-2">
            Import each master type separately first, then import vouchers. Safe to re-import - Tally silently skips masters that already exist.
          </p>
          <ol className="list-decimal list-inside space-y-1.5 text-blue-700 text-xs">
            <li>Open Tally → select company <strong>{company?.tally_company_name ?? '-'}</strong></li>
            <li>
              <strong>Import each master:</strong> Gateway of Tally → Import Data → Masters → select the file
              <span className="block ml-5 mt-0.5 text-blue-600">Order: Stock Items → Purchase Ledgers → Expense Ledgers → Duties &amp; Taxes → Sundry Creditors</span>
            </li>
            <li>
              <strong>Import Vouchers</strong> only after all masters succeed: Import Data → Vouchers → select <em>…_vouchers.xml</em>
            </li>
          </ol>
        </div>
      </main>
    </div>
  );
}
