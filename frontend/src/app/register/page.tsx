'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import * as XLSX from 'xlsx';
import { getSession } from '@/lib/auth';
import { getPurchaseRegister, deleteInvoice, deleteAllCompanyInvoices, getRejectedRegister, updateAcceptedInvoice, rejectInvoices, restoreRejectedInvoice } from '@/lib/db';
import type { RejectedRecord } from '@/lib/db';
import type { StoredInvoice, ITCStatus } from '@/types/invoice';
import { formatINR, buildFullTaxSummary, calcLineAmount } from '@/types/invoice';
import { resolveChargeSac } from '@/lib/expenseLedgers';
import AppSidebar from '@/components/AppSidebar';
import { getFYList, currentFY } from '@/lib/fyPeriod';
import { useCompany } from '@/lib/companyContext';
import FYPeriodSelector from '@/components/FYPeriodSelector';
import InvoiceDetailPanel from '@/components/InvoiceDetailPanel';
import { getSupabase } from '@/lib/supabase';

// ─── Per-invoice computed financials (single source of truth) ────────────────
// Always derives from the full tax summary (line items + SAC charges) so values
// match exactly what InvoiceDetailPanel shows.
function computeInvoiceFinancials(inv: StoredInvoice) {
  const lineItems = inv.line_items ?? [];
  const charges = (inv.charges ?? []).map((c) => ({
    ...c,
    sac: resolveChargeSac(c.description ?? '', c.sac),
  }));
  const billDiscount = inv.bill_discount_amount ?? 0;
  const taxableChargesTotal = charges.filter((c) => c.gst_percent > 0).reduce((s, c) => s + c.amount, 0);
  const nonGstChargesTotal = charges.filter((c) => c.gst_percent === 0).reduce((s, c) => s + c.amount, 0);
  const subtotal = lineItems.reduce((s, it) => s + calcLineAmount(it), 0);
  const netTaxable = Math.round((subtotal - billDiscount + taxableChargesTotal) * 100) / 100;
  const fullTaxRows = buildFullTaxSummary(lineItems, charges, inv.tax_type, billDiscount);
  const cgst = Math.round(fullTaxRows.reduce((s, r) => s + r.cgst, 0) * 100) / 100;
  const sgst = Math.round(fullTaxRows.reduce((s, r) => s + r.sgst, 0) * 100) / 100;
  const igst = Math.round(fullTaxRows.reduce((s, r) => s + r.igst, 0) * 100) / 100;
  const roundOff = inv.round_off ?? 0;
  const total = Math.round((netTaxable + nonGstChargesTotal + cgst + sgst + igst + roundOff) * 100) / 100;
  return { netTaxable, cgst, sgst, igst, roundOff, total };
}

// ─── ITC review audit data stored in itc_remark as JSON ───────────────────────

interface ITCReviewAudit {
  original_remark: string;
  review_reason: string;
  reviewed_at: string;
  reviewed_by: string;
}

function parseReviewAudit(remark: string | null): ITCReviewAudit | null {
  if (!remark) return null;
  try {
    const p = JSON.parse(remark);
    if (p?.reviewed_at) return p as ITCReviewAudit;
  } catch { /* plain text remark - not a review audit */ }
  return null;
}

// ─── ITC Badge with popover ────────────────────────────────────────────────────

function ITCBadge({
  status,
  remark,
  onMarkEligible,
}: {
  status: ITCStatus | null;
  remark: string | null;
  onMarkEligible?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [popoverPos, setPopoverPos] = useState<{ top: number; left: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const handleOpen = () => {
    if (btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      setPopoverPos({ top: rect.bottom + 6, left: rect.left });
    }
    setOpen(v => !v);
  };

  if (!status || status === 'not_applicable') {
    return <span className="text-gray-300 text-xs">—</span>;
  }

  if (status === 'eligible') {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-green-700 font-medium">
        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
        </svg>
        Eligible
      </span>
    );
  }

  if (status === 'reviewed_eligible') {
    const audit = parseReviewAudit(remark);
    return (
      <div ref={ref}>
        <button
          ref={btnRef}
          onClick={handleOpen}
          className="inline-flex items-center gap-1 text-xs text-indigo-700 font-medium hover:text-indigo-900"
        >
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
          </svg>
          Reviewed
          <svg className="w-3 h-3 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <circle cx="12" cy="12" r="9" strokeWidth="2" />
            <path strokeLinecap="round" strokeWidth="2" d="M12 8v4m0 4h.01" />
          </svg>
        </button>
        {open && popoverPos && (
          <div
            className="fixed z-[200] w-64 bg-white border border-gray-200 rounded-xl shadow-xl p-3"
            style={{ top: popoverPos.top, left: popoverPos.left }}
          >
            <p className="text-xs font-semibold text-indigo-700 mb-1.5">✓ Reviewed & Approved</p>
            {audit ? (
              <div className="space-y-1 text-xs text-gray-600">
                {audit.original_remark && (
                  <p><span className="font-medium text-gray-500">Original risk:</span> {audit.original_remark}</p>
                )}
                {audit.review_reason && (
                  <p><span className="font-medium text-gray-500">Approved because:</span> {audit.review_reason}</p>
                )}
                <p className="text-gray-400 mt-1">
                  By {audit.reviewed_by}<br />
                  {new Date(audit.reviewed_at).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                </p>
              </div>
            ) : (
              <p className="text-xs text-gray-500">ITC claim approved by accountant.</p>
            )}
          </div>
        )}
      </div>
    );
  }

  // potentially_ineligible
  const displayRemark = remark && !parseReviewAudit(remark) ? remark : null;

  return (
    <div ref={ref}>
      <button
        ref={btnRef}
        onClick={handleOpen}
        className="inline-flex items-center gap-1 text-xs text-amber-700 font-medium hover:text-amber-900"
      >
        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
        </svg>
        At Risk
        <svg className="w-3 h-3 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <circle cx="12" cy="12" r="9" strokeWidth="2" />
          <path strokeLinecap="round" strokeWidth="2" d="M12 8v4m0 4h.01" />
        </svg>
      </button>
      {open && popoverPos && (
        <div
          className="fixed z-[200] w-64 bg-white border border-amber-200 rounded-xl shadow-xl p-3"
          style={{ top: popoverPos.top, left: popoverPos.left }}
        >
          <p className="text-xs font-semibold text-amber-700 mb-1.5">⚠ ITC Risk Reason</p>
          {displayRemark ? (
            <p className="text-xs text-gray-700 mb-2">{displayRemark}</p>
          ) : (
            <p className="text-xs text-gray-500 mb-2">Potential ITC eligibility concern. Verify with supplier filing status.</p>
          )}
          {onMarkEligible && (
            <button
              onClick={() => { setOpen(false); onMarkEligible(); }}
              className="w-full text-xs font-semibold text-indigo-600 border border-indigo-300 rounded-lg px-2 py-1.5 hover:bg-indigo-50 transition-colors"
            >
              Mark as ITC Eligible →
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── ITC Review Confirmation Modal ────────────────────────────────────────────

function ITCReviewModal({
  invoice,
  onConfirm,
  onCancel,
  loading,
}: {
  invoice: StoredInvoice;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
  loading: boolean;
}) {
  const [reason, setReason] = useState('');
  const originalRemark = invoice.itc_remark && !parseReviewAudit(invoice.itc_remark)
    ? invoice.itc_remark
    : 'Potentially ineligible for ITC';

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-2xl shadow-xl max-w-md w-full mx-4 p-6">
        <div className="flex items-start gap-3 mb-4">
          <div className="w-9 h-9 rounded-full bg-indigo-100 flex items-center justify-center shrink-0 mt-0.5">
            <svg className="w-5 h-5 text-indigo-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <div className="min-w-0">
            <h3 className="font-semibold text-gray-900">Override ITC Risk Flag</h3>
            <p className="text-sm text-gray-500 mt-0.5 truncate">
              {invoice.invoice_number || '—'} · {invoice.vendor_name}
            </p>
          </div>
        </div>

        <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2.5 mb-4">
          <p className="text-xs font-semibold text-amber-700 mb-0.5">Original Risk Reason</p>
          <p className="text-xs text-amber-800">{originalRemark}</p>
        </div>

        <label className="block text-xs font-medium text-gray-600 mb-1">
          Reason for Approval <span className="text-gray-400 font-normal">(optional)</span>
        </label>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          placeholder="e.g. Vendor confirmed filing · GSTIN verified manually · Management approval obtained"
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 resize-none mb-1"
        />
        <p className="text-xs text-gray-400 mb-4">This will be stored in the audit trail with your email and timestamp.</p>

        <div className="flex gap-2">
          <button
            onClick={() => onConfirm(reason.trim())}
            disabled={loading}
            className="flex-1 px-4 py-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-sm font-semibold rounded-lg transition-colors"
          >
            {loading ? 'Saving…' : 'Confirm — Mark as ITC Eligible'}
          </button>
          <button
            onClick={onCancel}
            disabled={loading}
            className="flex-1 px-4 py-2.5 border border-gray-300 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Summary cards ────────────────────────────────────────────────────────────

function SummaryCard({ label, value, sub, accent }: {
  label: string; value: string; sub?: string; accent?: 'green' | 'amber' | 'indigo';
}) {
  const accClasses = accent === 'green'
    ? 'border-green-200 bg-green-50/40'
    : accent === 'amber'
    ? 'border-amber-200 bg-amber-50/40'
    : accent === 'indigo'
    ? 'border-indigo-200 bg-indigo-50/40'
    : 'border-gray-200 bg-white';

  const valClasses = accent === 'green'
    ? 'text-green-700'
    : accent === 'amber'
    ? 'text-amber-700'
    : accent === 'indigo'
    ? 'text-indigo-700'
    : 'text-gray-900';

  return (
    <div className={`border rounded-xl px-4 py-3.5 ${accClasses}`}>
      <p className="text-xs text-gray-500 font-medium uppercase tracking-wide">{label}</p>
      <p className={`text-lg font-bold mt-0.5 ${valClasses}`}>{value}</p>
      {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
    </div>
  );
}

// ─── Date formatter ───────────────────────────────────────────────────────────

function fmtDate(dt: string | null | undefined): string {
  if (!dt) return '—';
  try {
    return new Date(dt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' });
  } catch { return dt; }
}

function fmtDateTime(dt: string | null | undefined): string {
  if (!dt) return '—';
  try {
    return new Date(dt).toLocaleString('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch { return dt; }
}

// ─── Main ──────────────────────────────────────────────────────────────────────

export default function PurchaseRegisterPage() {
  const router = useRouter();
  const { company, loading: companyLoading } = useCompany();

  const [selectedFY, setSelectedFY] = useState<string>(currentFY);
  const [selectedITC, setSelectedITC] = useState<ITCStatus | ''>('');
  const [currentUserEmail, setCurrentUserEmail] = useState<string>('');

  const [invoices, setInvoices] = useState<StoredInvoice[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  type SortKey = 'date' | 'total' | 'vendor' | 'taxable' | 'itc' | 'invoice_number' | 'cgst' | 'sgst' | 'igst' | 'round_off';
  const [sortKey, setSortKey] = useState<SortKey>('date');
  const [sortAsc, setSortAsc] = useState(false);

  function handleSort(key: SortKey) {
    if (sortKey === key) setSortAsc((a) => !a);
    else { setSortKey(key); setSortAsc(key === 'vendor' || key === 'invoice_number'); }
  }

  function exportToExcel() {
    const itcLabel: Record<string, string> = { eligible: 'Eligible', reviewed_eligible: 'Reviewed', potentially_ineligible: 'At Risk', not_applicable: 'N/A' };
    const rows = sortedInvoices.map((inv, idx) => {
      const f = financialsById.get(inv.id)!;
      return {
        '#': idx + 1,
        'Invoice #': inv.invoice_number ?? '',
        'Vendor': inv.vendor_name ?? '',
        'GSTIN': inv.vendor_gstin ?? '',
        'Date': inv.invoice_date ?? '',
        'Period': inv.period_month ?? '',
        'Taxable (Rs)': f.netTaxable,
        'CGST (Rs)': f.cgst,
        'SGST (Rs)': f.sgst,
        'IGST (Rs)': f.igst,
        'Round Off (Rs)': f.roundOff,
        'Total (Rs)': f.total,
        'ITC Status': itcLabel[inv.itc_status ?? ''] ?? '',
      };
    });

    const ws = XLSX.utils.json_to_sheet(rows);
    // Right-align numeric columns
    const numCols = ['G', 'H', 'I', 'J', 'K'];
    numCols.forEach((col) => {
      for (let r = 2; r <= rows.length + 1; r++) {
        const cell = ws[`${col}${r}`];
        if (cell) cell.z = '#,##0.00';
      }
    });
    ws['!cols'] = [
      { wch: 4 }, { wch: 18 }, { wch: 28 }, { wch: 18 }, { wch: 12 },
      { wch: 12 }, { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 12 },
    ];
    const wb = XLSX.utils.book_new();
    const sheetName = selectedFY ? `Register ${selectedFY}` : 'Purchase Register';
    XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31));
    const fileName = `Purchase_Register_${selectedCompany?.name ?? 'export'}_${selectedFY ?? ''}.xlsx`
      .replace(/[^a-zA-Z0-9_.-]/g, '_');
    XLSX.writeFile(wb, fileName);
  }

  // ── Totals — always derived from computeInvoiceFinancials (same as detail panel) ──
  // IMPORTANT: must be defined before sortedInvoices so the sort comparator can access financialsById
  const invoiceFinancials = invoices.map((inv) => ({ id: inv.id, ...computeInvoiceFinancials(inv) }));
  const financialsById = new Map(invoiceFinancials.map((f) => [f.id, f]));
  const totalTaxable = invoiceFinancials.reduce((s, f) => s + f.netTaxable, 0);
  const totalCGST = invoiceFinancials.reduce((s, f) => s + f.cgst, 0);
  const totalSGST = invoiceFinancials.reduce((s, f) => s + f.sgst, 0);
  const totalIGST = invoiceFinancials.reduce((s, f) => s + f.igst, 0);
  const totalGST = totalCGST + totalSGST + totalIGST;
  const totalRoundOff = invoiceFinancials.reduce((s, f) => s + f.roundOff, 0);
  const grandTotal = invoiceFinancials.reduce((s, f) => s + f.total, 0);

  const itcOrder: Record<string, number> = { eligible: 0, reviewed_eligible: 1, potentially_ineligible: 2, not_applicable: 3 };
  const sortedInvoices = [...invoices].sort((a, b) => {
    const fa = financialsById.get(a.id)!;
    const fb = financialsById.get(b.id)!;
    let cmp = 0;
    if (sortKey === 'date') cmp = (a.invoice_date ?? '').localeCompare(b.invoice_date ?? '');
    else if (sortKey === 'vendor') cmp = (a.vendor_name ?? '').localeCompare(b.vendor_name ?? '');
    else if (sortKey === 'invoice_number') cmp = (a.invoice_number ?? '').localeCompare(b.invoice_number ?? '');
    else if (sortKey === 'total') cmp = fa.total - fb.total;
    else if (sortKey === 'taxable') cmp = fa.netTaxable - fb.netTaxable;
    else if (sortKey === 'cgst') cmp = fa.cgst - fb.cgst;
    else if (sortKey === 'sgst') cmp = fa.sgst - fb.sgst;
    else if (sortKey === 'igst') cmp = fa.igst - fb.igst;
    else if (sortKey === 'round_off') cmp = fa.roundOff - fb.roundOff;
    else if (sortKey === 'itc') cmp = (itcOrder[a.itc_status ?? ''] ?? 9) - (itcOrder[b.itc_status ?? ''] ?? 9);
    return sortAsc ? cmp : -cmp;
  });

  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [showDeleteAll, setShowDeleteAll] = useState(false);
  const [deleteAllLoading, setDeleteAllLoading] = useState(false);
  const [deleteAllConfirmText, setDeleteAllConfirmText] = useState('');

  // Multi-select
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkActionLoading, setBulkActionLoading] = useState(false);
  const [showBulkRejectModal, setShowBulkRejectModal] = useState(false);
  const [bulkRejectReason, setBulkRejectReason] = useState('');

  // Detail panel
  const [detailInvoice, setDetailInvoice] = useState<StoredInvoice | null>(null);

  // ITC Review modal
  const [reviewTarget, setReviewTarget] = useState<StoredInvoice | null>(null);
  const [reviewing, setReviewing] = useState(false);

  // Voided invoices overlay
  const [showRejected, setShowRejected] = useState(false);
  const [rejectedRecords, setRejectedRecords] = useState<RejectedRecord[]>([]);
  const [loadingRejected, setLoadingRejected] = useState(false);

  // ── Auth check ──
  useEffect(() => {
    if (companyLoading) return;
    getSession().then(async (session) => {
      if (!session) { router.replace('/login'); return; }
      if (!company) { router.replace('/select-company'); return; }
      // Capture user email for audit trail
      const { data } = await getSupabase().auth.getUser();
      setCurrentUserEmail(data.user?.email ?? '');
    });
  }, [company, companyLoading, router]);

  // ── Fetch register ──
  const fetchRegister = useCallback(async () => {
    if (!company?.id) return;
    setLoading(true);
    setError('');
    try {
      const data = await getPurchaseRegister(company.id, {
        financialYear: selectedFY || undefined,
        itcStatus: selectedITC || undefined,
      });
      setInvoices(data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load register.');
    } finally {
      setLoading(false);
    }
  }, [company?.id, selectedFY, selectedITC]);

  useEffect(() => { fetchRegister(); }, [fetchRegister]);

  // ── Fetch rejected register ──
  const fetchRejected = useCallback(async () => {
    if (!company?.id) return;
    setLoadingRejected(true);
    try {
      const data = await getRejectedRegister(company.id, selectedFY || undefined);
      setRejectedRecords(data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load voided invoices.');
    } finally {
      setLoadingRejected(false);
    }
  }, [company?.id, selectedFY]);

  const handleShowRejected = () => { setShowRejected(true); fetchRejected(); };

  const handleRestoreRejected = async (rec: RejectedRecord) => {
    if (!confirm(`Restore "${rec.invoice_number || 'this invoice'}" from ${rec.vendor_name || 'unknown vendor'}?\n\nThis will move it back to the Purchase Register as Accepted. You can move it to Rejected again if needed.`)) return;
    try {
      await restoreRejectedInvoice(rec.invoice_id);
      setRejectedRecords((prev) => prev.filter((r) => r.id !== rec.id));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to restore invoice.');
    }
  };

  // ── ITC Review handler ──
  const handleConfirmReview = async (reason: string) => {
    if (!reviewTarget) return;
    setReviewing(true);
    try {
      const originalRemark = reviewTarget.itc_remark && !parseReviewAudit(reviewTarget.itc_remark)
        ? reviewTarget.itc_remark
        : 'Potentially ineligible for ITC';
      const audit: ITCReviewAudit = {
        original_remark: originalRemark,
        review_reason: reason,
        reviewed_at: new Date().toISOString(),
        reviewed_by: currentUserEmail || 'unknown',
      };
      await updateAcceptedInvoice(reviewTarget.id, {
        itc_status: 'reviewed_eligible',
        itc_remark: JSON.stringify(audit),
      });
      setInvoices(prev => prev.map(inv =>
        inv.id === reviewTarget.id
          ? { ...inv, itc_status: 'reviewed_eligible', itc_remark: JSON.stringify(audit) }
          : inv
      ));
      setReviewTarget(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to update ITC status.');
    } finally {
      setReviewing(false);
    }
  };

  const itcEligibleCount = invoices.filter(inv => inv.itc_status === 'eligible').length;
  const itcAtRiskCount = invoices.filter(inv => inv.itc_status === 'potentially_ineligible').length;
  const itcReviewedCount = invoices.filter(inv => inv.itc_status === 'reviewed_eligible').length;

  const selectedCompany = company;
  const selectedCompanyId = company?.id ?? '';

  // ── Delete handlers ──
  const handleDeleteInvoice = async (id: string, label: string) => {
    if (!confirm(`Delete invoice "${label}"?\n\nThis cannot be undone.`)) return;
    setDeletingId(id);
    try {
      await deleteInvoice(id);
      setInvoices((prev) => prev.filter((inv) => inv.id !== id));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to delete invoice.');
    } finally {
      setDeletingId(null);
    }
  };

  const handleDeleteAll = async () => {
    setDeleteAllLoading(true);
    try {
      const count = await deleteAllCompanyInvoices(selectedCompanyId);
      setInvoices([]);
      setShowDeleteAll(false);
      setDeleteAllConfirmText('');
      setError('');
      alert(`Deleted ${count} invoice${count !== 1 ? 's' : ''} for ${selectedCompany?.name}.`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to delete invoices.');
    } finally {
      setDeleteAllLoading(false);
    }
  };

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === sortedInvoices.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(sortedInvoices.map((i) => i.id)));
    }
  };

  const handleBulkDelete = async () => {
    const ids = Array.from(selectedIds);
    if (!confirm(`Delete ${ids.length} selected invoice${ids.length !== 1 ? 's' : ''}?\n\nThis cannot be undone.`)) return;
    setBulkActionLoading(true);
    try {
      await Promise.all(ids.map((id) => deleteInvoice(id)));
      setInvoices((prev) => prev.filter((inv) => !selectedIds.has(inv.id)));
      setSelectedIds(new Set());
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to delete invoices.');
    } finally {
      setBulkActionLoading(false);
    }
  };

  const handleBulkReject = async () => {
    const ids = Array.from(selectedIds);
    setBulkActionLoading(true);
    try {
      await rejectInvoices(ids, bulkRejectReason.trim() || undefined);
      setInvoices((prev) => prev.filter((inv) => !selectedIds.has(inv.id)));
      setSelectedIds(new Set());
      setShowBulkRejectModal(false);
      setBulkRejectReason('');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to void invoices.');
    } finally {
      setBulkActionLoading(false);
    }
  };

  const handleBulkExport = () => {
    const selected = sortedInvoices.filter((inv) => selectedIds.has(inv.id));
    const rows = selected.map((inv, idx) => {
      const f = computeInvoiceFinancials(inv);
      const itcLabel: Record<string, string> = { eligible: 'Eligible', reviewed_eligible: 'Reviewed', potentially_ineligible: 'At Risk', not_applicable: 'N/A' };
      return {
        '#': idx + 1, 'Invoice #': inv.invoice_number ?? '', Vendor: inv.vendor_name ?? '',
        GSTIN: inv.vendor_gstin ?? '', Date: inv.invoice_date ?? '', Period: inv.period_month ?? '',
        'Taxable (Rs)': f.netTaxable, 'CGST (Rs)': f.cgst, 'SGST (Rs)': f.sgst,
        'IGST (Rs)': f.igst, 'Round Off (Rs)': f.roundOff, 'Total (Rs)': f.total,
        'ITC Status': itcLabel[inv.itc_status ?? ''] ?? '',
      };
    });
    const ws = XLSX.utils.json_to_sheet(rows);
    ws['!cols'] = [{ wch: 4 }, { wch: 18 }, { wch: 28 }, { wch: 18 }, { wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 12 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Selection');
    XLSX.writeFile(wb, `Selected_Invoices_${selected.length}.xlsx`);
  };

  void getFYList;

  return (
    <div className="flex min-h-screen bg-gray-50">
      <AppSidebar />

      {/* ── Detail Panel ── */}
      {detailInvoice && (
        <InvoiceDetailPanel
          invoice={detailInvoice}
          onClose={() => setDetailInvoice(null)}
          onSaved={(updated) => {
            setInvoices((prev) => prev.map((i) => i.id === updated.id ? updated : i));
            setDetailInvoice(updated);
          }}
          onDeleted={() => {
            setInvoices((prev) => prev.filter((i) => i.id !== detailInvoice.id));
            setDetailInvoice(null);
          }}
          onMovedToRejected={() => {
            setInvoices((prev) => prev.filter((i) => i.id !== detailInvoice.id));
            setDetailInvoice(null);
          }}
        />
      )}

      {/* ── ITC Review Modal ── */}
      {reviewTarget && (
        <ITCReviewModal
          invoice={reviewTarget}
          onConfirm={handleConfirmReview}
          onCancel={() => setReviewTarget(null)}
          loading={reviewing}
        />
      )}

      {/* ── Voided Invoices Overlay ── */}
      {showRejected && (
        <div className="fixed inset-0 z-50 bg-white flex flex-col overflow-hidden">
          <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 shrink-0">
            <div>
              <h2 className="text-base font-semibold text-gray-900">Voided Invoices</h2>
              <p className="text-xs text-gray-500 mt-0.5">{selectedCompany?.name}{selectedFY ? ` · ${selectedFY}` : ''}</p>
            </div>
            <button onClick={() => setShowRejected(false)} className="text-gray-400 hover:text-gray-600">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          <div className="flex-1 overflow-auto px-6 py-5">
            {loadingRejected ? (
              <div className="flex justify-center py-16"><div className="animate-spin rounded-full h-7 w-7 border-b-2 border-indigo-600" /></div>
            ) : rejectedRecords.length === 0 ? (
              <div className="text-center py-16">
                <p className="text-sm font-medium text-gray-700">No voided invoices found</p>
                <p className="text-xs text-gray-400 mt-1">Invoices moved to rejected will appear here.</p>
              </div>
            ) : (
              <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 border-b border-gray-200">
                      <tr>
                        {['#','Invoice #','Vendor','GSTIN','Date','Period','Total','Reason','Voided On','Voided By',''].map(h => (
                          <th key={h} className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide whitespace-nowrap">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {rejectedRecords.map((rec, idx) => (
                        <tr key={rec.id} className="hover:bg-gray-50">
                          <td className="px-4 py-3 text-gray-400 text-xs">{idx + 1}</td>
                          <td className="px-4 py-3 font-medium text-gray-900 whitespace-nowrap">{rec.invoice_number || '—'}</td>
                          <td className="px-4 py-3 text-gray-700 max-w-[140px] truncate" title={rec.vendor_name ?? undefined}>{rec.vendor_name || '—'}</td>
                          <td className="px-4 py-3 font-mono text-gray-500 text-xs whitespace-nowrap">{rec.vendor_gstin || '—'}</td>
                          <td className="px-4 py-3 text-gray-600 text-xs whitespace-nowrap">{rec.invoice_date || '—'}</td>
                          <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">{rec.period_label || '—'}</td>
                          <td className="px-4 py-3 text-right tabular-nums font-semibold text-gray-900 whitespace-nowrap">{rec.total != null ? `₹${formatINR(rec.total)}` : '—'}</td>
                          <td className="px-4 py-3 text-gray-500 text-xs max-w-[140px] truncate" title={rec.rejection_reason ?? undefined}>{rec.rejection_reason || '—'}</td>
                          <td className="px-4 py-3 text-gray-600 text-xs whitespace-nowrap">{fmtDateTime(rec.rejected_at)}</td>
                          <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">{rec.moved_by_email || '—'}</td>
                          <td className="px-4 py-3">
                            <button onClick={() => handleRestoreRejected(rec)} className="text-xs text-indigo-600 hover:text-indigo-800 hover:underline whitespace-nowrap">
                              Restore
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Delete All Modal ── */}
      {showDeleteAll && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-2xl shadow-xl max-w-md w-full mx-4 p-6">
            <div className="flex items-start gap-3 mb-4">
              <div className="w-9 h-9 rounded-full bg-red-100 flex items-center justify-center shrink-0">
                <svg className="w-5 h-5 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </div>
              <div>
                <h3 className="font-semibold text-gray-900">Delete all data for {selectedCompany?.name}?</h3>
                <p className="text-sm text-gray-500 mt-1">
                  Permanently deletes <strong>all {invoices.length} invoices</strong>. Cannot be undone.
                </p>
              </div>
            </div>
            <p className="text-sm text-gray-600 mb-2">Type <strong>{selectedCompany?.name}</strong> to confirm:</p>
            <input
              type="text"
              value={deleteAllConfirmText}
              onChange={(e) => setDeleteAllConfirmText(e.target.value)}
              placeholder={selectedCompany?.name ?? ''}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-red-300 mb-3"
            />
            <div className="flex gap-2">
              <button
                onClick={handleDeleteAll}
                disabled={deleteAllLoading || deleteAllConfirmText.trim().toLowerCase() !== (selectedCompany?.name ?? '').toLowerCase()}
                className="flex-1 px-4 py-2.5 bg-red-600 hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-lg"
              >
                {deleteAllLoading ? 'Deleting…' : 'Yes, delete all'}
              </button>
              <button onClick={() => { setShowDeleteAll(false); setDeleteAllConfirmText(''); }}
                className="flex-1 px-4 py-2.5 border border-gray-300 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Bulk Reject Modal ── */}
      {showBulkRejectModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-2xl shadow-xl max-w-md w-full mx-4 p-6">
            <h3 className="font-semibold text-gray-900 mb-1">Void {selectedIds.size} invoice{selectedIds.size !== 1 ? 's' : ''}?</h3>
            <p className="text-sm text-gray-500 mb-4">They will be moved to Voided Invoices and removed from the register.</p>
            <label className="block text-xs font-medium text-gray-600 mb-1">Reason (optional)</label>
            <input
              type="text"
              value={bulkRejectReason}
              onChange={(e) => setBulkRejectReason(e.target.value)}
              placeholder="e.g. Duplicate, wrong vendor, etc."
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-amber-300 mb-4"
            />
            <div className="flex gap-2">
              <button
                onClick={handleBulkReject}
                disabled={bulkActionLoading}
                className="flex-1 px-4 py-2.5 bg-amber-600 hover:bg-amber-700 disabled:opacity-50 text-white text-sm font-semibold rounded-lg"
              >
                {bulkActionLoading ? 'Voiding…' : 'Void invoices'}
              </button>
              <button onClick={() => { setShowBulkRejectModal(false); setBulkRejectReason(''); }} className="flex-1 px-4 py-2.5 border border-gray-300 text-gray-700 text-sm font-semibold rounded-lg hover:bg-gray-50">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Main content ── */}
      <main className="ml-60 flex-1 px-6 py-8 min-w-0">

        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-semibold text-gray-900">Purchase Register</h1>
            <p className="text-sm text-gray-500 mt-0.5">All accepted invoices · source of truth for Tally export and GST returns</p>
          </div>
          <div className="flex items-center gap-2">
            {selectedCompanyId && invoices.length > 0 && (
              <button
                onClick={exportToExcel}
                className="inline-flex items-center gap-1.5 px-4 py-2 border border-gray-300 hover:bg-gray-50 text-gray-700 text-sm font-medium rounded-lg transition-colors"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                Export Excel
              </button>
            )}
            {selectedCompanyId && invoices.length > 0 && (
              <button
                onClick={() => { setShowDeleteAll(true); setDeleteAllConfirmText(''); }}
                className="inline-flex items-center gap-1.5 px-4 py-2 border border-red-300 hover:bg-red-50 text-red-600 text-sm font-medium rounded-lg transition-colors"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
                Delete All
              </button>
            )}
            <button
              onClick={() => router.push('/upload')}
              className="inline-flex items-center gap-1.5 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg transition-colors"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              Upload Invoices
            </button>
          </div>
        </div>

        {/* Bulk action bar */}
        {selectedIds.size > 0 && (
          <div className="flex items-center gap-3 mb-4 px-4 py-3 bg-indigo-50 border border-indigo-200 rounded-xl">
            <span className="text-sm font-medium text-indigo-800">{selectedIds.size} selected</span>
            <div className="flex items-center gap-2 ml-2">
              <button
                onClick={handleBulkExport}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white border border-gray-300 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                Export Excel
              </button>
              <button
                onClick={() => setShowBulkRejectModal(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white border border-amber-300 text-amber-700 text-sm font-medium rounded-lg hover:bg-amber-50"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8l1.036 7.255A2 2 0 008.028 17h7.944a2 2 0 001.992-1.745L19 8" />
                </svg>
                Void
              </button>
              <button
                onClick={handleBulkDelete}
                disabled={bulkActionLoading}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white border border-red-300 text-red-600 text-sm font-medium rounded-lg hover:bg-red-50 disabled:opacity-50"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
                {bulkActionLoading ? 'Deleting…' : 'Delete'}
              </button>
            </div>
            <button onClick={() => setSelectedIds(new Set())} className="ml-auto text-xs text-indigo-600 hover:text-indigo-800 font-medium">
              Clear selection
            </button>
          </div>
        )}

        {/* Filters */}
        <div className="bg-white border border-gray-200 rounded-xl px-5 py-3.5 mb-5 flex flex-wrap items-end gap-4">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Financial Year</label>
            <FYPeriodSelector value={selectedFY} onChange={setSelectedFY} />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">ITC Status</label>
            <select
              value={selectedITC}
              onChange={(e) => setSelectedITC(e.target.value as ITCStatus | '')}
              className="border border-gray-300 rounded-md px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              <option value="">All</option>
              <option value="eligible">✓ Eligible</option>
              <option value="potentially_ineligible">⚠ At Risk</option>
              <option value="reviewed_eligible">✓ Reviewed</option>
              <option value="not_applicable">Not Applicable</option>
            </select>
          </div>
          {selectedCompanyId && (
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">&nbsp;</label>
              <button
                onClick={handleShowRejected}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-gray-300 text-gray-600 text-sm font-medium rounded-md hover:bg-gray-50 transition-colors"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8l1.036 7.255A2 2 0 008.028 17h7.944a2 2 0 001.992-1.745L19 8" />
                </svg>
                Voided Invoices
              </button>
            </div>
          )}
          {selectedCompanyId && (
            <div className="ml-auto text-xs text-gray-400 self-end pb-1.5">
              {loading ? 'Loading…' : `${invoices.length} invoice${invoices.length !== 1 ? 's' : ''}`}
              {selectedCompany ? ` · ${selectedCompany.name}` : ''}
            </div>
          )}
        </div>

        {/* Summary cards */}
        {invoices.length > 0 && (
          <div className="grid grid-cols-6 gap-3 mb-5">
            <SummaryCard label="Taxable Value" value={`₹${formatINR(totalTaxable)}`} sub={`${invoices.length} invoices`} />
            <SummaryCard
              label="Total GST"
              value={`₹${formatINR(totalGST)}`}
              sub={totalIGST > 0 ? `IGST Rs.${formatINR(totalIGST)}` : `CGST Rs.${formatINR(totalCGST)} / SGST Rs.${formatINR(totalSGST)}`}
            />
            <SummaryCard label="Grand Total" value={`₹${formatINR(grandTotal)}`} />
            <SummaryCard
              label="ITC Eligible"
              value={String(itcEligibleCount)}
              sub={itcEligibleCount > 0 ? 'invoices' : 'none'}
              accent="green"
            />
            <SummaryCard
              label="ITC At Risk"
              value={String(itcAtRiskCount)}
              sub={itcAtRiskCount > 0 ? 'need review' : 'all clear'}
              accent={itcAtRiskCount > 0 ? 'amber' : undefined}
            />
            <SummaryCard
              label="ITC Reviewed"
              value={String(itcReviewedCount)}
              sub={itcReviewedCount > 0 ? 'approved' : 'none'}
              accent={itcReviewedCount > 0 ? 'indigo' : undefined}
            />
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700 mb-4">{error}</div>
        )}

        {/* No company */}
        {!selectedCompanyId && !loading && (
          <div className="bg-white border border-gray-200 rounded-xl p-12 text-center text-gray-400">
            <p className="text-sm">Select a company above to view the Purchase Register.</p>
          </div>
        )}

        {/* Loading */}
        {loading && (
          <div className="flex justify-center py-16">
            <div className="animate-spin rounded-full h-7 w-7 border-b-2 border-indigo-600" />
          </div>
        )}

        {/* Empty state */}
        {!loading && selectedCompanyId && invoices.length === 0 && (
          <div className="bg-white border border-gray-200 rounded-xl p-12 text-center">
            <div className="w-12 h-12 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-3">
              <svg className="w-6 h-6 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </div>
            <p className="text-sm font-medium text-gray-700">No accepted invoices found</p>
            <p className="text-xs text-gray-400 mt-1">
              {selectedITC ? 'Try changing the filters above.' : 'Upload and accept invoices to populate the register.'}
            </p>
            <button onClick={() => router.push('/upload')} className="mt-4 text-sm text-indigo-600 hover:text-indigo-800 font-medium">
              Go to Upload →
            </button>
          </div>
        )}

        {/* ── Register table ── */}
        {!loading && invoices.length > 0 && (
          <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="px-3 py-2.5 w-8">
                    <input
                      type="checkbox"
                      checked={selectedIds.size === sortedInvoices.length && sortedInvoices.length > 0}
                      ref={(el) => { if (el) el.indeterminate = selectedIds.size > 0 && selectedIds.size < sortedInvoices.length; }}
                      onChange={toggleSelectAll}
                      className="w-3.5 h-3.5 rounded border-gray-300 text-indigo-600 cursor-pointer"
                    />
                  </th>
                  <th className="text-left px-3 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide w-7">#</th>
                  {([
                    { key: 'invoice_number', label: 'Invoice #', align: 'left' },
                    { key: 'vendor', label: 'Vendor', align: 'left' },
                    { key: null, label: 'GSTIN', align: 'left' },
                    { key: 'date', label: 'Date', align: 'left' },
                    { key: null, label: 'Period', align: 'left' },
                    { key: 'taxable', label: 'Taxable', align: 'right' },
                    { key: 'cgst', label: 'CGST', align: 'right' },
                    { key: 'sgst', label: 'SGST', align: 'right' },
                    { key: 'igst', label: 'IGST', align: 'right' },
                    { key: 'round_off', label: 'Rnd Off', align: 'right' },
                    { key: 'total', label: 'Total', align: 'right' },
                    { key: 'itc', label: 'ITC', align: 'left' },
                  ] as { key: SortKey | null; label: string; align: string }[]).map(({ key, label, align }) => (
                    <th
                      key={label}
                      onClick={key ? () => handleSort(key) : undefined}
                      className={`px-3 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide ${align === 'right' ? 'text-right' : 'text-left'} ${key ? 'cursor-pointer select-none hover:text-gray-800' : ''}`}
                    >
                      <span className="inline-flex items-center gap-1">
                        {label}
                        {key && (
                          <span className="text-gray-300">
                            {sortKey === key ? (sortAsc ? '↑' : '↓') : '↕'}
                          </span>
                        )}
                      </span>
                    </th>
                  ))}
                  <th className="px-2 py-2.5 w-8" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {sortedInvoices.map((inv, idx) => {
                  const f = financialsById.get(inv.id)!;

                  return (
                    <tr key={inv.id} className={`hover:bg-gray-50 transition-colors ${selectedIds.has(inv.id) ? 'bg-indigo-50/50' : ''}`}>
                      <td className="px-3 py-2.5">
                        <input
                          type="checkbox"
                          checked={selectedIds.has(inv.id)}
                          onChange={() => toggleSelect(inv.id)}
                          onClick={(e) => e.stopPropagation()}
                          className="w-3.5 h-3.5 rounded border-gray-300 text-indigo-600 cursor-pointer"
                        />
                      </td>
                      <td className="px-3 py-2.5 text-gray-400 tabular-nums">{idx + 1}</td>
                      <td className="px-3 py-2.5 whitespace-nowrap">
                        <button
                          onClick={() => setDetailInvoice(inv)}
                          className="font-semibold text-indigo-600 hover:text-indigo-800 hover:underline text-left text-xs"
                        >
                          {inv.invoice_number || <span className="text-gray-400 italic">No #</span>}
                        </button>
                      </td>
                      <td className="px-3 py-2.5 text-gray-700 max-w-[150px] truncate" title={inv.vendor_name}>
                        {inv.vendor_name}
                      </td>
                      <td className="px-3 py-2.5 font-mono text-gray-500 whitespace-nowrap">
                        {inv.vendor_gstin || <span className="text-gray-300 text-xs">N/A</span>}
                      </td>
                      <td className="px-3 py-2.5 text-gray-600 whitespace-nowrap">
                        {fmtDate(inv.invoice_date)}
                      </td>
                      <td className="px-3 py-2.5 text-gray-500 whitespace-nowrap">
                        {inv.period_label || ''}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-gray-800 whitespace-nowrap">
                        {formatINR(f.netTaxable)}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-gray-600 whitespace-nowrap">
                        {f.cgst > 0 ? formatINR(f.cgst) : <span className="text-gray-300">0.00</span>}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-gray-600 whitespace-nowrap">
                        {f.sgst > 0 ? formatINR(f.sgst) : <span className="text-gray-300">0.00</span>}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-gray-600 whitespace-nowrap">
                        {f.igst > 0 ? formatINR(f.igst) : <span className="text-gray-300">0.00</span>}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-gray-500 whitespace-nowrap text-xs">
                        {f.roundOff !== 0 ? (f.roundOff > 0 ? '+' : '') + formatINR(f.roundOff) : <span className="text-gray-200">0.00</span>}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums font-semibold text-gray-900 whitespace-nowrap">
                        ₹{formatINR(f.total)}
                      </td>
                      <td className="px-3 py-2.5">
                        <ITCBadge
                          status={inv.itc_status}
                          remark={inv.itc_remark}
                          onMarkEligible={inv.itc_status === 'potentially_ineligible' ? () => setReviewTarget(inv) : undefined}
                        />
                      </td>
                      <td className="px-2 py-2.5">
                        <button
                          onClick={() => handleDeleteInvoice(inv.id, inv.invoice_number || inv.vendor_name)}
                          disabled={deletingId === inv.id}
                          title="Delete this invoice"
                          className="text-gray-300 hover:text-red-500 transition-colors disabled:opacity-40"
                        >
                          {deletingId === inv.id ? (
                            <svg className="animate-spin w-3.5 h-3.5" fill="none" viewBox="0 0 24 24">
                              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                            </svg>
                          ) : (
                            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                          )}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>

              {/* Totals footer */}
              <tfoot className="bg-gray-50 border-t-2 border-gray-200">
                <tr>
                  <td colSpan={7} className="px-3 py-2.5 text-xs font-semibold text-gray-600 uppercase tracking-wide">
                    Total - {invoices.length} invoice{invoices.length !== 1 ? 's' : ''}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums font-bold text-gray-900 whitespace-nowrap">{formatINR(totalTaxable)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums font-bold text-gray-900 whitespace-nowrap">
                    {totalCGST > 0 ? formatINR(totalCGST) : '0.00'}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums font-bold text-gray-900 whitespace-nowrap">
                    {totalSGST > 0 ? formatINR(totalSGST) : '0.00'}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums font-bold text-gray-900 whitespace-nowrap">
                    {totalIGST > 0 ? formatINR(totalIGST) : '0.00'}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums font-bold text-gray-900 whitespace-nowrap text-xs">
                    {totalRoundOff !== 0 ? (totalRoundOff > 0 ? '+' : '') + formatINR(totalRoundOff) : '0.00'}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums font-bold text-gray-900 whitespace-nowrap">₹{formatINR(grandTotal)}</td>
                  <td className="px-3 py-2.5" />
                  <td className="px-2 py-2.5" />
                </tr>
              </tfoot>
            </table>
          </div>
        )}

      </main>
    </div>
  );
}
