import type { ExtractedInvoice, FileResult } from '@/types/invoice';

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
  const tax = (inv.cgst ?? 0) + (inv.sgst ?? 0) + (inv.igst ?? 0);
  const expected = subtotal + tax + (inv.round_off ?? 0);
  if (inv.total > 0 && Math.abs(expected - inv.total) > 1) {
    score -= 0.15;
    reasons.push(`Computed total ₹${expected.toFixed(2)} doesn't match invoice total ₹${inv.total.toFixed(2)} (-15%)`);
  }

  if (reasons.length === 0) {
    reasons.push('All key fields verified ✓');
  }

  return { score: Math.max(0, Math.min(1, score)), reasons };
}

export async function extractInvoices(files: File[]): Promise<{
  batch_id: string;
  file_results: FileResult[];
  total_invoices: number;
}> {
  const backendUrl = getBackendUrl();

  const form = new FormData();
  files.forEach((f) => form.append('files', f));
  form.append('company_id', 'demo');

  const res = await fetch(`${backendUrl}/invoices/upload`, {
    method: 'POST',
    body: form,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Server error ${res.status}: ${err.slice(0, 300)}`);
  }

  const data = await res.json();

  // Re-apply client-side confidence scoring on top of server scores
  for (const fileResult of data.file_results) {
    fileResult.invoices = (fileResult.invoices as ExtractedInvoice[]).map((inv) => {
      const { score, reasons } = computeConfidence(inv);
      return { ...inv, confidence: score, confidence_reasons: reasons };
    });
  }

  return data;
}
