/**
 * Deterministic stage-by-stage trace of KKE002397 through the full pipeline.
 * No database access required — all calculations are replicated from source code.
 *
 *   node scripts/trace_kke002397.mjs
 */

// ── Replicated from invoice.ts ─────────────────────────────────────────────────
const r2 = (n) => Math.round(n * 100) / 100;

function calcLineAmount(item) {
  return r2(item.qty * item.rate * (1 - item.disc_percent / 100));
}

function normalizeLineItem(item) {
  const disc = item.disc_percent ?? 0;
  let qty = item.qty ?? 0;
  const rawAmount = item.amount ?? 0;
  let rate = Math.abs(item.rate ?? 0);

  // Sign correction: negative amount with non-negative qty
  if (rawAmount < 0 && qty >= 0) {
    if (qty === 0) {
      qty = -1;
      if (rate === 0) rate = r2(Math.abs(rawAmount) / Math.max(1 - disc / 100, 0.001));
    } else {
      qty = -qty;
    }
  }

  const amount = r2(qty * rate * (1 - disc / 100));
  return { ...item, qty, rate, amount };
}

function buildHsnSummary(items, taxType, billDiscount = 0) {
  const map = {};
  for (const item of items) {
    const hsn = (item.hsn || '').replace(/[\s.]/g, '') || '-';
    const key = `${hsn}__${item.gst_percent}`;
    if (!map[key]) map[key] = { hsn, gst_percent: item.gst_percent, taxable: 0, cgst: 0, sgst: 0, igst: 0 };
    map[key].taxable += calcLineAmount(item);
  }

  const totalTaxable = Object.values(map).reduce((s, r) => s + r.taxable, 0);
  const absTotalTaxable = Math.abs(totalTaxable);

  for (const row of Object.values(map)) {
    const discountShare = absTotalTaxable > 0 && billDiscount > 0
      ? billDiscount * (row.taxable / totalTaxable) : 0;
    row.taxable = r2(row.taxable - discountShare);
    // OldDirect (current production after our rounding fix)
    if (taxType === 'cgst_sgst') {
      row.cgst = r2(row.taxable * row.gst_percent / 200);
      row.sgst = r2(row.taxable * row.gst_percent / 200);
    } else {
      row.igst = r2(row.taxable * row.gst_percent / 100);
    }
  }
  return Object.values(map);
}

function deriveInvoiceFinancials(inv) {
  const lineItems = inv.line_items ?? [];
  const billDiscount = inv.bill_discount_amount ?? 0;

  const goods_subtotal = r2(lineItems.reduce((s, it) => s + calcLineAmount(it), 0));
  const net_goods_taxable = r2(goods_subtotal - billDiscount);

  const tax_rows = buildHsnSummary(lineItems, inv.tax_type, billDiscount);
  const cgst = r2(tax_rows.reduce((s, row) => s + row.cgst, 0));
  const sgst = r2(tax_rows.reduce((s, row) => s + row.sgst, 0));
  const igst = r2(tax_rows.reduce((s, row) => s + row.igst, 0));
  const total_gst = r2(cgst + sgst + igst);
  const round_off = r2(inv.round_off ?? 0);
  const total = r2(net_goods_taxable + total_gst + round_off);

  return { goods_subtotal, net_goods_taxable, tax_rows, cgst, sgst, igst, total_gst, round_off, total };
}

// ── Replicates XML generator amount formatting ─────────────────────────────────
const fmt2 = (n) => n.toFixed(2);

// ── Helpers ────────────────────────────────────────────────────────────────────
const SEP = '─'.repeat(70);
const DSEP = '═'.repeat(70);
const lbl = (k, v, note = '') => {
  const val = typeof v === 'number' ? v.toFixed(6) + (note ? `  ← ${note}` : '') : String(v) + (note ? `  ← ${note}` : '');
  console.log(`    ${String(k).padEnd(28)} : ${val}`);
};
const diff = (label, before, after) => {
  const d = r2(after - before);
  const mark = d === 0 ? '✓ no change' : `⚠ CHANGED by ${d >= 0 ? '+' : ''}${d.toFixed(2)}`;
  console.log(`    ${label.padEnd(28)} : ${before.toFixed(2)} → ${after.toFixed(2)}  ${mark}`);
};

// ══════════════════════════════════════════════════════════════════════════════
// STAGE A — Excel Source Values
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n' + DSEP);
console.log('STAGE A — EXCEL SOURCE VALUES (KKE002397)');
console.log(DSEP);
console.log('  (From GSTR-1 Tally export — these are the values on the tax invoice)');
const EXCEL = {
  qty: 100,
  taxable: 3809.52,
  cgst: 95.24,
  sgst: 95.24,
  round_off: 0.00,
  total: 4000.00,
  rate: null,     // ABSENT — GSTR-1 does not include a rate column
  disc_percent: 0,
  gst_percent: 5, // derived from cgst/taxable: (95.24/3809.52)*200 ≈ 5.00
  hsn: '63041910',
};
lbl('qty', EXCEL.qty);
lbl('taxable (source)', EXCEL.taxable);
lbl('cgst (source)', EXCEL.cgst);
lbl('sgst (source)', EXCEL.sgst);
lbl('round_off (source)', EXCEL.round_off);
lbl('total (source)', EXCEL.total);
lbl('rate', 'ABSENT in GSTR-1 format', 'must be derived');
lbl('gst_percent', EXCEL.gst_percent, 'derived: (95.24+95.24)/3809.52 * 100/2 = 5.00%');

// ══════════════════════════════════════════════════════════════════════════════
// STAGE B — assembleInvoices() Output
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n' + DSEP);
console.log('STAGE B — assembleInvoices() OUTPUT');
console.log(DSEP);

// subtotal: uses taxable_amount directly (non-zero)
const B_taxable_from_row = EXCEL.taxable; // r.taxable_amount || r2(r.quantity * r.rate)
const B_subtotal = r2(B_taxable_from_row); // sum across rows

// rate derivation (line 362 of salesExtract.ts)
const B_rate_exact = EXCEL.taxable / EXCEL.qty;
const B_rate_r2 = r2(B_rate_exact);

// cgst/sgst from Excel columns
const B_cgst = r2(EXCEL.cgst);
const B_sgst = r2(EXCEL.sgst);
const B_explicit_total = r2(EXCEL.total);
const B_computed_total = r2(B_subtotal + B_cgst + B_sgst);
const B_round_off = r2(B_explicit_total - B_computed_total);

// LineItem as constructed in assembleInvoices
const B_lineItem = {
  description: 'UNKNOWN ITEM',
  hsn: EXCEL.hsn,
  gst_percent: EXCEL.gst_percent,
  uom: 'Nos',
  qty: EXCEL.qty,
  rate: B_rate_r2,  // ← r2 applied here
  disc_percent: 0,
  amount: B_taxable_from_row, // ← set from Excel taxable directly
};

console.log('\n  Rate derivation (salesExtract.ts line 362):');
console.log(`    r.rate = 0  (absent from Excel)`);
console.log(`    rawRate = r.rate || r2(taxable / qty)`);
console.log(`           = 0    ||  r2(${EXCEL.taxable} / ${EXCEL.qty})`);
console.log(`           = 0    ||  r2(${B_rate_exact})`);
console.log(`           = 0    ||  ${B_rate_r2}    ← r2() ROUNDS ${B_rate_exact} to ${B_rate_r2}`);
console.log(`    rate   = Math.abs(${B_rate_r2}) = ${B_rate_r2}`);

console.log('\n  Invoice-level values:');
lbl('subtotal', B_subtotal, 'from Excel taxable_amount directly');
lbl('cgst (assembleInvoices)', B_cgst, 'from Excel cgst_amount = 95.24  ✓');
lbl('sgst (assembleInvoices)', B_sgst, 'from Excel sgst_amount = 95.24  ✓');
lbl('total (assembleInvoices)', B_explicit_total, 'from Excel total_amount = 4000.00  ✓');
lbl('computed_total', B_computed_total, '= subtotal + cgst + sgst');
lbl('round_off', B_round_off, '= explicit_total - computed_total');

console.log('\n  LineItem[0] as constructed:');
lbl('  qty', B_lineItem.qty);
lbl('  rate', B_lineItem.rate, `r2(${B_rate_exact}) — PRECISION LOSS HERE`);
lbl('  amount', B_lineItem.amount, 'direct from Excel taxable  ✓');
lbl('  disc_percent', B_lineItem.disc_percent);
lbl('  gst_percent', B_lineItem.gst_percent);

console.log(`\n  STATUS: Invoice-level cgst/sgst/total CORRECT at this stage.`);
console.log(`          LineItem.amount CORRECT (3809.52) but rate ROUNDED (38.10 not 38.0952).`);
console.log(`          Drift is LATENT — it will fire when normalizeLineItem rewrites amount.`);

// ══════════════════════════════════════════════════════════════════════════════
// STAGE C — normalizeLineItem INPUT
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n' + DSEP);
console.log('STAGE C — normalizeLineItem INPUT');
console.log(DSEP);
console.log('\n  Object entering normalizeLineItem:');
console.log(JSON.stringify(B_lineItem, null, 4));

// ══════════════════════════════════════════════════════════════════════════════
// STAGE D — normalizeLineItem OUTPUT
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n' + DSEP);
console.log('STAGE D — normalizeLineItem OUTPUT');
console.log(DSEP);

const D_lineItem = normalizeLineItem(B_lineItem);

console.log('\n  Inside normalizeLineItem:');
console.log(`    disc     = ${B_lineItem.disc_percent}`);
console.log(`    qty      = ${B_lineItem.qty}  (no sign change — rawAmount=${B_lineItem.amount} >= 0)`);
console.log(`    rate     = Math.abs(${B_lineItem.rate}) = ${D_lineItem.rate}  (unchanged)`);
console.log(`    amount   = r2(qty × rate × (1 - disc/100))`);
console.log(`             = r2(${D_lineItem.qty} × ${D_lineItem.rate} × 1)`);
console.log(`             = r2(${D_lineItem.qty * D_lineItem.rate})`);
console.log(`             = ${D_lineItem.amount}   ← OVERWRITES 3809.52`);

console.log('\n  BEFORE vs AFTER normalizeLineItem:');
diff('  qty', B_lineItem.qty, D_lineItem.qty);
diff('  rate', B_lineItem.rate, D_lineItem.rate);
diff('  amount', B_lineItem.amount, D_lineItem.amount);

console.log(`\n  !! DRIFT ACTIVATES HERE !!`);
console.log(`     item.amount: 3809.52 → 3810.00  (Δ = +0.48)`);
console.log(`     The Excel taxable value is permanently replaced by qty × rate.`);

// ══════════════════════════════════════════════════════════════════════════════
// STAGE E — deriveInvoiceFinancials
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n' + DSEP);
console.log('STAGE E — deriveInvoiceFinancials()');
console.log(DSEP);

const E_inv = {
  line_items: [D_lineItem],
  tax_type: 'cgst_sgst',
  bill_discount_amount: 0,
  round_off: B_round_off,
};

const E_d = deriveInvoiceFinancials(E_inv);

console.log('\n  Input line_items[0]:');
lbl('  qty', D_lineItem.qty);
lbl('  rate', D_lineItem.rate);
lbl('  amount (stored)', D_lineItem.amount, 'THIS IS THE DRIFTED VALUE');
lbl('  disc_percent', D_lineItem.disc_percent);
lbl('  gst_percent', D_lineItem.gst_percent);

console.log('\n  calcLineAmount(item):');
console.log(`    = r2(qty × rate × (1 - disc/100))`);
console.log(`    = r2(${D_lineItem.qty} × ${D_lineItem.rate} × 1)`);
console.log(`    = r2(${D_lineItem.qty * D_lineItem.rate})`);
console.log(`    = ${calcLineAmount(D_lineItem)}  ← NOTE: ignores item.amount entirely`);

console.log('\n  buildHsnSummary:');
const hsnRow = E_d.tax_rows[0];
console.log(`    taxable accumulated = ${hsnRow.taxable}  (from calcLineAmount)`);
console.log(`    CGST = r2(${hsnRow.taxable} × ${hsnRow.gst_percent} / 200)`);
console.log(`         = r2(${hsnRow.taxable * hsnRow.gst_percent / 200})`);
console.log(`         = ${hsnRow.cgst}`);
console.log(`    SGST = ${hsnRow.sgst}  (same formula)`);

console.log('\n  Derived financial values:');
lbl('  goods_subtotal', E_d.goods_subtotal, 'WRONG — should be 3809.52');
lbl('  cgst', E_d.cgst, 'WRONG — should be 95.24');
lbl('  sgst', E_d.sgst, 'WRONG — should be 95.24');
lbl('  igst', E_d.igst);
lbl('  round_off', E_d.round_off);
lbl('  total', E_d.total, 'WRONG — should be 4000.00');

// ══════════════════════════════════════════════════════════════════════════════
// STAGE F — Database Insert (what gets stored)
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n' + DSEP);
console.log('STAGE F — DATABASE INSERT (what gets stored)');
console.log(DSEP);
const F_inv_original = {
  subtotal: B_subtotal,
  cgst: B_cgst,
  sgst: B_sgst,
  igst: 0,
  total: B_explicit_total,
  round_off: B_round_off,
};

console.log('\n  Column              │ Value         │ Source                   │ Status');
console.log('  ──────────────────────────────────────────────────────────────────────────');
const col = (name, val, source, ok) =>
  console.log(`  ${name.padEnd(20)}│ ${val.padEnd(14)}│ ${source.padEnd(26)}│ ${ok}`);

col('subtotal',         B_subtotal.toFixed(2),         'inv.subtotal (assembleInvoices)', '✓ 3809.52 correct');
col('supplier_cgst',    B_cgst.toFixed(2),             'inv.cgst (from Excel)',           '✓ 95.24 correct');
col('supplier_sgst',    B_sgst.toFixed(2),             'inv.sgst (from Excel)',           '✓ 95.24 correct');
col('supplier_igst',    (0).toFixed(2),                'inv.igst',                        '✓ 0.00');
col('supplier_total',   B_explicit_total.toFixed(2),   'inv.total (from Excel)',           '✓ 4000.00 correct');
col('supplier_roundoff',B_round_off.toFixed(2),        'inv.round_off',                   '✓ 0.00');
col('cgst',             E_d.cgst.toFixed(2),           'd.cgst (deriveInvoiceFinancials)', '✗ WRONG: should be 95.24');
col('sgst',             E_d.sgst.toFixed(2),           'd.sgst (deriveInvoiceFinancials)', '✗ WRONG: should be 95.24');
col('igst',             E_d.igst.toFixed(2),           'd.igst',                           '✓ 0.00');
col('total',            E_d.total.toFixed(2),          'd.total (deriveInvoiceFinancials)','✗ WRONG: should be 4000.00');
col('round_off',        E_d.round_off.toFixed(2),      'inv.round_off',                   '✓ 0.00');

console.log('\n  line_items[0] in JSONB:');
console.log('  ' + JSON.stringify({ qty: D_lineItem.qty, rate: D_lineItem.rate, amount: D_lineItem.amount,
  disc_percent: D_lineItem.disc_percent, gst_percent: D_lineItem.gst_percent, hsn: D_lineItem.hsn }));
console.log('  → amount field: 3810.00  (WRONG — should be 3809.52)');
console.log('  → rate field:    38.10   (WRONG — true rate is 38.0952)');

// ══════════════════════════════════════════════════════════════════════════════
// STAGE G — Register Display
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n' + DSEP);
console.log('STAGE G — REGISTER DISPLAY (what is shown)');
console.log(DSEP);

// computeInvoiceFinancials from register/page.tsx — replicates exactly
const G_subtotal = [D_lineItem].reduce((s, it) => s + calcLineAmount(it), 0);
const G_hsnRows = buildHsnSummary([D_lineItem], 'cgst_sgst', 0);
const G_cgst = Math.round(G_hsnRows.reduce((s, r) => s + r.cgst, 0) * 100) / 100;
const G_sgst = Math.round(G_hsnRows.reduce((s, r) => s + r.sgst, 0) * 100) / 100;
const G_total = r2(G_subtotal + G_cgst + G_sgst + B_round_off);

console.log('\n  computeInvoiceFinancials() called at every page load with stored line_items:');
console.log(`    subtotal = Σ calcLineAmount(item)`);
console.log(`             = calcLineAmount({qty:${D_lineItem.qty}, rate:${D_lineItem.rate}, disc:0})`);
console.log(`             = r2(${D_lineItem.qty} × ${D_lineItem.rate} × 1) = ${G_subtotal}`);
console.log(`    hsnRows  = buildHsnSummary(line_items)`);
console.log(`    CGST     = ${G_cgst}`);
console.log(`    SGST     = ${G_sgst}`);
console.log(`    total    = ${G_total}`);

console.log('\n  What is stored vs what is displayed:');
console.log(`  ${'Field'.padEnd(20)} │ ${'Stored in DB'.padEnd(14)} │ ${'Displayed in Register'.padEnd(22)} │ Status`);
console.log(`  ${'─'.repeat(78)}`);
const regrow = (f, stored, displayed) => {
  const match = Math.abs(stored - displayed) < 0.005;
  console.log(`  ${f.padEnd(20)} │ ${stored.toFixed(2).padEnd(14)} │ ${displayed.toFixed(2).padEnd(22)} │ ${match ? '= same' : '= same (both wrong)'}`);
};
regrow('taxable', E_d.goods_subtotal, G_subtotal);
regrow('CGST', E_d.cgst, G_cgst);
regrow('SGST', E_d.sgst, G_sgst);
regrow('total', E_d.total, G_total);
console.log(`\n  Note: stored cgst/total and displayed cgst/total agree — both are wrong.`);
console.log(`        The error is symmetric: both sides derive from the same drifted line_items.`);
console.log(`        Only supplier_cgst=95.24 and subtotal=3809.52 retain correct values.`);

// ══════════════════════════════════════════════════════════════════════════════
// STAGE H — XML Export
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n' + DSEP);
console.log('STAGE H — XML EXPORT (what Tally receives)');
console.log(DSEP);

// xmlGenerator.ts uses deriveInvoiceFinancials — same as Stage E
const H_d = E_d; // identical derivation
const H_itemNet = calcLineAmount(D_lineItem); // used for stock/sales line

console.log('\n  deriveInvoiceFinancials called by buildInvoiceVoucher:');
console.log(`    d.total = ${H_d.total}  (WRONG — should be 4000.00)`);
console.log(`    d.cgst  = ${H_d.cgst}   (WRONG — should be 95.24)`);
console.log(`    d.sgst  = ${H_d.sgst}   (WRONG — should be 95.24)`);

console.log('\n  XML ledger entries generated:');
console.log(`  ┌─────────────────────────────────────────────────────────────────────┐`);
console.log(`  │ ALLLEDGERENTRIES.LIST  (Party Ledger — Sundry Debtor/Creditor)      │`);
console.log(`  │   AMOUNT = ${fmt2(-H_d.total).padEnd(10)}  ← WRONG (invoice says 4000.00)  │`);
console.log(`  ├─────────────────────────────────────────────────────────────────────┤`);
console.log(`  │ ALLLEDGERENTRIES.LIST  (CGST Ledger)                                │`);
console.log(`  │   AMOUNT = ${fmt2(-H_d.cgst).padEnd(10)}  ← WRONG (invoice says 95.24)     │`);
console.log(`  ├─────────────────────────────────────────────────────────────────────┤`);
console.log(`  │ ALLLEDGERENTRIES.LIST  (SGST Ledger)                                │`);
console.log(`  │   AMOUNT = ${fmt2(-H_d.sgst).padEnd(10)}  ← WRONG (invoice says 95.24)     │`);
console.log(`  ├─────────────────────────────────────────────────────────────────────┤`);
console.log(`  │ INVENTORYENTRIES.LIST  (Stock/Sales Ledger)                         │`);
console.log(`  │   AMOUNT = ${fmt2(H_itemNet).padEnd(10)}  ← WRONG (invoice taxable is 3809.52) │`);
console.log(`  └─────────────────────────────────────────────────────────────────────┘`);

console.log('\n  Tally accounting impact:');
console.log(`    • Voucher total ₹4000.50 ≠ Invoice total ₹4000.00  → Δ = +₹0.50`);
console.log(`    • If customer pays ₹4000.00 against this voucher, Tally shows ₹0.50 outstanding`);
console.log(`    • Cannot close this voucher without a manual adjustment journal entry`);
console.log(`    • GSTR-1 filed: CGST=95.24. Tally voucher: CGST=95.25. Δ=₹0.01 reconciliation gap`);

// ══════════════════════════════════════════════════════════════════════════════
// PRECISION SCENARIOS — Rate Precision vs Drift
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n' + DSEP);
console.log('RATE PRECISION SCENARIOS');
console.log(DSEP);

const precisions = [
  { name: '2 decimal (current)', round: (n) => Math.round(n * 100) / 100 },
  { name: '4 decimal',           round: (n) => Math.round(n * 10000) / 10000 },
  { name: '6 decimal',           round: (n) => Math.round(n * 1000000) / 1000000 },
  { name: '8 decimal',           round: (n) => Math.round(n * 100000000) / 100000000 },
  { name: 'Full float',          round: (n) => n },
];

console.log(`\n  True rate = ${EXCEL.taxable} / ${EXCEL.qty} = ${EXCEL.taxable / EXCEL.qty}`);
console.log('');
console.log(`  ${'Precision'.padEnd(20)} │ ${'Rate Stored'.padEnd(14)} │ ${'Taxable'.padEnd(10)} │ ${'ΔTaxable'.padEnd(9)} │ ${'CGST'.padEnd(8)} │ ${'ΔCGST'.padEnd(8)} │ ${'Total'.padEnd(10)} │ ΔTotal`);
console.log(`  ${'─'.repeat(110)}`);
for (const p of precisions) {
  const pRate = p.round(EXCEL.taxable / EXCEL.qty);
  const pAmt = r2(EXCEL.qty * pRate);
  const hsnRow = {};
  const taxable = pAmt;
  const cgst = r2(taxable * EXCEL.gst_percent / 200);
  const sgst = r2(taxable * EXCEL.gst_percent / 200);
  const total = r2(taxable + cgst + sgst);
  const dTax = r2(pAmt - EXCEL.taxable);
  const dCgst = r2(cgst - EXCEL.cgst);
  const dTotal = r2(total - EXCEL.total);
  const sign = (n) => (n >= 0 ? '+' : '') + n.toFixed(2);
  console.log(
    `  ${p.name.padEnd(20)} │ ${pRate.toFixed(8).padEnd(14)} │ ${pAmt.toFixed(2).padEnd(10)} │ ${sign(dTax).padEnd(9)} │ ${cgst.toFixed(2).padEnd(8)} │ ${sign(dCgst).padEnd(8)} │ ${total.toFixed(2).padEnd(10)} │ ${sign(dTotal)}`
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// WHAT SOURCE-PRESERVATION WOULD PRODUCE
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n' + DSEP);
console.log('WHAT SOURCE-PRESERVED ARCHITECTURE PRODUCES');
console.log(DSEP);

// Approach B: normalizeLineItem preserves item.amount; calcLineAmount uses item.amount
const SP_lineItem = { ...B_lineItem }; // amount = 3809.52 is preserved
// calcLineAmount modified to use item.amount when disc_percent === 0 and amount is set
const calcLineAmountB = (item) => {
  if (item.amount != null && item.disc_percent === 0) return item.amount;
  return r2(item.qty * item.rate * (1 - item.disc_percent / 100));
};

const SP_subtotal = SP_lineItem.amount; // 3809.52
const SP_cgst = r2(SP_subtotal * EXCEL.gst_percent / 200);
const SP_sgst = r2(SP_subtotal * EXCEL.gst_percent / 200);
const SP_total = r2(SP_subtotal + SP_cgst + SP_sgst);

console.log('\n  Source-preserved calcLineAmount uses item.amount when available:');
console.log(`    item.amount   = ${SP_lineItem.amount}  (preserved from Excel)`);
console.log(`    calcLineAmountB = ${SP_lineItem.amount}  ← no qty×rate reconstruction`);
console.log('');
console.log(`  buildHsnSummary:`);
console.log(`    taxable  = ${SP_subtotal}   ✓ matches Excel`);
console.log(`    CGST     = r2(${SP_subtotal} × ${EXCEL.gst_percent} / 200) = r2(${SP_subtotal * EXCEL.gst_percent / 200}) = ${SP_cgst}   ✓ matches Excel`);
console.log(`    SGST     = ${SP_sgst}   ✓ matches Excel`);
console.log(`    total    = ${SP_total}   ✓ matches Excel`);
console.log('');
console.log(`  Comparison:`);
console.log(`  ${'Field'.padEnd(12)} │ ${'Excel Source'.padEnd(14)} │ ${'Current System'.padEnd(14)} │ ${'Source-Preserved'.padEnd(16)} │ Δ Current  │ Δ Preserved`);
console.log(`  ${'─'.repeat(86)}`);
const comprow = (f, ex, curr, sp) =>
  console.log(`  ${f.padEnd(12)} │ ${ex.toFixed(2).padEnd(14)} │ ${curr.toFixed(2).padEnd(14)} │ ${sp.toFixed(2).padEnd(16)} │ ${((curr-ex)>=0?'+':'')+(curr-ex).toFixed(2).padEnd(10)} │ ${((sp-ex)>=0?'+':'')+(sp-ex).toFixed(2)}`);
comprow('Taxable', EXCEL.taxable, E_d.goods_subtotal, SP_subtotal);
comprow('CGST', EXCEL.cgst, E_d.cgst, SP_cgst);
comprow('SGST', EXCEL.sgst, E_d.sgst, SP_sgst);
comprow('Total', EXCEL.total, E_d.total, SP_total);

console.log('\n  Source-preserved architecture eliminates ALL drift for KKE002397.');
console.log('  Result matches Excel exactly when item.amount is preserved from the source.\n');

console.log(DSEP);
console.log('END OF TRACE — KKE002397');
console.log(DSEP + '\n');
