/**
 * Financial Reconciliation Audit Script
 * ======================================
 * Run from any machine with Supabase access:
 *   node scripts/audit_financial_drift.mjs
 *
 * Compares:
 *   supplier_* columns  = original Excel / PDF-extracted values
 *   cgst/sgst/igst/total = system-derived values (from deriveInvoiceFinancials)
 *
 * For taxable: subtotal (Excel) vs sum of line_items[].amount (normalized)
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const settings = JSON.parse(readFileSync(join(__dir, '../.claude/settings.local.json'), 'utf8'));
const SUPABASE_URL = settings.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = settings.env.SUPABASE_SERVICE_ROLE_KEY;

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

const r2 = (n) => Math.round(n * 100) / 100;

function sumLineItemAmounts(lineItems) {
  if (!Array.isArray(lineItems)) return 0;
  return r2(lineItems.reduce((s, item) => {
    // This is exactly what calcLineAmount does
    const qty = item.qty ?? 0;
    const rate = item.rate ?? 0;
    const disc = item.disc_percent ?? 0;
    return s + r2(qty * rate * (1 - disc / 100));
  }, 0));
}

async function fetchAll(table, select, filter = {}) {
  let allRows = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    let q = sb.from(table).select(select).range(from, from + pageSize - 1);
    for (const [col, val] of Object.entries(filter)) q = q.eq(col, val);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    if (!data || data.length === 0) break;
    allRows = allRows.concat(data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return allRows;
}

function classify(diff) {
  const abs = Math.abs(diff);
  if (abs === 0)      return 'exact';
  if (abs <= 0.01)    return 'minor';
  if (abs <= 0.10)    return 'moderate';
  if (abs <= 0.50)    return 'material';
  return 'severe';
}

function formatINR(n) {
  return n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function auditTable(table, label) {
  console.log(`\n${'='.repeat(72)}`);
  console.log(`AUDIT: ${label}`);
  console.log(`${'='.repeat(72)}\n`);

  const rows = await fetchAll(
    table,
    'invoice_number, subtotal, cgst, sgst, igst, total, round_off, supplier_cgst, supplier_sgst, supplier_igst, supplier_total, supplier_roundoff, line_items, source',
  );

  console.log(`Total rows fetched: ${rows.length}\n`);

  const results = [];
  const categories = { exact: [], minor: [], moderate: [], material: [], severe: [] };

  for (const inv of rows) {
    const excelTaxable  = Number(inv.subtotal ?? 0);
    const excelCgst     = Number(inv.supplier_cgst ?? 0);
    const excelSgst     = Number(inv.supplier_sgst ?? 0);
    const excelIgst     = Number(inv.supplier_igst ?? 0);
    const excelTotal    = Number(inv.supplier_total ?? 0);
    const excelRoundOff = Number(inv.supplier_roundoff ?? 0);

    const sysCgst   = Number(inv.cgst ?? 0);
    const sysSgst   = Number(inv.sgst ?? 0);
    const sysIgst   = Number(inv.igst ?? 0);
    const sysTotal  = Number(inv.total ?? 0);

    // Taxable as shown in register: sum of calcLineAmount(item) from stored (normalized) line_items
    const sysTaxable = sumLineItemAmounts(inv.line_items);

    const dTaxable  = r2(sysTaxable - excelTaxable);
    const dCgst     = r2(sysCgst   - excelCgst);
    const dSgst     = r2(sysSgst   - excelSgst);
    const dIgst     = r2(sysIgst   - excelIgst);
    const dTotal    = r2(sysTotal  - excelTotal);
    const maxDiff   = Math.max(Math.abs(dTaxable), Math.abs(dTotal));

    const cat = classify(maxDiff);
    const row = {
      invoice_number: inv.invoice_number,
      source: inv.source,
      excelTaxable, excelCgst, excelSgst, excelIgst, excelTotal, excelRoundOff,
      sysTaxable, sysCgst, sysSgst, sysIgst, sysTotal,
      dTaxable, dCgst, dSgst, dIgst, dTotal, maxDiff, cat,
    };
    results.push(row);
    categories[cat].push(row);
  }

  // ── Summary counts ────────────────────────────────────────────────────────
  console.log('CLASSIFICATION SUMMARY');
  console.log('─'.repeat(50));
  console.log(`  Exact match   (Δ = 0.00)                 : ${categories.exact.length}`);
  console.log(`  Minor diff    (0.00 < Δ ≤ 0.01)          : ${categories.minor.length}`);
  console.log(`  Moderate diff (0.01 < Δ ≤ 0.10)          : ${categories.moderate.length}`);
  console.log(`  Material diff (0.10 < Δ ≤ 0.50)          : ${categories.material.length}`);
  console.log(`  Severe diff   (Δ > 0.50)                  : ${categories.severe.length}`);
  console.log(`  Total                                      : ${results.length}\n`);

  // ── Aggregate totals ──────────────────────────────────────────────────────
  const sum = (arr, field) => r2(arr.reduce((s, r) => s + r[field], 0));

  const excelTaxableTotal = sum(results, 'excelTaxable');
  const excelCgstTotal    = sum(results, 'excelCgst');
  const excelSgstTotal    = sum(results, 'excelSgst');
  const excelIgstTotal    = sum(results, 'excelIgst');
  const excelGrandTotal   = sum(results, 'excelTotal');

  const sysTaxableTotal   = sum(results, 'sysTaxable');
  const sysCgstTotal      = sum(results, 'sysCgst');
  const sysSgstTotal      = sum(results, 'sysSgst');
  const sysIgstTotal      = sum(results, 'sysIgst');
  const sysGrandTotal     = sum(results, 'sysTotal');

  console.log('AGGREGATE IMPACT (Excel Source vs System Derived)');
  console.log('─'.repeat(72));
  console.log(`  Field       │ Excel Source       │ System Derived     │ Difference`);
  console.log(`  ────────────┼────────────────────┼────────────────────┼──────────────`);
  const pad = (n) => formatINR(n).padStart(18);
  const diff = (a, b) => { const d = r2(b-a); return (d >= 0 ? '+' : '') + formatINR(d); };
  console.log(`  Taxable     │${pad(excelTaxableTotal)} │${pad(sysTaxableTotal)} │ ${diff(excelTaxableTotal, sysTaxableTotal)}`);
  console.log(`  CGST        │${pad(excelCgstTotal)}    │${pad(sysCgstTotal)}    │ ${diff(excelCgstTotal, sysCgstTotal)}`);
  console.log(`  SGST        │${pad(excelSgstTotal)}    │${pad(sysSgstTotal)}    │ ${diff(excelSgstTotal, sysSgstTotal)}`);
  console.log(`  IGST        │${pad(excelIgstTotal)}    │${pad(sysIgstTotal)}    │ ${diff(excelIgstTotal, sysIgstTotal)}`);
  console.log(`  Total       │${pad(excelGrandTotal)}   │${pad(sysGrandTotal)}   │ ${diff(excelGrandTotal, sysGrandTotal)}\n`);

  // ── Top 50 by max diff ────────────────────────────────────────────────────
  const top50 = [...results]
    .filter(r => r.maxDiff > 0)
    .sort((a, b) => b.maxDiff - a.maxDiff)
    .slice(0, 50);

  if (top50.length === 0) {
    console.log('TOP VARIANCES: All invoices are exact matches.\n');
  } else {
    console.log(`TOP ${top50.length} VARIANCES (sorted by |Δ| descending)`);
    console.log('─'.repeat(100));
    console.log(`  Invoice #      │ Source │ ExTaxable    SysTaxable   ΔTaxable   │ ExCGST    SysCGST   ΔCGST  │ ExTotal    SysTotal   ΔTotal`);
    console.log(`  ───────────────┼────────┼──────────────────────────────────────┼───────────────────────────┼────────────────────────────`);
    for (const r of top50) {
      const sign = (n) => (n > 0 ? '+' : '') + n.toFixed(2);
      console.log(
        `  ${r.invoice_number.padEnd(14)} │ ${(r.source ?? '').slice(0,6).padEnd(6)} │ ` +
        `${r.excelTaxable.toFixed(2).padStart(12)} ${r.sysTaxable.toFixed(2).padStart(12)} ${sign(r.dTaxable).padStart(9)} │ ` +
        `${r.excelCgst.toFixed(2).padStart(8)} ${r.sysCgst.toFixed(2).padStart(8)} ${sign(r.dCgst).padStart(7)} │ ` +
        `${r.excelTotal.toFixed(2).padStart(9)} ${r.sysTotal.toFixed(2).padStart(9)} ${sign(r.dTotal).padStart(8)}`
      );
    }
    console.log('');
  }

  // ── By source breakdown ───────────────────────────────────────────────────
  const sources = [...new Set(results.map(r => r.source))];
  if (sources.length > 1) {
    console.log('BY SOURCE BREAKDOWN');
    console.log('─'.repeat(50));
    for (const src of sources) {
      const srcRows = results.filter(r => r.source === src);
      const drifted = srcRows.filter(r => r.maxDiff > 0).length;
      console.log(`  ${src.padEnd(20)}: ${srcRows.length} invoices, ${drifted} drifted`);
    }
    console.log('');
  }

  return { results, categories, excelGrandTotal, sysGrandTotal };
}

// ── Also check purchase invoices ──────────────────────────────────────────────
async function auditPurchase() {
  // Uses same schema as auditTable — invoices table also has supplier_* columns (migration 034)
  await auditTable('invoices', 'Purchase Register (invoices table)');
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\nFINANCIAL RECONCILIATION AUDIT');
  console.log(`Run at: ${new Date().toISOString()}\n`);

  try {
    await auditTable('sales_invoices', 'Sales Register');
  } catch (e) {
    console.error('Sales audit error:', e.message);
  }

  try {
    await auditPurchase();
  } catch (e) {
    console.error('Purchase audit error:', e.message);
    console.log('(purchase table may be named differently — check schema)\n');
  }

  console.log('\nAudit complete.\n');
}

main();
