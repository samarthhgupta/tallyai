/**
 * TallyAI — Export Preview Impact Assessment
 *
 * PURPOSE: Compare old Export Preview values (stored inv.cgst/sgst/igst/total)
 * vs new Export Preview values (deriveInvoiceFinancials) for all accepted invoices.
 *
 * HOW TO RUN:
 *   1. Open the TallyAI app in your browser and log in.
 *   2. Open browser DevTools (F12) → Console tab.
 *   3. Paste this entire script and press Enter.
 *   4. Wait for "IMPACT ASSESSMENT COMPLETE" to appear.
 *   5. The full report is printed. Results are also saved to window.__tallyImpact.
 *
 * The script is read-only — it never writes to the database.
 */
(async () => {
  // ─── Canonical engine (mirrors invoiceCalculations.ts) ───────────────────
  const r2 = n => Math.round(n * 100) / 100;

  const EXPENSE_DEFAULTS = {
    'freight':                    { sac_code: '996511', gst_percent: 5  },
    'freight charges':            { sac_code: '996511', gst_percent: 5  },
    'freight & forwarding':       { sac_code: '996511', gst_percent: 5  },
    'freight forwarding':         { sac_code: '996511', gst_percent: 5  },
    'delivery charges':           { sac_code: '996511', gst_percent: 5  },
    'transport':                  { sac_code: '996511', gst_percent: 5  },
    'transportation':             { sac_code: '996511', gst_percent: 5  },
    'transportation charges':     { sac_code: '996511', gst_percent: 5  },
    'courier':                    { sac_code: '996812', gst_percent: 18 },
    'courier charges':            { sac_code: '996812', gst_percent: 18 },
    'postage':                    { sac_code: '996811', gst_percent: 18 },
    'postage & telegram':         { sac_code: '996811', gst_percent: 18 },
    'packing':                    { sac_code: '998540', gst_percent: 18 },
    'packing charges':            { sac_code: '998540', gst_percent: 18 },
    'packaging charges':          { sac_code: '998540', gst_percent: 18 },
    'loading':                    { sac_code: '996719', gst_percent: 18 },
    'unloading':                  { sac_code: '996719', gst_percent: 18 },
    'loading charges':            { sac_code: '996719', gst_percent: 18 },
    'loading & unloading':        { sac_code: '996719', gst_percent: 18 },
    'handling charges':           { sac_code: '996719', gst_percent: 18 },
    'insurance':                  { sac_code: '997135', gst_percent: 18 },
    'insurance charges':          { sac_code: '997135', gst_percent: 18 },
    'labour':                     { sac_code: '998519', gst_percent: 18 },
    'labour charges':             { sac_code: '998519', gst_percent: 18 },
    'accounting charges':         { sac_code: '998211', gst_percent: 18 },
    'round off':                  { sac_code: '',        gst_percent: 0  },
    'rounding off':               { sac_code: '',        gst_percent: 0  },
  };

  function resolveChargeSac(description, storedSac) {
    if (storedSac && storedSac.trim()) return storedSac.trim();
    const key = (description || '').toLowerCase().trim();
    if (EXPENSE_DEFAULTS[key]) return EXPENSE_DEFAULTS[key].sac_code;
    for (const k of Object.keys(EXPENSE_DEFAULTS)) {
      if (key.includes(k) || k.includes(key)) return EXPENSE_DEFAULTS[k].sac_code;
    }
    return undefined;
  }

  function calcLineAmount(item) {
    return r2((item.qty ?? 0) * item.rate * (1 - (item.disc_percent ?? 0) / 100));
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
    for (const row of Object.values(map)) {
      const ds = totalTaxable > 0 && billDiscount > 0 ? billDiscount * (row.taxable / totalTaxable) : 0;
      row.taxable = r2(row.taxable - ds);
      const tax = r2(row.taxable * row.gst_percent / 100);
      if (taxType === 'cgst_sgst') { row.cgst = r2(tax / 2); row.sgst = r2(tax / 2); }
      else { row.igst = tax; }
    }
    return Object.values(map);
  }

  function buildFullTaxSummary(items, charges, taxType, billDiscount = 0) {
    const rows = buildHsnSummary(items, taxType, billDiscount);
    for (const c of charges) {
      const code = (c.sac ?? c.hsn ?? '').trim();
      if (!code) continue;
      const tax = r2(c.amount * c.gst_percent / 100);
      rows.push({
        hsn: code, gst_percent: c.gst_percent, taxable: r2(c.amount),
        cgst: taxType === 'cgst_sgst' ? r2(tax / 2) : 0,
        sgst: taxType === 'cgst_sgst' ? r2(tax / 2) : 0,
        igst: taxType === 'igst' ? tax : 0,
      });
    }
    return rows;
  }

  function deriveInvoiceFinancials(inv) {
    const lineItems = inv.line_items ?? [];
    const billDiscount = inv.bill_discount_amount ?? 0;
    const charges_resolved = (inv.charges ?? []).map(c => ({
      ...c, sac: resolveChargeSac(c.description ?? '', c.sac),
    }));
    const goods_subtotal = r2(lineItems.reduce((s, it) => s + calcLineAmount(it), 0));
    const taxable_charges_total = r2(charges_resolved.filter(c => (c.gst_percent ?? 0) > 0).reduce((s, c) => s + c.amount, 0));
    const non_taxable_charges_total = r2(charges_resolved.filter(c => (c.gst_percent ?? 0) === 0).reduce((s, c) => s + c.amount, 0));
    const net_goods_taxable = r2(goods_subtotal - billDiscount);
    const tax_rows = buildFullTaxSummary(lineItems, charges_resolved, inv.tax_type, billDiscount);
    const cgst = r2(tax_rows.reduce((s, row) => s + row.cgst, 0));
    const sgst = r2(tax_rows.reduce((s, row) => s + row.sgst, 0));
    const igst = r2(tax_rows.reduce((s, row) => s + row.igst, 0));
    const total_gst = r2(cgst + sgst + igst);
    const round_off = r2(inv.round_off ?? 0);
    const total = r2(net_goods_taxable + taxable_charges_total + non_taxable_charges_total + total_gst + round_off);
    return { goods_subtotal, bill_discount: billDiscount, net_goods_taxable, taxable_charges_total, non_taxable_charges_total, charges_resolved, tax_rows, cgst, sgst, igst, total_gst, round_off, total };
  }

  // ─── Fetch all accepted invoices ─────────────────────────────────────────
  // Uses the same Supabase client the app already has in window context.
  // If window.__supabase is not available, falls back to the global createClient pattern.
  let supabase;
  try {
    // The app exposes supabase via module internals; try common patterns
    supabase = window.__supabase
      || window.supabase
      || (window._tallySupabase);
    if (!supabase) {
      // Last resort: construct from env vars baked into the page
      const meta = document.querySelector('meta[name="supabase-url"]');
      const keyMeta = document.querySelector('meta[name="supabase-anon-key"]');
      if (meta && keyMeta) {
        const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
        supabase = createClient(meta.content, keyMeta.content);
      }
    }
  } catch (e) { /* will handle below */ }

  // If still no client, try to reconstruct from the page's env
  if (!supabase) {
    // Next.js bakes NEXT_PUBLIC_ vars into __NEXT_DATA__
    const nextData = window.__NEXT_DATA__;
    const env = nextData?.props?.pageProps || {};
    const url = env.NEXT_PUBLIC_SUPABASE_URL
      || document.querySelector('[data-supabase-url]')?.dataset?.supabaseUrl;
    const key = env.NEXT_PUBLIC_SUPABASE_ANON_KEY
      || document.querySelector('[data-supabase-anon-key]')?.dataset?.supabaseAnonKey;

    if (url && key) {
      const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
      supabase = createClient(url, key);
    }
  }

  if (!supabase) {
    console.error(`
Could not auto-detect Supabase client. Please do one of the following before running:

Option A — paste your credentials first:
  const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
  window.__supabase = createClient(
    'https://idstdsuvxqzoankfgde.supabase.co',
    '<your-anon-key>'
  );
  // then re-run this script

Option B — run from the /register page where the client is already active.
    `);
    return;
  }

  console.log('Fetching accepted invoices...');
  // Fetch in pages to handle large datasets
  let allInvoices = [];
  let from = 0;
  const PAGE = 1000;
  while (true) {
    const { data, error } = await supabase
      .from('invoices')
      .select('id, invoice_number, vendor_name, invoice_date, tax_type, cgst, sgst, igst, total, round_off, subtotal, bill_discount_amount, line_items, charges')
      .eq('status', 'accepted')
      .range(from, from + PAGE - 1);
    if (error) { console.error('Fetch error:', error); return; }
    if (!data || data.length === 0) break;
    allInvoices = allInvoices.concat(data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  console.log(`Fetched ${allInvoices.length} accepted invoices. Comparing...`);

  // ─── Comparison ──────────────────────────────────────────────────────────
  const THRESH = 0.01; // treat differences < 1 paisa as float noise, not real divergence
  const abs = Math.abs;

  const results = allInvoices.map(inv => {
    const d = deriveInvoiceFinancials(inv);

    const old_cgst  = inv.cgst  ?? 0;
    const old_sgst  = inv.sgst  ?? 0;
    const old_igst  = inv.igst  ?? 0;
    const old_total = inv.total ?? 0;

    const cgst_diff  = r2(d.cgst  - old_cgst);
    const sgst_diff  = r2(d.sgst  - old_sgst);
    const igst_diff  = r2(d.igst  - old_igst);
    const total_diff = r2(d.total - old_total);

    const changed = abs(cgst_diff) > THRESH || abs(sgst_diff) > THRESH
                 || abs(igst_diff) > THRESH || abs(total_diff) > THRESH;

    // Categorise causes (may be multiple)
    const causes = [];
    const charges = inv.charges ?? [];
    const taxableCharges = charges.filter(c => {
      const sac = resolveChargeSac(c.description ?? '', c.sac);
      return sac && (c.gst_percent ?? 0) > 0;
    });
    if (taxableCharges.length > 0) causes.push('taxable_charges');
    if ((inv.bill_discount_amount ?? 0) > 0) causes.push('bill_discount');
    if (changed && abs(total_diff) > THRESH && abs(cgst_diff) <= THRESH && abs(sgst_diff) <= THRESH && abs(igst_diff) <= THRESH) causes.push('stale_stored_total');
    if (changed && (abs(cgst_diff) > THRESH || abs(sgst_diff) > THRESH || abs(igst_diff) > THRESH)) causes.push('stale_stored_gst');

    return {
      id: inv.id,
      invoice_number: inv.invoice_number,
      vendor_name: inv.vendor_name,
      invoice_date: inv.invoice_date,
      old:  { cgst: old_cgst, sgst: old_sgst, igst: old_igst, total: old_total, round_off: inv.round_off ?? 0 },
      new:  { cgst: d.cgst,   sgst: d.sgst,   igst: d.igst,   total: d.total,   round_off: d.round_off },
      diff: { cgst: cgst_diff, sgst: sgst_diff, igst: igst_diff, total: total_diff },
      changed,
      causes,
      taxable_charges_detail: taxableCharges.map(c => `${c.description} ₹${c.amount}@${c.gst_percent}%`),
    };
  });

  const changed = results.filter(r => r.changed);
  const unchanged = results.filter(r => !r.changed);

  // ─── Category counts ─────────────────────────────────────────────────────
  const withTaxableCharges  = results.filter(r => r.causes.includes('taxable_charges'));
  const withBillDiscount    = results.filter(r => r.causes.includes('bill_discount'));
  const changedByCharges    = changed.filter(r => r.causes.includes('taxable_charges'));
  const changedByStaleGST   = changed.filter(r => r.causes.includes('stale_stored_gst'));
  const changedByStaleTotal = changed.filter(r => r.causes.includes('stale_stored_total'));

  // ─── Print report ────────────────────────────────────────────────────────
  const fmt = n => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtDiff = n => (n >= 0 ? '+' : '') + fmt(n);

  console.log('\n' + '═'.repeat(70));
  console.log('EXPORT PREVIEW IMPACT ASSESSMENT — OLD vs NEW');
  console.log('═'.repeat(70));
  console.log(`\nTotal accepted invoices analysed : ${allInvoices.length}`);
  console.log(`Invoices with NO change          : ${unchanged.length}`);
  console.log(`Invoices WITH change             : ${changed.length} (${((changed.length/allInvoices.length)*100).toFixed(1)}%)`);

  console.log('\n── Changed field breakdown ────────────────────────────────');
  const cgstChanged  = changed.filter(r => abs(r.diff.cgst)  > THRESH).length;
  const sgstChanged  = changed.filter(r => abs(r.diff.sgst)  > THRESH).length;
  const igstChanged  = changed.filter(r => abs(r.diff.igst)  > THRESH).length;
  const totalChanged = changed.filter(r => abs(r.diff.total) > THRESH).length;
  console.log(`  CGST changes         : ${cgstChanged}`);
  console.log(`  SGST changes         : ${sgstChanged}`);
  console.log(`  IGST changes         : ${igstChanged}`);
  console.log(`  Total changes        : ${totalChanged}`);
  console.log(`  Party Amount         : same as Total (negated)`);
  console.log(`  Round Off            : unchanged (user input, passed through)`);

  console.log('\n── Root cause breakdown ───────────────────────────────────');
  console.log(`  All invoices with taxable charges    : ${withTaxableCharges.length}`);
  console.log(`  All invoices with bill discount      : ${withBillDiscount.length}`);
  console.log(`  Changed due to taxable charges       : ${changedByCharges.length}`);
  console.log(`  Changed due to stale stored GST      : ${changedByStaleGST.length}`);
  console.log(`  Changed due to stale stored total    : ${changedByStaleTotal.length}`);

  if (changed.length === 0) {
    console.log('\n✓ No invoices will show different values after deployment.');
    window.__tallyImpact = { summary: { total: allInvoices.length, changed: 0 }, results };
    console.log('IMPACT ASSESSMENT COMPLETE');
    return;
  }

  // ─── Top examples ────────────────────────────────────────────────────────
  // Sort by absolute total difference descending for most impactful examples
  const sorted = [...changed].sort((a, b) => abs(b.diff.total) - abs(a.diff.total));
  const examples = sorted.slice(0, Math.min(10, sorted.length));

  console.log('\n── Examples (up to 10, sorted by |Δtotal| descending) ─────');
  examples.forEach((r, i) => {
    console.log(`\n  ${i+1}. ${r.invoice_number}  ${r.vendor_name}  (${r.invoice_date ?? 'no date'})`);
    console.log(`     Cause(s): ${r.causes.join(', ')}`);
    if (r.taxable_charges_detail.length) console.log(`     Charges: ${r.taxable_charges_detail.join(' | ')}`);
    console.log(`                  OLD          NEW       DIFF`);
    const pad = s => String(s).padStart(12);
    if (abs(r.diff.cgst) > THRESH || abs(r.diff.sgst) > THRESH || abs(r.diff.igst) > THRESH) {
      if (r.old.cgst || r.new.cgst) console.log(`     CGST    ${pad(fmt(r.old.cgst))} ${pad(fmt(r.new.cgst))} ${pad(fmtDiff(r.diff.cgst))}`);
      if (r.old.sgst || r.new.sgst) console.log(`     SGST    ${pad(fmt(r.old.sgst))} ${pad(fmt(r.new.sgst))} ${pad(fmtDiff(r.diff.sgst))}`);
      if (r.old.igst || r.new.igst) console.log(`     IGST    ${pad(fmt(r.old.igst))} ${pad(fmt(r.new.igst))} ${pad(fmtDiff(r.diff.igst))}`);
    }
    if (abs(r.diff.total) > THRESH)
      console.log(`     Total   ${pad(fmt(r.old.total))} ${pad(fmt(r.new.total))} ${pad(fmtDiff(r.diff.total))}`);
    console.log(`     Party   ${pad(fmt(-r.old.total))} ${pad(fmt(-r.new.total))} ${pad(fmtDiff(-r.diff.total))}`);
  });

  if (changed.length > 10) {
    console.log(`\n  ... and ${changed.length - 10} more. Full list in window.__tallyImpact.changed`);
  }

  // Save full results for further inspection
  window.__tallyImpact = {
    summary: {
      total: allInvoices.length,
      unchanged: unchanged.length,
      changed: changed.length,
      by_cause: {
        taxable_charges: changedByCharges.length,
        stale_stored_gst: changedByStaleGST.length,
        stale_stored_total: changedByStaleTotal.length,
      },
    },
    changed: sorted,
    unchanged,
    all: results,
  };

  console.log('\n── Full results saved to window.__tallyImpact ─────────────');
  console.log('   window.__tallyImpact.changed      — all invoices with differences');
  console.log('   window.__tallyImpact.summary      — counts by category');
  console.log('   window.__tallyImpact.all           — every invoice compared');
  console.log('\nEXPORT TO CSV (optional):');
  console.log(`  const rows = window.__tallyImpact.changed.map(r => [r.invoice_number, r.vendor_name, r.invoice_date, r.old.cgst, r.new.cgst, r.diff.cgst, r.old.total, r.new.total, r.diff.total, r.causes.join(';')].join(','));`);
  console.log(`  const csv = ['invoice_number,vendor_name,date,old_cgst,new_cgst,diff_cgst,old_total,new_total,diff_total,causes', ...rows].join('\\n');`);
  console.log(`  navigator.clipboard.writeText(csv).then(() => console.log('CSV copied to clipboard'));`);

  console.log('\n' + '═'.repeat(70));
  console.log('IMPACT ASSESSMENT COMPLETE');
  console.log('═'.repeat(70));
})();
