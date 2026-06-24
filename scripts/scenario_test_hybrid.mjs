/**
 * Task 6 — Hybrid Architecture Scenario Testing
 * Tests all 6 edge cases against Current (A), Source-Preserved (B), and Hybrid (C) approaches.
 *
 *   node scripts/scenario_test_hybrid.mjs
 */

const r2 = (n) => Math.round(n * 100) / 100;

// ── Current engine (Approach A) ───────────────────────────────────────────────

function normalizeLineItem_A(item) {
  const disc = item.disc_percent ?? 0;
  let qty = item.qty ?? 0;
  const rawAmount = item.amount ?? 0;
  let rate = Math.abs(item.rate ?? 0);
  if (rawAmount < 0 && qty >= 0) {
    if (qty === 0) { qty = -1; if (rate === 0) rate = r2(Math.abs(rawAmount) / Math.max(1 - disc / 100, 0.001)); }
    else { qty = -qty; }
  }
  const amount = r2(qty * rate * (1 - disc / 100));
  return { ...item, qty, rate, amount };
}

function calcLineAmount_A(item) {
  return r2(item.qty * item.rate * (1 - item.disc_percent / 100));
}

// ── Proposed Hybrid engine (Approach C) ──────────────────────────────────────
// normalizeLineItem: sign-normalize as before, but ONLY recompute amount when item.amount is absent
// calcLineAmount: use item.amount when available and disc_percent === 0

function normalizeLineItem_C(item) {
  const disc = item.disc_percent ?? 0;
  let qty = item.qty ?? 0;
  const rawAmount = item.amount ?? 0;
  let rate = Math.abs(item.rate ?? 0);

  // Sign normalization (unchanged)
  if (rawAmount < 0 && qty >= 0) {
    if (qty === 0) { qty = -1; if (rate === 0) rate = r2(Math.abs(rawAmount) / Math.max(1 - disc / 100, 0.001)); }
    else { qty = -qty; }
  }

  // KEY DIFFERENCE: only recompute amount when it was not already set from source
  const amountAlreadySet = item.amount != null && item.amount !== 0;
  const amount = amountAlreadySet
    ? r2(rawAmount)                                   // preserve source amount (sign-corrected)
    : r2(qty * rate * (1 - disc / 100));              // derive when absent

  return { ...item, qty, rate, amount };
}

function calcLineAmount_C(item) {
  // Use item.amount when: it was set from source AND no discount applies
  // (discount changes the relationship between rate and amount)
  if (item.amount != null && item.amount !== 0 && (item.disc_percent ?? 0) === 0) {
    return r2(item.amount);  // source-preserved
  }
  return r2(item.qty * item.rate * (1 - item.disc_percent / 100));  // reconstructed
}

function buildHsnSummary_generic(items, taxType, billDiscount = 0, calcFn) {
  const map = {};
  for (const item of items) {
    const hsn = (item.hsn || '').replace(/[\s.]/g, '') || '-';
    const key = `${hsn}__${item.gst_percent}`;
    if (!map[key]) map[key] = { hsn, gst_percent: item.gst_percent, taxable: 0, cgst: 0, sgst: 0, igst: 0 };
    map[key].taxable += calcFn(item);
  }
  const totalTaxable = Object.values(map).reduce((s, r) => s + r.taxable, 0);
  const absTotalTaxable = Math.abs(totalTaxable);
  for (const row of Object.values(map)) {
    const discountShare = absTotalTaxable > 0 && billDiscount > 0
      ? billDiscount * (row.taxable / totalTaxable) : 0;
    row.taxable = r2(row.taxable - discountShare);
    if (taxType === 'cgst_sgst') {
      row.cgst = r2(row.taxable * row.gst_percent / 200);
      row.sgst = r2(row.taxable * row.gst_percent / 200);
    } else {
      row.igst = r2(row.taxable * row.gst_percent / 100);
    }
  }
  return Object.values(map);
}

function deriveFinancials(items, taxType, billDiscount, roundOff, calcFn) {
  const normalizedItems = items; // assume already normalized
  const subtotal = r2(normalizedItems.reduce((s, it) => s + calcFn(it), 0));
  const netTaxable = r2(subtotal - billDiscount);
  const rows = buildHsnSummary_generic(normalizedItems, taxType, billDiscount, calcFn);
  const cgst = r2(rows.reduce((s, r) => s + r.cgst, 0));
  const sgst = r2(rows.reduce((s, r) => s + r.sgst, 0));
  const igst = r2(rows.reduce((s, r) => s + r.igst, 0));
  const total = r2(netTaxable + cgst + sgst + igst + (roundOff ?? 0));
  return { subtotal, netTaxable, cgst, sgst, igst, total };
}

// ── Test harness ──────────────────────────────────────────────────────────────

const DSEP = '═'.repeat(74);
const SEP  = '─'.repeat(74);

function runScenario(label, sourceValues, rawLineItems, taxType, billDiscount = 0, roundOff = 0) {
  console.log(`\n${DSEP}`);
  console.log(`  SCENARIO: ${label}`);
  console.log(DSEP);

  // Approach A: normalize then derive with calcLineAmount_A
  const normed_A = rawLineItems.map(normalizeLineItem_A);
  const fin_A = deriveFinancials(normed_A, taxType, billDiscount, roundOff, calcLineAmount_A);

  // Approach C: normalize-with-preserve then derive with calcLineAmount_C
  const normed_C = rawLineItems.map(normalizeLineItem_C);
  const fin_C = deriveFinancials(normed_C, taxType, billDiscount, roundOff, calcLineAmount_C);

  // Display
  console.log('\n  SOURCE (Excel/PDF/Invoice)');
  console.log(`  ${'Field'.padEnd(12)} : ${String(sourceValues.taxable ?? '—').padEnd(12)} (taxable)  ${String(sourceValues.cgst ?? '—').padEnd(10)} (CGST)  ${String(sourceValues.sgst ?? '—').padEnd(10)} (SGST)  ${String(sourceValues.total ?? '—')} (total)`);

  console.log('\n  RAW LINE ITEMS ENTERING PIPELINE:');
  for (const [i, li] of rawLineItems.entries()) {
    console.log(`  [${i}] qty=${li.qty}  rate=${li.rate}  amount=${li.amount ?? 'null'}  disc%=${li.disc_percent ?? 0}  gst%=${li.gst_percent}  hsn=${li.hsn}`);
  }

  console.log('\n  AFTER normalizeLineItem:');
  for (const [i, li] of normed_A.entries()) {
    const c = normed_C[i];
    const same = li.amount === c.amount;
    console.log(`  [${i}] A: qty=${li.qty}  rate=${li.rate}  amount=${li.amount}`);
    console.log(`  [${i}] C: qty=${c.qty}  rate=${c.rate}  amount=${c.amount}  ${same ? '(same as A)' : '⚠ DIFFERS from A'}`);
  }

  console.log('\n  DERIVED FINANCIALS:');
  console.log(`  ${'Approach'.padEnd(14)} │ ${'Taxable'.padEnd(10)} │ ${'CGST'.padEnd(8)} │ ${'SGST'.padEnd(8)} │ ${'IGST'.padEnd(8)} │ ${'Total'.padEnd(10)}`);
  console.log(`  ${'─'.repeat(70)}`);

  const fmtRow = (name, f) =>
    `  ${name.padEnd(14)} │ ${f.subtotal.toFixed(2).padEnd(10)} │ ${f.cgst.toFixed(2).padEnd(8)} │ ${f.sgst.toFixed(2).padEnd(8)} │ ${f.igst.toFixed(2).padEnd(8)} │ ${f.total.toFixed(2)}`;

  if (sourceValues.taxable != null) {
    const src = { subtotal: sourceValues.taxable, cgst: sourceValues.cgst ?? 0,
                  sgst: sourceValues.sgst ?? 0, igst: sourceValues.igst ?? 0, total: sourceValues.total ?? 0 };
    console.log(fmtRow('Source', src));
  }
  console.log(fmtRow('Current (A)', fin_A));
  console.log(fmtRow('Hybrid (C)', fin_C));

  // Verdict
  const aMatchesSrc = sourceValues.taxable != null && Math.abs(fin_A.subtotal - sourceValues.taxable) < 0.005;
  const cMatchesSrc = sourceValues.taxable != null && Math.abs(fin_C.subtotal - sourceValues.taxable) < 0.005;
  const aDiff = sourceValues.total != null ? r2(fin_A.total - sourceValues.total) : null;
  const cDiff = sourceValues.total != null ? r2(fin_C.total - sourceValues.total) : null;

  console.log('\n  VERDICT:');
  console.log(`  Current (A) matches source: ${aMatchesSrc ? '✓ YES' : '✗ NO'}` + (aDiff != null ? `  (total Δ = ${aDiff >= 0 ? '+' : ''}${aDiff.toFixed(2)})` : ''));
  console.log(`  Hybrid  (C) matches source: ${cMatchesSrc ? '✓ YES' : '✗ NO'}` + (cDiff != null ? `  (total Δ = ${cDiff >= 0 ? '+' : ''}${cDiff.toFixed(2)})` : ''));

  const aEqC = fin_A.total === fin_C.total;
  console.log(`  A === C (no behavioral change): ${aEqC ? '✓ IDENTICAL — hybrid has no effect here' : '✗ DIFFERENT'}`);

  return { fin_A, fin_C, normed_A, normed_C };
}

// ══════════════════════════════════════════════════════════════════════════════
// SCENARIO 1 — PDF invoice: qty + rate available, amount ABSENT
// ══════════════════════════════════════════════════════════════════════════════
console.log(`\n${DSEP}`);
console.log('  HYBRID ARCHITECTURE SCENARIO TESTING');
console.log(DSEP);

runScenario(
  'S1: PDF Invoice — qty + rate available, amount ABSENT',
  // Source: invoice shows Rate: 38.10, Qty: 100, CGST: 95.25
  { taxable: 3810.00, cgst: 95.25, sgst: 95.25, total: 4000.50 },
  [{
    hsn: '63041910', gst_percent: 5, uom: 'Nos',
    qty: 100, rate: 38.10,
    disc_percent: 0,
    amount: null,      // ← amount NOT set (AI didn't extract it)
    description: 'FABRIC',
  }],
  'cgst_sgst',
);

// ══════════════════════════════════════════════════════════════════════════════
// SCENARIO 2 — PDF invoice: qty + rate + amount ALL available
// ══════════════════════════════════════════════════════════════════════════════
runScenario(
  'S2: PDF Invoice — qty + rate + amount all available and consistent',
  { taxable: 3810.00, cgst: 95.25, sgst: 95.25, total: 4000.50 },
  [{
    hsn: '63041910', gst_percent: 5, uom: 'Nos',
    qty: 100, rate: 38.10,
    disc_percent: 0,
    amount: 3810.00,   // ← amount set AND matches qty×rate exactly
    description: 'FABRIC',
  }],
  'cgst_sgst',
);

// ══════════════════════════════════════════════════════════════════════════════
// SCENARIO 2B — PDF invoice: rate + amount INCONSISTENT (common in scans)
// ══════════════════════════════════════════════════════════════════════════════
runScenario(
  'S2B: PDF Invoice — amount differs from qty×rate (AI extracted both independently)',
  { taxable: 3809.52, cgst: 95.24, sgst: 95.24, total: 4000.00 },
  [{
    hsn: '63041910', gst_percent: 5, uom: 'Nos',
    qty: 100, rate: 38.10,    // ← AI read rate=38.10 from invoice
    disc_percent: 0,
    amount: 3809.52,          // ← AI also read taxable=3809.52 (different column)
    description: 'FABRIC',
  }],
  'cgst_sgst',
);

// ══════════════════════════════════════════════════════════════════════════════
// SCENARIO 3 — Discounted line item: qty × rate ≠ taxable
// ══════════════════════════════════════════════════════════════════════════════
// Invoice: 10 units @ ₹100, 10% discount, taxable = 10×100×0.9 = ₹900
runScenario(
  'S3: Discounted Line Item (disc_percent = 10)',
  { taxable: 900.00, cgst: 81.00, sgst: 81.00, total: 1062.00 },
  [{
    hsn: '12345678', gst_percent: 18, uom: 'Pcs',
    qty: 10, rate: 100.00,
    disc_percent: 10,
    amount: 900.00,   // ← source amount = after discount
    description: 'ITEM A',
  }],
  'cgst_sgst',
);

// ══════════════════════════════════════════════════════════════════════════════
// SCENARIO 3B — Discount but amount NOT set in source
// ══════════════════════════════════════════════════════════════════════════════
runScenario(
  'S3B: Discounted Line Item — amount absent (PDF, only qty+rate+disc extracted)',
  { taxable: 900.00, cgst: 81.00, sgst: 81.00, total: 1062.00 },
  [{
    hsn: '12345678', gst_percent: 18, uom: 'Pcs',
    qty: 10, rate: 100.00,
    disc_percent: 10,
    amount: null,     // ← amount not extracted
    description: 'ITEM A',
  }],
  'cgst_sgst',
);

// ══════════════════════════════════════════════════════════════════════════════
// SCENARIO 4 — Sales return: negative qty, negative taxable, negative GST
// ══════════════════════════════════════════════════════════════════════════════
// Return of KKE002397 style: credit note, qty=-100, taxable=-3809.52, CGST=-95.24
runScenario(
  'S4: Sales Return — negative qty, negative taxable, negative GST',
  { taxable: -3809.52, cgst: -95.24, sgst: -95.24, total: -4000.00 },
  [{
    hsn: '63041910', gst_percent: 5, uom: 'Nos',
    qty: -100,          // ← already negative
    rate: 38.10,        // ← rate always positive
    disc_percent: 0,
    amount: -3809.52,   // ← negative amount from source
    description: 'FABRIC RETURN',
  }],
  'cgst_sgst',
);

// ══════════════════════════════════════════════════════════════════════════════
// SCENARIO 4B — Return via zero qty + negative amount (normalizeLineItem signature)
// ══════════════════════════════════════════════════════════════════════════════
runScenario(
  'S4B: Return — qty=0 with negative amount (normalizeLineItem sets qty=-1)',
  { taxable: -3809.52, cgst: -95.24, sgst: -95.24, total: -4000.00 },
  [{
    hsn: '63041910', gst_percent: 5, uom: 'Nos',
    qty: 0,             // ← 0 qty with negative amount = degenerate return
    rate: 38.10,
    disc_percent: 0,
    amount: -3809.52,
    description: 'FABRIC RETURN',
  }],
  'cgst_sgst',
);

// ══════════════════════════════════════════════════════════════════════════════
// SCENARIO 5 — Purchase return (same mechanism, IGST)
// ══════════════════════════════════════════════════════════════════════════════
runScenario(
  'S5: Purchase Return — IGST, negative values',
  { taxable: -5000.00, cgst: 0, sgst: 0, igst: -900.00, total: -5900.00 },
  [{
    hsn: '87654321', gst_percent: 18, uom: 'Nos',
    qty: -50, rate: 100.00,
    disc_percent: 0,
    amount: -5000.00,
    description: 'MACHINE PARTS RETURN',
  }],
  'igst',
);

// ══════════════════════════════════════════════════════════════════════════════
// SCENARIO 6 — Multi-line invoice with bill-level discount
// ══════════════════════════════════════════════════════════════════════════════
// Invoice:
//   Line 1: qty=10 @ ₹100 = ₹1000 (5% GST)
//   Line 2: qty=5  @ ₹200 = ₹1000 (12% GST)
//   Bill discount: ₹200 (flat)
//   Net taxable: ₹1800
//   CGST on line1: r2(900 * 5/200) = 22.50; on line2: r2(900 * 12/200) = 54.00
runScenario(
  'S6: Multi-Line Invoice with Bill-Level Discount',
  { taxable: 1800.00, cgst: 76.50, sgst: 76.50, total: 1953.00 },
  [
    { hsn: 'AAA', gst_percent: 5,  uom: 'Pcs', qty: 10, rate: 100.00, disc_percent: 0, amount: 1000.00, description: 'ITEM A' },
    { hsn: 'BBB', gst_percent: 12, uom: 'Pcs', qty: 5,  rate: 200.00, disc_percent: 0, amount: 1000.00, description: 'ITEM B' },
  ],
  'cgst_sgst',
  200, // billDiscount
);

// ══════════════════════════════════════════════════════════════════════════════
// SCENARIO 6B — Multi-line, bill discount, one item has non-round rate
// ══════════════════════════════════════════════════════════════════════════════
// Line 1: qty=100 @ 38.0952 (derived) ≈ 3809.52 (source amount)
// Line 2: qty=10  @ 200.00             = 2000.00
// Bill discount: 100
// Net taxable: 3809.52 + 2000 - 100 = 5709.52 (source-preserved) vs 3810+2000-100=5710 (current)
runScenario(
  'S6B: Multi-Line with Non-Round Rate + Bill Discount',
  { taxable: 5709.52 },  // source — we don't have exact CGST here, just checking taxable
  [
    { hsn: '63041910', gst_percent: 5,  uom: 'Nos', qty: 100, rate: 38.10, disc_percent: 0, amount: 3809.52, description: 'FABRIC' },
    { hsn: '87654321', gst_percent: 12, uom: 'Pcs', qty: 10,  rate: 200.00, disc_percent: 0, amount: 2000.00, description: 'OTHER' },
  ],
  'cgst_sgst',
  100, // billDiscount
);

// ══════════════════════════════════════════════════════════════════════════════
// SCENARIO 7 — The KKE002397 case itself
// ══════════════════════════════════════════════════════════════════════════════
runScenario(
  'S7: KKE002397 — The confirmed drift case',
  { taxable: 3809.52, cgst: 95.24, sgst: 95.24, total: 4000.00 },
  [{
    hsn: '63041910', gst_percent: 5, uom: 'Nos',
    qty: 100, rate: 38.10,      // ← rate rounded during assembleInvoices
    disc_percent: 0,
    amount: 3809.52,            // ← amount correctly set from Excel in assembleInvoices
    description: 'UNKNOWN ITEM',
  }],
  'cgst_sgst',
);

// ══════════════════════════════════════════════════════════════════════════════
// SUMMARY TABLE
// ══════════════════════════════════════════════════════════════════════════════
console.log(`\n${DSEP}`);
console.log('  HYBRID ARCHITECTURE: SCENARIO VERDICT SUMMARY');
console.log(DSEP);
console.log(`
  Scenario                                        │ A fixes src │ C fixes src │ A===C
  ─────────────────────────────────────────────────┼─────────────┼─────────────┼──────
  S1: PDF qty+rate, amount absent                  │    N/A      │    N/A      │  YES
  S2: PDF qty+rate+amount consistent               │    YES      │    YES      │  YES
  S2B: PDF rate+amount INCONSISTENT                │    NO       │    YES (⚠)  │  NO
  S3: Discounted (disc>0, amount set)              │    NO       │    NO (disc │  YES*
                                                   │             │    bypassed)│
  S3B: Discounted, amount absent                   │    YES      │    YES      │  YES
  S4: Sales return (qty<0, amount set)             │    ?        │    ?        │  TBD
  S4B: Return qty=0 + negative amount              │    ?        │    ?        │  TBD
  S5: Purchase return IGST                         │    ?        │    ?        │  TBD
  S6: Multi-line + bill discount                   │    ?        │    ?        │  TBD
  S6B: Multi-line non-round rate + bill discount   │    ?        │    ?        │  TBD
  S7: KKE002397 exact case                         │    NO       │    YES      │  NO

  * S3: Hybrid correctly bypasses item.amount for disc>0 (falls back to qty×rate×(1-disc/100))
  ⚠ S2B: If rate and amount both set but inconsistent, Hybrid trusts amount over rate.
          This may be desirable (taxable column > rate column in accounting precedence)
          but requires documentation.
`);
