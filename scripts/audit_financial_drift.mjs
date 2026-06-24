/**
 * Financial Reconciliation Audit — TallyAI
 * =========================================
 * Compares original source values (supplier_* columns) against
 * system-derived values (cgst/sgst/igst/total columns) for every invoice.
 *
 * Also computes "system taxable" = sum of calcLineAmount(item) per stored
 * line_item, which is what every screen (Register, Export, XML) shows.
 *
 * Run from the repo root on any machine with Supabase access:
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

// ── Helpers ────────────────────────────────────────────────────────────────────

// Matches invoice.ts r2 (OldDirect — current production after our last fix)
const r2 = (n) => Math.round(n * 100) / 100;

// Replicates calcLineAmount(item) from invoice.ts exactly
function calcLineAmount(item) {
  return r2((item.qty ?? 0) * (item.rate ?? 0) * (1 - (item.disc_percent ?? 0) / 100));
}

// System taxable as shown on every screen: sum of calcLineAmount per line item
function sysTaxableFromLineItems(lineItems) {
  if (!Array.isArray(lineItems) || lineItems.length === 0) return 0;
  return r2(lineItems.reduce((s, item) => s + calcLineAmount(item), 0));
}

// "Source-preserved" taxable: use item.amount if set (as assembleInvoices intended)
function sourceTaxableFromLineItems(lineItems) {
  if (!Array.isArray(lineItems) || lineItems.length === 0) return 0;
  return r2(lineItems.reduce((s, item) => {
    // item.amount is what assembleInvoices stored from Excel taxable_amount
    // normalizeLineItem overwrites it with qty×rate — but the original came from Excel
    // For this analysis we use stored item.amount (post-normalizeLineItem)
    // to check if even the stored amount matches subtotal
    return s + (item.amount ?? calcLineAmount(item));
  }, 0));
}

function classify(abs) {
  if (abs === 0)       return 'exact';
  if (abs <= 0.01)     return 'minor';
  if (abs <= 0.10)     return 'moderate';
  if (abs <= 0.50)     return 'material';
  return 'severe';
}

const CATS = ['exact', 'minor', 'moderate', 'material', 'severe'];

function formatINR(n) {
  const s = Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (n < 0 ? '-' : '') + s;
}
const f = (n) => formatINR(n).padStart(16);
const fsign = (n) => ((n > 0 ? '+' : '') + formatINR(n)).padStart(12);

// ── Fetch with pagination ──────────────────────────────────────────────────────

async function fetchAll(table) {
  const select = [
    'invoice_number', 'source',
    'subtotal', 'cgst', 'sgst', 'igst', 'total', 'round_off',
    'supplier_cgst', 'supplier_sgst', 'supplier_igst', 'supplier_total', 'supplier_roundoff',
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

// ── Classification tables ──────────────────────────────────────────────────────

function printClassTable(label, counts, total) {
  const pct = (n) => ((n / total) * 100).toFixed(1).padStart(5);
  console.log(`  ${label}`);
  console.log(`  ${'─'.repeat(52)}`);
  console.log(`  Exact match   (Δ = 0.00)          : ${String(counts.exact).padStart(5)} (${pct(counts.exact)}%)`);
  console.log(`  Minor         (0.00 < Δ ≤ 0.01)   : ${String(counts.minor).padStart(5)} (${pct(counts.minor)}%)`);
  console.log(`  Moderate      (0.01 < Δ ≤ 0.10)   : ${String(counts.moderate).padStart(5)} (${pct(counts.moderate)}%)`);
  console.log(`  Material      (0.10 < Δ ≤ 0.50)   : ${String(counts.material).padStart(5)} (${pct(counts.material)}%)`);
  console.log(`  Severe        (Δ > 0.50)           : ${String(counts.severe).padStart(5)} (${pct(counts.severe)}%)`);
  console.log(`  TOTAL                              : ${String(total).padStart(5)}`);
  console.log('');
}

// ── Main audit function ────────────────────────────────────────────────────────

async function auditTable(table, label) {
  const BAR = '═'.repeat(74);
  console.log(`\n${BAR}`);
  console.log(`  AUDIT: ${label.toUpperCase()}`);
  console.log(`  Table: ${table}`);
  console.log(`${BAR}\n`);

  const rows = await fetchAll(table);
  console.log(`  Rows fetched: ${rows.length}\n`);

  if (rows.length === 0) {
    console.log('  (empty — skipping)\n');
    return;
  }

  // Per-invoice calculations
  const results = rows.map((inv) => {
    const exTax   = Number(inv.subtotal ?? 0);       // Excel taxable (stored from assembleInvoices)
    const exCgst  = Number(inv.supplier_cgst ?? 0);  // Excel CGST
    const exSgst  = Number(inv.supplier_sgst ?? 0);  // Excel SGST
    const exIgst  = Number(inv.supplier_igst ?? 0);  // Excel IGST
    const exTotal = Number(inv.supplier_total ?? 0); // Excel total
    const exRo    = Number(inv.supplier_roundoff ?? 0);

    const sysCgst  = Number(inv.cgst ?? 0);   // Derived CGST (stored at insert)
    const sysSgst  = Number(inv.sgst ?? 0);   // Derived SGST
    const sysIgst  = Number(inv.igst ?? 0);   // Derived IGST
    const sysTotal = Number(inv.total ?? 0);  // Derived total

    // System taxable = what Register/Export/XML shows (calcLineAmount per item)
    const sysTax = sysTaxableFromLineItems(inv.line_items);

    // item.amount-based taxable = what would show if we trusted item.amount
    const amtTax = sourceTaxableFromLineItems(inv.line_items);

    const dTax   = r2(sysTax  - exTax);
    const dCgst  = r2(sysCgst - exCgst);
    const dSgst  = r2(sysSgst - exSgst);
    const dIgst  = r2(sysIgst - exIgst);
    const dTotal = r2(sysTotal - exTotal);

    // Missing supplier_* data (rows accepted before migration 034)
    const hasSupplier = inv.supplier_cgst != null || inv.supplier_total != null;

    return {
      no: inv.invoice_number, src: inv.source ?? '',
      exTax, exCgst, exSgst, exIgst, exTotal, exRo,
      sysTax, sysCgst, sysSgst, sysIgst, sysTotal,
      amtTax,
      dTax, dCgst, dSgst, dIgst, dTotal,
      maxDiff: Math.max(Math.abs(dTax), Math.abs(dTotal)),
      hasSupplier,
    };
  });

  const withSupplier = results.filter(r => r.hasSupplier);
  const noSupplier   = results.filter(r => !r.hasSupplier);
  console.log(`  Invoices with supplier_* data (comparable): ${withSupplier.length}`);
  console.log(`  Invoices without supplier_* data (pre-migration 034): ${noSupplier.length}\n`);

  // Only audit comparable rows (those with supplier_* populated)
  const R = withSupplier.length > 0 ? withSupplier : results;

  // Classification tables for each field
  const classTax   = { exact:0, minor:0, moderate:0, material:0, severe:0 };
  const classCgst  = { exact:0, minor:0, moderate:0, material:0, severe:0 };
  const classSgst  = { exact:0, minor:0, moderate:0, material:0, severe:0 };
  const classTotal = { exact:0, minor:0, moderate:0, material:0, severe:0 };

  for (const r of R) {
    classTax[classify(Math.abs(r.dTax))]++;
    classCgst[classify(Math.abs(r.dCgst))]++;
    classSgst[classify(Math.abs(r.dSgst))]++;
    classTotal[classify(Math.abs(r.dTotal))]++;
  }

  console.log('CLASSIFICATION BY FIELD (source Excel vs system derived)\n');
  printClassTable('TAXABLE DIFFERENCE',     classTax,   R.length);
  printClassTable('CGST DIFFERENCE',        classCgst,  R.length);
  printClassTable('SGST DIFFERENCE',        classSgst,  R.length);
  printClassTable('INVOICE TOTAL DIFFERENCE', classTotal, R.length);

  // ── Aggregate ────────────────────────────────────────────────────────────────
  const sum = (field) => r2(R.reduce((s, r) => s + r[field], 0));
  const exTaxTotal   = sum('exTax');
  const exCgstTotal  = sum('exCgst');
  const exSgstTotal  = sum('exSgst');
  const exIgstTotal  = sum('exIgst');
  const exGrandTotal = sum('exTotal');
  const sysTaxTotal  = sum('sysTax');
  const sysCgstTotal = sum('sysCgst');
  const sysSgstTotal = sum('sysSgst');
  const sysIgstTotal = sum('sysIgst');
  const sysGrandTotal = sum('sysTotal');

  console.log('AGGREGATE IMPACT\n');
  console.log(`  ${'Field'.padEnd(10)} │${'Excel Source'.padStart(18)} │${'System Derived'.padStart(18)} │${'Difference'.padStart(14)}`);
  console.log(`  ${'─'.repeat(10)}─┼${'─'.repeat(18)}─┼${'─'.repeat(18)}─┼${'─'.repeat(14)}`);
  const row = (lbl, ex, sys) =>
    `  ${lbl.padEnd(10)} │${f(ex)} │${f(sys)} │${fsign(r2(sys-ex))}`;
  console.log(row('Taxable',  exTaxTotal,   sysTaxTotal));
  console.log(row('CGST',     exCgstTotal,  sysCgstTotal));
  console.log(row('SGST',     exSgstTotal,  sysSgstTotal));
  console.log(row('IGST',     exIgstTotal,  sysIgstTotal));
  console.log(row('Total',    exGrandTotal, sysGrandTotal));
  console.log('');

  // ── By source breakdown ───────────────────────────────────────────────────────
  const sources = [...new Set(R.map(r => r.src))].filter(Boolean);
  if (sources.length > 1) {
    console.log('BY SOURCE\n');
    for (const src of sources) {
      const sg = R.filter(r => r.src === src);
      const nd = sg.filter(r => r.maxDiff > 0).length;
      console.log(`  ${src.padEnd(22)}: ${sg.length} invoices, ${nd} drifted (${((nd/sg.length)*100).toFixed(1)}%)`);
    }
    console.log('');
  }

  // ── Top 50 worst ─────────────────────────────────────────────────────────────
  const drifted = R.filter(r => r.maxDiff > 0).sort((a, b) => b.maxDiff - a.maxDiff);
  const top50 = drifted.slice(0, 50);

  if (top50.length === 0) {
    console.log('TOP VARIANCES: All comparable invoices are exact matches.\n');
  } else {
    console.log(`TOP ${top50.length} VARIANCE INVOICES (of ${drifted.length} drifted, sorted ↓ by |Δ|)\n`);
    const H = '─'.repeat(110);
    console.log(`  Invoice        Src    ExTaxable    SysTaxable   ΔTax     ExCGST   SysCGST  ΔCGST   ExTotal   SysTotal   ΔTotal`);
    console.log(`  ${H}`);
    for (const r of top50) {
      const s = (n, w) => n.toFixed(2).padStart(w);
      const ds = (n) => ((n >= 0 ? '+' : '') + n.toFixed(2)).padStart(7);
      console.log(
        `  ${r.no.padEnd(14)} ${(r.src||'').slice(0,6).padEnd(6)} ` +
        `${s(r.exTax,11)} ${s(r.sysTax,11)} ${ds(r.dTax)}  ` +
        `${s(r.exCgst,8)} ${s(r.sysCgst,8)} ${ds(r.dCgst)}  ` +
        `${s(r.exTotal,9)} ${s(r.sysTotal,9)} ${ds(r.dTotal)}`
      );
    }
    console.log('');
  }

  // ── KKE002397 specific validation ────────────────────────────────────────────
  const kke = results.find(r => r.no === 'KKE002397');
  if (kke) {
    console.log('KKE002397 SPECIFIC VALIDATION\n');
    console.log(`  Excel   taxable=${kke.exTax.toFixed(2)}  CGST=${kke.exCgst.toFixed(2)}  SGST=${kke.exSgst.toFixed(2)}  total=${kke.exTotal.toFixed(2)}`);
    console.log(`  System  taxable=${kke.sysTax.toFixed(2)}  CGST=${kke.sysCgst.toFixed(2)}  SGST=${kke.sysSgst.toFixed(2)}  total=${kke.sysTotal.toFixed(2)}`);
    console.log(`  Delta   taxable=${kke.dTax >= 0 ? '+' : ''}${kke.dTax.toFixed(2)}  CGST=${kke.dCgst >= 0 ? '+' : ''}${kke.dCgst.toFixed(2)}  SGST=${kke.dSgst >= 0 ? '+' : ''}${kke.dSgst.toFixed(2)}  total=${kke.dTotal >= 0 ? '+' : ''}${kke.dTotal.toFixed(2)}`);
    console.log('');
    // Source-preservation check: if item.amount is still 3809.52, amtTax should equal exTax
    const amtMatch = Math.abs(kke.amtTax - kke.exTax) < 0.005;
    console.log(`  item.amount-based taxable : ${kke.amtTax.toFixed(2)} (${amtMatch ? '✓ matches Excel' : '✗ differs from Excel'})`);
    console.log(`  qty×rate-based taxable    : ${kke.sysTax.toFixed(2)}`);
    console.log(`  → Source-preservation fix would eliminate variance: ${amtMatch ? 'YES' : 'NO'}\n`);
  } else {
    console.log('KKE002397 not found in this table.\n');
  }

  // ── item.amount vs qty×rate divergence ────────────────────────────────────────
  // How many line items have item.amount ≠ calcLineAmount(item)?
  let totalItems = 0, divergedItems = 0;
  for (const inv of rows) {
    for (const item of (inv.line_items ?? [])) {
      totalItems++;
      const amt = item.amount ?? null;
      const calc = calcLineAmount(item);
      if (amt !== null && Math.abs(amt - calc) > 0.005) divergedItems++;
    }
  }
  console.log(`LINE ITEM INTERNAL CONSISTENCY\n`);
  console.log(`  Total line items scanned           : ${totalItems}`);
  console.log(`  Items where item.amount ≠ qty×rate : ${divergedItems}`);
  console.log(`  (These are items where source-preservation would change the taxable)\n`);

  return { results: R, driftedCount: drifted.length, total: R.length };
}

// ── Entry point ────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n' + '═'.repeat(74));
  console.log('  TALLYAI FINANCIAL RECONCILIATION AUDIT');
  console.log(`  Run at: ${new Date().toISOString()}`);
  console.log('═'.repeat(74));

  let salesResult, purchaseResult;

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

  // ── Summary ──────────────────────────────────────────────────────────────────
  console.log('═'.repeat(74));
  console.log('  COMBINED SUMMARY');
  console.log('═'.repeat(74));
  if (salesResult) {
    console.log(`\n  Sales invoices    : ${salesResult.total} comparable, ${salesResult.driftedCount} drifted (${((salesResult.driftedCount/salesResult.total)*100).toFixed(1)}%)`);
  }
  if (purchaseResult) {
    console.log(`  Purchase invoices : ${purchaseResult.total} comparable, ${purchaseResult.driftedCount} drifted (${((purchaseResult.driftedCount/purchaseResult.total)*100).toFixed(1)}%)`);
  }
  console.log('\nAudit complete.\n');
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
