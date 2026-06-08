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

// Full state names keyed by GSTIN first-2-digits (Tally needs full names, not abbreviations)
const GSTIN_STATE_FULL: Record<string, string> = {
  '01': 'Jammu & Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh',
  '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan',
  '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh',
  '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura',
  '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand',
  '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh', '24': 'Gujarat',
  '25': 'Daman & Diu', '26': 'Dadra & Nagar Haveli', '27': 'Maharashtra',
  '28': 'Andhra Pradesh (Pre-2014)', '29': 'Karnataka', '30': 'Goa',
  '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry',
  '35': 'Andaman & Nicobar Islands', '36': 'Telangana', '37': 'Andhra Pradesh',
};

function stateFromGstin(gstin: string | null | undefined): string {
  if (!gstin || gstin.length < 2) return '';
  return GSTIN_STATE_FULL[gstin.slice(0, 2)] ?? '';
}

function generateGuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

export interface XmlGeneratorInput {
  invoices: StoredInvoice[];
  suppliers: SupplierMaster[];
  dutiesTaxes: DutiesTaxesMaster[];
  stockItems: StockItemMaster[];
  expenseLedgers: ExpenseLedgerMaster[];
  purchaseLedgers?: PurchaseLedgerEntry[];  // deprecated — purchase ledger now read per-invoice from tally_ledger_acceptance
  voucherTypes: VoucherTypeMaster[];        // maps purchase category → voucher type name
  tallyCompanyName: string;                 // sacred — used verbatim in XML header
  voucherMode?: 'accounting_only' | 'inventory'; // default: accounting_only
  discountLedgerName?: string | null;       // Tally ledger for bill-level discounts (P&L)
  companyGstin?: string;                    // company's own GSTIN (optional)
  companyState?: string;                    // company's state full name (optional)
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

function wrapVoucher(
  inv: StoredInvoice,
  partyLedger: string,
  ledgerXml: string,
  inventoryXml: string,
  voucherTypeName: string,
  mode: 'accounting_only' | 'inventory' = 'accounting_only',
  input?: XmlGeneratorInput,
): string {
  const narration = `${esc(inv.vendor_name)} | ${esc(inv.invoice_number)} | ${inv.invoice_date}`;
  const d = tallyDate(inv.invoice_date);

  if (mode === 'accounting_only') {
    return `
    <TALLYMESSAGE xmlns:UDF="TallyUDF">
      <VOUCHER VCHTYPE="${esc(voucherTypeName)}" ACTION="Create" OBJVIEW="Accounting Voucher View">
        <DATE>${d}</DATE>
        <VOUCHERTYPENAME>${esc(voucherTypeName)}</VOUCHERTYPENAME>
        <PARTYLEDGERNAME>${esc(partyLedger)}</PARTYLEDGERNAME>
        <VOUCHERNUMBER>${esc(inv.invoice_number)}</VOUCHERNUMBER>
        <ISINVOICE>Yes</ISINVOICE>
        <NARRATION>${narration}</NARRATION>${inventoryXml}${ledgerXml}
      </VOUCHER>
    </TALLYMESSAGE>`;
  }

  // Inventory mode — full GST header matching Tally import format
  const guid = generateGuid();
  const vendorGstin = inv.vendor_gstin ?? '';
  const vendorState = stateFromGstin(vendorGstin);
  const regType = vendorGstin ? 'Regular' : 'Unregistered';
  const cmpGstin = input?.companyGstin ?? '';
  const cmpState = input?.companyState ?? stateFromGstin(cmpGstin);

  return `
    <TALLYMESSAGE xmlns:UDF="TallyUDF">
      <VOUCHER VCHTYPE="${esc(voucherTypeName)}" ACTION="Create" OBJVIEW="Invoice Voucher View">
        <OLDAUDITENTRYIDS.LIST TYPE="Number"><OLDAUDITENTRYIDS>-1</OLDAUDITENTRYIDS></OLDAUDITENTRYIDS.LIST>
        <DATE>${d}</DATE>
        <VCHSTATUSDATE>${d}</VCHSTATUSDATE>
        <GUID>${guid}</GUID>
        <GSTREGISTRATIONTYPE>${regType}</GSTREGISTRATIONTYPE>
        <STATENAME>${esc(vendorState)}</STATENAME>
        <TYPEOFUPDATEACTIVITY>Import</TYPEOFUPDATEACTIVITY>
        <OBJECTUPDATEACTION>Create</OBJECTUPDATEACTION>
        <COUNTRYOFRESIDENCE>India</COUNTRYOFRESIDENCE>${vendorGstin ? `\n        <PARTYGSTIN>${esc(vendorGstin)}</PARTYGSTIN>` : ''}
        <PLACEOFSUPPLY>${esc(vendorState)}</PLACEOFSUPPLY>
        <VOUCHERTYPENAME>${esc(voucherTypeName)}</VOUCHERTYPENAME>
        <PARTYNAME>${esc(inv.vendor_name)}</PARTYNAME>${cmpGstin ? `\n        <CMPGSTIN>${esc(cmpGstin)}</CMPGSTIN>` : ''}
        <PARTYLEDGERNAME>${esc(partyLedger)}</PARTYLEDGERNAME>
        <VOUCHERNUMBER>${esc(inv.invoice_number)}</VOUCHERNUMBER>${cmpGstin ? '\n        <CMPGSTREGISTRATIONTYPE>Regular</CMPGSTREGISTRATIONTYPE>' : ''}${cmpState ? `\n        <CMPGSTSTATE>${esc(cmpState)}</CMPGSTSTATE>` : ''}
        <BASICBASEPARTYNAME>${esc(inv.vendor_name)}</BASICBASEPARTYNAME>
        <NUMBERINGSTYLE>Manual</NUMBERINGSTYLE>
        <ISELIGIBLEFORIT>Yes</ISELIGIBLEFORIT>
        <ISINVOICE>Yes</ISINVOICE>
        <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
        <ISDELETED>No</ISDELETED>
        <ISCANCELLED>No</ISCANCELLED>
        <ISONHOLD>No</ISONHOLD>
        <ISPOSTDATED>No</ISPOSTDATED>
        <NARRATION>${narration}</NARRATION>${inventoryXml}${ledgerXml}
        <CONTRITRANS.LIST> </CONTRITRANS.LIST>
        <EWAYBILLERRORLIST.LIST> </EWAYBILLERRORLIST.LIST>
        <IRNERRORLIST.LIST> </IRNERRORLIST.LIST>
        <HARYANAVAT.LIST> </HARYANAVAT.LIST>
        <SUPPLEMENTARYDUTYHEADDETAILS.LIST> </SUPPLEMENTARYDUTYHEADDETAILS.LIST>
        <INVOICEDELNOTES.LIST> </INVOICEDELNOTES.LIST>
        <INVOICEORDERLIST.LIST> </INVOICEORDERLIST.LIST>
        <INVOICEINDENTLIST.LIST> </INVOICEINDENTLIST.LIST>
        <ATTENDANCEENTRIES.LIST> </ATTENDANCEENTRIES.LIST>
        <ORIGINVOICEDETAILS.LIST> </ORIGINVOICEDETAILS.LIST>
        <INVOICEEXPORTLIST.LIST> </INVOICEEXPORTLIST.LIST>
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

  const purchaseLedger = inv.tally_ledger_acceptance?.purchaseLedger ?? '';
  if (!purchaseLedger) return { xml: null, skip: `No purchase ledger set for invoice "${inv.invoice_number}" — accept the invoice first`, warnings };

  for (const row of hsnRows) {
    entries.push(`\n      <ALLLEDGERENTRIES.LIST>\n        <LEDGERNAME>${esc(purchaseLedger)}</LEDGERNAME>\n        <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>\n        <AMOUNT>${fmt2(row.taxable)}</AMOUNT>\n      </ALLLEDGERENTRIES.LIST>`);
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

  return { xml: wrapVoucher(inv, partyLedger, entries.join(''), '', voucherTypeName, 'accounting_only'), warnings };
}

// ─── Inventory-mode entry builders (LEDGERENTRIES.LIST / ALLINVENTORYENTRIES.LIST) ─

/** Full LEDGERENTRIES.LIST block for inventory mode — correct signs and sub-elements */
function invLedgerEntry(opts: {
  ledgerName: string;
  isdeemedpositive: 'Yes' | 'No';
  isPartyledger: 'Yes' | 'No';
  islastdeemedpositive: 'Yes' | 'No';
  amount: number;                      // already-signed: positive = debit to account, negative = credit
  billRefName?: string;                // non-empty → emit BILLALLOCATIONS.LIST
  rateOfInvoiceTax?: number;           // non-null → emit RATEOFINVOICETAX.LIST before LEDGERNAME
}): string {
  const rateBlock = opts.rateOfInvoiceTax != null
    ? `\n        <RATEOFINVOICETAX.LIST TYPE="Number">\n          <RATEOFINVOICETAX> ${opts.rateOfInvoiceTax}</RATEOFINVOICETAX>\n        </RATEOFINVOICETAX.LIST>`
    : '';
  const billAlloc = opts.billRefName
    ? `\n        <BILLALLOCATIONS.LIST>\n          <NAME>${esc(opts.billRefName)}</NAME>\n          <BILLTYPE>New Ref</BILLTYPE>\n          <TDSDEDUCTEEISSPECIALRATE>No</TDSDEDUCTEEISSPECIALRATE>\n          <AMOUNT>${fmt2(opts.amount)}</AMOUNT>\n          <INTERESTCOLLECTION.LIST> </INTERESTCOLLECTION.LIST>\n          <STBILLCATEGORIES.LIST> </STBILLCATEGORIES.LIST>\n        </BILLALLOCATIONS.LIST>`
    : `\n        <BILLALLOCATIONS.LIST> </BILLALLOCATIONS.LIST>`;
  return (
    `\n      <LEDGERENTRIES.LIST>` +
    `\n        <OLDAUDITENTRYIDS.LIST TYPE="Number"><OLDAUDITENTRYIDS>-1</OLDAUDITENTRYIDS></OLDAUDITENTRYIDS.LIST>` +
    rateBlock +
    `\n        <LEDGERNAME>${esc(opts.ledgerName)}</LEDGERNAME>` +
    `\n        <GSTCLASS>&#4; Not Applicable</GSTCLASS>` +
    `\n        <ISDEEMEDPOSITIVE>${opts.isdeemedpositive}</ISDEEMEDPOSITIVE>` +
    `\n        <LEDGERFROMITEM>No</LEDGERFROMITEM>` +
    `\n        <REMOVEZEROENTRIES>No</REMOVEZEROENTRIES>` +
    `\n        <ISPARTYLEDGER>${opts.isPartyledger}</ISPARTYLEDGER>` +
    `\n        <GSTOVERRIDDEN>No</GSTOVERRIDDEN>` +
    `\n        <ISGSTASSESSABLEVALUEOVERRIDDEN>No</ISGSTASSESSABLEVALUEOVERRIDDEN>` +
    `\n        <STRDISGSTAPPLICABLE>No</STRDISGSTAPPLICABLE>` +
    `\n        <STRDGSTISPARTYLEDGER>No</STRDGSTISPARTYLEDGER>` +
    `\n        <STRDGSTISDUTYLEDGER>No</STRDGSTISDUTYLEDGER>` +
    `\n        <CONTENTNEGISPOS>No</CONTENTNEGISPOS>` +
    `\n        <ISLASTDEEMEDPOSITIVE>${opts.islastdeemedpositive}</ISLASTDEEMEDPOSITIVE>` +
    `\n        <ISCAPVATTAXALTERED>No</ISCAPVATTAXALTERED>` +
    `\n        <ISCAPVATNOTCLAIMED>No</ISCAPVATNOTCLAIMED>` +
    `\n        <AMOUNT>${fmt2(opts.amount)}</AMOUNT>` +
    billAlloc +
    `\n        <SERVICETAXDETAILS.LIST> </SERVICETAXDETAILS.LIST>` +
    `\n        <BANKALLOCATIONS.LIST> </BANKALLOCATIONS.LIST>` +
    `\n        <OLDAUDITENTRIES.LIST> </OLDAUDITENTRIES.LIST>` +
    `\n        <ACCOUNTAUDITENTRIES.LIST> </ACCOUNTAUDITENTRIES.LIST>` +
    `\n        <AUDITENTRIES.LIST> </AUDITENTRIES.LIST>` +
    `\n        <INPUTCRALLOCS.LIST> </INPUTCRALLOCS.LIST>` +
    `\n        <DUTYHEADDETAILS.LIST> </DUTYHEADDETAILS.LIST>` +
    `\n        <EXCISEPAYMENTALLOCATIONS.LIST> </EXCISEPAYMENTALLOCATIONS.LIST>` +
    `\n        <TAXOBJECTALLOCATIONS.LIST> </TAXOBJECTALLOCATIONS.LIST>` +
    `\n        <TDSEXPENSEALLOCATIONS.LIST> </TDSEXPENSEALLOCATIONS.LIST>` +
    `\n        <VATSTATUTORYDETAILS.LIST> </VATSTATUTORYDETAILS.LIST>` +
    `\n        <COSTTRACKALLOCATIONS.LIST> </COSTTRACKALLOCATIONS.LIST>` +
    `\n        <REFVOUCHERDETAILS.LIST> </REFVOUCHERDETAILS.LIST>` +
    `\n        <INVOICEWISEDETAILS.LIST> </INVOICEWISEDETAILS.LIST>` +
    `\n        <VATITCDETAILS.LIST> </VATITCDETAILS.LIST>` +
    `\n        <ADVANCETAXDETAILS.LIST> </ADVANCETAXDETAILS.LIST>` +
    `\n      </LEDGERENTRIES.LIST>`
  );
}

/** Simpler LEDGERENTRIES.LIST for charge/expense ledgers in inventory mode */
function invChargeLedgerEntry(ledgerName: string, amount: number): string {
  return (
    `\n      <LEDGERENTRIES.LIST>` +
    `\n        <LEDGERNAME>${esc(ledgerName)}</LEDGERNAME>` +
    `\n        <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>` +
    `\n        <ISPARTYLEDGER>No</ISPARTYLEDGER>` +
    `\n        <ISLASTDEEMEDPOSITIVE>Yes</ISLASTDEEMEDPOSITIVE>` +
    `\n        <AMOUNT>${fmt2(amount)}</AMOUNT>` +
    `\n        <BILLALLOCATIONS.LIST> </BILLALLOCATIONS.LIST>` +
    `\n        <SERVICETAXDETAILS.LIST> </SERVICETAXDETAILS.LIST>` +
    `\n        <BANKALLOCATIONS.LIST> </BANKALLOCATIONS.LIST>` +
    `\n        <OLDAUDITENTRIES.LIST> </OLDAUDITENTRIES.LIST>` +
    `\n        <ACCOUNTAUDITENTRIES.LIST> </ACCOUNTAUDITENTRIES.LIST>` +
    `\n        <AUDITENTRIES.LIST> </AUDITENTRIES.LIST>` +
    `\n        <INPUTCRALLOCS.LIST> </INPUTCRALLOCS.LIST>` +
    `\n        <DUTYHEADDETAILS.LIST> </DUTYHEADDETAILS.LIST>` +
    `\n        <EXCISEPAYMENTALLOCATIONS.LIST> </EXCISEPAYMENTALLOCATIONS.LIST>` +
    `\n        <TAXOBJECTALLOCATIONS.LIST> </TAXOBJECTALLOCATIONS.LIST>` +
    `\n        <TDSEXPENSEALLOCATIONS.LIST> </TDSEXPENSEALLOCATIONS.LIST>` +
    `\n        <VATSTATUTORYDETAILS.LIST> </VATSTATUTORYDETAILS.LIST>` +
    `\n        <COSTTRACKALLOCATIONS.LIST> </COSTTRACKALLOCATIONS.LIST>` +
    `\n        <REFVOUCHERDETAILS.LIST> </REFVOUCHERDETAILS.LIST>` +
    `\n        <INVOICEWISEDETAILS.LIST> </INVOICEWISEDETAILS.LIST>` +
    `\n        <VATITCDETAILS.LIST> </VATITCDETAILS.LIST>` +
    `\n        <ADVANCETAXDETAILS.LIST> </ADVANCETAXDETAILS.LIST>` +
    `\n      </LEDGERENTRIES.LIST>`
  );
}

/** Build ALLINVENTORYENTRIES.LIST for one line item */
function buildAllInventoryEntry(
  stockItem: StockItemMaster,
  item: LineItem,
  purchaseLedger: string,
): string {
  const itemNet = calcLineAmount(item);
  const uom = item.uom || stockItem.unit || 'NOS';
  const negAmt = -Math.abs(itemNet);
  const discLine = item.disc_percent > 0 ? `\n        <DISCOUNT> ${fmt2(item.disc_percent)}</DISCOUNT>` : '';
  const hsnCode = item.hsn ? item.hsn.replace(/[\s.]/g, '') : '';
  const hsnBlock = hsnCode
    ? `\n        <GSTHSNNAME>${esc(hsnCode)}</GSTHSNNAME>\n        <GSTHSNINFERAPPLICABILITY>As per Masters/Company</GSTHSNINFERAPPLICABILITY>`
    : '';
  const gstRate = item.gst_percent ?? 0;
  const halfRate = gstRate / 2;

  return (
    `\n      <ALLINVENTORYENTRIES.LIST>` +
    `\n        <STOCKITEMNAME>${esc(stockItem.tally_item_name)}</STOCKITEMNAME>` +
    `\n        <GSTOVRDNINELIGIBLEITC>&#4; Not Applicable</GSTOVRDNINELIGIBLEITC>` +
    `\n        <GSTOVRDNISREVCHARGEAPPL>&#4; Not Applicable</GSTOVRDNISREVCHARGEAPPL>` +
    `\n        <GSTOVRDNTAXABILITY>Taxable</GSTOVRDNTAXABILITY>` +
    `\n        <GSTSOURCETYPE>Stock Item</GSTSOURCETYPE>` +
    `\n        <GSTITEMSOURCE>${esc(stockItem.tally_item_name)}</GSTITEMSOURCE>` +
    `\n        <HSNSOURCETYPE>Stock Item</HSNSOURCETYPE>` +
    `\n        <HSNITEMSOURCE>${esc(stockItem.tally_item_name)}</HSNITEMSOURCE>` +
    `\n        <GSTOVRDNSTOREDNA TURE/>` +
    `\n        <GSTOVRDNTYPEOFSUPPLY>Goods</GSTOVRDNTYPEOFSUPPLY>` +
    `\n        <GSTRATEINFERAPPLICABILITY>As per Masters/Company</GSTRATEINFERAPPLICABILITY>` +
    hsnBlock +
    `\n        <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>` +
    `\n        <ISGSTASSESSABLEVALUEOVERRIDDEN>No</ISGSTASSESSABLEVALUEOVERRIDDEN>` +
    `\n        <STRDISGSTAPPLICABLE>No</STRDISGSTAPPLICABLE>` +
    `\n        <CONTENTNEGISPOS>No</CONTENTNEGISPOS>` +
    `\n        <ISLASTDEEMEDPOSITIVE>Yes</ISLASTDEEMEDPOSITIVE>` +
    `\n        <ISAUTONEGATE>No</ISAUTONEGATE>` +
    `\n        <ISCUSTOMSCLEARANCE>No</ISCUSTOMSCLEARANCE>` +
    `\n        <ISTRACKCOMPONENT>No</ISTRACKCOMPONENT>` +
    `\n        <ISTRACKPRODUCTION>No</ISTRACKPRODUCTION>` +
    `\n        <ISPRIMARYITEM>No</ISPRIMARYITEM>` +
    `\n        <ISSCRAP>No</ISSCRAP>` +
    `\n        <RATE>${fmt2(item.rate)}/${esc(uom)}</RATE>` +
    discLine +
    `\n        <AMOUNT>${fmt2(negAmt)}</AMOUNT>` +
    `\n        <ACTUALQTY> ${fmt2(item.qty)} ${esc(uom)}</ACTUALQTY>` +
    `\n        <BILLEDQTY> ${fmt2(item.qty)} ${esc(uom)}</BILLEDQTY>` +
    `\n        <BATCHALLOCATIONS.LIST>` +
    `\n          <GODOWNNAME>Main Location</GODOWNNAME>` +
    `\n          <BATCHNAME>Primary Batch</BATCHNAME>` +
    `\n          <DESTINATIONGODOWNNAME>Main Location</DESTINATIONGODOWNNAME>` +
    `\n          <INDENTNO>&#4; Not Applicable</INDENTNO>` +
    `\n          <ORDERNO>&#4; Not Applicable</ORDERNO>` +
    `\n          <TRACKINGNUMBER>&#4; Not Applicable</TRACKINGNUMBER>` +
    `\n          <DYNAMICCSTISCLEARED>No</DYNAMICCSTISCLEARED>` +
    `\n          <AMOUNT>${fmt2(negAmt)}</AMOUNT>` +
    `\n          <ACTUALQTY> ${fmt2(item.qty)} ${esc(uom)}</ACTUALQTY>` +
    `\n          <BILLEDQTY> ${fmt2(item.qty)} ${esc(uom)}</BILLEDQTY>` +
    `\n          <ADDITIONALDETAILS.LIST> </ADDITIONALDETAILS.LIST>` +
    `\n          <VOUCHERCOMPONENTLIST.LIST> </VOUCHERCOMPONENTLIST.LIST>` +
    `\n        </BATCHALLOCATIONS.LIST>` +
    `\n        <ACCOUNTINGALLOCATIONS.LIST>` +
    `\n          <OLDAUDITENTRYIDS.LIST TYPE="Number"><OLDAUDITENTRYIDS>-1</OLDAUDITENTRYIDS></OLDAUDITENTRYIDS.LIST>` +
    `\n          <LEDGERNAME>${esc(purchaseLedger)}</LEDGERNAME>` +
    `\n          <GSTCLASS>&#4; Not Applicable</GSTCLASS>` +
    `\n          <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>` +
    `\n          <LEDGERFROMITEM>No</LEDGERFROMITEM>` +
    `\n          <REMOVEZEROENTRIES>No</REMOVEZEROENTRIES>` +
    `\n          <ISPARTYLEDGER>No</ISPARTYLEDGER>` +
    `\n          <GSTOVERRIDDEN>No</GSTOVERRIDDEN>` +
    `\n          <ISGSTASSESSABLEVALUEOVERRIDDEN>No</ISGSTASSESSABLEVALUEOVERRIDDEN>` +
    `\n          <STRDISGSTAPPLICABLE>No</STRDISGSTAPPLICABLE>` +
    `\n          <STRDGSTISPARTYLEDGER>No</STRDGSTISPARTYLEDGER>` +
    `\n          <STRDGSTISDUTYLEDGER>No</STRDGSTISDUTYLEDGER>` +
    `\n          <CONTENTNEGISPOS>No</CONTENTNEGISPOS>` +
    `\n          <ISLASTDEEMEDPOSITIVE>Yes</ISLASTDEEMEDPOSITIVE>` +
    `\n          <ISCAPVATTAXALTERED>No</ISCAPVATTAXALTERED>` +
    `\n          <ISCAPVATNOTCLAIMED>No</ISCAPVATNOTCLAIMED>` +
    `\n          <AMOUNT>${fmt2(negAmt)}</AMOUNT>` +
    `\n          <SERVICETAXDETAILS.LIST> </SERVICETAXDETAILS.LIST>` +
    `\n          <BANKALLOCATIONS.LIST> </BANKALLOCATIONS.LIST>` +
    `\n          <BILLALLOCATIONS.LIST> </BILLALLOCATIONS.LIST>` +
    `\n          <INTERESTCOLLECTION.LIST> </INTERESTCOLLECTION.LIST>` +
    `\n          <OLDAUDITENTRIES.LIST> </OLDAUDITENTRIES.LIST>` +
    `\n          <ACCOUNTAUDITENTRIES.LIST> </ACCOUNTAUDITENTRIES.LIST>` +
    `\n          <AUDITENTRIES.LIST> </AUDITENTRIES.LIST>` +
    `\n          <INPUTCRALLOCS.LIST> </INPUTCRALLOCS.LIST>` +
    `\n          <DUTYHEADDETAILS.LIST> </DUTYHEADDETAILS.LIST>` +
    `\n          <EXCISEPAYMENTALLOCATIONS.LIST> </EXCISEPAYMENTALLOCATIONS.LIST>` +
    `\n          <TAXOBJECTALLOCATIONS.LIST> </TAXOBJECTALLOCATIONS.LIST>` +
    `\n          <TDSEXPENSEALLOCATIONS.LIST> </TDSEXPENSEALLOCATIONS.LIST>` +
    `\n          <VATSTATUTORYDETAILS.LIST> </VATSTATUTORYDETAILS.LIST>` +
    `\n          <COSTTRACKALLOCATIONS.LIST> </COSTTRACKALLOCATIONS.LIST>` +
    `\n          <REFVOUCHERDETAILS.LIST> </REFVOUCHERDETAILS.LIST>` +
    `\n          <INVOICEWISEDETAILS.LIST> </INVOICEWISEDETAILS.LIST>` +
    `\n          <VATITCDETAILS.LIST> </VATITCDETAILS.LIST>` +
    `\n          <ADVANCETAXDETAILS.LIST> </ADVANCETAXDETAILS.LIST>` +
    `\n        </ACCOUNTINGALLOCATIONS.LIST>` +
    `\n        <DUTYHEADDETAILS.LIST> </DUTYHEADDETAILS.LIST>` +
    `\n        <RATEDETAILS.LIST>` +
    `\n          <GSTRATEDUTYHEAD>CGST</GSTRATEDUTYHEAD>` +
    `\n          <GSTRATEVALUATIONTYPE>Based on Value</GSTRATEVALUATIONTYPE>` +
    `\n          <GSTRATE> ${halfRate}</GSTRATE>` +
    `\n        </RATEDETAILS.LIST>` +
    `\n        <RATEDETAILS.LIST>` +
    `\n          <GSTRATEDUTYHEAD>SGST/UTGST</GSTRATEDUTYHEAD>` +
    `\n          <GSTRATEVALUATIONTYPE>Based on Value</GSTRATEVALUATIONTYPE>` +
    `\n          <GSTRATE> ${halfRate}</GSTRATE>` +
    `\n        </RATEDETAILS.LIST>` +
    `\n        <RATEDETAILS.LIST>` +
    `\n          <GSTRATEDUTYHEAD>IGST</GSTRATEDUTYHEAD>` +
    `\n          <GSTRATEVALUATIONTYPE>Based on Value</GSTRATEVALUATIONTYPE>` +
    `\n          <GSTRATE> ${gstRate}</GSTRATE>` +
    `\n        </RATEDETAILS.LIST>` +
    `\n        <RATEDETAILS.LIST>` +
    `\n          <GSTRATEDUTYHEAD>Cess</GSTRATEDUTYHEAD>` +
    `\n          <GSTRATEVALUATIONTYPE>Based on Value</GSTRATEVALUATIONTYPE>` +
    `\n        </RATEDETAILS.LIST>` +
    `\n        <SUPPLEMENTARYDUTYHEADDETAILS.LIST> </SUPPLEMENTARYDUTYHEADDETAILS.LIST>` +
    `\n        <TAXOBJECTALLOCATIONS.LIST> </TAXOBJECTALLOCATIONS.LIST>` +
    `\n        <REFVOUCHERDETAILS.LIST> </REFVOUCHERDETAILS.LIST>` +
    `\n        <EXCISEALLOCATIONS.LIST> </EXCISEALLOCATIONS.LIST>` +
    `\n        <EXPENSEALLOCATIONS.LIST> </EXPENSEALLOCATIONS.LIST>` +
    `\n      </ALLINVENTORYENTRIES.LIST>`
  );
}

function buildInventoryVoucher(inv: StoredInvoice, input: XmlGeneratorInput): VoucherResult {
  const warnings: string[] = [];
  const supplier = findSupplier(input.suppliers, inv.vendor_gstin, inv.vendor_name);
  const partyLedger = supplier?.tally_ledger_name ?? inv.vendor_name;
  if (!supplier) warnings.push(`Supplier "${inv.vendor_name}" not in master — using vendor name as ledger`);
  const hasGst = (inv.cgst ?? 0) > 0 || (inv.sgst ?? 0) > 0 || (inv.igst ?? 0) > 0;
  const voucherTypeName = resolveVoucherType(input.voucherTypes ?? [], hasGst);

  const purchaseLedger = inv.tally_ledger_acceptance?.purchaseLedger ?? '';
  if (!purchaseLedger) warnings.push(`No purchase ledger set for invoice "${inv.invoice_number}" — accept the invoice first`);

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
    invEntries.push(buildAllInventoryEntry(stockItem, item, purchaseLedger));
  }

  if (invEntries.length === 0) {
    return { xml: null, skip: 'No line items could be mapped to stock items in master', warnings };
  }

  // Ledger entries — LEDGERENTRIES.LIST (inventory mode)
  const ledgerEntries: string[] = [];

  // 1. Party (creditor) — positive total, ISDEEMEDPOSITIVE=No
  ledgerEntries.push(invLedgerEntry({
    ledgerName: partyLedger,
    isdeemedpositive: 'No',
    isPartyledger: 'Yes',
    islastdeemedpositive: 'No',
    amount: inv.total,
    billRefName: inv.invoice_number,
  }));

  // 2. Bill discount (if any, using discount ledger)
  const hasDiscountLedger = !!(input.discountLedgerName && (inv.bill_discount_amount ?? 0) > 0);
  if (hasDiscountLedger) {
    ledgerEntries.push(invChargeLedgerEntry(input.discountLedgerName!, -(inv.bill_discount_amount ?? 0)));
  } else if ((inv.bill_discount_amount ?? 0) > 0) {
    warnings.push(`Bill discount ₹${fmt2(inv.bill_discount_amount ?? 0)} not booked — no discount ledger configured`);
  }

  // 3. Tax ledgers — NEGATIVE amounts (debit to ITC accounts)
  if (inv.tax_type === 'cgst_sgst') {
    if (inv.cgst > 0) {
      const taxable = totalItemsAmount - (inv.bill_discount_amount ?? 0);
      const rate = taxable > 0 ? Math.round((inv.cgst / taxable) * 100) : 0;
      const ledger = findTaxLedger(input.dutiesTaxes, 'CGST', rate) ?? findTaxLedger(input.dutiesTaxes, 'CGST', 0);
      if (!ledger) return { xml: null, skip: 'No CGST ledger configured in Duties & Taxes master', warnings };
      ledgerEntries.push(invLedgerEntry({
        ledgerName: ledger,
        isdeemedpositive: 'Yes',
        isPartyledger: 'No',
        islastdeemedpositive: 'Yes',
        amount: -inv.cgst,
        rateOfInvoiceTax: rate || undefined,
      }));
    }
    if (inv.sgst > 0) {
      const taxable = totalItemsAmount - (inv.bill_discount_amount ?? 0);
      const rate = taxable > 0 ? Math.round((inv.sgst / taxable) * 100) : 0;
      const ledger = findTaxLedger(input.dutiesTaxes, 'SGST', rate) ?? findTaxLedger(input.dutiesTaxes, 'SGST', 0);
      if (!ledger) return { xml: null, skip: 'No SGST ledger configured in Duties & Taxes master', warnings };
      ledgerEntries.push(invLedgerEntry({
        ledgerName: ledger,
        isdeemedpositive: 'Yes',
        isPartyledger: 'No',
        islastdeemedpositive: 'Yes',
        amount: -inv.sgst,
        rateOfInvoiceTax: rate || undefined,
      }));
    }
  } else if (inv.igst > 0) {
    const taxable = totalItemsAmount - (inv.bill_discount_amount ?? 0);
    const rate = taxable > 0 ? Math.round((inv.igst / taxable) * 100) : 0;
    const ledger = findTaxLedger(input.dutiesTaxes, 'IGST', rate) ?? findTaxLedger(input.dutiesTaxes, 'IGST', 0);
    if (!ledger) return { xml: null, skip: 'No IGST ledger configured in Duties & Taxes master', warnings };
    ledgerEntries.push(invLedgerEntry({
      ledgerName: ledger,
      isdeemedpositive: 'Yes',
      isPartyledger: 'No',
      islastdeemedpositive: 'Yes',
      amount: -inv.igst,
      rateOfInvoiceTax: rate || undefined,
    }));
  }

  // 4. Charge / expense ledgers — NEGATIVE amounts
  if (inv.charges?.length) {
    for (const charge of inv.charges) {
      if (!charge.amount || charge.amount === 0) continue;
      const ledger = findExpenseLedger(input.expenseLedgers, charge.description);
      if (!ledger) {
        warnings.push(`No expense ledger mapped for charge "${charge.description}" — charge excluded from XML`);
        continue;
      }
      ledgerEntries.push(invChargeLedgerEntry(ledger, -Math.abs(charge.amount)));
    }
  }

  // 5. Round-off
  if (inv.round_off && Math.abs(inv.round_off) > 0.001) {
    const ledger = findExpenseLedger(input.expenseLedgers, 'Round Off') ?? findExpenseLedger(input.expenseLedgers, 'Rounding Off');
    if (ledger) {
      ledgerEntries.push(invChargeLedgerEntry(ledger, -Math.abs(inv.round_off)));
    }
  }

  return {
    xml: wrapVoucher(inv, partyLedger, ledgerEntries.join(''), invEntries.join(''), voucherTypeName, 'inventory', input),
    warnings,
  };
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
  const regType = s.is_unregistered ? 'Unregistered' : 'Regular';
  const vendorState = stateFromGstin(s.vendor_gstin);

  const ledgstReg = s.vendor_gstin
    ? `
        <LEDGSTREGDETAILS.LIST>
          <APPLICABLEFROM>20170701</APPLICABLEFROM>
          <GSTREGISTRATIONTYPE>${regType}</GSTREGISTRATIONTYPE>
          <STATE>${esc(vendorState)}</STATE>
          <PLACEOFSUPPLY>${esc(vendorState)}</PLACEOFSUPPLY>
          <GSTIN>${esc(s.vendor_gstin)}</GSTIN>
          <ISOTHTERRITORYASSESSEE>No</ISOTHTERRITORYASSESSEE>
          <CONSIDERPURCHASEFOREXPORT>No</CONSIDERPURCHASEFOREXPORT>
          <ISTRANSPORTER>No</ISTRANSPORTER>
          <ISCOMMONPARTY>No</ISCOMMONPARTY>
        </LEDGSTREGDETAILS.LIST>`
    : `\n        <LEDGSTREGDETAILS.LIST> </LEDGSTREGDETAILS.LIST>`;

  return masterLedgerBlock(esc(s.tally_ledger_name), `
        <PARENT>Sundry Creditors</PARENT>
        <CURRENCYNAME>&#x20B9;</CURRENCYNAME>
        <TAXTYPE>Others</TAXTYPE>
        <COUNTRYOFRESIDENCE>India</COUNTRYOFRESIDENCE>
        <GSTREGISTRATIONTYPE>${regType}</GSTREGISTRATIONTYPE>${s.vendor_gstin ? `\n        <PARTYGSTIN>${esc(s.vendor_gstin)}</PARTYGSTIN>` : ''}
        <ISBILLWISEON>Yes</ISBILLWISEON>` + ledgstReg);
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

function buildUnitBlock(unitName: string): string {
  return `
    <TALLYMESSAGE xmlns:UDF="TallyUDF">
      <UNIT NAME="${esc(unitName)}" ACTION="Create">
        <NAME>${esc(unitName)}</NAME>
        <ORIGINALNAME>${esc(unitName)}</ORIGINALNAME>
        <ISSIMPLEUNIT>Yes</ISSIMPLEUNIT>
        <ISUPDATINGTARGETID>No</ISUPDATINGTARGETID>
        <ISDELETED>No</ISDELETED>
      </UNIT>
    </TALLYMESSAGE>`;
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

  // 2. Purchase account ledgers — collected from accepted invoices
  const seenPurchase = new Set<string>();
  for (const inv of input.invoices) {
    const pl = inv.tally_ledger_acceptance?.purchaseLedger;
    if (pl && !seenPurchase.has(pl)) {
      seenPurchase.add(pl);
      messages.push(buildPurchaseLedgerBlock({ gst_percent: null, tally_ledger_name: pl }));
    }
  }

  // 3. GST duty/tax ledgers (all configured)
  for (const dt of input.dutiesTaxes) {
    messages.push(buildTaxLedgerBlock(dt));
  }

  // 4. Expense ledgers (all configured; parent defaults to Indirect Expenses)
  for (const el of input.expenseLedgers) {
    messages.push(buildExpenseLedgerBlock(el));
  }

  // 5. Units + Stock items — inventory mode only, only those mapped in this batch
  if (input.voucherMode === 'inventory') {
    const itemRateMap = new Map<string, number>();
    for (const inv of input.invoices) {
      for (const item of inv.line_items) {
        const stockItem = findStockItem(input.stockItems, item.description ?? '');
        if (stockItem && !itemRateMap.has(stockItem.tally_item_name)) {
          itemRateMap.set(stockItem.tally_item_name, item.gst_percent ?? 0);
        }
      }
    }
    const mappedItems = input.stockItems.filter((s) => itemRateMap.has(s.tally_item_name));
    // Emit unit creation blocks first (Tally requires units to exist before stock items)
    const seenUnits = new Set<string>();
    for (const s of mappedItems) {
      const unit = s.unit || 'Nos';
      if (!seenUnits.has(unit)) { seenUnits.add(unit); messages.push(buildUnitBlock(unit)); }
    }
    for (const stockItem of mappedItems) {
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

/** Single XML file: masters section first, vouchers section second.
 *  Tally processes both in order — creates ledgers/items, then imports vouchers.
 *  Safe to import into a Tally company that already has some of these masters. */
export function generateCombinedXml(input: XmlGeneratorInput): XmlGeneratorResult {
  // Build master blocks (same logic as generateMastersXml but return raw message strings)
  const masterMessages: string[] = [];

  const seenSuppliers = new Set<string>();
  for (const inv of input.invoices) {
    const supplier = findSupplier(input.suppliers, inv.vendor_gstin, inv.vendor_name);
    if (supplier && !seenSuppliers.has(supplier.tally_ledger_name)) {
      seenSuppliers.add(supplier.tally_ledger_name);
      masterMessages.push(buildSupplierMasterBlock(supplier));
    }
  }
  // Purchase account ledgers — collected from accepted invoices
  const seenPurchaseCombined = new Set<string>();
  for (const inv of input.invoices) {
    const pl = inv.tally_ledger_acceptance?.purchaseLedger;
    if (pl && !seenPurchaseCombined.has(pl)) {
      seenPurchaseCombined.add(pl);
      masterMessages.push(buildPurchaseLedgerBlock({ gst_percent: null, tally_ledger_name: pl }));
    }
  }
  for (const dt of input.dutiesTaxes) {
    masterMessages.push(buildTaxLedgerBlock(dt));
  }
  for (const el of input.expenseLedgers) {
    masterMessages.push(buildExpenseLedgerBlock(el));
  }
  if (input.voucherMode === 'inventory') {
    const itemRateMap = new Map<string, number>();
    for (const inv of input.invoices) {
      for (const item of inv.line_items) {
        const stockItem = findStockItem(input.stockItems, item.description ?? '');
        if (stockItem && !itemRateMap.has(stockItem.tally_item_name)) {
          itemRateMap.set(stockItem.tally_item_name, item.gst_percent ?? 0);
        }
      }
    }
    const mappedItems2 = input.stockItems.filter((s) => itemRateMap.has(s.tally_item_name));
    const seenUnits2 = new Set<string>();
    for (const s of mappedItems2) {
      const unit = s.unit || 'Nos';
      if (!seenUnits2.has(unit)) { seenUnits2.add(unit); masterMessages.push(buildUnitBlock(unit)); }
    }
    for (const stockItem of mappedItems2) {
      const rate = itemRateMap.get(stockItem.tally_item_name) ?? 0;
      masterMessages.push(buildStockItemBlock(stockItem, rate));
    }
  }

  // Build voucher blocks
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
        <REPORTNAME>All Masters</REPORTNAME>
      </REQUESTDESC>
      <REQUESTDATA>${masterMessages.join('')}
      </REQUESTDATA>
    </IMPORTDATA>
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

    const acceptedPurchaseLedger = inv.tally_ledger_acceptance?.purchaseLedger ?? '';
    for (const row of hsnRows) {
      const suggestedPurchase = hasGst ? 'GST PURCHASE' : 'PURCHASE';
      rows.push({ ...base, ledger_type: 'Purchase', tally_ledger_name: acceptedPurchaseLedger || suggestedPurchase, amount: row.taxable, status: acceptedPurchaseLedger ? 'OK' : 'Suggested', is_suggested: !acceptedPurchaseLedger });
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
    const acceptedPurchaseLedger = inv.tally_ledger_acceptance?.purchaseLedger ?? '';
    let totalItemsAmount = 0;

    for (const item of inv.line_items) {
      const desc = item.description ?? '';
      const stockItem = findStockItem(input.stockItems, desc);
      const itemNet = calcLineAmount(item);
      totalItemsAmount += itemNet;
      const uom = item.uom || stockItem?.unit || 'NOS';
      const hsnRate = item.hsn ? `${item.hsn} @ ${item.gst_percent ?? 0}%` : `${desc} @ ${item.gst_percent ?? 0}%`;
      rows.push({
        ...base, ledger_type: 'Inventory',
        tally_ledger_name: stockItem ? stockItem.tally_item_name : hsnRate,
        amount: itemNet,
        status: stockItem ? 'OK' : 'Suggested',
        is_suggested: !stockItem,
        warning: (stockItem && !acceptedPurchaseLedger) ? `No purchase ledger set for invoice "${inv.invoice_number}" — accept the invoice first` : undefined,
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
