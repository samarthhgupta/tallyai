'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { getPurchaseRegister, savePurchaseLedgerConfig, getCompany } from '@/lib/db';
import { loadSuppliers, addSupplier } from '@/lib/suppliers';
import { loadDutiesTaxes } from '@/lib/dutiesTaxes';
import { loadStockItems, addStockItem } from '@/lib/stockItems';
import { loadExpenseLedgers, addExpenseLedger } from '@/lib/expenseLedgers';
import { loadVoucherTypes } from '@/lib/voucherTypes';
import { generateTallyXml, generateMastersXml, buildTallyPreview, suggestSupplier, suggestExpenseLedger, suggestStockItem, type PurchaseLedgerEntry, type PreviewRow } from '@/lib/xmlGenerator';
import type { StoredInvoice } from '@/types/invoice';
import AppSidebar from '@/components/AppSidebar';
import { currentFY } from '@/lib/fyPeriod';
import { useCompany } from '@/lib/companyContext';
import FYPeriodSelector from '@/components/FYPeriodSelector';
import * as XLSX from 'xlsx';

// ─── Constants ────────────────────────────────────────────────────────────────

const COMMON_GST_RATES = [0, 5, 12, 18, 28];

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

// ─── Auto-suggest purchase ledgers from invoice data ─────────────────────────
// Scans all accepted invoices → finds distinct GST rates → proposes standard
// Tally ledger names. Accountant can edit names before saving.

function autoSuggestPurchaseLedgers(invoices: StoredInvoice[]): PurchaseLedgerEntry[] {
  const rates = new Set<number>();
  for (const inv of invoices) {
    for (const item of (inv.line_items ?? [])) {
      if (typeof item.gst_percent === 'number') rates.add(item.gst_percent);
    }
  }
  const sorted = Array.from(rates).sort((a, b) => a - b);
  const entries: PurchaseLedgerEntry[] = sorted.map((rate) => ({
    gst_percent: rate,
    tally_ledger_name: rate === 0 ? 'Purchases (Exempt)' : `Purchases @${rate}%`,
  }));
  // Add a catch-all fallback for any rate not explicitly listed
  entries.push({ gst_percent: null, tally_ledger_name: 'Purchases' });
  return entries;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function PurchaseLedgerRow({
  entry, isSuggested, onChange, onRemove,
}: {
  entry: PurchaseLedgerEntry;
  isSuggested: boolean;
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
      <div className="flex-1 relative">
        <input
          type="text"
          value={entry.tally_ledger_name}
          onChange={(e) => onChange({ ...entry, tally_ledger_name: e.target.value })}
          placeholder="Tally purchase ledger name (exact)"
          className={`w-full border rounded-md px-3 py-1.5 text-sm font-mono text-gray-900 ${
            isSuggested ? 'border-amber-300 bg-amber-50' : 'border-gray-200'
          }`}
        />
        {isSuggested && (
          <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-amber-600 font-medium pointer-events-none">
            suggested
          </span>
        )}
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

// ─── Flat Preview Table (one row per line item, Excel format) ─────────────────

import type { SupplierMaster } from '@/lib/suppliers';

interface FlatDisplayRow {
  // invoice-level
  invoiceDate: string;
  invoiceNo: string;
  voucherType: string;
  vendorName: string;
  vendorLedger: string;
  vendorUnmapped: boolean;
  gstin: string;
  gstRegType: string;
  // item-level
  purchaseLedger: string;
  itemDesc: string;
  hsn: string;
  stockItem: string;
  stockItemUnmapped: boolean;
  taxRate: number | null;
  qty: number | null;
  uom: string;
  rate: number | null;
  disc: number | null;
  amount: number;
  // invoice-level shown only on first item row
  isFirst: boolean;
  charges: Array<{ desc: string; ledger: string; unmapped: boolean; amount: number }>;
  cgstLedger: string; cgstAmt: number;
  sgstLedger: string; sgstAmt: number;
  igstLedger: string; igstAmt: number;
  roLedger: string; roAmt: number;
}

function FlatPreviewTable({
  rows, invoices, suppliers, expenseLedgers, stockItems, purchaseLedgers,
  onMapExpense, onMapSupplier, onMapStockItem,
}: {
  rows: PreviewRow[];
  invoices: StoredInvoice[];
  suppliers: SupplierMaster[];
  expenseLedgers: { tally_ledger_name: string }[];
  stockItems: { tally_item_name: string }[];
  purchaseLedgers: PurchaseLedgerEntry[];
  onMapExpense: (description: string, ledgerName: string) => void;
  onMapSupplier: (vendorName: string, ledgerName: string) => void;
  onMapStockItem: (description: string, tallyItemName: string) => void;
}) {
  const isInventoryMode = rows.some((r) => r.ledger_type === 'Inventory');

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
    const cgst = invRows.find((r) => r.ledger_type === 'CGST');
    const sgst = invRows.find((r) => r.ledger_type === 'SGST');
    const igst = invRows.find((r) => r.ledger_type === 'IGST');
    const ro   = invRows.find((r) => r.ledger_type === 'Round Off');

    const invoice  = invoices.find((i) => i.invoice_number === invNo);
    const supplier = suppliers.find((s) => s.tally_ledger_name === partyRow?.party_ledger);

    const vendorLedger  = partyRow?.tally_ledger_name ?? '—';
    const vendorUnmapped = partyRow?.status === 'Skipped';

    const charges = chargeRows.map((c) => {
      const rawDesc = c.tally_ledger_name.replace(/^— NO LEDGER FOR "(.+)" —$/, '$1');
      return {
        desc: rawDesc,
        ledger: c.tally_ledger_name.startsWith('—') ? '' : c.tally_ledger_name,
        unmapped: !!(c.warning?.includes('No expense ledger')),
        amount: c.amount,
      };
    });

    const invoiceTail = {
      charges,
      cgstLedger: cgst?.tally_ledger_name?.startsWith('—') ? '' : (cgst?.tally_ledger_name ?? ''),
      cgstAmt: cgst?.amount ?? 0,
      sgstLedger: sgst?.tally_ledger_name?.startsWith('—') ? '' : (sgst?.tally_ledger_name ?? ''),
      sgstAmt: sgst?.amount ?? 0,
      igstLedger: igst?.tally_ledger_name?.startsWith('—') ? '' : (igst?.tally_ledger_name ?? ''),
      igstAmt: igst?.amount ?? 0,
      roLedger:  ro?.tally_ledger_name?.startsWith('(') ? '' : (ro?.tally_ledger_name ?? ''),
      roAmt:  ro?.amount ?? 0,
    };
    const emptyTail = { charges: [], cgstLedger: '', cgstAmt: 0, sgstLedger: '', sgstAmt: 0, igstLedger: '', igstAmt: 0, roLedger: '', roAmt: 0 };

    const base = {
      invoiceDate: partyRow?.invoice_date ?? '',
      invoiceNo: invNo,
      voucherType: partyRow?.voucher_type_name ?? '',
      vendorName: partyRow?.vendor_name ?? '',
      vendorLedger,
      vendorUnmapped,
      gstin: invoice?.vendor_gstin ?? '',
      gstRegType: supplier ? (supplier.is_unregistered ? 'Unregistered' : 'Regular') : '',
    };

    const itemsToRender = isInventoryMode ? invRows2 : purchRows;

    if (itemsToRender.length === 0) {
      // No line items: just render one row for the invoice (e.g., supplier unmapped)
      displayRows.push({
        ...base, isFirst: true, ...invoiceTail,
        purchaseLedger: '', itemDesc: '', hsn: '', stockItem: '', stockItemUnmapped: false,
        taxRate: null, qty: null, uom: '', rate: null, disc: null,
        amount: Math.abs(partyRow?.amount ?? 0),
      });
      continue;
    }

    itemsToRender.forEach((row, idx) => {
      const lineItem = invoice?.line_items.find((li) => li.description === row.item_description);
      const gstPct   = lineItem?.gst_percent ?? null;
      const plLedger = gstPct != null
        ? (purchaseLedgers.find((p) => p.gst_percent === gstPct) ?? purchaseLedgers.find((p) => p.gst_percent == null))?.tally_ledger_name ?? ''
        : (purchaseLedgers[0]?.tally_ledger_name ?? '');

      const isInv = row.ledger_type === 'Inventory';

      displayRows.push({
        ...base,
        isFirst: idx === 0,
        ...(idx === 0 ? invoiceTail : emptyTail),
        purchaseLedger: isInv ? plLedger : row.tally_ledger_name,
        itemDesc: isInv ? (row.item_description ?? '') : '',
        hsn: lineItem?.hsn ?? '',
        stockItem: isInv ? (row.status === 'Skipped' ? '' : (row.stock_item_name ?? '')) : '',
        stockItemUnmapped: isInv && row.status === 'Skipped',
        taxRate: gstPct,
        qty:  isInv ? (row.qty ?? null)  : null,
        uom:  isInv ? (row.uom ?? '')    : '',
        rate: isInv ? (row.rate ?? null) : null,
        disc: isInv ? (row.disc_percent ?? null) : null,
        amount: row.amount,
      });
    });
  }

  const maxCharges = Math.max(0, ...displayRows.map((r) => r.charges.length));

  const TH = ({ children, right }: { children: React.ReactNode; right?: boolean }) => (
    <th className={`px-3 py-2.5 border-b border-gray-200 font-semibold text-gray-500 uppercase tracking-wide whitespace-nowrap text-[11px] ${right ? 'text-right' : 'text-left'}`}>
      {children}
    </th>
  );

  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 shadow-sm">
      <table className="min-w-max text-xs border-collapse">
        <thead className="bg-gray-50">
          <tr>
            {/* Invoice Date */}
            <TH>Date</TH>
            {/* Invoice No */}
            <TH>Invoice No</TH>
            {/* Voucher Type */}
            <TH>Voucher Type</TH>
            {/* Vendor Name */}
            <TH>Vendor (Invoice)</TH>
            {/* Vendor Ledger */}
            <TH>Vendor Ledger (Tally)</TH>
            {/* GSTIN */}
            <TH>GSTIN</TH>
            {/* Reg Type */}
            <TH>GST Reg Type</TH>
            {/* Purchase Ledger */}
            <TH>Purchase Ledger (Tally)</TH>
            {/* Item */}
            <TH>Item Name + HSN (Invoice)</TH>
            {/* Stock Item */}
            <TH>Stock Item (Tally)</TH>
            {/* Tax Rate */}
            <TH right>Tax Rate %</TH>
            {/* Qty */}
            <TH right>Qty</TH>
            {/* UOM */}
            <TH>UOM</TH>
            {/* Rate */}
            <TH right>Rate (₹)</TH>
            {/* Disc */}
            <TH right>Discount %</TH>
            {/* Amount */}
            <TH right>Amount (₹)</TH>
            {/* Charges */}
            {Array.from({ length: maxCharges }, (_, ci) => (
              <React.Fragment key={`ch${ci}`}>
                <TH>Charge {ci + 1} (Invoice)</TH>
                <TH>Charge {ci + 1} Ledger (Tally)</TH>
                <TH right>Charge {ci + 1} Amt (₹)</TH>
              </React.Fragment>
            ))}
            {/* CGST */}
            <TH>CGST Ledger (Tally)</TH>
            <TH right>CGST Amt (₹)</TH>
            {/* SGST */}
            <TH>SGST Ledger (Tally)</TH>
            <TH right>SGST Amt (₹)</TH>
            {/* IGST */}
            <TH>IGST Ledger (Tally)</TH>
            <TH right>IGST Amt (₹)</TH>
            {/* Round Off */}
            <TH>Round Off Ledger (Tally)</TH>
            <TH right>Round Off Amt (₹)</TH>
          </tr>
        </thead>
        <tbody>
          {displayRows.map((row, i) => {
            const prevRow = displayRows[i - 1];
            const isNewInvoice = !prevRow || prevRow.invoiceNo !== row.invoiceNo;
            const hasError = row.vendorUnmapped || row.stockItemUnmapped;
            const rowBg = hasError
              ? 'bg-red-50'
              : isNewInvoice
              ? 'bg-white'
              : 'bg-blue-50/20';
            const borderTop = isNewInvoice && i > 0 ? 'border-t-2 border-gray-300' : 'border-t border-gray-100';

            return (
              <tr key={i} className={`${rowBg} ${borderTop} hover:bg-yellow-50/40 transition-colors`}>
                {/* Date */}
                <td className="px-3 py-2 whitespace-nowrap font-mono text-gray-600">{row.invoiceDate}</td>
                {/* Invoice No */}
                <td className="px-3 py-2 whitespace-nowrap font-mono font-semibold text-gray-800">{row.invoiceNo}</td>
                {/* Voucher Type */}
                <td className="px-3 py-2 whitespace-nowrap">
                  {row.isFirst && <span className="inline-block font-mono text-[11px] px-2 py-0.5 rounded bg-gray-100 text-gray-700">{row.voucherType}</span>}
                </td>
                {/* Vendor Name */}
                <td className="px-3 py-2 max-w-[160px] truncate text-gray-700" title={row.vendorName}>{row.vendorName}</td>
                {/* Vendor Ledger */}
                <td className="px-3 py-2 whitespace-nowrap">
                  {row.isFirst ? (
                    row.vendorUnmapped ? (
                      <select defaultValue="" onChange={(e) => e.target.value && onMapSupplier(row.vendorName, e.target.value)}
                        className="border border-red-300 rounded px-2 py-1 text-xs bg-white focus:ring-1 focus:ring-indigo-400 max-w-[180px]">
                        <option value="">Map supplier…</option>
                        {suppliers.map((s) => <option key={s.tally_ledger_name} value={s.tally_ledger_name}>{s.tally_ledger_name}</option>)}
                      </select>
                    ) : (
                      <span className="font-mono font-medium text-purple-800">{row.vendorLedger}</span>
                    )
                  ) : null}
                </td>
                {/* GSTIN */}
                <td className="px-3 py-2 font-mono text-gray-400 whitespace-nowrap text-[11px]">{row.gstin || '—'}</td>
                {/* Reg Type */}
                <td className="px-3 py-2 whitespace-nowrap">
                  {row.isFirst && row.gstRegType && (
                    <span className={`inline-block text-[11px] px-1.5 py-0.5 rounded font-medium ${row.gstRegType === 'Unregistered' ? 'bg-amber-100 text-amber-700' : 'bg-green-100 text-green-700'}`}>
                      {row.gstRegType}
                    </span>
                  )}
                </td>
                {/* Purchase Ledger */}
                <td className="px-3 py-2 font-mono text-blue-800 whitespace-nowrap">{row.purchaseLedger || '—'}</td>
                {/* Item Name + HSN */}
                <td className="px-3 py-2 max-w-[220px]">
                  <div className="truncate text-gray-800" title={row.itemDesc}>{row.itemDesc || '—'}</div>
                  {row.hsn && <div className="text-gray-400 font-mono text-[10px]">HSN: {row.hsn}</div>}
                </td>
                {/* Stock Item */}
                <td className="px-3 py-2 whitespace-nowrap">
                  {row.stockItemUnmapped ? (
                    <select defaultValue="" onChange={(e) => e.target.value && onMapStockItem(row.itemDesc, e.target.value)}
                      className="border border-amber-300 rounded px-2 py-1 text-xs bg-amber-50 focus:ring-1 focus:ring-indigo-400 max-w-[180px]">
                      <option value="">Map stock item…</option>
                      {stockItems.map((s) => <option key={s.tally_item_name} value={s.tally_item_name}>{s.tally_item_name}</option>)}
                    </select>
                  ) : (
                    <span className="font-mono text-indigo-700">{row.stockItem || (isInventoryMode ? '—' : '')}</span>
                  )}
                </td>
                {/* Tax Rate */}
                <td className="px-3 py-2 text-right text-gray-600">{row.taxRate != null ? `${row.taxRate}%` : '—'}</td>
                {/* Qty */}
                <td className="px-3 py-2 text-right font-mono text-gray-700">{row.qty != null ? row.qty : '—'}</td>
                {/* UOM */}
                <td className="px-3 py-2 text-gray-500">{row.uom || '—'}</td>
                {/* Rate */}
                <td className="px-3 py-2 text-right font-mono text-gray-700">{row.rate != null ? row.rate.toFixed(2) : '—'}</td>
                {/* Disc */}
                <td className="px-3 py-2 text-right text-gray-500">{row.disc != null && row.disc > 0 ? `${row.disc}%` : '—'}</td>
                {/* Amount */}
                <td className="px-3 py-2 text-right font-mono font-semibold text-gray-900">
                  {row.amount.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </td>
                {/* Charges */}
                {Array.from({ length: maxCharges }, (_, ci) => {
                  const ch = row.isFirst ? row.charges[ci] : undefined;
                  return (
                    <React.Fragment key={`ch${ci}`}>
                      <td className="px-3 py-2 text-gray-600">{ch?.desc ?? ''}</td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {ch && (ch.unmapped ? (
                          <select defaultValue="" onChange={(e) => e.target.value && onMapExpense(ch.desc, e.target.value)}
                            className="border border-amber-300 rounded px-2 py-1 text-xs bg-amber-50 focus:ring-1 focus:ring-indigo-400 max-w-[160px]">
                            <option value="">Map ledger…</option>
                            {expenseLedgers.map((l) => <option key={l.tally_ledger_name} value={l.tally_ledger_name}>{l.tally_ledger_name}</option>)}
                          </select>
                        ) : (
                          <span className="font-mono text-orange-700">{ch.ledger}</span>
                        ))}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-gray-700">
                        {ch ? ch.amount.toLocaleString('en-IN', { minimumFractionDigits: 2 }) : ''}
                      </td>
                    </React.Fragment>
                  );
                })}
                {/* CGST */}
                <td className="px-3 py-2 font-mono text-teal-700 whitespace-nowrap">{row.isFirst ? (row.cgstLedger || '—') : ''}</td>
                <td className="px-3 py-2 text-right font-mono text-gray-700">{row.isFirst && row.cgstAmt !== 0 ? row.cgstAmt.toFixed(2) : ''}</td>
                {/* SGST */}
                <td className="px-3 py-2 font-mono text-teal-700 whitespace-nowrap">{row.isFirst ? (row.sgstLedger || '—') : ''}</td>
                <td className="px-3 py-2 text-right font-mono text-gray-700">{row.isFirst && row.sgstAmt !== 0 ? row.sgstAmt.toFixed(2) : ''}</td>
                {/* IGST */}
                <td className="px-3 py-2 font-mono text-cyan-700 whitespace-nowrap">{row.isFirst ? (row.igstLedger || '—') : ''}</td>
                <td className="px-3 py-2 text-right font-mono text-gray-700">{row.isFirst && row.igstAmt !== 0 ? row.igstAmt.toFixed(2) : ''}</td>
                {/* Round Off */}
                <td className="px-3 py-2 font-mono text-gray-500 whitespace-nowrap">{row.isFirst ? (row.roLedger || '') : ''}</td>
                <td className="px-3 py-2 text-right font-mono text-gray-500">{row.isFirst && row.roAmt !== 0 ? row.roAmt.toFixed(2) : ''}</td>
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

  const [purchaseLedgers, setPurchaseLedgers] = useState<PurchaseLedgerEntry[]>([
    { gst_percent: null, tally_ledger_name: '' },
  ]);
  // Track which ledger entries are auto-suggested (unsaved) vs confirmed
  const [suggestedIndexes, setSuggestedIndexes] = useState<Set<number>>(new Set());
  const [savingMapping, setSavingMapping] = useState(false);
  const [mappingSaved, setMappingSaved] = useState(false);

  const [voucherMode, setVoucherMode] = useState<'accounting_only' | 'inventory'>('accounting_only');

  const [previewing, setPreviewing] = useState(false);
  const [previewRows, setPreviewRows] = useState<PreviewRow[] | null>(null);
  const [previewError, setPreviewError] = useState('');

  const [generatingXml, setGeneratingXml] = useState(false);
  const [xmlBlob, setXmlBlob] = useState<Blob | null>(null);
  const [xmlFilename, setXmlFilename] = useState('');
  const [generatingMasters, setGeneratingMasters] = useState(false);
  const [mastersBlob, setMastersBlob] = useState<Blob | null>(null);

  const [loadError, setLoadError] = useState('');

  // Auth
  useEffect(() => {
    if (companyLoading) return;
    getSession().then((session) => {
      if (!session) { router.replace('/login'); return; }
      if (!company) router.replace('/select-company');
    });
  }, [company, companyLoading, router]);

  // Load purchase ledger config + voucher mode from DB when company changes
  useEffect(() => {
    if (!company?.id) return;
    getCompany(company.id).then((fresh) => {
      if (fresh.purchase_ledger_config && fresh.purchase_ledger_config.length > 0) {
        setPurchaseLedgers(fresh.purchase_ledger_config);
        setSuggestedIndexes(new Set()); // saved config — no suggestions pending
      }
      if (fresh.voucher_mode) setVoucherMode(fresh.voucher_mode);
    }).catch(() => {});
  }, [company?.id]);

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

  useEffect(() => { setPreviewRows(null); setXmlBlob(null); }, [purchaseLedgers]);

  const validLedgers = useMemo(
    () => purchaseLedgers.filter((p) => p.tally_ledger_name.trim() !== ''),
    [purchaseLedgers],
  );

  const hasSuggestedPending = suggestedIndexes.size > 0;

  const fileBase = `${company?.tally_company_name ?? company?.name ?? 'export'}_${selectedFY}`
    .replace(/[^a-zA-Z0-9._-]/g, '_');

  // Preview only needs: company, tally_company_name, invoices
  function validateForPreview(): string | null {
    if (!company) return 'No company selected.';
    if (!company.tally_company_name) return 'Tally Company Name is missing — update it in Companies first.';
    if (invoices.length === 0) return 'No accepted invoices found for the selected period.';
    return null;
  }

  // XML generation additionally needs confirmed purchase ledger names
  function validateForXml(): string | null {
    const base = validateForPreview();
    if (base) return base;
    if (validLedgers.length === 0) return 'Configure at least one purchase ledger mapping and save it before generating XML.';
    return null;
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
      const mode = fresh.voucher_mode ?? 'accounting_only';
      setVoucherMode(mode);

      // Auto-suggest purchase ledgers if none are configured yet
      let ledgersToUse = validLedgers;
      if (ledgersToUse.length === 0 && invoices.length > 0) {
        const suggestions = autoSuggestPurchaseLedgers(invoices);
        setPurchaseLedgers(suggestions);
        setSuggestedIndexes(new Set(suggestions.map((_, i) => i)));
        ledgersToUse = suggestions;
      }

      const rows = buildTallyPreview({
        invoices, ...masters,
        purchaseLedgers: ledgersToUse,
        tallyCompanyName: company!.tally_company_name!,
        voucherMode: mode,
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

  // ── Step 3: Generate and download XML ──
  const handleGenerateXml = async () => {
    const err = validateForXml();
    if (err) { alert(err); return; }
    setGeneratingXml(true);
    setXmlBlob(null);
    try {
      const masters = await loadMasters(company!.id);
      const fresh = await getCompany(company!.id);
      const output = generateTallyXml({
        invoices, ...masters,
        purchaseLedgers: validLedgers,
        tallyCompanyName: company!.tally_company_name!,
        voucherMode: fresh.voucher_mode ?? 'accounting_only',
        discountLedgerName: fresh.discount_ledger_name,
      });
      const blob = new Blob([output.xml], { type: 'application/xml' });
      setXmlBlob(blob);
      setXmlFilename(`${fileBase}_purchase.xml`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `${fileBase}_purchase.xml`;
      a.click(); URL.revokeObjectURL(url);
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : 'XML generation failed');
    } finally {
      setGeneratingXml(false);
    }
  };

  const handleGenerateMastersXml = async () => {
    const err = validateForXml();
    if (err) { alert(err); return; }
    setGeneratingMasters(true);
    setMastersBlob(null);
    try {
      const masters = await loadMasters(company!.id);
      const fresh = await getCompany(company!.id);
      const xml = generateMastersXml({
        invoices, ...masters,
        purchaseLedgers: validLedgers,
        tallyCompanyName: company!.tally_company_name!,
        voucherMode: fresh.voucher_mode ?? 'accounting_only',
        discountLedgerName: fresh.discount_ledger_name,
      });
      const blob = new Blob([xml], { type: 'application/xml' });
      setMastersBlob(blob);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `${fileBase}_masters.xml`;
      a.click(); URL.revokeObjectURL(url);
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : 'Masters XML generation failed');
    } finally {
      setGeneratingMasters(false);
    }
  };

  const handleSaveMapping = async () => {
    if (!company) return;
    setSavingMapping(true);
    setMappingSaved(false);
    try {
      await savePurchaseLedgerConfig(company.id, purchaseLedgers);
      setSuggestedIndexes(new Set()); // all confirmed after save
      setMappingSaved(true);
      setTimeout(() => setMappingSaved(false), 3000);
    } finally {
      setSavingMapping(false);
    }
  };

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
                <input type="radio" name="voucherMode" value="accounting_only" checked={voucherMode === 'accounting_only'} onChange={() => setVoucherMode('accounting_only')} className="accent-indigo-600" />
                <span className="text-sm text-gray-700">Accounting only <span className="text-xs text-gray-400">(HSN-aggregated, no stock items)</span></span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="radio" name="voucherMode" value="inventory" checked={voucherMode === 'inventory'} onChange={() => setVoucherMode('inventory')} className="accent-indigo-600" />
                <span className="text-sm text-gray-700">Inventory <span className="text-xs text-gray-400">(item-level qty, rate, discount)</span></span>
              </label>
            </div>
          </div>

          {/* Purchase Ledger Mapping */}
          <div className="border-t border-gray-100 pt-4">
            <div className="flex items-center justify-between mb-1">
              <p className="text-xs font-semibold text-gray-600">Purchase Ledger Mapping</p>
              {hasSuggestedPending && (
                <span className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-0.5">
                  Auto-suggested from invoices — review names and save
                </span>
              )}
            </div>
            <p className="text-xs text-gray-400 mb-3">
              Maps each GST rate to the exact Tally purchase ledger name.
              {!hasSuggestedPending && validLedgers.length === 0 && invoices.length > 0 && (
                <> Leave empty and click <strong>Preview</strong> — ledger names will be auto-suggested from your invoices.</>
              )}
            </p>
            <div className="space-y-2.5">
              {purchaseLedgers.map((entry, idx) => (
                <PurchaseLedgerRow
                  key={idx}
                  entry={entry}
                  isSuggested={suggestedIndexes.has(idx)}
                  onChange={(u) => {
                    setPurchaseLedgers((prev) => prev.map((r, i) => (i === idx ? u : r)));
                    // Editing a suggested row marks it as modified (still unsaved)
                  }}
                  onRemove={() => {
                    setPurchaseLedgers((prev) => prev.filter((_, i) => i !== idx));
                    setSuggestedIndexes((prev) => {
                      const next = new Set<number>();
                      prev.forEach((n) => { if (n < idx) next.add(n); else if (n > idx) next.add(n - 1); });
                      return next;
                    });
                  }}
                />
              ))}
            </div>
            <div className="flex items-center gap-4 mt-3">
              <button
                onClick={() => setPurchaseLedgers((prev) => [...prev, { gst_percent: null, tally_ledger_name: '' }])}
                className="text-sm text-indigo-600 hover:text-indigo-800 font-medium"
              >
                + Add row
              </button>
              <button
                disabled={savingMapping || !company?.id}
                onClick={handleSaveMapping}
                className={`text-sm px-3 py-1.5 rounded-md text-white disabled:opacity-40 transition-colors ${
                  hasSuggestedPending
                    ? 'bg-amber-600 hover:bg-amber-700'
                    : 'bg-indigo-600 hover:bg-indigo-700'
                }`}
              >
                {savingMapping ? 'Saving…' : hasSuggestedPending ? 'Confirm & Save Mapping' : 'Save Mapping'}
              </button>
              {mappingSaved && <span className="text-xs text-green-600 font-medium">✓ Saved</span>}
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
            {validLedgers.length === 0 && invoices.length > 0 && !previewing && !previewRows && (
              <> Purchase ledger names will be <strong>auto-suggested</strong> when you click Preview.</>
            )}
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
                {previewSkippedCount > 0 && (
                  <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-2">
                    <span className="text-sm font-semibold text-red-800">
                      {previewSkippedCount} row{previewSkippedCount !== 1 ? 's' : ''} with errors
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

              {/* Auto-suggest notice */}
              {hasSuggestedPending && (
                <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
                  <svg className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <div className="text-xs text-amber-800">
                    <strong>Purchase ledger names were auto-suggested from your invoices.</strong>{' '}
                    Review them in the configuration above — rename any that don&apos;t match your Tally chart of accounts — then click{' '}
                    <button onClick={handleSaveMapping} className="underline font-semibold">Confirm &amp; Save Mapping</button>{' '}
                    before generating XML.
                  </div>
                </div>
              )}

              {/* Flat preview table — one row per line item */}
              <FlatPreviewTable
                rows={previewRows}
                invoices={invoices}
                suppliers={cachedMasters?.suppliers ?? []}
                expenseLedgers={cachedMasters?.expenseLedgers ?? []}
                stockItems={cachedMasters?.stockItems ?? []}
                purchaseLedgers={validLedgers}
                onMapExpense={async (description, ledgerName) => {
                  if (!company?.id) return;
                  try { await addExpenseLedger(company.id, { tally_ledger_name: ledgerName, expense_keyword: description }); handlePreview(); }
                  catch (e: unknown) { alert(e instanceof Error ? e.message : 'Failed to save'); }
                }}
                onMapSupplier={async (vendorName, ledgerName) => {
                  if (!company?.id) return;
                  try {
                    const inv = invoices.find((i) => i.vendor_name === vendorName);
                    await addSupplier(company.id, { vendor_name: vendorName, vendor_gstin: inv?.vendor_gstin ?? '', tally_ledger_name: ledgerName });
                    handlePreview();
                  } catch (e: unknown) { alert(e instanceof Error ? e.message : 'Failed to save'); }
                }}
                onMapStockItem={async (description, tallyItemName) => {
                  if (!company?.id) return;
                  try { await addStockItem(company.id, { tally_item_name: tallyItemName, alias_name: description }); handlePreview(); }
                  catch (e: unknown) { alert(e instanceof Error ? e.message : 'Failed to save'); }
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
            Once you&apos;re satisfied with the preview, generate the Tally XML file. The file downloads automatically.
          </p>

          {hasSuggestedPending && (
            <div className="mb-4 flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-lg px-4 py-2.5 text-sm text-amber-800">
              <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
              </svg>
              <span>
                Purchase ledger names are still <strong>auto-suggested</strong>.{' '}
                <button onClick={handleSaveMapping} className="underline font-semibold">
                  Confirm &amp; Save Mapping
                </button>{' '}
                above before generating XML.
              </span>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={handleGenerateMastersXml}
              disabled={generatingMasters || !company || invoices.length === 0 || hasSuggestedPending}
              className="flex items-center gap-2 px-5 py-2.5 bg-indigo-600 text-white rounded-lg text-sm font-semibold hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              {generatingMasters ? 'Generating…' : '1. Download Masters XML'}
            </button>

            <button
              onClick={handleGenerateXml}
              disabled={generatingXml || !company || invoices.length === 0 || hasSuggestedPending}
              className="flex items-center gap-2 px-5 py-2.5 bg-gray-900 text-white rounded-lg text-sm font-semibold hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              {generatingXml ? 'Generating…' : '2. Download Vouchers XML'}
            </button>

            {(mastersBlob || xmlBlob) && (
              <span className="text-xs text-gray-500 ml-1">
                {mastersBlob && <span className="font-mono">…_masters.xml</span>}
                {mastersBlob && xmlBlob && <span className="mx-1">·</span>}
                {xmlBlob && <span className="font-mono">{xmlFilename}</span>}
                <span className="ml-1">downloaded</span>
              </span>
            )}
          </div>
        </div>

        {/* How-to */}
        <div className="bg-blue-50 border border-blue-200 rounded-xl px-5 py-4 text-sm text-blue-800">
          <p className="font-semibold mb-2">How to import into Tally</p>
          <p className="text-xs text-blue-700 mb-2">
            Import <strong>Masters first</strong>, then Vouchers. Masters XML auto-creates any missing ledgers / stock items — safe to re-import (existing masters are skipped).
          </p>
          <ol className="list-decimal list-inside space-y-1.5 text-blue-700 text-xs">
            <li>Open Tally → select company <strong>{company?.tally_company_name ?? '—'}</strong></li>
            <li>
              <strong>Import Masters:</strong> Gateway of Tally → Import Data → Masters → select <em>…_masters.xml</em>
            </li>
            <li>
              <strong>Import Vouchers:</strong> Gateway of Tally → Import Data → Vouchers → select <em>…_purchase.xml</em>
            </li>
            <li>Tally will create purchase vouchers for all included invoices</li>
          </ol>
        </div>
      </main>
    </div>
  );
}
