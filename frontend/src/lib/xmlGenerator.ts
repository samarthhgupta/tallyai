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
  financialYear?: string;                   // e.g. 'FY 2024-25' — drives APPLICABLEFROM dates
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
    // Invoice has a GSTIN but it didn't match any supplier — do NOT fuzzy-name-match.
    // GSTIN is the definitive identifier; a name-based guess with an unmatched GSTIN would
    // map the invoice to the wrong Tally ledger (e.g. "SHRI VINAYAK TRADERS" wrongly matched
    // to "Shri Ganesh Traders" because both names share the words "Shri" and "Traders").
    return null;
  }
  // No GSTIN on invoice — exact name match then fuzzy
  const vn = norm(vendorName);
  const exact = suppliers.find((s) => norm(s.vendor_name) === vn || norm(s.tally_ledger_name) === vn);
  if (exact) return exact;
  // Fuzzy match only for invoices without a GSTIN (e.g. unregistered suppliers)
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

function findStockItem(
  stockItems: StockItemMaster[],
  description: string,
  hsn?: string,
  gstRate?: number,
): StockItemMaster | null {
  const q = norm(description);
  const byAlias = stockItems.find((s) => s.alias_name && norm(s.alias_name) === q);
  if (byAlias) return byAlias;
  const byName = stockItems.find((s) => norm(s.tally_item_name) === q);
  if (byName) return byName;
  const partialAlias = stockItems.find(
    (s) => s.alias_name && (norm(s.alias_name).includes(q) || q.includes(norm(s.alias_name))),
  );
  if (partialAlias) return partialAlias;
  const fuzzy = suggestStockItem(stockItems, description);
  if (fuzzy) return fuzzy;
  // HSN + GST rate match — stock items named "{HSN} @ {RATE}%" are looked up by code+rate
  if (hsn && gstRate != null) {
    const cleanHsn = hsn.replace(/[\s.]/g, '');
    const byHsn = stockItems.find(
      (s) =>
        s.hsn_code &&
        s.hsn_code.replace(/[\s.]/g, '') === cleanHsn &&
        s.gst_percent === gstRate,
    );
    if (byHsn) return byHsn;
    // Rate-only HSN match (consolidated item without rate distinction)
    const byHsnOnly = stockItems.find(
      (s) => s.hsn_code && s.hsn_code.replace(/[\s.]/g, '') === cleanHsn,
    );
    if (byHsnOnly) return byHsnOnly;
  }
  return null;
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

  // Inventory mode — full schema matching Tally export format (reverse-engineered June 2025)
  // U+0004 is Tally's "Not Applicable" sentinel — actual character, not &#4; entity
  const NA = ' Not Applicable';
  const guid = generateGuid();
  const vendorGstin = inv.vendor_gstin ?? '';
  const vendorState = stateFromGstin(vendorGstin);
  const regType = vendorGstin ? 'Regular' : 'Unregistered';
  const cmpGstin = input?.companyGstin ?? '';
  const cmpState = input?.companyState ?? stateFromGstin(cmpGstin);
  // "Uttar Pradesh Registration" — Tally's name for the company's GST registration unit
  const cmpTaxUnit = cmpState ? `${cmpState} Registration` : '';

  return `
    <TALLYMESSAGE xmlns:UDF="TallyUDF">
      <VOUCHER VCHTYPE="${esc(voucherTypeName)}" ACTION="Create" OBJVIEW="Invoice Voucher View">
        <OLDAUDITENTRYIDS.LIST TYPE="Number"><OLDAUDITENTRYIDS>-1</OLDAUDITENTRYIDS></OLDAUDITENTRYIDS.LIST>
        <DATE>${d}</DATE>
        <REFERENCEDATE>${d}</REFERENCEDATE>
        <VCHSTATUSDATE>${d}</VCHSTATUSDATE>
        <GUID>${guid}</GUID>
        <GSTREGISTRATIONTYPE>${regType}</GSTREGISTRATIONTYPE>
        <VATDEALERTYPE>${regType}</VATDEALERTYPE>
        <STATENAME>${esc(vendorState)}</STATENAME>
        <OBJECTUPDATEACTION>Create</OBJECTUPDATEACTION>
        <COUNTRYOFRESIDENCE>India</COUNTRYOFRESIDENCE>${vendorGstin ? `\n        <PARTYGSTIN>${esc(vendorGstin)}</PARTYGSTIN>` : ''}
        <PLACEOFSUPPLY>${esc(vendorState)}</PLACEOFSUPPLY>
        <VOUCHERTYPENAME>${esc(voucherTypeName)}</VOUCHERTYPENAME>
        <CLASSNAME>DefaultVoucherClass</CLASSNAME>
        <PARTYNAME>${esc(inv.vendor_name)}</PARTYNAME>${cmpGstin ? `\n        <CMPGSTIN>${esc(cmpGstin)}</CMPGSTIN>` : ''}
        <PARTYLEDGERNAME>${esc(partyLedger)}</PARTYLEDGERNAME>
        <VOUCHERNUMBER>${esc(inv.invoice_number)}</VOUCHERNUMBER>${cmpGstin ? '\n        <CMPGSTREGISTRATIONTYPE>Regular</CMPGSTREGISTRATIONTYPE>' : ''}${cmpState ? `\n        <CMPGSTSTATE>${esc(cmpState)}</CMPGSTSTATE>` : ''}
        <BASICBASEPARTYNAME>${esc(inv.vendor_name)}</BASICBASEPARTYNAME>
        <PARTYMAILINGNAME>${esc(inv.vendor_name)}</PARTYMAILINGNAME>
        <NUMBERINGSTYLE>Auto Renumber</NUMBERINGSTYLE>
        <CSTFORMISSUETYPE>${NA}</CSTFORMISSUETYPE>
        <CSTFORMRECVTYPE>${NA}</CSTFORMRECVTYPE>
        <FBTPAYMENTTYPE>Default</FBTPAYMENTTYPE>
        <PERSISTEDVIEW>Invoice Voucher View</PERSISTEDVIEW>
        <VCHSTATUSTAXADJUSTMENT>Default</VCHSTATUSTAXADJUSTMENT>
        <VCHSTATUSVOUCHERTYPE>${esc(voucherTypeName)}</VCHSTATUSVOUCHERTYPE>${cmpTaxUnit ? `\n        <VCHSTATUSTAXUNIT>${esc(cmpTaxUnit)}</VCHSTATUSTAXUNIT>` : ''}
        <VCHGSTCLASS>${NA}</VCHGSTCLASS>
        <VCHENTRYMODE>Item Invoice</VCHENTRYMODE>
        <DIFFACTUALQTY>No</DIFFACTUALQTY>
        <ISMSTFROMSYNC>No</ISMSTFROMSYNC>
        <ISDELETED>No</ISDELETED>
        <ISSECURITYONWHENENTERED>No</ISSECURITYONWHENENTERED>
        <ASORIGINAL>No</ASORIGINAL>
        <AUDITED>No</AUDITED>
        <ISCOMMONPARTY>No</ISCOMMONPARTY>
        <FORJOBCOSTING>No</FORJOBCOSTING>
        <ISOPTIONAL>No</ISOPTIONAL>
        <EFFECTIVEDATE>${d}</EFFECTIVEDATE>
        <USEFOREXCISE>No</USEFOREXCISE>
        <ISFORJOBWORKIN>No</ISFORJOBWORKIN>
        <ALLOWCONSUMPTION>No</ALLOWCONSUMPTION>
        <USEFORINTEREST>No</USEFORINTEREST>
        <USEFORGAINLOSS>No</USEFORGAINLOSS>
        <USEFORGODOWNTRANSFER>No</USEFORGODOWNTRANSFER>
        <USEFORCOMPOUND>No</USEFORCOMPOUND>
        <USEFORSERVICETAX>No</USEFORSERVICETAX>
        <ISREVERSECHARGEAPPLICABLE>No</ISREVERSECHARGEAPPLICABLE>
        <ISSYSTEM>No</ISSYSTEM>
        <ISFETCHEDONLY>No</ISFETCHEDONLY>
        <ISGSTOVERRIDDEN>No</ISGSTOVERRIDDEN>
        <ISCANCELLED>No</ISCANCELLED>
        <ISONHOLD>No</ISONHOLD>
        <ISSUMMARY>No</ISSUMMARY>
        <ISECOMMERCESUPPLY>No</ISECOMMERCESUPPLY>
        <ISBOENOTAPPLICABLE>No</ISBOENOTAPPLICABLE>
        <ISGSTSECSEVENAPPLICABLE>No</ISGSTSECSEVENAPPLICABLE>
        <IGNOREEINVVALIDATION>No</IGNOREEINVVALIDATION>
        <CMPGSTISOTHTERRITORYASSESSEE>No</CMPGSTISOTHTERRITORYASSESSEE>
        <PARTYGSTISOTHTERRITORYASSESSEE>No</PARTYGSTISOTHTERRITORYASSESSEE>
        <IRNJSONEXPORTED>No</IRNJSONEXPORTED>
        <IRNCANCELLED>No</IRNCANCELLED>
        <IGNOREGSTCONFLICTINMIG>No</IGNOREGSTCONFLICTINMIG>
        <ISOPBALTRANSACTION>No</ISOPBALTRANSACTION>
        <IGNOREGSTFORMATVALIDATION>No</IGNOREGSTFORMATVALIDATION>
        <ISELIGIBLEFORITC>Yes</ISELIGIBLEFORITC>
        <IGNOREGSTOPTIONALUNCERTAIN>No</IGNOREGSTOPTIONALUNCERTAIN>
        <UPDATESUMMARYVALUES>No</UPDATESUMMARYVALUES>
        <ISEWAYBILLAPPLICABLE>No</ISEWAYBILLAPPLICABLE>
        <ISDELETEDRETAINED>No</ISDELETEDRETAINED>
        <ISNULL>No</ISNULL>
        <ISEXCISEVOUCHER>No</ISEXCISEVOUCHER>
        <EXCISETAXOVERRIDE>No</EXCISETAXOVERRIDE>
        <USEFORTAXUNITTRANSFER>No</USEFORTAXUNITTRANSFER>
        <ISEXER1NOPOVERWRITE>No</ISEXER1NOPOVERWRITE>
        <ISEXF2NOPOVERWRITE>No</ISEXF2NOPOVERWRITE>
        <ISEXER3NOPOVERWRITE>No</ISEXER3NOPOVERWRITE>
        <IGNOREPOSVALIDATION>No</IGNOREPOSVALIDATION>
        <EXCISEOPENING>No</EXCISEOPENING>
        <USEFORFINALPRODUCTION>No</USEFORFINALPRODUCTION>
        <ISTDSOVERRIDDEN>No</ISTDSOVERRIDDEN>
        <ISTCSOVERRIDDEN>No</ISTCSOVERRIDDEN>
        <ISTDSTCSCASHVCH>No</ISTDSTCSCASHVCH>
        <INCLUDEADVPYMTVCH>No</INCLUDEADVPYMTVCH>
        <ISSUBWORKSCONTRACT>No</ISSUBWORKSCONTRACT>
        <ISVATOVERRIDDEN>No</ISVATOVERRIDDEN>
        <IGNOREORIGVCHDATE>No</IGNOREORIGVCHDATE>
        <ISVATPAIDATCUSTOMS>No</ISVATPAIDATCUSTOMS>
        <ISDECLAREDTOCUSTOMS>No</ISDECLAREDTOCUSTOMS>
        <VATADVANCEPAYMENT>No</VATADVANCEPAYMENT>
        <VATADVPAY>No</VATADVPAY>
        <ISCSTDELCAREDGOODSSALES>No</ISCSTDELCAREDGOODSSALES>
        <ISVATRESTAXINV>No</ISVATRESTAXINV>
        <ISSERVICETAXOVERRIDDEN>No</ISSERVICETAXOVERRIDDEN>
        <ISISDVOUCHER>No</ISISDVOUCHER>
        <ISEXCISEOVERRIDDEN>No</ISEXCISEOVERRIDDEN>
        <ISEXCISESUPPLYVCH>No</ISEXCISESUPPLYVCH>
        <GSTNOTEXPORTED>No</GSTNOTEXPORTED>
        <IGNOREGSTINVALIDATION>No</IGNOREGSTINVALIDATION>
        <ISGSTREFUND>No</ISGSTREFUND>
        <OVRDNEWAYBILLAPPLICABILITY>No</OVRDNEWAYBILLAPPLICABILITY>
        <ISVATPRINCIPALACCOUNT>No</ISVATPRINCIPALACCOUNT>
        <VCHSTATUSISVCHNUMUSED>No</VCHSTATUSISVCHNUMUSED>
        <VCHGSTSTATUSISINCLUDED>Yes</VCHGSTSTATUSISINCLUDED>
        <VCHGSTSTATUSISUNCERTAIN>No</VCHGSTSTATUSISUNCERTAIN>
        <VCHGSTSTATUSISEXCLUDED>No</VCHGSTSTATUSISEXCLUDED>
        <VCHGSTSTATUSISAPPLICABLE>Yes</VCHGSTSTATUSISAPPLICABLE>
        <VCHGSTSTATUSISGSTR2BRECONCILED>No</VCHGSTSTATUSISGSTR2BRECONCILED>
        <VCHGSTSTATUSISGSTR2BONLYINPORTAL>No</VCHGSTSTATUSISGSTR2BONLYINPORTAL>
        <VCHGSTSTATUSISGSTR2BONLYINBOOKS>No</VCHGSTSTATUSISGSTR2BONLYINBOOKS>
        <VCHGSTSTATUSISGSTR2BMISMATCH>No</VCHGSTSTATUSISGSTR2BMISMATCH>
        <VCHGSTSTATUSISGSTR2BINDIFFPERIOD>No</VCHGSTSTATUSISGSTR2BINDIFFPERIOD>
        <VCHGSTSTATUSISRETEFFDATEOVERRDN>No</VCHGSTSTATUSISRETEFFDATEOVERRDN>
        <VCHGSTSTATUSISOVERRDN>No</VCHGSTSTATUSISOVERRDN>
        <VCHGSTSTATUSISSTATINDIFFDATE>No</VCHGSTSTATUSISSTATINDIFFDATE>
        <VCHGSTSTATUSISRETINDIFFDATE>No</VCHGSTSTATUSISRETINDIFFDATE>
        <VCHGSTSTATUSMAINSECTIONEXCLUDED>No</VCHGSTSTATUSMAINSECTIONEXCLUDED>
        <VCHGSTSTATUSISBRANCHTRANSFEROUT>No</VCHGSTSTATUSISBRANCHTRANSFEROUT>
        <VCHGSTSTATUSISSYSTEMSUMMARY>No</VCHGSTSTATUSISSYSTEMSUMMARY>
        <VCHSTATUSISUNREGISTEREDRCM>No</VCHSTATUSISUNREGISTEREDRCM>
        <VCHSTATUSISOPTIONAL>No</VCHSTATUSISOPTIONAL>
        <VCHSTATUSISCANCELLED>No</VCHSTATUSISCANCELLED>
        <VCHSTATUSISDELETED>No</VCHSTATUSISDELETED>
        <VCHSTATUSISOPENINGBALANCE>No</VCHSTATUSISOPENINGBALANCE>
        <VCHSTATUSISFETCHEDONLY>No</VCHSTATUSISFETCHEDONLY>
        <VCHGSTSTATUSISOPTIONALUNCERTAIN>No</VCHGSTSTATUSISOPTIONALUNCERTAIN>
        <VCHSTATUSISREACCEPTFORHSNDONE>No</VCHSTATUSISREACCEPTFORHSNDONE>
        <VCHSTATUSISREACCEPHSNSIXONEDONE>Yes</VCHSTATUSISREACCEPHSNSIXONEDONE>
        <PAYMENTLINKHASMULTIREF>No</PAYMENTLINKHASMULTIREF>
        <ISSHIPPINGWITHINSTATE>No</ISSHIPPINGWITHINSTATE>
        <ISOVERSEASTOURISTTRANS>No</ISOVERSEASTOURISTTRANS>
        <ISDESIGNATEDZONEPARTY>No</ISDESIGNATEDZONEPARTY>
        <HASCASHFLOW>No</HASCASHFLOW>
        <ISPOSTDATED>No</ISPOSTDATED>
        <USETRACKINGNUMBER>No</USETRACKINGNUMBER>
        <ISINVOICE>Yes</ISINVOICE>
        <MFGJOURNAL>No</MFGJOURNAL>
        <HASDISCOUNTS>No</HASDISCOUNTS>
        <ASPAYSLIP>No</ASPAYSLIP>
        <ISCOSTCENTRE>No</ISCOSTCENTRE>
        <ISSTXNONREALIZEDVCH>No</ISSTXNONREALIZEDVCH>
        <ISEXCISEMANUFACTURERON>No</ISEXCISEMANUFACTURERON>
        <ISBLANKCHEQUE>No</ISBLANKCHEQUE>
        <ISVOID>No</ISVOID>
        <ORDERLINESTATUS>No</ORDERLINESTATUS>
        <VATISAGNSTCANCSALES>No</VATISAGNSTCANCSALES>
        <VATISPURCEXEMPTED>No</VATISPURCEXEMPTED>
        <ISVATRESTAXINVOICE>No</ISVATRESTAXINVOICE>
        <VATISASSESABLECALCVCH>No</VATISASSESABLECALCVCH>
        <ISVATDUTYPAID>Yes</ISVATDUTYPAID>
        <ISDELIVERYSAMEASCONSIGNEE>No</ISDELIVERYSAMEASCONSIGNEE>
        <ISDISPATCHSAMEASCONSIGNOR>No</ISDISPATCHSAMEASCONSIGNOR>
        <ISDELETEDVCHRETAINED>No</ISDELETEDVCHRETAINED>
        <VCHONLYADDLINFOUPDATED>No</VCHONLYADDLINFOUPDATED>
        <CHANGEVCHMODE>No</CHANGEVCHMODE>
        <RESETIRNQRCODE>No</RESETIRNQRCODE>
        <EWAYBILLDETAILS.LIST> </EWAYBILLDETAILS.LIST>
        <EXCLUDEDTAXATIONS.LIST> </EXCLUDEDTAXATIONS.LIST>
        <OLDAUDITENTRIES.LIST> </OLDAUDITENTRIES.LIST>
        <ACCOUNTAUDITENTRIES.LIST> </ACCOUNTAUDITENTRIES.LIST>
        <AUDITENTRIES.LIST> </AUDITENTRIES.LIST>
        <DUTYHEADDETAILS.LIST> </DUTYHEADDETAILS.LIST>
        <GSTADVADJDETAILS.LIST> </GSTADVADJDETAILS.LIST>${inventoryXml}
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
        <INVOICEEXPORTLIST.LIST> </INVOICEEXPORTLIST.LIST>${ledgerXml}
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
    `\n        <GSTCLASS> Not Applicable</GSTCLASS>` +
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
    `\n        <INTERESTCOLLECTION.LIST> </INTERESTCOLLECTION.LIST>` +
    `\n        <OLDAUDITENTRIES.LIST> </OLDAUDITENTRIES.LIST>` +
    `\n        <ACCOUNTAUDITENTRIES.LIST> </ACCOUNTAUDITENTRIES.LIST>` +
    `\n        <AUDITENTRIES.LIST> </AUDITENTRIES.LIST>` +
    `\n        <INPUTCRALLOCS.LIST> </INPUTCRALLOCS.LIST>` +
    `\n        <DUTYHEADDETAILS.LIST> </DUTYHEADDETAILS.LIST>` +
    `\n        <EXCISEDUTYHEADDETAILS.LIST> </EXCISEDUTYHEADDETAILS.LIST>` +
    `\n        <RATEDETAILS.LIST> </RATEDETAILS.LIST>` +
    `\n        <SUMMARYALLOCS.LIST> </SUMMARYALLOCS.LIST>` +
    `\n        <CENVATDUTYALLOCATIONS.LIST> </CENVATDUTYALLOCATIONS.LIST>` +
    `\n        <STPYMTDETAILS.LIST> </STPYMTDETAILS.LIST>` +
    `\n        <EXCISEPAYMENTALLOCATIONS.LIST> </EXCISEPAYMENTALLOCATIONS.LIST>` +
    `\n        <TAXBILLALLOCATIONS.LIST> </TAXBILLALLOCATIONS.LIST>` +
    `\n        <TAXOBJECTALLOCATIONS.LIST> </TAXOBJECTALLOCATIONS.LIST>` +
    `\n        <TDSEXPENSEALLOCATIONS.LIST> </TDSEXPENSEALLOCATIONS.LIST>` +
    `\n        <VATSTATUTORYDETAILS.LIST> </VATSTATUTORYDETAILS.LIST>` +
    `\n        <COSTTRACKALLOCATIONS.LIST> </COSTTRACKALLOCATIONS.LIST>` +
    `\n        <REFVOUCHERDETAILS.LIST> </REFVOUCHERDETAILS.LIST>` +
    `\n        <INVOICEWISEDETAILS.LIST> </INVOICEWISEDETAILS.LIST>` +
    `\n        <VATITCDETAILS.LIST> </VATITCDETAILS.LIST>` +
    `\n        <ADVANCETAXDETAILS.LIST> </ADVANCETAXDETAILS.LIST>` +
    `\n        <TAXTYPEALLOCATIONS.LIST> </TAXTYPEALLOCATIONS.LIST>` +
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
    `\n        <GSTOVRDNINELIGIBLEITC> Not Applicable</GSTOVRDNINELIGIBLEITC>` +
    `\n        <GSTOVRDNISREVCHARGEAPPL> Not Applicable</GSTOVRDNISREVCHARGEAPPL>` +
    `\n        <GSTOVRDNTAXABILITY>Taxable</GSTOVRDNTAXABILITY>` +
    `\n        <GSTSOURCETYPE>Stock Item</GSTSOURCETYPE>` +
    `\n        <GSTITEMSOURCE>${esc(stockItem.tally_item_name)}</GSTITEMSOURCE>` +
    `\n        <HSNSOURCETYPE>Stock Item</HSNSOURCETYPE>` +
    `\n        <HSNITEMSOURCE>${esc(stockItem.tally_item_name)}</HSNITEMSOURCE>` +
    `\n        <GSTOVRDNSTOREDNATURE/>` +
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
    `\n          <INDENTNO> Not Applicable</INDENTNO>` +
    `\n          <ORDERNO> Not Applicable</ORDERNO>` +
    `\n          <TRACKINGNUMBER> Not Applicable</TRACKINGNUMBER>` +
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
    `\n          <GSTCLASS> Not Applicable</GSTCLASS>` +
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
  if (!purchaseLedger) return { xml: null, skip: `No purchase ledger set for invoice "${inv.invoice_number}" — accept the invoice first`, warnings };

  let totalItemsAmount = 0;
  let unmappedItemsAmount = 0;
  const invEntries: string[] = [];

  for (const item of inv.line_items) {
    const desc = item.description ?? '';
    const stockItem = findStockItem(input.stockItems, desc, item.hsn, item.gst_percent);
    const itemNet = calcLineAmount(item);
    if (!stockItem) {
      warnings.push(`Stock item "${desc}" (HSN ${item.hsn}) not mapped — booking to purchase ledger`);
      unmappedItemsAmount += itemNet;
      continue;
    }
    totalItemsAmount += itemNet;
    invEntries.push(buildAllInventoryEntry(stockItem, item, purchaseLedger));
  }

  if (invEntries.length === 0) {
    // No line items mapped to stock items — fall back to accounting-only mode so the invoice is not lost
    warnings.push(`No line items could be mapped to stock items — falling back to accounting-only mode`);
    return buildAccountingOnlyVoucher(inv, input);
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
  const taxBase = totalItemsAmount + unmappedItemsAmount - (inv.bill_discount_amount ?? 0);
  if (inv.tax_type === 'cgst_sgst') {
    if (inv.cgst > 0) {
      const rate = taxBase > 0 ? Math.round((inv.cgst / taxBase) * 100) : 0;
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
      const rate = taxBase > 0 ? Math.round((inv.sgst / taxBase) * 100) : 0;
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
    const rate = taxBase > 0 ? Math.round((inv.igst / taxBase) * 100) : 0;
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
  let mappedChargesTotal = 0;
  let unmappedChargesTotal = 0;
  if (inv.charges?.length) {
    for (const charge of inv.charges) {
      if (!charge.amount || charge.amount === 0) continue;
      const ledger = findExpenseLedger(input.expenseLedgers, charge.description);
      if (!ledger) {
        warnings.push(`No expense ledger mapped for charge "${charge.description}" — booking to purchase ledger`);
        unmappedChargesTotal += charge.amount;
        continue;
      }
      mappedChargesTotal += charge.amount;
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

  // 6. Balance catch-up: unmapped items + unmapped charges create a debit gap vs party credit.
  //    Book the gap to the purchase ledger so the voucher always balances in Tally.
  const taxes = (inv.cgst ?? 0) + (inv.sgst ?? 0) + (inv.igst ?? 0);
  const roundOff = inv.round_off ? Math.abs(inv.round_off) : 0;
  const totalDebits = totalItemsAmount + unmappedItemsAmount + taxes + mappedChargesTotal + unmappedChargesTotal + roundOff;
  const gap = parseFloat((inv.total - totalDebits).toFixed(2));
  if (Math.abs(gap) > 0.01) {
    warnings.push(`Balance gap ₹${fmt2(Math.abs(gap))} in "${inv.invoice_number}" (rounding/data diff) — adjusted in purchase ledger`);
    ledgerEntries.push(invChargeLedgerEntry(purchaseLedger, -(unmappedItemsAmount + unmappedChargesTotal + gap)));
  } else if (unmappedItemsAmount + unmappedChargesTotal > 0) {
    // No gap but unmapped items/charges still need a purchase ledger debit entry
    ledgerEntries.push(invChargeLedgerEntry(purchaseLedger, -(unmappedItemsAmount + unmappedChargesTotal)));
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
//
// ══════════════════════════════════════════════════════════════════════════════
// TALLY XML IMPORT — VERIFIED WORKING SCHEMA (tested June 2025)
// ══════════════════════════════════════════════════════════════════════════════
//
// OUTPUT FORMAT REQUIREMENTS (critical — any deviation causes silent rejection):
//
//   1. ENCODING     UTF-16 LE with BOM (bytes FF FE at start of file).
//                   Tally rejects UTF-8 files silently.
//                   See triggerDownload() in xml/page.tsx.
//
//   2. NO XML DECL  Do NOT include <?xml version="1.0"?> — Tally's export
//                   omits it and the import parser expects no declaration.
//
//   3. SENTINEL     Tally stores "Not Applicable" fields as the literal Unicode
//                   control character U+0004 (EOT) followed by " Not Applicable".
//                   Write this as the actual character , NOT the XML entity
//                   &#4; — the UTF-16 encoder writes strings verbatim, so any
//                   XML entity text ends up as literal characters in the file.
//                   Same rule applies to  Applicable,  Any, etc.
//
//   4. CURRENCY     Use the actual ₹ character (U+20B9), NOT &#x20B9;.
//                   Same reason as above — the encoder writes it verbatim.
//
// ══════════════════════════════════════════════════════════════════════════════
// VERIFIED FIELD ORDER PER MASTER TYPE (reverse-engineered from Tally export)
// ══════════════════════════════════════════════════════════════════════════════
//
// ALL 5 MASTER TYPES share this common tail structure (after the type-specific
// header fields):
//   [LEDGER_BOOLEANS] → SORTPOSITION → ALTERID →
//   [LEDGER_EMPTY_LISTS: SERVICETAXDETAILS, LBTREGNDETAILS, VATDETAILS, SALESTAXCESSDETAILS] →
//   GSTDETAILS.LIST → HSNDETAILS.LIST → MSMEREGISTRATIONDETAILS.LIST →
//   LANGUAGENAME.LIST → [LEDGER_TAIL_LISTS_1: XBRLDETAIL..TCSMETHODOFCALCULATION] →
//   LEDGSTREGDETAILS.LIST → LEDMAILINGDETAILS.LIST →
//   [LEDGER_TAIL_LISTS_2: GSTRECONPREFIXSUFFIXDETAILS..DEFMULTIPLETOPHONENO]
//
// ── 1. SUNDRY CREDITORS (suppliers) ──────────────────────────────────────────
//   OLDMAILINGNAME.LIST → OLDAUDITENTRYIDS.LIST → STARTINGFROM → GUID →
//   CURRENCYNAME(₹) → PRIORSTATENAME → GSTREGISTRATIONTYPE → VATDEALERTYPE →
//   PARENT(Sundry Creditors) → TAXCLASSIFICATIONNAME → TAXTYPE(Others) →
//   COUNTRYOFRESIDENCE(India) → LEDADDLALLOCTYPE → GSTTYPE → APPROPRIATEFOR →
//   PARTYGSTIN → GSTTYPEOFSUPPLY(Services) → OLDLEDSTATENAME →
//   SERVICECATEGORY → EXCISELEDGERCLASSIFICATION → EXCISEDUTYTYPE →
//   EXCISENATUREOFPURCHASE → LEDGERFBTCATEGORY → OLDCOUNTRYNAME(India) →
//   [tail]
//   LEDGSTREGDETAILS: APPLICABLEFROM, GSTREGISTRATIONTYPE, STATE, PLACEOFSUPPLY,
//                     GSTIN, ISOTHTERRITORYASSESSEE(No), CONSIDERPURCHASEFOREXPORT(No),
//                     ISTRANSPORTER(No), ISCOMMONPARTY(No)
//   LEDMAILINGDETAILS: APPLICABLEFROM, MAILINGNAME, STATE, COUNTRY(India)
//
// ── 2. PURCHASE LEDGERS ────────────────────────────────────────────────────────
//   OLDAUDITENTRYIDS.LIST → STARTINGFROM → GUID →
//   CURRENCYNAME(₹) → PARENT(Purchase Accounts) → GSTAPPLICABLE → TAXTYPE(Others) →
//   GSTTYPEOFSUPPLY(Goods) → VATAPPLICABLE → AFFECTSSTOCK(Yes) →
//   TAXCLASSIFICATIONNAME → GSTTYPE → APPROPRIATEFOR → SERVICECATEGORY →
//   EXCISE* → LEDGERFBTCATEGORY → [tail]
//   GSTDETAILS.LIST: APPLICABLEFROM, TAXABILITY(Taxable), SRCOFGSTDETAILS,
//                    STATEWISEDETAILS with CGST/SGST/IGST/Cess/StateCess rates
//   LEDMAILINGDETAILS: APPLICABLEFROM, MAILINGNAME
//
// ── 3. DUTIES & TAXES ──────────────────────────────────────────────────────────
//   OLDAUDITENTRYIDS.LIST → STARTINGFROM → GUID →
//   CURRENCYNAME(₹) → PARENT(Duties & Taxes) → TAXCLASSIFICATIONNAME →
//   TAXTYPE(GST) → GSTTYPE → APPROPRIATEFOR →
//   GSTDUTYHEAD(CGST|SGST/UTGST|IGST) → GSTTYPEOFSUPPLY(Services) →
//   ROUNDINGMETHOD → SERVICECATEGORY → EXCISE* → LEDGERFBTCATEGORY → [tail]
//   LEDGSTREGDETAILS: empty    LEDMAILINGDETAILS: empty
//   NOTE: No OLDMAILINGNAME.LIST for this type.
//
// ── 4. EXPENSE / CHARGE LEDGERS ────────────────────────────────────────────────
//   OLDMAILINGNAME.LIST → OLDAUDITENTRYIDS.LIST → STARTINGFROM → GUID →
//   CURRENCYNAME(₹) → PARENT(Indirect Expenses) → GSTAPPLICABLE →
//   TAXCLASSIFICATIONNAME → TAXTYPE(Others) → LEDADDLALLOCTYPE → GSTTYPE →
//   APPROPRIATEFOR → GSTTYPEOFSUPPLY(Services) → SERVICECATEGORY → EXCISE* →
//   LEDGERFBTCATEGORY → VATAPPLICABLE → [tail]
//   GSTDETAILS.LIST: same structure as Purchase with actual GST rate
//   HSNDETAILS.LIST: APPLICABLEFROM, HSNCODE(SAC), SRCOFHSNDETAILS
//   LEDMAILINGDETAILS: APPLICABLEFROM, MAILINGNAME
//   NOTE: VATAPPLICABLE comes AFTER LEDGERFBTCATEGORY (not before it).
//
// ── 5. STOCK ITEMS ─────────────────────────────────────────────────────────────
//   Emit UNIT blocks first (TYPEOFUPDATEACTIVITY=Migration, OBJECTUPDATEACTION=Alter).
//   Then STOCKITEM blocks: PARENT(empty) → GSTAPPLICABLE → GSTTYPEOFSUPPLY(Goods) →
//   BASEUNITS → booleans → GSTDETAILS.LIST(with rates) → HSNDETAILS.LIST →
//   LANGUAGENAME.LIST
//
// IMPORT ORDER: Always import masters BEFORE vouchers. Within masters, the
// combined XML emits in this order: Creditors → Purchase → Duties → Expense →
// Units → Stock Items. Tally skips duplicates safely on re-import.
// ══════════════════════════════════════════════════════════════════════════════

// Returns the FY start date in YYYYMMDD Tally format.
// Uses the financialYear string from XmlGeneratorInput (e.g. 'FY 2024-25')
// which reflects the period the user has selected in TallyAI.
function fyStartFromString(financialYear?: string): string {
  if (financialYear) {
    const m = financialYear.match(/FY (\d{4})/);
    if (m) return `${m[1]}0401`;
  }
  // Fallback: derive from system date (should not normally be reached)
  const now = new Date();
  const fyYear = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  return `${fyYear}0401`;
}

// Tally-native boolean flags — full set Tally itself exports for every ledger
const LEDGER_BOOLEANS = `
      <ISBILLWISEON>No</ISBILLWISEON>
      <ISCOSTCENTRESON>No</ISCOSTCENTRESON>
      <ISINTERESTON>No</ISINTERESTON>
      <ALLOWINMOBILE>No</ALLOWINMOBILE>
      <ISCOSTTRACKINGON>No</ISCOSTTRACKINGON>
      <ISBENEFICIARYCODEON>No</ISBENEFICIARYCODEON>
      <ISEXPORTONVCHCREATE>No</ISEXPORTONVCHCREATE>
      <PLASINCOMEEXPENSE>No</PLASINCOMEEXPENSE>
      <ISUPDATINGTARGETID>No</ISUPDATINGTARGETID>
      <ISDELETED>No</ISDELETED>
      <ISSECURITYONWHENENTERED>No</ISSECURITYONWHENENTERED>
      <ASORIGINAL>Yes</ASORIGINAL>
      <ISCONDENSED>No</ISCONDENSED>
      <AFFECTSSTOCK>No</AFFECTSSTOCK>
      <ISRATEINCLUSIVEVAT>No</ISRATEINCLUSIVEVAT>
      <FORPAYROLL>No</FORPAYROLL>
      <ISABCENABLED>No</ISABCENABLED>
      <ISCREDITDAYSCHKON>No</ISCREDITDAYSCHKON>
      <INTERESTONBILLWISE>No</INTERESTONBILLWISE>
      <OVERRIDEINTEREST>No</OVERRIDEINTEREST>
      <OVERRIDEADVINTEREST>No</OVERRIDEADVINTEREST>
      <USEFORVAT>No</USEFORVAT>
      <IGNORETDSEXEMPT>No</IGNORETDSEXEMPT>
      <ISTCSAPPLICABLE>No</ISTCSAPPLICABLE>
      <ISTDSAPPLICABLE>No</ISTDSAPPLICABLE>
      <ISFBTAPPLICABLE>No</ISFBTAPPLICABLE>
      <ISGSTAPPLICABLE>No</ISGSTAPPLICABLE>
      <ISEXCISEAPPLICABLE>No</ISEXCISEAPPLICABLE>
      <ISTDSEXPENSE>No</ISTDSEXPENSE>
      <ISEDLIAPPLICABLE>No</ISEDLIAPPLICABLE>
      <ISRELATEDPARTY>No</ISRELATEDPARTY>
      <USEFORESIELIGIBILITY>No</USEFORESIELIGIBILITY>
      <ISINTERESTINCLLASTDAY>No</ISINTERESTINCLLASTDAY>
      <APPROPRIATETAXVALUE>No</APPROPRIATETAXVALUE>
      <ISBEHAVEASDUTY>No</ISBEHAVEASDUTY>
      <INTERESTINCLDAYOFADDITION>No</INTERESTINCLDAYOFADDITION>
      <INTERESTINCLDAYOFDEDUCTION>No</INTERESTINCLDAYOFDEDUCTION>
      <ISOTHTERRITORYASSESSEE>No</ISOTHTERRITORYASSESSEE>
      <IGNOREMISMATCHWITHWARNING>No</IGNOREMISMATCHWITHWARNING>
      <USEASNOTIONALBANK>No</USEASNOTIONALBANK>
      <BEHAVEASPAYMENTGATEWAY>No</BEHAVEASPAYMENTGATEWAY>
      <OVERRIDECREDITLIMIT>No</OVERRIDECREDITLIMIT>
      <ISAGAINSTFORMC>No</ISAGAINSTFORMC>
      <ISCHEQUEPRINTINGENABLED>No</ISCHEQUEPRINTINGENABLED>
      <ISPAYUPLOAD>No</ISPAYUPLOAD>
      <ISPAYBATCHONLYSAL>No</ISPAYBATCHONLYSAL>
      <ISBNFCODESUPPORTED>No</ISBNFCODESUPPORTED>
      <ALLOWEXPORTWITHERRORS>No</ALLOWEXPORTWITHERRORS>
      <CONSIDERPURCHASEFOREXPORT>No</CONSIDERPURCHASEFOREXPORT>
      <ISTRANSPORTER>No</ISTRANSPORTER>
      <ISECASHLEDGER>No</ISECASHLEDGER>
      <USEFORNOTIONALITC>No</USEFORNOTIONALITC>
      <ISECOMMOPERATOR>No</ISECOMMOPERATOR>
      <OVERRIDEBASEDONREALIZATION>No</OVERRIDEBASEDONREALIZATION>
      <ISECDIFFINSDATE>No</ISECDIFFINSDATE>
      <SHOWINPAYSLIP>No</SHOWINPAYSLIP>
      <USEFORGRATUITY>No</USEFORGRATUITY>
      <ISTDSPROJECTED>No</ISTDSPROJECTED>
      <ISSALARYMULFILE>No</ISSALARYMULFILE>
      <FORSERVICETAX>No</FORSERVICETAX>
      <ISINPUTCREDIT>No</ISINPUTCREDIT>
      <ISEXEMPTED>No</ISEXEMPTED>
      <ISABATEMENTAPPLICABLE>No</ISABATEMENTAPPLICABLE>
      <ISSTXPARTY>No</ISSTXPARTY>
      <ISSTXNONREALIZEDTYPE>No</ISSTXNONREALIZEDTYPE>
      <USEFORKKC>No</USEFORKKC>
      <USEFORSBC>No</USEFORSBC>
      <ISUSEDFORCVD>No</ISUSEDFORCVD>
      <LEDBELONGSTONONTAXABLE>No</LEDBELONGSTONONTAXABLE>
      <ISEXCISEMERCHANTEXPORTER>No</ISEXCISEMERCHANTEXPORTER>
      <ISPARTYEXEMPTED>No</ISPARTYEXEMPTED>
      <ISSEZPARTY>No</ISSEZPARTY>
      <TDSDEDUCTEEISSPECIALRATE>No</TDSDEDUCTEEISSPECIALRATE>
      <ISECHEQUESUPPORTED>No</ISECHEQUESUPPORTED>
      <ISEDDSUPPORTED>No</ISEDDSUPPORTED>
      <HASECHEQUEDELIVERYMODE>No</HASECHEQUEDELIVERYMODE>
      <HASECHEQUEDELIVERYTO>No</HASECHEQUEDELIVERYTO>
      <HASECHEQUEPRINTLOCATION>No</HASECHEQUEPRINTLOCATION>
      <HASECHEQUEPAYABLELOCATION>No</HASECHEQUEPAYABLELOCATION>
      <HASECHEQUEBANKLOCATION>No</HASECHEQUEBANKLOCATION>
      <HASEDDDELIVERYMODE>No</HASEDDDELIVERYMODE>
      <HASEDDDELIVERYTO>No</HASEDDDELIVERYTO>
      <HASEDDPRINTLOCATION>No</HASEDDPRINTLOCATION>
      <HASEDDPAYABLELOCATION>No</HASEDDPAYABLELOCATION>
      <HASEDDBANKLOCATION>No</HASEDDBANKLOCATION>
      <ISEBANKINGENABLED>No</ISEBANKINGENABLED>
      <ISEXPORTFILEENCRYPTED>No</ISEXPORTFILEENCRYPTED>
      <ISBATCHENABLED>No</ISBATCHENABLED>
      <ISPRODUCTCODEBASED>No</ISPRODUCTCODEBASED>
      <HASEDDCITY>No</HASEDDCITY>
      <HASECHEQUECITY>No</HASECHEQUECITY>
      <ISFILENAMEFORMATSUPPORTED>No</ISFILENAMEFORMATSUPPORTED>
      <HASCLIENTCODE>No</HASCLIENTCODE>
      <PAYINSISBATCHAPPLICABLE>No</PAYINSISBATCHAPPLICABLE>
      <PAYINSISFILENUMAPP>No</PAYINSISFILENUMAPP>
      <ISSALARYTRANSGROUPEDFORBRS>No</ISSALARYTRANSGROUPEDFORBRS>
      <ISEBANKINGSUPPORTED>No</ISEBANKINGSUPPORTED>
      <ISSCBUAE>No</ISSCBUAE>
      <ISBANKSTATUSAPP>No</ISBANKSTATUSAPP>
      <ISSALARYGROUPED>No</ISSALARYGROUPED>
      <USEFORPURCHASETAX>No</USEFORPURCHASETAX>
      <BANKISRECONCILEPERFECTMATCHES>No</BANKISRECONCILEPERFECTMATCHES>
      <ISPYMTADVONLINE>No</ISPYMTADVONLINE>
      <ISPYMTADVCCENABLED>No</ISPYMTADVCCENABLED>
      <ISINCLUDEPYMTADVBILLWISE>No</ISINCLUDEPYMTADVBILLWISE>
      <AUDITED>No</AUDITED>`;

// 4 always-empty lists that come before GSTDETAILS/HSNDETAILS
const LEDGER_EMPTY_LISTS = `
      <SERVICETAXDETAILS.LIST>      </SERVICETAXDETAILS.LIST>
      <LBTREGNDETAILS.LIST>      </LBTREGNDETAILS.LIST>
      <VATDETAILS.LIST>      </VATDETAILS.LIST>
      <SALESTAXCESSDETAILS.LIST>      </SALESTAXCESSDETAILS.LIST>`;

// Lists after LANGUAGENAME — up to (not including) LEDGSTREGDETAILS
const LEDGER_TAIL_LISTS_1 = `
      <XBRLDETAIL.LIST>      </XBRLDETAIL.LIST>
      <AUDITDETAILS.LIST>      </AUDITDETAILS.LIST>
      <SCHVIDETAILS.LIST>      </SCHVIDETAILS.LIST>
      <EXCISETARIFFDETAILS.LIST>      </EXCISETARIFFDETAILS.LIST>
      <TCSCATEGORYDETAILS.LIST>      </TCSCATEGORYDETAILS.LIST>
      <TDSCATEGORYDETAILS.LIST>      </TDSCATEGORYDETAILS.LIST>
      <SLABPERIOD.LIST>      </SLABPERIOD.LIST>
      <GRATUITYPERIOD.LIST>      </GRATUITYPERIOD.LIST>
      <ADDITIONALCOMPUTATIONS.LIST>      </ADDITIONALCOMPUTATIONS.LIST>
      <EXCISEJURISDICTIONDETAILS.LIST>      </EXCISEJURISDICTIONDETAILS.LIST>
      <EXCLUDEDTAXATIONS.LIST>      </EXCLUDEDTAXATIONS.LIST>
      <BANKALLOCATIONS.LIST>      </BANKALLOCATIONS.LIST>
      <PAYMENTDETAILS.LIST>      </PAYMENTDETAILS.LIST>
      <BANKEXPORTFORMATS.LIST>      </BANKEXPORTFORMATS.LIST>
      <TRANSFERMODELIMITDETAILS.LIST>      </TRANSFERMODELIMITDETAILS.LIST>
      <BILLALLOCATIONS.LIST>      </BILLALLOCATIONS.LIST>
      <INTERESTCOLLECTION.LIST>      </INTERESTCOLLECTION.LIST>
      <LEDGERCLOSINGVALUES.LIST>      </LEDGERCLOSINGVALUES.LIST>
      <LEDGERAUDITCLASS.LIST>      </LEDGERAUDITCLASS.LIST>
      <OLDAUDITENTRIES.LIST>      </OLDAUDITENTRIES.LIST>
      <TDSEXEMPTIONRULES.LIST>      </TDSEXEMPTIONRULES.LIST>
      <DEDUCTINSAMEVCHRULES.LIST>      </DEDUCTINSAMEVCHRULES.LIST>
      <LOWERDEDUCTION.LIST>      </LOWERDEDUCTION.LIST>
      <STXABATEMENTDETAILS.LIST>      </STXABATEMENTDETAILS.LIST>
      <LEDMULTIADDRESSLIST.LIST>      </LEDMULTIADDRESSLIST.LIST>
      <STXTAXDETAILS.LIST>      </STXTAXDETAILS.LIST>
      <CHEQUERANGE.LIST>      </CHEQUERANGE.LIST>
      <DEFAULTVCHCHEQUEDETAILS.LIST>      </DEFAULTVCHCHEQUEDETAILS.LIST>
      <ACCOUNTAUDITENTRIES.LIST>      </ACCOUNTAUDITENTRIES.LIST>
      <AUDITENTRIES.LIST>      </AUDITENTRIES.LIST>
      <BRSIMPORTEDINFO.LIST>      </BRSIMPORTEDINFO.LIST>
      <AUTOBRSCONFIGS.LIST>      </AUTOBRSCONFIGS.LIST>
      <BANKURENTRIES.LIST>      </BANKURENTRIES.LIST>
      <DEFAULTCHEQUEDETAILS.LIST>      </DEFAULTCHEQUEDETAILS.LIST>
      <DEFAULTOPENINGCHEQUEDETAILS.LIST>      </DEFAULTOPENINGCHEQUEDETAILS.LIST>
      <CANCELLEDPAYALLOCATIONS.LIST>      </CANCELLEDPAYALLOCATIONS.LIST>
      <ECHEQUEPRINTLOCATION.LIST>      </ECHEQUEPRINTLOCATION.LIST>
      <ECHEQUEPAYABLELOCATION.LIST>      </ECHEQUEPAYABLELOCATION.LIST>
      <EDDPRINTLOCATION.LIST>      </EDDPRINTLOCATION.LIST>
      <EDDPAYABLELOCATION.LIST>      </EDDPAYABLELOCATION.LIST>
      <AVAILABLETRANSACTIONTYPES.LIST>      </AVAILABLETRANSACTIONTYPES.LIST>
      <LEDPAYINSCONFIGS.LIST>      </LEDPAYINSCONFIGS.LIST>
      <TYPECODEDETAILS.LIST>      </TYPECODEDETAILS.LIST>
      <FIELDVALIDATIONDETAILS.LIST>      </FIELDVALIDATIONDETAILS.LIST>
      <INPUTCRALLOCS.LIST>      </INPUTCRALLOCS.LIST>
      <TCSMETHODOFCALCULATION.LIST>      </TCSMETHODOFCALCULATION.LIST>`;

// Lists after LEDGSTREGDETAILS/LEDMAILINGDETAILS
const LEDGER_TAIL_LISTS_2 = `
      <GSTRECONPREFIXSUFFIXDETAILS.LIST>      </GSTRECONPREFIXSUFFIXDETAILS.LIST>
      <CONTACTDETAILS.LIST>      </CONTACTDETAILS.LIST>
      <GSTCLASSFNIGSTRATES.LIST>      </GSTCLASSFNIGSTRATES.LIST>
      <EXTARIFFDUTYHEADDETAILS.LIST>      </EXTARIFFDUTYHEADDETAILS.LIST>
      <TEMPGSTITEMSLABRATES.LIST>      </TEMPGSTITEMSLABRATES.LIST>
      <LEDGSTADDRESS.LIST>      </LEDGSTADDRESS.LIST>
      <VOUCHERTYPEPRODUCTCODES.LIST>      </VOUCHERTYPEPRODUCTCODES.LIST>
      <LEDADDRESS.LIST>      </LEDADDRESS.LIST>
      <DEFMULTIPLETOPHONENO.LIST>      </DEFMULTIPLETOPHONENO.LIST>`;

function masterLedgerBlock(
  name: string,
  fyStart: string,
  coreFields: string,
  gstBlock: string,
  hsnBlock: string,
  ledgstRegBlock: string,
  mailingBlock: string,
): string {
  return `
    <TALLYMESSAGE xmlns:UDF="TallyUDF">
      <LEDGER NAME="${name}" RESERVEDNAME="">
      <OLDAUDITENTRYIDS.LIST TYPE="Number">
       <OLDAUDITENTRYIDS>-1</OLDAUDITENTRYIDS>
      </OLDAUDITENTRYIDS.LIST>
      <STARTINGFROM>${fyStart}</STARTINGFROM>
      <GUID></GUID>
      ${coreFields}
      <TAXCLASSIFICATIONNAME> Not Applicable</TAXCLASSIFICATIONNAME>
      <GSTTYPE> Not Applicable</GSTTYPE>
      <APPROPRIATEFOR> Not Applicable</APPROPRIATEFOR>
      <SERVICECATEGORY> Not Applicable</SERVICECATEGORY>
      <EXCISELEDGERCLASSIFICATION> Not Applicable</EXCISELEDGERCLASSIFICATION>
      <EXCISEDUTYTYPE> Not Applicable</EXCISEDUTYTYPE>
      <EXCISENATUREOFPURCHASE> Not Applicable</EXCISENATUREOFPURCHASE>
      <LEDGERFBTCATEGORY> Not Applicable</LEDGERFBTCATEGORY>${LEDGER_BOOLEANS}${LEDGER_EMPTY_LISTS}
      <GSTDETAILS.LIST>${gstBlock}</GSTDETAILS.LIST>
      <HSNDETAILS.LIST>${hsnBlock}</HSNDETAILS.LIST>
      <MSMEREGISTRATIONDETAILS.LIST>      </MSMEREGISTRATIONDETAILS.LIST>
      <LANGUAGENAME.LIST>
       <NAME.LIST TYPE="String">
        <NAME>${name}</NAME>
       </NAME.LIST>
       <LANGUAGEID> 1033</LANGUAGEID>
      </LANGUAGENAME.LIST>${LEDGER_TAIL_LISTS_1}
      <LEDGSTREGDETAILS.LIST>${ledgstRegBlock}</LEDGSTREGDETAILS.LIST>
      <LEDMAILINGDETAILS.LIST>${mailingBlock}</LEDMAILINGDETAILS.LIST>${LEDGER_TAIL_LISTS_2}
     </LEDGER>
    </TALLYMESSAGE>`;
}

function buildSupplierMasterBlock(s: SupplierMaster, fyStart: string): string {
  const regType = s.is_unregistered ? 'Unregistered' : 'Regular';
  const name = esc(s.tally_ledger_name);
  const vendorState = stateFromGstin(s.vendor_gstin);

  const ledgstRegBlock = s.vendor_gstin
    ? `
       <APPLICABLEFROM>${fyStart}</APPLICABLEFROM>
       <GSTREGISTRATIONTYPE>${regType}</GSTREGISTRATIONTYPE>
       <STATE>${esc(vendorState)}</STATE>
       <PLACEOFSUPPLY>${esc(vendorState)}</PLACEOFSUPPLY>
       <GSTIN>${esc(s.vendor_gstin)}</GSTIN>
       <ISOTHTERRITORYASSESSEE>No</ISOTHTERRITORYASSESSEE>
       <CONSIDERPURCHASEFOREXPORT>No</CONSIDERPURCHASEFOREXPORT>
       <ISTRANSPORTER>No</ISTRANSPORTER>
       <ISCOMMONPARTY>No</ISCOMMONPARTY>
      `
    : '      ';

  const mailingBlock = `
       <APPLICABLEFROM>${fyStart}</APPLICABLEFROM>
       <MAILINGNAME>${name}</MAILINGNAME>${vendorState ? `\n       <STATE>${esc(vendorState)}</STATE>` : ''}
       <COUNTRY>India</COUNTRY>
      `;

  // Exact field order matching Tally's own export for Sundry Creditor ledgers
  return `
    <TALLYMESSAGE xmlns:UDF="TallyUDF">
     <LEDGER NAME="${name}" RESERVEDNAME="">
      <OLDMAILINGNAME.LIST TYPE="String">
       <OLDMAILINGNAME>${name}</OLDMAILINGNAME>
      </OLDMAILINGNAME.LIST>
      <OLDAUDITENTRYIDS.LIST TYPE="Number">
       <OLDAUDITENTRYIDS>-1</OLDAUDITENTRYIDS>
      </OLDAUDITENTRYIDS.LIST>
      <STARTINGFROM>${fyStart}</STARTINGFROM>
      <GUID></GUID>
      <CURRENCYNAME>₹</CURRENCYNAME>${vendorState ? `\n      <PRIORSTATENAME>${esc(vendorState)}</PRIORSTATENAME>` : ''}
      <GSTREGISTRATIONTYPE>${regType}</GSTREGISTRATIONTYPE>
      <VATDEALERTYPE>${regType}</VATDEALERTYPE>
      <PARENT>Sundry Creditors</PARENT>
      <TAXCLASSIFICATIONNAME> Not Applicable</TAXCLASSIFICATIONNAME>
      <TAXTYPE>Others</TAXTYPE>
      <COUNTRYOFRESIDENCE>India</COUNTRYOFRESIDENCE>
      <LEDADDLALLOCTYPE> Not Applicable</LEDADDLALLOCTYPE>
      <GSTTYPE> Not Applicable</GSTTYPE>
      <APPROPRIATEFOR> Not Applicable</APPROPRIATEFOR>${s.vendor_gstin ? `\n      <PARTYGSTIN>${esc(s.vendor_gstin)}</PARTYGSTIN>` : ''}
      <GSTTYPEOFSUPPLY>Services</GSTTYPEOFSUPPLY>${vendorState ? `\n      <OLDLEDSTATENAME>${esc(vendorState)}</OLDLEDSTATENAME>` : ''}
      <SERVICECATEGORY> Not Applicable</SERVICECATEGORY>
      <EXCISELEDGERCLASSIFICATION> Not Applicable</EXCISELEDGERCLASSIFICATION>
      <EXCISEDUTYTYPE> Not Applicable</EXCISEDUTYTYPE>
      <EXCISENATUREOFPURCHASE> Not Applicable</EXCISENATUREOFPURCHASE>
      <LEDGERFBTCATEGORY> Not Applicable</LEDGERFBTCATEGORY>
      <OLDCOUNTRYNAME>India</OLDCOUNTRYNAME>${LEDGER_BOOLEANS}
      <SORTPOSITION> 1000</SORTPOSITION>
      <ALTERID> 0</ALTERID>${LEDGER_EMPTY_LISTS}
      <GSTDETAILS.LIST>      </GSTDETAILS.LIST>
      <HSNDETAILS.LIST>      </HSNDETAILS.LIST>
      <MSMEREGISTRATIONDETAILS.LIST>      </MSMEREGISTRATIONDETAILS.LIST>
      <LANGUAGENAME.LIST>
       <NAME.LIST TYPE="String">
        <NAME>${name}</NAME>
       </NAME.LIST>
       <LANGUAGEID> 1033</LANGUAGEID>
      </LANGUAGENAME.LIST>${LEDGER_TAIL_LISTS_1}
      <LEDGSTREGDETAILS.LIST>${ledgstRegBlock}</LEDGSTREGDETAILS.LIST>
      <LEDMAILINGDETAILS.LIST>${mailingBlock}</LEDMAILINGDETAILS.LIST>${LEDGER_TAIL_LISTS_2}
     </LEDGER>
    </TALLYMESSAGE>`;
}

function buildPurchaseLedgerBlock(pl: PurchaseLedgerEntry, fyStart: string): string {
  const coreFields = `<CURRENCYNAME>₹</CURRENCYNAME>
      <PARENT>Purchase Accounts</PARENT>
      <GSTAPPLICABLE> Applicable</GSTAPPLICABLE>
      <TAXTYPE>Others</TAXTYPE>
      <GSTTYPEOFSUPPLY>Goods</GSTTYPEOFSUPPLY>
      <VATAPPLICABLE> Applicable</VATAPPLICABLE>
      <AFFECTSSTOCK>Yes</AFFECTSSTOCK>`;

  const gstBlock = `
        <APPLICABLEFROM>${fyStart}</APPLICABLEFROM>
        <TAXABILITY>Taxable</TAXABILITY>
        <SRCOFGSTDETAILS>Specify Details Here</SRCOFGSTDETAILS>
        <GSTCALCSLABONMRP>No</GSTCALCSLABONMRP>
        <ISREVERSECHARGEAPPLICABLE>No</ISREVERSECHARGEAPPLICABLE>
        <ISNONGSTGOODS>No</ISNONGSTGOODS>
        <GSTINELIGIBLEITC>No</GSTINELIGIBLEITC>
        <INCLUDEEXPFORSLABCALC>No</INCLUDEEXPFORSLABCALC>
        <STATEWISEDETAILS.LIST>
          <STATENAME> Any</STATENAME>
          <RATEDETAILS.LIST>
            <GSTRATEDUTYHEAD>CGST</GSTRATEDUTYHEAD>
            <GSTRATEVALUATIONTYPE>Based on Value</GSTRATEVALUATIONTYPE>
            <GSTRATE> 0</GSTRATE>
          </RATEDETAILS.LIST>
          <RATEDETAILS.LIST>
            <GSTRATEDUTYHEAD>SGST/UTGST</GSTRATEDUTYHEAD>
            <GSTRATEVALUATIONTYPE>Based on Value</GSTRATEVALUATIONTYPE>
            <GSTRATE> 0</GSTRATE>
          </RATEDETAILS.LIST>
          <RATEDETAILS.LIST>
            <GSTRATEDUTYHEAD>IGST</GSTRATEDUTYHEAD>
            <GSTRATEVALUATIONTYPE>Based on Value</GSTRATEVALUATIONTYPE>
            <GSTRATE> 0</GSTRATE>
          </RATEDETAILS.LIST>
          <RATEDETAILS.LIST>
            <GSTRATEDUTYHEAD>Cess</GSTRATEDUTYHEAD>
            <GSTRATEVALUATIONTYPE> Not Applicable</GSTRATEVALUATIONTYPE>
          </RATEDETAILS.LIST>
          <RATEDETAILS.LIST>
            <GSTRATEDUTYHEAD>State Cess</GSTRATEDUTYHEAD>
            <GSTRATEVALUATIONTYPE>Based on Value</GSTRATEVALUATIONTYPE>
          </RATEDETAILS.LIST>
          <GSTSLABRATES.LIST>        </GSTSLABRATES.LIST>
        </STATEWISEDETAILS.LIST>
        <TEMPGSTITEMSLABRATES.LIST>       </TEMPGSTITEMSLABRATES.LIST>
        <TEMPGSTDETAILSLABRATES.LIST>       </TEMPGSTDETAILSLABRATES.LIST>
      `;

  const mailingBlock = `
        <APPLICABLEFROM>${fyStart}</APPLICABLEFROM>
        <MAILINGNAME>${esc(pl.tally_ledger_name)}</MAILINGNAME>
      `;

  return masterLedgerBlock(esc(pl.tally_ledger_name), fyStart, coreFields, gstBlock, '', '      ', mailingBlock);
}

function buildTaxLedgerBlock(dt: DutiesTaxesMaster, fyStart: string): string {
  const dutyHeadMap: Record<string, string> = { CGST: 'CGST', SGST: 'SGST/UTGST', IGST: 'IGST' };
  const dutyHead = dutyHeadMap[dt.tax_component] ?? dt.tax_component;
  const name = esc(dt.tally_ledger_name);

  // Exact field order matching Tally's own export for Duties & Taxes ledgers
  return `
    <TALLYMESSAGE xmlns:UDF="TallyUDF">
     <LEDGER NAME="${name}" RESERVEDNAME="">
      <OLDAUDITENTRYIDS.LIST TYPE="Number">
       <OLDAUDITENTRYIDS>-1</OLDAUDITENTRYIDS>
      </OLDAUDITENTRYIDS.LIST>
      <STARTINGFROM>${fyStart}</STARTINGFROM>
      <GUID></GUID>
      <CURRENCYNAME>₹</CURRENCYNAME>
      <PARENT>Duties &amp; Taxes</PARENT>
      <TAXCLASSIFICATIONNAME> Not Applicable</TAXCLASSIFICATIONNAME>
      <TAXTYPE>GST</TAXTYPE>
      <GSTTYPE> Not Applicable</GSTTYPE>
      <APPROPRIATEFOR> Not Applicable</APPROPRIATEFOR>
      <GSTDUTYHEAD>${esc(dutyHead)}</GSTDUTYHEAD>
      <GSTTYPEOFSUPPLY>Services</GSTTYPEOFSUPPLY>
      <ROUNDINGMETHOD> Not Applicable</ROUNDINGMETHOD>
      <SERVICECATEGORY> Not Applicable</SERVICECATEGORY>
      <EXCISELEDGERCLASSIFICATION> Not Applicable</EXCISELEDGERCLASSIFICATION>
      <EXCISEDUTYTYPE> Not Applicable</EXCISEDUTYTYPE>
      <EXCISENATUREOFPURCHASE> Not Applicable</EXCISENATUREOFPURCHASE>
      <LEDGERFBTCATEGORY> Not Applicable</LEDGERFBTCATEGORY>${LEDGER_BOOLEANS}
      <SORTPOSITION> 1000</SORTPOSITION>
      <ALTERID> 0</ALTERID>${LEDGER_EMPTY_LISTS}
      <GSTDETAILS.LIST>      </GSTDETAILS.LIST>
      <HSNDETAILS.LIST>      </HSNDETAILS.LIST>
      <MSMEREGISTRATIONDETAILS.LIST>      </MSMEREGISTRATIONDETAILS.LIST>
      <LANGUAGENAME.LIST>
       <NAME.LIST TYPE="String">
        <NAME>${name}</NAME>
       </NAME.LIST>
       <LANGUAGEID> 1033</LANGUAGEID>
      </LANGUAGENAME.LIST>${LEDGER_TAIL_LISTS_1}
      <LEDGSTREGDETAILS.LIST>      </LEDGSTREGDETAILS.LIST>
      <LEDMAILINGDETAILS.LIST>      </LEDMAILINGDETAILS.LIST>${LEDGER_TAIL_LISTS_2}
     </LEDGER>
    </TALLYMESSAGE>`;
}

function buildExpenseLedgerBlock(el: ExpenseLedgerMaster, fyStart: string): string {
  const gst = el.gst_percent && el.gst_percent > 0 ? el.gst_percent : null;
  const half = gst ? gst / 2 : 0;
  const name = esc(el.tally_ledger_name);

  const gstBlock = gst
    ? `
       <APPLICABLEFROM>${fyStart}</APPLICABLEFROM>
       <TAXABILITY>Taxable</TAXABILITY>
       <SRCOFGSTDETAILS>Specify Details Here</SRCOFGSTDETAILS>
       <GSTCALCSLABONMRP>No</GSTCALCSLABONMRP>
       <ISREVERSECHARGEAPPLICABLE>No</ISREVERSECHARGEAPPLICABLE>
       <ISNONGSTGOODS>No</ISNONGSTGOODS>
       <GSTINELIGIBLEITC>No</GSTINELIGIBLEITC>
       <INCLUDEEXPFORSLABCALC>No</INCLUDEEXPFORSLABCALC>
       <STATEWISEDETAILS.LIST>
        <STATENAME> Any</STATENAME>
        <RATEDETAILS.LIST>
         <GSTRATEDUTYHEAD>CGST</GSTRATEDUTYHEAD>
         <GSTRATEVALUATIONTYPE>Based on Value</GSTRATEVALUATIONTYPE>
         <GSTRATE> ${half}</GSTRATE>
        </RATEDETAILS.LIST>
        <RATEDETAILS.LIST>
         <GSTRATEDUTYHEAD>SGST/UTGST</GSTRATEDUTYHEAD>
         <GSTRATEVALUATIONTYPE>Based on Value</GSTRATEVALUATIONTYPE>
         <GSTRATE> ${half}</GSTRATE>
        </RATEDETAILS.LIST>
        <RATEDETAILS.LIST>
         <GSTRATEDUTYHEAD>IGST</GSTRATEDUTYHEAD>
         <GSTRATEVALUATIONTYPE>Based on Value</GSTRATEVALUATIONTYPE>
         <GSTRATE> ${gst}</GSTRATE>
        </RATEDETAILS.LIST>
        <RATEDETAILS.LIST>
         <GSTRATEDUTYHEAD>Cess</GSTRATEDUTYHEAD>
         <GSTRATEVALUATIONTYPE> Not Applicable</GSTRATEVALUATIONTYPE>
        </RATEDETAILS.LIST>
        <RATEDETAILS.LIST>
         <GSTRATEDUTYHEAD>State Cess</GSTRATEDUTYHEAD>
         <GSTRATEVALUATIONTYPE>Based on Value</GSTRATEVALUATIONTYPE>
        </RATEDETAILS.LIST>
        <GSTSLABRATES.LIST>        </GSTSLABRATES.LIST>
       </STATEWISEDETAILS.LIST>
       <TEMPGSTITEMSLABRATES.LIST>       </TEMPGSTITEMSLABRATES.LIST>
       <TEMPGSTDETAILSLABRATES.LIST>       </TEMPGSTDETAILSLABRATES.LIST>
      `
    : '';

  const hsnBlock = el.sac_code
    ? `
       <APPLICABLEFROM>${fyStart}</APPLICABLEFROM>
       <HSNCODE>${esc(el.sac_code)}</HSNCODE>
       <SRCOFHSNDETAILS>Specify Details Here</SRCOFHSNDETAILS>
      `
    : '';

  // Exact field order matching Tally's own export for Indirect Expense ledgers
  return `
    <TALLYMESSAGE xmlns:UDF="TallyUDF">
     <LEDGER NAME="${name}" RESERVEDNAME="">
      <OLDMAILINGNAME.LIST TYPE="String">
       <OLDMAILINGNAME>${name}</OLDMAILINGNAME>
      </OLDMAILINGNAME.LIST>
      <OLDAUDITENTRYIDS.LIST TYPE="Number">
       <OLDAUDITENTRYIDS>-1</OLDAUDITENTRYIDS>
      </OLDAUDITENTRYIDS.LIST>
      <STARTINGFROM>${fyStart}</STARTINGFROM>
      <GUID></GUID>
      <CURRENCYNAME>₹</CURRENCYNAME>
      <PARENT>Indirect Expenses</PARENT>
      <GSTAPPLICABLE> Applicable</GSTAPPLICABLE>
      <TAXCLASSIFICATIONNAME> Not Applicable</TAXCLASSIFICATIONNAME>
      <TAXTYPE>Others</TAXTYPE>
      <LEDADDLALLOCTYPE> Not Applicable</LEDADDLALLOCTYPE>
      <GSTTYPE> Not Applicable</GSTTYPE>
      <APPROPRIATEFOR> Not Applicable</APPROPRIATEFOR>
      <GSTTYPEOFSUPPLY>Services</GSTTYPEOFSUPPLY>
      <SERVICECATEGORY> Not Applicable</SERVICECATEGORY>
      <EXCISELEDGERCLASSIFICATION> Not Applicable</EXCISELEDGERCLASSIFICATION>
      <EXCISEDUTYTYPE> Not Applicable</EXCISEDUTYTYPE>
      <EXCISENATUREOFPURCHASE> Not Applicable</EXCISENATUREOFPURCHASE>
      <LEDGERFBTCATEGORY> Not Applicable</LEDGERFBTCATEGORY>
      <VATAPPLICABLE> Not Applicable</VATAPPLICABLE>${LEDGER_BOOLEANS}
      <SORTPOSITION> 1000</SORTPOSITION>
      <ALTERID> 0</ALTERID>${LEDGER_EMPTY_LISTS}
      <GSTDETAILS.LIST>${gstBlock}</GSTDETAILS.LIST>
      <HSNDETAILS.LIST>${hsnBlock}</HSNDETAILS.LIST>
      <MSMEREGISTRATIONDETAILS.LIST>      </MSMEREGISTRATIONDETAILS.LIST>
      <LANGUAGENAME.LIST>
       <NAME.LIST TYPE="String">
        <NAME>${name}</NAME>
       </NAME.LIST>
       <LANGUAGEID> 1033</LANGUAGEID>
      </LANGUAGENAME.LIST>${LEDGER_TAIL_LISTS_1}
      <LEDGSTREGDETAILS.LIST>      </LEDGSTREGDETAILS.LIST>
      <LEDMAILINGDETAILS.LIST>
       <APPLICABLEFROM>${fyStart}</APPLICABLEFROM>
       <MAILINGNAME>${name}</MAILINGNAME>
      </LEDMAILINGDETAILS.LIST>${LEDGER_TAIL_LISTS_2}
     </LEDGER>
    </TALLYMESSAGE>`;
}


const UNIT_FORMAL_NAMES: Record<string, string> = {
  'Nos': 'Numbers', 'NOS': 'Numbers', 'nos': 'Numbers',
  'Pcs': 'Pieces', 'PCS': 'Pieces', 'pcs': 'Pieces', 'pc': 'Pieces', 'PC': 'Pieces',
  'Kg': 'Kilograms', 'KG': 'Kilograms', 'kg': 'Kilograms',
  'Gm': 'Grams', 'GM': 'Grams', 'gm': 'Grams', 'g': 'Grams',
  'Mtr': 'Metres', 'MTR': 'Metres', 'mtr': 'Metres', 'm': 'Metres',
  'Ltr': 'Litres', 'LTR': 'Litres', 'ltr': 'Litres', 'L': 'Litres',
  'Box': 'Boxes', 'BOX': 'Boxes', 'box': 'Boxes',
  'Set': 'Sets', 'SET': 'Sets', 'set': 'Sets',
  'Doz': 'Dozens', 'DOZ': 'Dozens', 'doz': 'Dozens',
  'Pair': 'Pairs', 'PAIR': 'Pairs', 'pair': 'Pairs',
  'Roll': 'Rolls', 'ROLL': 'Rolls', 'roll': 'Rolls',
  'Bag': 'Bags', 'BAG': 'Bags', 'bag': 'Bags',
};

function buildUnitBlock(unitName: string, fyStart: string): string {
  const formalName = UNIT_FORMAL_NAMES[unitName] ?? `${unitName} Unit`;
  const gstRepUom = `${unitName.toUpperCase()}-${formalName.replace(/\s+/g, '').toUpperCase()}`;
  const fyStart2 = fyStart;
  return `
    <TALLYMESSAGE xmlns:UDF="TallyUDF">
      <UNIT NAME="${esc(unitName)}" RESERVEDNAME="">
        <NAME>${esc(unitName)}</NAME>
        <TYPEOFUPDATEACTIVITY>Migration</TYPEOFUPDATEACTIVITY>
        <OBJECTUPDATEACTION>Alter</OBJECTUPDATEACTION>
        <ORIGINALNAME>${esc(formalName)}</ORIGINALNAME>
        <GSTREPORUOM>${esc(gstRepUom)}</GSTREPORUOM>
        <ISUPDATINGTARGETID>No</ISUPDATINGTARGETID>
        <ISDELETED>No</ISDELETED>
        <ISSECURITYONWHENENTERED>No</ISSECURITYONWHENENTERED>
        <ASORIGINAL>Yes</ASORIGINAL>
        <ISGSTEXCLUDED>No</ISGSTEXCLUDED>
        <ISSIMPLEUNIT>Yes</ISSIMPLEUNIT>
        <DECIMALPLACES>2</DECIMALPLACES>
        <REPORTINGUQCDETAILS.LIST>
          <APPLICABLEFROM>${fyStart2}</APPLICABLEFROM>
          <REPORTINGUQCNAME>${esc(gstRepUom)}</REPORTINGUQCNAME>
        </REPORTINGUQCDETAILS.LIST>
      </UNIT>
    </TALLYMESSAGE>`;
}

function buildStockItemBlock(s: StockItemMaster, gstPercent: number, fyStart: string): string {
  const halfRate = gstPercent / 2;
  const unit = s.unit || 'Nos';

  const gstDetailsBlock = gstPercent > 0 ? `
        <GSTDETAILS.LIST>
          <APPLICABLEFROM>${fyStart}</APPLICABLEFROM>
          <CALCULATIONTYPE>On Value</CALCULATIONTYPE>
          <TAXABILITY>Taxable</TAXABILITY>
          <SRCOFGSTDETAILS>Specify Details Here</SRCOFGSTDETAILS>
          <GSTCALCSLABONMRP>No</GSTCALCSLABONMRP>
          <ISREVERSECHARGEAPPLICABLE>No</ISREVERSECHARGEAPPLICABLE>
          <ISNONGSTGOODS>No</ISNONGSTGOODS>
          <GSTINELIGIBLEITC>No</GSTINELIGIBLEITC>
          <INCLUDEEXPFORSLABCALC>No</INCLUDEEXPFORSLABCALC>
          <STATEWISEDETAILS.LIST>
            <STATENAME> Any</STATENAME>
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
            <RATEDETAILS.LIST>
              <GSTRATEDUTYHEAD>Cess</GSTRATEDUTYHEAD>
              <GSTRATEVALUATIONTYPE> Not Applicable</GSTRATEVALUATIONTYPE>
            </RATEDETAILS.LIST>
            <RATEDETAILS.LIST>
              <GSTRATEDUTYHEAD>State Cess</GSTRATEDUTYHEAD>
              <GSTRATEVALUATIONTYPE>Based on Value</GSTRATEVALUATIONTYPE>
            </RATEDETAILS.LIST>
            <GSTSLABRATES.LIST>        </GSTSLABRATES.LIST>
          </STATEWISEDETAILS.LIST>
          <TEMPGSTITEMSLABRATES.LIST>       </TEMPGSTITEMSLABRATES.LIST>
          <TEMPGSTDETAILSLABRATES.LIST>       </TEMPGSTDETAILSLABRATES.LIST>
        </GSTDETAILS.LIST>` : '';

  const hsnBlock = s.hsn_code ? `
        <HSNDETAILS.LIST>
          <APPLICABLEFROM>${fyStart}</APPLICABLEFROM>
          <HSNCODE>${esc(s.hsn_code)}</HSNCODE>
          <SRCOFHSNDETAILS>Specify Details Here</SRCOFHSNDETAILS>
        </HSNDETAILS.LIST>` : '';

  return `
    <TALLYMESSAGE xmlns:UDF="TallyUDF">
      <STOCKITEM NAME="${esc(s.tally_item_name)}" RESERVEDNAME="">
        <TYPEOFUPDATEACTIVITY>Migration</TYPEOFUPDATEACTIVITY>
        <OBJECTUPDATEACTION>Alter</OBJECTUPDATEACTION>
        <PARENT/>
        <GSTAPPLICABLE> Applicable</GSTAPPLICABLE>
        <GSTTYPEOFSUPPLY>Goods</GSTTYPEOFSUPPLY>
        <BASEUNITS>${esc(unit)}</BASEUNITS>
        <ISCOSTCENTRESON>No</ISCOSTCENTRESON>
        <ISBATCHWISEON>No</ISBATCHWISEON>
        <ISUPDATINGTARGETID>No</ISUPDATINGTARGETID>
        <ISDELETED>No</ISDELETED>
        <ISSECURITYONWHENENTERED>No</ISSECURITYONWHENENTERED>
        <ASORIGINAL>Yes</ASORIGINAL>${gstDetailsBlock}${hsnBlock}
        <LANGUAGENAME.LIST>
          <NAME.LIST TYPE="String">
            <NAME>${esc(s.tally_item_name)}</NAME>
          </NAME.LIST>
          <LANGUAGEID> 1033</LANGUAGEID>
        </LANGUAGENAME.LIST>
      </STOCKITEM>
    </TALLYMESSAGE>`;
}

export type MasterType = 'all' | 'stock_items' | 'purchase_ledgers' | 'expense_ledgers' | 'duties_taxes' | 'suppliers' | 'ledgers_only';

function buildMasterMessages(input: XmlGeneratorInput, type: MasterType): string[] {
  const messages: string[] = [];
  const fyStart = fyStartFromString(input.financialYear);

  const includeSuppliers  = type === 'all' || type === 'suppliers'  || type === 'ledgers_only';
  const includePurchase   = type === 'all' || type === 'purchase_ledgers' || type === 'ledgers_only';
  const includeDuties     = type === 'all' || type === 'duties_taxes'     || type === 'ledgers_only';
  const includeExpense    = type === 'all' || type === 'expense_ledgers'  || type === 'ledgers_only';
  const includeStockItems = type === 'all' || type === 'stock_items';

  if (includeSuppliers) {
    const seenSuppliers = new Set<string>();
    for (const inv of input.invoices) {
      const supplier = findSupplier(input.suppliers, inv.vendor_gstin, inv.vendor_name);
      if (supplier && !seenSuppliers.has(supplier.tally_ledger_name)) {
        seenSuppliers.add(supplier.tally_ledger_name);
        messages.push(buildSupplierMasterBlock(supplier, fyStart));
      }
    }
  }

  if (includePurchase) {
    const seenPurchase = new Set<string>();
    for (const inv of input.invoices) {
      const pl = inv.tally_ledger_acceptance?.purchaseLedger;
      if (pl && !seenPurchase.has(pl)) {
        seenPurchase.add(pl);
        messages.push(buildPurchaseLedgerBlock({ gst_percent: null, tally_ledger_name: pl }, fyStart));
      }
    }
  }

  if (includeDuties) {
    const seenDuties = new Set<string>();
    for (const dt of input.dutiesTaxes) {
      if (!seenDuties.has(dt.tally_ledger_name)) {
        seenDuties.add(dt.tally_ledger_name);
        messages.push(buildTaxLedgerBlock(dt, fyStart));
      }
    }
  }

  if (includeExpense) {
    const seenExpense = new Set<string>();
    for (const el of input.expenseLedgers) {
      if (!seenExpense.has(el.tally_ledger_name)) {
        seenExpense.add(el.tally_ledger_name);
        messages.push(buildExpenseLedgerBlock(el, fyStart));
      }
    }
  }

  if (includeStockItems) {
    // Build a map of invoice-extracted GST rates as fallback when master has no gst_percent
    const invoiceRateMap = new Map<string, number>();
    for (const inv of input.invoices) {
      for (const item of inv.line_items) {
        const stockItem = findStockItem(input.stockItems, item.description ?? '', item.hsn, item.gst_percent);
        if (stockItem && !invoiceRateMap.has(stockItem.tally_item_name)) {
          invoiceRateMap.set(stockItem.tally_item_name, item.gst_percent ?? 0);
        }
      }
    }

    // In inventory mode, only emit items that appear in the current invoice batch.
    // In standalone masters export (non-inventory), emit all stock items.
    const itemsToExport = input.voucherMode === 'inventory'
      ? input.stockItems.filter((s) => invoiceRateMap.has(s.tally_item_name))
      : input.stockItems;

    const seenUnits = new Set<string>();
    for (const s of itemsToExport) {
      const unit = s.unit || 'Nos';
      if (!seenUnits.has(unit)) { seenUnits.add(unit); messages.push(buildUnitBlock(unit, fyStart)); }
    }
    for (const stockItem of itemsToExport) {
      // Prefer stored gst_percent from master; fall back to invoice-extracted rate
      const rate = stockItem.gst_percent ?? invoiceRateMap.get(stockItem.tally_item_name) ?? 0;
      messages.push(buildStockItemBlock(stockItem, rate, fyStart));
    }
  }

  return messages;
}


export function generateMastersXml(input: XmlGeneratorInput, type: MasterType = 'all'): string {
  const messages = buildMasterMessages(input, type);
  return `<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Import Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>All Masters</REPORTNAME>
        <STATICVARIABLES>
          <SVCURRENTCOMPANY>${esc(input.tallyCompanyName)}</SVCURRENTCOMPANY>
        </STATICVARIABLES>
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
  const masterMessages = buildMasterMessages(input, 'all');

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

  const xml = `<ENVELOPE>
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

  const xml = `<ENVELOPE>
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
  // Expense/charge fields — from extracted invoice charge data
  charge_gst_percent?: number;
  charge_sac_code?: string;
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
        rows.push({
          ...base,
          ledger_type: 'Expense',
          tally_ledger_name: l ?? charge.description,
          amount: charge.amount,
          status: l ? 'OK' : 'Suggested',
          is_suggested: !l,
          item_description: charge.description,
          charge_gst_percent: charge.gst_percent ?? undefined,
          charge_sac_code: (charge as { sac?: string }).sac ?? undefined,
        });
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
      const stockItem = findStockItem(input.stockItems, desc, item.hsn, item.gst_percent);
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
        rows.push({
          ...base,
          ledger_type: 'Expense',
          tally_ledger_name: l ?? charge.description,
          amount: charge.amount,
          status: l ? 'OK' : 'Suggested',
          is_suggested: !l,
          item_description: charge.description,
          charge_gst_percent: charge.gst_percent ?? undefined,
          charge_sac_code: (charge as { sac?: string }).sac ?? undefined,
        });
      }
    }

    if (inv.round_off && Math.abs(inv.round_off) > 0.001) {
      const l = findExpenseLedger(input.expenseLedgers, 'Round Off') ?? findExpenseLedger(input.expenseLedgers, 'Rounding Off');
      rows.push({ ...base, ledger_type: 'Round Off', tally_ledger_name: l ?? 'Round Off', amount: inv.round_off, status: l ? 'OK' : 'Suggested', is_suggested: !l });
    }
  }
  return rows;
}
