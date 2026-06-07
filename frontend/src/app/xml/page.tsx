'use client';

import { useState, useEffect, useMemo } from 'react';
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

// ─── Invoice Preview Cards ────────────────────────────────────────────────────

function StatusDot({ status, warning }: { status: string; warning?: string }) {
  if (status === 'Skipped') return <span className="inline-block w-2 h-2 rounded-full bg-red-500" title="Error — will be excluded" />;
  if (warning) return <span className="inline-block w-2 h-2 rounded-full bg-amber-400" title={warning} />;
  return <span className="inline-block w-2 h-2 rounded-full bg-green-500" title="OK" />;
}

function InvoicePreviewCards({
  rows, invoices, expenseLedgers, suppliers, stockItems,
  onMapExpense, onMapSupplier, onMapStockItem,
}: {
  rows: PreviewRow[];
  invoices: StoredInvoice[];
  expenseLedgers: { tally_ledger_name: string }[];
  suppliers: { tally_ledger_name: string; vendor_name: string }[];
  stockItems: { tally_item_name: string }[];
  onMapExpense: (description: string, ledgerName: string) => void;
  onMapSupplier: (vendorName: string, ledgerName: string) => void;
  onMapStockItem: (description: string, tallyItemName: string) => void;
}) {
  // Group rows by invoice number, preserving order
  const invoiceOrder: string[] = [];
  const invoiceRowMap = new Map<string, PreviewRow[]>();
  rows.forEach((r) => {
    if (!invoiceRowMap.has(r.invoice_number)) {
      invoiceOrder.push(r.invoice_number);
      invoiceRowMap.set(r.invoice_number, []);
    }
    invoiceRowMap.get(r.invoice_number)!.push(r);
  });

  const defaultExpanded = invoiceOrder.length <= 10;
  const [expandedSet, setExpandedSet] = useState<Set<string>>(
    () => defaultExpanded ? new Set(invoiceOrder) : new Set()
  );

  const toggleCard = (invNo: string) => {
    setExpandedSet((prev) => {
      const next = new Set(prev);
      if (next.has(invNo)) next.delete(invNo);
      else next.add(invNo);
      return next;
    });
  };

  return (
    <div className="space-y-3">
      {invoiceOrder.map((invNo) => {
        const cardRows = invoiceRowMap.get(invNo)!;
        const partyRow = cardRows.find((r) => r.ledger_type === 'Party');
        const inventoryRows = cardRows.filter((r) => r.ledger_type === 'Inventory');
        const purchaseRows = cardRows.filter((r) => r.ledger_type === 'Purchase');
        const chargeRows = cardRows.filter((r) => r.ledger_type === 'Expense');
        const cgstRow = cardRows.find((r) => r.ledger_type === 'CGST');
        const sgstRow = cardRows.find((r) => r.ledger_type === 'SGST');
        const igstRow = cardRows.find((r) => r.ledger_type === 'IGST');
        const roundOffRow = cardRows.find((r) => r.ledger_type === 'Round Off');
        const discountRow = cardRows.find((r) => r.ledger_type === 'Discount');

        const invoiceMeta = invoices.find((i) => i.invoice_number === invNo);
        const totalAmount = partyRow?.amount ?? cardRows.reduce((s, r) => s + r.amount, 0);
        const errorCount = cardRows.filter((r) => r.status === 'Skipped').length;
        const warningCount = cardRows.filter((r) => r.warning && r.status !== 'Skipped').length;

        const isSupplierUnmapped = partyRow?.status === 'Skipped';
        const expanded = expandedSet.has(invNo);

        return (
          <div key={invNo} className={`rounded-xl border ${errorCount > 0 ? 'border-red-200' : 'border-gray-200'} bg-white overflow-hidden`}>
            {/* Header */}
            <button
              onClick={() => toggleCard(invNo)}
              className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-gray-50 transition-colors"
            >
              <span className="text-gray-400 text-xs select-none">{expanded ? '▼' : '▶'}</span>
              <span className="font-mono text-sm font-semibold text-gray-800 shrink-0">{invNo}</span>
              <span className="text-xs text-gray-400 shrink-0">{partyRow?.invoice_date ?? invoiceMeta?.invoice_date ?? ''}</span>
              <span className="text-sm text-gray-700 truncate max-w-[200px]" title={partyRow?.vendor_name}>
                {partyRow?.vendor_name ?? invoiceMeta?.vendor_name ?? ''}
              </span>

              {/* Supplier badge or dropdown */}
              {isSupplierUnmapped && partyRow ? (
                <span
                  className="shrink-0"
                  onClick={(e) => e.stopPropagation()}
                >
                  <select
                    defaultValue=""
                    onChange={(e) => e.target.value && onMapSupplier(partyRow.vendor_name, e.target.value)}
                    className="border border-red-300 rounded px-2 py-0.5 text-xs bg-white focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  >
                    <option value="">Map supplier…</option>
                    {suppliers.map((s) => (
                      <option key={s.tally_ledger_name} value={s.tally_ledger_name}>{s.tally_ledger_name}</option>
                    ))}
                  </select>
                </span>
              ) : partyRow ? (
                <span className="shrink-0 inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-green-50 border border-green-200 text-green-700 font-medium">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-500 inline-block" />
                  {partyRow.tally_ledger_name}
                </span>
              ) : null}

              {/* Voucher type */}
              {partyRow?.voucher_type_name && (
                <span className="shrink-0 text-xs font-mono px-2 py-0.5 rounded bg-gray-100 text-gray-600">
                  {partyRow.voucher_type_name}
                </span>
              )}

              <span className="ml-auto shrink-0 font-mono text-sm font-semibold text-gray-800">
                ₹{Math.abs(totalAmount).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>

              {/* Error / warning badges */}
              {(errorCount > 0 || warningCount > 0) && (
                <span className="shrink-0 flex items-center gap-1.5">
                  {errorCount > 0 && (
                    <span className="text-xs bg-red-100 text-red-700 font-semibold px-2 py-0.5 rounded-full">{errorCount} err</span>
                  )}
                  {warningCount > 0 && (
                    <span className="text-xs bg-amber-100 text-amber-700 font-semibold px-2 py-0.5 rounded-full">{warningCount} warn</span>
                  )}
                </span>
              )}
            </button>

            {/* Body */}
            {expanded && (
              <div className="border-t border-gray-100 px-4 py-3 space-y-4">

                {/* Section A: Inventory line items */}
                {inventoryRows.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Line Items</p>
                    <div className="overflow-x-auto rounded-lg border border-gray-100">
                      <table className="min-w-full text-xs">
                        <thead>
                          <tr className="bg-gray-50 text-gray-400 font-semibold uppercase tracking-wide">
                            <th className="px-3 py-2 text-left">#</th>
                            <th className="px-3 py-2 text-left">Description (as per invoice)</th>
                            <th className="px-3 py-2 text-left">→ Tally Stock Item</th>
                            <th className="px-3 py-2 text-left">HSN</th>
                            <th className="px-3 py-2 text-right">Qty</th>
                            <th className="px-3 py-2 text-left">UOM</th>
                            <th className="px-3 py-2 text-right">Rate</th>
                            <th className="px-3 py-2 text-right">Disc%</th>
                            <th className="px-3 py-2 text-right">Amount</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-50">
                          {inventoryRows.map((row, idx) => {
                            const isUnmapped = row.status === 'Skipped';
                            const itemDesc = row.item_description ?? '';
                            return (
                              <tr key={idx} className={isUnmapped ? 'bg-amber-50' : 'bg-white'}>
                                <td className="px-3 py-2 text-gray-400">{idx + 1}</td>
                                <td className="px-3 py-2 text-gray-700 max-w-[180px] truncate" title={itemDesc}>{itemDesc}</td>
                                <td className="px-3 py-2">
                                  {isUnmapped ? (
                                    <select
                                      defaultValue=""
                                      onChange={(e) => e.target.value && onMapStockItem(itemDesc, e.target.value)}
                                      className="border border-amber-300 rounded px-2 py-1 text-xs bg-white focus:outline-none focus:ring-1 focus:ring-indigo-500 max-w-[180px]"
                                    >
                                      <option value="">Pick stock item…</option>
                                      {stockItems.map((s) => (
                                        <option key={s.tally_item_name} value={s.tally_item_name}>{s.tally_item_name}</option>
                                      ))}
                                    </select>
                                  ) : (
                                    <span className="font-mono text-gray-800">{row.tally_ledger_name}</span>
                                  )}
                                </td>
                                <td className="px-3 py-2 font-mono text-gray-500">
                                  {invoices.find((i) => i.invoice_number === row.invoice_number)?.line_items.find((li) => li.description === row.item_description)?.hsn ?? ''}
                                </td>
                                <td className="px-3 py-2 text-right text-gray-700">{row.qty ?? ''}</td>
                                <td className="px-3 py-2 text-gray-500">{row.uom ?? ''}</td>
                                <td className="px-3 py-2 text-right font-mono text-gray-700">{row.rate != null ? row.rate.toFixed(2) : ''}</td>
                                <td className="px-3 py-2 text-right text-gray-500">{row.disc_percent != null ? `${row.disc_percent}%` : ''}</td>
                                <td className="px-3 py-2 text-right font-mono text-gray-800">
                                  {row.amount.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {/* Section B: Purchase accounts */}
                {purchaseRows.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Purchase Accounts</p>
                    <div className="overflow-x-auto rounded-lg border border-gray-100">
                      <table className="min-w-full text-xs">
                        <thead>
                          <tr className="bg-gray-50 text-gray-400 font-semibold uppercase tracking-wide">
                            <th className="px-3 py-2 text-left">GST Rate</th>
                            <th className="px-3 py-2 text-right">Taxable Amount (₹)</th>
                            <th className="px-3 py-2 text-left">Purchase Ledger</th>
                            <th className="px-3 py-2 text-left">Status</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-50">
                          {purchaseRows.map((row, idx) => (
                            <tr key={idx} className={row.status === 'Skipped' ? 'bg-red-50' : 'bg-white'}>
                              <td className="px-3 py-2 text-gray-600">—</td>
                              <td className="px-3 py-2 text-right font-mono text-gray-800">
                                {row.amount.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                              </td>
                              <td className="px-3 py-2 font-mono text-gray-800">{row.tally_ledger_name}</td>
                              <td className="px-3 py-2">
                                <StatusDot status={row.status} warning={row.warning} />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {/* Section C: Charges */}
                {chargeRows.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Charges</p>
                    <div className="overflow-x-auto rounded-lg border border-gray-100">
                      <table className="min-w-full text-xs">
                        <thead>
                          <tr className="bg-gray-50 text-gray-400 font-semibold uppercase tracking-wide">
                            <th className="px-3 py-2 text-left">Description (as invoice)</th>
                            <th className="px-3 py-2 text-left">→ Tally Ledger</th>
                            <th className="px-3 py-2 text-right">Amount (₹)</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-50">
                          {chargeRows.map((row, idx) => {
                            const isUnmapped = row.warning?.includes('No expense ledger');
                            const chargeDesc = isUnmapped
                              ? row.tally_ledger_name.replace(/^— NO LEDGER FOR "(.+)" —$/, '$1')
                              : '';
                            return (
                              <tr key={idx} className={isUnmapped ? 'bg-amber-50' : 'bg-white'}>
                                <td className="px-3 py-2 text-gray-700">{isUnmapped ? chargeDesc : row.item_description ?? ''}</td>
                                <td className="px-3 py-2">
                                  {isUnmapped ? (
                                    <select
                                      defaultValue=""
                                      onChange={(e) => e.target.value && onMapExpense(chargeDesc, e.target.value)}
                                      className="border border-amber-300 rounded px-2 py-1 text-xs bg-white focus:outline-none focus:ring-1 focus:ring-indigo-500 max-w-[200px]"
                                    >
                                      <option value="">Pick ledger…</option>
                                      {expenseLedgers.map((l) => (
                                        <option key={l.tally_ledger_name} value={l.tally_ledger_name}>{l.tally_ledger_name}</option>
                                      ))}
                                    </select>
                                  ) : (
                                    <span className="font-mono text-gray-800">{row.tally_ledger_name}</span>
                                  )}
                                </td>
                                <td className="px-3 py-2 text-right font-mono text-gray-800">
                                  {row.amount.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {/* Section D: Taxes + Round Off + Discount */}
                {(cgstRow || sgstRow || igstRow || roundOffRow || discountRow) && (
                  <div className="flex flex-wrap items-center gap-4 text-xs bg-gray-50 rounded-lg px-3 py-2">
                    {cgstRow && (
                      <span className={cgstRow.status === 'Skipped' ? 'text-red-600 font-semibold' : 'text-gray-700'}>
                        CGST ₹{Math.abs(cgstRow.amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                        <span className="text-gray-400 ml-1">→ {cgstRow.tally_ledger_name}</span>
                      </span>
                    )}
                    {sgstRow && (
                      <span className={sgstRow.status === 'Skipped' ? 'text-red-600 font-semibold' : 'text-gray-700'}>
                        SGST ₹{Math.abs(sgstRow.amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                        <span className="text-gray-400 ml-1">→ {sgstRow.tally_ledger_name}</span>
                      </span>
                    )}
                    {igstRow && (
                      <span className={igstRow.status === 'Skipped' ? 'text-red-600 font-semibold' : 'text-gray-700'}>
                        IGST ₹{Math.abs(igstRow.amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                        <span className="text-gray-400 ml-1">→ {igstRow.tally_ledger_name}</span>
                      </span>
                    )}
                    {roundOffRow && (
                      <span className="text-gray-500">
                        Round Off ₹{roundOffRow.amount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                      </span>
                    )}
                    {discountRow && (
                      <span className="text-gray-500">
                        Discount ₹{Math.abs(discountRow.amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                      </span>
                    )}
                  </div>
                )}

                {/* Footer */}
                <div className="flex items-center justify-between text-xs text-gray-500 border-t border-gray-100 pt-2">
                  <span className="font-semibold text-gray-700">
                    Total: ₹{Math.abs(totalAmount).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </span>
                  <span className="flex items-center gap-2">
                    {errorCount > 0 && <span className="text-red-600 font-semibold">{errorCount} error{errorCount !== 1 ? 's' : ''}</span>}
                    {warningCount > 0 && <span className="text-amber-600">{warningCount} warning{warningCount !== 1 ? 's' : ''}</span>}
                    {errorCount === 0 && warningCount === 0 && <span className="text-green-600">Ready</span>}
                  </span>
                </div>
              </div>
            )}
          </div>
        );
      })}
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

              {/* Invoice Preview Cards */}
              <InvoicePreviewCards
                rows={previewRows}
                invoices={invoices}
                expenseLedgers={cachedMasters?.expenseLedgers ?? []}
                suppliers={cachedMasters?.suppliers ?? []}
                stockItems={cachedMasters?.stockItems ?? []}
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
