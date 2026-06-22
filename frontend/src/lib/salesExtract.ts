// Excel parser for Sales invoices (frontend-only, uses the xlsx library).
// Produces ExtractedInvoice objects with buyer_* = customer, vendor_* = our company.
//
// Two parse modes:
//   flat         – one row per invoice (POS exports, ERP exports, simple CSVs)
//   hierarchical – invoice header row + multiple item continuation rows
//                  (GSTR-1 reports, Tally exports, Marg/Busy exports, any sparse layout)
//
// Mode is chosen automatically by detectFormat(). The public API
// parseExcelSalesFile() is unchanged.

import * as XLSX from 'xlsx';
import type { ExtractedInvoice, LineItem } from '@/types/invoice';

export interface ExcelImportResult {
  invoices: ExtractedInvoice[];
  errors: Array<{ row: number; reason: string }>;
  rowCount: number;
}

// ─── Shared utilities ─────────────────────────────────────────────────────────

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

function parseDate(v: unknown): string {
  if (v == null || v === '') return '';
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
  const parsed = new Date(s);
  if (!isNaN(parsed.getTime())) {
    return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, '0')}-${String(parsed.getDate()).padStart(2, '0')}`;
  }
  return s;
}

// ─── Header alias map ─────────────────────────────────────────────────────────

const HEADER_MAP: Record<string, string> = {
  // Invoice number
  'invoice number': 'invoice_number', 'invoice no': 'invoice_number', 'invoice no.': 'invoice_number',
  'inv no': 'invoice_number', 'invoice#': 'invoice_number', 'invoice #': 'invoice_number',
  'invoiceno': 'invoice_number',
  // Invoice date
  'invoice date': 'invoice_date', 'date': 'invoice_date', 'inv date': 'invoice_date',
  // Customer
  'customer name': 'customer_name', 'party name': 'customer_name', 'buyer name': 'customer_name',
  'customer': 'customer_name', 'desc': 'customer_name', 'description': 'customer_name',
  // GSTIN
  'customer gstin': 'customer_gstin', 'gstin': 'customer_gstin', 'buyer gstin': 'customer_gstin',
  'party gstin': 'customer_gstin',
  // Item / HSN
  'item description': 'item_description', 'item name': 'item_description', 'product': 'item_description',
  'hsn': 'hsn', 'hsn code': 'hsn', 'hsn-sac': 'hsn', 'hsn sac': 'hsn',
  // Quantity / Rate
  'quantity': 'quantity', 'qty': 'quantity',
  'rate': 'rate', 'unit price': 'rate', 'price': 'rate',
  // Amounts
  'taxable amount': 'taxable_amount', 'taxable value': 'taxable_amount', 'taxable': 'taxable_amount',
  'amount': 'taxable_amount',
  'cgst amount': 'cgst_amount', 'cgst': 'cgst_amount', 'cgst amt': 'cgst_amount',
  'sgst amount': 'sgst_amount', 'sgst': 'sgst_amount', 'sgst amt': 'sgst_amount',
  'igst amount': 'igst_amount', 'igst': 'igst_amount', 'igst amt': 'igst_amount',
  'total': 'total_amount', 'total amount': 'total_amount', 'invoice total': 'total_amount',
  'invoice value': 'total_amount', 'grand total': 'total_amount',
};

// Keywords used to score header row candidates
const HEADER_KEYWORDS = [
  'invoice', 'date', 'gstin', 'hsn', 'taxable', 'cgst', 'sgst', 'igst',
  'total', 'qty', 'amount', 'customer', 'party', 'desc', 'product', 'rate', 'quantity',
];

// Section header markers — rows containing only these are skipped in hierarchical mode
const SECTION_MARKERS = [
  'b2b', 'b2c', 'nil rated', 'exempted', 'export invoice', 'gross total',
  'tax liability', 'set/off', 'advance',
];

// ─── ColumnProfile ─────────────────────────────────────────────────────────────
// Describes how to read fields from rows in a specific file.
// Future: load from pos_import_profiles table instead of deriving at runtime.

interface ColumnProfile {
  dataStartRow: number;          // first row index that contains data (0-based)
  fields: Record<number, string>; // colIndex → canonical field name
  invoiceNumCol: number;          // column index of invoice_number (-1 if not found)
}

// ─── Format detection ─────────────────────────────────────────────────────────

type ParseFormat = 'flat' | 'hierarchical';

function detectFormat(aoa: unknown[][]): ParseFormat {
  // Find the best candidate for the header row first (needed to know invoice_number col)
  const profile = findHeaderRow(aoa);
  const invCol = profile.invoiceNumCol;
  if (invCol === -1) return 'flat'; // can't detect without knowing invoice col

  // Scan data rows: count continuation rows (invoice col empty, ≥2 other non-empty transactional values)
  let continuationCount = 0;
  const scanLimit = Math.min(aoa.length, profile.dataStartRow + 30);
  for (let i = profile.dataStartRow; i < scanLimit; i++) {
    const row = aoa[i];
    if (!row) continue;
    const invVal = String(row[invCol] ?? '').trim();
    if (invVal) continue; // anchor row, skip

    // Count non-empty, non-whitespace values in this row (excluding the invoice col)
    let nonEmptyCount = 0;
    for (let c = 0; c < row.length; c++) {
      if (c === invCol) continue;
      const v = row[c];
      if (v != null && v !== '' && v !== 0) nonEmptyCount++;
    }
    if (nonEmptyCount >= 2) continuationCount++;
  }

  // Also check for explicit section markers in first 15 rows
  let sectionMarkerFound = false;
  for (let i = 0; i < Math.min(15, aoa.length); i++) {
    const row = aoa[i];
    for (const cell of (row ?? [])) {
      const s = String(cell ?? '').toLowerCase().trim();
      if (SECTION_MARKERS.some((m) => s.includes(m))) { sectionMarkerFound = true; break; }
    }
    if (sectionMarkerFound) break;
  }

  return continuationCount >= 3 || sectionMarkerFound ? 'hierarchical' : 'flat';
}

// ─── Header row finder ────────────────────────────────────────────────────────

function findHeaderRow(aoa: unknown[][]): ColumnProfile {
  const scanLimit = Math.min(aoa.length, 15);
  let bestRow = 0;
  let bestScore = 0;

  for (let i = 0; i < scanLimit; i++) {
    const row = aoa[i];
    if (!row) continue;
    let score = 0;
    for (const cell of row) {
      const s = normHeader(String(cell ?? ''));
      for (const kw of HEADER_KEYWORDS) {
        if (s.includes(kw)) { score++; break; }
      }
    }
    if (score > bestScore) { bestScore = score; bestRow = i; }
  }

  if (bestScore < 2) {
    // No recognisable header found — assume row 0 and let the caller decide
    return buildProfile(aoa, 0);
  }

  // Check if the next row looks like a sub-header (all short strings, no numerics)
  const nextRow = aoa[bestRow + 1];
  const isSubHeader = nextRow && nextRow.every((c) => {
    if (c == null || c === '') return true;
    if (typeof c === 'number') return false;
    return String(c).trim().length <= 10;
  });

  if (isSubHeader) {
    // Merge two header rows. Handles the Excel merged-cell tax pattern where:
    //   primary row:  …SGST   null   CGST   null   IGST   null…
    //   sub row:      …%age  Amount  %age  Amount  %age  Amount…
    // Strategy: when primary is blank/null but sub is 'amount', look left for the
    // nearest tax name and emit '<taxname> amount'. Blank out %age columns.
    const primaryCells = aoa[bestRow] as unknown[];
    const merged: string[] = primaryCells.map(() => '');
    const taxNames = ['sgst', 'cgst', 'igst', 'cess'];
    let lastTaxName = '';

    for (let idx = 0; idx < primaryCells.length; idx++) {
      const pri = normHeader(String(primaryCells[idx] ?? ''));
      const sub = normHeader(String((nextRow[idx] ?? '')));

      if (taxNames.includes(pri)) {
        lastTaxName = pri;
        // %age column — leave blank
        merged[idx] = '';
      } else if (!pri && sub === 'amount' && lastTaxName) {
        // Amount sub-column after a tax name
        merged[idx] = `${lastTaxName} amount`;
        lastTaxName = ''; // consumed
      } else {
        lastTaxName = ''; // reset on non-tax, non-amount cell
        if (HEADER_MAP[pri]) merged[idx] = pri;
        else if (HEADER_MAP[sub]) merged[idx] = sub;
        else merged[idx] = pri.length >= sub.length ? pri : sub;
      }
    }
    return buildProfileFromNormed(merged, bestRow + 2);
  }

  return buildProfile(aoa, bestRow);
}

function buildProfile(aoa: unknown[][], headerRowIndex: number): ColumnProfile {
  const normed = (aoa[headerRowIndex] ?? []).map((h) => normHeader(String(h ?? '')));
  return buildProfileFromNormed(normed, headerRowIndex + 1);
}

function buildProfileFromNormed(normed: string[], dataStartRow: number): ColumnProfile {
  const fields: Record<number, string> = {};
  let invoiceNumCol = -1;
  normed.forEach((h, idx) => {
    const field = HEADER_MAP[h];
    if (field) {
      fields[idx] = field;
      if (field === 'invoice_number') invoiceNumCol = idx;
    }
  });
  return { dataStartRow, fields, invoiceNumCol };
}

// ─── Section header / summary row detection ───────────────────────────────────

function isSectionOrSummaryRow(row: unknown[], profile: ColumnProfile): boolean {
  // Has no invoice number
  const invVal = String(row[profile.invoiceNumCol] ?? '').trim();
  if (invVal) return false;

  // Count non-empty cells total
  const nonEmpty = row.filter((c) => c != null && c !== '' && c !== 0);
  // A row with multiple values but no invoice number is either a totals/summary row
  // (all numeric) or an unrecognised continuation — treat as section boundary either way.
  if (nonEmpty.length > 1) {
    const allNumeric = nonEmpty.every((c) => typeof c === 'number' || !isNaN(Number(String(c).replace(/,/g, ''))));
    if (allNumeric) return true; // totals row — treat as section boundary
    return false; // has mixed data — genuine continuation row
  }

  // Single-cell row: check if it matches a section marker
  for (const cell of row) {
    const s = String(cell ?? '').toLowerCase().trim();
    if (s && SECTION_MARKERS.some((m) => s.includes(m))) return true;
  }

  return nonEmpty.length === 0; // fully blank row
}

// ─── Shared invoice assembly ──────────────────────────────────────────────────

interface InvoiceRow {
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

function assembleInvoices(groups: Map<string, InvoiceRow[]>): ExtractedInvoice[] {
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
      // Use abs(taxable) so return lines (negative taxable) still yield the correct GST %.
      const gstPct = taxable !== 0 ? Math.round((Math.abs(rowTax) / Math.abs(taxable)) * 100) : 0;
      const qty = r.quantity || 1;
      // Rate must always be non-negative. Sign belongs to qty.
      // taxable / qty gives the correct positive rate for both regular and return lines:
      //   normal:  taxable=100, qty=2  → rate=50   ✓
      //   return:  taxable=-100, qty=-1 → rate=100  ✓
      // Fall back to abs(taxable) when qty is zero (degenerate row).
      const rawRate = r.rate || (qty !== 0 ? r2(taxable / qty) : Math.abs(taxable));
      const rate = Math.abs(rawRate); // guard: rate is never negative
      return {
        description: r.item_description || (r.hsn?.trim() ? r.hsn.trim() : 'UNKNOWN ITEM'),
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
      vendor_name: '',
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
  return invoices;
}

// ─── Flat parser (original logic, unchanged) ──────────────────────────────────

function parseFlat(aoa: unknown[][]): ExcelImportResult {
  if (aoa.length < 2) return { invoices: [], errors: [{ row: 0, reason: 'File has no data rows' }], rowCount: 0 };

  const headerRow = (aoa[0] as unknown[]).map((h) => normHeader(String(h)));
  const colMap: Record<number, string> = {};
  headerRow.forEach((h, idx) => { const f = HEADER_MAP[h]; if (f) colMap[idx] = f; });

  const errors: ExcelImportResult['errors'] = [];
  const parsedRows: InvoiceRow[] = [];

  for (let i = 1; i < aoa.length; i++) {
    const raw = aoa[i] as unknown[];
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

  const groups = new Map<string, InvoiceRow[]>();
  for (const row of parsedRows) {
    if (!groups.has(row.invoice_number)) groups.set(row.invoice_number, []);
    groups.get(row.invoice_number)!.push(row);
  }

  return { invoices: assembleInvoices(groups), errors, rowCount: parsedRows.length };
}

// ─── Hierarchical parser ──────────────────────────────────────────────────────

function parseHierarchical(aoa: unknown[][]): ExcelImportResult {
  const profile = findHeaderRow(aoa);
  if (profile.invoiceNumCol === -1) {
    return { invoices: [], errors: [{ row: 0, reason: 'Could not locate invoice number column' }], rowCount: 0 };
  }

  const errors: ExcelImportResult['errors'] = [];
  const groups = new Map<string, InvoiceRow[]>();

  // Carry-forward state
  let anchorInvoiceNumber = '';
  let anchorDate = '';
  let anchorCustomerName = '';
  let anchorGstin = '';
  let anchorTotal = 0;
  let rowCount = 0;

  for (let i = profile.dataStartRow; i < aoa.length; i++) {
    const raw = aoa[i] as unknown[];
    if (!raw || raw.every((c) => c == null || c === '' || c === 0)) continue;

    // Build rec first so we can inspect item-level fields before boundary detection
    const rec: Record<string, unknown> = {};
    Object.entries(profile.fields).forEach(([idx, field]) => { rec[field] = raw[Number(idx)]; });

    const invoiceNum = String(rec.invoice_number ?? '').trim();
    const recHsn     = String(rec.hsn ?? '').trim();
    const recDesc    = String(rec.item_description ?? '').trim();

    // Only treat as section boundary when the row has no item-level identifier.
    // Continuation rows with a numeric-looking HSN (e.g. "63041910") are
    // incorrectly classified as all-numeric by isSectionOrSummaryRow — guard here.
    if (!invoiceNum && !recHsn && !recDesc && isSectionOrSummaryRow(raw, profile)) {
      anchorInvoiceNumber = '';
      continue;
    }

    if (invoiceNum) {
      // ── Anchor row ──
      const customerName = String(rec.customer_name ?? '').trim();
      if (!customerName) {
        errors.push({ row: i + 1, reason: `Invoice ${invoiceNum}: missing customer name` });
        // Still process — use a placeholder so continuation rows attach correctly
      }
      anchorInvoiceNumber = invoiceNum;
      anchorDate = parseDate(rec.invoice_date);
      anchorCustomerName = customerName || '(unknown)';
      anchorGstin = String(rec.customer_gstin ?? '').trim().toUpperCase();
      anchorTotal = toNum(rec.total_amount);

      if (!groups.has(anchorInvoiceNumber)) groups.set(anchorInvoiceNumber, []);
    } else if (!anchorInvoiceNumber) {
      // Data row before any anchor — skip
      continue;
    }

    // Determine if this row has any transactional value worth adding as a line item
    const taxable = toNum(rec.taxable_amount);
    const cgstAmt = toNum(rec.cgst_amount);
    const sgstAmt = toNum(rec.sgst_amount);
    const igstAmt = toNum(rec.igst_amount);
    const qty = toNum(rec.quantity);
    const rate = toNum(rec.rate);

    const hasValue = taxable !== 0 || cgstAmt !== 0 || sgstAmt !== 0 || igstAmt !== 0 || (qty !== 0 && rate !== 0);
    if (!hasValue) continue; // row with no financial data (e.g. sub-totals showing only count)

    rowCount++;
    groups.get(anchorInvoiceNumber)!.push({
      invoice_number: anchorInvoiceNumber,
      invoice_date: anchorDate,
      customer_name: anchorCustomerName,
      customer_gstin: anchorGstin,
      item_description: String(rec.item_description ?? '').trim(),
      hsn: String(rec.hsn ?? '').trim(),
      quantity: qty,
      rate,
      taxable_amount: taxable,
      cgst_amount: cgstAmt,
      sgst_amount: sgstAmt,
      igst_amount: igstAmt,
      // Only the anchor row carries the invoice total; continuation rows carry 0
      total_amount: invoiceNum ? anchorTotal : 0,
    });
  }

  // For each invoice, keep only the anchor's total (already on first row in group)
  // The assembleInvoices function handles this correctly via explicitTotal on first row.

  return { invoices: assembleInvoices(groups), errors, rowCount };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function parseExcelSalesFile(file: File): Promise<ExcelImportResult> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array', cellDates: false });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) return { invoices: [], errors: [{ row: 0, reason: 'No sheet found in file' }], rowCount: 0 };

  const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: false });
  if (aoa.length < 2) return { invoices: [], errors: [{ row: 0, reason: 'File has no data rows' }], rowCount: 0 };

  const format = detectFormat(aoa);
  return format === 'hierarchical' ? parseHierarchical(aoa) : parseFlat(aoa);
}
