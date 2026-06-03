'use client';

import { useState, useEffect } from 'react';
import { updateAcceptedInvoice, moveAcceptedToRejected, deleteInvoice, computeReadiness } from '@/lib/db';
import type { StoredInvoice, LineItem, ExtraCharge } from '@/types/invoice';
import { formatINR, calcLineAmount, buildHsnSummary } from '@/types/invoice';

// ─── Props ────────────────────────────────────────────────────────────────────

interface InvoiceDetailPanelProps {
  invoice: StoredInvoice;
  onClose: () => void;
  onSaved: (updated: StoredInvoice) => void;
  onDeleted: () => void;
  onMovedToRejected: () => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(dt: string | null | undefined): string {
  if (!dt) return '—';
  try {
    return new Date(dt).toLocaleString('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return dt;
  }
}

function fmtDate(dt: string | null | undefined): string {
  if (!dt) return '—';
  try {
    return new Date(dt).toLocaleDateString('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric',
    });
  } catch {
    return dt;
  }
}

// ─── Confidence Badge ─────────────────────────────────────────────────────────

function ConfidenceBadge({ score }: { score: number }) {
  const pct = Math.round(score * 100);
  if (pct >= 85) return <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800">High ({pct}%)</span>;
  if (pct >= 70) return <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-yellow-100 text-yellow-800">Medium ({pct}%)</span>;
  return <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-800">Low ({pct}%)</span>;
}

// ─── ITC Badge ────────────────────────────────────────────────────────────────

function ITCBadge({ status }: { status: string | null }) {
  if (!status || status === 'not_applicable') return <span className="text-gray-400 text-xs">Not Applicable</span>;
  if (status === 'eligible') return <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800">Eligible</span>;
  return <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-800">At Risk</span>;
}

// ─── Readiness Flag Badge ─────────────────────────────────────────────────────

function FlagBadge({ flag }: { flag: string }) {
  const isError = flag.toLowerCase().includes('missing') || flag.toLowerCase().includes('critical');
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium mr-1 mb-1 ${isError ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'}`}>
      {flag}
    </span>
  );
}

// ─── Number Input ─────────────────────────────────────────────────────────────

function NumInput({ value, onChange, className }: { value: number; onChange: (v: number) => void; className?: string }) {
  return (
    <input
      type="number"
      value={value}
      onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
      className={`border border-gray-300 rounded px-2 py-1 text-sm w-full focus:outline-none focus:ring-1 focus:ring-indigo-500 ${className ?? ''}`}
    />
  );
}

function TextInput({ value, onChange, className }: { value: string; onChange: (v: string) => void; className?: string }) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`border border-gray-300 rounded px-2 py-1 text-sm w-full focus:outline-none focus:ring-1 focus:ring-indigo-500 ${className ?? ''}`}
    />
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function InvoiceDetailPanel({
  invoice,
  onClose,
  onSaved,
  onDeleted,
  onMovedToRejected,
}: InvoiceDetailPanelProps) {
  const [mode, setMode] = useState<'view' | 'edit'>('view');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  // Delete confirmation state
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Move to rejected modal state
  const [showRejectModal, setShowRejectModal] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [rejecting, setRejecting] = useState(false);

  // Edit state — mirrors invoice fields
  const [editInvoiceNumber, setEditInvoiceNumber] = useState(invoice.invoice_number ?? '');
  const [editInvoiceDate, setEditInvoiceDate] = useState(invoice.invoice_date ?? '');
  const [editVendorName, setEditVendorName] = useState(invoice.vendor_name ?? '');
  const [editVendorGstin, setEditVendorGstin] = useState(invoice.vendor_gstin ?? '');
  const [editBuyerName, setEditBuyerName] = useState(invoice.buyer_name ?? '');
  const [editBuyerGstin, setEditBuyerGstin] = useState(invoice.buyer_gstin ?? '');
  const [editTaxType, setEditTaxType] = useState<'cgst_sgst' | 'igst'>(invoice.tax_type);
  const [editRoundOff, setEditRoundOff] = useState(invoice.round_off ?? 0);
  const [editBillDiscount, setEditBillDiscount] = useState(invoice.bill_discount_amount ?? 0);
  const [editLineItems, setEditLineItems] = useState<LineItem[]>(
    (invoice.line_items ?? []).map((it) => ({ ...it }))
  );
  const [editCharges, setEditCharges] = useState<ExtraCharge[]>(
    (invoice.charges ?? []).map((c) => ({ ...c }))
  );

  // Live readiness from edit state
  const [liveReadiness, setLiveReadiness] = useState(invoice.readiness);
  const [liveFlags, setLiveFlags] = useState<string[]>(invoice.readiness_flags ?? []);

  useEffect(() => {
    if (mode !== 'edit') return;
    const fake = {
      vendor_name: editVendorName,
      vendor_gstin: editVendorGstin || null,
      vendor_address: null,
      buyer_name: editBuyerName || null,
      buyer_gstin: editBuyerGstin || null,
      invoice_number: editInvoiceNumber,
      invoice_date: editInvoiceDate,
      line_items: editLineItems,
      subtotal: editLineItems.reduce((s, it) => s + calcLineAmount(it), 0),
      bill_discount_amount: editBillDiscount,
      bill_discount_percent: null,
      cgst: 0, sgst: 0, igst: 0,
      charges: editCharges,
      round_off: editRoundOff,
      total: 0,
      tax_type: editTaxType,
      confidence: invoice.confidence,
      confidence_reasons: invoice.confidence_reasons,
    };
    const r = computeReadiness(fake);
    setLiveReadiness(r.readiness);
    setLiveFlags(r.flags);
  }, [mode, editVendorName, editVendorGstin, editBuyerName, editBuyerGstin, editInvoiceNumber, editInvoiceDate, editLineItems, editBillDiscount, editCharges, editRoundOff, editTaxType, invoice.confidence, invoice.confidence_reasons]);

  // ── Computed values ──

  const lineItems: LineItem[] = invoice.line_items ?? [];
  const charges: ExtraCharge[] = invoice.charges ?? [];

  const subtotal = lineItems.reduce((s, it) => s + calcLineAmount(it), 0);
  const billDiscount = invoice.bill_discount_amount ?? 0;
  const taxable = subtotal - billDiscount;
  const chargesTotal = charges.reduce((s, c) => s + c.amount, 0);
  const chargesGST = charges.filter((c) => c.gst_percent > 0).reduce((s, c) => s + c.amount * c.gst_percent / 100, 0);
  const totalGST = (invoice.cgst ?? 0) + (invoice.sgst ?? 0) + (invoice.igst ?? 0);
  const computedTotal = taxable + chargesTotal + chargesGST + totalGST + (invoice.round_off ?? 0);
  const diff = (invoice.total ?? 0) - computedTotal;

  const hsnRows = buildHsnSummary(lineItems, invoice.tax_type, billDiscount);

  // Edit computed totals
  const editSubtotal = editLineItems.reduce((s, it) => s + calcLineAmount(it), 0);
  const editHsnRows = buildHsnSummary(editLineItems, editTaxType, editBillDiscount);
  const editTotalGST = editHsnRows.reduce((s, r) => s + r.cgst + r.sgst + r.igst, 0);
  const editChargesTotal = editCharges.reduce((s, c) => s + c.amount, 0);
  const editChargesGST = editCharges.filter((c) => c.gst_percent > 0).reduce((s, c) => s + c.amount * c.gst_percent / 100, 0);
  const editComputedTotal = editSubtotal - editBillDiscount + editChargesTotal + editChargesGST + editTotalGST + editRoundOff;

  // ── Handlers ──

  const handleSave = async () => {
    setSaving(true);
    setSaveError('');
    try {
      const patch = {
        invoice_number: editInvoiceNumber,
        invoice_date: editInvoiceDate || null,
        vendor_name: editVendorName,
        vendor_gstin: editVendorGstin || null,
        buyer_name: editBuyerName || null,
        buyer_gstin: editBuyerGstin || null,
        tax_type: editTaxType,
        round_off: editRoundOff,
        bill_discount_amount: editBillDiscount,
        line_items: editLineItems,
        charges: editCharges,
        subtotal: editSubtotal,
        cgst: editTaxType === 'cgst_sgst' ? editHsnRows.reduce((s, r) => s + r.cgst, 0) : 0,
        sgst: editTaxType === 'cgst_sgst' ? editHsnRows.reduce((s, r) => s + r.sgst, 0) : 0,
        igst: editTaxType === 'igst' ? editHsnRows.reduce((s, r) => s + r.igst, 0) : 0,
        total: editComputedTotal,
        readiness: liveReadiness,
        readiness_flags: liveFlags,
      };
      await updateAcceptedInvoice(invoice.id, patch);
      const updated: StoredInvoice = {
        ...invoice,
        ...patch,
        last_modified_at: new Date().toISOString(),
      } as StoredInvoice;
      onSaved(updated);
      setMode('view');
    } catch (err: unknown) {
      setSaveError(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await deleteInvoice(invoice.id);
      onDeleted();
    } catch (err: unknown) {
      setSaveError(err instanceof Error ? err.message : 'Delete failed.');
      setDeleting(false);
      setShowDeleteConfirm(false);
    }
  };

  const handleMoveToRejected = async () => {
    setRejecting(true);
    try {
      await moveAcceptedToRejected(invoice.id, rejectReason || undefined);
      onMovedToRejected();
    } catch (err: unknown) {
      setSaveError(err instanceof Error ? err.message : 'Move failed.');
      setRejecting(false);
      setShowRejectModal(false);
    }
  };

  const handleCancelEdit = () => {
    setEditInvoiceNumber(invoice.invoice_number ?? '');
    setEditInvoiceDate(invoice.invoice_date ?? '');
    setEditVendorName(invoice.vendor_name ?? '');
    setEditVendorGstin(invoice.vendor_gstin ?? '');
    setEditBuyerName(invoice.buyer_name ?? '');
    setEditBuyerGstin(invoice.buyer_gstin ?? '');
    setEditTaxType(invoice.tax_type);
    setEditRoundOff(invoice.round_off ?? 0);
    setEditBillDiscount(invoice.bill_discount_amount ?? 0);
    setEditLineItems((invoice.line_items ?? []).map((it) => ({ ...it })));
    setEditCharges((invoice.charges ?? []).map((c) => ({ ...c })));
    setMode('view');
  };

  const addLineItem = () => {
    setEditLineItems((prev) => [...prev, { description: '', hsn: '', gst_percent: 18, uom: '', qty: 1, rate: 0, disc_percent: 0 }]);
  };

  const removeLineItem = (idx: number) => {
    setEditLineItems((prev) => prev.filter((_, i) => i !== idx));
  };

  const updateLineItem = (idx: number, field: keyof LineItem, value: string | number) => {
    setEditLineItems((prev) => prev.map((it, i) => i === idx ? { ...it, [field]: value } : it));
  };

  const addCharge = () => {
    setEditCharges((prev) => [...prev, { description: '', amount: 0, gst_percent: 0 }]);
  };

  const removeCharge = (idx: number) => {
    setEditCharges((prev) => prev.filter((_, i) => i !== idx));
  };

  const updateCharge = (idx: number, field: keyof ExtraCharge, value: string | number) => {
    setEditCharges((prev) => prev.map((c, i) => i === idx ? { ...c, [field]: value } : c));
  };

  // ── Render ──

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-40 bg-black/40" onClick={onClose} />

      {/* Panel */}
      <div className="fixed inset-y-0 right-0 z-50 w-full max-w-2xl bg-white shadow-2xl flex flex-col overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 shrink-0">
          <h2 className="text-base font-semibold text-gray-900">
            {mode === 'edit' ? 'Edit Invoice' : 'Invoice Details'}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 transition-colors">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">

          {saveError && (
            <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">{saveError}</div>
          )}

          {/* ── VIEW MODE ── */}
          {mode === 'view' && (
            <>
              {/* Invoice Header Card */}
              <div className="bg-gray-50 border border-gray-200 rounded-xl p-5 space-y-3">
                <div className="flex items-start justify-between">
                  <div>
                    <p className="text-xs text-gray-500 uppercase tracking-wide font-medium">Invoice Number</p>
                    <p className="text-lg font-bold text-gray-900 mt-0.5">{invoice.invoice_number || '—'}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-xs text-gray-500 uppercase tracking-wide font-medium">Total</p>
                    <p className="text-xl font-bold text-indigo-600 mt-0.5">₹{formatINR(invoice.total ?? 0)}</p>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <p className="text-xs text-gray-500">Invoice Date</p>
                    <p className="text-gray-900 font-medium">{invoice.invoice_date || '—'}</p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-500">Period</p>
                    <p className="text-gray-900 font-medium">{invoice.period_label || '—'}</p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-500">Supplier</p>
                    <p className="text-gray-900 font-medium">{invoice.vendor_name || '—'}</p>
                    <p className="text-gray-500 font-mono text-xs">{invoice.vendor_gstin || '—'}</p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-500">Buyer</p>
                    <p className="text-gray-900 font-medium">{invoice.buyer_name || '—'}</p>
                    <p className="text-gray-500 font-mono text-xs">{invoice.buyer_gstin || '—'}</p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-500">Accepted At</p>
                    <p className="text-gray-700 text-xs">{fmt(invoice.accepted_at)}</p>
                  </div>
                  {(invoice as StoredInvoice & { last_modified_at?: string }).last_modified_at && (
                    <div>
                      <p className="text-xs text-gray-500">Last Modified</p>
                      <p className="text-gray-700 text-xs">{fmt((invoice as StoredInvoice & { last_modified_at?: string }).last_modified_at)}</p>
                    </div>
                  )}
                </div>
              </div>

              {/* Confidence */}
              <div className="bg-white border border-gray-200 rounded-xl p-4">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Confidence</p>
                <div className="flex items-center gap-3 mb-2">
                  <ConfidenceBadge score={invoice.confidence} />
                </div>
                {(invoice.confidence_reasons ?? []).length > 0 && (
                  <ul className="list-disc list-inside space-y-0.5">
                    {(invoice.confidence_reasons ?? []).map((r, i) => (
                      <li key={i} className="text-xs text-gray-600">{r}</li>
                    ))}
                  </ul>
                )}
                {(invoice.readiness_flags ?? []).length > 0 && (
                  <div className="mt-2 flex flex-wrap">
                    {(invoice.readiness_flags ?? []).map((f, i) => <FlagBadge key={i} flag={f} />)}
                  </div>
                )}
              </div>

              {/* ITC Status */}
              <div className="bg-white border border-gray-200 rounded-xl p-4">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">ITC Status</p>
                <ITCBadge status={invoice.itc_status} />
                {invoice.itc_remark && (
                  <p className="text-xs text-gray-500 mt-1">{invoice.itc_remark}</p>
                )}
              </div>

              {/* Line Items */}
              <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
                <div className="px-4 py-3 border-b border-gray-100">
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Goods / Services</p>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="text-left px-3 py-2 text-gray-500">#</th>
                        <th className="text-left px-3 py-2 text-gray-500">Description</th>
                        <th className="text-left px-3 py-2 text-gray-500">HSN</th>
                        <th className="text-right px-3 py-2 text-gray-500">GST%</th>
                        <th className="text-right px-3 py-2 text-gray-500">Qty</th>
                        <th className="text-left px-3 py-2 text-gray-500">UOM</th>
                        <th className="text-right px-3 py-2 text-gray-500">Rate</th>
                        <th className="text-right px-3 py-2 text-gray-500">Disc%</th>
                        <th className="text-right px-3 py-2 text-gray-500">Taxable</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {lineItems.map((it, i) => (
                        <tr key={i} className="hover:bg-gray-50">
                          <td className="px-3 py-2 text-gray-400">{i + 1}</td>
                          <td className="px-3 py-2 text-gray-700 max-w-[120px] truncate" title={it.description}>{it.description || '—'}</td>
                          <td className="px-3 py-2 font-mono text-gray-600">{it.hsn || '—'}</td>
                          <td className="px-3 py-2 text-right text-gray-600">{it.gst_percent}%</td>
                          <td className="px-3 py-2 text-right text-gray-600 tabular-nums">{it.qty}</td>
                          <td className="px-3 py-2 text-gray-500">{it.uom}</td>
                          <td className="px-3 py-2 text-right text-gray-600 tabular-nums">{formatINR(it.rate)}</td>
                          <td className="px-3 py-2 text-right text-gray-600">{it.disc_percent > 0 ? `${it.disc_percent}%` : '—'}</td>
                          <td className="px-3 py-2 text-right tabular-nums font-medium text-gray-800">{formatINR(calcLineAmount(it))}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot className="bg-gray-50 border-t border-gray-200">
                      <tr>
                        <td colSpan={8} className="px-3 py-2 text-right text-xs font-semibold text-gray-500">Subtotal</td>
                        <td className="px-3 py-2 text-right tabular-nums font-bold text-gray-900">{formatINR(subtotal)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>

              {/* Bill Level Adjustments */}
              {billDiscount > 0 && (
                <div className="bg-white border border-gray-200 rounded-xl p-4">
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Bill Discount</p>
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-600">Bill Discount Amount</span>
                    <span className="font-medium text-gray-900">₹{formatINR(billDiscount)}</span>
                  </div>
                  {invoice.bill_discount_percent && (
                    <div className="flex justify-between text-sm mt-1">
                      <span className="text-gray-600">Discount Percent</span>
                      <span className="font-medium text-gray-900">{invoice.bill_discount_percent}%</span>
                    </div>
                  )}
                </div>
              )}

              {/* Charges */}
              {charges.length > 0 && (
                <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
                  <div className="px-4 py-3 border-b border-gray-100">
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Additional Charges</p>
                  </div>
                  <table className="w-full text-xs">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="text-left px-3 py-2 text-gray-500">#</th>
                        <th className="text-left px-3 py-2 text-gray-500">Description</th>
                        <th className="text-right px-3 py-2 text-gray-500">GST%</th>
                        <th className="text-right px-3 py-2 text-gray-500">Amount</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {charges.map((c, i) => (
                        <tr key={i}>
                          <td className="px-3 py-2 text-gray-400">{i + 1}</td>
                          <td className="px-3 py-2 text-gray-700">{c.description}</td>
                          <td className="px-3 py-2 text-right text-gray-600">{c.gst_percent > 0 ? `${c.gst_percent}%` : '—'}</td>
                          <td className="px-3 py-2 text-right tabular-nums font-medium text-gray-800">{formatINR(c.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* HSN Summary */}
              {hsnRows.length > 0 && (
                <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
                  <div className="px-4 py-3 border-b border-gray-100">
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Tax Summary (HSN)</p>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="text-left px-3 py-2 text-gray-500">#</th>
                          <th className="text-left px-3 py-2 text-gray-500">HSN</th>
                          <th className="text-right px-3 py-2 text-gray-500">GST%</th>
                          <th className="text-right px-3 py-2 text-gray-500">Taxable</th>
                          <th className="text-right px-3 py-2 text-gray-500">CGST</th>
                          <th className="text-right px-3 py-2 text-gray-500">SGST</th>
                          <th className="text-right px-3 py-2 text-gray-500">IGST</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {hsnRows.map((r, i) => (
                          <tr key={i} className="hover:bg-gray-50">
                            <td className="px-3 py-2 text-gray-400">{i + 1}</td>
                            <td className="px-3 py-2 font-mono text-gray-700">{r.hsn}</td>
                            <td className="px-3 py-2 text-right text-gray-600">{r.gst_percent}%</td>
                            <td className="px-3 py-2 text-right tabular-nums text-gray-800">{formatINR(r.taxable)}</td>
                            <td className="px-3 py-2 text-right tabular-nums text-gray-600">{r.cgst > 0 ? formatINR(r.cgst) : '—'}</td>
                            <td className="px-3 py-2 text-right tabular-nums text-gray-600">{r.sgst > 0 ? formatINR(r.sgst) : '—'}</td>
                            <td className="px-3 py-2 text-right tabular-nums text-gray-600">{r.igst > 0 ? formatINR(r.igst) : '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Reconciliation */}
              <div className="bg-white border border-gray-200 rounded-xl p-4">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Invoice Reconciliation</p>
                <div className="space-y-1.5 text-sm">
                  <div className="flex justify-between">
                    <span className="text-gray-600">Subtotal (line items)</span>
                    <span className="tabular-nums text-gray-800">₹{formatINR(subtotal)}</span>
                  </div>
                  {billDiscount > 0 && (
                    <div className="flex justify-between">
                      <span className="text-gray-600">Bill Discount (−)</span>
                      <span className="tabular-nums text-red-600">−₹{formatINR(billDiscount)}</span>
                    </div>
                  )}
                  {chargesTotal > 0 && (
                    <div className="flex justify-between">
                      <span className="text-gray-600">Charges (+)</span>
                      <span className="tabular-nums text-gray-800">+₹{formatINR(chargesTotal)}</span>
                    </div>
                  )}
                  {chargesGST > 0 && (
                    <div className="flex justify-between">
                      <span className="text-gray-600">Charges GST (+)</span>
                      <span className="tabular-nums text-gray-800">+₹{formatINR(chargesGST)}</span>
                    </div>
                  )}
                  {invoice.cgst > 0 && (
                    <div className="flex justify-between">
                      <span className="text-gray-600">CGST (+)</span>
                      <span className="tabular-nums text-gray-800">+₹{formatINR(invoice.cgst)}</span>
                    </div>
                  )}
                  {invoice.sgst > 0 && (
                    <div className="flex justify-between">
                      <span className="text-gray-600">SGST (+)</span>
                      <span className="tabular-nums text-gray-800">+₹{formatINR(invoice.sgst)}</span>
                    </div>
                  )}
                  {invoice.igst > 0 && (
                    <div className="flex justify-between">
                      <span className="text-gray-600">IGST (+)</span>
                      <span className="tabular-nums text-gray-800">+₹{formatINR(invoice.igst)}</span>
                    </div>
                  )}
                  {(invoice.round_off ?? 0) !== 0 && (
                    <div className="flex justify-between">
                      <span className="text-gray-600">Round Off</span>
                      <span className="tabular-nums text-gray-800">{invoice.round_off! >= 0 ? '+' : ''}₹{formatINR(invoice.round_off ?? 0)}</span>
                    </div>
                  )}
                  <div className="flex justify-between border-t border-gray-100 pt-1.5 font-semibold">
                    <span className="text-gray-700">Computed Total</span>
                    <span className="tabular-nums text-gray-900">₹{formatINR(computedTotal)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-600">Invoice Total (stored)</span>
                    <span className="tabular-nums text-gray-800">₹{formatINR(invoice.total ?? 0)}</span>
                  </div>
                  {Math.abs(diff) > 0.5 && (
                    <div className="flex justify-between text-red-600 font-medium">
                      <span>Difference</span>
                      <span className="tabular-nums">{diff >= 0 ? '+' : ''}₹{formatINR(diff)}</span>
                    </div>
                  )}
                </div>
              </div>
            </>
          )}

          {/* ── EDIT MODE ── */}
          {mode === 'edit' && (
            <>
              {/* Live readiness flags */}
              {liveFlags.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {liveFlags.map((f, i) => <FlagBadge key={i} flag={f} />)}
                </div>
              )}

              {/* Header fields */}
              <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-3">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Invoice Header</p>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-gray-600 mb-1">Invoice Number</label>
                    <TextInput value={editInvoiceNumber} onChange={setEditInvoiceNumber} />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-600 mb-1">Invoice Date</label>
                    <TextInput value={editInvoiceDate} onChange={setEditInvoiceDate} />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-600 mb-1">Vendor Name</label>
                    <TextInput value={editVendorName} onChange={setEditVendorName} />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-600 mb-1">Vendor GSTIN</label>
                    <TextInput value={editVendorGstin} onChange={setEditVendorGstin} />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-600 mb-1">Buyer Name</label>
                    <TextInput value={editBuyerName} onChange={setEditBuyerName} />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-600 mb-1">Buyer GSTIN</label>
                    <TextInput value={editBuyerGstin} onChange={setEditBuyerGstin} />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-600 mb-1">Tax Type</label>
                    <select
                      value={editTaxType}
                      onChange={(e) => setEditTaxType(e.target.value as 'cgst_sgst' | 'igst')}
                      className="border border-gray-300 rounded px-2 py-1 text-sm w-full focus:outline-none focus:ring-1 focus:ring-indigo-500"
                    >
                      <option value="cgst_sgst">CGST + SGST</option>
                      <option value="igst">IGST</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-gray-600 mb-1">Round Off</label>
                    <NumInput value={editRoundOff} onChange={setEditRoundOff} />
                  </div>
                </div>
              </div>

              {/* Line Items */}
              <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
                <div className="px-4 py-3 border-b border-gray-100">
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Line Items</p>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-2 py-2 text-left text-gray-500">Desc</th>
                        <th className="px-2 py-2 text-left text-gray-500 w-16">HSN</th>
                        <th className="px-2 py-2 text-right text-gray-500 w-12">GST%</th>
                        <th className="px-2 py-2 text-right text-gray-500 w-12">Qty</th>
                        <th className="px-2 py-2 text-left text-gray-500 w-14">UOM</th>
                        <th className="px-2 py-2 text-right text-gray-500 w-16">Rate</th>
                        <th className="px-2 py-2 text-right text-gray-500 w-12">Disc%</th>
                        <th className="px-2 py-2 text-right text-gray-500 w-20">Taxable</th>
                        <th className="px-2 py-2 w-6" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {editLineItems.map((it, i) => (
                        <tr key={i}>
                          <td className="px-2 py-1.5">
                            <TextInput value={it.description ?? ''} onChange={(v) => updateLineItem(i, 'description', v)} className="min-w-[80px]" />
                          </td>
                          <td className="px-2 py-1.5">
                            <TextInput value={it.hsn} onChange={(v) => updateLineItem(i, 'hsn', v)} />
                          </td>
                          <td className="px-2 py-1.5">
                            <NumInput value={it.gst_percent} onChange={(v) => updateLineItem(i, 'gst_percent', v)} />
                          </td>
                          <td className="px-2 py-1.5">
                            <NumInput value={it.qty} onChange={(v) => updateLineItem(i, 'qty', v)} />
                          </td>
                          <td className="px-2 py-1.5">
                            <TextInput value={it.uom} onChange={(v) => updateLineItem(i, 'uom', v)} />
                          </td>
                          <td className="px-2 py-1.5">
                            <NumInput value={it.rate} onChange={(v) => updateLineItem(i, 'rate', v)} />
                          </td>
                          <td className="px-2 py-1.5">
                            <NumInput value={it.disc_percent} onChange={(v) => updateLineItem(i, 'disc_percent', v)} />
                          </td>
                          <td className="px-2 py-1.5 text-right tabular-nums text-gray-800 font-medium whitespace-nowrap">
                            {formatINR(calcLineAmount(it))}
                          </td>
                          <td className="px-2 py-1.5">
                            <button onClick={() => removeLineItem(i)} className="text-gray-300 hover:text-red-500 transition-colors">
                              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                              </svg>
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="px-4 py-2 border-t border-gray-100 flex items-center justify-between">
                  <button
                    onClick={addLineItem}
                    className="text-xs text-indigo-600 hover:text-indigo-800 font-medium flex items-center gap-1"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                    </svg>
                    Add Line Item
                  </button>
                  <span className="text-xs text-gray-500 tabular-nums">Subtotal: ₹{formatINR(editSubtotal)}</span>
                </div>
              </div>

              {/* Bill Discount */}
              <div className="bg-white border border-gray-200 rounded-xl p-4">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Bill Discount</p>
                <div>
                  <label className="block text-xs text-gray-600 mb-1">Discount Amount</label>
                  <NumInput value={editBillDiscount} onChange={setEditBillDiscount} className="max-w-[150px]" />
                </div>
              </div>

              {/* Charges */}
              <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
                <div className="px-4 py-3 border-b border-gray-100">
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Additional Charges</p>
                </div>
                {editCharges.length > 0 && (
                  <table className="w-full text-xs">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="text-left px-3 py-2 text-gray-500">Description</th>
                        <th className="text-right px-3 py-2 text-gray-500 w-16">GST%</th>
                        <th className="text-right px-3 py-2 text-gray-500 w-24">Amount</th>
                        <th className="px-3 py-2 w-6" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {editCharges.map((c, i) => (
                        <tr key={i}>
                          <td className="px-3 py-1.5">
                            <TextInput value={c.description} onChange={(v) => updateCharge(i, 'description', v)} />
                          </td>
                          <td className="px-3 py-1.5">
                            <NumInput value={c.gst_percent} onChange={(v) => updateCharge(i, 'gst_percent', v)} />
                          </td>
                          <td className="px-3 py-1.5">
                            <NumInput value={c.amount} onChange={(v) => updateCharge(i, 'amount', v)} />
                          </td>
                          <td className="px-3 py-1.5">
                            <button onClick={() => removeCharge(i)} className="text-gray-300 hover:text-red-500 transition-colors">
                              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                              </svg>
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                <div className="px-4 py-2 border-t border-gray-100">
                  <button
                    onClick={addCharge}
                    className="text-xs text-indigo-600 hover:text-indigo-800 font-medium flex items-center gap-1"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                    </svg>
                    Add Charge
                  </button>
                </div>
              </div>

              {/* Edit totals preview */}
              <div className="bg-gray-50 border border-gray-200 rounded-xl p-4">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Computed Total</p>
                <p className="text-xl font-bold text-indigo-600">₹{formatINR(editComputedTotal)}</p>
              </div>
            </>
          )}

        </div>

        {/* ── Bottom Action Bar ── */}
        <div className="shrink-0 border-t border-gray-200 px-6 py-4 bg-white">

          {/* Delete inline confirm */}
          {showDeleteConfirm && (
            <div className="mb-4 bg-red-50 border border-red-200 rounded-xl p-4">
              <p className="text-sm font-medium text-red-800 mb-1">
                Delete Invoice {invoice.invoice_number || invoice.vendor_name}?
              </p>
              <p className="text-xs text-red-600 mb-3">This is permanent and cannot be undone.</p>
              <div className="flex gap-2">
                <button
                  onClick={handleDelete}
                  disabled={deleting}
                  className="px-4 py-2 bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white text-sm font-semibold rounded-lg transition-colors"
                >
                  {deleting ? 'Deleting…' : 'Confirm Delete'}
                </button>
                <button
                  onClick={() => setShowDeleteConfirm(false)}
                  className="px-4 py-2 border border-gray-300 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {mode === 'view' ? (
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowDeleteConfirm(true)}
                className="px-4 py-2 border border-red-300 text-red-600 text-sm font-medium rounded-lg hover:bg-red-50 transition-colors"
              >
                Delete Invoice
              </button>
              <div className="flex-1" />
              <button
                onClick={() => setShowRejectModal(true)}
                className="px-4 py-2 border border-amber-400 text-amber-700 text-sm font-medium rounded-lg hover:bg-amber-50 transition-colors"
              >
                Move to Rejected
              </button>
              <button
                onClick={() => setMode('edit')}
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold rounded-lg transition-colors"
              >
                Edit Invoice
              </button>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-2">
              <button
                onClick={handleCancelEdit}
                className="px-4 py-2 border border-gray-300 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={saving || liveReadiness === 'critical'}
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-sm font-semibold rounded-lg transition-colors"
              >
                {saving ? 'Saving…' : 'Save Changes'}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ── Move to Rejected Modal ── */}
      {showRejectModal && (
        <div className="fixed inset-0 z-60 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-2xl shadow-xl max-w-md w-full mx-4 p-6">
            <h3 className="font-semibold text-gray-900 mb-1">Move to Rejected Archive</h3>
            <p className="text-sm text-gray-500 mb-4">
              {invoice.invoice_number || '—'} · {invoice.vendor_name}
            </p>
            <label className="block text-xs font-medium text-gray-600 mb-1">Reason for Rejection (Optional)</label>
            <textarea
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              rows={3}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 mb-4"
              placeholder="Enter reason…"
            />
            <div className="flex gap-2">
              <button
                onClick={handleMoveToRejected}
                disabled={rejecting}
                className="flex-1 px-4 py-2.5 bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-white text-sm font-semibold rounded-lg transition-colors"
              >
                {rejecting ? 'Moving…' : 'Confirm'}
              </button>
              <button
                onClick={() => { setShowRejectModal(false); setRejectReason(''); }}
                className="flex-1 px-4 py-2.5 border border-gray-300 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
