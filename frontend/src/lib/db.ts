import { getSupabase } from './supabase';
import type { ExtractedInvoice, FileResult } from '@/types/invoice';

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
