// Excel parser for Sales invoices (frontend-only, uses the xlsx library).
// Produces ExtractedInvoice objects with buyer_* = customer, vendor_* = our company.

import * as XLSX from 'xlsx';
import type { ExtractedInvoice, LineItem } from '@/types/invoice';

export interface ExcelImportResult {
  invoices: ExtractedInvoice[];
  errors: Array<{ row: number; reason: string }>;
  rowCount: number;
}

// Header alias map → canonical field name. Keys are normalised (lowercase, trimmed).
const HEADER_MAP: Record<string, string> = {
  'invoice number': 'invoice_number', 'invoice no': 'invoice_number', 'inv no': 'invoice_number',
  'invoice#': 'invoice_number', 'invoice #': 'invoice_number', 'invoiceno': 'invoice_number',
  'invoice date': 'invoice_date', 'date': 'invoice_date', 'inv date': 'invoice_date',
  'customer name': 'customer_name', 'party name': 'customer_name', 'buyer name': 'customer_name',
  'customer': 'customer_name',
  'customer gstin': 'customer_gstin', 'gstin': 'customer_gstin', 'buyer gstin': 'customer_gstin',
  'party gstin': 'customer_gstin',
  'item description': 'item_description', 'description': 'item_description', 'item name': 'item_description',
  'product': 'item_description',
  'hsn': 'hsn', 'hsn code': 'hsn', 'hsn-sac': 'hsn', 'hsn sac': 'hsn',
  'quantity': 'quantity', 'qty': 'quantity',
  'rate': 'rate', 'unit price': 'rate', 'price': 'rate',
  'taxable amount': 'taxable_amount', 'taxable value': 'taxable_amount', 'taxable': 'taxable_amount',
  'cgst amount': 'cgst_amount', 'cgst': 'cgst_amount', 'cgst amt': 'cgst_amount',
  'sgst amount': 'sgst_amount', 'sgst': 'sgst_amount', 'sgst amt': 'sgst_amount',
  'igst amount': 'igst_amount', 'igst': 'igst_amount', 'igst amt': 'igst_amount',
  'total': 'total_amount', 'total amount': 'total_amount', 'invoice total': 'total_amount',
  'invoice value': 'total_amount', 'grand total': 'total_amount',
};

function normHeader(h: string): string {
  return String(h ?? '').toLowerCase().trim().replace(/\s+/g, ' ');
}

const r2 = (n: number) => Math.round(n * 100) / 100;

function toNum(v: unknown): number {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return v;
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? 0 : n;
}

// Normalise a date value to YYYY-MM-DD. Supports YYYY-MM-DD, DD/MM/YYYY, DD-MM-YYYY,
// and Excel serial date numbers.
function parseDate(v: unknown): string {
  if (v == null || v === '') return '';
  // Excel serial number
  if (typeof v === 'number') {
    const d = XLSX.SSF ? XLSX.SSF.parse_date_code(v) : null;
    if (d) return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
  }
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (m) {
    const [, dd, mm, yyyy] = m;
    return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
  }
  // Last resort: let Date try
  const parsed = new Date(s);
  if (!isNaN(parsed.getTime())) {
    return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, '0')}-${String(parsed.getDate()).padStart(2, '0')}`;
  }
  return s;
}

interface ParsedRow {
  invoice_number: string;
  invoice_date: string;
  customer_name: string;
  customer_gstin: string;
  item_description: string;
  hsn: string;
  quantity: number;
  rate: number;
  taxable_amount: number;
  cgst_amount: number;
  sgst_amount: number;
  igst_amount: number;
  total_amount: number;
}

export async function parseExcelSalesFile(file: File): Promise<ExcelImportResult> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array', cellDates: false });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) return { invoices: [], errors: [{ row: 0, reason: 'No sheet found in file' }], rowCount: 0 };

  // Read as array-of-arrays so we control header mapping
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: false });
  if (aoa.length < 2) return { invoices: [], errors: [{ row: 0, reason: 'File has no data rows' }], rowCount: 0 };

  const headerRow = aoa[0].map((h) => normHeader(String(h)));
  const colMap: Record<number, string> = {};
  headerRow.forEach((h, idx) => {
    const field = HEADER_MAP[h];
    if (field) colMap[idx] = field;
  });

  const errors: ExcelImportResult['errors'] = [];
  const parsedRows: ParsedRow[] = [];

  for (let i = 1; i < aoa.length; i++) {
    const raw = aoa[i];
    if (!raw || raw.every((c) => c == null || c === '')) continue;
    const rowNum = i + 1;
    const rec: Record<string, unknown> = {};
    Object.entries(colMap).forEach(([idx, field]) => { rec[field] = raw[Number(idx)]; });

    const invoice_number = String(rec.invoice_number ?? '').trim();
    const customer_name = String(rec.customer_name ?? '').trim();
    if (!invoice_number) { errors.push({ row: rowNum, reason: 'Missing invoice number' }); continue; }
    if (!customer_name) { errors.push({ row: rowNum, reason: 'Missing customer name' }); continue; }

    parsedRows.push({
      invoice_number,
      invoice_date: parseDate(rec.invoice_date),
      customer_name,
      customer_gstin: String(rec.customer_gstin ?? '').trim().toUpperCase(),
      item_description: String(rec.item_description ?? '').trim(),
      hsn: String(rec.hsn ?? '').trim(),
      quantity: toNum(rec.quantity),
      rate: toNum(rec.rate),
      taxable_amount: toNum(rec.taxable_amount),
      cgst_amount: toNum(rec.cgst_amount),
      sgst_amount: toNum(rec.sgst_amount),
      igst_amount: toNum(rec.igst_amount),
      total_amount: toNum(rec.total_amount),
    });
  }

  // Group by invoice_number
  const groups = new Map<string, ParsedRow[]>();
  for (const row of parsedRows) {
    const key = row.invoice_number;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }

  const invoices: ExtractedInvoice[] = [];
  for (const [, rows] of Array.from(groups.entries())) {
    const first = rows[0];
    const cgst = r2(rows.reduce((s, r) => s + r.cgst_amount, 0));
    const sgst = r2(rows.reduce((s, r) => s + r.sgst_amount, 0));
    const igst = r2(rows.reduce((s, r) => s + r.igst_amount, 0));
    const tax_type: 'cgst_sgst' | 'igst' = igst > 0 && cgst === 0 && sgst === 0 ? 'igst' : 'cgst_sgst';
    const subtotal = r2(rows.reduce((s, r) => {
      const taxable = r.taxable_amount || r2(r.quantity * r.rate);
      return s + taxable;
    }, 0));

    const line_items: LineItem[] = rows.map((r) => {
      const taxable = r.taxable_amount || r2(r.quantity * r.rate);
      const rowTax = r.cgst_amount + r.sgst_amount + r.igst_amount;
      const gstPct = taxable > 0 ? Math.round((rowTax / taxable) * 100) : 0;
      const qty = r.quantity || 1;
      const rate = r.rate || (qty > 0 ? r2(taxable / qty) : taxable);
      return {
        description: r.item_description || '(item)',
        hsn: r.hsn,
        gst_percent: gstPct,
        uom: 'Nos',
        qty,
        rate,
        disc_percent: 0,
        amount: taxable,
      };
    });

    const explicitTotal = r2(rows.reduce((s, r) => s + r.total_amount, 0));
    const computedTotal = r2(subtotal + cgst + sgst + igst);
    const total = explicitTotal > 0 ? explicitTotal : computedTotal;
    const round_off = explicitTotal > 0 ? r2(explicitTotal - computedTotal) : 0;

    invoices.push({
      vendor_name: '', // filled by calling code with our company name
      vendor_gstin: null,
      vendor_address: null,
      buyer_name: first.customer_name,
      buyer_gstin: first.customer_gstin || null,
      invoice_number: first.invoice_number,
      invoice_date: first.invoice_date,
      line_items,
      subtotal,
      bill_discount_amount: 0,
      bill_discount_percent: null,
      cgst,
      sgst,
      igst,
      charges: [],
      round_off,
      total,
      tax_type,
      confidence: 0.95,
    });
  }

  return { invoices, errors, rowCount: parsedRows.length };
}
