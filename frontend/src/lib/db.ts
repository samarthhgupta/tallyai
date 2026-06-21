import { getSupabase } from './supabase';
import type {
  ExtractedInvoice,
  FileResult,
  StoredInvoice,
  InvoiceReadiness,
  ITCStatus,
} from '@/types/invoice';
import { deriveInvoiceFinancials } from '@/lib/invoiceCalculations';
import { resolveChargeSac } from '@/lib/expenseLedgers';
import type { FYPeriod } from '@/lib/fyPeriod';

export interface Company {
  id: string;
  name: string;
  gstin: string | null;
  tally_company_name: string | null; // exact name in Tally - used in XML header
  state_name: string | null;         // auto-derived from GSTIN
  tally_url: string | null;
  tally_port: number;
  state_code: string | null;
  purchase_ledger_config: { gst_percent: number | null; tally_ledger_name: string }[] | null;
  voucher_mode: 'accounting_only' | 'inventory' | null;
  discount_ledger_name: string | null; // Tally ledger for bill-level discounts (P&L)
  stock_item_mode: 'hsn_driven' | null;
  // Clone audit metadata — no effect on business logic or XML
  is_test_company: boolean | null;
  cloned_from_company_id: string | null;
  cloned_from_company_name: string | null;
  cloned_at: string | null;
}

// ─── Companies ────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => getSupabase() as any;

const COMPANY_SELECT = 'id, name, gstin, tally_company_name, state_name, tally_url, tally_port, state_code, purchase_ledger_config, voucher_mode, discount_ledger_name, stock_item_mode, is_test_company, cloned_from_company_id, cloned_from_company_name, cloned_at';

export async function getMyCompanies(): Promise<Company[]> {
  const { data, error } = await db()
    .from('companies')
    .select(COMPANY_SELECT)
    .order('name');
  if (error) throw error;
  return (data ?? []) as Company[];
}

export async function getCompany(id: string): Promise<Company> {
  const { data, error } = await db()
    .from('companies')
    .select(COMPANY_SELECT)
    .eq('id', id)
    .single();
  if (error) throw error;
  return data as Company;
}

export async function savePurchaseLedgerConfig(
  companyId: string,
  config: { gst_percent: number | null; tally_ledger_name: string }[],
): Promise<void> {
  const { error } = await db()
    .from('companies')
    .update({ purchase_ledger_config: config, updated_at: new Date().toISOString() })
    .eq('id', companyId);
  if (error) throw error;
}

export async function saveCompanyVoucherSettings(
  companyId: string,
  params: {
    voucher_mode?: 'accounting_only' | 'inventory';
    discount_ledger_name?: string | null;
  },
): Promise<void> {
  const { error } = await db()
    .from('companies')
    .update({ ...params, updated_at: new Date().toISOString() })
    .eq('id', companyId);
  if (error) throw error;
}

export async function createCompany(params: {
  name: string;
  gstin: string;              // mandatory - needed to derive state
  tally_company_name: string; // mandatory - needed for XML header
  tally_url?: string;
  tally_port?: number;
}): Promise<Company> {
  const user = (await getSupabase().auth.getUser()).data.user;
  const stateCode = params.gstin.slice(0, 2);
  // Import deriveStateFromGstin inline to avoid circular deps
  const { deriveStateFromGstin } = await import('./suppliers');
  const stateName = deriveStateFromGstin(params.gstin) ?? '';
  const { data, error } = await db()
    .from('companies')
    .insert({
      ...params,
      state_code: stateCode,
      state_name: stateName,
      created_by: user?.id ?? null,
      updated_at: new Date().toISOString(),
    })
    .select()
    .single();
  if (error) throw error;
  return data as Company;
}

export async function updateCompany(
  id: string,
  params: {
    name?: string;
    gstin?: string;
    tally_company_name?: string;
    tally_url?: string;
    tally_port?: number;
    voucher_mode?: 'accounting_only' | 'inventory';
    discount_ledger_name?: string | null;
  },
): Promise<void> {
  const updates: Record<string, unknown> = { ...params, updated_at: new Date().toISOString() };
  if (params.gstin) {
    updates.state_code = params.gstin.slice(0, 2);
    const { deriveStateFromGstin } = await import('./suppliers');
    updates.state_name = deriveStateFromGstin(params.gstin) ?? '';
  }
  const { error } = await db().from('companies').update(updates).eq('id', id);
  if (error) throw error;
}

export async function cloneCompany(sourceId: string, newName: string): Promise<string> {
  const { data, error } = await db().rpc('clone_company', {
    source_id: sourceId,
    new_name: newName.trim(),
  });
  if (error) throw error;
  return data as string;
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
      uploaded_by: user?.id ?? null,
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

  // ── Critical failures - must be resolved before accepting ──
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

  const unidentifiedCharges = (inv.charges ?? []).filter((c) => !c.description?.trim());
  if (unidentifiedCharges.length > 0) {
    flags.push(`${unidentifiedCharges.length} unidentified charge(s) — must be resolved before accepting`);
    readiness = 'critical';
  }

  // Charges where GST% > 0 and amount > 0 but no SAC can be resolved block
  // acceptance because GST cannot be calculated — the charge will be silently
  // excluded from all GST computations, understating CGST/SGST/IGST and the
  // party ledger amount by the same amount (balanced but wrong).
  // Resolution: enter a SAC code on the charge, or set GST% to 0 if non-taxable.
  const unresolvedTaxableCharges = (inv.charges ?? []).filter(
    (c) => (c.gst_percent ?? 0) > 0 && (c.amount ?? 0) > 0 && !resolveChargeSac(c.description ?? '', c.sac ?? null),
  );
  for (const c of unresolvedTaxableCharges) {
    flags.push(
      `Charge "${c.description || 'Unknown'}" has GST rate ${c.gst_percent}% but no SAC code. ` +
      `GST cannot be calculated for this charge. ` +
      `Enter a SAC code or change GST% to 0 if this charge is non-taxable.`,
    );
    readiness = 'critical';
  }

  // Company mismatch check: if buyer GSTIN matches the selected company's GSTIN, the
  // invoice belongs to this company regardless of name variation — allow with a warning.
  // Only block when BOTH name AND GSTIN fail to match (unambiguously wrong company).
  if (companyName && inv.buyer_name?.trim()) {
    const buyerLower = inv.buyer_name.toLowerCase();
    const companyLower = companyName.toLowerCase();
    const companyWords = companyLower.split(/\s+/).filter((w) => w.length >= 5);
    const nameMatches = companyWords.length === 0 || companyWords.some((w) => buyerLower.includes(w));
    if (!nameMatches) {
      const gstinMatches =
        companyGstin?.trim() &&
        inv.buyer_gstin?.trim() &&
        inv.buyer_gstin.trim().toUpperCase() === companyGstin.trim().toUpperCase();
      if (gstinMatches) {
        flags.push(`Buyer name on invoice ("${inv.buyer_name}") differs from company name ("${companyName}") — verify before accepting`);
        if (readiness === 'ready') readiness = 'warning';
      } else {
        flags.push(`Wrong company: buyer on invoice is "${inv.buyer_name}" but selected company is "${companyName}"`);
        readiness = 'critical';
      }
    }
  }

  // ── Warnings - informational, never block acceptance ──
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
      // No GST - no ITC concern
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

// ─── Create batch record only (no invoices yet) ──────────────────────────────

export async function createBatch(
  companyId: string,
  fileCount: number,
  financialYear: string,
): Promise<string> {
  const user = (await getSupabase().auth.getUser()).data.user;
  const { data, error } = await db()
    .from('invoice_batches')
    .insert({
      company_id: companyId,
      uploaded_by: user?.id ?? null,
      file_count: fileCount,
      invoice_count: 0,
      financial_year: financialYear,
      period_month: null,
      period_label: null,
    })
    .select('id')
    .single();
  if (error) throw new Error(`createBatch failed: ${error.message} (code: ${error.code}, details: ${error.details})`);
  return data.id as string;
}

// ─── Insert accepted invoices directly (no pending stage) ────────────────────

export interface InvoiceToSave {
  inv: ExtractedInvoice;
  filename: string;
  itcStatusOverride?: ITCStatus;
  itcRemarkOverride?: string;
  convertedToNonGst?: boolean;
  convertedNonGstLedger?: string;
}

export async function insertAcceptedInvoices(
  companyId: string,
  batchId: string,
  items: InvoiceToSave[],
  financialYear: string,
  companyGstin?: string | null,
  companyName?: string | null,
): Promise<void> {
  if (!items.length) return;
  const user = (await getSupabase().auth.getUser()).data.user;
  const now = new Date().toISOString();
  const { periodFromInvoiceDate } = await import('./fyPeriod');

  const rows = items.map(({ inv, filename, itcStatusOverride, itcRemarkOverride, convertedToNonGst, convertedNonGstLedger }) => {
    const r = computeReadiness(inv, companyGstin, companyName);
    const finalItcStatus = itcStatusOverride ?? r.itcStatus;
    const finalItcRemark = itcRemarkOverride ?? r.itcRemark;
    // Derive period from invoice date - not from user-selected month
    const p = periodFromInvoiceDate(inv.invoice_date ?? '', financialYear);

    // Derive all financial values from the canonical engine.
    // This ensures cgst/sgst/igst/total are always internally consistent and include
    // both line-item GST and taxable charge GST (e.g. freight at 5%).
    //
    // ARCHITECTURE: supplier_* columns capture the raw AI-extracted values for audit.
    // The derived cgst/sgst/igst/total columns are the operational source of truth
    // and must be computed by deriveInvoiceFinancials — never taken from AI extraction.
    //
    // HISTORICAL NOTE: Rows accepted before migration 034 have supplier_* = NULL and
    // may have stale cgst/sgst/igst (built from buildHsnSummary, goods only).
    // All operational screens derive values at runtime, so those rows are safe
    // operationally, but their stored derived columns should not be trusted for
    // raw-column reporting without re-deriving from line_items + charges.
    const d = deriveInvoiceFinancials(inv);

    return {
      batch_id: batchId,
      company_id: companyId,
      filename,
      original_filename: filename,
      source_file_name: filename,
      voucher_class: 'purchase',
      voucher_direction: 'inward',
      source: 'pdf_extraction',
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
      // Supplier archival columns — AI-extracted values, written once, never updated.
      // Do not use these for any calculation or display. For audit only.
      supplier_cgst:     inv.cgst     ?? null,
      supplier_sgst:     inv.sgst     ?? null,
      supplier_igst:     inv.igst     ?? null,
      supplier_total:    inv.total    ?? null,
      supplier_roundoff: inv.round_off ?? null,
      // Derived columns — canonical engine output. Source of truth for all operational workflows.
      cgst:      d.cgst,
      sgst:      d.sgst,
      igst:      d.igst,
      charges: inv.charges ?? [],
      round_off: inv.round_off ?? 0,
      total:     d.total,
      confidence: inv.confidence,
      confidence_reasons: inv.confidence_reasons ?? [],
      line_items: inv.line_items,
      bill_discount_auto_detected: inv.bill_discount_auto_detected ?? false,
      status: 'accepted',
      readiness: r.readiness,
      readiness_flags: r.flags,
      financial_year: p.financial_year,
      period_month: p.period_month,
      period_label: p.period_label,
      itc_status: finalItcStatus,
      itc_remark: finalItcRemark,
      converted_to_nongst: convertedToNonGst ?? false,
      converted_nongst_ledger: convertedNonGstLedger ?? null,
      accepted_at: now,
      accepted_by: user?.id ?? null,
    };
  });

  const { error } = await db().from('invoices').insert(rows);
  if (error) throw new Error(`insertAcceptedInvoices failed: ${error.message} (code: ${error.code}, details: ${error.details})`);
}

// ─── Insert rejected invoices (+ archive) ────────────────────────────────────

export async function insertRejectedInvoices(
  companyId: string,
  batchId: string,
  items: InvoiceToSave[],
  financialYear: string,
  reason?: string,
): Promise<void> {
  if (!items.length) return;
  const user = (await getSupabase().auth.getUser()).data.user;
  const now = new Date().toISOString();
  const { periodFromInvoiceDate } = await import('./fyPeriod');

  const rows = items.map(({ inv, filename }) => {
    const r = computeReadiness(inv);
    const p = periodFromInvoiceDate(inv.invoice_date ?? '', financialYear);
    return {
      batch_id: batchId,
      company_id: companyId,
      filename,
      original_filename: filename,
      source_file_name: filename,
      voucher_class: 'purchase',
      voucher_direction: 'inward',
      source: 'pdf_extraction',
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
      charges: inv.charges ?? [],
      round_off: inv.round_off,
      total: inv.total,
      confidence: inv.confidence,
      confidence_reasons: inv.confidence_reasons ?? [],
      line_items: inv.line_items,
      bill_discount_auto_detected: inv.bill_discount_auto_detected ?? false,
      status: 'rejected',
      readiness: r.readiness,
      readiness_flags: r.flags,
      financial_year: p.financial_year,
      period_month: p.period_month,
      period_label: p.period_label,
      itc_status: r.itcStatus,
      itc_remark: r.itcRemark,
      rejected_at: now,
      rejected_by: user?.id ?? null,
      rejection_reason: reason ?? null,
    };
  });

  const { data: inserted, error } = await db()
    .from('invoices')
    .insert(rows)
    .select('id, company_id, batch_id, invoice_number, vendor_name, vendor_gstin, invoice_date, total, original_filename, financial_year, period_month, period_label, readiness, readiness_flags');
  if (error) throw new Error(`insertRejectedInvoices failed: ${error.message} (code: ${error.code}, details: ${error.details})`);

  // Insert rejection archive rows
  const archiveRows = (inserted ?? []).map((r: Record<string, unknown>) => ({
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
    const { error: archErr } = await db().from('rejection_archive').insert(archiveRows);
    if (archErr) throw new Error(`rejection_archive insert failed: ${archErr.message} (code: ${archErr.code}, details: ${archErr.details})`);
  }
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
      uploaded_by: user?.id ?? null,
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
        voucher_class: 'purchase',
        source: 'pdf_extraction',
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
    .eq('voucher_class', 'purchase')
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

// ─── Delete invoices ─────────────────────────────────────────────────────────

// Delete a single invoice by ID (cascades to rejection_archive)
export async function deleteInvoice(invoiceId: string): Promise<void> {
  const { error } = await db().from('invoices').delete().eq('id', invoiceId);
  if (error) throw new Error(error.message);
}

// Delete ALL invoices for a company (all statuses - for test data cleanup)
export async function deleteAllCompanyInvoices(companyId: string): Promise<number> {
  const { data, error } = await db()
    .from('invoices')
    .delete()
    .eq('company_id', companyId)
    .select('id');
  if (error) throw new Error(error.message);
  return (data ?? []).length;
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
    .eq('voucher_class', 'purchase')
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

// ─── Save Tally ledger acceptance for an invoice (by invoice_number + company_id) ──

export async function saveInvoiceTallyAcceptance(
  companyId: string,
  invoiceNumber: string,
  acceptance: StoredInvoice['tally_ledger_acceptance'],
): Promise<void> {
  const { error } = await db()
    .from('invoices')
    .update({ tally_ledger_acceptance: acceptance })
    .eq('company_id', companyId)
    .eq('invoice_number', invoiceNumber);
  if (error) throw error;
}

export async function clearAllTallyAcceptances(companyId: string, financialYear: string): Promise<void> {
  const { error } = await db()
    .from('invoices')
    .update({ tally_ledger_acceptance: null })
    .eq('company_id', companyId)
    .eq('financial_year', financialYear)
    .eq('status', 'accepted');
  if (error) throw error;
}

// ─── Get single invoice ───────────────────────────────────────────────────────

export async function getInvoiceById(id: string): Promise<StoredInvoice> {
  const { data, error } = await db().from('invoices').select('*').eq('id', id).single();
  if (error) throw error;
  return data as StoredInvoice;
}

// ─── Update accepted invoice ──────────────────────────────────────────────────

export async function updateAcceptedInvoice(
  id: string,
  patch: {
    vendor_name?: string;
    vendor_gstin?: string | null;
    buyer_name?: string | null;
    buyer_gstin?: string | null;
    invoice_number?: string;
    invoice_date?: string | null;
    tax_type?: 'cgst_sgst' | 'igst';
    subtotal?: number;
    bill_discount_amount?: number;
    bill_discount_percent?: number | null;
    cgst?: number;
    sgst?: number;
    igst?: number;
    round_off?: number;
    total?: number;
    line_items?: unknown;
    charges?: unknown;
    readiness?: string;
    readiness_flags?: string[];
    itc_status?: string | null;
    itc_remark?: string | null;
  },
): Promise<void> {
  const { error } = await db()
    .from('invoices')
    .update(patch)
    .eq('id', id);
  if (error) throw new Error(`${error.message}${error.details ? ` - ${error.details}` : ''}`);
}

// ─── Move accepted invoice to rejected ───────────────────────────────────────

export async function moveAcceptedToRejected(
  invoiceId: string,
  reason?: string,
): Promise<void> {
  const user = (await getSupabase().auth.getUser()).data.user;
  const now = new Date().toISOString();

  const { data: inv, error: fetchErr } = await db()
    .from('invoices')
    .select('*')
    .eq('id', invoiceId)
    .single();
  if (fetchErr) throw new Error(`Fetch failed: ${fetchErr.message}`);

  const { error: updateErr } = await db()
    .from('invoices')
    .update({
      status: 'rejected',
      rejected_at: now,
      rejected_by: user?.id ?? null,
      rejection_reason: reason ?? null,
    })
    .eq('id', invoiceId);
  if (updateErr) throw new Error(`Update failed: ${updateErr.message}${updateErr.details ? ` - ${updateErr.details}` : ''}`);

  const { error: archErr } = await db()
    .from('rejection_archive')
    .insert({
      invoice_id: invoiceId,
      company_id: inv.company_id,
      batch_id: inv.batch_id,
      rejected_by: user?.id ?? null,
      rejected_at: now,
      rejection_reason: reason ?? null,
      invoice_number: inv.invoice_number,
      vendor_name: inv.vendor_name,
      vendor_gstin: inv.vendor_gstin,
      invoice_date: inv.invoice_date,
      total: inv.total,
      original_filename: inv.original_filename,
      financial_year: inv.financial_year,
      period_month: inv.period_month,
      period_label: inv.period_label,
      readiness: inv.readiness,
      readiness_flags: inv.readiness_flags,
    });
  if (archErr) throw new Error(`Archive insert failed: ${archErr.message}${archErr.details ? ` - ${archErr.details}` : ''}`);

}

// ─── Rejected Register ────────────────────────────────────────────────────────

export interface RejectedRecord {
  id: string;
  invoice_id: string;
  company_id: string;
  invoice_number: string | null;
  vendor_name: string | null;
  vendor_gstin: string | null;
  invoice_date: string | null;
  total: number | null;
  period_label: string | null;
  financial_year: string | null;
  rejection_reason: string | null;
  rejected_at: string | null;
  moved_by_email?: string | null;
  itc_status?: string | null;
}

// ─── Restore a rejected invoice back to accepted ─────────────────────────────
// Moves the invoice from rejected back to accepted so it appears in the
// Purchase Register. The rejection_archive row is removed.
// The user can move it to rejected again via "Move to Rejected" if needed.
export async function restoreRejectedInvoice(invoiceId: string): Promise<void> {
  const user = (await getSupabase().auth.getUser()).data.user;
  const { error: updateErr } = await db()
    .from('invoices')
    .update({
      status: 'accepted',
      rejected_at: null,
      rejected_by: null,
      rejection_reason: null,
      accepted_at: new Date().toISOString(),
      accepted_by: user?.id ?? null,
    })
    .eq('id', invoiceId);
  if (updateErr) throw new Error(`Restore failed: ${updateErr.message}`);

  await db().from('rejection_archive').delete().eq('invoice_id', invoiceId);
}

export async function getRejectedRegister(
  companyId: string,
  financialYear?: string,
): Promise<RejectedRecord[]> {
  let q = db()
    .from('rejection_archive')
    .select('id, invoice_id, company_id, invoice_number, vendor_name, vendor_gstin, invoice_date, total, period_label, financial_year, rejection_reason, rejected_at')
    .eq('company_id', companyId)
    .order('rejected_at', { ascending: false });

  if (financialYear) q = q.eq('financial_year', financialYear);

  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? []) as RejectedRecord[];
}
