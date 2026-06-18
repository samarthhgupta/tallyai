'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { extractInvoices, tryRecoverBatch } from '@/lib/extract';
import { computeReadiness, createBatch, insertAcceptedInvoices, insertRejectedInvoices, type InvoiceToSave } from '@/lib/db';
import { learnVendorName } from '@/lib/suppliers';
import { findDuplicate, recordInvoice } from '@/lib/invoiceHistory';
import type { ExtractedInvoice, FileResult, ExtractionResponse, ChunkWarning } from '@/types/invoice';
import { InvoiceCard } from '@/components/InvoiceCard';
import { downloadBulkExcel } from '@/lib/exportExcel';
import AppLayout from '@/components/AppLayout';
import FYPeriodSelector from '@/components/FYPeriodSelector';
import { currentFY, invoiceFY } from '@/lib/fyPeriod';
import { useCompany } from '@/lib/companyContext';

// ─── Types ────────────────────────────────────────────────────────────────────

interface QueueItem {
  key: string;           // `${filename}:${idx}`
  inv: ExtractedInvoice;
  filename: string;
  readiness: 'ready' | 'warning' | 'critical';
  readinessFlags: string[];
  itcWarning: boolean;   // true if ITC concern present
  fyMismatch: boolean;   // true if invoice FY ≠ selected FY
}

interface ITCItem {
  key: string;
  inv: ExtractedInvoice;
  filename: string;
  itcRemark: string;
}

// ─── ReadinessBadge ───────────────────────────────────────────────────────────

function ReadinessBadge({ readiness, flags }: { readiness: QueueItem['readiness']; flags: string[] }) {
  const cfg = {
    ready:    { label: 'Ready',    cls: 'bg-green-100 text-green-700' },
    warning:  { label: 'Warning',  cls: 'bg-amber-100 text-amber-700' },
    critical: { label: 'Critical', cls: 'bg-red-100 text-red-700' },
  }[readiness];

  const [showFlags, setShowFlags] = useState(false);

  return (
    <span className="relative inline-flex items-center gap-1">
      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold ${cfg.cls}`}>
        {cfg.label}
      </span>
      {flags.length > 0 && (
        <button
          onClick={(e) => { e.stopPropagation(); setShowFlags((v) => !v); }}
          className="text-gray-400 dark:text-gray-500 hover:text-gray-600"
          title="Show details"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <circle cx="12" cy="12" r="10" strokeWidth="2" />
            <path strokeLinecap="round" strokeWidth="2" d="M12 8v4m0 4h.01" />
          </svg>
        </button>
      )}
      {showFlags && (
        <div className="absolute top-full left-0 mt-1 z-30 w-64 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
          <p className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-1.5">
            {readiness === 'critical' ? 'Must resolve before accepting:' : 'Warnings:'}
          </p>
          <ul className="space-y-1">
            {flags.map((f, i) => (
              <li key={i} className="text-xs text-gray-700 dark:text-gray-300 flex gap-1.5">
                <span className={readiness === 'critical' ? 'text-red-500' : 'text-amber-500'}>•</span>
                {f}
              </li>
            ))}
          </ul>
        </div>
      )}
    </span>
  );
}

// ─── ExtractionWarningBanner ──────────────────────────────────────────────────

interface ExtractionWarningState {
  type: 'partial' | 'recovered' | 'truncated';
  successCount: number;
  failureDetails: Array<{ pages: string; reason: string }>;
}

function ExtractionWarningBanner({
  warning,
  onDismiss,
}: {
  warning: ExtractionWarningState;
  onDismiss: () => void;
}) {
  const [expanded, setExpanded] = useState(false);

  const titles: Record<ExtractionWarningState['type'], string> = {
    partial: 'Partial extraction completed',
    recovered: 'Results recovered after connection failure',
    truncated: 'Extraction partially completed — output limit reached',
  };
  const descriptions: Record<ExtractionWarningState['type'], string> = {
    partial: `${warning.successCount} invoice${warning.successCount !== 1 ? 's' : ''} extracted successfully. Some sections could not be extracted.`,
    recovered: `${warning.successCount} invoice${warning.successCount !== 1 ? 's' : ''} recovered from the server after the connection was interrupted. Some invoices may be missing.`,
    truncated: `${warning.successCount} invoice${warning.successCount !== 1 ? 's' : ''} extracted. Claude reached its output limit — the last section of the document may be incomplete.`,
  };
  const actions: Record<ExtractionWarningState['type'], string> = {
    partial: 'Review the extracted invoices now. Re-upload the file to retry missing sections.',
    recovered: 'Review the recovered invoices below. Re-upload the original file to extract any missing invoices.',
    truncated: 'Review the extracted invoices. Re-upload this file to attempt the remaining invoices.',
  };

  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/40 p-4 mb-4">
      <div className="flex gap-3">
        <span className="text-amber-500 text-lg shrink-0 mt-0.5">⚠</span>
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-amber-800 dark:text-amber-200 text-sm">
            {titles[warning.type]}
          </p>
          <p className="text-sm text-amber-700 dark:text-amber-300 mt-1">
            {descriptions[warning.type]}
          </p>
          <p className="text-sm text-amber-700 dark:text-amber-300 mt-0.5">
            {actions[warning.type]}
          </p>
          {warning.failureDetails.length > 0 && (
            <button
              className="mt-2 text-xs text-amber-600 dark:text-amber-400 underline hover:no-underline"
              onClick={() => setExpanded((x) => !x)}
            >
              {expanded ? 'Hide details ▲' : 'Why did this happen? ▼'}
            </button>
          )}
          {expanded && (
            <ul className="mt-2 space-y-1">
              {warning.failureDetails.map((d, i) => (
                <li key={i} className="text-xs text-amber-700 dark:text-amber-300 bg-amber-100 dark:bg-amber-900/50 rounded px-2 py-1">
                  <span className="font-medium">Pages {d.pages}:</span> {d.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
        <button
          className="shrink-0 text-amber-400 hover:text-amber-600 dark:hover:text-amber-200 text-xl leading-none"
          onClick={onDismiss}
          title="Dismiss"
        >
          ×
        </button>
      </div>
    </div>
  );
}

// ─── RecoveryOfferBanner ──────────────────────────────────────────────────────

function RecoveryOfferBanner({
  offer,
  onRecover,
  onDiscard,
}: {
  offer: ExtractionResponse;
  onRecover: () => void;
  onDiscard: () => void;
}) {
  const fileNames = offer.file_results.map((fr) => fr.filename).join(', ');
  return (
    <div className="rounded-lg border border-blue-300 bg-blue-50 dark:bg-blue-950/40 p-4 mb-6">
      <div className="flex gap-3">
        <span className="text-blue-500 text-lg shrink-0 mt-0.5">↺</span>
        <div className="flex-1">
          <p className="font-semibold text-blue-800 dark:text-blue-200 text-sm">
            Previous extraction available
          </p>
          <p className="text-sm text-blue-700 dark:text-blue-300 mt-1">
            {offer.total_invoices} invoice{offer.total_invoices !== 1 ? 's' : ''} were extracted
            in a previous session that did not complete. You can recover them now.
          </p>
          <p className="text-xs text-blue-500 dark:text-blue-400 mt-1 truncate" title={fileNames}>
            {fileNames}
          </p>
          <div className="flex gap-2 mt-3">
            <button
              className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600"
              onClick={onRecover}
            >
              Recover {offer.total_invoices} invoice{offer.total_invoices !== 1 ? 's' : ''}
            </button>
            <button
              className="px-3 py-1.5 text-sm border border-blue-300 text-blue-700 dark:text-blue-400 rounded-md hover:bg-blue-100 dark:hover:bg-blue-900/30"
              onClick={onDiscard}
            >
              Discard and start fresh
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── ITC Warning Popup ────────────────────────────────────────────────────────

interface ITCPopupProps {
  items: ITCItem[];
  onProceed: (keys: string[]) => void;
  onReview: () => void;
}

function ITCWarningPopup({ items, onProceed, onReview }: ITCPopupProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-xl max-w-lg w-full mx-4 p-6">
        <div className="flex items-start gap-3 mb-4">
          <div className="w-9 h-9 rounded-full bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center shrink-0 mt-0.5">
            <svg className="w-5 h-5 text-amber-600 dark:text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
            </svg>
          </div>
          <div>
            <h3 className="font-semibold text-gray-900 dark:text-gray-100">ITC Eligibility Warning</h3>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
              {items.length === 1
                ? 'This invoice contains GST but may not be eligible for Input Tax Credit.'
                : `${items.length} invoices contain GST but may not be eligible for Input Tax Credit.`}
            </p>
          </div>
        </div>

        <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg p-3 mb-5 space-y-2 max-h-48 overflow-y-auto">
          {items.map((item) => (
            <div key={item.key} className="text-xs">
              <span className="font-medium text-gray-800 dark:text-gray-200">{item.inv.invoice_number || '(no number)'}</span>
              <span className="text-gray-500 dark:text-gray-400 mx-1">·</span>
              <span className="text-gray-600 dark:text-gray-400">{item.inv.vendor_name}</span>
              <div className="text-amber-700 dark:text-amber-400 mt-0.5">{item.itcRemark}</div>
            </div>
          ))}
        </div>

        <p className="text-sm text-gray-600 dark:text-gray-400 mb-5">
          You can still accept and book these invoices. ITC status will be marked as
          <strong className="text-amber-700 dark:text-amber-400"> Potentially Ineligible</strong> in the Purchase Register.
        </p>

        <div className="flex flex-col gap-2">
          <button
            onClick={() => onProceed(items.map((i) => i.key))}
            className="w-full px-4 py-2.5 bg-amber-500 hover:bg-amber-600 text-white text-sm font-semibold rounded-lg transition-colors"
          >
            Proceed - Book with GST (ITC marked as Potentially Ineligible)
          </button>
          <button
            onClick={onReview}
            className="w-full px-4 py-2.5 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 text-sm font-medium rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
          >
            Cancel - Review invoices first
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Reject Reason Popup ─────────────────────────────────────────────────────

interface RejectPopupProps {
  count: number;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}

function RejectPopup({ count, onConfirm, onCancel }: RejectPopupProps) {
  const [reason, setReason] = useState('');
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-xl max-w-md w-full mx-4 p-6">
        <h3 className="font-semibold text-gray-900 dark:text-gray-100 mb-1">
          Reject {count} invoice{count !== 1 ? 's' : ''}?
        </h3>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
          Rejected invoices will not enter the Purchase Register. A record will be kept for audit purposes.
        </p>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Reason for rejection (optional)"
          rows={3}
          className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm dark:bg-gray-700 dark:text-gray-100 dark:placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-red-400 resize-none mb-4"
        />
        <div className="flex gap-2">
          <button
            onClick={() => onConfirm(reason.trim())}
            className="flex-1 px-4 py-2.5 bg-red-500 hover:bg-red-600 text-white text-sm font-semibold rounded-lg transition-colors"
          >
            Reject {count} Invoice{count !== 1 ? 's' : ''}
          </button>
          <button
            onClick={onCancel}
            className="flex-1 px-4 py-2.5 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 text-sm font-medium rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main ──────────────────────────────────────────────────────────────────────

export default function UploadPage() {
  const router = useRouter();
  const { company, loading: companyLoading } = useCompany();
  const [financialYear, setFinancialYear] = useState<string>(currentFY);

  // Auth state
  const [isAuthed, setIsAuthed] = useState(false);

  // File + extraction state
  const [files, setFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [extractError, setExtractError] = useState('');
  const [result, setResult] = useState<ExtractionResponse | null>(null);
  const [fileUrls, setFileUrls] = useState<Record<string, string>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Upload Queue state
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [invoiceOverrides, setInvoiceOverrides] = useState<Map<string, ExtractedInvoice>>(new Map());
  const [batchId, setBatchId] = useState<string | null>(null);
  const [queueRestored, setQueueRestored] = useState(false);

  // Action state
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState('');

  // Popups
  const [itcPopup, setItcPopup] = useState<ITCItem[] | null>(null);
  const [rejectPopup, setRejectPopup] = useState<string[] | null>(null); // keys to reject

  // Extraction warning (partial success / truncation / recovery)
  const [extractionWarning, setExtractionWarning] = useState<ExtractionWarningState | null>(null);
  // Recovery offer from previous interrupted session
  const [recoveryOffer, setRecoveryOffer] = useState<ExtractionResponse | null>(null);

  // ── Auth check ──
  useEffect(() => {
    if (companyLoading) return;
    getSession().then((session) => {
      if (!session) { router.replace('/login'); return; }
      if (!company) { router.replace('/select-company'); return; }
      setIsAuthed(true);
    });
  }, [company, companyLoading, router]);

  // ── Queue persistence (localStorage) ──
  const queueStorageKey = company?.id ? `upload_queue_${company.id}` : null;

  // Restore queue from localStorage once company is loaded
  useEffect(() => {
    if (!queueStorageKey || queueRestored) return;
    try {
      const raw = localStorage.getItem(queueStorageKey);
      if (raw) {
        const parsed = JSON.parse(raw) as {
          queue: QueueItem[];
          overrides: [string, ExtractedInvoice][];
          batchId: string | null;
          financialYear: string;
        };
        if (parsed.queue?.length) {
          setQueue(parsed.queue);
          setInvoiceOverrides(new Map(parsed.overrides ?? []));
          setBatchId(parsed.batchId ?? null);
          if (parsed.financialYear) setFinancialYear(parsed.financialYear);
        }
      }
    } catch { /* ignore corrupt storage */ }
    setQueueRestored(true);
  }, [queueStorageKey, queueRestored]);

  // Save queue to localStorage whenever it changes
  useEffect(() => {
    if (!queueStorageKey || !queueRestored) return;
    if (queue.length === 0) {
      localStorage.removeItem(queueStorageKey);
    } else {
      try {
        localStorage.setItem(queueStorageKey, JSON.stringify({
          queue,
          overrides: Array.from(invoiceOverrides.entries()),
          batchId,
          financialYear,
        }));
      } catch { /* ignore quota errors */ }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue, invoiceOverrides, batchId, financialYear, queueStorageKey, queueRestored]);

  // Check for an interrupted batch from a previous session (crash / Railway timeout)
  useEffect(() => {
    if (!isAuthed || !queueStorageKey || !queueRestored) return;
    if (queue.length > 0) return; // queue already restored — no recovery needed

    const pendingBatch = localStorage.getItem(`${queueStorageKey}_pending_batch`);
    if (!pendingBatch) return;

    tryRecoverBatch(pendingBatch).then((recovered) => {
      if (recovered && recovered.total_invoices > 0) {
        setRecoveryOffer(recovered);
      } else {
        localStorage.removeItem(`${queueStorageKey}_pending_batch`);
      }
    }).catch(() => {
      localStorage.removeItem(`${queueStorageKey}_pending_batch`);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthed, queueStorageKey, queueRestored]);

  const selectedCompany = company;
  const selectedCompanyId = company?.id ?? '';

  // ── File handling ──
  const ACCEPT = '.pdf,.jpg,.jpeg,.png,.doc,.docx';
  const MAX_FILE_SIZE_MB = 15;
  const isValidFile = (f: File) =>
    ['.pdf', '.jpg', '.jpeg', '.png', '.doc', '.docx'].some((e) => f.name.toLowerCase().endsWith(e));

  const addFiles = useCallback((incoming: FileList | File[]) => {
    const valid = Array.from(incoming).filter(isValidFile);
    if (!valid.length) return;
    const oversized = valid.filter((f) => f.size > MAX_FILE_SIZE_MB * 1024 * 1024);
    if (oversized.length > 0) {
      setExtractError(`File too large: ${oversized.map((f) => `${f.name} (${(f.size / 1048576).toFixed(1)} MB)`).join(', ')}. Maximum is ${MAX_FILE_SIZE_MB} MB per file. Split large PDFs into smaller parts before uploading.`);
      return;
    }
    setFiles((prev) => {
      const names = new Set(prev.map((f) => f.name));
      return [...prev, ...valid.filter((f) => !names.has(f.name))];
    });
    setExtractError('');
  }, [MAX_FILE_SIZE_MB]);

  const removeFile = (name: string) => setFiles((prev) => prev.filter((f) => f.name !== name));
  const handleDragOver = useCallback((e: React.DragEvent) => { e.preventDefault(); setDragging(true); }, []);
  const handleDragLeave = useCallback(() => setDragging(false), []);
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files);
  }, [addFiles]);
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) addFiles(e.target.files);
    e.target.value = '';
  };

  const formatBytes = (b: number) =>
    b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`;

  // ── Extraction helpers ──
  const categoriseError = useCallback((msg: string): string => {
    if (msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('network')) {
      return 'Connection lost during extraction. Claude may have already processed part of your document — try re-uploading to recover.';
    }
    if (msg.includes('504') || msg.includes('Gateway Timeout') || msg.includes('timeout')) {
      return 'Server timeout. The document took too long to process. Split the PDF into smaller parts (recommended: under 20 pages per file) and try again.';
    }
    if (msg.includes('500') || msg.includes('Internal Server')) {
      return 'Extraction server error. Try again. If the error persists with the same file, the PDF format may not be supported.';
    }
    if (msg.includes('Skipped') || msg.includes('blank') || msg.includes('no invoice content')) {
      return 'No invoice content detected in this file. Check that you uploaded the correct file.';
    }
    if (msg.includes('rate') || msg.includes('429')) {
      return 'Extraction service rate limit reached. Wait 30 seconds and try again.';
    }
    return `Extraction failed: ${msg.slice(0, 200)}. Please try again.`;
  }, []);

  const buildQueueItems = useCallback((data: ExtractionResponse): QueueItem[] => {
    const companyGstin = selectedCompany && 'gstin' in selectedCompany ? selectedCompany.gstin : null;
    const companyName = selectedCompany?.name ?? null;
    const items: QueueItem[] = [];
    data.file_results.forEach((fr) => {
      fr.invoices.forEach((inv, idx) => {
        const r = computeReadiness(inv, companyGstin, companyName);
        const invFY = invoiceFY(inv.invoice_date ?? '');
        items.push({
          key: `${fr.filename}:${idx}`,
          inv,
          filename: fr.filename,
          readiness: r.readiness,
          readinessFlags: r.flags,
          itcWarning: r.itcStatus === 'potentially_ineligible',
          fyMismatch: !!invFY && invFY !== financialYear,
        });
      });
    });
    return items;
  }, [selectedCompany, financialYear]);

  // ── Extraction ──
  const handleExtract = async () => {
    if (!files.length) return;

    const oversized = files.filter((f) => f.size > MAX_FILE_SIZE_MB * 1024 * 1024);
    if (oversized.length > 0) {
      setExtractError(`File too large: ${oversized.map((f) => `${f.name} (${(f.size / 1048576).toFixed(1)} MB)`).join(', ')}. Maximum size is ${MAX_FILE_SIZE_MB} MB per file. Split the PDF into smaller parts and upload separately.`);
      return;
    }

    // Generate batch_id BEFORE the request so we can query Supabase for recovery
    // if the response never arrives (Railway timeout, network drop, browser crash).
    const newBatchId = crypto.randomUUID();
    setBatchId(newBatchId);
    if (queueStorageKey) {
      localStorage.setItem(`${queueStorageKey}_pending_batch`, newBatchId);
    }

    setExtracting(true);
    setExtractError('');
    setExtractionWarning(null);
    setRecoveryOffer(null);
    setResult(null);
    setQueue([]);
    setSelected(new Set());
    setInvoiceOverrides(new Map());
    setActionError('');

    const urls: Record<string, string> = {};
    files.forEach((f) => { urls[f.name] = URL.createObjectURL(f); });
    setFileUrls(urls);

    try {
      const data = await extractInvoices(files, newBatchId);

      // Record to localStorage history (duplicate detection across sessions)
      data.file_results.forEach((fr) => {
        fr.invoices.forEach((inv) => {
          if (inv.invoice_number && !inv.duplicate_of) {
            recordInvoice(inv.invoice_number, inv.vendor_name, inv.invoice_date, inv.total);
          }
        });
      });

      setQueue(buildQueueItems(data));
      setResult(data);

      // Show partial-success warning if any chunk failed or was truncated
      const anyIncomplete = data.file_results.some((fr) => fr.extraction_complete === false);
      if (anyIncomplete) {
        const allWarnings = data.file_results.flatMap((fr) => fr.warnings ?? []);
        const failures = allWarnings.filter((w) => !w.reason.startsWith('recovered') && w.invoices_recovered === 0);
        const truncations = allWarnings.filter((w) => w.reason.startsWith('max_tokens'));
        if (failures.length > 0 || truncations.length > 0) {
          setExtractionWarning({
            type: truncations.length > 0 ? 'truncated' : 'partial',
            successCount: data.total_invoices,
            failureDetails: [...failures, ...truncations].map((w) => ({ pages: w.pages, reason: w.reason })),
          });
        }
      }

      if (queueStorageKey) localStorage.removeItem(`${queueStorageKey}_pending_batch`);

    } catch (err: unknown) {
      // HTTP request failed — attempt Supabase recovery before showing error
      const recovered = await tryRecoverBatch(newBatchId).catch(() => null);
      if (recovered && recovered.total_invoices > 0) {
        setQueue(buildQueueItems(recovered));
        setResult(recovered);
        setExtractionWarning({
          type: 'recovered',
          successCount: recovered.total_invoices,
          failureDetails: [],
        });
        if (queueStorageKey) localStorage.removeItem(`${queueStorageKey}_pending_batch`);
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        setExtractError(categoriseError(msg));
      }
    } finally {
      setExtracting(false);
    }
  };

  // ── Revalidate FY mismatch when selected FY changes ──
  useEffect(() => {
    if (!queue.length) return;
    setQueue((prev) =>
      prev.map((q) => {
        const inv = invoiceOverrides.get(q.key) ?? q.inv;
        const invFY = invoiceFY(inv.invoice_date ?? '');
        return { ...q, fyMismatch: !!invFY && invFY !== financialYear };
      })
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [financialYear]);

  // ── Selection ──
  const selectableKeys = queue.filter((q) => q.readiness !== 'critical' && !q.fyMismatch).map((q) => q.key);

  const toggleSelect = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  };

  const allSelected = selectableKeys.length > 0 && selectableKeys.every((k) => selected.has(k));
  const someSelected = selectableKeys.some((k) => selected.has(k));

  const toggleSelectAll = () => {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(selectableKeys));
    }
  };

  const selectedCount = Array.from(selected).filter((k) => queue.some((q) => q.key === k)).length;
  const selectedRejectCount = selectedCount; // same set used for reject

  // ── Accept flow ──
  const handleAcceptSelected = async () => {
    if (!selected.size) return;

    // Check for ITC warnings among selected
    const itcItems: ITCItem[] = queue
      .filter((q) => selected.has(q.key) && q.itcWarning)
      .map((q) => ({
        key: q.key,
        inv: invoiceOverrides.get(q.key) ?? q.inv,
        filename: q.filename,
        itcRemark: computeReadiness(invoiceOverrides.get(q.key) ?? q.inv).itcRemark ?? 'ITC concern',
      }));

    if (itcItems.length > 0) {
      setItcPopup(itcItems);
      return;
    }

    await doAccept(Array.from(selected));
  };

  const doAccept = async (keys: string[], itcOverrides: Record<string, { status: string; remark: string }> = {}) => {
    setActionLoading(true);
    setActionError('');

    // Remove from queue immediately regardless of Supabase outcome
    const removeFromQueue = () => {
      setQueue((prev) => prev.filter((q) => !keys.includes(q.key)));
      setSelected((prev) => { const n = new Set(prev); keys.forEach((k) => n.delete(k)); return n; });
      setItcPopup(null);
    };

    if (!selectedCompanyId || !financialYear) {
      setActionError('No company or financial year selected.');
      setActionLoading(false);
      return;
    }

    // Backend enforcement: block any FY mismatch invoice from entering Purchase Register
    const mismatchedKeys = keys.filter((key) => {
      const q = queue.find((q) => q.key === key);
      if (!q) return false;
      const inv = invoiceOverrides.get(key) ?? q.inv;
      const invFY = invoiceFY(inv.invoice_date ?? '');
      return !!invFY && invFY !== financialYear;
    });
    if (mismatchedKeys.length > 0) {
      setActionError(`Cannot accept: ${mismatchedKeys.length} invoice(s) have Financial Year mismatches. Resolve them before accepting.`);
      setActionLoading(false);
      return;
    }

    try {
      // Create batch now if not yet created
      let activeBatchId = batchId;
      if (!activeBatchId) {
        activeBatchId = await createBatch(selectedCompanyId, files.length, financialYear);
        setBatchId(activeBatchId);
      }

      const items: InvoiceToSave[] = keys
        .map((key) => {
          const q = queue.find((q) => q.key === key);
          if (!q) return null;
          const inv = invoiceOverrides.get(key) ?? q.inv;
          const override = itcOverrides[key];
          return {
            inv,
            filename: q.filename,
            itcStatusOverride: override
              ? (override.status as 'eligible' | 'potentially_ineligible' | 'not_applicable')
              : undefined,
            itcRemarkOverride: override?.remark,
          } satisfies InvoiceToSave;
        })
        .filter(Boolean) as InvoiceToSave[];

      const companyGstin = selectedCompany && 'gstin' in selectedCompany ? selectedCompany.gstin : null;
      const companyName = selectedCompany?.name ?? null;

      // Auto-learn vendor names: update supplier master with name from invoice (fire-and-forget)
      items.forEach(({ inv }) => {
        if (inv.vendor_gstin && inv.vendor_name) {
          learnVendorName(selectedCompanyId, inv.vendor_gstin, inv.vendor_name).catch(() => {});
        }
      });

      await insertAcceptedInvoices(selectedCompanyId, activeBatchId, items, financialYear, companyGstin, companyName);
      removeFromQueue();
    } catch (err: unknown) {
      const msg = err instanceof Error
        ? err.message
        : (err as { message?: string })?.message ?? 'Failed to save to Purchase Register. Please try again.';
      setActionError(msg);
      // Do NOT remove from queue on failure - user can retry
    } finally {
      setActionLoading(false);
    }
  };

  const handleITCProceed = async (itcKeys: string[]) => {
    const itcOverrides: Record<string, { status: string; remark: string }> = {};
    itcKeys.forEach((key) => {
      const q = queue.find((q) => q.key === key);
      if (q) {
        const r = computeReadiness(invoiceOverrides.get(key) ?? q.inv);
        itcOverrides[key] = { status: 'potentially_ineligible', remark: r.itcRemark ?? '' };
      }
    });
    await doAccept(Array.from(selected), itcOverrides);
  };

  // ── Reject flow ──
  const handleRejectSelected = () => {
    if (!selected.size) return;
    setRejectPopup(Array.from(selected));
  };

  const doReject = async (keys: string[], reason: string) => {
    // Remove from queue immediately regardless of DB outcome
    const removeFromQueue = () => {
      setQueue((prev) => prev.filter((q) => !keys.includes(q.key)));
      setSelected(new Set());
      setRejectPopup(null);
    };

    if (!selectedCompanyId || !financialYear) {
      setActionError('No company or financial year selected.');
      return;
    }
    setActionLoading(true);
    setActionError('');
    try {
      let activeBatchId = batchId;
      if (!activeBatchId) {
        activeBatchId = await createBatch(selectedCompanyId, files.length, financialYear);
        setBatchId(activeBatchId);
      }

      const items: InvoiceToSave[] = keys
        .map((key) => {
          const q = queue.find((q) => q.key === key);
          if (!q) return null;
          return { inv: invoiceOverrides.get(key) ?? q.inv, filename: q.filename };
        })
        .filter(Boolean) as InvoiceToSave[];

      await insertRejectedInvoices(selectedCompanyId, activeBatchId, items, financialYear, reason || undefined);
      removeFromQueue();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'Failed to save rejection record.');
      // Do NOT remove from queue on failure - user can retry
    } finally {
      setActionLoading(false);
    }
  };

  // ─── Render ──────────────────────────────────────────────────────────────────

  return (
    <AppLayout>
      {/* ITC Warning Popup */}
      {itcPopup && (
        <ITCWarningPopup
          items={itcPopup}
          onProceed={handleITCProceed}
          onReview={() => setItcPopup(null)}
        />
      )}

      {/* Reject Reason Popup */}
      {rejectPopup && (
        <RejectPopup
          count={rejectPopup.length}
          onConfirm={(reason) => doReject(rejectPopup, reason)}
          onCancel={() => setRejectPopup(null)}
        />
      )}

      <main className="flex-1 px-6 py-8">
        <div className="max-w-5xl">

          {/* ── Upload Card ── */}
          <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm p-6 mb-8">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Upload Invoices</h2>
              <FYPeriodSelector value={financialYear} onChange={setFinancialYear} />
            </div>


            {/* Drop zone */}
            <div
              onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              className={`border-2 border-dashed rounded-lg p-10 text-center cursor-pointer transition-colors ${
                dragging ? 'border-indigo-400 bg-indigo-50 dark:bg-indigo-900/20' : 'border-gray-300 dark:border-gray-600 hover:border-indigo-400 hover:bg-gray-50 dark:hover:bg-gray-700'
              }`}
            >
              <input ref={fileInputRef} type="file" multiple accept={ACCEPT} onChange={handleFileChange} className="hidden" />
              <svg className="w-10 h-10 text-gray-300 dark:text-gray-600 mx-auto mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
              </svg>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                <span className="text-indigo-600 dark:text-indigo-400 font-medium">Drop invoices here or click to browse</span>
              </p>
              <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">PDF, JPG, PNG, DOC, DOCX · Multiple files · Multi-invoice files supported</p>
              <p className="text-xs font-medium text-amber-600 dark:text-amber-400 mt-1.5">⚠ Max 15 MB per file - split larger PDFs before uploading</p>
            </div>

            {/* File list */}
            {files.length > 0 && (
              <ul className="mt-3 space-y-1">
                {files.map((f) => (
                  <li key={f.name} className="flex items-center justify-between bg-gray-50 dark:bg-gray-700 rounded-md px-3 py-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <svg className="w-4 h-4 text-indigo-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                      </svg>
                      <span className="text-sm text-gray-700 dark:text-gray-300 truncate">{f.name}</span>
                      <span className="text-xs text-gray-400 dark:text-gray-500 shrink-0">{formatBytes(f.size)}</span>
                    </div>
                    <button onClick={(e) => { e.stopPropagation(); removeFile(f.name); }} className="ml-2 text-gray-400 dark:text-gray-500 hover:text-red-500 text-lg leading-none shrink-0">×</button>
                  </li>
                ))}
              </ul>
            )}

            {extracting && (
              <div className="mt-4">
                <div className="w-full h-1.5 bg-gray-200 dark:bg-gray-600 rounded-full overflow-hidden">
                  <div className="h-full bg-indigo-500 rounded-full animate-pulse w-full" />
                </div>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 text-center">Sending to Claude AI for extraction…</p>
              </div>
            )}

            {extractError && (
              <div className="mt-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md px-3 py-2 text-sm text-red-700 dark:text-red-400">{extractError}</div>
            )}

            {extractionWarning && (
              <div className="mt-3">
                <ExtractionWarningBanner
                  warning={extractionWarning}
                  onDismiss={() => setExtractionWarning(null)}
                />
              </div>
            )}

            <div className="mt-4">
              <button
                onClick={handleExtract}
                disabled={!files.length || extracting}
                className="px-6 py-2.5 bg-indigo-600 text-white text-sm font-medium rounded-md hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
              >
                {extracting ? (
                  <>
                    <svg className="animate-spin h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    Extracting…
                  </>
                ) : (
                  `Extract ${files.length > 0 ? `${files.length} file${files.length > 1 ? 's' : ''}` : 'All'}`
                )}
              </button>
            </div>
          </div>

          {/* ── Recovery Offer ── */}
          {recoveryOffer && !queue.length && (
            <RecoveryOfferBanner
              offer={recoveryOffer}
              onRecover={() => {
                setQueue(buildQueueItems(recoveryOffer));
                setResult(recoveryOffer);
                setExtractionWarning({
                  type: 'recovered',
                  successCount: recoveryOffer.total_invoices,
                  failureDetails: [],
                });
                setRecoveryOffer(null);
                if (queueStorageKey) localStorage.removeItem(`${queueStorageKey}_pending_batch`);
              }}
              onDiscard={() => {
                setRecoveryOffer(null);
                if (queueStorageKey) localStorage.removeItem(`${queueStorageKey}_pending_batch`);
              }}
            />
          )}

          {/* ── Upload Queue ── */}
          {queue.length > 0 && (
            <div>
              {/* Queue header + action bar */}
              <div className="sticky top-0 z-10 bg-gray-50 dark:bg-gray-900 pb-3 pt-1">
                <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl shadow-sm px-5 py-4">
                  <div className="flex items-center justify-between flex-wrap gap-3">
                    {/* Left: title + select-all */}
                    <div className="flex items-center gap-4">
                      <div>
                        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                          Upload Queue
                          <span className="ml-2 text-gray-400 dark:text-gray-500 font-normal">
                            {queue.length} invoice{queue.length !== 1 ? 's' : ''}
                            {selectedCompany ? ` · ${selectedCompany.name}` : ''}
                            {financialYear ? ` · ${financialYear}` : ''}
                          </span>
                        </h3>
                      </div>
                      <label className="flex items-center gap-2 cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={allSelected}
                          ref={(el) => { if (el) el.indeterminate = someSelected && !allSelected; }}
                          onChange={toggleSelectAll}
                          className="w-4 h-4 rounded border-gray-300 dark:border-gray-600 text-indigo-600 focus:ring-indigo-500"
                        />
                        <span className="text-sm text-gray-600 dark:text-gray-400">Select All</span>
                      </label>
                    </div>

                    {/* Right: action buttons */}
                    <div className="flex items-center gap-2 flex-wrap">
                      {actionError && (
                        <span className="text-xs font-medium text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md px-2 py-1 max-w-xs">{actionError}</span>
                      )}
                      <button
                        onClick={handleAcceptSelected}
                        disabled={selectedCount === 0 || actionLoading}
                        className="inline-flex items-center gap-1.5 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 text-white text-sm font-semibold rounded-lg transition-colors"
                      >
                        {actionLoading ? (
                          <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                          </svg>
                        ) : (
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                          </svg>
                        )}
                        Accept Selected ({selectedCount})
                      </button>
                      <button
                        onClick={handleRejectSelected}
                        disabled={selectedRejectCount === 0 || actionLoading}
                        className="inline-flex items-center gap-1.5 px-4 py-2 border border-red-300 dark:border-red-800 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-40 text-red-600 dark:text-red-400 text-sm font-semibold rounded-lg transition-colors"
                      >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                        Reject Selected ({selectedRejectCount})
                      </button>
                      <button
                        onClick={() => {
                          const fileResults = result
                            ? result.file_results.map((fr) => ({
                                ...fr,
                                invoices: fr.invoices.map((inv, idx) =>
                                  invoiceOverrides.get(`${fr.filename}:${idx}`) ?? inv
                                ),
                              }))
                            : (() => {
                                // Queue restored from localStorage - group by filename
                                const byFile = new Map<string, ExtractedInvoice[]>();
                                queue.forEach((q) => {
                                  const inv = invoiceOverrides.get(q.key) ?? q.inv;
                                  const list = byFile.get(q.filename) ?? [];
                                  list.push(inv);
                                  byFile.set(q.filename, list);
                                });
                                return Array.from(byFile.entries()).map(([filename, invoices]) => ({ filename, invoices, error: null }));
                              })();
                          downloadBulkExcel(fileResults);
                        }}
                        className="inline-flex items-center gap-1.5 px-4 py-2 bg-green-600 hover:bg-green-700 text-white text-sm font-medium rounded-lg transition-colors"
                      >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                        </svg>
                        Excel
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              {/* Invoice cards with checkboxes */}
              <div className="space-y-4">
                {queue.map((item) => {
                  const inv = invoiceOverrides.get(item.key) ?? item.inv;
                  const isSelected = selected.has(item.key);
                  const isCritical = item.readiness === 'critical';
                  const isFYMismatch = item.fyMismatch;
                  const historyMatch = findDuplicate(inv.invoice_number, inv.vendor_name);

                  return (
                    <div key={item.key} className={`flex gap-3 items-start ${isCritical || isFYMismatch ? 'opacity-80' : ''}`}>
                      {/* Checkbox / reject column */}
                      <div className="pt-4 pl-1 shrink-0 flex flex-col items-center gap-1">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          disabled={isCritical || isFYMismatch}
                          onChange={() => !isCritical && !isFYMismatch && toggleSelect(item.key)}
                          title={isFYMismatch ? 'Financial Year mismatch - change FY or correct invoice date' : isCritical ? 'Resolve critical issues before accepting' : undefined}
                          className="w-4 h-4 rounded border-gray-300 dark:border-gray-600 text-indigo-600 focus:ring-indigo-500 disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed"
                        />
                        <button
                          onClick={() => setRejectPopup([item.key])}
                          title="Reject this invoice"
                          className="mt-0.5 text-[10px] font-semibold text-red-500 dark:text-red-400 hover:text-red-700 hover:underline leading-tight"
                        >
                          Reject
                        </button>
                      </div>

                      {/* Card + readiness badge */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                          <ReadinessBadge readiness={item.readiness} flags={item.readinessFlags} />
                          {isFYMismatch && (() => {
                            const invFY = invoiceFY(inv.invoice_date ?? '');
                            return (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400 border border-red-200 dark:border-red-800">
                                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                                </svg>
                                Financial Year Mismatch - Invoice belongs to {invFY}, current selection is {financialYear}. Change FY or correct the invoice date.
                              </span>
                            );
                          })()}
                          {item.itcWarning && (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400">
                              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                              </svg>
                              ITC Risk
                            </span>
                          )}
                          {isCritical && !isFYMismatch && (
                            <span className="text-xs text-red-600 dark:text-red-400 font-medium">Edit required before accepting</span>
                          )}
                        </div>
                        <InvoiceCard
                          inv={inv}
                          sourceUrl={fileUrls[item.filename]}
                          company={selectedCompany ? { id: selectedCompany.id, name: selectedCompany.name, gstin: selectedCompany.gstin ?? '' } : undefined}
                          historyMatch={historyMatch}
                          isBatchNew={true}
                          onReject={() => doReject([item.key], 'Duplicate invoice')}
                          onSave={(updated) => {
                            setInvoiceOverrides((prev) => new Map(prev).set(item.key, updated));
                            // Recompute readiness + FY mismatch with updated invoice
                            const companyGstin = selectedCompany && 'gstin' in selectedCompany ? selectedCompany.gstin : null;
                            const r = computeReadiness(updated, companyGstin, selectedCompany?.name ?? null);
                            const invFY = invoiceFY(updated.invoice_date ?? '');
                            setQueue((prev) =>
                              prev.map((q) =>
                                q.key === item.key
                                  ? { ...q, readiness: r.readiness, readinessFlags: r.flags, itcWarning: r.itcStatus === 'potentially_ineligible', fyMismatch: !!invFY && invFY !== financialYear }
                                  : q
                              )
                            );
                          }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* File-level errors (skipped files etc.) */}
              {result?.file_results.some((fr) => fr.error) && (
                <div className="mt-6 space-y-2">
                  {result!.file_results
                    .filter((fr) => fr.error)
                    .map((fr) => {
                      const isSkipped = fr.error?.startsWith('Skipped');
                      return (
                        <div key={fr.filename} className={`rounded-lg px-4 py-3 text-sm flex items-start gap-2 ${isSkipped ? 'bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400' : 'bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400'}`}>
                          <span className="font-medium shrink-0">{fr.filename}:</span>
                          <span>{fr.error}</span>
                          {isSkipped && fileUrls[fr.filename] && (
                            <a href={fileUrls[fr.filename]} target="_blank" rel="noopener noreferrer" className="ml-auto text-indigo-600 dark:text-indigo-400 text-xs hover:underline shrink-0">
                              Open →
                            </a>
                          )}
                        </div>
                      );
                    })}
                </div>
              )}
            </div>
          )}

          {/* Empty queue (all actioned) */}
          {result && queue.length === 0 && (
            <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-10 text-center">
              <div className="w-12 h-12 bg-green-100 dark:bg-green-900/30 rounded-full flex items-center justify-center mx-auto mb-3">
                <svg className="w-6 h-6 text-green-600 dark:text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <p className="text-sm font-medium text-gray-900 dark:text-gray-100">All invoices have been actioned</p>
              <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">Accepted invoices are now in the Purchase Register.</p>
              <button
                onClick={() => router.push('/register')}
                className="mt-4 text-sm text-indigo-600 dark:text-indigo-400 hover:text-indigo-800 font-medium"
              >
                View Purchase Register →
              </button>
            </div>
          )}

        </div>
      </main>
    </AppLayout>
  );
}
