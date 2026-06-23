// Shared types for invoice extraction and display

// GSTIN first-2-digits → state name
export const GSTIN_STATE_MAP: Record<string, string> = {
  '01': 'J&K', '02': 'HP', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand',
  '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'UP', '10': 'Bihar',
  '11': 'Sikkim', '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur',
  '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'WB',
  '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'MP', '24': 'Gujarat',
  '25': 'Daman & Diu', '26': 'D&NH', '27': 'Maharashtra', '28': 'AP (old)', '29': 'Karnataka',
  '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry',
  '35': 'A&N Islands', '36': 'Telangana', '37': 'AP',
};

export function getStateFromGstin(gstin: string): string {
  if (!gstin || gstin.length < 2) return 'Unknown';
  return GSTIN_STATE_MAP[gstin.slice(0, 2)] || 'Unknown';
}

export const formatINR = (n: number): string =>
  n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export interface LineItem {
  description?: string;  // product/service name as printed on invoice
  hsn: string;
  gst_percent: number;
  uom: string;
  qty: number;
  rate: number;        // ex-GST, BEFORE discount
  disc_percent: number;
  amount?: number;     // printed amount from invoice (after discount, before GST)
}

export interface ExtraCharge {
  description: string;  // "Postage", "Freight", "Delivery Charges", etc.
  amount: number;
  gst_percent: number;  // usually 0
  sac?: string;         // SAC code for services (e.g. 9965 for freight)
  hsn?: string;         // HSN code if applicable
}

export interface ExtractedInvoice {
  vendor_name: string;
  vendor_gstin: string | null;
  vendor_address: string | null;
  buyer_name: string | null;
  buyer_gstin: string | null;
  invoice_number: string;
  invoice_date: string;
  line_items: LineItem[];
  subtotal: number;
  bill_discount_amount: number;            // 0 if none; deducted from subtotal before GST
  bill_discount_percent: number | null;    // % if percentage-based, null if fixed amount
  bill_discount_auto_detected?: boolean;   // true when server inferred discount from total mismatch
  cgst: number;
  sgst: number;
  igst: number;
  charges?: ExtraCharge[];   // freight, postage, delivery - excluded from HSN summary
  round_off: number;
  total: number;
  tax_type: 'cgst_sgst' | 'igst';
  confidence: number;
  confidence_reasons?: string[];
  is_gst_inclusive_amounts?: boolean;
  duplicate_of?: string;           // invoice_number of earlier copy (within-batch)
  duplicate_of_filename?: string;  // filename of that earlier copy
}

export interface ChunkWarning {
  chunk: number;
  pages: string;
  reason: string;
  invoices_recovered: number;
}

export interface FileResult {
  filename: string;
  invoices: ExtractedInvoice[];
  error: string | null;
  warnings?: ChunkWarning[];
  extraction_complete?: boolean;
}

export interface ExtractionResponse {
  batch_id: string;
  file_results: FileResult[];
  total_invoices: number;
  recovered?: boolean;
}

export interface Company {
  id: string;
  name: string;
  gstin?: string;
}

export type InvoiceStatus = 'pending_review' | 'accepted' | 'rejected';
export type InvoiceReadiness = 'ready' | 'warning' | 'critical';
export type ITCStatus = 'eligible' | 'potentially_ineligible' | 'not_applicable' | 'reviewed_eligible';

// Stored invoice row from Supabase (superset of ExtractedInvoice)
export interface StoredInvoice extends ExtractedInvoice {
  id: string;
  batch_id: string | null;
  company_id: string;
  filename: string;
  original_filename: string | null;
  upload_date: string | null;
  upload_time: string | null;
  status: InvoiceStatus;
  readiness: InvoiceReadiness;
  readiness_flags: string[] | null;
  financial_year: string | null;
  period_month: string | null;
  period_label: string | null;
  itc_status: ITCStatus | null;
  itc_remark: string | null;
  accepted_at: string | null;
  accepted_by: string | null;
  rejected_at: string | null;
  rejected_by: string | null;
  rejection_reason: string | null;
  converted_to_nongst: boolean;
  converted_nongst_ledger: string | null;
  supplier_master_id: string | null;
  ledger_master_id: string | null;
  tally_ledger_acceptance: {
    vendorLedger: string; purchaseLedger: string;
    cgstLedger: string; sgstLedger: string; igstLedger: string;
    roLedger: string;
    stock: Record<string, string>;
    charges: Record<string, string>;
  } | null;
}

export interface HsnRow {
  hsn: string;
  gst_percent: number;
  taxable: number;
  cgst: number;
  sgst: number;
  igst: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function calcLineAmount(item: LineItem): number {
  return r2(item.qty * item.rate * (1 - item.disc_percent / 100));
}

/**
 * Normalize a line item so that:
 *  - rate is always ≥ 0 (sign belongs to qty, never to rate)
 *  - amount is recomputed from qty × rate × (1 − disc/100)
 * Call this at every import/save boundary before storing or displaying.
 */
export function normalizeLineItem(item: LineItem): LineItem {
  const disc = item.disc_percent ?? 0;
  let qty = item.qty ?? 0;
  const rawAmount = item.amount ?? 0;

  // Rate must always be non-negative.
  let rate = Math.abs(item.rate ?? 0);

  // If amount is negative but qty is non-negative (zero or positive), this is a
  // return/credit adjustment: the sign must live on qty, never on rate.
  if (rawAmount < 0 && qty >= 0) {
    if (qty === 0) {
      // No physical movement — model as -1 unit.
      qty = -1;
      // Derive rate from |amount| if rate is missing/zero.
      if (rate === 0) rate = r2(Math.abs(rawAmount) / Math.max(1 - disc / 100, 0.001));
    } else {
      // Positive qty with negative amount — flip qty sign.
      qty = -qty;
    }
  }

  const amount = r2(qty * rate * (1 - disc / 100));
  return { ...item, qty, rate, amount };
}

function cleanHsn(hsn: string): string {
  return (hsn || '').replace(/[\s.]/g, '') || '-';
}

export function buildHsnSummary(items: LineItem[], taxType: 'cgst_sgst' | 'igst', billDiscount = 0): HsnRow[] {
  const map: Record<string, HsnRow> = {};
  for (const item of items) {
    const hsn = cleanHsn(item.hsn);
    const key = `${hsn}__${item.gst_percent}`;
    if (!map[key]) {
      map[key] = { hsn, gst_percent: item.gst_percent, taxable: 0, cgst: 0, sgst: 0, igst: 0 };
    }
    map[key].taxable += calcLineAmount(item);
  }

  // Pro-rate bill discount across HSN rows proportional to each row's share of total taxable.
  // Use Math.abs for the denominator so return invoices (negative totalTaxable) still apply
  // discount correctly — discount shares subtract from the absolute taxable value.
  const totalTaxable = Object.values(map).reduce((s, r) => s + r.taxable, 0);
  const absTotalTaxable = Math.abs(totalTaxable);
  for (const row of Object.values(map)) {
    const discountShare = absTotalTaxable > 0 && billDiscount > 0
      ? billDiscount * (row.taxable / totalTaxable)  // preserves sign; proportional to signed share
      : 0;
    row.taxable = r2(row.taxable - discountShare);
    const tax = r2(row.taxable * row.gst_percent / 100);
    if (taxType === 'cgst_sgst') {
      row.cgst = r2(tax / 2);
      row.sgst = r2(tax / 2);
    } else {
      row.igst = tax;
    }
  }

  return Object.values(map);
}

// Full tax summary including both HSN (line items) and SAC (charges) rows.
// Charges with gst_percent=0 but a SAC code are included with zero GST.
export function buildFullTaxSummary(
  items: LineItem[],
  charges: ExtraCharge[],
  taxType: 'cgst_sgst' | 'igst',
  billDiscount = 0,
): HsnRow[] {
  const rows = buildHsnSummary(items, taxType, billDiscount);
  for (const c of charges) {
    const code = (c.sac ?? c.hsn ?? '').trim();
    if (!code) continue;
    const tax = r2(c.amount * c.gst_percent / 100);
    rows.push({
      hsn: code,
      gst_percent: c.gst_percent,
      taxable: r2(c.amount),
      cgst: taxType === 'cgst_sgst' ? r2(tax / 2) : 0,
      sgst: taxType === 'cgst_sgst' ? r2(tax / 2) : 0,
      igst: taxType === 'igst' ? tax : 0,
    });
  }
  return rows;
}
