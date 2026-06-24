import * as XLSX from 'xlsx';
import type { ExtractedInvoice, FileResult } from '@/types/invoice';
import { calcLineAmount, buildHsnSummary, GSTIN_STATE_MAP } from '@/types/invoice';

function r2(n: number) {
  return n === 0 ? 0 : Math.sign(n) * Math.round(Math.abs(n) * 100) / 100;
}

// SAC mapping for additional charges (mirrors InvoiceCard CHARGE_TYPES)
const CHARGE_SAC_MAP: Record<string, string> = {
  'freight': '9965', 'freight charges': '9965', 'freight & forwarding charges': '9965',
  'f&f charges': '9965', 'transport charges': '9965', 'transportation charges': '9965',
  'delivery charges': '9965', 'builty charges': '9965', 'lr charges': '9965',
  'lorry charges': '9965', 'cartage charges': '9965',
  'postage': '9968', 'postal charges': '9968', 'courier charges': '9968',
  'courier service': '9968', 'dispatch charges': '9968', 'shipping charges': '9968',
  'shipping service': '9968',
};
function sacForCharge(desc: string): string {
  return CHARGE_SAC_MAP[desc.toLowerCase()] ?? '';
}

// Full state names for Place of Supply column (GSTR-2B format)
const FULL_STATE_NAME: Record<string, string> = {
  '01': 'Jammu & Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab',
  '04': 'Chandigarh', '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi',
  '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim',
  '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram',
  '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal',
  '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh',
  '23': 'Madhya Pradesh', '24': 'Gujarat', '25': 'Daman & Diu',
  '26': 'Dadra & Nagar Haveli', '27': 'Maharashtra', '28': 'Andhra Pradesh (old)',
  '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala',
  '33': 'Tamil Nadu', '34': 'Puducherry', '35': 'A&N Islands',
  '36': 'Telangana', '37': 'Andhra Pradesh',
};

function placeOfSupply(inv: ExtractedInvoice): string {
  const gstin = inv.buyer_gstin ?? inv.vendor_gstin ?? '';
  if (!gstin || gstin.length < 2) return '';
  return FULL_STATE_NAME[gstin.slice(0, 2)] ?? '';
}

// ─── Shared invoice calculations ──────────────────────────────────────────────
// Mirrors InvoiceCard: GST-applicable charges merge into taxable value;
// non-GST charges are pass-through additions shown after taxes.

interface InvCalc {
  computedSubtotal: number;
  billDiscount: number;
  taxableValue: number;          // goods only (after discount)
  gstChargesAmount: number;      // charges with gst_percent > 0
  nonGstChargesAmount: number;   // charges with gst_percent === 0
  totalTaxableValue: number;     // taxableValue + gstChargesAmount (matches dashboard "Total Taxable Value")
  allCGST: number;               // CGST on goods + GST charges
  allSGST: number;
  allIGST: number;
  excelRoundOff: number;         // adjusted round-off matching dashboard reconciliation display
  excelTotal: number;            // inv.total when available (matches dashboard Final Invoice Value)
  hsnRows: ReturnType<typeof buildHsnSummary>;
  chargeHsnRows: { hsn: string; gst_percent: number; taxable: number; cgst: number; sgst: number; igst: number }[];
}

function calcInv(inv: ExtractedInvoice): InvCalc {
  const billDiscount = inv.bill_discount_amount ?? 0;
  const hsnRows = buildHsnSummary(inv.line_items, inv.tax_type, billDiscount);
  const computedSubtotal = inv.line_items.reduce((s, it) => s + calcLineAmount(it), 0);
  const taxableValue = computedSubtotal - billDiscount;
  const invCharges = inv.charges ?? [];

  // Split charges by GST status
  const gstChargesAmount = invCharges.filter(c => c.gst_percent > 0).reduce((s, c) => s + c.amount, 0);
  const nonGstChargesAmount = invCharges.filter(c => c.gst_percent === 0).reduce((s, c) => s + c.amount, 0);
  const totalTaxableValue = taxableValue + gstChargesAmount;

  // Charge HSN rows for GST-carrying charges
  const chargeHsnRows = invCharges.filter(c => c.gst_percent > 0).map(c => {
    const tax = r2(c.amount * c.gst_percent / 100);
    const sac = sacForCharge(c.description) || c.description;
    return {
      hsn: sac,
      gst_percent: c.gst_percent,
      taxable: c.amount,
      cgst: inv.tax_type === 'cgst_sgst' ? r2(tax / 2) : 0,
      sgst: inv.tax_type === 'cgst_sgst' ? r2(tax / 2) : 0,
      igst: inv.tax_type === 'igst' ? tax : 0,
    };
  });

  // All-in GST totals (goods + GST-carrying charges) - matches dashboard Tax Summary TOTAL row
  const allCGST = hsnRows.reduce((s, r) => s + r.cgst, 0) + chargeHsnRows.reduce((s, r) => s + r.cgst, 0);
  const allSGST = hsnRows.reduce((s, r) => s + r.sgst, 0) + chargeHsnRows.reduce((s, r) => s + r.sgst, 0);
  const allIGST = hsnRows.reduce((s, r) => s + r.igst, 0) + chargeHsnRows.reduce((s, r) => s + r.igst, 0);

  // Replicate the dashboard reconciliation IIFE logic so Excel matches what the user sees.
  // excelBase = everything except round-off (= recoBase in InvoiceCard).
  const excelBase = totalTaxableValue + nonGstChargesAmount + r2(allCGST) + r2(allSGST) + r2(allIGST);
  const invTotal = inv.total ?? 0;
  const rawRoundOff = r2(inv.round_off ?? 0);
  const useInvTotal = invTotal > 0 && Math.abs(invTotal - excelBase - rawRoundOff) <= 2;
  const excelRoundOff = useInvTotal ? r2(invTotal - excelBase) : rawRoundOff;
  const excelTotal = useInvTotal ? invTotal : r2(excelBase + excelRoundOff);

  return {
    computedSubtotal, billDiscount, taxableValue,
    gstChargesAmount, nonGstChargesAmount, totalTaxableValue,
    allCGST, allSGST, allIGST,
    excelRoundOff, excelTotal,
    hsnRows, chargeHsnRows,
  };
}

// Group HSN rows by GST rate - used for GSTR-2B format (one row per rate slab)
interface RateSlab {
  rate: number;
  taxable: number;
  igst: number;
  cgst: number;
  sgst: number;
}

function buildRateSlabs(inv: ExtractedInvoice): RateSlab[] {
  const billDiscount = inv.bill_discount_amount ?? 0;
  const hsnRows = buildHsnSummary(inv.line_items, inv.tax_type, billDiscount);
  const map: Record<number, RateSlab> = {};
  for (const row of hsnRows) {
    if (!map[row.gst_percent]) {
      map[row.gst_percent] = { rate: row.gst_percent, taxable: 0, igst: 0, cgst: 0, sgst: 0 };
    }
    map[row.gst_percent].taxable += row.taxable;
    map[row.gst_percent].igst += row.igst;
    map[row.gst_percent].cgst += row.cgst;
    map[row.gst_percent].sgst += row.sgst;
  }
  // Include additional charges in the rate slabs (0% charges also included)
  for (const c of inv.charges ?? []) {
    const gst = c.gst_percent;
    const tax = r2(c.amount * gst / 100);
    if (!map[gst]) {
      map[gst] = { rate: gst, taxable: 0, igst: 0, cgst: 0, sgst: 0 };
    }
    map[gst].taxable += c.amount;
    if (inv.tax_type === 'cgst_sgst') {
      map[gst].cgst += tax / 2;
      map[gst].sgst += tax / 2;
    } else {
      map[gst].igst += tax;
    }
  }
  return Object.values(map).sort((a, b) => b.rate - a.rate);
}

// Build the GSTR-2B style rows for one invoice (no header - header added once at top)
function gstReconInvoiceRows(inv: ExtractedInvoice, filename?: string): unknown[][] {
  const slabs = buildRateSlabs(inv);
  const gstin = inv.vendor_gstin ?? '';
  const vendor = inv.vendor_name ?? '';
  const invNo = inv.invoice_number ?? '';
  const date = inv.invoice_date ?? '';
  const pos = placeOfSupply(inv);
  const rows: unknown[][] = [];

  let totalTaxable = 0, totalIgst = 0, totalCgst = 0, totalSgst = 0;

  for (const slab of slabs) {
    const t = r2(slab.taxable);
    const ig = r2(slab.igst);
    const cg = r2(slab.cgst);
    const sg = r2(slab.sgst);
    const invValue = r2(t + ig + cg + sg);
    totalTaxable += t;
    totalIgst += ig;
    totalCgst += cg;
    totalSgst += sg;
    rows.push([gstin, vendor, invNo, date, invValue, pos, slab.rate, t, ig, cg, sg, 0]);
  }

  // Total row
  const totTaxable = r2(totalTaxable);
  const totIgst = r2(totalIgst);
  const totCgst = r2(totalCgst);
  const totSgst = r2(totalSgst);
  const totValue = r2(totTaxable + totIgst + totCgst + totSgst);
  rows.push([gstin, vendor, `${invNo}-Total`, date, totValue, pos, '-', totTaxable, totIgst, totCgst, totSgst, 0]);

  // Blank separator
  rows.push(new Array(12).fill(null));

  return rows;
}

// Build complete GSTR-2B worksheet (header + all invoice rows)
function buildGstReconSheet(invoices: { inv: ExtractedInvoice }[]): XLSX.WorkSheet {
  // Two-row header
  const headerRow1 = [
    'GSTIN of supplier',
    'Trade/Legal name of the Supplier',
    'Invoice details', null, null,    // C1:E1 merged
    'Place of supply',
    'Rate (%)',
    'Taxable Value (₹)',
    'Tax Amount', null, null, null,   // I1:L1 merged
  ];
  const headerRow2 = [
    null, null,
    'Invoice number', 'Invoice Date', 'Invoice Value (₹)',
    null, null, null,
    'Integrated Tax (₹)', 'Central Tax (₹)', 'State/UT tax (₹)', 'Cess (₹)',
  ];

  const aoa: unknown[][] = [headerRow1, headerRow2];
  for (const { inv } of invoices) {
    aoa.push(...gstReconInvoiceRows(inv));
  }

  const ws = XLSX.utils.aoa_to_sheet(aoa);

  // Merged cells (0-indexed rows/cols)
  ws['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 1, c: 0 } },   // A1:A2
    { s: { r: 0, c: 1 }, e: { r: 1, c: 1 } },   // B1:B2
    { s: { r: 0, c: 2 }, e: { r: 0, c: 4 } },   // C1:E1
    { s: { r: 0, c: 5 }, e: { r: 1, c: 5 } },   // F1:F2
    { s: { r: 0, c: 6 }, e: { r: 1, c: 6 } },   // G1:G2
    { s: { r: 0, c: 7 }, e: { r: 1, c: 7 } },   // H1:H2
    { s: { r: 0, c: 8 }, e: { r: 0, c: 11 } },  // I1:L1
  ];

  // Column widths
  ws['!cols'] = [
    { wch: 18 }, // A GSTIN
    { wch: 30 }, // B Vendor Name
    { wch: 20 }, // C Invoice #
    { wch: 13 }, // D Date
    { wch: 16 }, // E Invoice Value
    { wch: 18 }, // F Place of Supply
    { wch: 9  }, // G Rate%
    { wch: 16 }, // H Taxable Value
    { wch: 16 }, // I IGST
    { wch: 16 }, // J CGST
    { wch: 16 }, // K SGST
    { wch: 10 }, // L Cess
  ];

  return ws;
}

// ─── Per-invoice sheet helpers ─────────────────────────────────────────────────

function invoiceSheets(inv: ExtractedInvoice) {
  const {
    computedSubtotal, billDiscount, taxableValue,
    gstChargesAmount, nonGstChargesAmount, totalTaxableValue,
    allCGST, allSGST, allIGST,
    excelRoundOff, excelTotal,
    hsnRows, chargeHsnRows,
  } = calcInv(inv);

  const charges = inv.charges ?? [];

  const header = [
    ['Field', 'Value'],
    ['Vendor Name', inv.vendor_name],
    ['Vendor GSTIN', inv.vendor_gstin ?? ''],
    ['Vendor Address', inv.vendor_address ?? ''],
    ['Buyer Name', inv.buyer_name ?? ''],
    ['Buyer GSTIN', inv.buyer_gstin ?? ''],
    ['Invoice Number', inv.invoice_number],
    ['Invoice Date', inv.invoice_date],
    ['Tax Type', inv.tax_type === 'cgst_sgst' ? 'CGST + SGST' : 'IGST'],
    [''],
    ['Subtotal', r2(computedSubtotal)],
    ['Bill Discount', r2(billDiscount)],
    // totalTaxableValue matches dashboard "Total Taxable Value" (includes GST-applicable charges)
    ['Taxable Value', r2(totalTaxableValue)],
    inv.tax_type === 'cgst_sgst' ? ['CGST', r2(allCGST)] : ['IGST', r2(allIGST)],
    inv.tax_type === 'cgst_sgst' ? ['SGST', r2(allSGST)] : ['', ''],
    // Only non-GST charges shown separately; GST charges already in Taxable Value
    ['Additional Charges (Non-GST)', r2(nonGstChargesAmount)],
    ['Round Off', excelRoundOff],
    ['Total', excelTotal],
    ['Confidence', `${Math.round(inv.confidence * 100)}%`],
  ];

  // All Line Items - Issue 3: split "Description / HSN" into "Description" + "Ledger Name"
  const lineItemRows: unknown[][] = [
    ['S.No.', 'Description', 'Ledger Name', 'GST%', 'UOM', 'Qty', 'Rate (ex-GST)', 'Disc%', 'Amount'],
    ...inv.line_items.map((it, i) => {
      const hsn = it.hsn.replace(/[\s.]/g, '') || '-';
      return [
        i + 1,
        it.description || '-',
        `${hsn} @ ${it.gst_percent}%`,
        it.gst_percent,
        it.uom || '-',
        it.qty,
        r2(it.rate),
        it.disc_percent,
        r2(calcLineAmount(it)),
      ];
    }),
    ['', '', '', '', '', '', '', 'Subtotal', r2(computedSubtotal)],
    // Charge rows (all charges included for full picture)
    ...charges.map((c, i) => {
      const sac = sacForCharge(c.description);
      const ledger = `${sac || c.description} @ ${c.gst_percent}%`;
      return [
        inv.line_items.length + i + 1,
        c.description,
        ledger,
        c.gst_percent,
        '-',
        1,
        r2(c.amount),
        0,
        r2(c.amount),
      ];
    }),
    ...(charges.length > 0 ? [['', '', '', '', '', '', '', 'Charges Total', r2(charges.reduce((s, c) => s + c.amount, 0))]] : []),
    ['', '', '', '', '', '', '', 'Total Taxable', r2(totalTaxableValue)],
  ];

  const allHsnRows = [...hsnRows, ...chargeHsnRows];

  const hsnSummaryRows = [
    ['HSN / SAC', 'Description', 'GST%', 'Taxable', 'CGST', 'SGST', 'IGST'],
    ...hsnRows.map((r) => [
      r.hsn, '-', r.gst_percent, r2(r.taxable), r2(r.cgst), r2(r.sgst), r2(r.igst),
    ]),
    ...chargeHsnRows.map((r) => {
      const desc = charges.find((c) => sacForCharge(c.description) === r.hsn || c.description === r.hsn)?.description ?? '-';
      return [r.hsn, desc, r.gst_percent, r2(r.taxable), r2(r.cgst), r2(r.sgst), r2(r.igst)];
    }),
    [
      'Total', '', '',
      r2(allHsnRows.reduce((s, r) => s + r.taxable, 0)),
      r2(allHsnRows.reduce((s, r) => s + r.cgst, 0)),
      r2(allHsnRows.reduce((s, r) => s + r.sgst, 0)),
      r2(allHsnRows.reduce((s, r) => s + r.igst, 0)),
    ],
  ];

  return { header, lineItemRows, hsnSummaryRows, charges: inv.charges ?? [] };
}

// ─── Public exports ────────────────────────────────────────────────────────────

export function downloadInvoiceExcel(inv: ExtractedInvoice) {
  const wb = XLSX.utils.book_new();
  const { header, lineItemRows, hsnSummaryRows, charges } = invoiceSheets(inv);

  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(header), 'Invoice');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(lineItemRows), 'Line Items');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(hsnSummaryRows), 'HSN Summary');
  if (charges.length > 0) {
    const chargeRows = [
      ['Description', 'GST%', 'Amount'],
      ...charges.map((c) => [c.description, c.gst_percent, r2(c.amount)]),
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(chargeRows), 'Charges');
  }
  // GSTR-2B reconciliation sheet
  XLSX.utils.book_append_sheet(wb, buildGstReconSheet([{ inv }]), 'GST Reconciliation');

  const safeName = (inv.vendor_name || 'Invoice').replace(/[^a-zA-Z0-9 _-]/g, '').trim().slice(0, 30);
  const num = inv.invoice_number ? `-${inv.invoice_number.replace(/[^a-zA-Z0-9-]/g, '')}` : '';
  XLSX.writeFile(wb, `${safeName}${num}.xlsx`);
}

export function downloadBulkExcel(fileResults: FileResult[]) {
  const wb = XLSX.utils.book_new();

  const summaryRows: unknown[][] = [
    ['File', 'Vendor Name', 'Vendor GSTIN', 'Buyer Name', 'Buyer GSTIN',
     'Invoice #', 'Invoice Date', 'Tax Type',
     'Subtotal', 'Bill Discount', 'Taxable Value', 'CGST', 'SGST', 'IGST',
     'Additional Charges (Non-GST)', 'Round Off', 'Total', 'Confidence%'],
  ];
  // Issue 3: 11 columns - "Description / HSN" split into "Description" + "Ledger Name"
  const allLineItems: unknown[][] = [
    ['Invoice #', 'Vendor Name', 'S.No.', 'Description', 'Ledger Name', 'GST%', 'UOM', 'Qty', 'Rate (ex-GST)', 'Disc%', 'Amount'],
  ];
  const allHsn: unknown[][] = [
    ['Invoice #', 'Vendor Name', 'HSN / SAC', 'Description', 'GST%', 'Taxable', 'CGST', 'SGST', 'IGST'],
  ];
  const allInvoicesForRecon: { inv: ExtractedInvoice }[] = [];

  for (const fr of fileResults) {
    for (const inv of fr.invoices) {
      const {
        computedSubtotal, billDiscount, taxableValue,
        gstChargesAmount, nonGstChargesAmount, totalTaxableValue,
        allCGST, allSGST, allIGST,
        excelRoundOff, excelTotal,
        hsnRows, chargeHsnRows,
      } = calcInv(inv);

      const invCharges = inv.charges ?? [];

      // Issue 2: use totalTaxableValue (includes GST charges), allCGST/allSGST/allIGST (includes charge GST),
      //          nonGstChargesAmount for Additional Charges column, excelTotal/excelRoundOff for consistency with dashboard.
      summaryRows.push([
        fr.filename, inv.vendor_name, inv.vendor_gstin ?? '',
        inv.buyer_name ?? '', inv.buyer_gstin ?? '',
        inv.invoice_number, inv.invoice_date,
        inv.tax_type === 'cgst_sgst' ? 'CGST+SGST' : 'IGST',
        r2(computedSubtotal), r2(billDiscount), r2(totalTaxableValue),
        inv.tax_type === 'cgst_sgst' ? r2(allCGST) : 0,
        inv.tax_type === 'cgst_sgst' ? r2(allSGST) : 0,
        inv.tax_type === 'igst' ? r2(allIGST) : 0,
        r2(nonGstChargesAmount),
        excelRoundOff,
        excelTotal,
        Math.round(inv.confidence * 100),
      ]);

      // Issue 3: Line items with separate Description and Ledger Name columns
      inv.line_items.forEach((it, i) => {
        const hsn = it.hsn.replace(/[\s.]/g, '') || '-';
        allLineItems.push([
          inv.invoice_number, inv.vendor_name, i + 1,
          it.description || '-',
          `${hsn} @ ${it.gst_percent}%`,
          it.gst_percent, it.uom || '-', it.qty,
          r2(it.rate), it.disc_percent, r2(calcLineAmount(it)),
        ]);
      });
      // Charge rows - all charges (GST and non-GST) for full audit trail
      invCharges.forEach((c, i) => {
        const sac = sacForCharge(c.description);
        const ledger = `${sac || c.description} @ ${c.gst_percent}%`;
        allLineItems.push([
          inv.invoice_number, inv.vendor_name, inv.line_items.length + i + 1,
          c.description,
          ledger,
          c.gst_percent, '-', 1, r2(c.amount), 0, r2(c.amount),
        ]);
      });

      // HSN summary - goods
      hsnRows.forEach((row) => {
        allHsn.push([
          inv.invoice_number, inv.vendor_name,
          row.hsn, '-', row.gst_percent,
          r2(row.taxable), r2(row.cgst), r2(row.sgst), r2(row.igst),
        ]);
      });
      // HSN summary - GST-carrying charges
      chargeHsnRows.forEach((row) => {
        const desc = invCharges.find(c => sacForCharge(c.description) === row.hsn || c.description === row.hsn)?.description ?? '-';
        allHsn.push([
          inv.invoice_number, inv.vendor_name,
          row.hsn, desc, row.gst_percent,
          r2(row.taxable), r2(row.cgst), r2(row.sgst), r2(row.igst),
        ]);
      });

      allInvoicesForRecon.push({ inv });
    }
  }

  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summaryRows), 'Invoice Summary');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(allLineItems), 'All Line Items');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(allHsn), 'HSN Summary');
  XLSX.utils.book_append_sheet(wb, buildGstReconSheet(allInvoicesForRecon), 'GST Reconciliation');
  XLSX.writeFile(wb, 'TallyAI-Bulk-Export.xlsx');
}
