/**
 * Debug trace for KKE001336 multi-line item regression.
 *
 * Reconstructs the exact GSTR-1 hierarchical format that the KKE Excel file
 * produces for an invoice with 3 HSN rows under the same invoice number.
 * Runs through the live parseHierarchical logic step-by-step and annotates
 * where the current code drops rows 2 and 3, then shows what the proposed
 * fix produces.
 *
 * Usage: node debug_kke001336.mjs
 */

// ─── Inline the critical utilities from salesExtract.ts ───────────────────────

const r2 = (n) => Math.round(n * 100) / 100;
const toNum = (v) => {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return v;
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? 0 : n;
};

const SECTION_MARKERS = [
  'b2b', 'b2c', 'nil rated', 'exempted', 'export invoice', 'gross total',
  'tax liability', 'set/off', 'advance',
];

/**
 * CURRENT (broken) isSectionOrSummaryRow — exact copy from salesExtract.ts
 */
function isSectionOrSummaryRow_CURRENT(row, profile) {
  const invVal = String(row[profile.invoiceNumCol] ?? '').trim();
  if (invVal) return false;

  const nonEmpty = row.filter((c) => c != null && c !== '' && c !== 0);
  if (nonEmpty.length > 1) {
    const allNumeric = nonEmpty.every(
      (c) => typeof c === 'number' || !isNaN(Number(String(c).replace(/,/g, '')))
    );
    if (allNumeric) return true;  // ← treats numeric HSN rows as section boundaries
    return false;
  }

  for (const cell of row) {
    const s = String(cell ?? '').toLowerCase().trim();
    if (s && SECTION_MARKERS.some((m) => s.includes(m))) return true;
  }

  return nonEmpty.length === 0;
}

// ─── Synthetic GSTR-1 data matching KKE001336 format ─────────────────────────
//
// GSTR-1 hierarchical layout (one header row per invoice, continuation rows
// for additional HSN codes, no invoice number on continuation rows):
//
// Col: 0=InvNo  1=Date        2=CustName          3=CustGSTIN            4=ItemDesc 5=HSN       6=Qty  7=Rate   8=Taxable  9=CGST    10=SGST   11=IGST   12=Total
//
// Section header before B2B invoices (text row, not a data row):
//   ["B2B Invoices (4A,4B,4C,6B,6C)", "", "", "", ...]
//
// Invoice KKE001336 anchor row:
//   ["KKE001336", "01-04-2023", "SHARMA TEXTILES", "27AAATS1234A1Z5", "", "40169100", 1, 1500, 1500, 135, 135, 0, 3870]
//
// Continuation row 2 (HSN 63041910):
//   ["", "", "", "", "", "63041910", 1, 800, 800, 40, 40, 0, 0]
//
// Continuation row 3 (HSN 63041990):
//   ["", "", "", "", "", "63041990", 1, 1200, 1200, 60, 60, 0, 0]
//
// Section totals row (all numeric, no invoice #):
//   ["", "", "", "", "", "", 3, "", 3500, 235, 235, 0, 3970]
//
// The synthetic data below uses representative values. Exact KKE amounts
// are unknown without the file, but the structural pattern is identical.

const syntheticAoa = [
  // Row 0: header
  ['Invoice No.', 'Invoice Date', 'Customer Name', 'Customer GSTIN', 'Item Description', 'HSN/SAC', 'Quantity', 'Rate', 'Taxable Value', 'CGST Amount', 'SGST Amount', 'IGST Amount', 'Invoice Total'],
  // Row 1: section marker
  ['B2B Invoices (4A,4B,4C,6B,6C)', '', '', '', '', '', '', '', '', '', '', '', ''],
  // Row 2: KKE001336 — anchor row (invoice # present)
  ['KKE001336', '01-04-2023', 'SHARMA TEXTILES', '27AAATS1234A1Z5', '', '40169100', 1, 1500, 1500, 135, 135, 0, 3870],
  // Row 3: continuation — HSN 63041910 (NO invoice number)
  ['', '', '', '', '', '63041910', 1, 800, 800, 40, 40, 0, 0],
  // Row 4: continuation — HSN 63041990 (NO invoice number)
  ['', '', '', '', '', '63041990', 1, 1200, 1200, 60, 60, 0, 0],
  // Row 5: section totals (all numeric, no invoice #) — this is a totals row
  ['', '', '', '', '', '', 3, '', 3500, 235, 235, 0, 3870],
];

// Column mapping for this header
// Col 0 = invoice_number, Col 5 = hsn, Col 8 = taxable_amount, Col 9 = cgst_amount, etc.
const profile = {
  invoiceNumCol: 0,
  dataStartRow: 2,   // skip header row (0) and section marker row (1)
  fields: {
    0: 'invoice_number',
    1: 'invoice_date',
    2: 'customer_name',
    3: 'customer_gstin',
    4: 'item_description',
    5: 'hsn',
    6: 'quantity',
    7: 'rate',
    8: 'taxable_amount',
    9: 'cgst_amount',
    10: 'sgst_amount',
    11: 'igst_amount',
    12: 'total_amount',
  },
};

// ─── SIMULATION 1: Current (broken) behaviour ─────────────────────────────────

console.log('═══════════════════════════════════════════════════════════════════');
console.log('SIMULATION 1 — CURRENT CODE (broken)');
console.log('═══════════════════════════════════════════════════════════════════\n');

{
  const groups = new Map();
  let anchorInvoiceNumber = '';
  let anchorDate = '';
  let anchorCustomerName = '';
  let anchorGstin = '';
  let anchorTotal = 0;
  let rowCount = 0;

  for (let i = profile.dataStartRow; i < syntheticAoa.length; i++) {
    const raw = syntheticAoa[i];
    if (!raw || raw.every((c) => c == null || c === '' || c === 0)) {
      console.log(`  Row ${i + 1}: SKIPPED (all empty/zero)`);
      continue;
    }

    // ── Current code: isSectionOrSummaryRow BEFORE building rec ──
    const isBoundary = isSectionOrSummaryRow_CURRENT(raw, profile);
    if (isBoundary) {
      console.log(`  Row ${i + 1}: isSectionOrSummaryRow=TRUE → anchor reset to '' → CONTINUE`);
      console.log(`            raw=[${raw.map(v => JSON.stringify(v)).join(', ')}]`);
      const nonEmpty = raw.filter((c) => c != null && c !== '' && c !== 0);
      const allNumeric = nonEmpty.every(
        (c) => typeof c === 'number' || !isNaN(Number(String(c).replace(/,/g, '')))
      );
      console.log(`            nonEmpty count=${nonEmpty.length}, allNumeric=${allNumeric}`);
      console.log(`            NOTE: HSN "${raw[5]}" → isNaN(Number("${raw[5]}"))=${isNaN(Number(String(raw[5]).replace(/,/g, '')))}`);
      anchorInvoiceNumber = '';
      continue;
    }

    const rec = {};
    Object.entries(profile.fields).forEach(([idx, field]) => { rec[field] = raw[Number(idx)]; });
    const invoiceNum = String(rec.invoice_number ?? '').trim();

    if (invoiceNum) {
      anchorInvoiceNumber = invoiceNum;
      anchorDate = String(rec.invoice_date ?? '');
      anchorCustomerName = String(rec.customer_name ?? '');
      anchorGstin = String(rec.customer_gstin ?? '');
      anchorTotal = toNum(rec.total_amount);
      if (!groups.has(anchorInvoiceNumber)) groups.set(anchorInvoiceNumber, []);
      console.log(`  Row ${i + 1}: ANCHOR → invoice="${invoiceNum}", hsn="${rec.hsn}", taxable=${rec.taxable_amount}`);
    } else if (!anchorInvoiceNumber) {
      console.log(`  Row ${i + 1}: SKIPPED (no anchor yet)`);
      continue;
    }

    const taxable = toNum(rec.taxable_amount);
    const cgstAmt = toNum(rec.cgst_amount);
    const sgstAmt = toNum(rec.sgst_amount);
    const igstAmt = toNum(rec.igst_amount);
    const qty = toNum(rec.quantity);
    const rate = toNum(rec.rate);

    const hasValue = taxable !== 0 || cgstAmt !== 0 || sgstAmt !== 0 || igstAmt !== 0 || (qty !== 0 && rate !== 0);
    if (!hasValue) {
      console.log(`  Row ${i + 1}: SKIPPED (no financial value)`);
      continue;
    }

    rowCount++;
    groups.get(anchorInvoiceNumber).push({
      invoice_number: anchorInvoiceNumber,
      hsn: String(rec.hsn ?? '').trim(),
      taxable_amount: taxable,
      cgst_amount: cgstAmt,
      sgst_amount: sgstAmt,
    });
    console.log(`  Row ${i + 1}: PUSHED to group "${anchorInvoiceNumber}" → hsn="${rec.hsn}", taxable=${taxable}`);
  }

  console.log('\n── Final groups ──');
  for (const [invNo, rows] of groups.entries()) {
    console.log(`  ${invNo}: ${rows.length} row(s)`);
    rows.forEach((r, idx) => {
      console.log(`    [${idx}] hsn="${r.hsn}", taxable=${r.taxable_amount}, cgst=${r.cgst_amount}`);
    });
  }

  console.log('\n── Assembled line_items ──');
  for (const [invNo, rows] of groups.entries()) {
    const lineItems = rows.map(r => ({ description: r.hsn || 'UNKNOWN', hsn: r.hsn }));
    console.log(`  ${invNo}: ${lineItems.length} line item(s) — HSNs: [${lineItems.map(l => l.hsn).join(', ')}]`);
  }
}

// ─── SIMULATION 2: Proposed fix ───────────────────────────────────────────────

console.log('\n');
console.log('═══════════════════════════════════════════════════════════════════');
console.log('SIMULATION 2 — PROPOSED FIX');
console.log('  Build rec BEFORE section-boundary check.');
console.log('  Guard: if rec.hsn or rec.item_description is non-empty,');
console.log('         skip isSectionOrSummaryRow and proceed as continuation.');
console.log('═══════════════════════════════════════════════════════════════════\n');

{
  const groups = new Map();
  let anchorInvoiceNumber = '';
  let anchorDate = '';
  let anchorCustomerName = '';
  let anchorGstin = '';
  let anchorTotal = 0;
  let rowCount = 0;

  for (let i = profile.dataStartRow; i < syntheticAoa.length; i++) {
    const raw = syntheticAoa[i];
    if (!raw || raw.every((c) => c == null || c === '' || c === 0)) {
      console.log(`  Row ${i + 1}: SKIPPED (all empty/zero)`);
      continue;
    }

    // ── PROPOSED FIX: build rec first, then check HSN before section guard ──
    const rec = {};
    Object.entries(profile.fields).forEach(([idx, field]) => { rec[field] = raw[Number(idx)]; });

    const invoiceNum  = String(rec.invoice_number ?? '').trim();
    const recHsn      = String(rec.hsn ?? '').trim();
    const recDesc     = String(rec.item_description ?? '').trim();

    // Only reset anchor if BOTH conditions: no item identifier AND is a section boundary
    if (!invoiceNum && !recHsn && !recDesc && isSectionOrSummaryRow_CURRENT(raw, profile)) {
      console.log(`  Row ${i + 1}: section boundary (no HSN, no desc, all-numeric or label) → anchor reset → CONTINUE`);
      anchorInvoiceNumber = '';
      continue;
    }

    if (invoiceNum) {
      anchorInvoiceNumber = invoiceNum;
      anchorDate = String(rec.invoice_date ?? '');
      anchorCustomerName = String(rec.customer_name ?? '');
      anchorGstin = String(rec.customer_gstin ?? '');
      anchorTotal = toNum(rec.total_amount);
      if (!groups.has(anchorInvoiceNumber)) groups.set(anchorInvoiceNumber, []);
      console.log(`  Row ${i + 1}: ANCHOR → invoice="${invoiceNum}", hsn="${recHsn}", taxable=${rec.taxable_amount}`);
    } else if (!anchorInvoiceNumber) {
      console.log(`  Row ${i + 1}: SKIPPED (no anchor yet)`);
      continue;
    } else {
      console.log(`  Row ${i + 1}: CONTINUATION → anchor="${anchorInvoiceNumber}", hsn="${recHsn}", taxable=${rec.taxable_amount}`);
    }

    const taxable = toNum(rec.taxable_amount);
    const cgstAmt = toNum(rec.cgst_amount);
    const sgstAmt = toNum(rec.sgst_amount);
    const igstAmt = toNum(rec.igst_amount);
    const qty = toNum(rec.quantity);
    const rate = toNum(rec.rate);

    const hasValue = taxable !== 0 || cgstAmt !== 0 || sgstAmt !== 0 || igstAmt !== 0 || (qty !== 0 && rate !== 0);
    if (!hasValue) {
      console.log(`    └─ SKIPPED (no financial value)`);
      continue;
    }

    rowCount++;
    groups.get(anchorInvoiceNumber).push({
      invoice_number: anchorInvoiceNumber,
      hsn: recHsn,
      taxable_amount: taxable,
      cgst_amount: cgstAmt,
      sgst_amount: sgstAmt,
    });
    console.log(`    └─ PUSHED → hsn="${recHsn}", taxable=${taxable}`);
  }

  console.log('\n── Final groups ──');
  for (const [invNo, rows] of groups.entries()) {
    console.log(`  ${invNo}: ${rows.length} row(s)`);
    rows.forEach((r, idx) => {
      console.log(`    [${idx}] hsn="${r.hsn}", taxable=${r.taxable_amount}, cgst=${r.cgst_amount}`);
    });
  }

  console.log('\n── Assembled line_items ──');
  for (const [invNo, rows] of groups.entries()) {
    const lineItems = rows.map(r => ({ description: r.hsn || 'UNKNOWN', hsn: r.hsn }));
    console.log(`  ${invNo}: ${lineItems.length} line item(s) — HSNs: [${lineItems.map(l => l.hsn).join(', ')}]`);
  }
}

// ─── Key diagnostic: the allNumeric check on a numeric HSN ───────────────────

console.log('\n');
console.log('═══════════════════════════════════════════════════════════════════');
console.log('KEY DIAGNOSTIC — why isSectionOrSummaryRow fires on continuation rows');
console.log('═══════════════════════════════════════════════════════════════════\n');

const hsnCodes = ['40169100', '63041910', '63041990'];
for (const hsn of hsnCodes) {
  const asNumber = Number(String(hsn).replace(/,/g, ''));
  const isNumeric = !isNaN(asNumber);
  console.log(`  HSN "${hsn}" → Number("${hsn}") = ${asNumber} → isNaN=${isNaN(asNumber)} → treated as numeric = ${isNumeric}`);
}

console.log('\n  A continuation row for HSN 63041910 looks like:');
const sampleRow = ['', '', '', '', '', '63041910', 1, 800, 800, 40, 40, 0, 0];
const nonEmpty = sampleRow.filter(c => c != null && c !== '' && c !== 0);
const allNumeric = nonEmpty.every(c => typeof c === 'number' || !isNaN(Number(String(c).replace(/,/g, ''))));
console.log(`  nonEmpty = [${nonEmpty.map(v => JSON.stringify(v)).join(', ')}]`);
console.log(`  nonEmpty.length = ${nonEmpty.length} (> 1)`);
console.log(`  allNumeric = ${allNumeric}`);
console.log(`  isSectionOrSummaryRow returns: ${nonEmpty.length > 1 && allNumeric} (TRUE = BUG)`);

console.log('\n  Totals row (no HSN):');
const totalsRow = ['', '', '', '', '', '', 3, '', 3500, 235, 235, 0, 3870];
const nonEmptyT = totalsRow.filter(c => c != null && c !== '' && c !== 0);
const allNumericT = nonEmptyT.every(c => typeof c === 'number' || !isNaN(Number(String(c).replace(/,/g, ''))));
console.log(`  nonEmpty = [${nonEmptyT.map(v => JSON.stringify(v)).join(', ')}]`);
console.log(`  nonEmpty.length = ${nonEmptyT.length} (> 1)`);
console.log(`  allNumeric = ${allNumericT}`);
console.log(`  isSectionOrSummaryRow returns: ${nonEmptyT.length > 1 && allNumericT} (TRUE = correct — this IS a totals row)`);
console.log('\n  With the fix: totals row has rec.hsn="" and rec.item_description="" → section guard STILL fires → anchor reset ✓');
console.log('  With the fix: continuation row has rec.hsn="63041910" → guard SKIPPED → row processed ✓');
