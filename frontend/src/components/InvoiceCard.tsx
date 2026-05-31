'use client';

import { useState } from 'react';
import type { ExtractedInvoice, LineItem, HsnRow, ExtraCharge } from '@/types/invoice';
import { formatINR, getStateFromGstin, calcLineAmount, buildHsnSummary } from '@/types/invoice';
import type { LocalCompany } from '@/lib/companies';
import { matchCompany, type MatchResult } from '@/lib/companies';
import type { InvoiceFingerprint } from '@/lib/invoiceHistory';
import { downloadInvoiceExcel } from '@/lib/exportExcel';

// ─── Types ─────────────────────────────────────────────────────────────────────

interface AuditEntry {
  field: string;
  original: string | number;
  updated: string | number;
  timestamp: string;
}

// ─── Charge types & SAC mapping ────────────────────────────────────────────────

const CHARGE_TYPES: { label: string; sac: string }[] = [
  { label: 'Freight',                      sac: '9965' },
  { label: 'Freight Charges',              sac: '9965' },
  { label: 'Freight & Forwarding Charges', sac: '9965' },
  { label: 'F&F Charges',                  sac: '9965' },
  { label: 'Transport Charges',            sac: '9965' },
  { label: 'Transportation Charges',       sac: '9965' },
  { label: 'Delivery Charges',             sac: '9965' },
  { label: 'Builty Charges',               sac: '9965' },
  { label: 'LR Charges',                   sac: '9965' },
  { label: 'Lorry Charges',                sac: '9965' },
  { label: 'Cartage Charges',              sac: '9965' },
  { label: 'Postage',                      sac: '9968' },
  { label: 'Postal Charges',               sac: '9968' },
  { label: 'Courier Charges',              sac: '9968' },
  { label: 'Courier Service',              sac: '9968' },
  { label: 'Dispatch Charges',             sac: '9968' },
  { label: 'Shipping Charges',             sac: '9968' },
  { label: 'Shipping Service',             sac: '9968' },
  { label: 'Packing Charges',              sac: '' },
  { label: 'Handling Charges',             sac: '' },
  { label: 'Other Charges',                sac: '' },
];

function getSacForCharge(description: string): string {
  const match = CHARGE_TYPES.find(
    (ct) => ct.label.toLowerCase() === description.toLowerCase()
  );
  return match?.sac ?? '';
}

function calcAutoRoundOff(d: ExtractedInvoice): number {
  const subtotal = d.line_items.reduce((s, it) => s + calcLineAmount(it), 0);
  const discount = d.bill_discount_amount ?? 0;
  const taxable = subtotal - discount;
  const hsn = buildHsnSummary(d.line_items, d.tax_type, discount);
  const tax = hsn.reduce((s, r) => s + r.cgst + r.sgst + r.igst, 0);
  const chargesTot = (d.charges ?? []).reduce((s, c) => s + c.amount, 0);
  const chargesGST = (d.charges ?? [])
    .filter((c) => c.gst_percent > 0)
    .reduce((s, c) => s + c.amount * c.gst_percent / 100, 0);
  const base = taxable + tax + chargesTot + chargesGST;
  return parseFloat((Math.round(base) - base).toFixed(2));
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/;

function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

function buildAuditEntries(
  original: ExtractedInvoice,
  updated: ExtractedInvoice,
): AuditEntry[] {
  const now = new Date().toISOString();
  const entries: AuditEntry[] = [];

  const headerKeys: Array<keyof ExtractedInvoice> = [
    'vendor_name', 'vendor_gstin', 'invoice_number', 'invoice_date',
  ];
  for (const k of headerKeys) {
    if (original[k] !== updated[k]) {
      entries.push({ field: String(k), original: String(original[k] ?? ''), updated: String(updated[k] ?? ''), timestamp: now });
    }
  }
  if ((original.round_off ?? 0) !== (updated.round_off ?? 0)) {
    entries.push({ field: 'round_off', original: original.round_off ?? 0, updated: updated.round_off ?? 0, timestamp: now });
  }

  updated.line_items.forEach((item, i) => {
    const orig = original.line_items[i];
    if (!orig) return;
    const lineFields: Array<keyof LineItem> = ['hsn', 'gst_percent', 'uom', 'qty', 'rate', 'disc_percent'];
    for (const f of lineFields) {
      if (String(orig[f]) !== String(item[f])) {
        entries.push({
          field: `Line ${i + 1}: ${f}`,
          original: String(orig[f]),
          updated: String(item[f]),
          timestamp: now,
        });
      }
    }
  });

  (updated.charges ?? []).forEach((charge, i) => {
    const orig = (original.charges ?? [])[i];
    if (!orig) return;
    const chargeFields: Array<keyof ExtraCharge> = ['description', 'gst_percent', 'amount'];
    for (const f of chargeFields) {
      if (String(orig[f]) !== String(charge[f])) {
        entries.push({
          field: `Charge ${i + 1}: ${f}`,
          original: String(orig[f]),
          updated: String(charge[f]),
          timestamp: now,
        });
      }
    }
  });

  return entries;
}

function saveAuditLog(key: string, entries: AuditEntry[]) {
  if (typeof window === 'undefined') return;
  try {
    const existing: AuditEntry[] = JSON.parse(localStorage.getItem(`tallyai_audit_${key}`) ?? '[]');
    localStorage.setItem(`tallyai_audit_${key}`, JSON.stringify([...existing, ...entries]));
  } catch { /* ignore */ }
}

// ─── Sub-components ────────────────────────────────────────────────────────────

export function ConfidenceBadge({ score }: { score: number }) {
  const pct = Math.round(score * 100);
  if (pct >= 80) return <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-700">High {pct}%</span>;
  if (pct >= 60) return <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-700">Medium {pct}%</span>;
  return <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-700">Low {pct}%</span>;
}

export function ConfidenceBar({ score }: { score: number }) {
  const pct = Math.round(score * 100);
  const color = pct >= 80 ? 'bg-green-500' : pct >= 60 ? 'bg-amber-400' : 'bg-red-500';
  return (
    <div className="flex items-center gap-2">
      <div className="w-20 h-2 bg-gray-200 rounded-full overflow-hidden">
        <div className={`h-full ${color} rounded-full`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-gray-500">{pct}%</span>
    </div>
  );
}

function CompanyMatchBadge({ match }: { match: MatchResult }) {
  if (match === 'gstin_match') return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-700 border border-green-200">✓ GSTIN matched</span>;
  if (match === 'name_match') return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-700 border border-blue-200">~ Name matched</span>;
  if (match === 'mismatch') return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-700 border border-red-200">✗ Company mismatch</span>;
  return null;
}

export function DuplicateBanner({
  reason, detail, onReject, onKeep,
}: { reason: 'batch' | 'history'; detail: string; onReject: () => void; onKeep: () => void }) {
  return (
    <div className="mx-5 mt-4 rounded-lg border border-red-300 bg-red-50 px-4 py-3">
      <div className="flex items-start gap-3">
        <svg className="w-5 h-5 text-red-500 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
        </svg>
        <div className="flex-1">
          <p className="text-sm font-semibold text-red-800">Possible duplicate invoice</p>
          <p className="text-sm text-red-700 mt-0.5">{detail}</p>
          <div className="flex gap-3 mt-2">
            <button onClick={onReject} className="px-3 py-1.5 bg-red-600 text-white text-xs font-medium rounded-md hover:bg-red-700 transition-colors">Reject &amp; remove</button>
            <button onClick={onKeep} className="px-3 py-1.5 border border-red-300 text-red-700 text-xs font-medium rounded-md hover:bg-red-100 transition-colors">Keep anyway</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Edit input helpers ────────────────────────────────────────────────────────

function HeaderInput({
  value, onChange, error, placeholder, className = '',
}: { value: string; onChange: (v: string) => void; error?: string; placeholder?: string; className?: string }) {
  return (
    <span className="inline-flex flex-col">
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`border rounded px-1.5 py-0.5 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-400 ${error ? 'border-red-400 bg-red-50' : 'border-gray-300 bg-white'} ${className}`}
      />
      {error && <span className="text-xs text-red-500 mt-0.5">{error}</span>}
    </span>
  );
}

function CellInput({
  value, onChange, type = 'text', min, max, step, className = '',
}: { value: string | number; onChange: (v: string) => void; type?: string; min?: string; max?: string; step?: string; className?: string }) {
  return (
    <input
      type={type}
      value={value}
      min={min}
      max={max}
      step={step}
      onChange={(e) => onChange(e.target.value)}
      className={`w-full bg-blue-50 border-0 border-b border-blue-300 focus:outline-none focus:border-indigo-500 focus:bg-indigo-50 text-right px-1 py-0.5 text-sm rounded-sm ${className}`}
    />
  );
}

// ─── InvoiceCard ───────────────────────────────────────────────────────────────

export function InvoiceCard({
  inv, sourceUrl, company, historyMatch, isBatchNew, onReject, onSave,
}: {
  inv: ExtractedInvoice;
  sourceUrl?: string;
  company?: LocalCompany;
  historyMatch: InvoiceFingerprint | null;
  isBatchNew: boolean;
  onReject: () => void;
  onSave?: (updated: ExtractedInvoice) => void;
}) {
  const [displayInv, setDisplayInv] = useState<ExtractedInvoice>(() => deepClone(inv));
  const [editMode, setEditMode] = useState(false);
  const [draft, setDraft] = useState<ExtractedInvoice>(() => deepClone(inv));
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});
  const [auditLog, setAuditLog] = useState<AuditEntry[]>([]);
  const [auditOpen, setAuditOpen] = useState(false);
  const [savedBadge, setSavedBadge] = useState(false);
  const [dupDismissed, setDupDismissed] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [roundOffAuto, setRoundOffAuto] = useState(true);

  const current = editMode ? draft : displayInv;

  // ─── Calculations ──────────────────────────────────────────────────────────

  const computedSubtotal = current.line_items.reduce((s, item) => s + calcLineAmount(item), 0);
  const billDiscount = current.bill_discount_amount ?? 0;
  const hsnRows: HsnRow[] = buildHsnSummary(current.line_items, current.tax_type, billDiscount);
  const taxableValue = computedSubtotal - billDiscount;
  const computedTax = hsnRows.reduce((s, r) => s + r.cgst + r.sgst + r.igst, 0);
  const chargesTotal = (current.charges ?? []).reduce((s, c) => s + c.amount, 0);

  // HSN rows derived from additional charges that have GST > 0
  const chargeHsnRows: HsnRow[] = (current.charges ?? [])
    .filter((c) => c.gst_percent > 0)
    .map((c) => {
      const tax = c.amount * c.gst_percent / 100;
      return {
        hsn: getSacForCharge(c.description) || c.description,
        gst_percent: c.gst_percent,
        taxable: c.amount,
        cgst: current.tax_type === 'cgst_sgst' ? tax / 2 : 0,
        sgst: current.tax_type === 'cgst_sgst' ? tax / 2 : 0,
        igst: current.tax_type === 'igst' ? tax : 0,
      };
    });

  const chargesGST = chargeHsnRows.reduce((s, r) => s + r.cgst + r.sgst + r.igst, 0);
  const computedTotal = taxableValue + computedTax + chargesTotal + chargesGST + (current.round_off ?? 0);

  // ─── Mismatch detection ────────────────────────────────────────────────────

  const invoiceTotal = inv.total; // reference stays fixed (original extracted value)
  const totalDiff = Math.abs(computedTotal - invoiceTotal);
  const isMismatched = invoiceTotal > 0 && totalDiff > 1;
  const wasMismatched = Math.abs(
    displayInv.line_items.reduce((s, it) => s + calcLineAmount(it), 0)
    - (displayInv.bill_discount_amount ?? 0)
    + buildHsnSummary(displayInv.line_items, displayInv.tax_type, displayInv.bill_discount_amount ?? 0).reduce((s, r) => s + r.cgst + r.sgst + r.igst, 0)
    + (displayInv.charges ?? []).reduce((s, c) => s + c.amount, 0)
    + (displayInv.charges ?? []).reduce((s, c) => s + c.amount * c.gst_percent / 100, 0)
    + (displayInv.round_off ?? 0)
    - invoiceTotal
  ) > 1;

  const mismatchJustResolved = editMode && wasMismatched && !isMismatched;

  const needsReview = !reviewed && isMismatched && !editMode;

  // ─── Duplicate ─────────────────────────────────────────────────────────────

  const isBatchDup = !!inv.duplicate_of;
  const isHistoryDup = !!historyMatch && !dupDismissed && !isBatchNew;
  const showDupBanner = (isBatchDup || isHistoryDup) && !dupDismissed;

  // ─── Company match ─────────────────────────────────────────────────────────

  const matchResult: MatchResult = company
    ? matchCompany(company, current.buyer_gstin, current.buyer_name)
    : 'no_buyer_data';

  const vendorState = current.vendor_gstin ? getStateFromGstin(current.vendor_gstin) : null;

  // ─── Validation ────────────────────────────────────────────────────────────

  function validate(d: ExtractedInvoice): Record<string, string> {
    const errors: Record<string, string> = {};
    if (!d.invoice_number?.trim()) errors['invoice_number'] = 'Required';
    if (!d.invoice_date?.trim()) errors['invoice_date'] = 'Required';
    if (!d.vendor_name?.trim()) errors['vendor_name'] = 'Required';
    if (d.vendor_gstin && !GSTIN_RE.test(d.vendor_gstin)) {
      errors['vendor_gstin'] = 'Invalid GSTIN format (15 chars: 00AAAAA0000A0Z0)';
    }
    return errors;
  }

  // ─── Draft field updaters ──────────────────────────────────────────────────

  function setHeader<K extends keyof ExtractedInvoice>(key: K, value: ExtractedInvoice[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
    setValidationErrors((e) => { const n = { ...e }; delete n[key as string]; return n; });
  }

  function setLineItem(i: number, key: keyof LineItem, raw: string) {
    const numKeys = new Set<keyof LineItem>(['qty', 'rate', 'disc_percent', 'gst_percent']);
    const value = numKeys.has(key) ? (parseFloat(raw) || 0) : raw;
    setDraft((d) => {
      const items = d.line_items.map((it, idx) => idx === i ? { ...it, [key]: value } : it);
      const next = { ...d, line_items: items };
      return roundOffAuto ? { ...next, round_off: calcAutoRoundOff(next) } : next;
    });
  }

  function setCharge(i: number, key: keyof ExtraCharge, raw: string) {
    const numKeys = new Set<keyof ExtraCharge>(['amount', 'gst_percent']);
    const value = numKeys.has(key) ? (parseFloat(raw) || 0) : raw;
    setDraft((d) => {
      const charges = (d.charges ?? []).map((c, idx) => idx === i ? { ...c, [key]: value } : c);
      const next = { ...d, charges };
      return roundOffAuto ? { ...next, round_off: calcAutoRoundOff(next) } : next;
    });
  }

  function setDiscountAmount(raw: string) {
    const amount = parseFloat(raw) || 0;
    setDraft((d) => {
      const subtotal = d.line_items.reduce((s, it) => s + calcLineAmount(it), 0);
      const pct = subtotal > 0 ? parseFloat(((amount / subtotal) * 100).toFixed(2)) : null;
      const next = { ...d, bill_discount_amount: amount, bill_discount_percent: pct };
      return roundOffAuto ? { ...next, round_off: calcAutoRoundOff(next) } : next;
    });
  }

  function setDiscountPercent(raw: string) {
    const pct = parseFloat(raw) || 0;
    setDraft((d) => {
      const subtotal = d.line_items.reduce((s, it) => s + calcLineAmount(it), 0);
      const amount = parseFloat((subtotal * pct / 100).toFixed(2));
      const next = { ...d, bill_discount_amount: amount, bill_discount_percent: pct };
      return roundOffAuto ? { ...next, round_off: calcAutoRoundOff(next) } : next;
    });
  }

  // ─── Save / Cancel ─────────────────────────────────────────────────────────

  function handleEnterEdit() {
    setDraft(deepClone(displayInv));
    setValidationErrors({});
    setRoundOffAuto(true);
    setEditMode(true);
  }

  function handleCancel() {
    setDraft(deepClone(displayInv));
    setValidationErrors({});
    setEditMode(false);
  }

  function handleSave() {
    const errors = validate(draft);
    if (Object.keys(errors).length > 0) {
      setValidationErrors(errors);
      return;
    }
    const newEntries = buildAuditEntries(displayInv, draft);
    const auditKey = `${draft.vendor_name}__${draft.invoice_number}`.replace(/\s+/g, '_');
    if (newEntries.length > 0) {
      saveAuditLog(auditKey, newEntries);
      setAuditLog((prev) => [...prev, ...newEntries]);
    }
    setDisplayInv(deepClone(draft));
    onSave?.(deepClone(draft));
    setEditMode(false);
    setSavedBadge(true);
    setTimeout(() => setSavedBadge(false), 3000);
  }

  // ─── Render ────────────────────────────────────────────────────────────────

  const borderColor = showDupBanner ? 'border-red-300' : (isMismatched && !editMode) ? 'border-amber-300' : (editMode ? 'border-indigo-400' : 'border-gray-200');

  // Totals for all rows (goods + charges) used in Tax Summary and Reconciliation
  const allHsnRows = [...hsnRows, ...chargeHsnRows];
  const totalCGST = allHsnRows.reduce((s, r) => s + r.cgst, 0);
  const totalSGST = allHsnRows.reduce((s, r) => s + r.sgst, 0);
  const totalIGST = allHsnRows.reduce((s, r) => s + r.igst, 0);
  const totalTaxable = allHsnRows.reduce((s, r) => s + r.taxable, 0);

  return (
    <div className={`bg-white rounded-lg border shadow-sm overflow-hidden ${borderColor} ${editMode ? 'ring-1 ring-indigo-200' : ''}`}>

      {/* ── Action Bar ── */}
      <div className={`px-5 py-3 flex items-center justify-between gap-4 flex-wrap ${editMode ? 'bg-indigo-50 border-b border-indigo-100' : 'bg-gray-50 border-b border-gray-100'}`}>
        <div className="flex items-center gap-2 flex-wrap">
          <ConfidenceBadge score={inv.confidence} />
          {company && <CompanyMatchBadge match={matchResult} />}
          {matchResult === 'mismatch' && (
            <span className="text-xs text-red-600">
              Invoice addressed to &ldquo;{current.buyer_name || current.buyer_gstin}&rdquo; — not {company?.name}
            </span>
          )}
          {needsReview && !editMode && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-700 border border-amber-300">
              ⚠ Needs Review
            </span>
          )}
          {savedBadge && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-700 border border-green-200 animate-pulse">
              ✓ Saved
            </span>
          )}
          {sourceUrl && (
            <a href={sourceUrl} target="_blank" rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-indigo-600 hover:text-indigo-800 hover:underline">
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
              View original
            </a>
          )}
          {!editMode && (
            <button onClick={() => downloadInvoiceExcel(displayInv)}
              className="inline-flex items-center gap-1 text-xs text-green-700 hover:text-green-900 bg-green-50 hover:bg-green-100 border border-green-200 px-2 py-0.5 rounded transition-colors">
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              Excel
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          {editMode ? (
            <>
              <button onClick={handleCancel}
                className="px-3 py-1.5 text-xs font-medium border border-gray-300 text-gray-600 rounded-md hover:bg-gray-50 transition-colors">
                Cancel
              </button>
              <button onClick={handleSave}
                className="px-3 py-1.5 text-xs font-medium bg-indigo-600 text-white rounded-md hover:bg-indigo-700 transition-colors">
                Save Changes
              </button>
            </>
          ) : (
            <button onClick={handleEnterEdit}
              className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium border border-gray-300 text-gray-600 rounded-md hover:bg-gray-50 hover:border-indigo-300 hover:text-indigo-700 transition-colors">
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
              Edit Invoice
            </button>
          )}
        </div>
      </div>

      {/* ── Duplicate Banner ── */}
      {showDupBanner && (
        <DuplicateBanner
          reason={isBatchDup ? 'batch' : 'history'}
          detail={
            isBatchDup
              ? `This invoice (${inv.invoice_number}) already appears in ${inv.duplicate_of_filename} in this upload batch.`
              : `Invoice ${inv.invoice_number} from ${inv.vendor_name} was already uploaded on ${new Date(historyMatch!.uploaded_at).toLocaleDateString('en-IN')} (Total ₹${historyMatch!.total.toLocaleString('en-IN')}).`
          }
          onReject={onReject}
          onKeep={() => setDupDismissed(true)}
        />
      )}

      {/* ── Mismatch / Review Banner ── */}
      {(needsReview || (editMode && (isMismatched || mismatchJustResolved))) && (
        <div className={`mx-5 mt-4 rounded-lg border px-4 py-3 ${mismatchJustResolved ? 'border-green-300 bg-green-50' : 'border-amber-300 bg-amber-50'}`}>
          {mismatchJustResolved ? (
            <div className="flex items-center gap-2 text-green-800">
              <svg className="w-5 h-5 text-green-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <div>
                <p className="text-sm font-semibold">✓ Mismatch Resolved</p>
                <p className="text-xs text-green-700 mt-0.5">
                  Computed total ₹{formatINR(computedTotal)} now matches invoice total ₹{formatINR(invoiceTotal)}. Save changes to confirm.
                </p>
              </div>
            </div>
          ) : (
            <div className="flex items-start gap-3">
              <svg className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
              </svg>
              <div className="flex-1">
                <p className="text-sm font-semibold text-amber-800">
                  {editMode ? '⚠ Difference Between Computed Value and Invoice Value' : 'Human review required'}
                </p>
                <div className="text-sm text-amber-700 mt-0.5">
                  {inv.bill_discount_auto_detected && !editMode ? (
                    <p>A bill-level discount of <strong>₹{formatINR(Math.abs(computedTotal - invoiceTotal))}</strong> was <strong>auto-detected</strong> and applied. Please verify against the original invoice.</p>
                  ) : (
                    <div className="flex flex-wrap gap-4 mt-1">
                      <span>Computed: <strong>₹{formatINR(computedTotal)}</strong></span>
                      <span>Invoice: <strong>₹{formatINR(invoiceTotal)}</strong></span>
                      <span className="text-red-600 font-semibold">
                        Difference: {computedTotal > invoiceTotal ? '+' : '−'}₹{formatINR(Math.abs(computedTotal - invoiceTotal))}
                      </span>
                    </div>
                  )}
                </div>
                {!editMode && (
                  <div className="flex items-center gap-3 mt-2">
                    {sourceUrl && (
                      <a href={sourceUrl} target="_blank" rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-xs font-medium text-amber-800 underline hover:text-amber-900">
                        Open original →
                      </a>
                    )}
                    <button onClick={() => setReviewed(true)} className="text-xs font-medium text-amber-700 hover:text-amber-900 underline">
                      Mark as reviewed ✓
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════════ */}
      {/* Section 1 — Invoice Summary                                          */}
      {/* ══════════════════════════════════════════════════════════════════════ */}
      <div className="px-5 py-4 border-t border-gray-100">
        <h4 className="text-xs font-semibold text-emerald-700 uppercase tracking-wide mb-3 pb-1 border-b border-emerald-100">
          1. Invoice Summary
        </h4>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-12 gap-y-2 text-sm">

          {/* Invoice No */}
          <div className="flex items-baseline gap-2">
            <span className="text-gray-500 w-36 shrink-0">Invoice No</span>
            {editMode
              ? <HeaderInput value={draft.invoice_number} onChange={(v) => setHeader('invoice_number', v)} error={validationErrors['invoice_number']} placeholder="Invoice #" className="flex-1" />
              : <span className="font-medium">{current.invoice_number || '—'}</span>}
          </div>

          {/* Invoice Date */}
          <div className="flex items-baseline gap-2">
            <span className="text-gray-500 w-36 shrink-0">Invoice Date</span>
            {editMode
              ? <HeaderInput value={draft.invoice_date} onChange={(v) => setHeader('invoice_date', v)} error={validationErrors['invoice_date']} placeholder="YYYY-MM-DD" className="flex-1" />
              : <span className="font-medium">{current.invoice_date || '—'}</span>}
          </div>

          {/* Supplier Name */}
          <div className="flex items-baseline gap-2">
            <span className="text-gray-500 w-36 shrink-0">Supplier Name</span>
            {editMode
              ? <HeaderInput value={draft.vendor_name} onChange={(v) => setHeader('vendor_name', v)} error={validationErrors['vendor_name']} placeholder="Vendor Name" className="flex-1 font-semibold" />
              : <span className="font-semibold text-gray-900">{current.vendor_name || '—'}</span>}
          </div>

          {/* Supplier GSTIN */}
          <div className="flex items-baseline gap-2">
            <span className="text-gray-500 w-36 shrink-0">Supplier GSTIN</span>
            {editMode
              ? <HeaderInput value={draft.vendor_gstin ?? ''} onChange={(v) => setHeader('vendor_gstin', v.toUpperCase())} error={validationErrors['vendor_gstin']} placeholder="GSTIN" className="flex-1 font-mono text-xs" />
              : <span className="font-mono text-xs">{current.vendor_gstin || '—'}{vendorState && vendorState !== 'Unknown' && <span className="ml-2 text-xs bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded not-italic font-sans">{vendorState}</span>}</span>}
          </div>

          {/* Customer Name */}
          <div className="flex items-baseline gap-2">
            <span className="text-gray-500 w-36 shrink-0">Customer Name</span>
            <span className="font-medium">{current.buyer_name || '—'}</span>
          </div>

          {/* Customer GSTIN */}
          <div className="flex items-baseline gap-2">
            <span className="text-gray-500 w-36 shrink-0">Customer GSTIN</span>
            <span className="font-mono text-xs">{current.buyer_gstin || '—'}</span>
          </div>

          {/* Invoice Total */}
          <div className="flex items-baseline gap-2">
            <span className="text-gray-500 w-36 shrink-0">Invoice Total</span>
            <span className="font-semibold text-gray-900">₹{formatINR(invoiceTotal)}</span>
          </div>

          {/* Confidence Score */}
          <div className="flex items-center gap-2">
            <span className="text-gray-500 w-36 shrink-0">Confidence</span>
            <ConfidenceBar score={inv.confidence} />
          </div>

        </div>

        {/* Confidence reasons — suppress stale mismatch warnings when totals currently reconcile */}
        {inv.confidence_reasons && inv.confidence_reasons.length > 0 && (() => {
          const visibleReasons = inv.confidence_reasons.filter(r => {
            if (!isMismatched && (r.includes("doesn't match") || r.includes("Computed total") || r.includes("match invoice total"))) return false;
            return true;
          });
          return visibleReasons.length > 0 ? (
            <ul className="mt-2 space-y-0.5">
              {visibleReasons.map((r, i) => (
                <li key={i} className={`text-xs ${r.includes('✓') ? 'text-green-600' : 'text-red-500'}`}>
                  {r.includes('✓') ? '' : '↓ '}{r}
                </li>
              ))}
            </ul>
          ) : null;
        })()}
      </div>

      {/* ══════════════════════════════════════════════════════════════════════ */}
      {/* Section 2 — Goods / Services                                         */}
      {/* ══════════════════════════════════════════════════════════════════════ */}
      {current.line_items.length > 0 && (
        <div className="px-5 pb-4 pt-4 border-t border-gray-100">
          <h4 className="text-xs font-semibold text-emerald-700 uppercase tracking-wide mb-3 pb-1 border-b border-emerald-100">
            2. Goods / Services
          </h4>
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="bg-gray-50">
                  {['S.No', 'Description', 'HSN', 'Ledger Name', 'Qty', 'UOM', 'Rate (ex-GST)', 'Disc %', 'Taxable Amount'].map((h) => (
                    <th key={h} className="text-left px-2 py-2 text-xs text-gray-500 font-medium border border-gray-200 whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {current.line_items.map((item: LineItem, i: number) => (
                  <tr key={i} className={`hover:bg-gray-50 ${editMode ? 'bg-blue-50/30' : ''}`}>

                    {/* S.No */}
                    <td className="px-2 py-1.5 border border-gray-200 text-xs text-gray-500 text-center w-10">{i + 1}</td>

                    {/* Description */}
                    <td className="px-2 py-1.5 border border-gray-200 text-xs min-w-[160px]">
                      {item.description || '—'}
                    </td>

                    {/* HSN (editable in edit mode — includes GST% inline) */}
                    <td className="px-2 py-1.5 border border-gray-200 font-mono text-xs min-w-[140px]">
                      {editMode ? (
                        <div className="flex items-center gap-1">
                          <CellInput value={item.hsn.replace(/[\s.]/g, '') || ''} onChange={(v) => setLineItem(i, 'hsn', v)} className="w-20 text-left" />
                          <span className="text-gray-400 text-xs">@</span>
                          <CellInput value={item.gst_percent} onChange={(v) => setLineItem(i, 'gst_percent', v)} type="number" min="0" step="0.01" className="w-10" />
                          <span className="text-gray-400 text-xs">%</span>
                        </div>
                      ) : (
                        item.hsn.replace(/[\s.]/g, '') || '—'
                      )}
                    </td>

                    {/* Ledger Name — display only, auto-derived */}
                    <td className="px-2 py-1.5 border border-gray-200 font-mono text-xs text-gray-500 whitespace-nowrap">
                      {item.hsn.replace(/[\s.]/g, '') || '—'} @ {item.gst_percent}%
                    </td>

                    {/* Qty */}
                    <td className="px-2 py-1.5 border border-gray-200 text-right">
                      {editMode ? <CellInput value={item.qty} onChange={(v) => setLineItem(i, 'qty', v)} type="number" min="0" step="0.001" className="w-16" /> : item.qty}
                    </td>

                    {/* UOM */}
                    <td className="px-2 py-1.5 border border-gray-200 text-xs">
                      {editMode ? <CellInput value={item.uom || ''} onChange={(v) => setLineItem(i, 'uom', v)} className="w-14 text-left" /> : (item.uom || '—')}
                    </td>

                    {/* Rate */}
                    <td className="px-2 py-1.5 border border-gray-200 text-right">
                      {editMode ? <CellInput value={item.rate} onChange={(v) => setLineItem(i, 'rate', v)} type="number" min="0" step="0.01" className="w-20" /> : formatINR(item.rate)}
                    </td>

                    {/* Disc % */}
                    <td className="px-2 py-1.5 border border-gray-200 text-right">
                      {editMode ? <CellInput value={item.disc_percent as number} onChange={(v) => setLineItem(i, 'disc_percent', v)} type="number" min="0" max="100" step="0.01" className="w-14" /> : `${item.disc_percent}%`}
                    </td>

                    {/* Taxable Amount (after item discount, before bill discount) */}
                    <td className="px-2 py-1.5 border border-gray-200 text-right font-medium">
                      {formatINR(calcLineAmount(item))}
                    </td>

                  </tr>
                ))}
                <tr className="bg-gray-50 font-semibold">
                  <td colSpan={8} className="px-2 py-1.5 border border-gray-200 text-xs text-right text-gray-600">Line Item Taxable Value</td>
                  <td className="px-2 py-1.5 border border-gray-200 text-right text-sm">{formatINR(computedSubtotal)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════════ */}
      {/* Section 3 — Bill Level Adjustments                                   */}
      {/* ══════════════════════════════════════════════════════════════════════ */}
      {(editMode || billDiscount > 0) && (
        <div className="px-5 pb-4 pt-4 border-t border-gray-100">
          <h4 className="text-xs font-semibold text-emerald-700 uppercase tracking-wide mb-3 pb-1 border-b border-emerald-100">
            3. Bill Level Adjustments
          </h4>
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="bg-gray-50">
                  {['Description', 'Rate', 'Amount'].map((h) => (
                    <th key={h} className="text-left px-2 py-2 text-xs text-gray-500 font-medium border border-gray-200 whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr className={editMode ? 'bg-blue-50/30' : ''}>
                  <td className="px-2 py-1.5 border border-gray-200 text-xs font-medium text-orange-700">Invoice Discount</td>
                  <td className="px-2 py-1.5 border border-gray-200 text-right w-32">
                    {editMode ? (
                      <div className="flex items-center justify-end gap-1">
                        <input
                          type="number" min="0" max="100" step="0.01"
                          value={draft.bill_discount_percent ?? ''}
                          placeholder="0"
                          onChange={(e) => setDiscountPercent(e.target.value)}
                          className="w-16 border border-orange-200 bg-orange-50 rounded px-1.5 py-0.5 text-sm text-right focus:outline-none focus:ring-1 focus:ring-orange-400"
                        />
                        <span className="text-xs text-gray-500">%</span>
                      </div>
                    ) : (
                      <span className="text-orange-600">
                        {current.bill_discount_percent != null ? `${current.bill_discount_percent}%` : '—'}
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-1.5 border border-gray-200 text-right font-medium w-36">
                    {editMode ? (
                      <div className="flex items-center justify-end gap-1">
                        <span className="text-xs text-gray-400">₹</span>
                        <input
                          type="number" min="0" step="0.01"
                          value={draft.bill_discount_amount ?? 0}
                          onChange={(e) => setDiscountAmount(e.target.value)}
                          className="w-24 border border-orange-200 bg-orange-50 rounded px-1.5 py-0.5 text-sm text-right focus:outline-none focus:ring-1 focus:ring-orange-400"
                        />
                      </div>
                    ) : (
                      <span className="text-orange-600">−{formatINR(billDiscount)}</span>
                    )}
                  </td>
                </tr>
                <tr className="bg-gray-50 font-semibold">
                  <td colSpan={2} className="px-2 py-1.5 border border-gray-200 text-xs text-right text-gray-600">Net Goods Taxable Value</td>
                  <td className="px-2 py-1.5 border border-gray-200 text-right text-sm">{formatINR(taxableValue)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════════ */}
      {/* Section 4 — Additional Charges                                        */}
      {/* ══════════════════════════════════════════════════════════════════════ */}
      {(current.charges ?? []).length > 0 && (
        <div className="px-5 pb-4 pt-4 border-t border-gray-100">
          <h4 className="text-xs font-semibold text-emerald-700 uppercase tracking-wide mb-3 pb-1 border-b border-emerald-100">
            4. Additional Charges
          </h4>
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="bg-gray-50">
                  {['Description', 'SAC', 'Ledger Name', 'Taxable Amount', 'GST %', 'GST Amount'].map((h) => (
                    <th key={h} className="text-left px-2 py-2 text-xs text-gray-500 font-medium border border-gray-200 whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(current.charges ?? []).map((c: ExtraCharge, i: number) => {
                  const sac = getSacForCharge(c.description);
                  const gstAmt = c.amount * c.gst_percent / 100;
                  return (
                    <tr key={i} className={`hover:bg-gray-50 ${editMode ? 'bg-blue-50/30' : ''}`}>

                      {/* Description */}
                      <td className="px-2 py-1.5 border border-gray-200 text-xs min-w-[200px]">
                        {editMode ? (
                          <select
                            value={c.description}
                            onChange={(e) => setCharge(i, 'description', e.target.value)}
                            className="w-full bg-blue-50 border-0 border-b border-blue-300 focus:outline-none focus:border-indigo-500 focus:bg-indigo-50 py-0.5 text-sm rounded-sm"
                          >
                            {CHARGE_TYPES.map((ct) => (
                              <option key={ct.label} value={ct.label}>{ct.label}</option>
                            ))}
                            {!CHARGE_TYPES.find((ct) => ct.label === c.description) && (
                              <option value={c.description}>{c.description}</option>
                            )}
                          </select>
                        ) : c.description}
                      </td>

                      {/* SAC */}
                      <td className="px-2 py-1.5 border border-gray-200 font-mono text-xs text-gray-500">{sac || '—'}</td>

                      {/* Ledger Name — display only */}
                      <td className="px-2 py-1.5 border border-gray-200 font-mono text-xs text-gray-500 whitespace-nowrap">
                        {c.description} @ {c.gst_percent}%
                      </td>

                      {/* Taxable Amount */}
                      <td className="px-2 py-1.5 border border-gray-200 text-right font-medium">
                        {editMode ? (
                          <CellInput value={c.amount} onChange={(v) => setCharge(i, 'amount', v)} type="number" min="0" step="0.01" className="w-24" />
                        ) : formatINR(c.amount)}
                      </td>

                      {/* GST % */}
                      <td className="px-2 py-1.5 border border-gray-200 text-right w-20">
                        {editMode ? (
                          <CellInput value={c.gst_percent} onChange={(v) => setCharge(i, 'gst_percent', v)} type="number" min="0" max="100" step="0.01" className="w-14" />
                        ) : `${c.gst_percent}%`}
                      </td>

                      {/* GST Amount */}
                      <td className="px-2 py-1.5 border border-gray-200 text-right font-medium">{formatINR(gstAmt)}</td>

                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════════ */}
      {/* Section 5 — Tax Summary                                              */}
      {/* ══════════════════════════════════════════════════════════════════════ */}
      {allHsnRows.length > 0 && (
        <div className="px-5 pb-4 pt-4 border-t border-gray-100">
          <h4 className="text-xs font-semibold text-emerald-700 uppercase tracking-wide mb-3 pb-1 border-b border-emerald-100">
            5. Tax Summary
          </h4>
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="bg-gray-50">
                  {['S.No', 'HSN / SAC', 'Taxable Value', 'CGST', 'SGST', 'IGST'].map((h) => (
                    <th key={h} className="text-left px-2 py-2 text-xs text-gray-500 font-medium border border-gray-200 whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {hsnRows.map((row: HsnRow, i: number) => (
                  <tr key={`goods-${i}`} className="hover:bg-gray-50">
                    <td className="px-2 py-1.5 border border-gray-200 text-xs text-gray-500 text-center w-10">{i + 1}</td>
                    <td className="px-2 py-1.5 border border-gray-200 font-mono text-xs">{row.hsn}</td>
                    <td className="px-2 py-1.5 border border-gray-200 text-right">{formatINR(row.taxable)}</td>
                    <td className="px-2 py-1.5 border border-gray-200 text-right">{row.cgst > 0 ? formatINR(row.cgst) : '—'}</td>
                    <td className="px-2 py-1.5 border border-gray-200 text-right">{row.sgst > 0 ? formatINR(row.sgst) : '—'}</td>
                    <td className="px-2 py-1.5 border border-gray-200 text-right">{row.igst > 0 ? formatINR(row.igst) : '—'}</td>
                  </tr>
                ))}
                {chargeHsnRows.map((row: HsnRow, i: number) => (
                  <tr key={`charge-${i}`} className="hover:bg-gray-50 bg-blue-50/20">
                    <td className="px-2 py-1.5 border border-gray-200 text-xs text-gray-500 text-center w-10">{hsnRows.length + i + 1}</td>
                    <td className="px-2 py-1.5 border border-gray-200 font-mono text-xs">
                      {row.hsn} <span className="text-blue-500 not-italic font-sans">(SAC)</span>
                    </td>
                    <td className="px-2 py-1.5 border border-gray-200 text-right">{formatINR(row.taxable)}</td>
                    <td className="px-2 py-1.5 border border-gray-200 text-right">{row.cgst > 0 ? formatINR(row.cgst) : '—'}</td>
                    <td className="px-2 py-1.5 border border-gray-200 text-right">{row.sgst > 0 ? formatINR(row.sgst) : '—'}</td>
                    <td className="px-2 py-1.5 border border-gray-200 text-right">{row.igst > 0 ? formatINR(row.igst) : '—'}</td>
                  </tr>
                ))}
                <tr className="bg-gray-50 font-semibold text-sm">
                  <td colSpan={2} className="px-2 py-1.5 border border-gray-200 text-xs text-gray-600">TOTAL</td>
                  <td className="px-2 py-1.5 border border-gray-200 text-right">{formatINR(totalTaxable)}</td>
                  <td className="px-2 py-1.5 border border-gray-200 text-right">{totalCGST > 0 ? formatINR(totalCGST) : '—'}</td>
                  <td className="px-2 py-1.5 border border-gray-200 text-right">{totalSGST > 0 ? formatINR(totalSGST) : '—'}</td>
                  <td className="px-2 py-1.5 border border-gray-200 text-right">{totalIGST > 0 ? formatINR(totalIGST) : '—'}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════════ */}
      {/* Section 6 — Invoice Reconciliation                                   */}
      {/* ══════════════════════════════════════════════════════════════════════ */}
      <div className="px-5 pb-5 pt-4 border-t border-gray-100">
        <h4 className="text-xs font-semibold text-emerald-700 uppercase tracking-wide mb-3 pb-1 border-b border-emerald-100">
          6. Invoice Reconciliation
        </h4>
        <div className="max-w-xs text-sm space-y-1.5">

          <div className="flex justify-between text-gray-700">
            <span>Line Item Taxable Value</span>
            <span className="font-medium tabular-nums">{formatINR(computedSubtotal)}</span>
          </div>

          {billDiscount > 0 && (
            <div className="flex justify-between text-orange-600">
              <span>(−) Bill Level Discount</span>
              <span className="font-medium tabular-nums">−{formatINR(billDiscount)}</span>
            </div>
          )}

          {chargesTotal > 0 && (
            <div className="flex justify-between text-blue-600">
              <span>(+) Additional Charges</span>
              <span className="font-medium tabular-nums">+{formatINR(chargesTotal)}</span>
            </div>
          )}

          <div className="border-t border-gray-300 pt-1.5 flex justify-between font-semibold text-gray-800">
            <span>Total Taxable Value</span>
            <span className="tabular-nums">{formatINR(taxableValue + chargesTotal)}</span>
          </div>

          {current.tax_type === 'cgst_sgst' ? (
            <>
              <div className="flex justify-between text-gray-600">
                <span>(+) CGST</span>
                <span className="tabular-nums">+{formatINR(totalCGST)}</span>
              </div>
              <div className="flex justify-between text-gray-600">
                <span>(+) SGST</span>
                <span className="tabular-nums">+{formatINR(totalSGST)}</span>
              </div>
            </>
          ) : (
            <div className="flex justify-between text-gray-600">
              <span>(+) IGST</span>
              <span className="tabular-nums">+{formatINR(totalIGST)}</span>
            </div>
          )}

          <div className="flex justify-between text-gray-600 items-center">
            <span>(+) Round Off</span>
            {editMode ? (
              <span className="flex items-center gap-1">
                <input
                  type="number"
                  step="0.01"
                  value={draft.round_off ?? 0}
                  onChange={(e) => {
                    setRoundOffAuto(false);
                    setHeader('round_off', parseFloat(e.target.value) || 0);
                  }}
                  className="w-20 border border-gray-300 bg-blue-50 rounded px-1.5 py-0.5 text-sm text-right focus:outline-none focus:ring-1 focus:ring-indigo-400"
                />
                <button
                  onClick={() => {
                    setRoundOffAuto(true);
                    setDraft((d) => ({ ...d, round_off: calcAutoRoundOff(d) }));
                  }}
                  title="Auto-calculate round off to nearest ₹1"
                  className={`text-xs px-1.5 py-0.5 rounded border transition-colors whitespace-nowrap ${
                    roundOffAuto
                      ? 'bg-indigo-100 text-indigo-700 border-indigo-300'
                      : 'bg-gray-100 text-gray-500 border-gray-300 hover:bg-gray-200'
                  }`}
                >
                  ↺ Auto
                </button>
              </span>
            ) : (
              <span className="tabular-nums">{formatINR(current.round_off ?? 0)}</span>
            )}
          </div>

          <div className={`border-t-2 pt-2 flex justify-between font-bold text-base ${isMismatched ? 'border-amber-400' : 'border-gray-400'}`}>
            <span className="text-gray-900">Final Invoice Value</span>
            <span className={`tabular-nums ${isMismatched ? 'text-amber-700' : 'text-gray-900'}`}>
              ₹{formatINR(computedTotal)}
            </span>
          </div>

          {invoiceTotal > 0 && !isMismatched && !editMode && (
            <div className="text-xs text-green-600 font-medium text-right">✓ Invoice Value Matched</div>
          )}
          {invoiceTotal > 0 && isMismatched && !editMode && (
            <div className="text-xs text-amber-600 text-right">
              Invoice shows ₹{formatINR(invoiceTotal)} · Diff: {computedTotal > invoiceTotal ? '+' : '−'}₹{formatINR(Math.abs(computedTotal - invoiceTotal))}
            </div>
          )}

        </div>
      </div>

      {/* ── Audit Log ── */}
      {auditLog.length > 0 && (
        <div className="px-5 py-3 border-t border-gray-100">
          <button
            onClick={() => setAuditOpen((v) => !v)}
            className="text-xs text-gray-500 hover:text-gray-700 font-medium flex items-center gap-1"
          >
            <svg className={`w-3.5 h-3.5 transition-transform ${auditOpen ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
            View Changes ({auditLog.length})
          </button>
          {auditOpen && (
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr className="bg-gray-50">
                    {['Field', 'Original', 'Updated', 'When'].map((h) => (
                      <th key={h} className="text-left px-2 py-1.5 text-gray-500 font-medium border border-gray-200">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {auditLog.map((e, i) => (
                    <tr key={i} className="hover:bg-gray-50">
                      <td className="px-2 py-1.5 border border-gray-200 font-medium text-gray-700">{e.field}</td>
                      <td className="px-2 py-1.5 border border-gray-200 text-red-600 line-through">{String(e.original)}</td>
                      <td className="px-2 py-1.5 border border-gray-200 text-green-700 font-medium">{String(e.updated)}</td>
                      <td className="px-2 py-1.5 border border-gray-200 text-gray-400">
                        {new Date(e.timestamp).toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'short' })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
