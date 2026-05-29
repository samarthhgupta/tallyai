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
  hsn: string;
  gst_percent: number;
  uom: string;
  qty: number;
  rate: number;        // ex-GST, BEFORE discount
  disc_percent: number;
  amount?: number;     // printed amount from invoice (after discount, before GST)
}

export interface ExtractedInvoice {
  vendor_name: string;
  invoice_number: string;
  invoice_date: string;
  vendor_gstin: string | null;
  vendor_address: string | null;
  line_items: LineItem[];
  subtotal: number;
  cgst: number;
  sgst: number;
  igst: number;
  round_off: number;
  total: number;
  tax_type: 'cgst_sgst' | 'igst';
  confidence: number;
  confidence_reasons?: string[];
}

export interface FileResult {
  filename: string;
  invoices: ExtractedInvoice[];
  error: string | null;
}

export interface ExtractionResponse {
  batch_id: string;
  file_results: FileResult[];
  total_invoices: number;
}

export interface Company {
  id: string;
  name: string;
  gstin?: string;
}

export interface HsnRow {
  hsn: string;
  gst_percent: number;
  taxable: number;
  cgst: number;
  sgst: number;
  igst: number;
}

export function calcLineAmount(item: LineItem): number {
  return item.qty * item.rate * (1 - item.disc_percent / 100);
}

export function buildHsnSummary(items: LineItem[], taxType: 'cgst_sgst' | 'igst'): HsnRow[] {
  const map: Record<string, HsnRow> = {};
  for (const item of items) {
    const key = `${item.hsn}__${item.gst_percent}`;
    if (!map[key]) {
      map[key] = { hsn: item.hsn || '—', gst_percent: item.gst_percent, taxable: 0, cgst: 0, sgst: 0, igst: 0 };
    }
    const amt = calcLineAmount(item);
    const tax = amt * item.gst_percent / 100;
    map[key].taxable += amt;
    if (taxType === 'cgst_sgst') {
      map[key].cgst += tax / 2;
      map[key].sgst += tax / 2;
    } else {
      map[key].igst += tax;
    }
  }
  return Object.values(map);
}
