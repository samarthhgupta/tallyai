import { getSupabase } from './supabase';
import type {
  ExtractedInvoice,
  FileResult,
  StoredInvoice,
  InvoiceReadiness,
  ITCStatus,
} from '@/types/invoice';
import type { FYPeriod } from '@/lib/fyPeriod';

export interface Company {
  id: string;
  name: string;
  gstin: string | null;
  tally_url: string | null;
  tally_port: number;
  state_code: string | null;
}

// ─── Companies ────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => getSupabase() as any;

export async function getMyCompanies(): Promise<Company[]> {
  const { data, error } = await db()
    .from('companies')
    .select('id, name, gstin, tally_url, tally_port, state_code')
    .order('name');
  if (error) throw error;
  return (data ?? []) as Company[];
}

export async function createCompany(params: {
  name: string;
  gstin?: string;
  tally_url?: string;
  tally_port?: number;
}): Promise<Company> {
  const user = (await getSupabase().auth.getUser()).data.user;
  const stateCode = params.gstin?.slice(0, 2) ?? null;
  const { data, error } = await db()
    .from('companies')
    .insert({ ...params, state_code: stateCode, created_by: user?.id })
    .select()
    .single();
  if (error) throw error;
  return data as Company;
}

// ─── Save extraction results ──────────────────────────────────────────────────

export async function saveBatch(
  companyId: string,
  fileResults: FileResult[],
): Promise<string> {
  const user = (await getSupabase().auth.getUser()).data.user;
  const totalInvoices = fileResults.reduce((s, fr) => s + fr.invoices.length, 0);

  // Create batch
  const { data: batch, error: batchErr } = await db()
    .from('invoice_batches')
    .insert({
      company_id: companyId,
      uploaded_by: user?.id,
      file_count: fileResults.length,
      invoice_count: totalInvoices,
    })
    .select('id')
    .single();
  if (batchErr) throw batchErr;

  // Insert all invoices
  const rows = fileResults.flatMap((fr) =>
    fr.invoices.map((inv: ExtractedInvoice) => ({
      batch_id: batch.id,
      company_id: companyId,
      filename: fr.filename,
      vendor_name: inv.vendor_name,
      invoice_number: inv.invoice_number,
      invoice_date: inv.invoice_date || null,
      vendor_gstin: inv.vendor_gstin,
      vendor_address: inv.vendor_address,
      subtotal: inv.subtotal,
      bill_discount_amount: inv.bill_discount_amount ?? 0,
      bill_discount_percent: inv.bill_discount_percent ?? null,
      cgst: inv.cgst,
      sgst: inv.sgst,
      igst: inv.igst,
      round_off: inv.round_off,
      total: inv.total,
      tax_type: inv.tax_type,
      confidence: inv.confidence,
      needs_review: inv.total > 0 && Math.abs(
        (inv.line_items ?? []).reduce((s, it) => s + it.qty * it.rate * (1 - it.disc_percent / 100), 0)
        - (inv.bill_discount_amount ?? 0)
        + inv.cgst + inv.sgst + inv.igst
        + (inv.round_off ?? 0)
        - inv.total
      ) > 1,
      bill_discount_auto_detected: inv.bill_discount_auto_detected ?? false,
      line_items: inv.line_items,
    }))
  );

  if (rows.length > 0) {
    const { error: invErr } = await db().from('invoices').insert(rows);
    if (invErr) throw invErr;
  }

  return batch.id;
}

// ─── Readiness computation ────────────────────────────────────────────────────
// Runs client-side on extracted invoice data before/after save.
// Returns { readiness, flags, itcStatus, itcRemark }.

export interface ReadinessResult {
  readiness: InvoiceReadiness;
  flags: string[];
  itcStatus: ITCStatus | null;
  itcRemark: string | null;
}

export function computeReadiness(
  inv: ExtractedInvoice,
  companyGstin?: string | null,
  companyName?: string | null,
): ReadinessResult {
  const flags: string[] = [];
  let readiness: InvoiceReadiness = 'ready';
  let itcStatus: ITCStatus | null = null;
  let itcRemark: string | null = null;

  // ── Critical failures — must be resolved before accepting ──
  if (!inv.invoice_number?.trim()) {
    flags.push('Invoice number missing');
    readiness = 'critical';
  }
  if (!inv.vendor_name?.trim()) {
    flags.push('Vendor name missing');
    readiness = 'critical';
  }
  if (!inv.invoice_date?.trim()) {
    flags.push('Invoice date missing');
    readiness = 'critical';
  }
  if (!inv.line_items?.length && inv.total > 0) {
    flags.push('No line items extracted');
    readiness = 'critical';
  }

  // ── Warnings — informational, never block acceptance ──
  if (readiness !== 'critical') {
    if (inv.confidence < 0.70) {
      flags.push(`Low confidence (${Math.round(inv.confidence * 100)}%)`);
      if (readiness === 'ready') readiness = 'warning';
    }

    if (!inv.vendor_gstin) {
      flags.push('Missing vendor GSTIN');
      if (readiness === 'ready') readiness = 'warning';
    }

    const hasGST = inv.cgst > 0 || inv.sgst > 0 || inv.igst > 0;

    if (hasGST) {
      const buyerGstinMissing = !inv.buyer_gstin?.trim();
      const buyerNameMismatch = companyName
        ? !inv.buyer_name?.toLowerCase().includes(companyName.toLowerCase().slice(0, 5))
        : false;
      const companyGstinMissing = !companyGstin;

      if (buyerGstinMissing && companyGstinMissing) {
        // Scenario C: GST charged, recipient GSTIN absent
        itcStatus = 'potentially_ineligible';
        itcRemark = 'Recipient GSTIN Missing';
        flags.push('ITC risk: Recipient GSTIN missing');
        if (readiness === 'ready') readiness = 'warning';
      } else if (buyerGstinMissing || buyerNameMismatch) {
        // Scenario D: GST charged, recipient name/GSTIN doesn't match company
        itcStatus = 'potentially_ineligible';
        itcRemark = 'Recipient Name/GSTIN Mismatch';
        flags.push('ITC risk: Recipient name or GSTIN mismatch');
        if (readiness === 'ready') readiness = 'warning';
      } else {
        itcStatus = 'eligible';
      }
    } else {
      // No GST — no ITC concern
      itcStatus = 'not_applicable';
    }

    // Missing HSN on any line item
    const missingHsn = (inv.line_items ?? []).some(
      (it) => !it.hsn?.replace(/[\s.]/g, ''),
    );
    if (missingHsn) {
      flags.push('One or more line items missing HSN/SAC');
      if (readiness === 'ready') readiness = 'warning';
    }
  }

  return { readiness, flags, itcStatus, itcRemark };
}

// ─── Save batch (updated to include period + readiness) ──────────────────────

export async function saveBatchWithPeriod(
  companyId: string,
  fileResults: FileResult[],
  period: FYPeriod,
  companyGstin?: string | null,
  companyName?: string | null,
): Promise<string> {
  const user = (await getSupabase().auth.getUser()).data.user;
  const totalInvoices = fileResults.reduce((s, fr) => s + fr.invoices.length, 0);

  const { data: batch, error: batchErr } = await db()
    .from('invoice_batches')
    .insert({
      company_id: companyId,
      uploaded_by: user?.id,
      file_count: fileResults.length,
      invoice_count: totalInvoices,
      financial_year: period.financial_year,
      period_month: period.period_month,
      period_label: period.period_label,
    })
    .select('id')
    .single();
  if (batchErr) throw batchErr;

  const rows = fileResults.flatMap((fr) =>
    fr.invoices.map((inv: ExtractedInvoice) => {
      const r = computeReadiness(inv, companyGstin, companyName);
      return {
        batch_id: batch.id,
        company_id: companyId,
        filename: fr.filename,
        original_filename: fr.filename,
        vendor_name: inv.vendor_name,
        vendor_gstin: inv.vendor_gstin,
        vendor_address: inv.vendor_address,
        buyer_name: inv.buyer_name,
        buyer_gstin: inv.buyer_gstin,
        invoice_number: inv.invoice_number,
        invoice_date: inv.invoice_date || null,
        tax_type: inv.tax_type,
        subtotal: inv.subtotal,
        bill_discount_amount: inv.bill_discount_amount ?? 0,
        bill_discount_percent: inv.bill_discount_percent ?? null,
        cgst: inv.cgst,
        sgst: inv.sgst,
        igst: inv.igst,
        round_off: inv.round_off,
        total: inv.total,
        confidence: inv.confidence,
        confidence_reasons: inv.confidence_reasons ?? [],
        line_items: inv.line_items,
        charges: inv.charges ?? [],
        needs_review: r.readiness !== 'ready',
        bill_discount_auto_detected: inv.bill_discount_auto_detected ?? false,
        // Purchase register fields
        status: 'pending_review',
        readiness: r.readiness,
        readiness_flags: r.flags,
        financial_year: period.financial_year,
        period_month: period.period_month,
        period_label: period.period_label,
        itc_status: r.itcStatus,
        itc_remark: r.itcRemark,
      };
    })
  );

  if (rows.length > 0) {
    const { error: invErr } = await db().from('invoices').insert(rows);
    if (invErr) throw invErr;
  }

  return batch.id;
}

// ─── Upload Queue ─────────────────────────────────────────────────────────────

export async function getPendingInvoices(
  companyId: string,
  batchId?: string,
): Promise<StoredInvoice[]> {
  let q = db()
    .from('invoices')
    .select('*')
    .eq('company_id', companyId)
    .eq('status', 'pending_review')
    .order('created_at', { ascending: true });
  if (batchId) q = q.eq('batch_id', batchId);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as StoredInvoice[];
}

// ─── Accept invoices ─────────────────────────────────────────────────────────

export interface AcceptParams {
  itcStatus?: ITCStatus;
  itcRemark?: string;
  convertedToNonGst?: boolean;
  convertedNonGstLedger?: string;
  // Allow overriding readiness flags (e.g. after ITC popup decision)
  readinessFlags?: string[];
}

export async function acceptInvoices(
  invoiceIds: string[],
  params: AcceptParams = {},
): Promise<void> {
  if (!invoiceIds.length) return;
  const user = (await getSupabase().auth.getUser()).data.user;
  const now = new Date().toISOString();

  const update: Record<string, unknown> = {
    status: 'accepted',
    accepted_at: now,
    accepted_by: user?.id ?? null,
  };
  if (params.itcStatus !== undefined) update.itc_status = params.itcStatus;
  if (params.itcRemark !== undefined) update.itc_remark = params.itcRemark;
  if (params.convertedToNonGst !== undefined) update.converted_to_nongst = params.convertedToNonGst;
  if (params.convertedNonGstLedger !== undefined) update.converted_nongst_ledger = params.convertedNonGstLedger;
  if (params.readinessFlags !== undefined) update.readiness_flags = params.readinessFlags;

  const { error } = await db()
    .from('invoices')
    .update(update)
    .in('id', invoiceIds);
  if (error) throw error;
}

// ─── Reject invoices ─────────────────────────────────────────────────────────

export async function rejectInvoices(
  invoiceIds: string[],
  reason?: string,
): Promise<void> {
  if (!invoiceIds.length) return;
  const user = (await getSupabase().auth.getUser()).data.user;
  const now = new Date().toISOString();

  // 1. Fetch invoice snapshots for archive
  const { data: rows, error: fetchErr } = await db()
    .from('invoices')
    .select('id, company_id, batch_id, invoice_number, vendor_name, vendor_gstin, invoice_date, total, original_filename, financial_year, period_month, period_label, readiness, readiness_flags')
    .in('id', invoiceIds);
  if (fetchErr) throw fetchErr;

  // 2. Mark as rejected
  const { error: updateErr } = await db()
    .from('invoices')
    .update({
      status: 'rejected',
      rejected_at: now,
      rejected_by: user?.id ?? null,
      rejection_reason: reason ?? null,
    })
    .in('id', invoiceIds);
  if (updateErr) throw updateErr;

  // 3. Insert audit records into rejection_archive
  const archiveRows = (rows ?? []).map((r: Record<string, unknown>) => ({
    invoice_id: r.id,
    company_id: r.company_id,
    batch_id: r.batch_id,
    rejected_by: user?.id ?? null,
    rejected_at: now,
    rejection_reason: reason ?? null,
    invoice_number: r.invoice_number,
    vendor_name: r.vendor_name,
    vendor_gstin: r.vendor_gstin,
    invoice_date: r.invoice_date,
    total: r.total,
    original_filename: r.original_filename,
    financial_year: r.financial_year,
    period_month: r.period_month,
    period_label: r.period_label,
    readiness: r.readiness,
    readiness_flags: r.readiness_flags,
  }));

  if (archiveRows.length > 0) {
    const { error: archiveErr } = await db()
      .from('rejection_archive')
      .insert(archiveRows);
    if (archiveErr) throw archiveErr;
  }
}

// ─── Purchase Register ────────────────────────────────────────────────────────

export interface RegisterFilters {
  financialYear?: string;
  periodMonth?: string;
  itcStatus?: ITCStatus;
}

export async function getPurchaseRegister(
  companyId: string,
  filters: RegisterFilters = {},
): Promise<StoredInvoice[]> {
  let q = db()
    .from('invoices')
    .select('*')
    .eq('company_id', companyId)
    .eq('status', 'accepted')
    .order('invoice_date', { ascending: false })
    .order('accepted_at', { ascending: false });

  if (filters.financialYear) q = q.eq('financial_year', filters.financialYear);
  if (filters.periodMonth)   q = q.eq('period_month', filters.periodMonth);
  if (filters.itcStatus)     q = q.eq('itc_status', filters.itcStatus);

  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as StoredInvoice[];
}
