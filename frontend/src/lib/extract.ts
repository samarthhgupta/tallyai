import type { ExtractedInvoice, FileResult } from '@/types/invoice';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

const SYSTEM_PROMPT = `You are an expert Indian invoice data extractor. Extract ALL invoices from the provided document. A single document may contain multiple separate invoices.

For each invoice found, return a JSON object with exactly this shape:
{
  "vendor_name": string,
  "invoice_number": string,
  "invoice_date": string (YYYY-MM-DD),
  "vendor_gstin": string or null,
  "vendor_address": string or null,
  "line_items": [
    {
      "hsn": string,
      "gst_percent": number,
      "uom": string (unit of measure exactly as printed, e.g. "Nos", "Kg", "Pcs", "Mtr", "Box"),
      "qty": number,
      "rate": number,
      "disc_percent": number
    }
  ],
  "subtotal": number,
  "cgst": number,
  "sgst": number,
  "igst": number,
  "round_off": number,
  "total": number,
  "tax_type": "cgst_sgst" or "igst",
  "confidence": number
}

Return ONLY a JSON array [...]. No markdown, no explanation, no code fences.

Rules:
- line_items: do NOT use product/service names. Use only the HSN or SAC code.
- If a line item has no HSN, put "UNKNOWN".
- rate is always EX-GST. If invoice shows inclusive rate, divide by (1 + gst_percent/100).
- disc_percent is 0 if no discount shown.
- uom: capture exactly as printed on the invoice.
- confidence: 1.0 = everything clearly readable, 0.5 = some fields unclear, 0.0 = unreadable.
- If multiple invoices exist in the document, return all of them in the array.`;

function getApiKey(): string {
  const key = process.env.NEXT_PUBLIC_ANTHROPIC_API_KEY;
  if (!key) throw new Error('Anthropic API key is not configured. Add ANTHROPIC_API_KEY to GitHub Secrets.');
  return key;
}

function computeConfidence(inv: ExtractedInvoice): number {
  let score = inv.confidence ?? 0.5;
  if (!inv.vendor_gstin) score -= 0.05;
  if (!inv.invoice_number) score -= 0.1;
  if (!inv.invoice_date) score -= 0.1;
  if (!inv.line_items?.length) score -= 0.2;
  const subtotal = (inv.line_items ?? []).reduce(
    (s, item) => s + item.qty * item.rate * (1 - item.disc_percent / 100), 0
  );
  const tax = (inv.cgst ?? 0) + (inv.sgst ?? 0) + (inv.igst ?? 0);
  const expected = subtotal + tax + (inv.round_off ?? 0);
  if (inv.total > 0 && Math.abs(expected - inv.total) > 1) score -= 0.15;
  return Math.max(0, Math.min(1, score));
}

async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function docxToText(file: File): Promise<string> {
  const mammoth = await import('mammoth');
  const arrayBuffer = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer });
  return result.value || '(empty document)';
}

type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'document'; source: { type: 'base64'; media_type: 'application/pdf'; data: string } };

async function fileToContentParts(file: File): Promise<ContentPart[]> {
  const name = file.name.toLowerCase();

  if (name.endsWith('.pdf')) {
    const b64 = await fileToBase64(file);
    return [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } },
      { type: 'text', text: 'Extract all invoices from this PDF.' },
    ];
  }

  if (name.endsWith('.jpg') || name.endsWith('.jpeg')) {
    const b64 = await fileToBase64(file);
    return [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
      { type: 'text', text: 'Extract all invoices from this image.' },
    ];
  }

  if (name.endsWith('.png')) {
    const b64 = await fileToBase64(file);
    return [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } },
      { type: 'text', text: 'Extract all invoices from this image.' },
    ];
  }

  if (name.endsWith('.docx') || name.endsWith('.doc')) {
    const text = await docxToText(file);
    return [{ type: 'text', text: `Extract all invoices from this document:\n\n${text}` }];
  }

  const text = await file.text();
  return [{ type: 'text', text: `Extract all invoices:\n\n${text}` }];
}

async function callClaude(content: ContentPart[]): Promise<string> {
  const apiKey = getApiKey();
  const res = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      'anthropic-dangerous-direct-browser-ipc': 'true',
    },
    body: JSON.stringify({
      model: 'claude-opus-4-8',
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content }],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${err.slice(0, 300)}`);
  }

  const data = await res.json();
  return data.content?.[0]?.text ?? '';
}

function parseInvoices(raw: string): ExtractedInvoice[] {
  const text = raw.trim();
  // Try direct parse
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch { /* fall through */ }
  // Extract JSON array from surrounding text
  const match = text.match(/\[[\s\S]*\]/);
  if (match) {
    const parsed = JSON.parse(match[0]);
    return Array.isArray(parsed) ? parsed : [parsed];
  }
  throw new Error(`Could not parse response as JSON: ${text.slice(0, 200)}`);
}

async function extractFromFile(file: File): Promise<FileResult> {
  try {
    const content = await fileToContentParts(file);
    const raw = await callClaude(content);
    const invoices = parseInvoices(raw).map((inv) => ({
      ...inv,
      confidence: computeConfidence(inv),
    }));
    return { filename: file.name, invoices, error: null };
  } catch (err: unknown) {
    return {
      filename: file.name,
      invoices: [],
      error: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}

export async function extractInvoices(files: File[]): Promise<{
  batch_id: string;
  file_results: FileResult[];
  total_invoices: number;
}> {
  const batch_id = crypto.randomUUID();
  const file_results: FileResult[] = [];

  // Sequential to avoid rate limits
  for (const file of files) {
    file_results.push(await extractFromFile(file));
  }

  return {
    batch_id,
    file_results,
    total_invoices: file_results.reduce((s, r) => s + r.invoices.length, 0),
  };
}
