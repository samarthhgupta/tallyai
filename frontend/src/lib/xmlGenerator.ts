// Tally XML Generator — Purchase Voucher Import
//
// CRITICAL RULES:
//   1. ALL ledger/item names used in output are taken VERBATIM from master tables — no trim, no change.
//   2. Dates output as YYYYMMDD (Tally format).
//   3. Amounts output with 2 decimal places, negative for credit entries.
//   4. If a required ledger cannot be resolved, that invoice is skipped and an error is returned.
//   5. Additional charges (freight, etc.) = always separate expense ledger entries (never capitalized).
//   6. Bill-level discounts = separate P&L entry (if discount_ledger_name set); never apportioned to items.
//   7. Item-level disc_percent flows as DISCOUNT in INVENTORYENTRIES.LIST (inventory mode only).

import type { StoredInvoice, LineItem } from '@/types/invoice';
import type { SupplierMaster } from './suppliers';
import type { DutiesTaxesMaster } from './dutiesTaxes';
import type { StockItemMaster } from './stockItems';
import type { ExpenseLedgerMaster } from './expenseLedgers';
import type { VoucherTypeMaster } from './voucherTypes';
import { resolveVoucherType } from './voucherTypes';
import { calcLineAmount } from '@/types/invoice';

export interface XmlGeneratorInput {
  invoices: StoredInvoice[];
  suppliers: SupplierMaster[];
  dutiesTaxes: DutiesTaxesMaster[];
  stockItems: StockItemMaster[];
  expenseLedgers: ExpenseLedgerMaster[];
  purchaseLedgers: PurchaseLedgerEntry[];   // maps gst_percent → purchase ledger name
  voucherTypes: VoucherTypeMaster[];        // maps purchase category → voucher type name
  tallyCompanyName: string;                 // sacred — used verbatim in XML header
  voucherMode?: 'accounting_only' | 'inventory'; // default: accounting_only
  discountLedgerName?: string | null;       // Tally ledger for bill-level discounts (P&L)
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
  if (/^\d{8}$/.test(iso)) return iso;
  if (/^\d{4}-\d{2}-\d{2}/.test(iso)) return iso.slice(0, 10).replace(/-/g, '');
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

// Fuzzy word-overlap match — handles "SAVIK AGENCIES - (2022 Onwards)" vs "Savik Agencies"
function fuzzyNameMatch(a: string, b: string): boolean {
  const na = norm(a);
  const nb = norm(b);
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  // Word overlap: strip punctuation, check if significant words overlap
  const words = (s: string) =>
    s.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2);
  const wa = words(na);
  const wb = words(nb);
  if (!wa.length || !wb.length) return false;
  const shorter = wa.length <= wb.length ? wa : wb;
  const longer  = wa.length <= wb.length ? wb : wa;
  const hits = shorter.filter((w) => longer.some((lw) => lw.includes(w) || w.includes(lw)));
  return hits.length / shorter.length >= 0.6;
}

// Best fuzzy supplier suggestion (for UI display when exact match fails)
export function suggestSupplier(suppliers: SupplierMaster[], gstin: string | null, vendorName: string): SupplierMaster | null {
  return suppliers.find((s) => fuzzyNameMatch(s.vendor_name, vendorName) || fuzzyNameMatch(s.tally_ledger_name, vendorName)) ?? null;
}

// Best fuzzy expense ledger suggestion
export function suggestExpenseLedger(expenseLedgers: ExpenseLedgerMaster[], description: string): ExpenseLedgerMaster | null {
  return expenseLedgers.find((l) =>
    (l.expense_keyword && fuzzyNameMatch(l.expense_keyword, description)) ||
    fuzzyNameMatch(l.tally_ledger_name, description)
  ) ?? null;
}

// Best fuzzy stock item suggestion
export function suggestStockItem(stockItems: StockItemMaster[], description: string): StockItemMaster | null {
  return stockItems.find((s) =>
    (s.alias_name && fuzzyNameMatch(s.alias_name, description)) ||
    fuzzyNameMatch(s.tally_item_name, description)
  ) ?? null;
}

// ─── Master lookups (in-memory, no async) ────────────────────────────────────

function findSupplier(suppliers: SupplierMaster[], gstin: string | null, vendorName: string): SupplierMaster | null {
  if (gstin) {
    const g = norm(gstin);
    const byGstin = suppliers.find((s) => norm(s.vendor_gstin ?? '') === g);
    if (byGstin) return byGstin;
  }
  // Exact name match
  const vn = norm(vendorName);
  const exact = suppliers.find((s) => norm(s.vendor_name) === vn || norm(s.tally_ledger_name) === vn);
  if (exact) return exact;
  // Fuzzy match — handles name variations like "SAVIK AGENCIES - (2022 Onwards)" vs "Savik Agencies"
  return suggestSupplier(suppliers, gstin, vendorName);
}

function findTaxLedger(dutiesTaxes: DutiesTaxesMaster[], component: string, rate: number): string | null {
  const comp = component.toUpperCase();
  const specific = dutiesTaxes.find((d) => d.tax_component === comp && d.tax_rate === rate);
  if (specific) return specific.tally_ledger_name;
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
  // Exact keyword
  const byKeyword = expenseLedgers.find((l) => l.expense_keyword && norm(l.expense_keyword) === q);
  if (byKeyword) return byKeyword.tally_ledger_name;
  // Partial keyword
  const partial = expenseLedgers.find(
    (l) => l.expense_keyword && (q.includes(norm(l.expense_keyword)) || norm(l.expense_keyword).includes(q)),
  );
  if (partial) return partial.tally_ledger_name;
  // Exact ledger name
  const byName = expenseLedgers.find((l) => norm(l.tally_ledger_name) === q);
  if (byName) return byName.tally_ledger_name;
  // Fuzzy match
  const fuzzy = suggestExpenseLedger(expenseLedgers, description);
  return fuzzy?.tally_ledger_name ?? null;
}

function findStockItem(stockItems: StockItemMaster[], description: string): StockItemMaster | null {
  const q = norm(description);
  const byAlias = stockItems.find((s) => s.alias_name && norm(s.alias_name) === q);
  if (byAlias) return byAlias;
  const byName = stockItems.find((s) => norm(s.tally_item_name) === q);
  if (byName) return byName;
  const partialAlias = stockItems.find(
    (s) => s.alias_name && (norm(s.alias_name).includes(q) || q.includes(norm(s.alias_name))),
  );
  if (partialAlias) return partialAlias;
  return suggestStockItem(stockItems, description);
}

// ─── HSN summary for accounting_only mode ────────────────────────────────────
// Bill discount is NOT apportioned here when a discount ledger is configured.
// If no discount_ledger_name, deduct proportionally so the voucher still balances.

interface HsnRow {
  hsn: string;
  gst_percent: number;
  taxable: number;
  cgst: number;
  sgst: number;
  igst: number;
}

function buildHsnRows(
  items: LineItem[],
  taxType: 'cgst_sgst' | 'igst',
  billDiscount: number,
  hasDiscountLedger: boolean,
): HsnRow[] {
  const map: Record<string, HsnRow> = {};
  for (const item of items) {
    const hsn = (item.hsn || '').replace(/[\s.]/g, '') || '—';
    const key = `${hsn}__${item.gst_percent}`;
    if (!map[key]) map[key] = { hsn, gst_percent: item.gst_percent, taxable: 0, cgst: 0, sgst: 0, igst: 0 };
    map[key].taxable += calcLineAmount(item);
  }

  const rows = Object.values(map);
  const totalTaxable = rows.reduce((s, r) => s + r.taxable, 0);
  for (const row of rows) {
    if (!hasDiscountLedger && billDiscount > 0 && totalTaxable > 0) {
      row.taxable -= billDiscount * (row.taxable / totalTaxable);
    }
    const tax = row.taxable * row.gst_percent / 100;
    if (taxType === 'cgst_sgst') { row.cgst = tax / 2; row.sgst = tax / 2; }
    else { row.igst = tax; }
  }
  return rows;
}

// ─── Shared entry builders ────────────────────────────────────────────────────

function buildTaxEntriesFromHsn(
  inv: StoredInvoice,
  hsnRows: HsnRow[],
  dutiesTaxes: DutiesTaxesMaster[],
): { entries: string[]; skip?: string } {
  const entries: string[] = [];
  if (inv.tax_type === 'cgst_sgst') {
    const cgstTotal = hsnRows.reduce((s, r) => s + r.cgst, 0);
    if (cgstTotal > 0) {
      const rate = hsnRows[0]?.gst_percent ? hsnRows[0].gst_percent / 2 : 0;
      const ledger = findTaxLedger(dutiesTaxes, 'CGST', rate);
      if (!ledger) return { entries, skip: 'No CGST ledger configured in Duties & Taxes master' };
      entries.push(`\n      <ALLLEDGERENTRIES.LIST>\n        <LEDGERNAME>${esc(ledger)}</LEDGERNAME>\n        <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>\n        <AMOUNT>${fmt2(cgstTotal)}</AMOUNT>\n      </ALLLEDGERENTRIES.LIST>`);
    }
    const sgstTotal = hsnRows.reduce((s, r) => s + r.sgst, 0);
    if (sgstTotal > 0) {
      const rate = hsnRows[0]?.gst_percent ? hsnRows[0].gst_percent / 2 : 0;
      const ledger = findTaxLedger(dutiesTaxes, 'SGST', rate);
      if (!ledger) return { entries, skip: 'No SGST ledger configured in Duties & Taxes master' };
      entries.push(`\n      <ALLLEDGERENTRIES.LIST>\n        <LEDGERNAME>${esc(ledger)}</LEDGERNAME>\n        <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>\n        <AMOUNT>${fmt2(sgstTotal)}</AMOUNT>\n      </ALLLEDGERENTRIES.LIST>`);
    }
  } else {
    const igstTotal = hsnRows.reduce((s, r) => s + r.igst, 0);
    if (igstTotal > 0) {
      const rate = hsnRows[0]?.gst_percent ?? 0;
      const ledger = findTaxLedger(dutiesTaxes, 'IGST', rate);
      if (!ledger) return { entries, skip: 'No IGST ledger configured in Duties & Taxes master' };
      entries.push(`\n      <ALLLEDGERENTRIES.LIST>\n        <LEDGERNAME>${esc(ledger)}</LEDGERNAME>\n        <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>\n        <AMOUNT>${fmt2(igstTotal)}</AMOUNT>\n      </ALLLEDGERENTRIES.LIST>`);
    }
  }
  return { entries };
}

function buildTaxEntriesFromInvoiceTotals(
  inv: StoredInvoice,
  taxableAmount: number,
  dutiesTaxes: DutiesTaxesMaster[],
): { entries: string[]; skip?: string } {
  const entries: string[] = [];
  if (inv.tax_type === 'cgst_sgst') {
    if (inv.cgst > 0) {
      const rate = taxableAmount > 0 ? Math.round((inv.cgst / taxableAmount) * 100) : 0;
      const ledger = findTaxLedger(dutiesTaxes, 'CGST', rate) ?? findTaxLedger(dutiesTaxes, 'CGST', 0);
      if (!ledger) return { entries, skip: 'No CGST ledger configured in Duties & Taxes master' };
      entries.push(`\n      <ALLLEDGERENTRIES.LIST>\n        <LEDGERNAME>${esc(ledger)}</LEDGERNAME>\n        <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>\n        <AMOUNT>${fmt2(inv.cgst)}</AMOUNT>\n      </ALLLEDGERENTRIES.LIST>`);
    }
    if (inv.sgst > 0) {
      const rate = taxableAmount > 0 ? Math.round((inv.sgst / taxableAmount) * 100) : 0;
      const ledger = findTaxLedger(dutiesTaxes, 'SGST', rate) ?? findTaxLedger(dutiesTaxes, 'SGST', 0);
      if (!ledger) return { entries, skip: 'No SGST ledger configured in Duties & Taxes master' };
      entries.push(`\n      <ALLLEDGERENTRIES.LIST>\n        <LEDGERNAME>${esc(ledger)}</LEDGERNAME>\n        <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>\n        <AMOUNT>${fmt2(inv.sgst)}</AMOUNT>\n      </ALLLEDGERENTRIES.LIST>`);
    }
  } else if (inv.igst > 0) {
    const rate = taxableAmount > 0 ? Math.round((inv.igst / taxableAmount) * 100) : 0;
    const ledger = findTaxLedger(dutiesTaxes, 'IGST', rate) ?? findTaxLedger(dutiesTaxes, 'IGST', 0);
    if (!ledger) return { entries, skip: 'No IGST ledger configured in Duties & Taxes master' };
    entries.push(`\n      <ALLLEDGERENTRIES.LIST>\n        <LEDGERNAME>${esc(ledger)}</LEDGERNAME>\n        <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>\n        <AMOUNT>${fmt2(inv.igst)}</AMOUNT>\n      </ALLLEDGERENTRIES.LIST>`);
  }
  return { entries };
}

function buildChargeEntries(
  inv: StoredInvoice,
  expenseLedgers: ExpenseLedgerMaster[],
  warnings: string[],
): string[] {
  const entries: string[] = [];
  if (!inv.charges?.length) return entries;
  for (const charge of inv.charges) {
    if (!charge.amount || charge.amount === 0) continue;
    const ledger = findExpenseLedger(expenseLedgers, charge.description);
    if (!ledger) {
      warnings.push(`No expense ledger mapped for charge "${charge.description}" — charge excluded from XML`);
      continue;
    }
    entries.push(`\n      <ALLLEDGERENTRIES.LIST>\n        <LEDGERNAME>${esc(ledger)}</LEDGERNAME>\n        <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>\n        <AMOUNT>${fmt2(charge.amount)}</AMOUNT>\n      </ALLLEDGERENTRIES.LIST>`);
  }
  return entries;
}

function buildRoundOffEntry(inv: StoredInvoice, expenseLedgers: ExpenseLedgerMaster[]): string {
  if (!inv.round_off || Math.abs(inv.round_off) <= 0.001) return '';
  const ledger = findExpenseLedger(expenseLedgers, 'Round Off') ?? findExpenseLedger(expenseLedgers, 'Rounding Off');
  if (!ledger) return '';
  return `\n      <ALLLEDGERENTRIES.LIST>\n        <LEDGERNAME>${esc(ledger)}</LEDGERNAME>\n        <ISDEEMEDPOSITIVE>${inv.round_off > 0 ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>\n        <AMOUNT>${fmt2(inv.round_off)}</AMOUNT>\n      </ALLLEDGERENTRIES.LIST>`;
}

function wrapVoucher(inv: StoredInvoice, partyLedger: string, ledgerXml: string, inventoryXml: string, voucherTypeName: string): string {
  const narration = `${esc(inv.vendor_name)} | ${esc(inv.invoice_number)} | ${inv.invoice_date}`;
  return `
    <TALLYMESSAGE xmlns:UDF="TallyUDF">
      <VOUCHER VCHTYPE="${esc(voucherTypeName)}" ACTION="Create" OBJVIEW="Invoice Voucher View">
        <DATE>${tallyDate(inv.invoice_date)}</DATE>
        <VOUCHERTYPENAME>${esc(voucherTypeName)}</VOUCHERTYPENAME>
        <PARTYLEDGERNAME>${esc(partyLedger)}</PARTYLEDGERNAME>
        <VOUCHERNUMBER>${esc(inv.invoice_number)}</VOUCHERNUMBER>
        <NARRATION>${narration}</NARRATION>${inventoryXml}${ledgerXml}
      </VOUCHER>
    </TALLYMESSAGE>`;
}

// ─── Voucher builders ─────────────────────────────────────────────────────────

interface VoucherResult { xml: string | null; skip?: string; warnings: string[]; }

function buildAccountingOnlyVoucher(inv: StoredInvoice, input: XmlGeneratorInput): VoucherResult {
  const warnings: string[] = [];
  const supplier = findSupplier(input.suppliers, inv.vendor_gstin, inv.vendor_name);
  const partyLedger = supplier?.tally_ledger_name ?? inv.vendor_name;
  if (!supplier) warnings.push(`Supplier "${inv.vendor_name}" not in master — using vendor name as ledger`);
  const hasGst = (inv.cgst ?? 0) > 0 || (inv.sgst ?? 0) > 0 || (inv.igst ?? 0) > 0;
  const voucherTypeName = resolveVoucherType(input.voucherTypes ?? [], hasGst);
  const hasDiscountLedger = !!(input.discountLedgerName && (inv.bill_discount_amount ?? 0) > 0);
  const hsnRows = buildHsnRows(inv.line_items, inv.tax_type, inv.bill_discount_amount ?? 0, hasDiscountLedger);

  const entries: string[] = [];
  entries.push(`\n      <ALLLEDGERENTRIES.LIST>\n        <LEDGERNAME>${esc(partyLedger)}</LEDGERNAME>\n        <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>\n        <AMOUNT>${fmt2(-inv.total)}</AMOUNT>\n      </ALLLEDGERENTRIES.LIST>`);

  for (const row of hsnRows) {
    const ledger = findPurchaseLedger(input.purchaseLedgers, row.gst_percent);
    const name = ledger ?? input.purchaseLedgers[0]?.tally_ledger_name;
    if (!ledger) warnings.push(`No purchase ledger mapped for GST rate ${row.gst_percent}% — using first available`);
    if (!name) return { xml: null, skip: `No purchase ledger configured for rate ${row.gst_percent}%`, warnings };
    entries.push(`\n      <ALLLEDGERENTRIES.LIST>\n        <LEDGERNAME>${esc(name)}</LEDGERNAME>\n        <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>\n        <AMOUNT>${fmt2(row.taxable)}</AMOUNT>\n      </ALLLEDGERENTRIES.LIST>`);
  }

  if (hasDiscountLedger) {
    entries.push(`\n      <ALLLEDGERENTRIES.LIST>\n        <LEDGERNAME>${esc(input.discountLedgerName!)}</LEDGERNAME>\n        <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>\n        <AMOUNT>${fmt2(-(inv.bill_discount_amount ?? 0))}</AMOUNT>\n      </ALLLEDGERENTRIES.LIST>`);
  }

  const tax = buildTaxEntriesFromHsn(inv, hsnRows, input.dutiesTaxes);
  if (tax.skip) return { xml: null, skip: tax.skip, warnings };
  entries.push(...tax.entries);
  entries.push(...buildChargeEntries(inv, input.expenseLedgers, warnings));
  const ro = buildRoundOffEntry(inv, input.expenseLedgers);
  if (ro) entries.push(ro);

  return { xml: wrapVoucher(inv, partyLedger, entries.join(''), '', voucherTypeName), warnings };
}

function buildInventoryVoucher(inv: StoredInvoice, input: XmlGeneratorInput): VoucherResult {
  const warnings: string[] = [];
  const supplier = findSupplier(input.suppliers, inv.vendor_gstin, inv.vendor_name);
  const partyLedger = supplier?.tally_ledger_name ?? inv.vendor_name;
  if (!supplier) warnings.push(`Supplier "${inv.vendor_name}" not in master — using vendor name as ledger`);
  const hasGst = (inv.cgst ?? 0) > 0 || (inv.sgst ?? 0) > 0 || (inv.igst ?? 0) > 0;
  const voucherTypeName = resolveVoucherType(input.voucherTypes ?? [], hasGst);

  let totalItemsAmount = 0;
  const invEntries: string[] = [];

  for (const item of inv.line_items) {
    const desc = item.description ?? '';
    const stockItem = findStockItem(input.stockItems, desc);
    if (!stockItem) {
      warnings.push(`Stock item "${desc}" not mapped — line item excluded from inventory entries`);
      continue;
    }
    const itemNet = calcLineAmount(item);
    totalItemsAmount += itemNet;
    const uom = item.uom || stockItem.unit || 'NOS';
    const purchaseLedger = findPurchaseLedger(input.purchaseLedgers, item.gst_percent)
      ?? input.purchaseLedgers[0]?.tally_ledger_name ?? '';
    if (!purchaseLedger) warnings.push(`No purchase ledger for GST rate ${item.gst_percent}% on item "${desc}"`);
    const discLine = item.disc_percent > 0 ? `\n        <DISCOUNT>${fmt2(item.disc_percent)}</DISCOUNT>` : '';
    invEntries.push(
      `\n      <INVENTORYENTRIES.LIST>` +
      `\n        <STOCKITEMNAME>${esc(stockItem.tally_item_name)}</STOCKITEMNAME>` +
      `\n        <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>` +
      `\n        <RATE>${fmt2(item.rate)}/${esc(uom)}</RATE>` +
      `\n        <AMOUNT>${fmt2(itemNet)}</AMOUNT>` +
      `\n        <ACTUALQTY>${fmt2(item.qty)} ${esc(uom)}</ACTUALQTY>` +
      `\n        <BILLEDQTY>${fmt2(item.qty)} ${esc(uom)}</BILLEDQTY>` +
      discLine +
      `\n        <ACCOUNTINGALLOCATIONS.LIST>` +
      `\n          <LEDGERNAME>${esc(purchaseLedger)}</LEDGERNAME>` +
      `\n          <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>` +
      `\n          <AMOUNT>${fmt2(itemNet)}</AMOUNT>` +
      `\n        </ACCOUNTINGALLOCATIONS.LIST>` +
      `\n      </INVENTORYENTRIES.LIST>`
    );
  }

  if (invEntries.length === 0) {
    return { xml: null, skip: 'No line items could be mapped to stock items in master', warnings };
  }

  const ledgerEntries: string[] = [];
  ledgerEntries.push(`\n      <ALLLEDGERENTRIES.LIST>\n        <LEDGERNAME>${esc(partyLedger)}</LEDGERNAME>\n        <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>\n        <AMOUNT>${fmt2(-inv.total)}</AMOUNT>\n      </ALLLEDGERENTRIES.LIST>`);

  const hasDiscountLedger = !!(input.discountLedgerName && (inv.bill_discount_amount ?? 0) > 0);
  if (hasDiscountLedger) {
    ledgerEntries.push(`\n      <ALLLEDGERENTRIES.LIST>\n        <LEDGERNAME>${esc(input.discountLedgerName!)}</LEDGERNAME>\n        <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>\n        <AMOUNT>${fmt2(-(inv.bill_discount_amount ?? 0))}</AMOUNT>\n      </ALLLEDGERENTRIES.LIST>`);
  } else if ((inv.bill_discount_amount ?? 0) > 0) {
    warnings.push(`Bill discount ₹${fmt2(inv.bill_discount_amount ?? 0)} not booked — no discount ledger configured`);
  }

  const taxable = totalItemsAmount - (inv.bill_discount_amount ?? 0);
  const tax = buildTaxEntriesFromInvoiceTotals(inv, taxable, input.dutiesTaxes);
  if (tax.skip) return { xml: null, skip: tax.skip, warnings };
  ledgerEntries.push(...tax.entries);
  ledgerEntries.push(...buildChargeEntries(inv, input.expenseLedgers, warnings));
  const ro = buildRoundOffEntry(inv, input.expenseLedgers);
  if (ro) ledgerEntries.push(ro);

  return { xml: wrapVoucher(inv, partyLedger, ledgerEntries.join(''), invEntries.join(''), voucherTypeName), warnings };
}

// ─── Master creation XML ──────────────────────────────────────────────────────
// Generates a separate XML file (REPORTNAME=All Masters) that creates all
// ledgers and stock items referenced in the export batch. Import this FIRST
// in Tally before importing the vouchers XML — Tally silently skips masters
// that already exist, so it is safe to re-import.

function masterLedgerBlock(name: string, fields: string): string {
  return `
    <TALLYMESSAGE xmlns:UDF="TallyUDF">
      <LEDGER NAME="${name}" ACTION="Create">
        ${fields}
        <ISUPDATINGTARGETID>No</ISUPDATINGTARGETID>
        <ISDELETED>No</ISDELETED>
        <LANGUAGENAME.LIST>
          <NAME.LIST TYPE="String">
            <NAME>${name}</NAME>
          </NAME.LIST>
          <LANGUAGEID> 1033</LANGUAGEID>
        </LANGUAGENAME.LIST>
      </LEDGER>
    </TALLYMESSAGE>`;
}

function buildSupplierMasterBlock(s: SupplierMaster): string {
  const gstin = s.vendor_gstin ? `<PARTYGSTIN>${esc(s.vendor_gstin)}</PARTYGSTIN>` : '';
  const regType = s.is_unregistered ? 'Unregistered' : 'Regular';
  return masterLedgerBlock(esc(s.tally_ledger_name), `
        <PARENT>Sundry Creditors</PARENT>
        <CURRENCYNAME>&#x20B9;</CURRENCYNAME>
        <GSTREGISTRATIONTYPE>${regType}</GSTREGISTRATIONTYPE>
        ${gstin}
        <ISBILLWISEON>No</ISBILLWISEON>`);
}

function buildPurchaseLedgerBlock(pl: PurchaseLedgerEntry): string {
  return masterLedgerBlock(esc(pl.tally_ledger_name), `
        <PARENT>Purchase Accounts</PARENT>
        <CURRENCYNAME>&#x20B9;</CURRENCYNAME>
        <TAXTYPE>Others</TAXTYPE>
        <GSTAPPLICABLE>&#4; Applicable</GSTAPPLICABLE>
        <GSTTYPEOFSUPPLY>Goods</GSTTYPEOFSUPPLY>
        <AFFECTSSTOCK>Yes</AFFECTSSTOCK>`);
}

function buildTaxLedgerBlock(dt: DutiesTaxesMaster): string {
  const dutyHeadMap: Record<string, string> = { CGST: 'CGST', SGST: 'SGST/UTGST', IGST: 'IGST' };
  const dutyHead = dutyHeadMap[dt.tax_component] ?? dt.tax_component;
  return masterLedgerBlock(esc(dt.tally_ledger_name), `
        <PARENT>Duties &amp; Taxes</PARENT>
        <CURRENCYNAME>&#x20B9;</CURRENCYNAME>
        <TAXTYPE>GST</TAXTYPE>
        <GSTDUTYHEAD>${dutyHead}</GSTDUTYHEAD>`);
}

function buildExpenseLedgerBlock(el: ExpenseLedgerMaster): string {
  return masterLedgerBlock(esc(el.tally_ledger_name), `
        <PARENT>Indirect Expenses</PARENT>
        <CURRENCYNAME>&#x20B9;</CURRENCYNAME>
        <TAXTYPE>Others</TAXTYPE>
        <GSTAPPLICABLE>&#4; Applicable</GSTAPPLICABLE>
        <GSTTYPEOFSUPPLY>Services</GSTTYPEOFSUPPLY>`);
}

function buildStockItemBlock(s: StockItemMaster, gstPercent: number): string {
  const halfRate = gstPercent / 2;
  const unit = s.unit || 'Nos';
  const hsnBlock = s.hsn_code ? `
        <HSNDETAILS.LIST>
          <APPLICABLEFROM>20240401</APPLICABLEFROM>
          <HSNCODE>${esc(s.hsn_code)}</HSNCODE>
          <SRCOFHSNDETAILS>Specify Details Here</SRCOFHSNDETAILS>
        </HSNDETAILS.LIST>` : '';
  return `
    <TALLYMESSAGE xmlns:UDF="TallyUDF">
      <STOCKITEM NAME="${esc(s.tally_item_name)}" ACTION="Create">
        <PARENT/>
        <GSTTYPEOFSUPPLY>Goods</GSTTYPEOFSUPPLY>
        <BASEUNITS>${esc(unit)}</BASEUNITS>
        <ISUPDATINGTARGETID>No</ISUPDATINGTARGETID>
        <ISDELETED>No</ISDELETED>
        <GSTDETAILS.LIST>
          <APPLICABLEFROM>20240401</APPLICABLEFROM>
          <TAXABILITY>Taxable</TAXABILITY>
          <STATEWISEDETAILS.LIST>
            <STATENAME>&#4; Any</STATENAME>
            <RATEDETAILS.LIST>
              <GSTRATEDUTYHEAD>CGST</GSTRATEDUTYHEAD>
              <GSTRATEVALUATIONTYPE>Based on Value</GSTRATEVALUATIONTYPE>
              <GSTRATE> ${halfRate}</GSTRATE>
            </RATEDETAILS.LIST>
            <RATEDETAILS.LIST>
              <GSTRATEDUTYHEAD>SGST/UTGST</GSTRATEDUTYHEAD>
              <GSTRATEVALUATIONTYPE>Based on Value</GSTRATEVALUATIONTYPE>
              <GSTRATE> ${halfRate}</GSTRATE>
            </RATEDETAILS.LIST>
            <RATEDETAILS.LIST>
              <GSTRATEDUTYHEAD>IGST</GSTRATEDUTYHEAD>
              <GSTRATEVALUATIONTYPE>Based on Value</GSTRATEVALUATIONTYPE>
              <GSTRATE> ${gstPercent}</GSTRATE>
            </RATEDETAILS.LIST>
          </STATEWISEDETAILS.LIST>
        </GSTDETAILS.LIST>${hsnBlock}
        <LANGUAGENAME.LIST>
          <NAME.LIST TYPE="String">
            <NAME>${esc(s.tally_item_name)}</NAME>
          </NAME.LIST>
          <LANGUAGEID> 1033</LANGUAGEID>
        </LANGUAGENAME.LIST>
      </STOCKITEM>
    </TALLYMESSAGE>`;
}

export function generateMastersXml(input: XmlGeneratorInput): string {
  const messages: string[] = [];

  // 1. Supplier ledgers — only those used in this export batch
  const seenSuppliers = new Set<string>();
  for (const inv of input.invoices) {
    const supplier = findSupplier(input.suppliers, inv.vendor_gstin, inv.vendor_name);
    if (supplier && !seenSuppliers.has(supplier.tally_ledger_name)) {
      seenSuppliers.add(supplier.tally_ledger_name);
      messages.push(buildSupplierMasterBlock(supplier));
    }
  }

  // 2. Purchase account ledgers (all configured)
  for (const pl of input.purchaseLedgers) {
    if (pl.tally_ledger_name.trim()) messages.push(buildPurchaseLedgerBlock(pl));
  }

  // 3. GST duty/tax ledgers (all configured)
  for (const dt of input.dutiesTaxes) {
    messages.push(buildTaxLedgerBlock(dt));
  }

  // 4. Expense ledgers (all configured; parent defaults to Indirect Expenses)
  for (const el of input.expenseLedgers) {
    messages.push(buildExpenseLedgerBlock(el));
  }

  // 5. Stock items — inventory mode only, only those mapped in this batch
  if (input.voucherMode === 'inventory') {
    // Build a map from tally_item_name → GST rate (from first matching invoice line)
    const itemRateMap = new Map<string, number>();
    for (const inv of input.invoices) {
      for (const item of inv.line_items) {
        const stockItem = findStockItem(input.stockItems, item.description ?? '');
        if (stockItem && !itemRateMap.has(stockItem.tally_item_name)) {
          itemRateMap.set(stockItem.tally_item_name, item.gst_percent ?? 0);
        }
      }
    }
    for (const [, stockItem] of input.stockItems
      .filter((s) => itemRateMap.has(s.tally_item_name))
      .map((s) => [s.tally_item_name, s] as const)) {
      const rate = itemRateMap.get(stockItem.tally_item_name) ?? 0;
      messages.push(buildStockItemBlock(stockItem, rate));
    }
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Import Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>All Masters</REPORTNAME>
      </REQUESTDESC>
      <REQUESTDATA>${messages.join('')}
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export function generateTallyXml(input: XmlGeneratorInput): XmlGeneratorResult {
  const skipped: XmlGeneratorResult['skippedInvoices'] = [];
  const allWarnings: XmlGeneratorResult['warnings'] = [];
  const voucherBlocks: string[] = [];
  const isInventory = input.voucherMode === 'inventory';

  for (const inv of input.invoices) {
    const result = isInventory ? buildInventoryVoucher(inv, input) : buildAccountingOnlyVoucher(inv, input);
    result.warnings.forEach((w) => allWarnings.push({ invoice_number: inv.invoice_number, warning: w }));
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
      </REQUESTDESC>
      <REQUESTDATA>${voucherBlocks.join('')}
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;

  return { xml, includedCount: voucherBlocks.length, skippedInvoices: skipped, warnings: allWarnings };
}

// ─── Preview builder ──────────────────────────────────────────────────────────

export interface PreviewRow {
  invoice_number: string;
  invoice_date: string;
  vendor_name: string;
  party_ledger: string;
  voucher_type_name: string;   // resolved Tally voucher type for this invoice
  ledger_type: 'Party' | 'Purchase' | 'CGST' | 'SGST' | 'IGST' | 'Expense' | 'Round Off' | 'Inventory' | 'Discount';
  tally_ledger_name: string;
  amount: number;
  status: 'OK' | 'Skipped' | 'Suggested';
  is_suggested?: boolean;
  skip_reason?: string;
  warning?: string;
  // Inventory-mode fields
  stock_item_name?: string;
  qty?: number;
  rate?: number;
  uom?: string;
  disc_percent?: number;
  item_description?: string;
}

export function buildTallyPreview(input: XmlGeneratorInput): PreviewRow[] {
  return input.voucherMode === 'inventory'
    ? buildInventoryPreview(input)
    : buildAccountingOnlyPreview(input);
}

function makeBase(inv: StoredInvoice, partyLedger: string, voucherTypeName: string) {
  return { invoice_number: inv.invoice_number, invoice_date: inv.invoice_date, vendor_name: inv.vendor_name, party_ledger: partyLedger, voucher_type_name: voucherTypeName };
}

function buildAccountingOnlyPreview(input: XmlGeneratorInput): PreviewRow[] {
  const rows: PreviewRow[] = [];

  for (const inv of input.invoices) {
    const hasGst = (inv.cgst ?? 0) > 0 || (inv.sgst ?? 0) > 0 || (inv.igst ?? 0) > 0;
    const voucherTypeName = resolveVoucherType(input.voucherTypes ?? [], hasGst);
    const supplier = findSupplier(input.suppliers, inv.vendor_gstin, inv.vendor_name);
    const partyLedger = supplier?.tally_ledger_name ?? inv.vendor_name;
    const partyStatus: PreviewRow['status'] = supplier ? 'OK' : 'Suggested';
    const base = makeBase(inv, partyLedger, voucherTypeName);
    const hasDiscountLedger = !!(input.discountLedgerName && (inv.bill_discount_amount ?? 0) > 0);
    const hsnRows = buildHsnRows(inv.line_items, inv.tax_type, inv.bill_discount_amount ?? 0, hasDiscountLedger);

    rows.push({ ...base, ledger_type: 'Party', tally_ledger_name: partyLedger, amount: -inv.total, status: partyStatus, is_suggested: !supplier });

    for (const row of hsnRows) {
      const ledger = findPurchaseLedger(input.purchaseLedgers, row.gst_percent);
      const suggestedPurchase = hasGst ? 'GST PURCHASE' : 'PURCHASE';
      rows.push({ ...base, ledger_type: 'Purchase', tally_ledger_name: ledger ?? suggestedPurchase, amount: row.taxable, status: ledger ? 'OK' : 'Suggested', is_suggested: !ledger });
    }

    if ((inv.bill_discount_amount ?? 0) > 0) {
      rows.push({ ...base, ledger_type: 'Discount', tally_ledger_name: hasDiscountLedger ? input.discountLedgerName! : '(deducted from purchase — configure Discount Ledger to book separately)', amount: -(inv.bill_discount_amount ?? 0), status: 'OK', warning: hasDiscountLedger ? undefined : 'No discount ledger configured — discount deducted from purchase amount' });
    }

    if (inv.tax_type === 'cgst_sgst') {
      const cgstTotal = hsnRows.reduce((s, r) => s + r.cgst, 0);
      if (cgstTotal > 0) {
        const rate = hsnRows[0]?.gst_percent ? hsnRows[0].gst_percent / 2 : 0;
        const l = findTaxLedger(input.dutiesTaxes, 'CGST', rate);
        rows.push({ ...base, ledger_type: 'CGST', tally_ledger_name: l ?? 'Input CGST', amount: cgstTotal, status: l ? 'OK' : 'Suggested', is_suggested: !l });
      }
      const sgstTotal = hsnRows.reduce((s, r) => s + r.sgst, 0);
      if (sgstTotal > 0) {
        const rate = hsnRows[0]?.gst_percent ? hsnRows[0].gst_percent / 2 : 0;
        const l = findTaxLedger(input.dutiesTaxes, 'SGST', rate);
        rows.push({ ...base, ledger_type: 'SGST', tally_ledger_name: l ?? 'Input SGST', amount: sgstTotal, status: l ? 'OK' : 'Suggested', is_suggested: !l });
      }
    } else {
      const igstTotal = hsnRows.reduce((s, r) => s + r.igst, 0);
      if (igstTotal > 0) {
        const rate = hsnRows[0]?.gst_percent ?? 0;
        const l = findTaxLedger(input.dutiesTaxes, 'IGST', rate);
        rows.push({ ...base, ledger_type: 'IGST', tally_ledger_name: l ?? 'Input IGST', amount: igstTotal, status: l ? 'OK' : 'Suggested', is_suggested: !l });
      }
    }

    if (inv.charges) {
      for (const charge of inv.charges) {
        if (!charge.amount) continue;
        const l = findExpenseLedger(input.expenseLedgers, charge.description);
        rows.push({ ...base, ledger_type: 'Expense', tally_ledger_name: l ?? charge.description, amount: charge.amount, status: l ? 'OK' : 'Suggested', is_suggested: !l });
      }
    }

    if (inv.round_off && Math.abs(inv.round_off) > 0.001) {
      const l = findExpenseLedger(input.expenseLedgers, 'Round Off') ?? findExpenseLedger(input.expenseLedgers, 'Rounding Off');
      rows.push({ ...base, ledger_type: 'Round Off', tally_ledger_name: l ?? 'Round Off', amount: inv.round_off, status: l ? 'OK' : 'Suggested', is_suggested: !l });
    }
  }
  return rows;
}

function buildInventoryPreview(input: XmlGeneratorInput): PreviewRow[] {
  const rows: PreviewRow[] = [];

  for (const inv of input.invoices) {
    const hasGst = (inv.cgst ?? 0) > 0 || (inv.sgst ?? 0) > 0 || (inv.igst ?? 0) > 0;
    const voucherTypeName = resolveVoucherType(input.voucherTypes ?? [], hasGst);
    const supplier = findSupplier(input.suppliers, inv.vendor_gstin, inv.vendor_name);
    const partyLedger = supplier?.tally_ledger_name ?? inv.vendor_name;
    const partyStatus: PreviewRow['status'] = supplier ? 'OK' : 'Suggested';
    const base = makeBase(inv, partyLedger, voucherTypeName);
    let totalItemsAmount = 0;

    for (const item of inv.line_items) {
      const desc = item.description ?? '';
      const stockItem = findStockItem(input.stockItems, desc);
      const itemNet = calcLineAmount(item);
      totalItemsAmount += itemNet;
      const uom = item.uom || stockItem?.unit || 'NOS';
      const purchaseLedger = findPurchaseLedger(input.purchaseLedgers, item.gst_percent);
      const hsnRate = item.hsn ? `${item.hsn} @ ${item.gst_percent ?? 0}%` : `${desc} @ ${item.gst_percent ?? 0}%`;
      rows.push({
        ...base, ledger_type: 'Inventory',
        tally_ledger_name: stockItem ? stockItem.tally_item_name : hsnRate,
        amount: itemNet,
        status: stockItem ? 'OK' : 'Suggested',
        is_suggested: !stockItem,
        warning: (stockItem && !purchaseLedger) ? `No purchase ledger for GST ${item.gst_percent}%` : undefined,
        stock_item_name: stockItem?.tally_item_name,
        qty: item.qty, rate: item.rate, uom,
        disc_percent: item.disc_percent > 0 ? item.disc_percent : undefined,
        item_description: desc,
      });
    }

    rows.push({ ...base, ledger_type: 'Party', tally_ledger_name: partyLedger, amount: -inv.total, status: partyStatus, is_suggested: !supplier });

    if ((inv.bill_discount_amount ?? 0) > 0) {
      const hasDiscountLedger = !!(input.discountLedgerName);
      rows.push({ ...base, ledger_type: 'Discount', tally_ledger_name: hasDiscountLedger ? input.discountLedgerName! : '— NO DISCOUNT LEDGER CONFIGURED —', amount: -(inv.bill_discount_amount ?? 0), status: 'OK', warning: hasDiscountLedger ? undefined : 'No discount ledger configured — discount not booked' });
    }

    const taxable = totalItemsAmount - (inv.bill_discount_amount ?? 0);
    if (inv.tax_type === 'cgst_sgst') {
      if (inv.cgst > 0) {
        const rate = taxable > 0 ? Math.round((inv.cgst / taxable) * 100) : 0;
        const l = findTaxLedger(input.dutiesTaxes, 'CGST', rate) ?? findTaxLedger(input.dutiesTaxes, 'CGST', 0);
        rows.push({ ...base, ledger_type: 'CGST', tally_ledger_name: l ?? 'Input CGST', amount: inv.cgst, status: l ? 'OK' : 'Suggested', is_suggested: !l });
      }
      if (inv.sgst > 0) {
        const rate = taxable > 0 ? Math.round((inv.sgst / taxable) * 100) : 0;
        const l = findTaxLedger(input.dutiesTaxes, 'SGST', rate) ?? findTaxLedger(input.dutiesTaxes, 'SGST', 0);
        rows.push({ ...base, ledger_type: 'SGST', tally_ledger_name: l ?? 'Input SGST', amount: inv.sgst, status: l ? 'OK' : 'Suggested', is_suggested: !l });
      }
    } else if (inv.igst > 0) {
      const rate = taxable > 0 ? Math.round((inv.igst / taxable) * 100) : 0;
      const l = findTaxLedger(input.dutiesTaxes, 'IGST', rate) ?? findTaxLedger(input.dutiesTaxes, 'IGST', 0);
      rows.push({ ...base, ledger_type: 'IGST', tally_ledger_name: l ?? 'Input IGST', amount: inv.igst, status: l ? 'OK' : 'Suggested', is_suggested: !l });
    }

    if (inv.charges) {
      for (const charge of inv.charges) {
        if (!charge.amount) continue;
        const l = findExpenseLedger(input.expenseLedgers, charge.description);
        rows.push({ ...base, ledger_type: 'Expense', tally_ledger_name: l ?? charge.description, amount: charge.amount, status: l ? 'OK' : 'Suggested', is_suggested: !l });
      }
    }

    if (inv.round_off && Math.abs(inv.round_off) > 0.001) {
      const l = findExpenseLedger(input.expenseLedgers, 'Round Off') ?? findExpenseLedger(input.expenseLedgers, 'Rounding Off');
      rows.push({ ...base, ledger_type: 'Round Off', tally_ledger_name: l ?? 'Round Off', amount: inv.round_off, status: l ? 'OK' : 'Suggested', is_suggested: !l });
    }
  }
  return rows;
}
