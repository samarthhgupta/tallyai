import { getSupabase } from './supabase';
import type { StoredInvoice, ExtractedInvoice, InvoiceReadiness } from '@/types/invoice';
import { deriveInvoiceFinancials } from './invoiceCalculations';

// PostgREST default max-rows is 1000. Use an explicit high limit for full-register queries.
const MAX_REGISTER_ROWS = 10000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => getSupabase() as any;

// ─── Readiness for sales invoices ─────────────────────────────────────────────
// Simpler than purchase: no ITC, no company-mismatch checks. The customer is the
// buyer_name; our own company is vendor_name.
export function computeSalesReadiness(
  inv: ExtractedInvoice,
): { readiness: InvoiceReadiness; flags: string[] } {
  const flags: string[] = [];
  let readiness: InvoiceReadiness = 'ready';

  if (!inv.invoice_number?.trim()) {
    flags.push('Invoice number missing');
    readiness = 'critical';
  }
  if (!inv.buyer_name?.trim()) {
    flags.push('Customer name missing');
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

  if (readiness !== 'critical') {
    if (inv.confidence < 0.70) {
      flags.push(`Low confidence (${Math.round(inv.confidence * 100)}%)`);
      readiness = 'warning';
    }
    if (!inv.buyer_gstin?.trim()) {
      flags.push('Missing customer GSTIN (B2C)');
      if (readiness === 'ready') readiness = 'warning';
    }
  }

  return { readiness, flags };
}

// ─── Create a sales batch ─────────────────────────────────────────────────────
export async function createSalesBatch(
  companyId: string,
  fileCount: number,
  financialYear: string,
  source?: string,
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
      voucher_class: 'sales',
      source: source ?? 'pdf_extraction',
    })
    .select('id')
    .single();
  if (error) throw new Error(`createSalesBatch failed: ${error.message} (code: ${error.code}, details: ${error.details})`);
  return data.id as string;
}

// ─── Pending sales invoices ───────────────────────────────────────────────────
export async function getSalesPendingInvoices(
  companyId: string,
  batchId?: string,
): Promise<StoredInvoice[]> {
  let q = db()
    .from('invoices')
    .select('*')
    .eq('company_id', companyId)
    .eq('voucher_class', 'sales')
    .eq('status', 'pending_review')
    .order('created_at', { ascending: true });
  if (batchId) q = q.eq('batch_id', batchId);
  const { data, error } = await q.limit(MAX_REGISTER_ROWS);
  if (error) throw error;
  return (data ?? []) as StoredInvoice[];
}

// ─── Sales Register (accepted) ────────────────────────────────────────────────
export async function getSalesRegister(
  companyId: string,
  filters: { financialYear?: string; periodMonth?: string } = {},
): Promise<StoredInvoice[]> {
  let q = db()
    .from('invoices')
    .select('*')
    .eq('company_id', companyId)
    .eq('voucher_class', 'sales')
    .eq('status', 'accepted')
    .order('invoice_date', { ascending: false })
    .order('accepted_at', { ascending: false });

  if (filters.financialYear) q = q.eq('financial_year', filters.financialYear);
  if (filters.periodMonth) q = q.eq('period_month', filters.periodMonth);

  const { data, error } = await q.limit(MAX_REGISTER_ROWS);
  if (error) throw error;
  return (data ?? []) as StoredInvoice[];
}

// ─── Shared row builder ───────────────────────────────────────────────────────
function buildSalesRow(
  inv: ExtractedInvoice,
  filename: string,
  companyId: string,
  batchId: string,
  financialYear: string,
  source: 'pdf_extraction' | 'excel_import',
  now: string,
  userId: string | null,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  p: { financial_year: string; period_month: string; period_label: string },
): Record<string, unknown> {
  const r = computeSalesReadiness(inv);
  const d = deriveInvoiceFinancials(inv);
  return {
    batch_id: batchId,
    company_id: companyId,
    filename,
    original_filename: filename,
    source_file_name: filename,
    voucher_class: 'sales',
    voucher_direction: 'outward',
    source,
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
    supplier_cgst: inv.cgst ?? null,
    supplier_sgst: inv.sgst ?? null,
    supplier_igst: inv.igst ?? null,
    supplier_total: inv.total ?? null,
    supplier_roundoff: inv.round_off ?? null,
    cgst: d.cgst,
    sgst: d.sgst,
    igst: d.igst,
    charges: inv.charges ?? [],
    round_off: inv.round_off ?? 0,
    total: d.total,
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
    itc_status: 'not_applicable',
    itc_remark: null,
    accepted_at: now,
    accepted_by: userId,
  };
}

// ─── Insert accepted sales invoices from PDF extraction ───────────────────────
export async function insertAcceptedSalesInvoices(
  companyId: string,
  batchId: string,
  items: Array<{ inv: ExtractedInvoice; filename: string }>,
  financialYear: string,
  companyGstin?: string | null,
  companyName?: string | null,
): Promise<void> {
  if (!items.length) return;
  const user = (await getSupabase().auth.getUser()).data.user;
  const now = new Date().toISOString();
  const { periodFromInvoiceDate } = await import('./fyPeriod');

  const rows = items.map(({ inv, filename }) => {
    // For sales, the seller is always our company. Populate vendor fields if the
    // extraction did not produce them (common for PDF/image sources).
    const enrichedInv: ExtractedInvoice = companyName
      ? { ...inv, vendor_name: inv.vendor_name || companyName, vendor_gstin: inv.vendor_gstin || (companyGstin ?? '') }
      : inv;
    const p = periodFromInvoiceDate(enrichedInv.invoice_date ?? '', financialYear);
    return buildSalesRow(enrichedInv, filename, companyId, batchId, financialYear, 'pdf_extraction', now, user?.id ?? null, p);
  });

  const { error } = await db().from('invoices').insert(rows);
  if (error) throw new Error(`insertAcceptedSalesInvoices failed: ${error.message} (code: ${error.code}, details: ${error.details})`);
}

// ─── Insert accepted sales invoices from Excel import ─────────────────────────
export async function insertAcceptedSalesExcelInvoices(
  companyId: string,
  batchId: string,
  items: Array<{ inv: ExtractedInvoice; filename: string }>,
  financialYear: string,
): Promise<void> {
  if (!items.length) return;
  const user = (await getSupabase().auth.getUser()).data.user;
  const now = new Date().toISOString();
  const { periodFromInvoiceDate } = await import('./fyPeriod');

  const rows = items.map(({ inv, filename }) => {
    const p = periodFromInvoiceDate(inv.invoice_date ?? '', financialYear);
    return buildSalesRow(inv, filename, companyId, batchId, financialYear, 'excel_import', now, user?.id ?? null, p);
  });

  const { error } = await db().from('invoices').insert(rows);
  if (error) throw new Error(`insertAcceptedSalesExcelInvoices failed: ${error.message} (code: ${error.code}, details: ${error.details})`);
}

// ─── Save Tally ledger acceptance by invoice ID (safer than invoice_number) ───
export async function saveSalesTallyAcceptance(
  companyId: string,
  invoiceId: string,
  acceptance: Record<string, unknown> | null,
): Promise<void> {
  const { error } = await db()
    .from('invoices')
    .update({ tally_ledger_acceptance: acceptance })
    .eq('company_id', companyId)
    .eq('id', invoiceId);
  if (error) throw error;
}

// ─── Sales rejected register ──────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getSalesRejectedRegister(companyId: string, financialYear?: string): Promise<any[]> {
  // rejection_archive is shared across voucher classes; we join through invoices
  // to filter for sales. Simpler: fetch archive rows whose invoice is sales.
  let q = db()
    .from('rejection_archive')
    .select('id, invoice_id, company_id, invoice_number, vendor_name, vendor_gstin, invoice_date, total, period_label, financial_year, rejection_reason, rejected_at')
    .eq('company_id', companyId)
    .order('rejected_at', { ascending: false });
  if (financialYear) q = q.eq('financial_year', financialYear);
  const { data, error } = await q;
  if (error) throw new Error(error.message);

  const rows = (data ?? []) as Array<{ invoice_id: string }>;
  if (!rows.length) return [];

  // Filter to sales invoices only
  const ids = rows.map((r) => r.invoice_id);
  const { data: salesInv } = await db()
    .from('invoices')
    .select('id')
    .in('id', ids)
    .eq('voucher_class', 'sales');
  const salesIds = new Set((salesInv ?? []).map((r: { id: string }) => r.id));
  return rows.filter((r) => salesIds.has(r.invoice_id));
}

/**
 * Check which invoice numbers from a proposed Excel import already exist
 * as accepted sales invoices for this company + FY. Returns the duplicates.
 */
export async function checkExcelDuplicates(
  companyId: string,
  invoiceNumbers: string[],
  financialYear: string,
): Promise<string[]> {
  if (!invoiceNumbers.length) return [];
  const { data, error } = await db()
    .from('invoices')
    .select('invoice_number')
    .eq('company_id', companyId)
    .eq('voucher_class', 'sales')
    .eq('financial_year', financialYear)
    .in('invoice_number', invoiceNumbers);
  if (error) throw new Error(error.message);
  return (data ?? []).map((r: { invoice_number: string }) => r.invoice_number);
}

/** Delete ALL sales invoices for a company. Scoped to voucher_class='sales' only — never touches purchase data. */
export async function deleteAllSalesInvoices(companyId: string): Promise<number> {
  const { data, error } = await db()
    .from('invoices')
    .delete()
    .eq('company_id', companyId)
    .eq('voucher_class', 'sales')
    .select('id');
  if (error) throw new Error(error.message);
  return (data ?? []).length;
}
