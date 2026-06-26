/**
 * Pure-logic validator trace — no database needed.
 * Tests all plausible invoice shapes that could produce "Debit X, Credit 0"
 * and proves which scenario matches the 14 failing vouchers.
 *
 *   node frontend/trace_validator_logic.mjs
 */

// ─── Replicated helpers ───────────────────────────────────────────────────────

const r2 = (n) => Math.round(n * 100) / 100;
function fmt2(n) { return n.toFixed(2); }

function calcLineAmount(item) {
  const disc = item.disc_percent ?? 0;
  return r2((item.qty ?? 0) * (item.rate ?? 0) * (1 - disc / 100));
}

// ─── Replica of invSalesLedgerEntry ──────────────────────────────────────────

function invSalesLedgerEntry(opts) {
  const rateBlock = opts.rateOfInvoiceTax != null
    ? `\n        <RATEOFINVOICETAX.LIST TYPE="Number">\n          <RATEOFINVOICETAX> ${opts.rateOfInvoiceTax}</RATEOFINVOICETAX>\n        </RATEOFINVOICETAX.LIST>`
    : '';
  const billAlloc = opts.billRefName
    ? `\n        <BILLALLOCATIONS.LIST>\n          <NAME>${opts.billRefName}</NAME>\n          <BILLTYPE>New Ref</BILLTYPE>\n          <TDSDEDUCTEEISSPECIALRATE>No</TDSDEDUCTEEISSPECIALRATE>\n          <AMOUNT>${fmt2(opts.amount)}</AMOUNT>\n          <INTERESTCOLLECTION.LIST> </INTERESTCOLLECTION.LIST>\n        </BILLALLOCATIONS.LIST>`
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

function invSalesIncomeLedgerEntry(ledgerName, amount) {
  return (
    `\n      <LEDGERENTRIES.LIST>` +
    `\n        <LEDGERNAME>${ledgerName}</LEDGERNAME>` +
    `\n        <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>` +
    `\n        <ISPARTYLEDGER>No</ISPARTYLEDGER>` +
    `\n        <ISLASTDEEMEDPOSITIVE>No</ISLASTDEEMEDPOSITIVE>` +
    `\n        <AMOUNT>${fmt2(amount)}</AMOUNT>` +
    `\n        <BILLALLOCATIONS.LIST> </BILLALLOCATIONS.LIST>` +
    `\n      </LEDGERENTRIES.LIST>`
  );
}

function buildSalesAllInventoryEntry(itemName, posAmt) {
  return (
    `\n      <ALLINVENTORYENTRIES.LIST>` +
    `\n        <STOCKITEMNAME>${itemName}</STOCKITEMNAME>` +
    `\n        <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>` +
    `\n        <ISLASTDEEMEDPOSITIVE>No</ISLASTDEEMEDPOSITIVE>` +
    `\n        <AMOUNT>${fmt2(posAmt)}</AMOUNT>` +
    `\n        <BATCHALLOCATIONS.LIST>` +
    `\n          <AMOUNT>${fmt2(posAmt)}</AMOUNT>` +
    `\n        </BATCHALLOCATIONS.LIST>` +
    `\n        <ACCOUNTINGALLOCATIONS.LIST>` +
    `\n          <LEDGERNAME>GST SALE</LEDGERNAME>` +
    `\n          <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>` +
    `\n          <AMOUNT>${fmt2(posAmt)}</AMOUNT>` +
    `\n        </ACCOUNTINGALLOCATIONS.LIST>` +
    `\n      </ALLINVENTORYENTRIES.LIST>`
  );
}

// ─── Replica of the NEW validator (from commit 71c341d) ──────────────────────

function parseEmittedAmount(xml) {
  return parseFloat(xml.match(/<AMOUNT>([^<]*)<\/AMOUNT>/)?.[1] ?? '0');
}

function parseEmittedIsDeemedPositive(xml) {
  return xml.match(/<ISDEEMEDPOSITIVE>([^<]*)<\/ISDEEMEDPOSITIVE>/)?.[1] ?? 'No';
}

function runNewValidator(label, ledgerEntries, invEntries) {
  let emittedDebitSum = 0;
  let emittedCreditSum = 0;

  const rows = [];

  for (const entry of ledgerEntries) {
    const amt = parseEmittedAmount(entry);
    const idp = parseEmittedIsDeemedPositive(entry);
    const name = entry.match(/<LEDGERNAME>([^<]*)<\/LEDGERNAME>/)?.[1] ?? '?';
    const isDebit = idp === 'Yes';
    if (isDebit) emittedDebitSum += Math.abs(amt);
    else emittedCreditSum += Math.abs(amt);
    rows.push({ source: 'LEDGER', name, amt, idp, classification: isDebit ? 'DEBIT' : 'CREDIT', contribution: isDebit ? Math.abs(amt) : Math.abs(amt) });
  }

  for (const entry of invEntries) {
    const amt = parseEmittedAmount(entry);
    const name = entry.match(/<STOCKITEMNAME>([^<]*)<\/STOCKITEMNAME>/)?.[1] ?? '?';
    const isDebit = amt < 0;
    if (isDebit) emittedDebitSum += Math.abs(amt);
    else emittedCreditSum += amt;
    rows.push({ source: 'INVENTORY', name, amt, idp: 'N/A', classification: isDebit ? 'DEBIT' : 'CREDIT', contribution: Math.abs(amt) });
  }

  console.log(`\n  ── Step 3: Validator Parsing (${label}) ─────────────`);
  for (const r of rows) {
    console.log(`    [${r.source}] "${r.name}"`);
    console.log(`      Amount Parsed      : ${r.amt}`);
    console.log(`      ISDEEMEDPOSITIVE   : ${r.idp}`);
    console.log(`      → ${r.classification.padEnd(6)} ${r.contribution.toFixed(2)}`);
  }

  console.log(`\n  ── Step 4: Totals ──────────────────────────────────`);
  console.log(`    Debit  Total : ${emittedDebitSum.toFixed(2)}`);
  console.log(`    Credit Total : ${emittedCreditSum.toFixed(2)}`);
  console.log(`    Difference   : ${Math.abs(emittedDebitSum - emittedCreditSum).toFixed(2)}`);
  const imbalance = Math.abs(emittedDebitSum - emittedCreditSum);
  if (imbalance > 0.01) {
    console.log(`    ❌ VALIDATOR WOULD SKIP (imbalance ₹${imbalance.toFixed(2)})`);
  } else {
    console.log(`    ✅ VALIDATOR PASSES`);
  }
  return { emittedDebitSum, emittedCreditSum };
}

// ─── Scenario builder ─────────────────────────────────────────────────────────

function buildAndTrace(label, inv) {
  console.log('\n\n╔══════════════════════════════════════════════════════════════╗');
  console.log(`║  ${label.padEnd(62)}║`);
  console.log('╚══════════════════════════════════════════════════════════════╝');

  const total = inv.total_amount ?? 0;
  const taxType = inv.tax_type ?? 'cgst_sgst';
  const items = inv.line_items ?? [];
  const partyLedger = 'B2C Debtors';
  const salesLedger = 'GST SALE';

  // Derive financials
  let net_goods_taxable = 0;
  let cgst = 0, sgst = 0, igst = 0;
  for (const item of items) {
    const lineAmt = calcLineAmount(item);
    const gst = item.gst_percent ?? 0;
    net_goods_taxable += lineAmt;
    const taxable = r2(lineAmt);
    if (gst > 0) {
      if (taxType === 'cgst_sgst') { cgst += r2(taxable * gst / 2 / 100); sgst += r2(taxable * gst / 2 / 100); }
      else { igst += r2(taxable * gst / 100); }
    }
  }
  cgst = r2(cgst); sgst = r2(sgst); igst = r2(igst);
  const total_gst = cgst + sgst + igst;
  const round_off = r2(total - net_goods_taxable - total_gst);

  console.log(`\n  ── Invoice Financials ──────────────────────────────`);
  console.log(`    inv.total_amount      : ${total}`);
  console.log(`    d.total              : ${total}`);
  console.log(`    d.cgst               : ${cgst}`);
  console.log(`    d.sgst               : ${sgst}`);
  console.log(`    d.igst               : ${igst}`);
  console.log(`    d.net_goods_taxable  : ${net_goods_taxable}`);
  console.log(`    d.round_off          : ${round_off}`);

  // Build ledger and inventory entries
  const ledgerEntries = [];
  const invEntries = [];

  // Step 1: Customer entry
  const custEntry = invSalesLedgerEntry({
    ledgerName: partyLedger,
    isdeemedpositive: 'Yes',
    isPartyledger: 'Yes',
    islastdeemedpositive: 'Yes',
    amount: -total,
    billRefName: inv.invoice_number,
  });
  ledgerEntries.push(custEntry);

  console.log(`\n  ── Step 1: ledgerEntries ──────────────────────────`);
  console.log(`    [1] "${partyLedger}"  amount=${-total}  idp=Yes`);

  // Step 1b: GST entries
  const taxBase = net_goods_taxable;
  const absTaxBase = Math.abs(taxBase);
  const roundHalf = (r) => Math.round(r * 2) / 2;

  if (Math.abs(cgst) > 0.001) {
    const rate = absTaxBase > 0.001 ? roundHalf((Math.abs(cgst) / absTaxBase) * 100) : 0;
    const isDebit = cgst < 0;
    const e = invSalesLedgerEntry({ ledgerName: 'Output CGST', isdeemedpositive: isDebit ? 'Yes' : 'No', isPartyledger: 'No', islastdeemedpositive: isDebit ? 'Yes' : 'No', amount: cgst, rateOfInvoiceTax: rate || undefined });
    ledgerEntries.push(e);
    console.log(`    [${ledgerEntries.length}] "Output CGST"  amount=${cgst}  idp=${isDebit ? 'Yes (debit)' : 'No (credit)'}  rate=${rate}%`);
  } else {
    console.log(`    CGST skipped: Math.abs(${cgst}) <= 0.001`);
  }
  if (Math.abs(sgst) > 0.001) {
    const rate = absTaxBase > 0.001 ? roundHalf((Math.abs(sgst) / absTaxBase) * 100) : 0;
    const isDebit = sgst < 0;
    const e = invSalesLedgerEntry({ ledgerName: 'Output SGST', isdeemedpositive: isDebit ? 'Yes' : 'No', isPartyledger: 'No', islastdeemedpositive: isDebit ? 'Yes' : 'No', amount: sgst, rateOfInvoiceTax: rate || undefined });
    ledgerEntries.push(e);
    console.log(`    [${ledgerEntries.length}] "Output SGST"  amount=${sgst}  idp=${isDebit ? 'Yes (debit)' : 'No (credit)'}  rate=${rate}%`);
  } else {
    console.log(`    SGST skipped: Math.abs(${sgst}) <= 0.001`);
  }
  if (Math.abs(igst) > 0.001) {
    const rate = absTaxBase > 0.001 ? roundHalf((Math.abs(igst) / absTaxBase) * 100) : 0;
    const isDebit = igst < 0;
    const e = invSalesLedgerEntry({ ledgerName: 'Output IGST', isdeemedpositive: isDebit ? 'Yes' : 'No', isPartyledger: 'No', islastdeemedpositive: isDebit ? 'Yes' : 'No', amount: igst, rateOfInvoiceTax: rate || undefined });
    ledgerEntries.push(e);
    console.log(`    [${ledgerEntries.length}] "Output IGST"  amount=${igst}  idp=${isDebit ? 'Yes (debit)' : 'No (credit)'}  rate=${rate}%`);
  }

  // Step 2: Inventory entries
  let totalItemsAmount = 0;
  console.log(`\n  ── Step 2: invEntries ─────────────────────────────`);
  for (const item of items) {
    const posAmt = calcLineAmount(item);
    totalItemsAmount += posAmt;
    const e = buildSalesAllInventoryEntry(item.description ?? 'Item', posAmt);
    invEntries.push(e);
    console.log(`    "${item.description}"  qty=${item.qty}  rate=${item.rate}  gst=${item.gst_percent ?? 0}%  calcLineAmount=${posAmt}`);
  }

  // Gap formula + sales ledger entry
  const taxes = cgst + sgst + igst;
  const totalCreditSide = totalItemsAmount + taxes;
  const totalDebitSide = total;
  const gap = parseFloat((totalDebitSide - totalCreditSide).toFixed(2));
  const netSalesLedgerAdj = gap;

  console.log(`\n    Gap formula:`);
  console.log(`      totalItemsAmount  : ${totalItemsAmount}`);
  console.log(`      taxes             : ${taxes}`);
  console.log(`      totalCreditSide   : ${totalCreditSide}`);
  console.log(`      totalDebitSide    : ${totalDebitSide}`);
  console.log(`      gap               : ${gap}`);
  console.log(`      netSalesLedgerAdj : ${netSalesLedgerAdj}`);

  if (Math.abs(netSalesLedgerAdj) > 0.01) {
    if (netSalesLedgerAdj > 0) {
      const e = invSalesIncomeLedgerEntry(salesLedger, netSalesLedgerAdj);
      ledgerEntries.push(e);
      console.log(`    [${ledgerEntries.length}] "${salesLedger}" CREDIT  amount=${netSalesLedgerAdj}  idp=No`);
    } else {
      const e = invSalesLedgerEntry({ ledgerName: salesLedger, isdeemedpositive: 'Yes', isPartyledger: 'No', islastdeemedpositive: 'Yes', amount: -Math.abs(netSalesLedgerAdj) });
      ledgerEntries.push(e);
      console.log(`    [${ledgerEntries.length}] "${salesLedger}" DEBIT  amount=${-Math.abs(netSalesLedgerAdj)}  idp=Yes`);
    }
  } else {
    console.log(`    No sales ledger entry (netSalesLedgerAdj=${netSalesLedgerAdj} too small)`);
  }

  // Run validator
  const { emittedDebitSum, emittedCreditSum } = runNewValidator(label, ledgerEntries, invEntries);

  // Answer the key question
  console.log(`\n  ── ROOT CAUSE ANSWER ───────────────────────────────`);
  if (emittedCreditSum < 0.01 && emittedDebitSum > 0.01) {
    console.log(`    THIS SCENARIO MATCHES "Debit X, Credit 0" PATTERN`);
    // Check if it's validator bug or builder bug
    // Builder check: are there entries with positive amount and idp='No'?
    let hasPositiveCreditEntry = false;
    for (const e of ledgerEntries) {
      const amt = parseEmittedAmount(e);
      const idp = parseEmittedIsDeemedPositive(e);
      if (idp === 'No' && amt > 0.001) { hasPositiveCreditEntry = true; break; }
    }
    for (const e of invEntries) {
      const amt = parseEmittedAmount(e);
      if (amt > 0.001) { hasPositiveCreditEntry = true; break; }
    }
    if (hasPositiveCreditEntry) {
      console.log(`    CONCLUSION → Case B: VALIDATOR BUG`);
      console.log(`    The builder emitted credit entries with positive amounts,`);
      console.log(`    but the validator classified them as DEBIT due to wrong IDP logic.`);
    } else {
      console.log(`    CONCLUSION → Case A: BUILDER BUG`);
      console.log(`    The builder emitted no positive credit-side entries.`);
    }
  } else {
    console.log(`    This scenario does NOT produce "Debit X, Credit 0".`);
    console.log(`    Debit=${emittedDebitSum.toFixed(2)}, Credit=${emittedCreditSum.toFixed(2)}`);
  }
}

// ─── SCENARIO 1: Normal sale (should pass) ────────────────────────────────────
buildAndTrace('SCENARIO 1: Normal sale — 1 item @5% GST', {
  invoice_number: 'TEST001',
  total_amount: 80.00,
  tax_type: 'cgst_sgst',
  line_items: [
    { description: 'Fabric A', qty: 5, rate: 15.24, gst_percent: 5, disc_percent: 0 },
  ],
});

// ─── SCENARIO 2: Pure credit note (all returns, d.total < 0) ─────────────────
buildAndTrace('SCENARIO 2: Pure credit note — all items are returns (d.total < 0)', {
  invoice_number: 'TEST002',
  total_amount: -80.00,
  tax_type: 'cgst_sgst',
  line_items: [
    { description: 'Fabric A', qty: -5, rate: 15.24, gst_percent: 5, disc_percent: 0 },
  ],
});

// ─── SCENARIO 3: Mixed invoice (some positive, some negative) ─────────────────
buildAndTrace('SCENARIO 3: Mixed invoice — returns > sales (d.total < 0)', {
  invoice_number: 'TEST003',
  total_amount: -80.00,
  tax_type: 'cgst_sgst',
  line_items: [
    { description: 'Fabric A', qty: 3,  rate: 15.24, gst_percent: 5, disc_percent: 0 },
    { description: 'Fabric B', qty: -8, rate: 15.24, gst_percent: 5, disc_percent: 0 },
  ],
});

// ─── SCENARIO 4: Zero-GST pure credit note ────────────────────────────────────
buildAndTrace('SCENARIO 4: Zero-GST pure credit note (exempt items)', {
  invoice_number: 'TEST004',
  total_amount: -80.00,
  tax_type: 'cgst_sgst',
  line_items: [
    { description: 'Exempt Fabric', qty: -5, rate: 16.00, gst_percent: 0, disc_percent: 0 },
  ],
});

// ─── SCENARIO 5: Credit note with d.total positive but all items negative ─────
buildAndTrace('SCENARIO 5: DB stores total_amount as POSITIVE but all items are returns', {
  invoice_number: 'TEST005',
  total_amount: 80.00,
  tax_type: 'cgst_sgst',
  line_items: [
    { description: 'Fabric A', qty: -5, rate: 15.24, gst_percent: 5, disc_percent: 0 },
  ],
});

// ─── SCENARIO 6: What invSalesIncomeLedgerEntry exactly produces ──────────────
console.log('\n\n╔══════════════════════════════════════════════════════════════╗');
console.log('║  REGEX VERIFICATION — Raw XML output of each entry type      ║');
console.log('╚══════════════════════════════════════════════════════════════╝');

const testEntries = {
  'Customer (normal sale)': invSalesLedgerEntry({ ledgerName: 'B2C Debtors', isdeemedpositive: 'Yes', isPartyledger: 'Yes', islastdeemedpositive: 'Yes', amount: -80.00, billRefName: 'KKE001' }),
  'Customer (credit note d.total<0)': invSalesLedgerEntry({ ledgerName: 'B2C Debtors', isdeemedpositive: 'Yes', isPartyledger: 'Yes', islastdeemedpositive: 'Yes', amount: 80.00, billRefName: 'KKE002' }),
  'CGST credit (normal)': invSalesLedgerEntry({ ledgerName: 'Output CGST', isdeemedpositive: 'No', isPartyledger: 'No', islastdeemedpositive: 'No', amount: 3.81, rateOfInvoiceTax: 2.5 }),
  'CGST debit (credit note)': invSalesLedgerEntry({ ledgerName: 'Output CGST', isdeemedpositive: 'Yes', isPartyledger: 'No', islastdeemedpositive: 'Yes', amount: -3.81, rateOfInvoiceTax: 2.5 }),
  'Sales ledger credit': invSalesIncomeLedgerEntry('GST SALE', 72.38),
  'Inventory item positive': buildSalesAllInventoryEntry('Fabric 63041910', 72.38),
  'Inventory item negative (return)': buildSalesAllInventoryEntry('Fabric 63041990', -72.38),
};

for (const [name, xml] of Object.entries(testEntries)) {
  const amt = parseEmittedAmount(xml);
  const idp = parseEmittedIsDeemedPositive(xml);
  const isDebitByIDP = idp === 'Yes';
  const isDebitBySign = amt < 0;
  console.log(`\n  "${name}"`);
  console.log(`    Parsed AMOUNT          : ${amt}`);
  console.log(`    Parsed ISDEEMEDPOSITIVE: ${idp}`);
  console.log(`    Validator says (IDP)   : ${isDebitByIDP ? 'DEBIT' : 'CREDIT'} (contribution ${Math.abs(amt).toFixed(2)})`);
  console.log(`    Sign-only says         : ${isDebitBySign ? 'DEBIT' : 'CREDIT'} (contribution ${Math.abs(amt).toFixed(2)})`);
  if (isDebitByIDP !== isDebitBySign) {
    console.log(`    ⚠️  IDP and SIGN DISAGREE — IDP=${isDebitByIDP?'DEBIT':'CREDIT'}, SIGN=${isDebitBySign?'DEBIT':'CREDIT'}`);
  }
}

console.log('\n\nDone.\n');
