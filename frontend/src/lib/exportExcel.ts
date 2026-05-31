import * as XLSX from 'xlsx';
import type { ExtractedInvoice, FileResult } from '@/types/invoice';
import { calcLineAmount, buildHsnSummary } from '@/types/invoice';

function r2(n: number) {
  return Math.round(n * 100) / 100;
}

function invoiceSheets(inv: ExtractedInvoice) {
  const billDiscount = inv.bill_discount_amount ?? 0;
  const hsnRows = buildHsnSummary(inv.line_items, inv.tax_type, billDiscount);
  const computedSubtotal = inv.line_items.reduce((s, it) => s + calcLineAmount(it), 0);
  const taxableValue = computedSubtotal - billDiscount;
  const computedTax = hsnRows.reduce((s, r) => s + r.cgst + r.sgst + r.igst, 0);
  const chargesTotal = (inv.charges ?? []).reduce((s, c) => s + c.amount, 0);
  const computedTotal = taxableValue + computedTax + chargesTotal + (inv.round_off ?? 0);

  // Sheet 1 — header
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
    ['Taxable Value', r2(taxableValue)],
    inv.tax_type === 'cgst_sgst'
      ? ['CGST', r2(computedTax / 2)]
      : ['IGST', r2(computedTax)],
    inv.tax_type === 'cgst_sgst'
      ? ['SGST', r2(computedTax / 2)]
      : ['', ''],
    ['Additional Charges', r2(chargesTotal)],
    ['Round Off', r2(inv.round_off ?? 0)],
    ['Total', r2(computedTotal)],
    ['Confidence', `${Math.round(inv.confidence * 100)}%`],
  ];

  // Sheet 2 — line items
  const lineItemRows = [
    ['S.No.', 'HSN', 'GST%', 'UOM', 'Qty', 'Rate (ex-GST)', 'Disc%', 'Amount'],
    ...inv.line_items.map((it, i) => [
      i + 1,
      it.hsn.replace(/[\s.]/g, '') || '—',
      it.gst_percent,
      it.uom || '—',
      it.qty,
      r2(it.rate),
      it.disc_percent,
      r2(calcLineAmount(it)),
    ]),
    ['', '', '', '', '', '', 'Total Taxable', r2(computedSubtotal)],
  ];

  // Sheet 3 — HSN summary
  const hsnSummaryRows = [
    ['HSN', 'GST%', 'Taxable', 'CGST', 'SGST', 'IGST'],
    ...hsnRows.map((r) => [
      r.hsn,
      r.gst_percent,
      r2(r.taxable),
      r2(r.cgst),
      r2(r.sgst),
      r2(r.igst),
    ]),
    [
      'Total', '',
      r2(hsnRows.reduce((s, r) => s + r.taxable, 0)),
      r2(hsnRows.reduce((s, r) => s + r.cgst, 0)),
      r2(hsnRows.reduce((s, r) => s + r.sgst, 0)),
      r2(hsnRows.reduce((s, r) => s + r.igst, 0)),
    ],
  ];

  return { header, lineItemRows, hsnSummaryRows, charges: inv.charges ?? [] };
}

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
     'Additional Charges', 'Round Off', 'Total', 'Confidence%'],
  ];
  const allLineItems: unknown[][] = [
    ['Invoice #', 'Vendor Name', 'S.No.', 'HSN', 'GST%', 'UOM', 'Qty', 'Rate (ex-GST)', 'Disc%', 'Amount'],
  ];
  const allHsn: unknown[][] = [
    ['Invoice #', 'Vendor Name', 'HSN', 'GST%', 'Taxable', 'CGST', 'SGST', 'IGST'],
  ];

  for (const fr of fileResults) {
    for (const inv of fr.invoices) {
      const billDiscount = inv.bill_discount_amount ?? 0;
      const hsnRows = buildHsnSummary(inv.line_items, inv.tax_type, billDiscount);
      const computedSubtotal = inv.line_items.reduce((s, it) => s + calcLineAmount(it), 0);
      const taxableValue = computedSubtotal - billDiscount;
      const computedTax = hsnRows.reduce((s, r) => s + r.cgst + r.sgst + r.igst, 0);
      const chargesTotal = (inv.charges ?? []).reduce((s, c) => s + c.amount, 0);
      const computedTotal = taxableValue + computedTax + chargesTotal + (inv.round_off ?? 0);

      summaryRows.push([
        fr.filename,
        inv.vendor_name,
        inv.vendor_gstin ?? '',
        inv.buyer_name ?? '',
        inv.buyer_gstin ?? '',
        inv.invoice_number,
        inv.invoice_date,
        inv.tax_type === 'cgst_sgst' ? 'CGST+SGST' : 'IGST',
        r2(computedSubtotal),
        r2(billDiscount),
        r2(taxableValue),
        inv.tax_type === 'cgst_sgst' ? r2(computedTax / 2) : 0,
        inv.tax_type === 'cgst_sgst' ? r2(computedTax / 2) : 0,
        inv.tax_type === 'igst' ? r2(computedTax) : 0,
        r2(chargesTotal),
        r2(inv.round_off ?? 0),
        r2(computedTotal),
        Math.round(inv.confidence * 100),
      ]);

      inv.line_items.forEach((it, i) => {
        allLineItems.push([
          inv.invoice_number,
          inv.vendor_name,
          i + 1,
          it.hsn.replace(/[\s.]/g, '') || '—',
          it.gst_percent,
          it.uom || '—',
          it.qty,
          r2(it.rate),
          it.disc_percent,
          r2(calcLineAmount(it)),
        ]);
      });

      hsnRows.forEach((row) => {
        allHsn.push([
          inv.invoice_number,
          inv.vendor_name,
          row.hsn,
          row.gst_percent,
          r2(row.taxable),
          r2(row.cgst),
          r2(row.sgst),
          r2(row.igst),
        ]);
      });
    }
  }

  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summaryRows), 'Invoice Summary');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(allLineItems), 'All Line Items');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(allHsn), 'HSN Summary');
  XLSX.writeFile(wb, 'TallyAI-Bulk-Export.xlsx');
}
