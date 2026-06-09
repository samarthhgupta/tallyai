'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { updateAcceptedInvoice, moveAcceptedToRejected, deleteInvoice, computeReadiness } from '@/lib/db';
import type { StoredInvoice, LineItem, ExtraCharge } from '@/types/invoice';
import { formatINR, calcLineAmount, buildHsnSummary, buildFullTaxSummary } from '@/types/invoice';
import { resolveChargeSac } from '@/lib/expenseLedgers';

interface InvoiceDetailPanelProps {
  invoice: StoredInvoice;
  onClose: () => void;
  onSaved: (updated: StoredInvoice) => void;
  onDeleted: () => void;
  onMovedToRejected: () => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(dt: string | null | undefined): string {
  if (!dt) return 'N/A';
  try {
    return new Date(dt).toLocaleString('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch { return dt; }
}

function pct(score: number) { return Math.round(score * 100); }

// ─── Confidence badge + tooltip ───────────────────────────────────────────────

function ConfidenceSection({ score, reasons, flags }: {
  score: number;
  reasons?: string[];
  flags?: string[] | null;
}) {
  const p = pct(score);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const color =
    p >= 85 ? { badge: 'bg-green-50 border-green-200 text-green-800', dot: 'bg-green-500' }
    : p >= 70 ? { badge: 'bg-yellow-50 border-yellow-200 text-yellow-800', dot: 'bg-yellow-500' }
    : { badge: 'bg-red-50 border-red-200 text-red-800', dot: 'bg-red-500' };

  const label = p >= 85 ? 'High' : p >= 70 ? 'Medium' : 'Low';

  // Parse "Field: XX%" style breakdown entries
  const rows: { key: string; val: string }[] = [];
  const plain: string[] = [];
  for (const r of (reasons ?? [])) {
    const m = r.match(/^(.+?):\s*(\d+%?)$/);
    if (m) rows.push({ key: m[1].trim(), val: m[2] });
    else plain.push(r);
  }
  const allGood = !(flags?.length) && p >= 85;

  return (
    <div ref={ref} className="relative">
      <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">Confidence Score</p>
      <div className="flex items-center gap-1.5">
        <div className={`flex items-center gap-1.5 border rounded-md px-2.5 py-1 text-sm font-semibold ${color.badge}`}>
          <span className={`w-2 h-2 rounded-full shrink-0 ${color.dot}`} />
          {label} ({p}%)
        </div>
        <button
          onClick={() => setOpen((v) => !v)}
          className="w-5 h-5 rounded-full bg-gray-100 hover:bg-gray-200 text-gray-500 text-xs font-bold flex items-center justify-center transition-colors"
          title="View breakdown"
        >ⓘ</button>
      </div>

      {open && (
        <div className="absolute top-full mt-2 left-0 z-[300] bg-white border border-gray-200 rounded-xl shadow-xl p-4 w-72">
          <p className="text-xs font-bold text-gray-600 uppercase tracking-wide mb-3">Confidence Breakdown</p>
          {rows.length > 0 ? (
            <table className="w-full text-sm mb-2">
              <tbody className="divide-y divide-gray-100">
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td className="py-1.5 text-gray-600 pr-3">{r.key}</td>
                    <td className="py-1.5 text-right font-semibold text-gray-800 tabular-nums">{r.val}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t-2 border-gray-200">
                <tr>
                  <td className="pt-2 text-gray-700 font-semibold">Overall</td>
                  <td className={`pt-2 text-right font-bold tabular-nums ${p >= 85 ? 'text-green-700' : p >= 70 ? 'text-yellow-700' : 'text-red-700'}`}>{p}%</td>
                </tr>
              </tfoot>
            </table>
          ) : (
            <p className="text-xs text-gray-400 mb-2">No detailed breakdown available</p>
          )}
          {plain.map((r, i) => <p key={i} className="text-xs text-gray-500 mb-1">· {r}</p>)}
          {allGood && <p className="text-xs text-green-700 font-medium mt-1">✓ All key fields verified</p>}
          {(flags ?? []).map((f, i) => (
            <p key={i} className={`text-xs mt-1 font-medium ${f.toLowerCase().includes('missing') ? 'text-red-600' : 'text-amber-600'}`}>⚠ {f}</p>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── ITC status display ────────────────────────────────────────────────────────

function ITCSection({ status, remark }: { status: string | null; remark?: string | null }) {
  const eligible = status === 'eligible';
  const na = !status || status === 'not_applicable';
  return (
    <div>
      <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">ITC Status</p>
      <div className={`flex items-center gap-1.5 text-sm font-semibold ${na ? 'text-gray-400' : eligible ? 'text-green-700' : 'text-amber-700'}`}>
        <span className={`w-2 h-2 rounded-full shrink-0 ${na ? 'bg-gray-300' : eligible ? 'bg-green-500' : 'bg-amber-500'}`} />
        {na ? 'N/A' : eligible ? 'Eligible' : 'At Risk'}
      </div>
      {remark && <p className="text-xs text-gray-400 mt-0.5">{remark}</p>}
    </div>
  );
}

// ─── Collapsible section ───────────────────────────────────────────────────────

function Section({ title, badge, open, onToggle, children }: {
  title: string; badge?: string; open: boolean; onToggle: () => void; children: React.ReactNode;
}) {
  return (
    <div className="border border-gray-200 rounded-xl overflow-hidden bg-white">
      <button onClick={onToggle} className="w-full flex items-center justify-between px-4 py-2.5 bg-gray-50 hover:bg-gray-100 transition-colors">
        <div className="flex items-center gap-2">
          <span className="text-xs font-bold text-gray-500 uppercase tracking-wider">{title}</span>
          {badge && <span className="text-xs text-gray-400 font-normal">({badge})</span>}
        </div>
        <svg className={`w-4 h-4 text-gray-400 transition-transform duration-150 ${open ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && children}
    </div>
  );
}

// ─── Reconciliation row ────────────────────────────────────────────────────────

function ReconRow({ label, value, bold, valueClass }: { label: string; value: string; bold?: boolean; valueClass?: string }) {
  return (
    <div className={`flex justify-between items-center text-sm ${bold ? 'font-semibold' : ''}`}>
      <span className={bold ? 'text-gray-800' : 'text-gray-600'}>{label}</span>
      <span className={`tabular-nums ${bold ? 'text-gray-900' : 'text-gray-700'} ${valueClass ?? ''}`}>{value}</span>
    </div>
  );
}

// ─── Info field (view mode) ────────────────────────────────────────────────────

function InfoField({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-0.5">{label}</p>
      <p className={`text-sm font-medium text-gray-800 ${mono ? 'font-mono' : ''}`}>{value}</p>
    </div>
  );
}

// ─── Form field (edit mode) ────────────────────────────────────────────────────

function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-semibold text-gray-500 mb-1">{label}</label>
      {children}
    </div>
  );
}

const inputCls = 'w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300';
const tblInputCls = 'w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-400';

// ─── Main Component ────────────────────────────────────────────────────────────

export default function InvoiceDetailPanel({
  invoice, onClose, onSaved, onDeleted, onMovedToRejected,
}: InvoiceDetailPanelProps) {
  const [mode, setMode] = useState<'view' | 'edit'>('view');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showRejectModal, setShowRejectModal] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [rejecting, setRejecting] = useState(false);

  // Section open/closed state
  const [secHeader, setSecHeader] = useState(true);
  const [secLines, setSecLines] = useState(true);
  const [secDiscount, setSecDiscount] = useState(true);
  const [secCharges, setSecCharges] = useState(true);
  const [secHsn, setSecHsn] = useState(true);
  const [secRecon, setSecRecon] = useState(true);
  const [secAudit, setSecAudit] = useState(false);

  // Edit state mirrors invoice fields
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
  const [editCharges, setEditCharges] = useState<ExtraCharge[]>(
    (invoice.charges ?? []).map((c) => ({ ...c, sac: resolveChargeSac(c.description, c.sac) })),
  );
  const [liveReadiness, setLiveReadiness] = useState(invoice.readiness);
  const [liveFlags, setLiveFlags] = useState<string[]>(invoice.readiness_flags ?? []);

  // Live readiness recompute
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
  }, [mode, editVendorName, editVendorGstin, editBuyerName, editBuyerGstin, editInvoiceNumber,
      editInvoiceDate, editLineItems, editBillDiscount, editCharges, editRoundOff, editTaxType,
      invoice.confidence, invoice.confidence_reasons]);

  // ── View computed values ──
  const lineItems: LineItem[] = invoice.line_items ?? [];
  // Enrich stored charges with SAC from defaults when SAC is missing
  const charges: ExtraCharge[] = (invoice.charges ?? []).map((c) => ({
    ...c,
    sac: resolveChargeSac(c.description, c.sac),
  }));
  const subtotal = lineItems.reduce((s, it) => s + calcLineAmount(it), 0);           // A
  const billDiscount = invoice.bill_discount_amount ?? 0;                             // B
  const taxableCharges = charges.filter(c => c.gst_percent > 0);
  const nonGstCharges = charges.filter(c => c.gst_percent === 0);
  const taxableChargesTotal = taxableCharges.reduce((s, c) => s + c.amount, 0);      // C
  const nonGstChargesTotal = nonGstCharges.reduce((s, c) => s + c.amount, 0);        // D
  const chargesTotal = taxableChargesTotal + nonGstChargesTotal; void chargesTotal;
  const netTaxable = subtotal - billDiscount + taxableChargesTotal;                   // A - B + C
  // Full tax summary includes HSN rows (line items) + SAC rows (charges)
  const fullTaxRows = buildFullTaxSummary(lineItems, charges, invoice.tax_type, billDiscount);
  const computedCGST = fullTaxRows.reduce((s, r) => s + r.cgst, 0);
  const computedSGST = fullTaxRows.reduce((s, r) => s + r.sgst, 0);
  const computedIGST = fullTaxRows.reduce((s, r) => s + r.igst, 0);
  const computedTotal = netTaxable + nonGstChargesTotal + computedCGST + computedSGST + computedIGST + (invoice.round_off ?? 0);
  const reconDiff = (invoice.total ?? 0) - computedTotal;
  void buildHsnSummary; // still exported for InvoiceCard

  // ── Edit computed values (reactive) ──
  const editSubtotal = editLineItems.reduce((s, it) => s + calcLineAmount(it), 0);
  const editFullTaxRows = buildFullTaxSummary(editLineItems, editCharges, editTaxType, editBillDiscount);
  const editHsnRows = buildHsnSummary(editLineItems, editTaxType, editBillDiscount);
  const editCGST = editFullTaxRows.reduce((s, r) => s + r.cgst, 0);
  const editSGST = editFullTaxRows.reduce((s, r) => s + r.sgst, 0);
  const editIGST = editFullTaxRows.reduce((s, r) => s + r.igst, 0);
  const editTaxableChargesTotal = editCharges.filter(c => c.gst_percent > 0).reduce((s, c) => s + c.amount, 0);
  const editNonGstChargesTotal = editCharges.filter(c => c.gst_percent === 0).reduce((s, c) => s + c.amount, 0);
  const editChargesTotal = editTaxableChargesTotal + editNonGstChargesTotal; void editChargesTotal;
  const editNetTaxable = editSubtotal - editBillDiscount + editTaxableChargesTotal;
  const editComputedTotal = editNetTaxable + editNonGstChargesTotal + editCGST + editSGST + editIGST + editRoundOff;

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
        readiness_flags: liveFlags as string[],
      };
      await updateAcceptedInvoice(invoice.id, patch);
      onSaved({ ...invoice, ...patch } as StoredInvoice);
      setMode('view');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String((err as { message?: string }).message ?? 'Save failed');
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
    setEditCharges((invoice.charges ?? []).map((c) => ({ ...c, sac: resolveChargeSac(c.description, c.sac) })));
    setSaveError('');
    setMode('view');
  }, [invoice]);

  const updLI = (idx: number, field: keyof LineItem, val: string | number) =>
    setEditLineItems(prev => prev.map((it, i) => i === idx ? { ...it, [field]: val } : it));

  const updCh = (idx: number, field: keyof ExtraCharge, val: string | number) =>
    setEditCharges(prev => prev.map((c, i) => i === idx ? { ...c, [field]: val } : c));

  // ── Render ──

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-40 bg-black/40" onClick={onClose} />

      {/* Panel */}
      <div className="fixed inset-y-0 right-0 z-50 w-full max-w-5xl bg-white shadow-2xl flex flex-col overflow-hidden">

        {/* ══ STICKY HEADER BAR ══ */}
        <div className="shrink-0 border-b border-gray-200 bg-white">
          <div className="px-5 py-3 flex items-start justify-between gap-6">

            {/* Left: Invoice no + supplier */}
            <div className="min-w-0 shrink">
              <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-0.5">Invoice No.</p>
              <p className="text-lg font-bold text-gray-900 leading-tight truncate">{invoice.invoice_number || ''}</p>
              <p className="text-sm font-semibold text-gray-700 mt-0.5 truncate">{invoice.vendor_name || ''}</p>
              <p className="text-xs font-mono font-medium text-gray-500">{invoice.vendor_gstin || ''}</p>
            </div>

            {/* Center: Confidence + ITC */}
            <div className="flex flex-col gap-2 shrink-0 pt-0.5">
              <ConfidenceSection
                score={invoice.confidence}
                reasons={invoice.confidence_reasons}
                flags={invoice.readiness_flags}
              />
              <ITCSection status={invoice.itc_status} remark={invoice.itc_remark} />
            </div>

            {/* Right: Total + close */}
            <div className="shrink-0 flex flex-col items-end gap-1.5">
              <button onClick={onClose} className="text-gray-400 hover:text-gray-600 -mr-1 self-end">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
              <div className="text-right">
                <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-0.5">Invoice Total</p>
                <p className="text-2xl font-bold text-indigo-600 tabular-nums leading-tight">
                  ₹{formatINR(mode === 'edit' ? editComputedTotal : (invoice.total ?? 0))}
                </p>
                {mode === 'edit' && Math.abs(editComputedTotal - (invoice.total ?? 0)) > 0.5 && (
                  <p className="text-xs text-amber-600 tabular-nums">was ₹{formatINR(invoice.total ?? 0)}</p>
                )}
              </div>
            </div>
          </div>

          {/* Edit mode tab indicator */}
          {mode === 'edit' && (
            <div className="px-5 pb-2">
              <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-indigo-600 bg-indigo-50 border border-indigo-200 rounded-full px-2.5 py-0.5">
                <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 animate-pulse" />
                Editing
              </span>
            </div>
          )}
        </div>

        {/* Error banner */}
        {saveError && (
          <div className="shrink-0 mx-4 mt-3 bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700 flex items-start gap-2">
            <svg className="w-4 h-4 shrink-0 mt-0.5 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M12 3a9 9 0 110 18A9 9 0 0112 3z" />
            </svg>
            <span className="font-mono text-xs break-all">{saveError}</span>
          </div>
        )}

        {/* ══ SCROLLABLE BODY ══ */}
        <div className="flex-1 overflow-y-auto">

          {/* ════ VIEW MODE ════ */}
          {mode === 'view' && (
            <div className="p-4 space-y-3">

              {/* 1. Invoice Header */}
              <Section title="Invoice Header" open={secHeader} onToggle={() => setSecHeader(v => !v)}>
                <div className="px-4 py-3 grid grid-cols-2 gap-x-8 gap-y-3">
                  <InfoField label="Invoice Date" value={invoice.invoice_date || ''} />
                  <InfoField label="Period" value={invoice.period_label || ''} />
                  <div>
                    <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-0.5">Supplier</p>
                    <p className="text-sm font-semibold text-gray-900">{invoice.vendor_name || ''}</p>
                    <p className="text-sm font-medium font-mono text-gray-600">{invoice.vendor_gstin || ''}</p>
                  </div>
                  <div>
                    <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-0.5">Buyer</p>
                    <p className="text-sm font-semibold text-gray-900">{invoice.buyer_name || ''}</p>
                    <p className="text-sm font-medium font-mono text-gray-600">{invoice.buyer_gstin || ''}</p>
                  </div>
                  <InfoField label="Tax Type" value={invoice.tax_type === 'cgst_sgst' ? 'CGST + SGST' : 'IGST'} />
                </div>
              </Section>

              {/* 2. Goods / Services (A) */}
              <Section title="Goods / Services" badge={`${lineItems.length} item${lineItems.length !== 1 ? 's' : ''}`} open={secLines} onToggle={() => setSecLines(v => !v)}>
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead className="bg-gray-50 border-b border-gray-200">
                      <tr>
                        <th className="text-left px-3 py-2.5 text-xs font-bold text-gray-500 w-7">#</th>
                        <th className="text-left px-3 py-2.5 text-xs font-bold text-gray-500">Description</th>
                        <th className="text-left px-3 py-2.5 text-xs font-bold text-gray-500">HSN</th>
                        <th className="text-right px-3 py-2.5 text-xs font-bold text-gray-500">GST%</th>
                        <th className="text-right px-3 py-2.5 text-xs font-bold text-gray-500">Qty</th>
                        <th className="text-left px-3 py-2.5 text-xs font-bold text-gray-500">UOM</th>
                        <th className="text-right px-3 py-2.5 text-xs font-bold text-gray-500">Rate</th>
                        <th className="text-right px-3 py-2.5 text-xs font-bold text-gray-500">Disc%</th>
                        <th className="text-right px-3 py-2.5 text-xs font-bold text-gray-500">Taxable</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {lineItems.map((it, i) => (
                        <tr key={i} className="hover:bg-gray-50">
                          <td className="px-3 py-2.5 text-sm text-gray-400">{i + 1}</td>
                          <td className="px-3 py-2.5 text-sm font-medium text-gray-800">{it.description || ''}</td>
                          <td className="px-3 py-2.5 text-sm font-mono font-medium text-gray-700">{it.hsn || ''}</td>
                          <td className="px-3 py-2.5 text-sm text-right text-gray-700">{it.gst_percent}%</td>
                          <td className="px-3 py-2.5 text-sm text-right tabular-nums font-medium text-gray-800">{it.qty}</td>
                          <td className="px-3 py-2.5 text-sm text-gray-600">{it.uom}</td>
                          <td className="px-3 py-2.5 text-sm text-right tabular-nums text-gray-800">{formatINR(it.rate)}</td>
                          <td className="px-3 py-2.5 text-sm text-right text-gray-600">{it.disc_percent > 0 ? `${it.disc_percent}%` : '0%'}</td>
                          <td className="px-3 py-2.5 text-sm text-right tabular-nums font-bold text-gray-900">{formatINR(calcLineAmount(it))}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot className="border-t-2 border-gray-300 bg-gray-50">
                      <tr>
                        <td colSpan={8} className="px-3 py-2.5 text-sm font-semibold text-gray-500 text-right">Subtotal (A)</td>
                        <td className="px-3 py-2.5 text-sm text-right tabular-nums font-bold text-gray-900">{formatINR(subtotal)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </Section>

              {/* 3. Bill Discount (B) */}
              <Section title="Bill Discount" badge={billDiscount > 0 ? `−₹${formatINR(billDiscount)}` : 'none'} open={secDiscount} onToggle={() => setSecDiscount(v => !v)}>
                {billDiscount <= 0 ? (
                  <div className="px-4 py-4 text-sm text-gray-400 italic">No bill discount on this invoice.</div>
                ) : (
                  <>
                    <table className="w-full">
                      <thead className="bg-gray-50 border-b border-gray-100">
                        <tr>
                          <th className="text-left px-4 py-2 text-xs font-bold text-gray-500">Description</th>
                          <th className="text-right px-4 py-2 text-xs font-bold text-gray-500">Discount Amount (B)</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr>
                          <td className="px-4 py-2.5 text-sm text-gray-700">Bill Discount</td>
                          <td className="px-4 py-2.5 text-sm text-right tabular-nums font-semibold text-red-600">−₹{formatINR(billDiscount)}</td>
                        </tr>
                      </tbody>
                    </table>
                    <div className="px-4 py-2.5 bg-gray-50 border-t border-gray-100 flex justify-between text-sm">
                      <span className="font-semibold text-gray-600">Net Goods Taxable (A − B)</span>
                      <span className="tabular-nums font-bold text-gray-900">₹{formatINR(subtotal - billDiscount)}</span>
                    </div>
                  </>
                )}
              </Section>

              {/* 4. Additional Charges (C + D) */}
              <Section
                title="Additional Charges"
                badge={charges.length > 0 ? `${charges.length} charge${charges.length !== 1 ? 's' : ''}` : 'none'}
                open={secCharges}
                onToggle={() => setSecCharges(v => !v)}
              >
                {charges.length === 0 ? (
                  <div className="px-4 py-4 text-sm text-gray-400 italic">No additional charges on this invoice.</div>
                ) : (
                  <>
                    <table className="w-full">
                      <thead className="bg-gray-50 border-b border-gray-100">
                        <tr>
                          <th className="text-left px-3 py-2 text-xs font-bold text-gray-500">Description</th>
                          <th className="text-left px-3 py-2 text-xs font-bold text-gray-500">SAC</th>
                          <th className="text-left px-3 py-2 text-xs font-bold text-gray-500">Tax Type</th>
                          <th className="text-right px-3 py-2 text-xs font-bold text-gray-500">GST%</th>
                          <th className="text-right px-3 py-2 text-xs font-bold text-gray-500">Amount</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {charges.map((c, i) => (
                          <tr key={i} className="hover:bg-gray-50">
                            <td className="px-3 py-2 text-sm text-gray-700">{c.description || ''}</td>
                            <td className="px-3 py-2 text-sm font-mono text-gray-500">{(c.sac ?? c.hsn ?? '') || <span className="text-gray-400 text-xs">N/A</span>}</td>
                            <td className="px-3 py-2 text-sm">
                              <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold ${c.gst_percent > 0 ? 'bg-blue-50 text-blue-700' : 'bg-gray-100 text-gray-500'}`}>
                                {c.gst_percent > 0 ? 'Taxable' : 'Non-GST'}
                              </span>
                            </td>
                            <td className="px-3 py-2 text-sm text-right text-gray-600">{c.gst_percent > 0 ? `${c.gst_percent}%` : '0%'}</td>
                            <td className="px-3 py-2 text-sm text-right tabular-nums font-semibold text-gray-800">₹{formatINR(c.amount)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {/* Subtotal rows for C and D */}
                    <div className="border-t border-gray-200 divide-y divide-gray-100">
                      {taxableChargesTotal > 0 && (
                        <div className="px-4 py-2 bg-gray-50 flex justify-between text-xs font-semibold text-gray-500">
                          <span>Taxable Additional Charges (C)</span>
                          <span className="tabular-nums">₹{formatINR(taxableChargesTotal)}</span>
                        </div>
                      )}
                      {nonGstChargesTotal > 0 && (
                        <div className="px-4 py-2 bg-gray-50 flex justify-between text-xs font-semibold text-gray-500">
                          <span>Non-GST Charges (D)</span>
                          <span className="tabular-nums">₹{formatINR(nonGstChargesTotal)}</span>
                        </div>
                      )}
                    </div>
                  </>
                )}
              </Section>

              {/* 5. Tax Summary (HSN + SAC) */}
              {fullTaxRows.length > 0 && (
                <Section title="Tax Summary (HSN / SAC)" open={secHsn} onToggle={() => setSecHsn(v => !v)}>
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead className="bg-gray-50 border-b border-gray-200">
                        <tr>
                          <th className="text-left px-3 py-2.5 text-xs font-bold text-gray-500">#</th>
                          <th className="text-left px-3 py-2.5 text-xs font-bold text-gray-500">HSN / SAC</th>
                          <th className="text-right px-3 py-2.5 text-xs font-bold text-gray-500">GST%</th>
                          <th className="text-right px-3 py-2.5 text-xs font-bold text-gray-500">Taxable</th>
                          <th className="text-right px-3 py-2.5 text-xs font-bold text-gray-500">CGST</th>
                          <th className="text-right px-3 py-2.5 text-xs font-bold text-gray-500">SGST</th>
                          <th className="text-right px-3 py-2.5 text-xs font-bold text-gray-500">IGST</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {fullTaxRows.map((r, i) => (
                          <tr key={i} className="hover:bg-gray-50">
                            <td className="px-3 py-2.5 text-sm text-gray-400">{i + 1}</td>
                            <td className="px-3 py-2.5 text-sm font-mono font-medium text-gray-800">{r.hsn}</td>
                            <td className="px-3 py-2.5 text-sm text-right text-gray-700">{r.gst_percent > 0 ? `${r.gst_percent}%` : '0%'}</td>
                            <td className="px-3 py-2.5 text-sm text-right tabular-nums font-semibold text-gray-900">₹{formatINR(r.taxable)}</td>
                            <td className="px-3 py-2.5 text-sm text-right tabular-nums text-gray-700">{r.cgst > 0 ? `₹${formatINR(r.cgst)}` : '₹0.00'}</td>
                            <td className="px-3 py-2.5 text-sm text-right tabular-nums text-gray-700">{r.sgst > 0 ? `₹${formatINR(r.sgst)}` : '₹0.00'}</td>
                            <td className="px-3 py-2.5 text-sm text-right tabular-nums text-gray-700">{r.igst > 0 ? `₹${formatINR(r.igst)}` : '₹0.00'}</td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot className="border-t-2 border-gray-200 bg-gray-50">
                        <tr>
                          <td colSpan={3} className="px-3 py-2 text-xs font-bold text-gray-500 uppercase">Total</td>
                          <td className="px-3 py-2 text-sm text-right tabular-nums font-bold text-gray-900">₹{formatINR(fullTaxRows.reduce((s, r) => s + r.taxable, 0))}</td>
                          <td className="px-3 py-2 text-sm text-right tabular-nums font-bold text-gray-900">{computedCGST > 0 ? `₹${formatINR(computedCGST)}` : '0%'}</td>
                          <td className="px-3 py-2 text-sm text-right tabular-nums font-bold text-gray-900">{computedSGST > 0 ? `₹${formatINR(computedSGST)}` : '0%'}</td>
                          <td className="px-3 py-2 text-sm text-right tabular-nums font-bold text-gray-900">{computedIGST > 0 ? `₹${formatINR(computedIGST)}` : '0%'}</td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                </Section>
              )}

              {/* 6. Invoice Reconciliation - A/B/C/D convention */}
              <Section title="Invoice Reconciliation" open={secRecon} onToggle={() => setSecRecon(v => !v)}>
                <div className="px-4 py-3 space-y-1.5">
                  <ReconRow label="Subtotal - Line Items (A)" value={`₹${formatINR(subtotal)}`} />
                  {billDiscount > 0 && <ReconRow label="Bill Discount (−B)" value={`−₹${formatINR(billDiscount)}`} valueClass="text-red-600" />}
                  {taxableChargesTotal > 0 && <ReconRow label="Taxable Additional Charges (+C)" value={`+₹${formatINR(taxableChargesTotal)}`} />}
                  <div className="flex justify-between items-center text-sm border-t border-dashed border-gray-200 pt-2 font-semibold">
                    <span className="text-gray-700">Net Taxable Value {billDiscount > 0 && taxableChargesTotal > 0 ? '(A − B + C)' : billDiscount > 0 ? '(A − B)' : taxableChargesTotal > 0 ? '(A + C)' : '(A)'}</span>
                    <span className="tabular-nums text-gray-900">₹{formatINR(netTaxable)}</span>
                  </div>
                  {nonGstChargesTotal > 0 && <ReconRow label="Non-GST Charges (+D)" value={`+₹${formatINR(nonGstChargesTotal)}`} />}
                  {computedCGST > 0 && <ReconRow label="CGST (+)" value={`+₹${formatINR(computedCGST)}`} />}
                  {computedSGST > 0 && <ReconRow label="SGST (+)" value={`+₹${formatINR(computedSGST)}`} />}
                  {computedIGST > 0 && <ReconRow label="IGST (+)" value={`+₹${formatINR(computedIGST)}`} />}
                  {(invoice.round_off ?? 0) !== 0 && (
                    <ReconRow
                      label="Round Off"
                      value={`${(invoice.round_off ?? 0) >= 0 ? '+' : '−'}₹${formatINR(Math.abs(invoice.round_off ?? 0))}`}
                    />
                  )}
                  <div className="border-t border-gray-200 pt-2 space-y-1.5">
                    <ReconRow label="Final Invoice Value (computed)" value={`₹${formatINR(computedTotal)}`} bold />
                    <ReconRow label="Invoice Total (stored)" value={`₹${formatINR(invoice.total ?? 0)}`} />
                  </div>
                  <div className={`flex items-center justify-between rounded-lg px-3 py-2 text-sm font-semibold ${Math.abs(reconDiff) > 0.5 ? 'bg-red-50 text-red-700' : 'bg-green-50 text-green-700'}`}>
                    <span>{Math.abs(reconDiff) > 0.5 ? '⚠ Difference' : '✓ Balanced'}</span>
                    {Math.abs(reconDiff) > 0.5 && <span className="tabular-nums">{reconDiff >= 0 ? '+' : ''}₹{formatINR(reconDiff)}</span>}
                  </div>
                </div>
              </Section>

              {/* Audit Trail */}
              <Section title="Audit Trail" open={secAudit} onToggle={() => setSecAudit(v => !v)}>
                <div className="px-4 py-3 grid grid-cols-2 gap-3">
                  <InfoField label="Accepted At" value={fmt(invoice.accepted_at)} />
                  <InfoField label="Upload Date" value={invoice.upload_date ?? ''} />
                  <InfoField label="File" value={invoice.original_filename ?? invoice.filename ?? ''} />
                  <InfoField label="Period" value={`${invoice.financial_year ?? ''} ${invoice.period_label ?? ''}`.trim() || ''} />
                </div>
              </Section>

            </div>
          )}

          {/* ════ EDIT MODE ════ */}
          {mode === 'edit' && (
            <div className="p-4 space-y-4">

              {/* Readiness flags */}
              {liveFlags.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {liveFlags.map((f, i) => (
                    <span key={i} className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold ${f.toLowerCase().includes('missing') ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'}`}>{f}</span>
                  ))}
                </div>
              )}

              {/* Invoice Header fields */}
              <div className="border border-gray-200 rounded-xl bg-white overflow-hidden">
                <div className="px-4 py-2.5 bg-gray-50 border-b border-gray-200">
                  <span className="text-xs font-bold text-gray-500 uppercase tracking-wider">Invoice Header</span>
                </div>
                <div className="p-4 grid grid-cols-2 gap-3">
                  <FormField label="Invoice Number">
                    <input type="text" value={editInvoiceNumber} onChange={e => setEditInvoiceNumber(e.target.value)} className={inputCls} />
                  </FormField>
                  <FormField label="Invoice Date">
                    <input type="text" value={editInvoiceDate} onChange={e => setEditInvoiceDate(e.target.value)} placeholder="YYYY-MM-DD" className={inputCls} />
                  </FormField>
                  <FormField label="Vendor Name">
                    <input type="text" value={editVendorName} onChange={e => setEditVendorName(e.target.value)} className={inputCls} />
                  </FormField>
                  <FormField label="Vendor GSTIN">
                    <input type="text" value={editVendorGstin} onChange={e => setEditVendorGstin(e.target.value)} className={`${inputCls} font-mono`} />
                  </FormField>
                  <FormField label="Buyer Name">
                    <input type="text" value={editBuyerName} onChange={e => setEditBuyerName(e.target.value)} className={inputCls} />
                  </FormField>
                  <FormField label="Buyer GSTIN">
                    <input type="text" value={editBuyerGstin} onChange={e => setEditBuyerGstin(e.target.value)} className={`${inputCls} font-mono`} />
                  </FormField>
                  <FormField label="Tax Type">
                    <select value={editTaxType} onChange={e => setEditTaxType(e.target.value as 'cgst_sgst' | 'igst')} className={inputCls}>
                      <option value="cgst_sgst">CGST + SGST</option>
                      <option value="igst">IGST</option>
                    </select>
                  </FormField>
                  <FormField label="Bill Discount (₹)">
                    <input type="number" value={editBillDiscount} onChange={e => setEditBillDiscount(parseFloat(e.target.value) || 0)} className={inputCls} />
                  </FormField>
                </div>
              </div>

              {/* Line Items - proper table with fixed widths */}
              <div className="border border-gray-200 rounded-xl bg-white overflow-hidden">
                <div className="px-4 py-2.5 bg-gray-50 border-b border-gray-200 flex items-center justify-between">
                  <span className="text-xs font-bold text-gray-500 uppercase tracking-wider">Line Items</span>
                  <span className="text-xs tabular-nums text-gray-500">Subtotal: ₹{formatINR(editSubtotal)}</span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full" style={{ minWidth: '860px' }}>
                    <thead className="bg-gray-50 border-b border-gray-200">
                      <tr>
                        <th className="px-2 py-2 text-center text-xs font-bold text-gray-500 w-8">#</th>
                        <th className="px-2 py-2 text-left text-xs font-bold text-gray-500" style={{ minWidth: '200px' }}>Description</th>
                        <th className="px-2 py-2 text-left text-xs font-bold text-gray-500 w-28">HSN Code</th>
                        <th className="px-2 py-2 text-right text-xs font-bold text-gray-500 w-16">GST%</th>
                        <th className="px-2 py-2 text-right text-xs font-bold text-gray-500 w-20">Qty</th>
                        <th className="px-2 py-2 text-left text-xs font-bold text-gray-500 w-16">UOM</th>
                        <th className="px-2 py-2 text-right text-xs font-bold text-gray-500 w-24">Rate</th>
                        <th className="px-2 py-2 text-right text-xs font-bold text-gray-500 w-20">Disc%</th>
                        <th className="px-2 py-2 text-right text-xs font-bold text-gray-500 w-24">Taxable</th>
                        <th className="px-2 py-2 w-8" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {editLineItems.map((it, i) => (
                        <tr key={i} className="hover:bg-indigo-50/20">
                          <td className="px-2 py-2 text-xs text-gray-400 text-center">{i + 1}</td>
                          <td className="px-2 py-2">
                            <input type="text" value={it.description ?? ''} onChange={e => updLI(i, 'description', e.target.value)} className={tblInputCls} />
                          </td>
                          <td className="px-2 py-2">
                            <input type="text" value={it.hsn} onChange={e => updLI(i, 'hsn', e.target.value)} className={`${tblInputCls} font-mono`} />
                          </td>
                          <td className="px-2 py-2">
                            <input type="number" value={it.gst_percent} onChange={e => updLI(i, 'gst_percent', parseFloat(e.target.value) || 0)} className={`${tblInputCls} text-right`} />
                          </td>
                          <td className="px-2 py-2">
                            <input type="number" value={it.qty} onChange={e => updLI(i, 'qty', parseFloat(e.target.value) || 0)} className={`${tblInputCls} text-right`} />
                          </td>
                          <td className="px-2 py-2">
                            <input type="text" value={it.uom} onChange={e => updLI(i, 'uom', e.target.value)} className={tblInputCls} />
                          </td>
                          <td className="px-2 py-2">
                            <input type="number" value={it.rate} onChange={e => updLI(i, 'rate', parseFloat(e.target.value) || 0)} className={`${tblInputCls} text-right`} />
                          </td>
                          <td className="px-2 py-2">
                            <input type="number" value={it.disc_percent} onChange={e => updLI(i, 'disc_percent', parseFloat(e.target.value) || 0)} className={`${tblInputCls} text-right`} />
                          </td>
                          <td className="px-2 py-2 text-right text-sm tabular-nums font-semibold text-gray-800 whitespace-nowrap pr-3">
                            {formatINR(calcLineAmount(it))}
                          </td>
                          <td className="px-2 py-2 text-center">
                            <button onClick={() => setEditLineItems(prev => prev.filter((_, j) => j !== i))} className="text-gray-300 hover:text-red-500 transition-colors">
                              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="px-4 py-2.5 border-t border-gray-100">
                  <button
                    onClick={() => setEditLineItems(prev => [...prev, { description: '', hsn: '', gst_percent: 18, uom: 'pcs', qty: 1, rate: 0, disc_percent: 0 }])}
                    className="text-sm font-medium text-indigo-600 hover:text-indigo-800 flex items-center gap-1.5 transition-colors"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
                    Add Line Item
                  </button>
                </div>
              </div>

              {/* Additional Charges (edit) */}
              <div className="border border-gray-200 rounded-xl bg-white overflow-hidden">
                <div className="px-4 py-2.5 bg-gray-50 border-b border-gray-200">
                  <span className="text-xs font-bold text-gray-500 uppercase tracking-wider">Additional Charges</span>
                </div>
                {editCharges.length > 0 && (
                  <div className="overflow-x-auto">
                    <table className="w-full" style={{ minWidth: '620px' }}>
                      <thead className="bg-gray-50 border-b border-gray-100">
                        <tr>
                          <th className="text-left px-3 py-2 text-xs font-bold text-gray-500">Description</th>
                          <th className="text-left px-3 py-2 text-xs font-bold text-gray-500 w-28">SAC</th>
                          <th className="text-left px-3 py-2 text-xs font-bold text-gray-500 w-24">Tax Type</th>
                          <th className="text-right px-3 py-2 text-xs font-bold text-gray-500 w-20">GST%</th>
                          <th className="text-right px-3 py-2 text-xs font-bold text-gray-500 w-32">Amount (₹)</th>
                          <th className="px-3 py-2 w-8" />
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {editCharges.map((c, i) => (
                          <tr key={i} className="hover:bg-gray-50">
                            <td className="px-3 py-2">
                              <input type="text" value={c.description} onChange={e => updCh(i, 'description', e.target.value)} placeholder="e.g. Freight" className={tblInputCls} />
                            </td>
                            <td className="px-3 py-2">
                              <input type="text" value={c.sac ?? ''} onChange={e => updCh(i, 'sac', e.target.value)} placeholder="9965" className={`${tblInputCls} font-mono`} />
                            </td>
                            <td className="px-3 py-2">
                              <span className={`inline-flex items-center px-2 py-1 rounded text-xs font-semibold ${c.gst_percent > 0 ? 'bg-blue-50 text-blue-700' : 'bg-gray-100 text-gray-500'}`}>
                                {c.gst_percent > 0 ? 'Taxable' : 'Non-GST'}
                              </span>
                            </td>
                            <td className="px-3 py-2">
                              <input type="number" value={c.gst_percent} onChange={e => updCh(i, 'gst_percent', parseFloat(e.target.value) || 0)} className={`${tblInputCls} text-right`} />
                            </td>
                            <td className="px-3 py-2">
                              <input type="number" value={c.amount} onChange={e => updCh(i, 'amount', parseFloat(e.target.value) || 0)} className={`${tblInputCls} text-right`} />
                            </td>
                            <td className="px-3 py-2 text-center">
                              <button onClick={() => setEditCharges(prev => prev.filter((_, j) => j !== i))} className="text-gray-300 hover:text-red-500">
                                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <div className="px-4 py-2.5 border-t border-gray-100">
                  <button onClick={() => setEditCharges(prev => [...prev, { description: '', amount: 0, gst_percent: 0, sac: '' }])}
                    className="text-sm font-medium text-indigo-600 hover:text-indigo-800 flex items-center gap-1.5">
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
                    Add Charge
                  </button>
                </div>
              </div>

              {/* Live Tax Summary (HSN + SAC) */}
              {editFullTaxRows.length > 0 && (
                <div className="border border-indigo-200 rounded-xl bg-indigo-50 overflow-hidden">
                  <div className="px-4 py-2.5 bg-indigo-100 border-b border-indigo-200">
                    <span className="text-xs font-bold text-indigo-600 uppercase tracking-wider">Tax Summary - HSN / SAC (Live)</span>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead className="border-b border-indigo-200">
                        <tr>
                          <th className="text-left px-3 py-2 text-xs font-bold text-indigo-500">HSN / SAC</th>
                          <th className="text-right px-3 py-2 text-xs font-bold text-indigo-500">GST%</th>
                          <th className="text-right px-3 py-2 text-xs font-bold text-indigo-500">Taxable</th>
                          <th className="text-right px-3 py-2 text-xs font-bold text-indigo-500">CGST</th>
                          <th className="text-right px-3 py-2 text-xs font-bold text-indigo-500">SGST</th>
                          <th className="text-right px-3 py-2 text-xs font-bold text-indigo-500">IGST</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-indigo-100">
                        {editFullTaxRows.map((r, i) => (
                          <tr key={i}>
                            <td className="px-3 py-2 text-sm font-mono font-medium text-indigo-800">{r.hsn}</td>
                            <td className="px-3 py-2 text-sm text-right text-indigo-700">{r.gst_percent > 0 ? `${r.gst_percent}%` : '0%'}</td>
                            <td className="px-3 py-2 text-sm text-right tabular-nums font-semibold text-indigo-900">₹{formatINR(r.taxable)}</td>
                            <td className="px-3 py-2 text-sm text-right tabular-nums text-indigo-700">{r.cgst > 0 ? `₹${formatINR(r.cgst)}` : '₹0.00'}</td>
                            <td className="px-3 py-2 text-sm text-right tabular-nums text-indigo-700">{r.sgst > 0 ? `₹${formatINR(r.sgst)}` : '₹0.00'}</td>
                            <td className="px-3 py-2 text-sm text-right tabular-nums text-indigo-700">{r.igst > 0 ? `₹${formatINR(r.igst)}` : '₹0.00'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Live Reconciliation + Round Off */}
              <div className="border border-gray-200 rounded-xl bg-white p-4">
                <p className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-3">Live Reconciliation</p>
                <div className="space-y-1.5 mb-4">
                  <ReconRow label="Subtotal - Line Items (A)" value={`₹${formatINR(editSubtotal)}`} />
                  {editBillDiscount > 0 && <ReconRow label="Bill Discount (−B)" value={`−₹${formatINR(editBillDiscount)}`} valueClass="text-red-600" />}
                  {editTaxableChargesTotal > 0 && <ReconRow label="Taxable Additional Charges (+C)" value={`+₹${formatINR(editTaxableChargesTotal)}`} />}
                  <div className="flex justify-between items-center text-sm border-t border-dashed border-gray-200 pt-2 font-semibold">
                    <span className="text-gray-700">
                      Net Taxable Value {editBillDiscount > 0 && editTaxableChargesTotal > 0 ? '(A − B + C)' : editBillDiscount > 0 ? '(A − B)' : editTaxableChargesTotal > 0 ? '(A + C)' : '(A)'}
                    </span>
                    <span className="tabular-nums text-gray-900">₹{formatINR(editNetTaxable)}</span>
                  </div>
                  {editNonGstChargesTotal > 0 && <ReconRow label="Non-GST Charges (+D)" value={`+₹${formatINR(editNonGstChargesTotal)}`} />}
                  {editCGST > 0 && <ReconRow label="CGST (+)" value={`+₹${formatINR(editCGST)}`} />}
                  {editSGST > 0 && <ReconRow label="SGST (+)" value={`+₹${formatINR(editSGST)}`} />}
                  {editIGST > 0 && <ReconRow label="IGST (+)" value={`+₹${formatINR(editIGST)}`} />}
                  {editRoundOff !== 0 && <ReconRow label="Round Off" value={`${editRoundOff >= 0 ? '+' : '−'}₹${formatINR(Math.abs(editRoundOff))}`} />}
                  <div className="border-t border-gray-200 pt-2 space-y-1.5">
                    <ReconRow label="Final Invoice Value (computed)" value={`₹${formatINR(editComputedTotal)}`} bold />
                    <ReconRow label="Original Total" value={`₹${formatINR(invoice.total ?? 0)}`} />
                  </div>
                  <div className={`flex items-center justify-between rounded-lg px-3 py-2 text-sm font-semibold ${Math.abs(editComputedTotal - (invoice.total ?? 0)) > 0.5 ? 'bg-amber-50 text-amber-700' : 'bg-green-50 text-green-700'}`}>
                    <span>{Math.abs(editComputedTotal - (invoice.total ?? 0)) > 0.5 ? '⚠ Differs from original' : '✓ Matches original'}</span>
                    {Math.abs(editComputedTotal - (invoice.total ?? 0)) > 0.5 && (
                      <span className="tabular-nums">{(editComputedTotal - (invoice.total ?? 0)) >= 0 ? '+' : ''}₹{formatINR(editComputedTotal - (invoice.total ?? 0))}</span>
                    )}
                  </div>
                </div>
                <div className="border-t border-gray-100 pt-3">
                  <label className="block text-xs font-semibold text-gray-500 mb-1">Round Off</label>
                  <div className="max-w-[160px]">
                    <input type="number" value={editRoundOff} onChange={e => setEditRoundOff(parseFloat(e.target.value) || 0)} className={inputCls} />
                  </div>
                </div>
              </div>

            </div>
          )}
        </div>

        {/* ══ BOTTOM ACTION BAR ══ */}
        <div className="shrink-0 border-t border-gray-200 bg-white px-5 py-3">

          {showDeleteConfirm && (
            <div className="mb-3 bg-red-50 border border-red-200 rounded-xl p-3">
              <p className="text-sm font-semibold text-red-800 mb-0.5">Delete invoice {invoice.invoice_number}?</p>
              <p className="text-xs text-red-600 mb-2">Permanent - cannot be undone.</p>
              <div className="flex gap-2">
                <button onClick={handleDelete} disabled={deleting} className="px-4 py-1.5 bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white text-sm font-semibold rounded-lg">
                  {deleting ? 'Deleting…' : 'Confirm Delete'}
                </button>
                <button onClick={() => setShowDeleteConfirm(false)} className="px-4 py-1.5 border border-gray-300 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50">
                  Cancel
                </button>
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
            <div className="flex items-center justify-between gap-3">
              <button onClick={handleCancelEdit} className="px-4 py-2 border border-gray-300 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50">
                Cancel
              </button>
              <div className="flex items-center gap-3">
                {liveReadiness === 'critical' && <span className="text-xs text-red-600 font-medium">Fix critical issues first</span>}
                <button onClick={handleSave} disabled={saving || liveReadiness === 'critical'}
                  className="px-5 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-lg transition-colors">
                  {saving ? 'Saving…' : 'Save Changes'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Move to Rejected Modal ── */}
      {showRejectModal && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50" onClick={e => e.stopPropagation()}>
          <div className="bg-white rounded-2xl shadow-xl max-w-md w-full mx-4 p-6" onClick={e => e.stopPropagation()}>
            <h3 className="font-semibold text-gray-900 mb-1">Move to Rejected Archive</h3>
            <p className="text-sm text-gray-500 mb-4">{invoice.invoice_number || ''} · {invoice.vendor_name}</p>
            <label className="block text-xs font-medium text-gray-600 mb-1">Reason (Optional)</label>
            <textarea
              value={rejectReason}
              onChange={e => setRejectReason(e.target.value)}
              rows={3}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 mb-4"
              placeholder="Enter reason…"
            />
            <div className="flex gap-2">
              <button onClick={handleMoveToRejected} disabled={rejecting}
                className="flex-1 px-4 py-2.5 bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-white text-sm font-semibold rounded-lg">
                {rejecting ? 'Moving…' : 'Confirm'}
              </button>
              <button onClick={() => { setShowRejectModal(false); setRejectReason(''); }}
                className="flex-1 px-4 py-2.5 border border-gray-300 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
