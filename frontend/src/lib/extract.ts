import type { ExtractedInvoice, FileResult, ExtractionResponse, ChunkWarning } from '@/types/invoice';
import { getSupabase } from './supabase';

function getBackendUrl(): string {
  const url = process.env.NEXT_PUBLIC_BACKEND_URL;
  if (!url) throw new Error('Backend URL not configured. Add NEXT_PUBLIC_BACKEND_URL to GitHub Secrets.');
  return url.replace(/\/$/, '');
}

function computeConfidence(inv: ExtractedInvoice): { score: number; reasons: string[] } {
  let score = inv.confidence ?? 0.5;
  const reasons: string[] = [];

  if (!inv.vendor_gstin) {
    score -= 0.05;
    reasons.push('Vendor GSTIN not found (-5%)');
  }
  if (!inv.invoice_number) {
    score -= 0.1;
    reasons.push('Invoice number not found (-10%)');
  }
  if (!inv.invoice_date) {
    score -= 0.1;
    reasons.push('Invoice date not found (-10%)');
  }
  if (!inv.line_items?.length) {
    score -= 0.2;
    reasons.push('No line items detected (-20%)');
  }

  const subtotal = (inv.line_items ?? []).reduce(
    (s, item) => s + item.qty * item.rate * (1 - item.disc_percent / 100), 0
  );
  const billDiscount = inv.bill_discount_amount ?? 0;
  const taxableValue = subtotal - billDiscount;
  const recomputedTax = (inv.line_items ?? []).reduce((s, item) => {
    const itemAmt = item.qty * item.rate * (1 - item.disc_percent / 100);
    const discountShare = subtotal > 0 && billDiscount > 0 ? billDiscount * (itemAmt / subtotal) : 0;
    return s + (itemAmt - discountShare) * item.gst_percent / 100;
  }, 0);
  const expected = taxableValue + recomputedTax + (inv.round_off ?? 0);
  if (inv.total > 0 && Math.abs(expected - inv.total) > 1) {
    score -= 0.15;
    reasons.push(`Computed total ₹${expected.toFixed(2)} doesn't match invoice total ₹${inv.total.toFixed(2)} (-15%)`);
  }

  if (reasons.length === 0) {
    reasons.push('All key fields verified ✓');
  }

  return { score: Math.max(0, Math.min(1, score)), reasons };
}

function applyConfidence(invoices: ExtractedInvoice[]): ExtractedInvoice[] {
  return invoices.map((inv) => {
    const { score, reasons } = computeConfidence(inv);
    return { ...inv, confidence: score, confidence_reasons: reasons };
  });
}

export async function extractInvoices(
  files: File[],
  batchId: string,
): Promise<ExtractionResponse> {
  const backendUrl = getBackendUrl();

  const form = new FormData();
  files.forEach((f) => form.append('files', f));
  form.append('company_id', 'demo');
  form.append('batch_id', batchId);

  const t0 = performance.now();
  console.log('[VERIFY] FETCH_STARTED', { batchId, files: files.map(f => ({ name: f.name, size: f.size })), t: new Date().toISOString() });

  let res: Response;
  try {
    res = await fetch(`${backendUrl}/invoices/upload`, {
      method: 'POST',
      body: form,
    });
    const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
    console.log('[VERIFY] FETCH_COMPLETED', { batchId, status: res.status, elapsed: `${elapsed}s`, t: new Date().toISOString() });
  } catch (fetchErr) {
    const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
    const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
    console.error('[VERIFY] FETCH_FAILED — this is what triggers Connection Lost message', { batchId, elapsed: `${elapsed}s`, error: msg, t: new Date().toISOString() });
    throw fetchErr;
  }

  if (!res.ok) {
    const err = await res.text();
    console.error('[VERIFY] FETCH_NOT_OK', { batchId, status: res.status, body: err.slice(0, 200) });
    throw new Error(`Server error ${res.status}: ${err.slice(0, 300)}`);
  }

  let data: ExtractionResponse;
  try {
    data = await res.json();
    const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
    console.log('[VERIFY] RESPONSE_PARSED', { batchId, totalInvoices: data.total_invoices, elapsed: `${elapsed}s`, t: new Date().toISOString() });
  } catch (parseErr) {
    const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
    console.error('[VERIFY] RESPONSE_PARSE_FAILED', { batchId, elapsed: `${elapsed}s`, error: String(parseErr) });
    throw parseErr;
  }

  // Re-apply client-side confidence scoring on top of server scores
  for (const fileResult of data.file_results) {
    fileResult.invoices = applyConfidence(fileResult.invoices);
  }

  return data;
}

/**
 * Called after a network failure. Queries Supabase extraction_logs for any
 * invoices already persisted under this batch_id from per-chunk immediate writes.
 * Returns a reconstructed ExtractionResponse, or null if nothing was found.
 */
export async function tryRecoverBatch(batchId: string): Promise<ExtractionResponse | null> {
  try {
    const sb = getSupabase();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (sb as any)
      .from('extraction_logs')
      .select('file_name, invoices, invoice_count, error')
      .eq('batch_id', batchId)
      .order('created_at');

    if (error || !data?.length) return null;

    // Group rows by base filename (strip __chunk_N suffix from per-chunk rows).
    // Skip the summary row (no __chunk_ suffix) — its invoices are already in the chunk rows.
    const byFile = new Map<string, { invoices: ExtractedInvoice[]; warnings: ChunkWarning[] }>();
    for (const row of data) {
      const rawName = row.file_name as string;
      const chunkMatch = rawName.match(/__chunk_(\d+)$/);
      if (!chunkMatch) continue; // skip summary rows

      const base = rawName.slice(0, rawName.lastIndexOf('__chunk_'));
      const entry = byFile.get(base) ?? { invoices: [], warnings: [] };
      const chunkInvoices: ExtractedInvoice[] = (row.invoices ?? []) as ExtractedInvoice[];
      entry.invoices.push(...chunkInvoices);

      if (row.error) {
        entry.warnings.push({
          chunk: parseInt(chunkMatch[1], 10),
          pages: '?',
          reason: row.error === 'TRUNCATED'
            ? 'max_tokens: Response truncated — some invoices may be missing'
            : `chunk_failed: ${row.error}`,
          invoices_recovered: chunkInvoices.length,
        });
      }
      byFile.set(base, entry);
    }

    if (byFile.size === 0) return null;

    const file_results: FileResult[] = Array.from(byFile.entries()).map(([filename, { invoices, warnings }]) => ({
      filename,
      invoices: applyConfidence(invoices),
      error: null,
      warnings: [
        ...warnings,
        {
          chunk: 0,
          pages: 'all',
          reason: 'recovered: Results recovered after connection failure — extraction may be incomplete',
          invoices_recovered: invoices.length,
        },
      ],
      extraction_complete: false,
    }));

    const total = file_results.reduce((s, fr) => s + fr.invoices.length, 0);
    if (total === 0) return null;

    return { batch_id: batchId, file_results, total_invoices: total, recovered: true };
  } catch {
    return null;
  }
}
