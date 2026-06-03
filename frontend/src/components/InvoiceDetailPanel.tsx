'use client';

import { useState, useEffect, useCallback } from 'react';
import { updateAcceptedInvoice, moveAcceptedToRejected, deleteInvoice, computeReadiness } from '@/lib/db';
import type { StoredInvoice, LineItem, ExtraCharge } from '@/types/invoice';
import { formatINR, calcLineAmount, buildHsnSummary } from '@/types/invoice';

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
  } catch { return dt; }
}

function pct(score: number) { return Math.round(score * 100); }

function ConfidenceBadge({ score }: { score: number }) {
  const p = pct(score);
  const cls = p >= 85 ? 'bg-green-100 text-green-800' : p >= 70 ? 'bg-yellow-100 text-yellow-800' : 'bg-red-100 text-red-800';
  const label = p >= 85 ? 'High' : p >= 70 ? 'Medium' : 'Low';
  return <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold ${cls}`}>{label} ({p}%)</span>;
}

function ITCBadge({ status }: { status: string | null }) {
  if (!status || status === 'not_applicable') return <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-gray-100 text-gray-600">N/A</span>;
  if (status === 'eligible') return <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-green-100 text-green-800">ITC Eligible</span>;
  return <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-800">ITC At Risk</span>;
}

function SectionHeader({ title, open, onToggle }: { title: string; open: boolean; onToggle: () => void }) {
  return (
    <button onClick={onToggle} className="w-full flex items-center justify-between px-4 py-3 border-b border-gray-100 hover:bg-gray-50 transition-colors">
      <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">{title}</span>
      <svg className={`w-4 h-4 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
      </svg>
    </button>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function InvoiceDetailPanel({ invoice, onClose, onSaved, onDeleted, onMovedToRejected }: InvoiceDetailPanelProps) {
  const [mode, setMode] = useState<'view' | 'edit'>('view');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const [showRejectModal, setShowRejectModal] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [rejecting, setRejecting] = useState(false);

  // Collapsible sections (view mode)
  const [secHeader, setSecHeader] = useState(true);
  const [secLines, setSecLines] = useState(true);
  const [secHsn, setSecHsn] = useState(true);
  const [secRecon, setSecRecon] = useState(true);
  const [secAudit, setSecAudit] = useState(false);

  // Edit state
  const [editInvoiceNumber, setEditInvoiceNumber] = useState(invoice.invoice_number ?? '');
  const [editInvoiceDate, setEditInvoiceDate] = useState(invoice.invoice_date ?? '');
  const [editVendorName, setEditVendorName] = useState(invoice.vendor_name ?? '');
  const [editVendorGstin, setEditVendorGstin] = useState(invoice.vendor_gstin ?? '');
  const [editBuyerName, setEditBuyerName] = useState(invoice.buyer_name ?? '');
  const [editBuyerGstin, setEditBuyerGstin] = useState(invoice.buyer_gstin ?? '');
  const [editTaxType, setEditTaxType] = useState<'cgst_sgst' | 'igst'>(invoice.tax_type);
  const [editRoundOff, setEditRoundOff] = useState(invoice.round_off ?? 0);
  const [editBillDiscount, setEditBillDiscount] = useState(invoice.bill_discount_amount ?? 0);
  const [editLineItems, setEditLineItems] = useState<LineItem[]>((invoice.line_items ?? []).map((it) => ({ ...it })));
  const [editCharges, setEditCharges] = useState<ExtraCharge[]>((invoice.charges ?? []).map((c) => ({ ...c })));

  const [liveReadiness, setLiveReadiness] = useState(invoice.readiness);
  const [liveFlags, setLiveFlags] = useState<string[]>(invoice.readiness_flags ?? []);

  // Recompute readiness live in edit mode
  useEffect(() => {
    if (mode !== 'edit') return;
    const r = computeReadiness({
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
    });
    setLiveReadiness(r.readiness);
    setLiveFlags(r.flags);
  }, [mode, editVendorName, editVendorGstin, editBuyerName, editBuyerGstin, editInvoiceNumber, editInvoiceDate, editLineItems, editBillDiscount, editCharges, editRoundOff, editTaxType, invoice.confidence, invoice.confidence_reasons]);

  // ── View mode computed values ──

  const lineItems: LineItem[] = invoice.line_items ?? [];
  const charges: ExtraCharge[] = invoice.charges ?? [];
  const subtotal = lineItems.reduce((s, it) => s + calcLineAmount(it), 0);
  const billDiscount = invoice.bill_discount_amount ?? 0;
  const chargesTotal = charges.reduce((s, c) => s + c.amount, 0);
  const chargesGST = charges.filter((c) => c.gst_percent > 0).reduce((s, c) => s + c.amount * c.gst_percent / 100, 0);
  const totalGST = (invoice.cgst ?? 0) + (invoice.sgst ?? 0) + (invoice.igst ?? 0);
  const computedTotal = subtotal - billDiscount + chargesTotal + chargesGST + totalGST + (invoice.round_off ?? 0);
  const diff = (invoice.total ?? 0) - computedTotal;
  const hsnRows = buildHsnSummary(lineItems, invoice.tax_type, billDiscount);

  // ── Edit mode computed values (reactive) ──

  const editSubtotal = editLineItems.reduce((s, it) => s + calcLineAmount(it), 0);
  const editHsnRows = buildHsnSummary(editLineItems, editTaxType, editBillDiscount);
  const editCGST = editTaxType === 'cgst_sgst' ? editHsnRows.reduce((s, r) => s + r.cgst, 0) : 0;
  const editSGST = editTaxType === 'cgst_sgst' ? editHsnRows.reduce((s, r) => s + r.sgst, 0) : 0;
  const editIGST = editTaxType === 'igst' ? editHsnRows.reduce((s, r) => s + r.igst, 0) : 0;
  const editChargesTotal = editCharges.reduce((s, c) => s + c.amount, 0);
  const editChargesGST = editCharges.filter((c) => c.gst_percent > 0).reduce((s, c) => s + c.amount * c.gst_percent / 100, 0);
  const editComputedTotal = editSubtotal - editBillDiscount + editChargesTotal + editChargesGST + editCGST + editSGST + editIGST + editRoundOff;

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
        cgst: editCGST,
        sgst: editSGST,
        igst: editIGST,
        total: editComputedTotal,
        readiness: liveReadiness,
        readiness_flags: liveFlags,
      };
      await updateAcceptedInvoice(invoice.id, patch);
      onSaved({ ...invoice, ...patch, last_modified_at: new Date().toISOString() } as StoredInvoice);
      setMode('view');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String((err as { message?: string }).message ?? 'Save failed — unknown error');
      setSaveError(msg);
      console.error('Save invoice error:', err);
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

  const handleCancelEdit = useCallback(() => {
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
    setSaveError('');
    setMode('view');
  }, [invoice]);

  const updateLineItem = (idx: number, field: keyof LineItem, value: string | number) =>
    setEditLineItems((prev) => prev.map((it, i) => i === idx ? { ...it, [field]: value } : it));

  const updateCharge = (idx: number, field: keyof ExtraCharge, value: string | number) =>
    setEditCharges((prev) => prev.map((c, i) => i === idx ? { ...c, [field]: value } : c));

  const addLineItem = () =>
    setEditLineItems((prev) => [...prev, { description: '', hsn: '', gst_percent: 18, uom: 'pcs', qty: 1, rate: 0, disc_percent: 0 }]);

  const addCharge = () =>
    setEditCharges((prev) => [...prev, { description: '', amount: 0, gst_percent: 0 }]);

  // ── Render helpers ──

  const inv = invoice as StoredInvoice & { last_modified_at?: string; last_modified_by?: string };

  const canSave = !saving && liveReadiness !== 'critical';

  // ── Render ──

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-40 bg-black/40" onClick={onClose} />

      {/* Panel */}
      <div className="fixed inset-y-0 right-0 z-50 w-full max-w-5xl bg-white shadow-2xl flex flex-col overflow-hidden">

        {/* ── Panel Header (sticky) ── */}
        <div className="shrink-0 flex items-center justify-between px-5 py-3 border-b border-gray-200 bg-white">
          <div className="flex items-center gap-3 min-w-0">
            <div>
              <span className="text-xs text-gray-400 uppercase tracking-wide">{mode === 'edit' ? 'Editing' : 'Invoice'}</span>
              <h2 className="text-base font-bold text-gray-900 leading-tight truncate">{invoice.invoice_number || '—'}</h2>
            </div>
            {mode === 'view' && (
              <div className="flex items-center gap-1.5 flex-wrap">
                <ConfidenceBadge score={invoice.confidence} />
                <ITCBadge status={invoice.itc_status} />
              </div>
            )}
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <span className="text-lg font-bold text-indigo-600 tabular-nums">₹{formatINR(mode === 'edit' ? editComputedTotal : (invoice.total ?? 0))}</span>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-1">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* ── Scrollable Body ── */}
        <div className="flex-1 overflow-y-auto">

          {/* Error Banner */}
          {saveError && (
            <div className="mx-4 mt-3 bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700 flex items-start gap-2">
              <svg className="w-4 h-4 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M12 3a9 9 0 110 18A9 9 0 0112 3z" />
              </svg>
              <span>{saveError}</span>
            </div>
          )}

          {/* ════════════════════════════════════════════════════
              VIEW MODE
          ════════════════════════════════════════════════════ */}
          {mode === 'view' && (
            <div className="p-4 space-y-3">

              {/* ── Invoice Header Card ── */}
              <div className="bg-gray-50 border border-gray-200 rounded-xl overflow-hidden">
                <SectionHeader title="Invoice Header" open={secHeader} onToggle={() => setSecHeader((v) => !v)} />
                {secHeader && (
                  <div className="p-4">
                    <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
                      <div>
                        <p className="text-xs text-gray-400 mb-0.5">Invoice Date</p>
                        <p className="font-medium text-gray-900">{invoice.invoice_date || '—'}</p>
                      </div>
                      <div>
                        <p className="text-xs text-gray-400 mb-0.5">Period</p>
                        <p className="font-medium text-gray-900">{invoice.period_label || '—'}</p>
                      </div>
                      <div>
                        <p className="text-xs text-gray-400 mb-0.5">Supplier</p>
                        <p className="font-semibold text-gray-900">{invoice.vendor_name || '—'}</p>
                        <p className="font-mono text-xs text-gray-500">{invoice.vendor_gstin || '—'}</p>
                      </div>
                      <div>
                        <p className="text-xs text-gray-400 mb-0.5">Buyer</p>
                        <p className="font-semibold text-gray-900">{invoice.buyer_name || '—'}</p>
                        <p className="font-mono text-xs text-gray-500">{invoice.buyer_gstin || '—'}</p>
                      </div>
                      <div>
                        <p className="text-xs text-gray-400 mb-0.5">Tax Type</p>
                        <p className="font-medium text-gray-900">{invoice.tax_type === 'cgst_sgst' ? 'CGST + SGST' : 'IGST'}</p>
                      </div>
                      {(invoice.round_off ?? 0) !== 0 && (
                        <div>
                          <p className="text-xs text-gray-400 mb-0.5">Round Off</p>
                          <p className="font-medium text-gray-900 tabular-nums">{invoice.round_off! >= 0 ? '+' : ''}₹{formatINR(invoice.round_off ?? 0)}</p>
                        </div>
                      )}
                    </div>
                    {(invoice.readiness_flags ?? []).length > 0 && (
                      <div className="mt-3 flex flex-wrap gap-1">
                        {(invoice.readiness_flags ?? []).map((f, i) => (
                          <span key={i} className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${f.toLowerCase().includes('missing') || f.toLowerCase().includes('critical') ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'}`}>{f}</span>
                        ))}
                      </div>
                    )}
                    {(invoice.confidence_reasons ?? []).length > 0 && (
                      <ul className="mt-2 space-y-0.5">
                        {(invoice.confidence_reasons ?? []).map((r, i) => (
                          <li key={i} className="text-xs text-gray-500">· {r}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>

              {/* ── Goods / Services ── */}
              <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
                <SectionHeader title={`Goods / Services (${lineItems.length} items)`} open={secLines} onToggle={() => setSecLines((v) => !v)} />
                {secLines && (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-50 border-b border-gray-100">
                        <tr>
                          <th className="text-left px-3 py-2.5 text-xs font-semibold text-gray-500 w-6">#</th>
                          <th className="text-left px-3 py-2.5 text-xs font-semibold text-gray-500">Description</th>
                          <th className="text-left px-3 py-2.5 text-xs font-semibold text-gray-500">HSN</th>
                          <th className="text-right px-3 py-2.5 text-xs font-semibold text-gray-500">GST%</th>
                          <th className="text-right px-3 py-2.5 text-xs font-semibold text-gray-500">Qty</th>
                          <th className="text-left px-3 py-2.5 text-xs font-semibold text-gray-500">UOM</th>
                          <th className="text-right px-3 py-2.5 text-xs font-semibold text-gray-500">Rate</th>
                          <th className="text-right px-3 py-2.5 text-xs font-semibold text-gray-500">Disc%</th>
                          <th className="text-right px-3 py-2.5 text-xs font-semibold text-gray-500">Taxable</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {lineItems.map((it, i) => (
                          <tr key={i} className="hover:bg-gray-50">
                            <td className="px-3 py-2.5 text-gray-400 text-sm">{i + 1}</td>
                            <td className="px-3 py-2.5 text-gray-800 text-sm font-medium max-w-[180px]" title={it.description}>{it.description || '—'}</td>
                            <td className="px-3 py-2.5 font-mono text-gray-600 text-sm">{it.hsn || '—'}</td>
                            <td className="px-3 py-2.5 text-right text-gray-600 text-sm">{it.gst_percent}%</td>
                            <td className="px-3 py-2.5 text-right text-gray-700 tabular-nums text-sm">{it.qty}</td>
                            <td className="px-3 py-2.5 text-gray-500 text-sm">{it.uom}</td>
                            <td className="px-3 py-2.5 text-right text-gray-700 tabular-nums text-sm">{formatINR(it.rate)}</td>
                            <td className="px-3 py-2.5 text-right text-gray-600 text-sm">{it.disc_percent > 0 ? `${it.disc_percent}%` : '—'}</td>
                            <td className="px-3 py-2.5 text-right tabular-nums font-semibold text-gray-900 text-sm">{formatINR(calcLineAmount(it))}</td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot className="bg-gray-50 border-t-2 border-gray-200">
                        <tr>
                          <td colSpan={8} className="px-3 py-2.5 text-right text-sm font-semibold text-gray-600">Subtotal</td>
                          <td className="px-3 py-2.5 text-right tabular-nums font-bold text-gray-900 text-sm">{formatINR(subtotal)}</td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                )}
              </div>

              {/* ── Additional Charges ── */}
              {charges.length > 0 && (
                <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
                  <div className="px-4 py-3 border-b border-gray-100">
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Additional Charges</p>
                  </div>
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="text-left px-3 py-2 text-xs font-semibold text-gray-500">Description</th>
                        <th className="text-right px-3 py-2 text-xs font-semibold text-gray-500">GST%</th>
                        <th className="text-right px-3 py-2 text-xs font-semibold text-gray-500">Amount</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {charges.map((c, i) => (
                        <tr key={i}>
                          <td className="px-3 py-2 text-gray-700">{c.description}</td>
                          <td className="px-3 py-2 text-right text-gray-600">{c.gst_percent > 0 ? `${c.gst_percent}%` : '—'}</td>
                          <td className="px-3 py-2 text-right tabular-nums font-medium text-gray-800">{formatINR(c.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* ── HSN Tax Summary ── */}
              {hsnRows.length > 0 && (
                <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
                  <SectionHeader title="Tax Summary (HSN)" open={secHsn} onToggle={() => setSecHsn((v) => !v)} />
                  {secHsn && (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-gray-50 border-b border-gray-100">
                          <tr>
                            <th className="text-left px-3 py-2.5 text-xs font-semibold text-gray-500">#</th>
                            <th className="text-left px-3 py-2.5 text-xs font-semibold text-gray-500">HSN</th>
                            <th className="text-right px-3 py-2.5 text-xs font-semibold text-gray-500">GST%</th>
                            <th className="text-right px-3 py-2.5 text-xs font-semibold text-gray-500">Taxable</th>
                            <th className="text-right px-3 py-2.5 text-xs font-semibold text-gray-500">CGST</th>
                            <th className="text-right px-3 py-2.5 text-xs font-semibold text-gray-500">SGST</th>
                            <th className="text-right px-3 py-2.5 text-xs font-semibold text-gray-500">IGST</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                          {hsnRows.map((r, i) => (
                            <tr key={i} className="hover:bg-gray-50">
                              <td className="px-3 py-2.5 text-gray-400 text-sm">{i + 1}</td>
                              <td className="px-3 py-2.5 font-mono text-gray-700 text-sm">{r.hsn}</td>
                              <td className="px-3 py-2.5 text-right text-gray-600 text-sm">{r.gst_percent}%</td>
                              <td className="px-3 py-2.5 text-right tabular-nums text-gray-800 font-medium text-sm">{formatINR(r.taxable)}</td>
                              <td className="px-3 py-2.5 text-right tabular-nums text-gray-600 text-sm">{r.cgst > 0 ? formatINR(r.cgst) : '—'}</td>
                              <td className="px-3 py-2.5 text-right tabular-nums text-gray-600 text-sm">{r.sgst > 0 ? formatINR(r.sgst) : '—'}</td>
                              <td className="px-3 py-2.5 text-right tabular-nums text-gray-600 text-sm">{r.igst > 0 ? formatINR(r.igst) : '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}

              {/* ── Invoice Reconciliation ── */}
              <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
                <SectionHeader title="Invoice Reconciliation" open={secRecon} onToggle={() => setSecRecon((v) => !v)} />
                {secRecon && (
                  <div className="px-4 py-3 space-y-2 text-sm">
                    <ReconRow label="Subtotal (line items)" value={`₹${formatINR(subtotal)}`} />
                    {billDiscount > 0 && <ReconRow label="Bill Discount (−)" value={`−₹${formatINR(billDiscount)}`} valueClass="text-red-600" />}
                    {chargesTotal > 0 && <ReconRow label="Additional Charges (+)" value={`+₹${formatINR(chargesTotal)}`} />}
                    {chargesGST > 0 && <ReconRow label="Charges GST (+)" value={`+₹${formatINR(chargesGST)}`} />}
                    {(invoice.cgst ?? 0) > 0 && <ReconRow label="CGST (+)" value={`+₹${formatINR(invoice.cgst ?? 0)}`} />}
                    {(invoice.sgst ?? 0) > 0 && <ReconRow label="SGST (+)" value={`+₹${formatINR(invoice.sgst ?? 0)}`} />}
                    {(invoice.igst ?? 0) > 0 && <ReconRow label="IGST (+)" value={`+₹${formatINR(invoice.igst ?? 0)}`} />}
                    {(invoice.round_off ?? 0) !== 0 && <ReconRow label="Round Off" value={`${(invoice.round_off ?? 0) >= 0 ? '₹' : '−₹'}${formatINR(Math.abs(invoice.round_off ?? 0))}`} />}
                    <div className="border-t border-gray-200 pt-2">
                      <ReconRow label="Computed Total" value={`₹${formatINR(computedTotal)}`} bold />
                      <ReconRow label="Invoice Total (stored)" value={`₹${formatINR(invoice.total ?? 0)}`} />
                    </div>
                    {Math.abs(diff) > 0.5
                      ? <div className="flex justify-between items-center text-red-600 font-medium bg-red-50 rounded-lg px-3 py-1.5"><span>⚠ Difference</span><span className="tabular-nums">{diff >= 0 ? '+' : ''}₹{formatINR(diff)}</span></div>
                      : <div className="text-green-700 bg-green-50 rounded-lg px-3 py-1.5 text-sm font-medium">✓ Balanced</div>
                    }
                  </div>
                )}
              </div>

              {/* ── Audit Trail ── */}
              <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
                <SectionHeader title="Audit Trail" open={secAudit} onToggle={() => setSecAudit((v) => !v)} />
                {secAudit && (
                  <div className="px-4 py-3 grid grid-cols-2 gap-3 text-sm">
                    <AuditField label="Accepted At" value={fmt(invoice.accepted_at)} />
                    <AuditField label="Last Modified" value={fmt(inv.last_modified_at)} />
                    <AuditField label="File" value={invoice.original_filename ?? invoice.filename ?? '—'} />
                    <AuditField label="Upload Date" value={invoice.upload_date ?? '—'} />
                  </div>
                )}
              </div>

            </div>
          )}

          {/* ════════════════════════════════════════════════════
              EDIT MODE
          ════════════════════════════════════════════════════ */}
          {mode === 'edit' && (
            <div className="p-4 space-y-4">

              {/* Readiness flags */}
              {liveFlags.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {liveFlags.map((f, i) => (
                    <span key={i} className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium ${f.toLowerCase().includes('missing') || f.toLowerCase().includes('critical') ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'}`}>{f}</span>
                  ))}
                </div>
              )}

              {/* ── Invoice Header ── */}
              <div className="bg-white border border-gray-200 rounded-xl p-4">
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">Invoice Header</p>
                <div className="grid grid-cols-2 gap-4">
                  <Field label="Invoice Number"><TextInput value={editInvoiceNumber} onChange={setEditInvoiceNumber} /></Field>
                  <Field label="Invoice Date"><TextInput value={editInvoiceDate} onChange={setEditInvoiceDate} placeholder="YYYY-MM-DD" /></Field>
                  <Field label="Vendor Name"><TextInput value={editVendorName} onChange={setEditVendorName} /></Field>
                  <Field label="Vendor GSTIN"><TextInput value={editVendorGstin} onChange={setEditVendorGstin} mono /></Field>
                  <Field label="Buyer Name"><TextInput value={editBuyerName} onChange={setEditBuyerName} /></Field>
                  <Field label="Buyer GSTIN"><TextInput value={editBuyerGstin} onChange={setEditBuyerGstin} mono /></Field>
                  <Field label="Tax Type">
                    <select
                      value={editTaxType}
                      onChange={(e) => setEditTaxType(e.target.value as 'cgst_sgst' | 'igst')}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
                    >
                      <option value="cgst_sgst">CGST + SGST</option>
                      <option value="igst">IGST</option>
                    </select>
                  </Field>
                  <Field label="Round Off"><NumInput value={editRoundOff} onChange={setEditRoundOff} /></Field>
                </div>
              </div>

              {/* ── Line Items (card-per-row layout) ── */}
              <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
                <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
                  <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Line Items</p>
                  <span className="text-xs text-gray-500 tabular-nums">Subtotal: ₹{formatINR(editSubtotal)}</span>
                </div>
                <div className="divide-y divide-gray-100">
                  {editLineItems.map((it, i) => (
                    <div key={i} className="p-4 hover:bg-gray-50 transition-colors">
                      <div className="flex items-start justify-between mb-3">
                        <span className="text-xs font-bold text-gray-400 bg-gray-100 rounded-full w-5 h-5 flex items-center justify-center">{i + 1}</span>
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-semibold text-gray-900 tabular-nums">₹{formatINR(calcLineAmount(it))}</span>
                          <button onClick={() => setEditLineItems((prev) => prev.filter((_, j) => j !== i))} className="text-gray-300 hover:text-red-500 transition-colors p-1">
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                          </button>
                        </div>
                      </div>
                      {/* Description — full width */}
                      <div className="mb-3">
                        <label className="block text-xs text-gray-500 mb-1">Description</label>
                        <input
                          type="text"
                          value={it.description ?? ''}
                          onChange={(e) => updateLineItem(i, 'description', e.target.value)}
                          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
                          placeholder="Product / Service description"
                        />
                      </div>
                      {/* Row 1: HSN | GST% | UOM */}
                      <div className="grid grid-cols-3 gap-3 mb-3">
                        <div>
                          <label className="block text-xs text-gray-500 mb-1">HSN Code</label>
                          <input
                            type="text"
                            value={it.hsn}
                            onChange={(e) => updateLineItem(i, 'hsn', e.target.value)}
                            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-300"
                            placeholder="e.g. 96081099"
                          />
                        </div>
                        <div>
                          <label className="block text-xs text-gray-500 mb-1">GST %</label>
                          <input
                            type="number"
                            value={it.gst_percent}
                            onChange={(e) => updateLineItem(i, 'gst_percent', parseFloat(e.target.value) || 0)}
                            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
                          />
                        </div>
                        <div>
                          <label className="block text-xs text-gray-500 mb-1">UOM</label>
                          <input
                            type="text"
                            value={it.uom}
                            onChange={(e) => updateLineItem(i, 'uom', e.target.value)}
                            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
                            placeholder="pcs"
                          />
                        </div>
                      </div>
                      {/* Row 2: Qty | Rate | Disc% */}
                      <div className="grid grid-cols-3 gap-3">
                        <div>
                          <label className="block text-xs text-gray-500 mb-1">Quantity</label>
                          <input
                            type="number"
                            value={it.qty}
                            onChange={(e) => updateLineItem(i, 'qty', parseFloat(e.target.value) || 0)}
                            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
                          />
                        </div>
                        <div>
                          <label className="block text-xs text-gray-500 mb-1">Rate (ex-GST)</label>
                          <input
                            type="number"
                            value={it.rate}
                            onChange={(e) => updateLineItem(i, 'rate', parseFloat(e.target.value) || 0)}
                            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
                          />
                        </div>
                        <div>
                          <label className="block text-xs text-gray-500 mb-1">Discount %</label>
                          <input
                            type="number"
                            value={it.disc_percent}
                            onChange={(e) => updateLineItem(i, 'disc_percent', parseFloat(e.target.value) || 0)}
                            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
                          />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="px-4 py-3 border-t border-gray-100">
                  <button onClick={addLineItem} className="text-sm text-indigo-600 hover:text-indigo-800 font-medium flex items-center gap-1.5">
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
                    Add Line Item
                  </button>
                </div>
              </div>

              {/* ── Bill Discount ── */}
              <div className="bg-white border border-gray-200 rounded-xl p-4">
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">Bill Discount</p>
                <div className="max-w-[200px]">
                  <label className="block text-xs text-gray-500 mb-1">Discount Amount (₹)</label>
                  <NumInput value={editBillDiscount} onChange={setEditBillDiscount} />
                </div>
              </div>

              {/* ── Additional Charges ── */}
              <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
                <div className="px-4 py-3 border-b border-gray-100">
                  <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Additional Charges</p>
                </div>
                {editCharges.map((c, i) => (
                  <div key={i} className="p-4 border-b border-gray-100 hover:bg-gray-50">
                    <div className="grid grid-cols-3 gap-3 items-end">
                      <div className="col-span-1">
                        <label className="block text-xs text-gray-500 mb-1">Description</label>
                        <input type="text" value={c.description} onChange={(e) => updateCharge(i, 'description', e.target.value)}
                          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300" placeholder="e.g. Freight" />
                      </div>
                      <div>
                        <label className="block text-xs text-gray-500 mb-1">GST %</label>
                        <input type="number" value={c.gst_percent} onChange={(e) => updateCharge(i, 'gst_percent', parseFloat(e.target.value) || 0)}
                          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300" />
                      </div>
                      <div className="flex items-end gap-2">
                        <div className="flex-1">
                          <label className="block text-xs text-gray-500 mb-1">Amount (₹)</label>
                          <input type="number" value={c.amount} onChange={(e) => updateCharge(i, 'amount', parseFloat(e.target.value) || 0)}
                            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300" />
                        </div>
                        <button onClick={() => setEditCharges((prev) => prev.filter((_, j) => j !== i))} className="text-gray-300 hover:text-red-500 mb-0.5">
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
                <div className="px-4 py-3">
                  <button onClick={addCharge} className="text-sm text-indigo-600 hover:text-indigo-800 font-medium flex items-center gap-1.5">
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
                    Add Charge
                  </button>
                </div>
              </div>

              {/* ── Live HSN Summary ── */}
              {editHsnRows.length > 0 && (
                <div className="bg-indigo-50 border border-indigo-200 rounded-xl overflow-hidden">
                  <div className="px-4 py-3 border-b border-indigo-200">
                    <p className="text-xs font-semibold text-indigo-600 uppercase tracking-wide">HSN Summary (Live)</p>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-indigo-100/50">
                        <tr>
                          <th className="text-left px-3 py-2 text-xs font-semibold text-indigo-500">HSN</th>
                          <th className="text-right px-3 py-2 text-xs font-semibold text-indigo-500">GST%</th>
                          <th className="text-right px-3 py-2 text-xs font-semibold text-indigo-500">Taxable</th>
                          <th className="text-right px-3 py-2 text-xs font-semibold text-indigo-500">CGST</th>
                          <th className="text-right px-3 py-2 text-xs font-semibold text-indigo-500">SGST</th>
                          <th className="text-right px-3 py-2 text-xs font-semibold text-indigo-500">IGST</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-indigo-100">
                        {editHsnRows.map((r, i) => (
                          <tr key={i}>
                            <td className="px-3 py-2 font-mono text-indigo-700">{r.hsn}</td>
                            <td className="px-3 py-2 text-right text-indigo-600">{r.gst_percent}%</td>
                            <td className="px-3 py-2 text-right tabular-nums font-medium text-indigo-800">{formatINR(r.taxable)}</td>
                            <td className="px-3 py-2 text-right tabular-nums text-indigo-600">{r.cgst > 0 ? formatINR(r.cgst) : '—'}</td>
                            <td className="px-3 py-2 text-right tabular-nums text-indigo-600">{r.sgst > 0 ? formatINR(r.sgst) : '—'}</td>
                            <td className="px-3 py-2 text-right tabular-nums text-indigo-600">{r.igst > 0 ? formatINR(r.igst) : '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* ── Live Invoice Reconciliation ── */}
              <div className="bg-white border border-gray-200 rounded-xl p-4">
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">Live Reconciliation</p>
                <div className="space-y-2 text-sm">
                  <ReconRow label="Line Item Subtotal" value={`₹${formatINR(editSubtotal)}`} />
                  {editBillDiscount > 0 && <ReconRow label="Bill Discount (−)" value={`−₹${formatINR(editBillDiscount)}`} valueClass="text-red-600" />}
                  {editChargesTotal > 0 && <ReconRow label="Additional Charges (+)" value={`+₹${formatINR(editChargesTotal)}`} />}
                  {editCGST > 0 && <ReconRow label="CGST" value={`+₹${formatINR(editCGST)}`} />}
                  {editSGST > 0 && <ReconRow label="SGST" value={`+₹${formatINR(editSGST)}`} />}
                  {editIGST > 0 && <ReconRow label="IGST" value={`+₹${formatINR(editIGST)}`} />}
                  {editRoundOff !== 0 && <ReconRow label="Round Off" value={`${editRoundOff >= 0 ? '' : '−'}₹${formatINR(Math.abs(editRoundOff))}`} />}
                  <div className="border-t border-gray-200 pt-2">
                    <ReconRow label="Computed Total" value={`₹${formatINR(editComputedTotal)}`} bold />
                    <ReconRow label="Original Invoice Total" value={`₹${formatINR(invoice.total ?? 0)}`} />
                  </div>
                  {Math.abs(editComputedTotal - (invoice.total ?? 0)) > 0.5
                    ? <div className="flex justify-between items-center text-amber-700 font-medium bg-amber-50 rounded-lg px-3 py-1.5 text-sm"><span>⚠ Difference from original</span><span className="tabular-nums">{(editComputedTotal - (invoice.total ?? 0)) >= 0 ? '+' : ''}₹{formatINR(editComputedTotal - (invoice.total ?? 0))}</span></div>
                    : <div className="text-green-700 bg-green-50 rounded-lg px-3 py-1.5 text-sm font-medium">✓ Matches original total</div>
                  }
                </div>
              </div>

            </div>
          )}
        </div>

        {/* ── Bottom Action Bar ── */}
        <div className="shrink-0 border-t border-gray-200 px-5 py-3 bg-white">

          {showDeleteConfirm && (
            <div className="mb-3 bg-red-50 border border-red-200 rounded-xl p-4">
              <p className="text-sm font-semibold text-red-800 mb-0.5">Delete Invoice {invoice.invoice_number || invoice.vendor_name}?</p>
              <p className="text-xs text-red-600 mb-3">Permanent — cannot be undone.</p>
              <div className="flex gap-2">
                <button onClick={handleDelete} disabled={deleting} className="px-4 py-2 bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white text-sm font-semibold rounded-lg">
                  {deleting ? 'Deleting…' : 'Confirm Delete'}
                </button>
                <button onClick={() => setShowDeleteConfirm(false)} className="px-4 py-2 border border-gray-300 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50">Cancel</button>
              </div>
            </div>
          )}

          {mode === 'view' ? (
            <div className="flex items-center gap-2">
              <button onClick={() => setShowDeleteConfirm(true)} className="px-4 py-2 border border-red-300 text-red-600 text-sm font-medium rounded-lg hover:bg-red-50 transition-colors">
                Delete
              </button>
              <div className="flex-1" />
              <button onClick={() => setShowRejectModal(true)} className="px-4 py-2 border border-amber-400 text-amber-700 text-sm font-medium rounded-lg hover:bg-amber-50 transition-colors">
                Move to Rejected
              </button>
              <button onClick={() => { setSaveError(''); setMode('edit'); }} className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold rounded-lg transition-colors">
                Edit Invoice
              </button>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-2">
              <button onClick={handleCancelEdit} className="px-4 py-2 border border-gray-300 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50">Cancel</button>
              <div className="flex items-center gap-3">
                {liveReadiness === 'critical' && (
                  <span className="text-xs text-red-600 font-medium">Fix critical issues before saving</span>
                )}
                <button
                  onClick={handleSave}
                  disabled={!canSave}
                  className="px-5 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-lg transition-colors"
                >
                  {saving ? 'Saving…' : 'Save Changes'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Move to Rejected Modal ── */}
      {showRejectModal && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50" onClick={(e) => e.stopPropagation()}>
          <div className="bg-white rounded-2xl shadow-xl max-w-md w-full mx-4 p-6" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-semibold text-gray-900 mb-1">Move to Rejected Archive</h3>
            <p className="text-sm text-gray-500 mb-4">{invoice.invoice_number || '—'} · {invoice.vendor_name}</p>
            <label className="block text-xs font-medium text-gray-600 mb-1">Reason (Optional)</label>
            <textarea
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              rows={3}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 mb-4"
              placeholder="Enter reason…"
            />
            <div className="flex gap-2">
              <button onClick={handleMoveToRejected} disabled={rejecting} className="flex-1 px-4 py-2.5 bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-white text-sm font-semibold rounded-lg">
                {rejecting ? 'Moving…' : 'Confirm'}
              </button>
              <button onClick={() => { setShowRejectModal(false); setRejectReason(''); }} className="flex-1 px-4 py-2.5 border border-gray-300 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ─── Small helpers ─────────────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs text-gray-500 mb-1">{label}</label>
      {children}
    </div>
  );
}

function TextInput({ value, onChange, placeholder, mono }: { value: string; onChange: (v: string) => void; placeholder?: string; mono?: boolean }) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className={`w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300 ${mono ? 'font-mono' : ''}`}
    />
  );
}

function NumInput({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <input
      type="number"
      value={value}
      onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
    />
  );
}

function ReconRow({ label, value, bold, valueClass }: { label: string; value: string; bold?: boolean; valueClass?: string }) {
  return (
    <div className={`flex justify-between items-center ${bold ? 'font-semibold' : ''}`}>
      <span className={bold ? 'text-gray-800' : 'text-gray-600'}>{label}</span>
      <span className={`tabular-nums ${bold ? 'text-gray-900' : 'text-gray-700'} ${valueClass ?? ''}`}>{value}</span>
    </div>
  );
}

function AuditField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-gray-400 mb-0.5">{label}</p>
      <p className="text-sm text-gray-700">{value}</p>
    </div>
  );
}
