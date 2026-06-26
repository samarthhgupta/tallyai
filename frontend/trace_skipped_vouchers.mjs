/**
 * Forensic trace of the 14 skipped vouchers.
 * Fetches real invoice data from Supabase, replicates the builder
 * and validator logic step-by-step, and prints every decision.
 *
 *   node scripts/trace_skipped_vouchers.mjs
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://idstdsuvxqzoankfgde.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SERVICE_KEY) { console.error('Set SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }
const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

const TARGET_INVOICES = ['KKE002537', 'KKE002442', 'KKE002105'];

// ─── Replicated helpers (must stay in sync with source) ───────────────────────

const r2 = (n) => Math.round(n * 100) / 100;
function fmt2(n) { return n.toFixed(2); }

function calcLineAmount(item) {
  const disc = item.disc_percent ?? 0;
  return r2((item.qty ?? 0) * (item.rate ?? 0) * (1 - disc / 100));
}

function deriveInvoiceFinancials(inv) {
  const items = inv.line_items ?? [];
  const taxType = inv.tax_type ?? 'cgst_sgst';
  const billDiscount = inv.bill_discount_amount ?? 0;

  let net_goods_taxable = 0;
  let cgstPaisa = 0, sgstPaisa = 0, igstPaisa = 0;

  for (const item of items) {
    const lineAmt = calcLineAmount(item);
    const gst = item.gst_percent ?? 0;
    if (gst === 0) continue;
    net_goods_taxable += lineAmt;
    const taxableLine = r2(lineAmt * (1 - billDiscount / 100));
    if (taxType === 'cgst_sgst') {
      cgstPaisa += Math.round(taxableLine * (gst / 2) * 100);
      sgstPaisa += Math.round(taxableLine * (gst / 2) * 100);
    } else {
      igstPaisa += Math.round(taxableLine * gst * 100);
    }
  }

  const cgst = cgstPaisa / 100;
  const sgst = sgstPaisa / 100;
  const igst = igstPaisa / 100;
  const total_gst = cgst + sgst + igst;

  let non_taxable = 0;
  let taxable_charges = 0;
  const charges_resolved = [];
  for (const c of inv.charges ?? []) {
    if (!c.amount) continue;
    charges_resolved.push(c);
    if (c.gst_percent && c.gst_percent > 0) taxable_charges += c.amount;
    else non_taxable += c.amount;
  }

  const total = r2((inv.total_amount ?? 0));
  const round_off = r2(total - net_goods_taxable - total_gst - taxable_charges - non_taxable);

  return {
    cgst, sgst, igst, total_gst,
    net_goods_taxable: r2(net_goods_taxable),
    taxable_charges_total: r2(taxable_charges),
    non_taxable_charges_total: r2(non_taxable),
    total,
    round_off,
    bill_discount: billDiscount,
    charges_resolved,
  };
}

// ─── Validator replica (exact copy of the new code in salesXmlGenerator.ts) ───

function parseEmittedAmount(xml) {
  const m = xml.match(/<AMOUNT>([^<]*)<\/AMOUNT>/);
  return parseFloat(m?.[1] ?? '0');
}

function parseEmittedIsDeemedPositive(xml) {
  const m = xml.match(/<ISDEEMEDPOSITIVE>([^<]*)<\/ISDEEMEDPOSITIVE>/);
  return m?.[1] ?? 'No';
}

function runValidator(invoiceNumber, ledgerEntries, invEntries, buyerState, cmpState) {
  console.log('\n══════════════════════════════════════════════');
  console.log(`STEP 3 — Validator Trace for ${invoiceNumber}`);
  console.log('══════════════════════════════════════════════');

  let emittedDebitSum = 0;
  let emittedCreditSum = 0;

  console.log('\n── Ledger Entries ──────────────────────────');
  for (const entry of ledgerEntries) {
    const amt = parseEmittedAmount(entry);
    const idp = parseEmittedIsDeemedPositive(entry);
    const nameMatch = entry.match(/<LEDGERNAME>([^<]*)<\/LEDGERNAME>/);
    const name = nameMatch?.[1] ?? '?';
    const isDebit = idp === 'Yes';
    if (isDebit) emittedDebitSum += Math.abs(amt);
    else emittedCreditSum += Math.abs(amt);
    console.log(`  Ledger: "${name}"`);
    console.log(`    Amount Parsed  : ${amt}`);
    console.log(`    ISDEEMEDPOSITIVE: ${idp}`);
    console.log(`    → ${isDebit ? 'DEBIT  ' : 'CREDIT '} ${Math.abs(amt).toFixed(2)}`);
  }

  console.log('\n── Inventory Entries ───────────────────────');
  for (const entry of invEntries) {
    const amt = parseEmittedAmount(entry);
    const nameMatch = entry.match(/<STOCKITEMNAME>([^<]*)<\/STOCKITEMNAME>/);
    const name = nameMatch?.[1] ?? '?';
    const isDebit = amt < 0;
    if (isDebit) emittedDebitSum += Math.abs(amt);
    else emittedCreditSum += amt;
    console.log(`  Stock Item: "${name}"`);
    console.log(`    Amount Parsed: ${amt}`);
    console.log(`    → ${isDebit ? 'DEBIT  ' : 'CREDIT '} ${Math.abs(amt).toFixed(2)}`);
  }

  const imbalance = Math.abs(emittedDebitSum - emittedCreditSum);
  console.log('\n── STEP 4 — Validator Result ───────────────');
  console.log(`  Debit  Total : ${emittedDebitSum.toFixed(2)}`);
  console.log(`  Credit Total : ${emittedCreditSum.toFixed(2)}`);
  console.log(`  Difference   : ${imbalance.toFixed(2)}`);
  if (imbalance > 0.01) {
    console.log(`  ❌ IMBALANCED — validator would SKIP this voucher`);
  } else {
    console.log(`  ✅ BALANCED`);
  }
  return imbalance;
}

// ─── Builder replica for inventory mode ───────────────────────────────────────

function buildLedgerEntry(opts) {
  // Minimal replica of invSalesLedgerEntry — enough to test the regex
  const rateBlock = opts.rateOfInvoiceTax != null
    ? `\n        <RATEOFINVOICETAX.LIST TYPE="Number">\n          <RATEOFINVOICETAX> ${opts.rateOfInvoiceTax}</RATEOFINVOICETAX>\n        </RATEOFINVOICETAX.LIST>`
    : '';
  const billAlloc = opts.billRefName
    ? `\n        <BILLALLOCATIONS.LIST>\n          <NAME>${opts.billRefName}</NAME>\n          <BILLTYPE>New Ref</BILLTYPE>\n          <TDSDEDUCTEEISSPECIALRATE>No</TDSDEDUCTEEISSPECIALRATE>\n          <AMOUNT>${fmt2(opts.amount)}</AMOUNT>\n          <INTERESTCOLLECTION.LIST> </INTERESTCOLLECTION.LIST>\n          <STBILLCATEGORIES.LIST> </STBILLCATEGORIES.LIST>\n        </BILLALLOCATIONS.LIST>`
    : `\n        <BILLALLOCATIONS.LIST> </BILLALLOCATIONS.LIST>`;
  return (
    `\n      <LEDGERENTRIES.LIST>` +
    `\n        <OLDAUDITENTRYIDS.LIST TYPE="Number"><OLDAUDITENTRYIDS>-1</OLDAUDITENTRYIDS></OLDAUDITENTRYIDS.LIST>` +
    rateBlock +
    `\n        <LEDGERNAME>${opts.ledgerName}</LEDGERNAME>` +
    `\n        <GSTCLASS> Not Applicable</GSTCLASS>` +
    `\n        <ISDEEMEDPOSITIVE>${opts.isdeemedpositive}</ISDEEMEDPOSITIVE>` +
    `\n        <ISPARTYLEDGER>${opts.isPartyledger}</ISPARTYLEDGER>` +
    `\n        <ISLASTDEEMEDPOSITIVE>${opts.islastdeemedpositive}</ISLASTDEEMEDPOSITIVE>` +
    `\n        <AMOUNT>${fmt2(opts.amount)}</AMOUNT>` +
    billAlloc +
    `\n      </LEDGERENTRIES.LIST>`
  );
}

function buildIncomeLedgerEntry(ledgerName, amount) {
  return (
    `\n      <LEDGERENTRIES.LIST>` +
    `\n        <LEDGERNAME>${ledgerName}</LEDGERNAME>` +
    `\n        <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>` +
    `\n        <ISPARTYLEDGER>No</ISPARTYLEDGER>` +
    `\n        <ISLASTDEEMEDPOSITIVE>No</ISLASTDEEMEDPOSITIVE>` +
    `\n        <AMOUNT>${fmt2(amount)}</AMOUNT>` +
    `\n      </LEDGERENTRIES.LIST>`
  );
}

function buildInventoryEntry(itemName, amount) {
  return (
    `\n      <ALLINVENTORYENTRIES.LIST>` +
    `\n        <STOCKITEMNAME>${itemName}</STOCKITEMNAME>` +
    `\n        <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>` +
    `\n        <AMOUNT>${fmt2(amount)}</AMOUNT>` +
    `\n        <BATCHALLOCATIONS.LIST>` +
    `\n          <AMOUNT>${fmt2(amount)}</AMOUNT>` +
    `\n        </BATCHALLOCATIONS.LIST>` +
    `\n        <ACCOUNTINGALLOCATIONS.LIST>` +
    `\n          <LEDGERNAME>SALES_LEDGER</LEDGERNAME>` +
    `\n          <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>` +
    `\n          <AMOUNT>${fmt2(amount)}</AMOUNT>` +
    `\n        </ACCOUNTINGALLOCATIONS.LIST>` +
    `\n      </ALLINVENTORYENTRIES.LIST>`
  );
}

// ─── Fetch data and trace ──────────────────────────────────────────────────────

async function traceInvoice(inv, stockItems, customers, dutiesTaxes) {
  console.log('\n\n╔══════════════════════════════════════════════════════════════╗');
  console.log(`║  FORENSIC TRACE: ${inv.invoice_number.padEnd(44)}║`);
  console.log('╚══════════════════════════════════════════════════════════════╝');

  const acc = inv.tally_ledger_acceptance ?? {};
  const d = deriveInvoiceFinancials(inv);

  console.log('\n── Invoice Mode ────────────────────────────────');
  const mode = inv.invoice_voucher_mode ?? 'accounting_only';
  console.log(`  invoice_voucher_mode : ${mode}`);
  console.log(`  tax_type             : ${inv.tax_type ?? '(null)'}`);

  console.log('\n── Financials (deriveInvoiceFinancials) ────────');
  console.log(`  d.total              : ${d.total}`);
  console.log(`  d.cgst               : ${d.cgst}`);
  console.log(`  d.sgst               : ${d.sgst}`);
  console.log(`  d.igst               : ${d.igst}`);
  console.log(`  d.net_goods_taxable  : ${d.net_goods_taxable}`);
  console.log(`  d.taxable_charges    : ${d.taxable_charges_total}`);
  console.log(`  d.non_taxable_charges: ${d.non_taxable_charges_total}`);
  console.log(`  d.round_off          : ${d.round_off}`);

  console.log('\n── Ledger Acceptance ───────────────────────────');
  console.log(`  customerLedger : "${acc.customerLedger ?? '(none)'}"`);
  console.log(`  salesLedger    : "${acc.salesLedger ?? '(none)'}"`);
  console.log(`  cgstLedger     : "${acc.cgstLedger ?? '(none)'}"`);
  console.log(`  sgstLedger     : "${acc.sgstLedger ?? '(none)'}"`);
  console.log(`  igstLedger     : "${acc.igstLedger ?? '(none)'}"`);

  const salesLedger = acc.salesLedger?.trim() ?? '';
  if (!salesLedger) {
    console.log('\n  ⚠️  No salesLedger set — builder would SKIP with "No sales ledger set"');
    return;
  }

  // Customer resolution
  const accCustomer = acc.customerLedger?.trim() ?? '';
  let resolvedCustomer = null;
  if (!accCustomer) {
    resolvedCustomer = customers.find(c =>
      (inv.buyer_gstin && c.gstin === inv.buyer_gstin) ||
      (c.buyer_name && inv.buyer_name && c.buyer_name.toLowerCase() === inv.buyer_name.toLowerCase())
    );
  }
  const partyLedger = accCustomer || resolvedCustomer?.tally_ledger_name || inv.buyer_name || '';
  console.log(`\n  partyLedger resolved : "${partyLedger}"`);
  if (!partyLedger) {
    console.log('  ⚠️  No partyLedger — builder would SKIP');
    return;
  }

  // STEP 1 — Build ledgerEntries
  console.log('\n══════════════════════════════════════════════');
  console.log('STEP 1 — Building ledgerEntries');
  console.log('══════════════════════════════════════════════');

  const ledgerEntries = [];

  // Customer entry
  const custEntry = buildLedgerEntry({
    ledgerName: partyLedger,
    isdeemedpositive: 'Yes',
    isPartyledger: 'Yes',
    islastdeemedpositive: 'Yes',
    amount: -d.total,
    billRefName: inv.invoice_number,
  });
  ledgerEntries.push(custEntry);
  console.log(`\n  [1] Customer: "${partyLedger}"`);
  console.log(`      amount           : ${-d.total}`);
  console.log(`      isdeemedpositive : Yes`);

  // GST entries
  const taxBase = d.net_goods_taxable + d.taxable_charges_total;
  const absTaxBase = Math.abs(taxBase);
  const roundHalf = (r) => Math.round(r * 2) / 2;

  const cgstAbs = Math.abs(d.cgst);
  const sgstAbs = Math.abs(d.sgst);
  const igstAbs = Math.abs(d.igst);

  console.log(`\n  GST check: Math.abs(d.cgst)=${cgstAbs} > 0.001? ${cgstAbs > 0.001}`);
  console.log(`  GST check: Math.abs(d.sgst)=${sgstAbs} > 0.001? ${sgstAbs > 0.001}`);
  console.log(`  GST check: Math.abs(d.igst)=${igstAbs} > 0.001? ${igstAbs > 0.001}`);

  if (cgstAbs > 0.001) {
    const rate = absTaxBase > 0.001 ? roundHalf((cgstAbs / absTaxBase) * 100) : 0;
    const isDebit = d.cgst < 0;
    // Find ledger
    const cgstLedger = acc.cgstLedger?.trim()
      || dutiesTaxes.find(dt => dt.gst_type === 'CGST')?.tally_ledger_name
      || null;
    if (!cgstLedger) {
      console.log(`  ⚠️  No CGST ledger found — builder would SKIP with "No CGST ledger configured"`);
      return;
    }
    const entry = buildLedgerEntry({
      ledgerName: cgstLedger,
      isdeemedpositive: isDebit ? 'Yes' : 'No',
      isPartyledger: 'No',
      islastdeemedpositive: isDebit ? 'Yes' : 'No',
      amount: d.cgst,
      rateOfInvoiceTax: rate || undefined,
    });
    ledgerEntries.push(entry);
    console.log(`\n  [${ledgerEntries.length}] CGST: "${cgstLedger}"`);
    console.log(`      d.cgst           : ${d.cgst}`);
    console.log(`      isdeemedpositive : ${isDebit ? 'Yes (debit)' : 'No (credit)'}`);
    console.log(`      rate             : ${rate}%`);
  }

  if (sgstAbs > 0.001) {
    const rate = absTaxBase > 0.001 ? roundHalf((sgstAbs / absTaxBase) * 100) : 0;
    const isDebit = d.sgst < 0;
    const sgstLedger = acc.sgstLedger?.trim()
      || dutiesTaxes.find(dt => dt.gst_type === 'SGST')?.tally_ledger_name
      || null;
    if (!sgstLedger) {
      console.log(`  ⚠️  No SGST ledger found — builder would SKIP with "No SGST ledger configured"`);
      return;
    }
    const entry = buildLedgerEntry({
      ledgerName: sgstLedger,
      isdeemedpositive: isDebit ? 'Yes' : 'No',
      isPartyledger: 'No',
      islastdeemedpositive: isDebit ? 'Yes' : 'No',
      amount: d.sgst,
      rateOfInvoiceTax: rate || undefined,
    });
    ledgerEntries.push(entry);
    console.log(`\n  [${ledgerEntries.length}] SGST: "${sgstLedger}"`);
    console.log(`      d.sgst           : ${d.sgst}`);
    console.log(`      isdeemedpositive : ${isDebit ? 'Yes (debit)' : 'No (credit)'}`);
    console.log(`      rate             : ${rate}%`);
  }

  if (igstAbs > 0.001) {
    const rate = absTaxBase > 0.001 ? roundHalf((igstAbs / absTaxBase) * 100) : 0;
    const isDebit = d.igst < 0;
    const igstLedger = acc.igstLedger?.trim()
      || dutiesTaxes.find(dt => dt.gst_type === 'IGST')?.tally_ledger_name
      || null;
    if (!igstLedger) {
      console.log(`  ⚠️  No IGST ledger found — builder would SKIP with "No IGST ledger configured"`);
      return;
    }
    const entry = buildLedgerEntry({
      ledgerName: igstLedger,
      isdeemedpositive: isDebit ? 'Yes' : 'No',
      isPartyledger: 'No',
      islastdeemedpositive: isDebit ? 'Yes' : 'No',
      amount: d.igst,
      rateOfInvoiceTax: rate || undefined,
    });
    ledgerEntries.push(entry);
    console.log(`\n  [${ledgerEntries.length}] IGST: "${igstLedger}"`);
    console.log(`      d.igst           : ${d.igst}`);
    console.log(`      isdeemedpositive : ${isDebit ? 'Yes (debit)' : 'No (credit)'}`);
    console.log(`      rate             : ${rate}%`);
  }

  // STEP 2 — Inventory entries
  console.log('\n══════════════════════════════════════════════');
  console.log('STEP 2 — Building invEntries');
  console.log('══════════════════════════════════════════════');

  const invEntries = [];
  let totalItemsAmount = 0;
  let unmappedItemsAmount = 0;

  for (const item of inv.line_items ?? []) {
    const itemNet = calcLineAmount(item);
    const desc = item.description ?? '';
    const hsn = item.hsn ?? '';
    // Try to find stock item
    const si = stockItems.find(s =>
      (hsn && s.hsn_code && s.hsn_code.replace(/[\s.]/g, '') === hsn.replace(/[\s.]/g, '')) ||
      (s.tally_item_name && s.tally_item_name.toLowerCase() === desc.toLowerCase())
    );
    if (!si) {
      console.log(`  ⚠️  Item "${desc}" (HSN ${hsn}) NOT mapped to stock item → unmapped (books to sales ledger)`);
      unmappedItemsAmount += itemNet;
      continue;
    }
    totalItemsAmount += itemNet;
    const entry = buildInventoryEntry(si.tally_item_name, itemNet);
    invEntries.push(entry);
    console.log(`\n  Stock item: "${si.tally_item_name}"`);
    console.log(`    calcLineAmount   : ${itemNet}`);
    console.log(`    qty=${item.qty}, rate=${item.rate}, disc=${item.disc_percent ?? 0}%`);
  }

  console.log(`\n  invEntries.length    : ${invEntries.length}`);
  console.log(`  totalItemsAmount     : ${totalItemsAmount}`);
  console.log(`  unmappedItemsAmount  : ${unmappedItemsAmount}`);

  if (invEntries.length === 0) {
    console.log('\n  ⚠️  invEntries is EMPTY — builder falls back to buildSalesVoucher (accounting-only)');
    console.log('     The new inventory-mode validator does NOT run for this invoice.');
    console.log('     The imbalance is from the old pre-computed validateVoucherBalance call.');
    // Simulate old validator
    const debitTotal = d.total;
    const creditTotal = d.net_goods_taxable + d.taxable_charges_total + d.non_taxable_charges_total + d.total_gst + d.round_off;
    console.log(`\n  Old validator (accounting-only): debit=${debitTotal.toFixed(2)}, credit=${creditTotal.toFixed(2)}`);
    console.log(`  Imbalance: ${Math.abs(debitTotal - creditTotal).toFixed(2)}`);
    return;
  }

  // Sales ledger gap formula
  const taxes = d.cgst + d.sgst + d.igst;
  const mappedChargesTotal = 0; // simplified — charges handled separately
  const unmappedChargesTotal = 0;
  const roundOffCredit = 0;
  const roundOffDebit = 0;
  const totalCreditSide = totalItemsAmount + unmappedItemsAmount + taxes + mappedChargesTotal + unmappedChargesTotal + roundOffCredit;
  const totalDebitSide = d.total + roundOffDebit;
  const gap = parseFloat((totalDebitSide - totalCreditSide).toFixed(2));
  const netSalesLedgerAdj = unmappedItemsAmount + unmappedChargesTotal + gap;

  console.log('\n  Gap formula:');
  console.log(`    totalItemsAmount   : ${totalItemsAmount}`);
  console.log(`    unmappedItems      : ${unmappedItemsAmount}`);
  console.log(`    taxes (cgst+sgst+igst): ${taxes}`);
  console.log(`    totalCreditSide    : ${totalCreditSide}`);
  console.log(`    totalDebitSide     : ${totalDebitSide}`);
  console.log(`    gap                : ${gap}`);
  console.log(`    netSalesLedgerAdj  : ${netSalesLedgerAdj}`);

  if (Math.abs(netSalesLedgerAdj) > 0.01) {
    if (netSalesLedgerAdj > 0) {
      const entry = buildIncomeLedgerEntry(salesLedger, netSalesLedgerAdj);
      ledgerEntries.push(entry);
      console.log(`\n  [${ledgerEntries.length}] Sales Ledger (CREDIT): "${salesLedger}" amount=${netSalesLedgerAdj}`);
    } else {
      const entry = buildLedgerEntry({
        ledgerName: salesLedger,
        isdeemedpositive: 'Yes',
        isPartyledger: 'No',
        islastdeemedpositive: 'Yes',
        amount: -Math.abs(netSalesLedgerAdj),
      });
      ledgerEntries.push(entry);
      console.log(`\n  [${ledgerEntries.length}] Sales Ledger (DEBIT): "${salesLedger}" amount=${-Math.abs(netSalesLedgerAdj)}`);
    }
  } else {
    console.log(`  netSalesLedgerAdj too small (${netSalesLedgerAdj}) — no sales ledger entry added`);
  }

  console.log(`\n  Total ledgerEntries: ${ledgerEntries.length}`);
  console.log('  Entries:');
  for (let i = 0; i < ledgerEntries.length; i++) {
    const name = ledgerEntries[i].match(/<LEDGERNAME>([^<]*)<\/LEDGERNAME>/)?.[1] ?? '?';
    const amt = parseEmittedAmount(ledgerEntries[i]);
    const idp = parseEmittedIsDeemedPositive(ledgerEntries[i]);
    console.log(`    [${i+1}] "${name}" amt=${amt} idp=${idp}`);
  }

  // Run the validator
  runValidator(inv.invoice_number, ledgerEntries, invEntries, '', '');
}

async function main() {
  console.log('Fetching invoices from Supabase...\n');

  const { data: invoices, error: invErr } = await supabase
    .from('invoices')
    .select('*')
    .in('invoice_number', TARGET_INVOICES)
    .order('invoice_number');

  if (invErr) { console.error('Invoice fetch error:', invErr); process.exit(1); }
  if (!invoices?.length) { console.error('No invoices found for:', TARGET_INVOICES); process.exit(1); }

  // Use the company_id from first invoice
  const companyId = invoices[0].company_id;
  console.log(`Company ID: ${companyId}`);

  const [{ data: stockItems }, { data: customers }, { data: dutiesTaxes }] = await Promise.all([
    supabase.from('stock_items').select('*').eq('company_id', companyId),
    supabase.from('customer_ledger_preferences').select('*').eq('company_id', companyId),
    supabase.from('duties_taxes').select('*').eq('company_id', companyId),
  ]);

  console.log(`Loaded: ${stockItems?.length ?? 0} stock items, ${customers?.length ?? 0} customers, ${dutiesTaxes?.length ?? 0} duties/taxes`);

  for (const inv of invoices) {
    await traceInvoice(inv, stockItems ?? [], customers ?? [], dutiesTaxes ?? []);
  }
}

main().catch(console.error);
