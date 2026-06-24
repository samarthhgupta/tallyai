/**
 * Financial Reconciliation Audit — TallyAI
 * =========================================
 * Covers:
 *   TASK 1  — Dataset-wide drift quantification (Sales + Purchase)
 *   TASK 2  — Top 100 worst invoices
 *   TASK 3  — Root cause classification (A–F)
 *   TASK 4  — Purchase drift audit (YES/NO + magnitude)
 *   TASK 5  — Supplier vs Derived values (two-truth audit)
 *   TASK 6  — GST rounding method comparison (OldDirect vs TwoStep vs SignConsistent)
 *   TASK 7  — CGST ≠ SGST mismatch detection (equal-rate invoices)
 *
 * Run from repo root on any machine with Supabase access:
 *   node scripts/audit_financial_drift.mjs
 *
 * Or override credentials:
 *   SUPABASE_URL=https://... SUPABASE_KEY=... node scripts/audit_financial_drift.mjs
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// ── Credentials ────────────────────────────────────────────────────────────────
let SUPABASE_URL = process.env.SUPABASE_URL;
let SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  try {
    const __dir = dirname(fileURLToPath(import.meta.url));
    const s = JSON.parse(readFileSync(join(__dir, '../.claude/settings.local.json'), 'utf8'));
    SUPABASE_URL = SUPABASE_URL || s.env.NEXT_PUBLIC_SUPABASE_URL;
    SUPABASE_KEY = SUPABASE_KEY || s.env.SUPABASE_SERVICE_ROLE_KEY;
  } catch (e) {
    console.error('Could not load credentials. Set SUPABASE_URL and SUPABASE_KEY env vars.');
    process.exit(1);
  }
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Math helpers ───────────────────────────────────────────────────────────────

// Production r2 (OldDirect — current after 8d5d8f0 fix)
const r2 = (n) => Math.round(n * 100) / 100;

// Sign-consistent r2 (what was briefly applied and reverted)
const r2sc = (n) => n === 0 ? 0 : Math.sign(n) * Math.round(Math.abs(n) * 100) / 100;

// OldDirect GST (current production)
function gstOldDirect(taxable, gstPct, taxType) {
  if (taxType === 'cgst_sgst') {
    return { cgst: r2(taxable * gstPct / 200), sgst: r2(taxable * gstPct / 200), igst: 0 };
  }
  return { cgst: 0, sgst: 0, igst: r2(taxable * gstPct / 100) };
}

// TwoStep GST (previous production, pre-fix)
function gstTwoStep(taxable, gstPct, taxType) {
  const tax = r2(taxable * gstPct / 100);
  if (taxType === 'cgst_sgst') {
    return { cgst: r2(tax / 2), sgst: r2(tax / 2), igst: 0 };
  }
  return { cgst: 0, sgst: 0, igst: tax };
}

// SignConsistent + OldDirect (briefly tried, reverted)
function gstSignConsistentDirect(taxable, gstPct, taxType) {
  if (taxType === 'cgst_sgst') {
    return { cgst: r2sc(taxable * gstPct / 200), sgst: r2sc(taxable * gstPct / 200), igst: 0 };
  }
  return { cgst: 0, sgst: 0, igst: r2sc(taxable * gstPct / 100) };
}

function calcLineAmount(item) {
  return r2((item.qty ?? 0) * (item.rate ?? 0) * (1 - (item.disc_percent ?? 0) / 100));
}

function sysTaxableFromLineItems(lineItems) {
  if (!Array.isArray(lineItems) || lineItems.length === 0) return 0;
  return r2(lineItems.reduce((s, item) => s + calcLineAmount(item), 0));
}

// Hybrid: trust item.amount when disc_percent=0 and amount is set
function hybridTaxableFromLineItems(lineItems) {
  if (!Array.isArray(lineItems) || lineItems.length === 0) return 0;
  return r2(lineItems.reduce((s, item) => {
    const disc = item.disc_percent ?? 0;
    const amt  = item.amount;
    if (disc === 0 && amt != null && amt !== 0) return s + amt;
    return s + calcLineAmount(item);
  }, 0));
}

// ── Drift buckets ──────────────────────────────────────────────────────────────
// Buckets: exact / ≤0.01 / 0.02–0.10 / 0.11–0.50 / 0.51–1.00 / >1.00
function bucket(absVal) {
  if (absVal === 0)        return 'exact';
  if (absVal <= 0.01)      return 'le001';
  if (absVal <= 0.10)      return 'r002_010';
  if (absVal <= 0.50)      return 'r011_050';
  if (absVal <= 1.00)      return 'r051_100';
  return 'gt100';
}

const BUCKETS = ['exact', 'le001', 'r002_010', 'r011_050', 'r051_100', 'gt100'];
const BLABELS = {
  exact:    'Exact match (Δ = 0.00)     ',
  le001:    '≤ ₹0.01                     ',
  r002_010: '₹0.02 – ₹0.10              ',
  r011_050: '₹0.11 – ₹0.50              ',
  r051_100: '₹0.51 – ₹1.00              ',
  gt100:    '> ₹1.00                     ',
};

function emptyBuckets() {
  return { exact:0, le001:0, r002_010:0, r011_050:0, r051_100:0, gt100:0 };
}

function printBucketTable(label, counts, total) {
  const pct = (n) => ((n / total) * 100).toFixed(1).padStart(5);
  console.log(`  ${label}`);
  console.log(`  ${'─'.repeat(54)}`);
  for (const b of BUCKETS) {
    console.log(`  ${BLABELS[b]}: ${String(counts[b]).padStart(5)} (${pct(counts[b])}%)`);
  }
  console.log(`  ${'─'.repeat(54)}`);
  console.log(`  TOTAL                              : ${String(total).padStart(5)}`);
  console.log('');
}

// ── Root cause classifier ──────────────────────────────────────────────────────
// A: Rate precision loss → taxable drifts because rate was rounded (item.amount ≠ calcLineAmount)
// B: normalizeLineItem overwrite → same trigger as A, confirmed when diverged items > 0
// C: GST recomputation drift → taxable OK but GST changes
// D: Round-off recomputation → total differs because round_off differs
// E: Source data inconsistency → source totals don't arithmetic-check
// F: Other
function classifyRootCause(inv, r) {
  const taxDrift  = Math.abs(r.dTax)   > 0.005;
  const gstDrift  = Math.abs(r.dCgst)  > 0.005 || Math.abs(r.dSgst) > 0.005 || Math.abs(r.dIgst) > 0.005;
  const totalDrift = Math.abs(r.dTotal) > 0.005;
  const hasItemDivergence = (inv.line_items ?? []).some(item => {
    const amt = item.amount;
    return amt != null && Math.abs(amt - calcLineAmount(item)) > 0.005;
  });

  // Detect source arithmetic inconsistency
  const srcCheck = r2(r.exCgst + r.exSgst + r.exIgst);
  const srcGst   = srcCheck;
  const srcTaxPlusFees = r.exTax; // simplified; charges not stored separately
  const srcArithOk = Math.abs((r.exTotal) - r2(r.exTax + r.exCgst + r.exSgst + r.exIgst)) < 0.10;

  if (!srcArithOk && totalDrift) return 'E';
  if (taxDrift && hasItemDivergence) return 'A';
  if (taxDrift && !hasItemDivergence) return 'B'; // overwrite without divergence? unusual
  if (!taxDrift && gstDrift) return 'C';
  if (!taxDrift && !gstDrift && totalDrift) return 'D';
  return 'F';
}

const CAUSE_LABELS = {
  A: 'A — Rate precision loss + normalizeLineItem overwrite',
  B: 'B — normalizeLineItem overwrite (no stored amount divergence)',
  C: 'C — GST recomputation drift (taxable OK, GST wrong)',
  D: 'D — Round-off recomputation',
  E: 'E — Source data inconsistency (source totals don\'t check)',
  F: 'F — Other / no drift detected',
};

// ── Fetch with pagination ──────────────────────────────────────────────────────
async function fetchAll(table) {
  const select = [
    'invoice_number', 'source', 'tax_type',
    'subtotal', 'cgst', 'sgst', 'igst', 'total', 'round_off',
    'supplier_cgst', 'supplier_sgst', 'supplier_igst',
    'supplier_total', 'supplier_roundoff',
    'line_items',
  ].join(',');

  let all = [];
  let from = 0;
  const PAGE = 1000;
  while (true) {
    const { data, error } = await sb.from(table).select(select).range(from, from + PAGE - 1);
    if (error) throw new Error(`[${table}] ${error.message}`);
    if (!data || data.length === 0) break;
    all = all.concat(data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

// ── Format helpers ─────────────────────────────────────────────────────────────
const f = (n) => n.toFixed(2).padStart(14);
const fpm = (n) => ((n >= 0 ? '+' : '') + n.toFixed(2)).padStart(9);
const fp = (n, total) => ((n / total) * 100).toFixed(1).padStart(5) + '%';

// ── Main audit function ────────────────────────────────────────────────────────
async function auditTable(table, label) {
  const BAR = '═'.repeat(80);
  console.log(`\n${BAR}`);
  console.log(`  AUDIT: ${label.toUpperCase()}`);
  console.log(`  Table: ${table}`);
  console.log(`${BAR}\n`);

  const rows = await fetchAll(table);
  console.log(`  Rows fetched: ${rows.length}\n`);

  if (rows.length === 0) {
    console.log('  (empty — skipping)\n');
    return null;
  }

  // Compute per-invoice metrics
  const results = rows.map((inv) => {
    const exTax   = Number(inv.subtotal ?? 0);
    const exCgst  = Number(inv.supplier_cgst  ?? 0);
    const exSgst  = Number(inv.supplier_sgst  ?? 0);
    const exIgst  = Number(inv.supplier_igst  ?? 0);
    const exTotal = Number(inv.supplier_total ?? 0);
    const exRo    = Number(inv.supplier_roundoff ?? 0);

    const sysCgst  = Number(inv.cgst  ?? 0);
    const sysSgst  = Number(inv.sgst  ?? 0);
    const sysIgst  = Number(inv.igst  ?? 0);
    const sysTotal = Number(inv.total ?? 0);
    const sysRo    = Number(inv.round_off ?? 0);

    const sysTax   = sysTaxableFromLineItems(inv.line_items);
    const hybTax   = hybridTaxableFromLineItems(inv.line_items);

    const dTax   = r2(sysTax   - exTax);
    const dCgst  = r2(sysCgst  - exCgst);
    const dSgst  = r2(sysSgst  - exSgst);
    const dIgst  = r2(sysIgst  - exIgst);
    const dTotal = r2(sysTotal - exTotal);
    const dRo    = r2(sysRo    - exRo);

    const maxAbsDiff = Math.max(
      Math.abs(dTax), Math.abs(dCgst), Math.abs(dSgst),
      Math.abs(dIgst), Math.abs(dTotal)
    );

    const hasSupplier = inv.supplier_cgst != null || inv.supplier_total != null;

    // Item divergence (for root cause classification and line-item audit)
    const lineItems = inv.line_items ?? [];
    const divergedItems = lineItems.filter(item => {
      const amt = item.amount;
      return amt != null && Math.abs(amt - calcLineAmount(item)) > 0.005;
    });

    return {
      inv,
      no: inv.invoice_number, src: inv.source ?? '', taxType: inv.tax_type ?? 'cgst_sgst',
      exTax, exCgst, exSgst, exIgst, exTotal, exRo,
      sysTax, sysCgst, sysSgst, sysIgst, sysTotal, sysRo,
      hybTax,
      dTax, dCgst, dSgst, dIgst, dTotal, dRo,
      maxAbsDiff,
      hasSupplier,
      divergedItems: divergedItems.length,
      totalItems: lineItems.length,
    };
  });

  const withSupplier = results.filter(r => r.hasSupplier);
  const noSupplier   = results.filter(r => !r.hasSupplier);
  console.log(`  Rows with supplier_* data (comparable) : ${withSupplier.length}`);
  console.log(`  Rows without supplier_* data (pre-034)  : ${noSupplier.length}\n`);

  const R = withSupplier.length > 0 ? withSupplier : results;
  const N = R.length;

  // ────────────────────────────────────────────────────────────────────────────
  // TASK 1 — DRIFT BUCKETS
  // ────────────────────────────────────────────────────────────────────────────
  console.log('━'.repeat(80));
  console.log('  TASK 1 — DRIFT QUANTIFICATION BY FIELD');
  console.log('━'.repeat(80) + '\n');

  const bTax   = emptyBuckets();
  const bCgst  = emptyBuckets();
  const bSgst  = emptyBuckets();
  const bIgst  = emptyBuckets();
  const bTotal = emptyBuckets();

  for (const r of R) {
    bTax[bucket(Math.abs(r.dTax))]++;
    bCgst[bucket(Math.abs(r.dCgst))]++;
    bSgst[bucket(Math.abs(r.dSgst))]++;
    bIgst[bucket(Math.abs(r.dIgst))]++;
    bTotal[bucket(Math.abs(r.dTotal))]++;
  }

  printBucketTable('TAXABLE  (system calcLineAmount vs Excel subtotal)', bTax,   N);
  printBucketTable('CGST     (derived vs supplier_cgst)',                 bCgst,  N);
  printBucketTable('SGST     (derived vs supplier_sgst)',                 bSgst,  N);
  printBucketTable('IGST     (derived vs supplier_igst)',                 bIgst,  N);
  printBucketTable('TOTAL    (derived vs supplier_total)',                 bTotal, N);

  // Aggregate impact
  const sum = (field) => r2(R.reduce((s, r) => s + r[field], 0));
  console.log('  AGGREGATE IMPACT\n');
  console.log(`  ${'Field'.padEnd(8)} │${'Excel Source'.padStart(16)} │${'System Derived'.padStart(16)} │${'Difference'.padStart(12)}`);
  console.log(`  ${'─'.repeat(8)}─┼${'─'.repeat(16)}─┼${'─'.repeat(16)}─┼${'─'.repeat(12)}`);
  const agRow = (lbl, exF, sysF) => {
    const ex = sum(exF), sys = sum(sysF), d = r2(sys - ex);
    return `  ${lbl.padEnd(8)} │${f(ex)} │${f(sys)} │${fpm(d).padStart(12)}`;
  };
  console.log(agRow('Taxable',  'exTax',   'sysTax'));
  console.log(agRow('CGST',     'exCgst',  'sysCgst'));
  console.log(agRow('SGST',     'exSgst',  'sysSgst'));
  console.log(agRow('IGST',     'exIgst',  'sysIgst'));
  console.log(agRow('Total',    'exTotal', 'sysTotal'));
  console.log('');

  // ────────────────────────────────────────────────────────────────────────────
  // TASK 2 — TOP 100 WORST INVOICES
  // ────────────────────────────────────────────────────────────────────────────
  console.log('━'.repeat(80));
  console.log('  TASK 2 — TOP 100 WORST INVOICES (sorted by |max field drift|)');
  console.log('━'.repeat(80) + '\n');

  const drifted = R.filter(r => r.maxAbsDiff > 0).sort((a, b) => b.maxAbsDiff - a.maxAbsDiff);
  const top100  = drifted.slice(0, 100);

  if (top100.length === 0) {
    console.log('  All comparable invoices are exact matches.\n');
  } else {
    console.log(`  ${drifted.length} of ${N} invoices have at least one drifted field.\n`);
    const hdr = [
      'Invoice'.padEnd(16), 'Src'.padEnd(8),
      'ΔTaxable'.padStart(10), 'ΔCGST'.padStart(8), 'ΔSGST'.padStart(8),
      'ΔIGST'.padStart(8), 'ΔTotal'.padStart(9),
    ].join(' ');
    console.log(`  ${hdr}`);
    console.log(`  ${'─'.repeat(75)}`);
    for (const r of top100) {
      const row = [
        r.no.padEnd(16), (r.src || '').slice(0, 8).padEnd(8),
        fpm(r.dTax).padStart(10), fpm(r.dCgst).padStart(8), fpm(r.dSgst).padStart(8),
        fpm(r.dIgst).padStart(8), fpm(r.dTotal).padStart(9),
      ].join(' ');
      console.log(`  ${row}`);
    }
    console.log('');
  }

  // ────────────────────────────────────────────────────────────────────────────
  // TASK 3 — ROOT CAUSE CLASSIFICATION
  // ────────────────────────────────────────────────────────────────────────────
  console.log('━'.repeat(80));
  console.log('  TASK 3 — ROOT CAUSE CLASSIFICATION');
  console.log('━'.repeat(80) + '\n');

  const causeCounts   = { A:0, B:0, C:0, D:0, E:0, F:0 };
  const causeImpact   = { A:0, B:0, C:0, D:0, E:0, F:0 };

  for (const r of R) {
    const cause = classifyRootCause(r.inv, r);
    causeCounts[cause]++;
    causeImpact[cause] = r2(causeImpact[cause] + Math.abs(r.dTotal));
  }

  console.log(`  ${'Cause'.padEnd(56)} ${'Count'.padStart(6)} ${'%'.padStart(6)} ${'|ΔTotal|'.padStart(12)}`);
  console.log(`  ${'─'.repeat(84)}`);
  for (const c of ['A','B','C','D','E','F']) {
    console.log(
      `  ${CAUSE_LABELS[c].padEnd(56)} ` +
      `${String(causeCounts[c]).padStart(6)} ` +
      `${fp(causeCounts[c], N).padStart(6)} ` +
      `${f(causeImpact[c]).padStart(12)}`
    );
  }
  console.log('');

  // Hybrid would fix Category A invoices
  const catA = R.filter(r => classifyRootCause(r.inv, r) === 'A');
  const hybridFixable = catA.filter(r => Math.abs(r.hybTax - r.exTax) < 0.005).length;
  console.log(`  Category A invoices fixable by Hybrid Architecture: ${hybridFixable} / ${catA.length}\n`);

  // ────────────────────────────────────────────────────────────────────────────
  // TASK 5 — SUPPLIER VS DERIVED (two-truth audit)
  // ────────────────────────────────────────────────────────────────────────────
  console.log('━'.repeat(80));
  console.log('  TASK 5 — SUPPLIER VS DERIVED VALUES (two-truth audit)');
  console.log('━'.repeat(80) + '\n');

  const mismatchCgst  = R.filter(r => Math.abs(r.dCgst)  > 0.005);
  const mismatchSgst  = R.filter(r => Math.abs(r.dSgst)  > 0.005);
  const mismatchIgst  = R.filter(r => Math.abs(r.dIgst)  > 0.005);
  const mismatchTotal = R.filter(r => Math.abs(r.dTotal) > 0.005);
  const mismatchTax   = R.filter(r => Math.abs(r.dTax)   > 0.005);

  const maxOf = (arr, field) => arr.length === 0 ? 0 : Math.max(...arr.map(r => Math.abs(r[field])));
  const sumOf = (arr, field) => r2(arr.reduce((s, r) => s + Math.abs(r[field]), 0));

  const rows2 = [
    ['Taxable (subtotal vs sys)',  mismatchTax,   'dTax'],
    ['CGST',                       mismatchCgst,  'dCgst'],
    ['SGST',                       mismatchSgst,  'dSgst'],
    ['IGST',                       mismatchIgst,  'dIgst'],
    ['Total',                      mismatchTotal, 'dTotal'],
  ];

  console.log(`  ${'Field'.padEnd(26)} ${'Mismatches'.padStart(11)} ${'Largest |Δ|'.padStart(13)} ${'Sum |Δ|'.padStart(13)}`);
  console.log(`  ${'─'.repeat(66)}`);
  for (const [lbl, arr, fld] of rows2) {
    console.log(
      `  ${lbl.padEnd(26)} ${String(arr.length).padStart(11)} ` +
      `${f(maxOf(arr, fld)).padStart(13)} ` +
      `${f(sumOf(arr, fld)).padStart(13)}`
    );
  }
  console.log('');
  console.log(`  The system currently stores ${mismatchTotal.length} invoices where`);
  console.log(`  supplier_total ≠ derived total. These are invoices with two conflicting truths.\n`);

  // ────────────────────────────────────────────────────────────────────────────
  // TASK 6 — GST ROUNDING METHOD COMPARISON
  // ────────────────────────────────────────────────────────────────────────────
  console.log('━'.repeat(80));
  console.log('  TASK 6 — GST ROUNDING METHOD COMPARISON');
  console.log('            (OldDirect vs TwoStep vs SignConsistentDirect)');
  console.log('━'.repeat(80) + '\n');

  // For each invoice, compute what each method would produce given the system taxable
  // and compare against supplier (Excel) GST values.
  // We need gst_percent. Derive from line_items where possible.
  // If multiple rates, compute per HSN group using calcLineAmount.

  let betterDirect = 0, worseDirect = 0, sameDirect = 0;
  let betterSc = 0, worseSc = 0, sameSc = 0;
  let cgstNeqSgst = 0; // CGST ≠ SGST despite equal rates (sign-consistent artifact)

  const gstCompDetail = []; // invoices where methods differ

  for (const r of R) {
    if (!r.hasSupplier) continue;
    const lineItems = r.inv.line_items ?? [];
    const taxType   = r.taxType;

    // Build HSN groups from line items
    const hsnMap = {};
    for (const item of lineItems) {
      const key = String(item.hsn ?? '') + '_' + String(item.gst_percent ?? 0);
      if (!hsnMap[key]) hsnMap[key] = { gstPct: item.gst_percent ?? 0, taxable: 0 };
      hsnMap[key].taxable = r2(hsnMap[key].taxable + calcLineAmount(item));
    }

    let cgstDirect = 0, sgstDirect = 0, igstDirect = 0;
    let cgstTwo    = 0, sgstTwo    = 0, igstTwo    = 0;
    let cgstSc     = 0, sgstSc     = 0, igstSc     = 0;

    for (const grp of Object.values(hsnMap)) {
      const d  = gstOldDirect(grp.taxable, grp.gstPct, taxType);
      const t  = gstTwoStep(grp.taxable, grp.gstPct, taxType);
      const sc = gstSignConsistentDirect(grp.taxable, grp.gstPct, taxType);
      cgstDirect += d.cgst;  sgstDirect += d.sgst;  igstDirect += d.igst;
      cgstTwo    += t.cgst;  sgstTwo    += t.sgst;  igstTwo    += t.igst;
      cgstSc     += sc.cgst; sgstSc     += sc.sgst; igstSc     += sc.igst;
    }
    cgstDirect = r2(cgstDirect); sgstDirect = r2(sgstDirect); igstDirect = r2(igstDirect);
    cgstTwo    = r2(cgstTwo);    sgstTwo    = r2(sgstTwo);    igstTwo    = r2(igstTwo);
    cgstSc     = r2(cgstSc);    sgstSc     = r2(sgstSc);    igstSc     = r2(igstSc);

    // Error of each method vs Excel supplier values
    const errDirect = Math.abs(cgstDirect - r.exCgst) + Math.abs(sgstDirect - r.exSgst) + Math.abs(igstDirect - r.exIgst);
    const errTwo    = Math.abs(cgstTwo    - r.exCgst) + Math.abs(sgstTwo    - r.exSgst) + Math.abs(igstTwo    - r.exIgst);
    const errSc     = Math.abs(cgstSc     - r.exCgst) + Math.abs(sgstSc     - r.exSgst) + Math.abs(igstSc     - r.exIgst);

    // Direct vs TwoStep
    if      (errDirect < errTwo - 0.001) betterDirect++;
    else if (errDirect > errTwo + 0.001) worseDirect++;
    else                                 sameDirect++;

    // SignConsistent vs TwoStep (what we briefly tried and reverted)
    if      (errSc < errTwo - 0.001) betterSc++;
    else if (errSc > errTwo + 0.001) worseSc++;
    else                             sameSc++;

    // CGST ≠ SGST despite equal rates (sign-consistent can produce different magnitudes for negatives)
    if (taxType === 'cgst_sgst' && Math.abs(Math.abs(cgstSc) - Math.abs(sgstSc)) > 0.005) {
      cgstNeqSgst++;
    }

    // Collect invoices where method matters
    if (errDirect > 0.001 || errSc > 0.001) {
      gstCompDetail.push({
        no: r.no, taxType,
        exCgst: r.exCgst, exSgst: r.exSgst, exIgst: r.exIgst,
        directErr: r2(errDirect), twoErr: r2(errTwo), scErr: r2(errSc),
        cgstDirect, cgstTwo, cgstSc,
        cgstNeqSgst_sc: taxType === 'cgst_sgst' && Math.abs(Math.abs(cgstSc) - Math.abs(sgstSc)) > 0.005,
      });
    }
  }

  const comparable = R.filter(r => r.hasSupplier).length;
  console.log(`  Comparing GST methods against Excel supplier values (N=${comparable})\n`);
  console.log(`  OldDirect vs TwoStep (baseline):`);
  console.log(`    OldDirect is BETTER  : ${betterDirect} invoices`);
  console.log(`    OldDirect is SAME    : ${sameDirect} invoices`);
  console.log(`    OldDirect is WORSE   : ${worseDirect} invoices`);
  console.log('');
  console.log(`  SignConsistentDirect vs TwoStep (what was briefly tried, then reverted):`);
  console.log(`    SignConsistent is BETTER : ${betterSc} invoices`);
  console.log(`    SignConsistent is SAME   : ${sameSc} invoices`);
  console.log(`    SignConsistent is WORSE  : ${worseSc} invoices`);
  console.log('');
  console.log(`  Invoices where CGST magnitude ≠ SGST magnitude (SignConsistent artifact): ${cgstNeqSgst}`);
  console.log('');

  // GST drift count with current system
  const gstDriftCount = R.filter(r => Math.abs(r.dCgst) > 0.01 || Math.abs(r.dSgst) > 0.01 || Math.abs(r.dIgst) > 0.01).length;
  console.log(`  Invoices with current GST drift > ₹0.01: ${gstDriftCount} of ${N}\n`);

  if (gstCompDetail.length > 0) {
    const worst = gstCompDetail.sort((a, b) => b.directErr - a.directErr).slice(0, 20);
    console.log(`  Top 20 invoices where GST method matters:\n`);
    console.log(`  ${'Invoice'.padEnd(16)} ${'Type'.padEnd(10)} ${'exCGST'.padStart(8)} ${'Direct'.padStart(8)} ${'TwoStep'.padStart(8)} ${'SignCon'.padStart(8)} ${'DirectErr'.padStart(10)}`);
    console.log(`  ${'─'.repeat(72)}`);
    for (const d of worst) {
      console.log(
        `  ${d.no.padEnd(16)} ${d.taxType.padEnd(10)} ` +
        `${d.exCgst.toFixed(2).padStart(8)} ${d.cgstDirect.toFixed(2).padStart(8)} ` +
        `${d.cgstTwo.toFixed(2).padStart(8)} ${d.cgstSc.toFixed(2).padStart(8)} ` +
        `${d.directErr.toFixed(2).padStart(10)}` +
        (d.cgstNeqSgst_sc ? ' ⚠CGST≠SGST' : '')
      );
    }
    console.log('');
  }

  // ────────────────────────────────────────────────────────────────────────────
  // TASK 7 — CGST ≠ SGST (equal-rate invoices)
  // ────────────────────────────────────────────────────────────────────────────
  console.log('━'.repeat(80));
  console.log('  TASK 7 — CGST ≠ SGST MISMATCH (current stored values)');
  console.log('━'.repeat(80) + '\n');

  const cgstNeqSgstStored = R.filter(r =>
    r.taxType === 'cgst_sgst' &&
    Math.abs(Math.abs(r.sysCgst) - Math.abs(r.sysSgst)) > 0.005
  );
  console.log(`  CGST_SGST invoices where |stored CGST| ≠ |stored SGST|: ${cgstNeqSgstStored.length}`);
  if (cgstNeqSgstStored.length > 0) {
    console.log('');
    console.log(`  ${'Invoice'.padEnd(16)} ${'sysCGST'.padStart(10)} ${'sysSGST'.padStart(10)} ${'|Δ|'.padStart(8)}`);
    console.log(`  ${'─'.repeat(48)}`);
    for (const r of cgstNeqSgstStored.slice(0, 30)) {
      console.log(
        `  ${r.no.padEnd(16)} ` +
        `${r.sysCgst.toFixed(2).padStart(10)} ${r.sysSgst.toFixed(2).padStart(10)} ` +
        `${Math.abs(Math.abs(r.sysCgst) - Math.abs(r.sysSgst)).toFixed(2).padStart(8)}`
      );
    }
    if (cgstNeqSgstStored.length > 30) console.log(`  ... and ${cgstNeqSgstStored.length - 30} more`);
    console.log('');
  }

  // ────────────────────────────────────────────────────────────────────────────
  // KKE002397 specific validation
  // ────────────────────────────────────────────────────────────────────────────
  const kke = results.find(r => r.no === 'KKE002397');
  if (kke) {
    console.log('━'.repeat(80));
    console.log('  KKE002397 SPECIFIC VALIDATION');
    console.log('━'.repeat(80) + '\n');
    console.log(`  Excel    taxable=${kke.exTax.toFixed(2)}  CGST=${kke.exCgst.toFixed(2)}  SGST=${kke.exSgst.toFixed(2)}  IGST=${kke.exIgst.toFixed(2)}  total=${kke.exTotal.toFixed(2)}`);
    console.log(`  System   taxable=${kke.sysTax.toFixed(2)}  CGST=${kke.sysCgst.toFixed(2)}  SGST=${kke.sysSgst.toFixed(2)}  IGST=${kke.sysIgst.toFixed(2)}  total=${kke.sysTotal.toFixed(2)}`);
    console.log(`  Delta    taxable=${fpm(kke.dTax)}  CGST=${fpm(kke.dCgst)}  SGST=${fpm(kke.dSgst)}  IGST=${fpm(kke.dIgst)}  total=${fpm(kke.dTotal)}`);
    console.log(`  Hybrid   taxable=${kke.hybTax.toFixed(2)}  fixes drift: ${Math.abs(kke.hybTax - kke.exTax) < 0.005 ? 'YES' : 'NO'}`);

    const lineItems = kke.inv.line_items ?? [];
    console.log(`\n  Line items (${lineItems.length}):`);
    for (const item of lineItems) {
      const calc = calcLineAmount(item);
      const diff = item.amount != null ? r2(item.amount - calc) : null;
      console.log(
        `    qty=${item.qty}  rate=${item.rate}  amount=${item.amount ?? 'null'}  ` +
        `calcLineAmount=${calc}  ` +
        (diff !== null ? `diff=${diff >= 0 ? '+' : ''}${diff.toFixed(2)}` : 'no stored amount')
      );
    }
    console.log('');
  }

  // ────────────────────────────────────────────────────────────────────────────
  // LINE ITEM INTERNAL CONSISTENCY
  // ────────────────────────────────────────────────────────────────────────────
  let totalItems = 0, divergedItems = 0;
  const divergedInvoices = new Set();
  for (const r of results) {
    for (const item of (r.inv.line_items ?? [])) {
      totalItems++;
      const amt = item.amount ?? null;
      const calc = calcLineAmount(item);
      if (amt !== null && Math.abs(amt - calc) > 0.005) {
        divergedItems++;
        divergedInvoices.add(r.no);
      }
    }
  }

  console.log('━'.repeat(80));
  console.log('  LINE ITEM INTERNAL CONSISTENCY');
  console.log('━'.repeat(80) + '\n');
  console.log(`  Total line items scanned                : ${totalItems}`);
  console.log(`  Items where stored amount ≠ qty×rate   : ${divergedItems}`);
  console.log(`  Invoices affected                       : ${divergedInvoices.size}`);
  console.log(`  (Source-preservation fixes these ${divergedInvoices.size} invoices)\n`);

  return {
    results: R, rawResults: results,
    total: N,
    driftedCount: drifted.length,
    catACounts: causeCounts.A,
    cgstNeqSgstStoredCount: cgstNeqSgstStored.length,
    gstDriftCount,
    mismatchTotalCount: mismatchTotal.length,
    divergedInvoiceCount: divergedInvoices.size,
  };
}

// ── Entry point ────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n' + '═'.repeat(80));
  console.log('  TALLYAI COMPREHENSIVE FINANCIAL RECONCILIATION AUDIT');
  console.log(`  Run at: ${new Date().toISOString()}`);
  console.log('  Tasks: 1 (buckets) | 2 (top 100) | 3 (root cause) | 4 (purchase) |');
  console.log('         5 (supplier vs derived) | 6 (GST method) | 7 (CGST≠SGST)');
  console.log('═'.repeat(80));

  let salesResult = null, purchaseResult = null;

  try {
    salesResult = await auditTable('sales_invoices', 'Sales Register');
  } catch (e) {
    console.error('\n[ERROR] Sales audit failed:', e.message);
  }

  try {
    purchaseResult = await auditTable('invoices', 'Purchase Register');
  } catch (e) {
    console.error('\n[ERROR] Purchase audit failed:', e.message);
  }

  // ── TASK 4 — PURCHASE IMPACT SUMMARY ────────────────────────────────────────
  console.log('\n' + '═'.repeat(80));
  console.log('  TASK 4 — PURCHASE DRIFT VERDICT');
  console.log('═'.repeat(80) + '\n');

  if (purchaseResult) {
    const affected = purchaseResult.driftedCount > 0;
    console.log(`  Purchase affected: ${affected ? 'YES' : 'NO'}`);
    if (affected) {
      const P = purchaseResult.results;
      const dP = P.filter(r => r.maxAbsDiff > 0);
      const largestTotal = Math.max(...dP.map(r => Math.abs(r.dTotal)));
      const sumTotal = r2(dP.reduce((s, r) => s + Math.abs(r.dTotal), 0));
      console.log(`  Invoices with drift : ${dP.length} of ${purchaseResult.total}`);
      console.log(`  Largest |ΔTotal|    : ₹${largestTotal.toFixed(2)}`);
      console.log(`  Sum |ΔTotal|        : ₹${sumTotal.toFixed(2)}`);
    }
  } else {
    console.log('  Purchase audit did not complete.');
  }

  // ── COMBINED SUMMARY ─────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(80));
  console.log('  COMBINED SUMMARY');
  console.log('═'.repeat(80) + '\n');

  if (salesResult) {
    console.log(`  Sales:`);
    console.log(`    Comparable invoices              : ${salesResult.total}`);
    console.log(`    Invoices with any drift          : ${salesResult.driftedCount} (${((salesResult.driftedCount/salesResult.total)*100).toFixed(1)}%)`);
    console.log(`    Category A (rate precision)      : ${salesResult.catACounts}`);
    console.log(`    Two-truth mismatches (total)     : ${salesResult.mismatchTotalCount}`);
    console.log(`    Line items with amount≠qty×rate  : ${salesResult.divergedInvoiceCount} invoices`);
    console.log(`    Current GST drift > ₹0.01        : ${salesResult.gstDriftCount}`);
    console.log(`    Stored CGST≠SGST (equal rates)   : ${salesResult.cgstNeqSgstStoredCount}`);
  }
  if (purchaseResult) {
    console.log(`\n  Purchase:`);
    console.log(`    Comparable invoices              : ${purchaseResult.total}`);
    console.log(`    Invoices with any drift          : ${purchaseResult.driftedCount} (${((purchaseResult.driftedCount/purchaseResult.total)*100).toFixed(1)}%)`);
    console.log(`    Category A (rate precision)      : ${purchaseResult.catACounts}`);
    console.log(`    Two-truth mismatches (total)     : ${purchaseResult.mismatchTotalCount}`);
    console.log(`    Line items with amount≠qty×rate  : ${purchaseResult.divergedInvoiceCount} invoices`);
    console.log(`    Current GST drift > ₹0.01        : ${purchaseResult.gstDriftCount}`);
    console.log(`    Stored CGST≠SGST (equal rates)   : ${purchaseResult.cgstNeqSgstStoredCount}`);
  }

  console.log('\nAudit complete.\n');
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
