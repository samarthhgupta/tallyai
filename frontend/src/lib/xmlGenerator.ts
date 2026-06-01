// Tally XML Generator — Purchase Voucher Import
//
// CRITICAL RULES:
//   1. ALL ledger names used in output are taken VERBATIM from master tables — no trim, no change.
//   2. Dates output as YYYYMMDD (Tally format).
//   3. Amounts output with 2 decimal places, negative for credit entries.
//   4. If a required ledger cannot be resolved, that invoice is skipped and an error is returned.

import type { StoredInvoice } from '@/types/invoice';
import type { SupplierMaster } from './suppliers';
import type { DutiesTaxesMaster } from './dutiesTaxes';
import type { StockItemMaster } from './stockItems';
import type { ExpenseLedgerMaster } from './expenseLedgers';
import { buildHsnSummary } from '@/types/invoice';

export interface XmlGeneratorInput {
  invoices: StoredInvoice[];
  suppliers: SupplierMaster[];
  dutiesTaxes: DutiesTaxesMaster[];
  stockItems: StockItemMaster[];
  expenseLedgers: ExpenseLedgerMaster[];
  purchaseLedgers: PurchaseLedgerEntry[];  // maps gst_percent → purchase ledger name
  tallyCompanyName: string;                // sacred — used verbatim in XML header
}

// Maps a GST rate (e.g. 18) to the Tally purchase ledger name for that rate.
// Rate 0 / null covers non-GST or exempt purchases.
export interface PurchaseLedgerEntry {
  gst_percent: number | null;   // null = consolidated / catch-all
  tally_ledger_name: string;    // sacred
}

export interface XmlGeneratorResult {
  xml: string;
  includedCount: number;
  skippedInvoices: Array<{ invoice_number: string; reason: string }>;
  warnings: Array<{ invoice_number: string; warning: string }>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt2(n: number): string {
  return n.toFixed(2);
}

function tallyDate(iso: string): string {
  // iso: YYYY-MM-DD or DD/MM/YYYY or YYYYMMDD
  if (/^\d{8}$/.test(iso)) return iso;
  if (/^\d{4}-\d{2}-\d{2}/.test(iso)) {
    return iso.slice(0, 10).replace(/-/g, '');
  }
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(iso)) {
    const [d, m, y] = iso.split('/');
    return `${y}${m}${d}`;
  }
  return iso.replace(/[-/]/g, '').slice(0, 8);
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function norm(s: string): string {
  return (s ?? '').toLowerCase().trim();
}

// ─── Master lookups (in-memory, no async) ────────────────────────────────────

function findSupplier(suppliers: SupplierMaster[], gstin: string | null, vendorName: string): SupplierMaster | null {
  if (gstin) {
    const g = norm(gstin);
    const byGstin = suppliers.find((s) => norm(s.vendor_gstin ?? '') === g);
    if (byGstin) return byGstin;
  }
  // fallback: match by normalised vendor name
  const vn = norm(vendorName);
  return suppliers.find((s) => norm(s.vendor_name) === vn || norm(s.tally_ledger_name) === vn) ?? null;
}

function findTaxLedger(
  dutiesTaxes: DutiesTaxesMaster[],
  component: string,
  rate: number,
): string | null {
  const comp = component.toUpperCase();
  // rate-specific first
  const specific = dutiesTaxes.find((d) => d.tax_component === comp && d.tax_rate === rate);
  if (specific) return specific.tally_ledger_name;
  // consolidated fallback
  const consolidated = dutiesTaxes.find((d) => d.tax_component === comp && d.tax_rate == null);
  return consolidated?.tally_ledger_name ?? null;
}

function findPurchaseLedger(purchaseLedgers: PurchaseLedgerEntry[], gst_percent: number): string | null {
  const specific = purchaseLedgers.find((p) => p.gst_percent === gst_percent);
  if (specific) return specific.tally_ledger_name;
  const fallback = purchaseLedgers.find((p) => p.gst_percent == null);
  return fallback?.tally_ledger_name ?? null;
}

function findExpenseLedger(expenseLedgers: ExpenseLedgerMaster[], description: string): string | null {
  const q = norm(description);
  const byKeyword = expenseLedgers.find(
    (l) => l.expense_keyword && norm(l.expense_keyword) === q,
  );
  if (byKeyword) return byKeyword.tally_ledger_name;
  const partial = expenseLedgers.find(
    (l) => l.expense_keyword && (q.includes(norm(l.expense_keyword)) || norm(l.expense_keyword).includes(q)),
  );
  if (partial) return partial.tally_ledger_name;
  const byName = expenseLedgers.find((l) => norm(l.tally_ledger_name) === q);
  return byName?.tally_ledger_name ?? null;
}

// ─── Single voucher builder ───────────────────────────────────────────────────

interface VoucherResult {
  xml: string | null;
  skip?: string;
  warnings: string[];
}

function buildVoucher(
  inv: StoredInvoice,
  input: XmlGeneratorInput,
): VoucherResult {
  const warnings: string[] = [];

  // 1. Supplier
  const supplier = findSupplier(input.suppliers, inv.vendor_gstin, inv.vendor_name);
  if (!supplier) {
    return { xml: null, skip: `Supplier not found in master for "${inv.vendor_name}"`, warnings };
  }
  const partyLedger = supplier.tally_ledger_name; // sacred

  // 2. HSN summary for purchase + tax ledger rows
  const hsnRows = buildHsnSummary(inv.line_items, inv.tax_type, inv.bill_discount_amount ?? 0);

  // 3. Build ALLLEDGERENTRIES.LIST blocks
  const entries: string[] = [];

  // 3a. Party (credit — negative)
  entries.push(`
      <ALLLEDGERENTRIES.LIST>
        <LEDGERNAME>${esc(partyLedger)}</LEDGERNAME>
        <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
        <AMOUNT>${fmt2(-inv.total)}</AMOUNT>
      </ALLLEDGERENTRIES.LIST>`);

  // 3b. Purchase ledger per HSN row (debit — positive)
  for (const row of hsnRows) {
    const purchaseLedger = findPurchaseLedger(input.purchaseLedgers, row.gst_percent);
    if (!purchaseLedger) {
      warnings.push(`No purchase ledger mapped for GST rate ${row.gst_percent}% — using first available or skipping`);
      // still try catch-all
      const catchAll = input.purchaseLedgers[0]?.tally_ledger_name;
      if (!catchAll) {
        return { xml: null, skip: `No purchase ledger configured for rate ${row.gst_percent}%`, warnings };
      }
      entries.push(`
      <ALLLEDGERENTRIES.LIST>
        <LEDGERNAME>${esc(catchAll)}</LEDGERNAME>
        <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
        <AMOUNT>${fmt2(row.taxable)}</AMOUNT>
      </ALLLEDGERENTRIES.LIST>`);
    } else {
      entries.push(`
      <ALLLEDGERENTRIES.LIST>
        <LEDGERNAME>${esc(purchaseLedger)}</LEDGERNAME>
        <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
        <AMOUNT>${fmt2(row.taxable)}</AMOUNT>
      </ALLLEDGERENTRIES.LIST>`);
    }
  }

  // 3c. Tax entries
  if (inv.tax_type === 'cgst_sgst') {
    // CGST
    const cgstTotal = hsnRows.reduce((s, r) => s + r.cgst, 0);
    if (cgstTotal > 0) {
      // find rate for first hsn row (all same rate in most cases)
      const cgstRate = hsnRows[0]?.gst_percent ? hsnRows[0].gst_percent / 2 : null;
      const cgstLedger = findTaxLedger(input.dutiesTaxes, 'CGST', cgstRate ?? 0);
      if (!cgstLedger) {
        return { xml: null, skip: 'No CGST ledger configured in Duties & Taxes master', warnings };
      }
      entries.push(`
      <ALLLEDGERENTRIES.LIST>
        <LEDGERNAME>${esc(cgstLedger)}</LEDGERNAME>
        <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
        <AMOUNT>${fmt2(cgstTotal)}</AMOUNT>
      </ALLLEDGERENTRIES.LIST>`);
    }
    // SGST
    const sgstTotal = hsnRows.reduce((s, r) => s + r.sgst, 0);
    if (sgstTotal > 0) {
      const sgstRate = hsnRows[0]?.gst_percent ? hsnRows[0].gst_percent / 2 : null;
      const sgstLedger = findTaxLedger(input.dutiesTaxes, 'SGST', sgstRate ?? 0);
      if (!sgstLedger) {
        return { xml: null, skip: 'No SGST ledger configured in Duties & Taxes master', warnings };
      }
      entries.push(`
      <ALLLEDGERENTRIES.LIST>
        <LEDGERNAME>${esc(sgstLedger)}</LEDGERNAME>
        <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
        <AMOUNT>${fmt2(sgstTotal)}</AMOUNT>
      </ALLLEDGERENTRIES.LIST>`);
    }
  } else {
    // IGST
    const igstTotal = hsnRows.reduce((s, r) => s + r.igst, 0);
    if (igstTotal > 0) {
      const igstRate = hsnRows[0]?.gst_percent ?? null;
      const igstLedger = findTaxLedger(input.dutiesTaxes, 'IGST', igstRate ?? 0);
      if (!igstLedger) {
        return { xml: null, skip: 'No IGST ledger configured in Duties & Taxes master', warnings };
      }
      entries.push(`
      <ALLLEDGERENTRIES.LIST>
        <LEDGERNAME>${esc(igstLedger)}</LEDGERNAME>
        <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
        <AMOUNT>${fmt2(igstTotal)}</AMOUNT>
      </ALLLEDGERENTRIES.LIST>`);
    }
  }

  // 3d. Extra charges (freight, courier, etc.)
  if (inv.charges && inv.charges.length > 0) {
    for (const charge of inv.charges) {
      if (!charge.amount || charge.amount === 0) continue;
      const expLedger = findExpenseLedger(input.expenseLedgers, charge.description);
      if (!expLedger) {
        warnings.push(`No expense ledger mapped for charge "${charge.description}" — charge excluded from XML`);
        continue;
      }
      entries.push(`
      <ALLLEDGERENTRIES.LIST>
        <LEDGERNAME>${esc(expLedger)}</LEDGERNAME>
        <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
        <AMOUNT>${fmt2(charge.amount)}</AMOUNT>
      </ALLLEDGERENTRIES.LIST>`);
    }
  }

  // 3e. Round off (if non-zero)
  if (inv.round_off && Math.abs(inv.round_off) > 0.001) {
    const roundLedger = findExpenseLedger(input.expenseLedgers, 'Round Off') ??
                        findExpenseLedger(input.expenseLedgers, 'Rounding Off') ??
                        null;
    if (roundLedger) {
      entries.push(`
      <ALLLEDGERENTRIES.LIST>
        <LEDGERNAME>${esc(roundLedger)}</LEDGERNAME>
        <ISDEEMEDPOSITIVE>${inv.round_off > 0 ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>
        <AMOUNT>${fmt2(inv.round_off)}</AMOUNT>
      </ALLLEDGERENTRIES.LIST>`);
    }
    // Round off with no ledger is allowed — Tally auto-balances
  }

  const dateStr = tallyDate(inv.invoice_date);
  const narration = `${esc(inv.vendor_name)} | ${esc(inv.invoice_number)} | ${inv.invoice_date}`;

  const voucherXml = `
    <TALLYMESSAGE xmlns:UDF="TallyUDF">
      <VOUCHER VCHTYPE="Purchase" ACTION="Create" OBJVIEW="Invoice Voucher View">
        <DATE>${dateStr}</DATE>
        <VOUCHERTYPENAME>Purchase</VOUCHERTYPENAME>
        <PARTYLEDGERNAME>${esc(partyLedger)}</PARTYLEDGERNAME>
        <VOUCHERNUMBER>${esc(inv.invoice_number)}</VOUCHERNUMBER>
        <NARRATION>${narration}</NARRATION>${entries.join('')}
      </VOUCHER>
    </TALLYMESSAGE>`;

  return { xml: voucherXml, warnings };
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export function generateTallyXml(input: XmlGeneratorInput): XmlGeneratorResult {
  const skipped: XmlGeneratorResult['skippedInvoices'] = [];
  const allWarnings: XmlGeneratorResult['warnings'] = [];
  const voucherBlocks: string[] = [];

  for (const inv of input.invoices) {
    const result = buildVoucher(inv, input);
    if (result.warnings.length > 0) {
      result.warnings.forEach((w) =>
        allWarnings.push({ invoice_number: inv.invoice_number, warning: w }),
      );
    }
    if (!result.xml || result.skip) {
      skipped.push({ invoice_number: inv.invoice_number, reason: result.skip ?? 'Unknown error' });
    } else {
      voucherBlocks.push(result.xml);
    }
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Import Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Vouchers</REPORTNAME>
        <STATICVARIABLES>
          <SVCURRENTCOMPANY>${esc(input.tallyCompanyName)}</SVCURRENTCOMPANY>
        </STATICVARIABLES>
      </REQUESTDESC>
      <REQUESTDATA>${voucherBlocks.join('')}
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;

  return {
    xml,
    includedCount: voucherBlocks.length,
    skippedInvoices: skipped,
    warnings: allWarnings,
  };
}
