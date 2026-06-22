'use client';

import { useState } from 'react';
import type { LineItem, ExtraCharge } from '@/types/invoice';
import { formatINR, buildFullTaxSummary, normalizeLineItem } from '@/types/invoice';
import { deriveInvoiceFinancials } from '@/lib/invoiceCalculations';

export interface InvoiceEditData {
  invoice_number?: string | null;
  invoice_date?: string | null;
  vendor_name?: string | null;
  vendor_gstin?: string | null;
  buyer_name?: string | null;
  buyer_gstin?: string | null;
  tax_type: 'cgst_sgst' | 'igst';
  bill_discount_amount?: number | null;
  round_off?: number | null;
  line_items?: LineItem[];
  charges?: ExtraCharge[];
}

export interface InvoiceEditPanelProps {
  invoice: InvoiceEditData;
  perspective: 'purchase' | 'sales';
  onSave: (updated: InvoiceEditData) => void;
  onClose: () => void;
}

export function InvoiceEditPanel({ invoice, perspective, onSave, onClose }: InvoiceEditPanelProps) {
  // Header fields
  const [invoiceNumber, setInvoiceNumber] = useState(invoice.invoice_number ?? '');
  const [invoiceDate, setInvoiceDate] = useState(invoice.invoice_date ?? '');
  const [vendorName, setVendorName] = useState(invoice.vendor_name ?? '');
  const [vendorGstin, setVendorGstin] = useState(invoice.vendor_gstin ?? '');
  const [buyerName, setBuyerName] = useState(invoice.buyer_name ?? '');
  const [buyerGstin, setBuyerGstin] = useState(invoice.buyer_gstin ?? '');
  const [taxType, setTaxType] = useState<'cgst_sgst' | 'igst'>(invoice.tax_type ?? 'cgst_sgst');
  const [billDiscountAmount, setBillDiscountAmount] = useState<number>(invoice.bill_discount_amount ?? 0);

  // Line items — normalize on load so legacy records with negative rate are healed immediately.
  const [lineItems, setLineItems] = useState<LineItem[]>(
    invoice.line_items?.map(normalizeLineItem) ?? [],
  );

  // Additional charges
  const [charges, setCharges] = useState<ExtraCharge[]>(
    (invoice.charges ?? []).map((c) => ({ ...c })),
  );

  // Section open/close
  const [headerOpen, setHeaderOpen] = useState(true);
  const [itemsOpen, setItemsOpen] = useState(true);
  const [chargesOpen, setChargesOpen] = useState(false);
  const [taxOpen, setTaxOpen] = useState(true);

  const updateLineItem = (i: number, field: keyof LineItem, value: string | number) => {
    setLineItems((prev) => prev.map((li, idx) => {
      if (idx !== i) return li;
      const updated = { ...li, [field]: value };
      if (['qty', 'rate', 'disc_percent'].includes(field as string)) {
        // Rate must never be negative — sign belongs to qty only.
        const qty  = field === 'qty'          ? Number(value) : (li.qty          ?? 1);
        const rate = Math.abs(field === 'rate' ? Number(value) : (li.rate         ?? 0));
        const disc = field === 'disc_percent'  ? Number(value) : (li.disc_percent ?? 0);
        updated.rate   = rate;
        updated.amount = Math.round(qty * rate * (1 - disc / 100) * 100) / 100;
      }
      return updated;
    }));
  };

  const addLineItem = () => {
    setLineItems((prev) => [...prev, {
      description: '', hsn: '', gst_percent: 0, uom: 'Nos', qty: 1, rate: 0, disc_percent: 0, amount: 0,
    }]);
  };

  const removeLineItem = (i: number) => setLineItems((prev) => prev.filter((_, idx) => idx !== i));

  const updateCharge = (i: number, field: keyof ExtraCharge, value: string | number) => {
    setCharges((prev) => prev.map((c, idx) => idx === i ? { ...c, [field]: value } : c));
  };

  const addCharge = () => {
    setCharges((prev) => [...prev, { description: '', amount: 0, gst_percent: 0 }]);
  };

  const removeCharge = (i: number) => setCharges((prev) => prev.filter((_, idx) => idx !== i));

  // Live financials
  const draftInv: InvoiceEditData = {
    ...invoice,
    invoice_number: invoiceNumber,
    invoice_date: invoiceDate,
    vendor_name: vendorName,
    vendor_gstin: vendorGstin,
    buyer_name: buyerName,
    buyer_gstin: buyerGstin,
    tax_type: taxType,
    bill_discount_amount: billDiscountAmount,
    line_items: lineItems,
    charges,
  };
  const derived = deriveInvoiceFinancials(draftInv);
  const taxSummary = buildFullTaxSummary(lineItems, charges, taxType, billDiscountAmount);

  const handleSave = () => {
    onSave({
      ...draftInv,
      round_off: derived.round_off,
    });
    onClose();
  };

  const inputCls = 'w-full px-2.5 py-1.5 text-xs border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-indigo-500';
  const labelCls = 'block text-xs text-gray-500 dark:text-gray-400 mb-1';

  const sellerLabel = perspective === 'sales' ? 'Seller Name' : 'Vendor Name';
  const sellerGstinLabel = perspective === 'sales' ? 'Seller GSTIN' : 'Vendor GSTIN';
  const buyerLabel = perspective === 'sales' ? 'Customer Name' : 'Buyer Name';
  const buyerGstinLabel = perspective === 'sales' ? 'Customer GSTIN' : 'Buyer GSTIN';

  const ChevronIcon = ({ open }: { open: boolean }) => (
    <svg className={`w-4 h-4 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
    </svg>
  );

  return (
    <div className="fixed inset-0 z-50 flex" onClick={onClose}>
      <div className="flex-1 bg-black/40" />
      <div
        className="fixed inset-y-0 right-0 z-50 w-full max-w-5xl bg-white dark:bg-gray-900 shadow-2xl overflow-y-auto flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Sticky header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 dark:border-gray-700 sticky top-0 bg-white dark:bg-gray-900 z-10">
          <div>
            <h2 className="text-base font-bold text-gray-900 dark:text-gray-100">
              {invoiceNumber || <span className="text-gray-400 italic">No invoice number</span>}
            </h2>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              {vendorName}{vendorGstin ? ` · ${vendorGstin}` : ''}
              {' — '}
              <span className="font-semibold text-indigo-700 dark:text-indigo-400">₹{formatINR(derived.total)}</span>
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 text-2xl leading-none">&times;</button>
        </div>

        <div className="flex-1 px-5 py-4 space-y-3">

          {/* Invoice Header */}
          <div className="border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
            <button
              onClick={() => setHeaderOpen((v) => !v)}
              className="w-full flex items-center justify-between px-4 py-2.5 bg-gray-50 dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
            >
              <span className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Invoice Header</span>
              <ChevronIcon open={headerOpen} />
            </button>
            {headerOpen && (
              <div className="px-4 py-3 grid grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>Invoice Number</label>
                  <input className={inputCls} value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} />
                </div>
                <div>
                  <label className={labelCls}>Invoice Date</label>
                  <input className={inputCls} value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} placeholder="DD-MM-YYYY or YYYY-MM-DD" />
                </div>
                <div>
                  <label className={labelCls}>{sellerLabel}</label>
                  <input className={inputCls} value={vendorName} onChange={(e) => setVendorName(e.target.value)} />
                </div>
                <div>
                  <label className={labelCls}>{sellerGstinLabel}</label>
                  <input className={inputCls} value={vendorGstin} onChange={(e) => setVendorGstin(e.target.value.toUpperCase())} />
                </div>
                <div>
                  <label className={labelCls}>{buyerLabel}</label>
                  <input className={inputCls} value={buyerName} onChange={(e) => setBuyerName(e.target.value)} />
                </div>
                <div>
                  <label className={labelCls}>{buyerGstinLabel} <span className="text-gray-400">(blank for B2C)</span></label>
                  <input className={inputCls} value={buyerGstin} onChange={(e) => setBuyerGstin(e.target.value.toUpperCase())} />
                </div>
                <div>
                  <label className={labelCls}>Tax Type</label>
                  <select
                    className={inputCls}
                    value={taxType}
                    onChange={(e) => setTaxType(e.target.value as 'cgst_sgst' | 'igst')}
                  >
                    <option value="cgst_sgst">GST (CGST + SGST)</option>
                    <option value="igst">IGST (Inter-state)</option>
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Bill Discount (₹)</label>
                  <input type="number" min="0" step="0.01" className={inputCls} value={billDiscountAmount} onChange={(e) => setBillDiscountAmount(Number(e.target.value))} />
                </div>
              </div>
            )}
          </div>

          {/* Line Items */}
          <div className="border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
            <button
              onClick={() => setItemsOpen((v) => !v)}
              className="w-full flex items-center justify-between px-4 py-2.5 bg-gray-50 dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
            >
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Line Items</span>
                <span className="text-xs text-gray-400 dark:text-gray-500">({lineItems.length})</span>
              </div>
              <ChevronIcon open={itemsOpen} />
            </button>
            {itemsOpen && (
              <div className="px-4 py-3">
                <div className="overflow-x-auto">
                  <table className="w-full text-xs min-w-[860px]">
                    <thead>
                      <tr className="border-b border-gray-200 dark:border-gray-700">
                        <th className="text-left pb-1.5 text-gray-400 font-medium w-[28%]">Description</th>
                        <th className="text-left pb-1.5 text-gray-400 font-medium w-[10%]">HSN Code</th>
                        <th className="text-right pb-1.5 text-gray-400 font-medium w-[8%]">GST %</th>
                        <th className="text-right pb-1.5 text-gray-400 font-medium w-[7%]">Qty</th>
                        <th className="text-left pb-1.5 text-gray-400 font-medium w-[7%]">UOM</th>
                        <th className="text-right pb-1.5 text-gray-400 font-medium w-[10%]">Rate</th>
                        <th className="text-right pb-1.5 text-gray-400 font-medium w-[8%]">Disc %</th>
                        <th className="text-right pb-1.5 text-gray-400 font-medium w-[12%]">Taxable</th>
                        <th className="w-6" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                      {lineItems.map((li, i) => {
                        const computedAmount = Math.round((li.qty ?? 1) * (li.rate ?? 0) * (1 - (li.disc_percent ?? 0) / 100) * 100) / 100;
                        return (
                          <tr key={i}>
                            <td className="py-1 pr-1">
                              <input className={inputCls} value={li.description ?? ''} onChange={(e) => updateLineItem(i, 'description', e.target.value)} />
                            </td>
                            <td className="py-1 pr-1">
                              <input className={inputCls} value={li.hsn ?? ''} onChange={(e) => updateLineItem(i, 'hsn', e.target.value)} />
                            </td>
                            <td className="py-1 pr-1">
                              <input type="number" min="0" className={`${inputCls} text-right`} value={li.gst_percent ?? 0} onChange={(e) => updateLineItem(i, 'gst_percent', Number(e.target.value))} />
                            </td>
                            <td className="py-1 pr-1">
                              <input type="number" min="0" className={`${inputCls} text-right`} value={li.qty ?? 1} onChange={(e) => updateLineItem(i, 'qty', Number(e.target.value))} />
                            </td>
                            <td className="py-1 pr-1">
                              <input className={inputCls} value={li.uom ?? 'Nos'} onChange={(e) => updateLineItem(i, 'uom', e.target.value)} />
                            </td>
                            <td className="py-1 pr-1">
                              <input type="number" min="0" className={`${inputCls} text-right`} value={li.rate ?? 0} onChange={(e) => updateLineItem(i, 'rate', Number(e.target.value))} />
                            </td>
                            <td className="py-1 pr-1">
                              <input type="number" min="0" max="100" className={`${inputCls} text-right`} value={li.disc_percent ?? 0} onChange={(e) => updateLineItem(i, 'disc_percent', Number(e.target.value))} />
                            </td>
                            <td className="py-1 pr-1 text-right tabular-nums text-gray-700 dark:text-gray-300 font-medium">
                              {formatINR(computedAmount)}
                            </td>
                            <td className="py-1 pl-1">
                              <button onClick={() => removeLineItem(i)} className="text-red-400 hover:text-red-600 text-base leading-none" title="Remove">×</button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <button onClick={addLineItem} className="mt-2 text-xs text-indigo-600 dark:text-indigo-400 hover:underline">
                  + Add Line Item
                </button>
              </div>
            )}
          </div>

          {/* Additional Charges */}
          <div className="border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
            <button
              onClick={() => setChargesOpen((v) => !v)}
              className="w-full flex items-center justify-between px-4 py-2.5 bg-gray-50 dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
            >
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Additional Charges</span>
                {charges.length > 0 && <span className="text-xs text-gray-400 dark:text-gray-500">({charges.length})</span>}
              </div>
              <ChevronIcon open={chargesOpen} />
            </button>
            {chargesOpen && (
              <div className="px-4 py-3">
                <div className="overflow-x-auto">
                  <table className="w-full text-xs min-w-[620px]">
                    <thead>
                      <tr className="border-b border-gray-200 dark:border-gray-700">
                        <th className="text-left pb-1.5 text-gray-400 font-medium w-[40%]">Description</th>
                        <th className="text-left pb-1.5 text-gray-400 font-medium w-[12%]">SAC</th>
                        <th className="text-right pb-1.5 text-gray-400 font-medium w-[12%]">GST %</th>
                        <th className="text-right pb-1.5 text-gray-400 font-medium w-[20%]">Amount</th>
                        <th className="w-6" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                      {charges.map((c, i) => (
                        <tr key={i}>
                          <td className="py-1 pr-1">
                            <input className={inputCls} value={c.description} onChange={(e) => updateCharge(i, 'description', e.target.value)} />
                          </td>
                          <td className="py-1 pr-1">
                            <input className={inputCls} value={c.sac ?? ''} onChange={(e) => updateCharge(i, 'sac', e.target.value)} placeholder="e.g. 9965" />
                          </td>
                          <td className="py-1 pr-1">
                            <input type="number" min="0" className={`${inputCls} text-right`} value={c.gst_percent ?? 0} onChange={(e) => updateCharge(i, 'gst_percent', Number(e.target.value))} />
                          </td>
                          <td className="py-1 pr-1">
                            <input type="number" className={`${inputCls} text-right`} value={c.amount} onChange={(e) => updateCharge(i, 'amount', Number(e.target.value))} />
                          </td>
                          <td className="py-1 pl-1">
                            <button onClick={() => removeCharge(i)} className="text-red-400 hover:text-red-600 text-base leading-none" title="Remove">×</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <button onClick={addCharge} className="mt-2 text-xs text-indigo-600 dark:text-indigo-400 hover:underline">
                  + Add Charge
                </button>
              </div>
            )}
          </div>

          {/* Tax Summary */}
          <div className="border border-indigo-100 dark:border-indigo-900/40 rounded-xl overflow-hidden">
            <button
              onClick={() => setTaxOpen((v) => !v)}
              className="w-full flex items-center justify-between px-4 py-2.5 bg-indigo-50 dark:bg-indigo-900/20 hover:bg-indigo-100 dark:hover:bg-indigo-900/30 transition-colors"
            >
              <span className="text-xs font-bold text-indigo-600 dark:text-indigo-400 uppercase tracking-wider">Tax Summary</span>
              <ChevronIcon open={taxOpen} />
            </button>
            {taxOpen && (
              <div className="px-4 py-3 space-y-3 bg-indigo-50/40 dark:bg-indigo-900/10">
                {taxSummary.length > 0 && (
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-indigo-100 dark:border-indigo-900/40">
                        <th className="text-left pb-1 text-gray-400 font-medium">GST Rate</th>
                        <th className="text-right pb-1 text-gray-400 font-medium">Taxable</th>
                        {taxType === 'cgst_sgst' && <th className="text-right pb-1 text-gray-400 font-medium">CGST</th>}
                        {taxType === 'cgst_sgst' && <th className="text-right pb-1 text-gray-400 font-medium">SGST</th>}
                        {taxType === 'igst' && <th className="text-right pb-1 text-gray-400 font-medium">IGST</th>}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-indigo-50 dark:divide-indigo-900/20">
                      {taxSummary.map((row) => (
                        <tr key={row.gst_percent}>
                          <td className="py-1 text-gray-600 dark:text-gray-400">{row.gst_percent}%</td>
                          <td className="py-1 text-right tabular-nums text-gray-800 dark:text-gray-200">{formatINR(row.taxable)}</td>
                          {taxType === 'cgst_sgst' && <td className="py-1 text-right tabular-nums text-gray-600 dark:text-gray-400">{formatINR(row.cgst)}</td>}
                          {taxType === 'cgst_sgst' && <td className="py-1 text-right tabular-nums text-gray-600 dark:text-gray-400">{formatINR(row.sgst)}</td>}
                          {taxType === 'igst' && <td className="py-1 text-right tabular-nums text-gray-600 dark:text-gray-400">{formatINR(row.igst)}</td>}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                <div className="border-t border-indigo-100 dark:border-indigo-900/40 pt-3 space-y-1 text-xs">
                  <div className="flex justify-between text-gray-600 dark:text-gray-400">
                    <span>Taxable (after discount)</span>
                    <span className="tabular-nums font-medium text-gray-800 dark:text-gray-200">{formatINR(derived.net_goods_taxable)}</span>
                  </div>
                  {derived.cgst > 0 && (
                    <div className="flex justify-between text-gray-600 dark:text-gray-400">
                      <span>CGST</span>
                      <span className="tabular-nums">{formatINR(derived.cgst)}</span>
                    </div>
                  )}
                  {derived.sgst > 0 && (
                    <div className="flex justify-between text-gray-600 dark:text-gray-400">
                      <span>SGST</span>
                      <span className="tabular-nums">{formatINR(derived.sgst)}</span>
                    </div>
                  )}
                  {derived.igst > 0 && (
                    <div className="flex justify-between text-gray-600 dark:text-gray-400">
                      <span>IGST</span>
                      <span className="tabular-nums">{formatINR(derived.igst)}</span>
                    </div>
                  )}
                  {derived.round_off !== 0 && (
                    <div className="flex justify-between text-gray-500 dark:text-gray-400">
                      <span>Round Off</span>
                      <span className="tabular-nums">{derived.round_off > 0 ? '+' : ''}{formatINR(derived.round_off)}</span>
                    </div>
                  )}
                  <div className="flex justify-between font-semibold text-gray-900 dark:text-gray-100 border-t border-indigo-100 dark:border-indigo-900/40 pt-1">
                    <span>Invoice Total</span>
                    <span className="tabular-nums">₹{formatINR(derived.total)}</span>
                  </div>
                </div>
              </div>
            )}
          </div>

        </div>

        {/* Sticky footer */}
        <div className="px-5 py-4 border-t border-gray-200 dark:border-gray-700 flex gap-2 sticky bottom-0 bg-white dark:bg-gray-900">
          <button
            onClick={handleSave}
            className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors"
          >
            Save Changes
          </button>
          <button
            onClick={onClose}
            className="px-4 py-2 border border-gray-300 dark:border-gray-600 text-sm text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

export default InvoiceEditPanel;
