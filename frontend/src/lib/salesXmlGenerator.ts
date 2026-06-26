// Tally XML Generator - Sales Voucher Import
//
// Adapted from xmlGenerator.ts (purchase). Key differences:
//   - Voucher type: "Sales"
//   - Party = customer (buyer_gstin / buyer_name); our company is the seller.
//   - Dr/Cr INVERSION:
//       Customer ledger : POSITIVE (debit  — customer owes us)
//       Sales ledger    : NEGATIVE (credit — our income)
//       CGST/SGST/IGST   : NEGATIVE (credit — output tax liability)
//   - GSTREGISTRATIONTYPE: "Regular" (B2B with GSTIN), "Unregistered" (named B2C).
//   - All ledger/item names output VERBATIM from masters - no trim, no change.
//   - Encoding handled by the page (UTF-16 LE + BOM).

import type { StoredInvoice, LineItem } from '@/types/invoice';
import type { CustomerMaster } from './customers';
import type { DutiesTaxesMaster } from './dutiesTaxes';
import type { StockItemMaster } from './stockItems';
import type { ExpenseLedgerMaster } from './expenseLedgers';
import { calcLineAmount, buildFullTaxSummary } from '@/types/invoice';
import { deriveInvoiceFinancials } from './invoiceCalculations';
import { isPooledLedger } from './partyKey';
import { resolveUom, getCanonical } from './uomRegistry';
import { suggestStockItem } from './xmlGenerator';

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

const SALES_VOUCHER_TYPE = 'Sales';

export interface SalesXmlGeneratorInput {
  invoices: StoredInvoice[];
  customers: CustomerMaster[];
  dutiesTaxes: DutiesTaxesMaster[];
  stockItems: StockItemMaster[];
  expenseLedgers: ExpenseLedgerMaster[];
  tallyCompanyName: string;
  financialYear?: string;
  voucherMode?: 'accounting_only' | 'inventory';
  companyGstin?: string;
  companyState?: string;
  stockItemMode?: 'hsn_driven' | null;
}

export interface SalesXmlGeneratorResult {
  xml: string;
  includedCount: number;
  skippedInvoices: Array<{ invoice_number: string; reason: string }>;
  warnings: Array<{ invoice_number: string; warning: string }>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt2(n: number): string { return n.toFixed(2); }

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

function norm(s: string): string { return (s ?? '').toLowerCase().trim(); }

// Find the customer ledger for an invoice. GSTIN is definitive; for B2C (no GSTIN)
// fall back to exact name match, then null (use buyer_name as ledger).
function findCustomer(customers: CustomerMaster[], gstin: string | null, name: string): CustomerMaster | null {
  if (gstin) {
    const g = norm(gstin);
    return customers.find((c) => norm(c.customer_gstin ?? '') === g) ?? null;
  }
  const n = norm(name);
  return customers.find((c) => norm(c.customer_name) === n || norm(c.tally_ledger_name) === n) ?? null;
}

// Output tax ledger: prefer rate-specific, then consolidated preferring "Output" ledgers.
function findOutputTaxLedger(dutiesTaxes: DutiesTaxesMaster[], component: string, rate: number): string | null {
  const comp = component.toUpperCase();
  const specific = dutiesTaxes.find((d) => d.tax_component === comp && d.tax_rate === rate);
  if (specific) return specific.tally_ledger_name;
  const consolidated = dutiesTaxes.filter((d) => d.tax_component === comp && d.tax_rate == null);
  if (consolidated.length === 0) return null;
  const output = consolidated.find((d) => d.tally_ledger_name.toLowerCase().startsWith('output'));
  return (output ?? consolidated[0]).tally_ledger_name;
}


// ─── Accounting-only voucher ──────────────────────────────────────────────────

interface VoucherResult { xml: string | null; skip?: string; warnings: string[]; }

function ledgerEntry(name: string, isDeemedPositive: 'Yes' | 'No', amount: number): string {
  return `\n      <ALLLEDGERENTRIES.LIST>\n        <LEDGERNAME>${esc(name)}</LEDGERNAME>\n        <ISDEEMEDPOSITIVE>${isDeemedPositive}</ISDEEMEDPOSITIVE>\n        <AMOUNT>${fmt2(amount)}</AMOUNT>\n      </ALLLEDGERENTRIES.LIST>`;
}

function wrapSalesVoucher(inv: StoredInvoice, partyLedger: string, ledgerXml: string): string {
  const narration = `${esc(inv.buyer_name ?? '')} | ${esc(inv.invoice_number)} | ${inv.invoice_date}`;
  const d = tallyDate(inv.invoice_date);
  return `
    <TALLYMESSAGE xmlns:UDF="TallyUDF">
      <VOUCHER VCHTYPE="${esc(SALES_VOUCHER_TYPE)}" ACTION="Create" OBJVIEW="Accounting Voucher View">
        <DATE>${d}</DATE>
        <VOUCHERTYPENAME>${esc(SALES_VOUCHER_TYPE)}</VOUCHERTYPENAME>
        <PARTYLEDGERNAME>${esc(partyLedger)}</PARTYLEDGERNAME>
        <VOUCHERNUMBER>${esc(inv.invoice_number)}</VOUCHERNUMBER>
        <ISINVOICE>Yes</ISINVOICE>
        <NARRATION>${narration}</NARRATION>${ledgerXml}
      </VOUCHER>
    </TALLYMESSAGE>`;
}

function buildSalesVoucher(inv: StoredInvoice, input: SalesXmlGeneratorInput): VoucherResult {
  const warnings: string[] = [];
  const d = deriveInvoiceFinancials(inv);
  const acc = inv.tally_ledger_acceptance as unknown as Record<string, string> | null;

  // Party ledger: acceptance takes precedence; fall back to master resolution then raw name.
  const accCustomer = acc?.customerLedger?.trim() ?? '';
  const resolvedCustomer = findCustomer(input.customers, inv.buyer_gstin, inv.buyer_name ?? '');
  const partyLedger = accCustomer || resolvedCustomer?.tally_ledger_name || (inv.buyer_name ?? '');
  if (!partyLedger) return { xml: null, skip: 'No customer ledger and no customer name', warnings };
  if (!accCustomer && !resolvedCustomer) warnings.push(`Customer "${inv.buyer_name}" not in master - using customer name as ledger`);

  // Sales ledger: must come from per-invoice acceptance.
  const salesLedger = acc?.salesLedger?.trim() ?? '';
  if (!salesLedger) return { xml: null, skip: `No sales ledger set for invoice "${inv.invoice_number}" - accept the invoice first`, warnings };

  // HSN rows from shared canonical engine (same values as DB and UI).
  const hsnRows = buildFullTaxSummary(inv.line_items ?? [], d.charges_resolved, inv.tax_type, inv.bill_discount_amount ?? 0);

  const entries: string[] = [];

  // 1. Customer ledger: DEBIT (positive) — customer owes us.
  entries.push(ledgerEntry(partyLedger, 'Yes', d.total));

  // 2. Sales ledger: CREDIT (negative) split by HSN group taxable.
  for (const row of hsnRows) {
    if (Math.abs(row.taxable) > 0.001) {
      entries.push(ledgerEntry(salesLedger, 'No', -row.taxable));
    }
  }

  // 3. Output tax ledgers: CREDIT (negative).
  //    Emit based on computed amounts — not inv.tax_type — so null tax_type invoices
  //    are handled correctly. CGST/SGST and IGST are mutually exclusive per sale.
  if (Math.abs(d.cgst) > 0.001) {
    const l = acc?.cgstLedger?.trim()
      || findOutputTaxLedger(input.dutiesTaxes, 'CGST', Math.round(d.cgst / Math.max(d.net_goods_taxable + d.taxable_charges_total, 1) * 100))
      || findOutputTaxLedger(input.dutiesTaxes, 'CGST', 0);
    if (!l) return { xml: null, skip: 'No CGST ledger configured', warnings };
    entries.push(ledgerEntry(l, 'No', -d.cgst));
  }
  if (Math.abs(d.sgst) > 0.001) {
    const l = acc?.sgstLedger?.trim()
      || findOutputTaxLedger(input.dutiesTaxes, 'SGST', Math.round(d.sgst / Math.max(d.net_goods_taxable + d.taxable_charges_total, 1) * 100))
      || findOutputTaxLedger(input.dutiesTaxes, 'SGST', 0);
    if (!l) return { xml: null, skip: 'No SGST ledger configured', warnings };
    entries.push(ledgerEntry(l, 'No', -d.sgst));
  }
  if (Math.abs(d.igst) > 0.001) {
    const l = acc?.igstLedger?.trim()
      || findOutputTaxLedger(input.dutiesTaxes, 'IGST', Math.round(d.igst / Math.max(d.net_goods_taxable + d.taxable_charges_total, 1) * 100))
      || findOutputTaxLedger(input.dutiesTaxes, 'IGST', 0);
    if (!l) return { xml: null, skip: 'No IGST ledger configured', warnings };
    entries.push(ledgerEntry(l, 'No', -d.igst));
  }

  // 4. Charges (income) — CREDIT. Use expense ledger mapping by description.
  if (inv.charges?.length) {
    for (const charge of inv.charges) {
      if (!charge.amount || charge.amount === 0) continue;
      const q = norm(charge.description);
      const el = input.expenseLedgers.find((l) => l.expense_keyword && norm(l.expense_keyword) === q)
        ?? input.expenseLedgers.find((l) => norm(l.tally_ledger_name) === q);
      if (!el) {
        warnings.push(`No ledger mapped for charge "${charge.description}" - charge excluded from XML`);
        continue;
      }
      entries.push(ledgerEntry(el.tally_ledger_name, 'No', -Math.abs(charge.amount)));
    }
  }

  // 5. Round-off: use accepted roLedger, then expense master, then default.
  if (Math.abs(d.round_off) > 0.001) {
    const roLedger = acc?.roLedger?.trim()
      || input.expenseLedgers.find((l) => norm(l.tally_ledger_name).includes('round'))?.tally_ledger_name
      || 'Round Off';
    entries.push(ledgerEntry(roLedger, d.round_off > 0 ? 'No' : 'Yes', -d.round_off));
  }

  return { xml: wrapSalesVoucher(inv, partyLedger, entries.join('')), warnings };
}

// ─── Inventory-mode helpers ───────────────────────────────────────────────────

function generateGuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function findSalesStockItem(
  stockItems: StockItemMaster[],
  description: string,
  hsn?: string,
  gstRate?: number,
  mode?: 'hsn_driven' | null,
): StockItemMaster | null {
  if (mode === 'hsn_driven') {
    if (!hsn) return null;
    const cleanHsn = hsn.replace(/[\s.]/g, '');
    // Require exact HSN + rate match; no rate-agnostic fallback (would map wrong rate items)
    if (gstRate != null) {
      const byHsn = stockItems.find(
        (s) => s.hsn_code && s.hsn_code.replace(/[\s.]/g, '') === cleanHsn && s.gst_percent === gstRate,
      );
      if (byHsn) {
        // Sanity-check: name must not encode a different rate
        const nameRate = byHsn.tally_item_name.match(/@\s*(\d+(?:\.\d+)?)\s*%/i);
        if (!nameRate || Number(nameRate[1]) === gstRate) return byHsn;
      }
    }
    return null;
  }
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
  if (hsn && gstRate != null) {
    const cleanHsn = hsn.replace(/[\s.]/g, '');
    const byHsn = stockItems.find(
      (s) => s.hsn_code && s.hsn_code.replace(/[\s.]/g, '') === cleanHsn && s.gst_percent === gstRate,
    );
    if (byHsn) return byHsn;
    const byHsnOnly = stockItems.find(
      (s) => s.hsn_code && s.hsn_code.replace(/[\s.]/g, '') === cleanHsn,
    );
    if (byHsnOnly) return byHsnOnly;
  }
  return null;
}

/** LEDGERENTRIES.LIST block for sales inventory mode — mirrors invLedgerEntry from xmlGenerator.ts */
function invSalesLedgerEntry(opts: {
  ledgerName: string;
  isdeemedpositive: 'Yes' | 'No';
  isPartyledger: 'Yes' | 'No';
  islastdeemedpositive: 'Yes' | 'No';
  amount: number;
  billRefName?: string;
  rateOfInvoiceTax?: number;
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
    `\n        <GSTCLASS> Not Applicable</GSTCLASS>` +
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

/** Simpler LEDGERENTRIES.LIST for income/charge ledgers in sales inventory mode */
function invSalesIncomeLedgerEntry(ledgerName: string, amount: number): string {
  return (
    `\n      <LEDGERENTRIES.LIST>` +
    `\n        <LEDGERNAME>${esc(ledgerName)}</LEDGERNAME>` +
    `\n        <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>` +
    `\n        <ISPARTYLEDGER>No</ISPARTYLEDGER>` +
    `\n        <ISLASTDEEMEDPOSITIVE>No</ISLASTDEEMEDPOSITIVE>` +
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

/** ALLINVENTORYENTRIES.LIST for one sales line item — stock OUT */
function buildSalesAllInventoryEntry(
  stockItem: StockItemMaster,
  item: LineItem,
  salesLedger: string,
): string {
  const itemNet = calcLineAmount(item);
  const uom = resolveUom(stockItem.unit, item.uom);
  // Sales: stock goes OUT. Positive amount, ISDEEMEDPOSITIVE=No (opposite of purchase).
  const posAmt = itemNet;
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
    `\n        <GSTOVRDNINELIGIBLEITC> Not Applicable</GSTOVRDNINELIGIBLEITC>` +
    `\n        <GSTOVRDNISREVCHARGEAPPL> Not Applicable</GSTOVRDNISREVCHARGEAPPL>` +
    `\n        <GSTOVRDNTAXABILITY>Taxable</GSTOVRDNTAXABILITY>` +
    `\n        <GSTSOURCETYPE>Stock Item</GSTSOURCETYPE>` +
    `\n        <GSTITEMSOURCE>${esc(stockItem.tally_item_name)}</GSTITEMSOURCE>` +
    `\n        <HSNSOURCETYPE>Stock Item</HSNSOURCETYPE>` +
    `\n        <HSNITEMSOURCE>${esc(stockItem.tally_item_name)}</HSNITEMSOURCE>` +
    `\n        <GSTOVRDNSTOREDNATURE/>` +
    `\n        <GSTOVRDNTYPEOFSUPPLY>Goods</GSTOVRDNTYPEOFSUPPLY>` +
    `\n        <GSTRATEINFERAPPLICABILITY>As per Masters/Company</GSTRATEINFERAPPLICABILITY>` +
    hsnBlock +
    `\n        <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>` +
    `\n        <ISGSTASSESSABLEVALUEOVERRIDDEN>No</ISGSTASSESSABLEVALUEOVERRIDDEN>` +
    `\n        <STRDISGSTAPPLICABLE>No</STRDISGSTAPPLICABLE>` +
    `\n        <CONTENTNEGISPOS>No</CONTENTNEGISPOS>` +
    `\n        <ISLASTDEEMEDPOSITIVE>No</ISLASTDEEMEDPOSITIVE>` +
    `\n        <ISAUTONEGATE>No</ISAUTONEGATE>` +
    `\n        <ISCUSTOMSCLEARANCE>No</ISCUSTOMSCLEARANCE>` +
    `\n        <ISTRACKCOMPONENT>No</ISTRACKCOMPONENT>` +
    `\n        <ISTRACKPRODUCTION>No</ISTRACKPRODUCTION>` +
    `\n        <ISPRIMARYITEM>No</ISPRIMARYITEM>` +
    `\n        <ISSCRAP>No</ISSCRAP>` +
    `\n        <RATE>${fmt2(Math.abs(item.rate))}/${esc(uom)}</RATE>` +
    discLine +
    `\n        <AMOUNT>${fmt2(posAmt)}</AMOUNT>` +
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
    `\n          <AMOUNT>${fmt2(posAmt)}</AMOUNT>` +
    `\n          <ACTUALQTY> ${fmt2(item.qty)} ${esc(uom)}</ACTUALQTY>` +
    `\n          <BILLEDQTY> ${fmt2(item.qty)} ${esc(uom)}</BILLEDQTY>` +
    `\n          <ADDITIONALDETAILS.LIST> </ADDITIONALDETAILS.LIST>` +
    `\n          <VOUCHERCOMPONENTLIST.LIST> </VOUCHERCOMPONENTLIST.LIST>` +
    `\n        </BATCHALLOCATIONS.LIST>` +
    `\n        <ACCOUNTINGALLOCATIONS.LIST>` +
    `\n          <OLDAUDITENTRYIDS.LIST TYPE="Number"><OLDAUDITENTRYIDS>-1</OLDAUDITENTRYIDS></OLDAUDITENTRYIDS.LIST>` +
    `\n          <LEDGERNAME>${esc(salesLedger)}</LEDGERNAME>` +
    `\n          <GSTCLASS> Not Applicable</GSTCLASS>` +
    `\n          <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>` +
    `\n          <LEDGERFROMITEM>No</LEDGERFROMITEM>` +
    `\n          <REMOVEZEROENTRIES>No</REMOVEZEROENTRIES>` +
    `\n          <ISPARTYLEDGER>No</ISPARTYLEDGER>` +
    `\n          <GSTOVERRIDDEN>No</GSTOVERRIDDEN>` +
    `\n          <ISGSTASSESSABLEVALUEOVERRIDDEN>No</ISGSTASSESSABLEVALUEOVERRIDDEN>` +
    `\n          <STRDISGSTAPPLICABLE>No</STRDISGSTAPPLICABLE>` +
    `\n          <STRDGSTISPARTYLEDGER>No</STRDGSTISPARTYLEDGER>` +
    `\n          <STRDGSTISDUTYLEDGER>No</STRDGSTISDUTYLEDGER>` +
    `\n          <CONTENTNEGISPOS>No</CONTENTNEGISPOS>` +
    `\n          <ISLASTDEEMEDPOSITIVE>No</ISLASTDEEMEDPOSITIVE>` +
    `\n          <ISCAPVATTAXALTERED>No</ISCAPVATTAXALTERED>` +
    `\n          <ISCAPVATNOTCLAIMED>No</ISCAPVATNOTCLAIMED>` +
    `\n          <AMOUNT>${fmt2(posAmt)}</AMOUNT>` +
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

/** Full inventory-mode Sales voucher wrapper — mirrors purchase wrapVoucher but for buyer info */
function wrapSalesInventoryVoucher(
  inv: StoredInvoice,
  partyLedger: string,
  ledgerXml: string,
  inventoryXml: string,
  input: SalesXmlGeneratorInput,
): string {
  const NA = ' Not Applicable';
  const guid = generateGuid();
  const d = tallyDate(inv.invoice_date);
  const buyerGstin = inv.buyer_gstin ?? '';
  const buyerState = stateFromGstin(buyerGstin);
  const regType = buyerGstin ? 'Regular' : 'Unregistered';
  const cmpGstin = input.companyGstin ?? '';
  const cmpState = input.companyState ?? stateFromGstin(cmpGstin);
  const cmpTaxUnit = cmpState ? `${cmpState} Registration` : '';
  const buyerName = esc(inv.buyer_name ?? '');
  const narration = `${buyerName} | ${esc(inv.invoice_number)} | ${inv.invoice_date}`;

  return `
    <TALLYMESSAGE xmlns:UDF="TallyUDF">
      <VOUCHER VCHTYPE="${esc(SALES_VOUCHER_TYPE)}" ACTION="Create" OBJVIEW="Invoice Voucher View">
        <OLDAUDITENTRYIDS.LIST TYPE="Number"><OLDAUDITENTRYIDS>-1</OLDAUDITENTRYIDS></OLDAUDITENTRYIDS.LIST>
        <DATE>${d}</DATE>
        <REFERENCEDATE>${d}</REFERENCEDATE>
        <VCHSTATUSDATE>${d}</VCHSTATUSDATE>
        <GUID>${guid}</GUID>
        <GSTREGISTRATIONTYPE>${regType}</GSTREGISTRATIONTYPE>
        <VATDEALERTYPE>${regType}</VATDEALERTYPE>
        <STATENAME>${esc(buyerState)}</STATENAME>
        <OBJECTUPDATEACTION>Create</OBJECTUPDATEACTION>
        <COUNTRYOFRESIDENCE>India</COUNTRYOFRESIDENCE>${buyerGstin ? `\n        <PARTYGSTIN>${esc(buyerGstin)}</PARTYGSTIN>` : ''}
        <PLACEOFSUPPLY>${esc(buyerState)}</PLACEOFSUPPLY>
        <VOUCHERTYPENAME>${esc(SALES_VOUCHER_TYPE)}</VOUCHERTYPENAME>
        <ISINVENTORYAFFECTED>Yes</ISINVENTORYAFFECTED>
        <PARTYNAME>${buyerName}</PARTYNAME>${cmpGstin ? `\n        <CMPGSTIN>${esc(cmpGstin)}</CMPGSTIN>` : ''}
        <PARTYLEDGERNAME>${esc(partyLedger)}</PARTYLEDGERNAME>
        <VOUCHERNUMBER>${esc(inv.invoice_number)}</VOUCHERNUMBER>${cmpGstin ? '\n        <CMPGSTREGISTRATIONTYPE>Regular</CMPGSTREGISTRATIONTYPE>' : ''}${cmpState ? `\n        <CMPGSTSTATE>${esc(cmpState)}</CMPGSTSTATE>` : ''}
        <BASICBASEPARTYNAME>${buyerName}</BASICBASEPARTYNAME>
        <PARTYMAILINGNAME>${buyerName}</PARTYMAILINGNAME>
        <REFERENCE>${esc(inv.invoice_number)}</REFERENCE>
        <NARRATION>${narration}</NARRATION>
        <NUMBERINGSTYLE>Auto Renumber</NUMBERINGSTYLE>
        <CSTFORMISSUETYPE>${NA}</CSTFORMISSUETYPE>
        <CSTFORMRECVTYPE>${NA}</CSTFORMRECVTYPE>
        <FBTPAYMENTTYPE>Default</FBTPAYMENTTYPE>
        <PERSISTEDVIEW>Invoice Voucher View</PERSISTEDVIEW>
        <VCHSTATUSTAXADJUSTMENT>Default</VCHSTATUSTAXADJUSTMENT>
        <VCHSTATUSVOUCHERTYPE>${esc(SALES_VOUCHER_TYPE)}</VCHSTATUSVOUCHERTYPE>${cmpTaxUnit ? `\n        <VCHSTATUSTAXUNIT>${esc(cmpTaxUnit)}</VCHSTATUSTAXUNIT>` : ''}
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
        <ISELIGIBLEFORITC>No</ISELIGIBLEFORITC>
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

function buildSalesInventoryVoucher(inv: StoredInvoice, input: SalesXmlGeneratorInput): VoucherResult {
  const warnings: string[] = [];
  const d = deriveInvoiceFinancials(inv);
  const acc = inv.tally_ledger_acceptance as unknown as Record<string, unknown> | null;

  const accCustomer = (acc?.customerLedger as string | undefined)?.trim() ?? '';
  const resolvedCustomer = findCustomer(input.customers, inv.buyer_gstin, inv.buyer_name ?? '');
  const partyLedger = accCustomer || resolvedCustomer?.tally_ledger_name || (inv.buyer_name ?? '');
  if (!partyLedger) return { xml: null, skip: 'No customer ledger and no customer name', warnings };
  if (!accCustomer && !resolvedCustomer) warnings.push(`Customer "${inv.buyer_name}" not in master - using customer name as ledger`);

  const salesLedger = (acc?.salesLedger as string | undefined)?.trim() ?? '';
  if (!salesLedger) return { xml: null, skip: `No sales ledger set for invoice "${inv.invoice_number}" - accept the invoice first`, warnings };

  // Acceptance stock map: desc → tally_item_name
  const stockMap = (acc?.stock as Record<string, string> | undefined) ?? {};

  let totalItemsAmount = 0;
  let unmappedItemsAmount = 0;
  const invEntries: string[] = [];

  for (const item of inv.line_items) {
    const desc = item.description ?? '';
    const mappedItemName = stockMap[desc];
    let stockItem: StockItemMaster | null = null;
    if (mappedItemName) {
      stockItem = input.stockItems.find((s) => s.tally_item_name === mappedItemName) ?? null;
    }
    if (!stockItem) {
      stockItem = findSalesStockItem(input.stockItems, desc, item.hsn, item.gst_percent, input.stockItemMode);
    }
    const itemNet = calcLineAmount(item);
    if (!stockItem) {
      warnings.push(`Stock item "${desc}" (HSN ${item.hsn}) not mapped - booking to sales ledger`);
      unmappedItemsAmount += itemNet;
      continue;
    }
    totalItemsAmount += itemNet;
    invEntries.push(buildSalesAllInventoryEntry(stockItem, item, salesLedger));
  }

  if (invEntries.length === 0) {
    // Fall back to accounting-only mode so the invoice is not lost
    warnings.push('No line items could be mapped to stock items - falling back to accounting-only mode');
    return buildSalesVoucher(inv, input);
  }

  const ledgerEntries: string[] = [];

  // 1. Customer (debtor) — DEBIT.
  // In Tally inventory-mode LEDGERENTRIES.LIST the sign convention is:
  //   NEGATIVE amount = DEBIT (money flows out / receivable from customer)
  //   POSITIVE amount = CREDIT (money flows in / payable to supplier)
  // This is the OPPOSITE of ALLLEDGERENTRIES.LIST used in accounting-only mode.
  // Mirror of purchase: party (creditor) uses +d.total (CREDIT); sales: customer uses -d.total (DEBIT).
  ledgerEntries.push(invSalesLedgerEntry({
    ledgerName: partyLedger,
    isdeemedpositive: 'Yes',
    isPartyledger: 'Yes',
    islastdeemedpositive: 'Yes',
    amount: -d.total,
    billRefName: inv.invoice_number,
  }));

  // 2. Output tax ledgers — CREDIT, ISDEEMEDPOSITIVE=No.
  // Emit based on computed amounts, not inv.tax_type. When inv.tax_type is null
  // buildFullTaxSummary still computes CGST/SGST from line-item gst_percent, so
  // d.cgst/d.sgst can be > 0 even with null tax_type, causing a debit/credit mismatch
  // if we gated on inv.tax_type === 'cgst_sgst'. Using amounts directly is safe because
  // CGST/SGST and IGST are mutually exclusive on a single sale.
  const taxBase = d.net_goods_taxable + d.taxable_charges_total;
  const roundHalf = (r: number) => Math.round(r * 2) / 2;
  if (d.cgst > 0) {
    const rate = taxBase > 0 ? roundHalf((d.cgst / taxBase) * 100) : 0;
    const l = ((acc?.cgstLedger as string | undefined)?.trim()) ||
      findOutputTaxLedger(input.dutiesTaxes, 'CGST', rate) ||
      findOutputTaxLedger(input.dutiesTaxes, 'CGST', 0);
    if (!l) return { xml: null, skip: 'No CGST ledger configured', warnings };
    ledgerEntries.push(invSalesLedgerEntry({
      ledgerName: l,
      isdeemedpositive: 'No',
      isPartyledger: 'No',
      islastdeemedpositive: 'No',
      amount: d.cgst,
      rateOfInvoiceTax: rate || undefined,
    }));
  }
  if (d.sgst > 0) {
    const rate = taxBase > 0 ? roundHalf((d.sgst / taxBase) * 100) : 0;
    const l = ((acc?.sgstLedger as string | undefined)?.trim()) ||
      findOutputTaxLedger(input.dutiesTaxes, 'SGST', rate) ||
      findOutputTaxLedger(input.dutiesTaxes, 'SGST', 0);
    if (!l) return { xml: null, skip: 'No SGST ledger configured', warnings };
    ledgerEntries.push(invSalesLedgerEntry({
      ledgerName: l,
      isdeemedpositive: 'No',
      isPartyledger: 'No',
      islastdeemedpositive: 'No',
      amount: d.sgst,
      rateOfInvoiceTax: rate || undefined,
    }));
  }
  if (d.igst > 0) {
    const rate = taxBase > 0 ? roundHalf((d.igst / taxBase) * 100) : 0;
    const l = ((acc?.igstLedger as string | undefined)?.trim()) ||
      findOutputTaxLedger(input.dutiesTaxes, 'IGST', rate) ||
      findOutputTaxLedger(input.dutiesTaxes, 'IGST', 0);
    if (!l) return { xml: null, skip: 'No IGST ledger configured', warnings };
    ledgerEntries.push(invSalesLedgerEntry({
      ledgerName: l,
      isdeemedpositive: 'No',
      isPartyledger: 'No',
      islastdeemedpositive: 'No',
      amount: d.igst,
      rateOfInvoiceTax: rate || undefined,
    }));
  }

  // 3. Charges (income) — CREDIT via invSalesIncomeLedgerEntry
  let mappedChargesTotal = 0;
  let unmappedChargesTotal = 0;
  if (inv.charges?.length) {
    for (const charge of inv.charges) {
      if (!charge.amount || charge.amount === 0) continue;
      const el = input.expenseLedgers.find((l) => l.expense_keyword && norm(l.expense_keyword) === norm(charge.description))
        ?? input.expenseLedgers.find((l) => norm(l.tally_ledger_name) === norm(charge.description));
      if (!el) {
        warnings.push(`No ledger mapped for charge "${charge.description}" - booking to sales ledger`);
        unmappedChargesTotal += charge.amount;
        continue;
      }
      mappedChargesTotal += charge.amount;
      ledgerEntries.push(invSalesIncomeLedgerEntry(el.tally_ledger_name, Math.abs(charge.amount)));
    }
  }

  // 4. Round-off — track debit/credit separately (mirrors purchase buildInventoryVoucher)
  let roundOffDebit = 0;
  let roundOffCredit = 0;
  if (d.round_off && Math.abs(d.round_off) > 0.001) {
    const roLedger = ((acc?.roLedger as string | undefined)?.trim())
      || input.expenseLedgers.find((l) => norm(l.tally_ledger_name).includes('round'))?.tally_ledger_name
      || 'Round Off';
    if (d.round_off > 0) {
      // Round-off income for seller → CREDIT
      roundOffCredit = d.round_off;
      ledgerEntries.push(invSalesIncomeLedgerEntry(roLedger, d.round_off));
    } else {
      // Round-off expense for seller → DEBIT (negative amount in LEDGERENTRIES.LIST)
      roundOffDebit = Math.abs(d.round_off);
      ledgerEntries.push(invSalesLedgerEntry({
        ledgerName: roLedger,
        isdeemedpositive: 'Yes',
        isPartyledger: 'No',
        islastdeemedpositive: 'Yes',
        amount: -roundOffDebit,
      }));
    }
  }

  // 5. Balance catch-up — mirrors purchase buildInventoryVoucher gap formula exactly
  const taxes = d.cgst + d.sgst + d.igst;
  const totalCreditSide = totalItemsAmount + unmappedItemsAmount + taxes + mappedChargesTotal + unmappedChargesTotal + roundOffCredit;
  const totalDebitSide = d.total + roundOffDebit;
  const gap = parseFloat((totalDebitSide - totalCreditSide).toFixed(2));
  const netSalesLedgerAdj = unmappedItemsAmount + unmappedChargesTotal + gap;
  if (Math.abs(netSalesLedgerAdj) > 0.01) {
    if (netSalesLedgerAdj > 0) {
      ledgerEntries.push(invSalesIncomeLedgerEntry(salesLedger, netSalesLedgerAdj));
    } else {
      // Excess credit (e.g. bill discount absorbed into total) — debit sales ledger to balance
      // Negative amount = DEBIT in LEDGERENTRIES.LIST convention.
      warnings.push(`Balance gap ₹${fmt2(Math.abs(netSalesLedgerAdj))} in "${inv.invoice_number}" - debited to sales ledger`);
      ledgerEntries.push(invSalesLedgerEntry({
        ledgerName: salesLedger,
        isdeemedpositive: 'Yes',
        isPartyledger: 'No',
        islastdeemedpositive: 'Yes',
        amount: -Math.abs(netSalesLedgerAdj),
      }));
    }
  }

  return {
    xml: wrapSalesInventoryVoucher(inv, partyLedger, ledgerEntries.join(''), invEntries.join(''), input),
    warnings,
  };
}

// ─── Vouchers XML ─────────────────────────────────────────────────────────────

export function generateSalesVouchersXml(input: SalesXmlGeneratorInput): string {
  const result = buildVouchers(input);
  return result.xml;
}

export function generateSalesVouchers(input: SalesXmlGeneratorInput): SalesXmlGeneratorResult {
  return buildVouchers(input);
}

function buildVouchers(input: SalesXmlGeneratorInput): SalesXmlGeneratorResult {
  const skipped: SalesXmlGeneratorResult['skippedInvoices'] = [];
  const allWarnings: SalesXmlGeneratorResult['warnings'] = [];
  const voucherBlocks: string[] = [];

  const seen = new Set<string>();
  const invoices = input.invoices.filter((inv) => {
    const key = inv.invoice_number.trim().toLowerCase();
    if (seen.has(key)) {
      skipped.push({ invoice_number: inv.invoice_number, reason: 'Duplicate invoice number - only first occurrence exported' });
      return false;
    }
    seen.add(key);
    return true;
  });

  for (const inv of invoices) {
    const invMode = inv.invoice_voucher_mode ?? input.voucherMode ?? 'accounting_only';
    const result = invMode === 'inventory' ? buildSalesInventoryVoucher(inv, input) : buildSalesVoucher(inv, input);
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
        <STATICVARIABLES>
          <SVCURRENTCOMPANY>${esc(input.tallyCompanyName)}</SVCURRENTCOMPANY>
        </STATICVARIABLES>
      </REQUESTDESC>
      <REQUESTDATA>${voucherBlocks.join('')}
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;

  return { xml, includedCount: voucherBlocks.length, skippedInvoices: skipped, warnings: allWarnings };
}

// ─── Masters XML ──────────────────────────────────────────────────────────────
// Creates the customer ledgers (Sundry Debtors), sales ledgers, and duties/taxes
// referenced by the export batch. Minimal valid schema — Tally fills defaults and
// skips duplicates safely on re-import.

function fyStartFromString(financialYear?: string): string {
  if (financialYear) {
    const m = financialYear.match(/FY (\d{4})/);
    if (m) return `${m[1]}0401`;
  }
  const now = new Date();
  const fyYear = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  return `${fyYear}0401`;
}

function buildCustomerLedgerBlock(c: CustomerMaster, fyStart: string): string {
  const name = esc(c.tally_ledger_name);
  // Regular = B2B with valid GSTIN; Unregistered = named B2C (identifiable person, no GSTIN)
  const regType = c.customer_gstin ? 'Regular' : 'Unregistered';
  const state = stateFromGstin(c.customer_gstin) || esc(c.state_name ?? '');
  const gstinBlock = c.customer_gstin ? `\n      <PARTYGSTIN>${esc(c.customer_gstin)}</PARTYGSTIN>` : '';
  const regBlock = c.customer_gstin
    ? `\n       <APPLICABLEFROM>${fyStart}</APPLICABLEFROM>\n       <GSTREGISTRATIONTYPE>${regType}</GSTREGISTRATIONTYPE>\n       <STATE>${esc(state)}</STATE>\n       <GSTIN>${esc(c.customer_gstin)}</GSTIN>\n      `
    : '      ';
  return `
    <TALLYMESSAGE xmlns:UDF="TallyUDF">
     <LEDGER NAME="${name}" RESERVEDNAME="">
      <STARTINGFROM>${fyStart}</STARTINGFROM>
      <CURRENCYNAME>₹</CURRENCYNAME>
      <GSTREGISTRATIONTYPE>${regType}</GSTREGISTRATIONTYPE>
      <PARENT>Sundry Debtors</PARENT>
      <TAXTYPE>Others</TAXTYPE>
      <COUNTRYOFRESIDENCE>India</COUNTRYOFRESIDENCE>${gstinBlock}
      <ISDELETED>No</ISDELETED>
      <LEDGSTREGDETAILS.LIST>${regBlock}</LEDGSTREGDETAILS.LIST>
      <LANGUAGENAME.LIST>
       <NAME.LIST TYPE="String"><NAME>${name}</NAME></NAME.LIST>
       <LANGUAGEID> 1033</LANGUAGEID>
      </LANGUAGENAME.LIST>
     </LEDGER>
    </TALLYMESSAGE>`;
}

function buildSalesLedgerBlock(ledgerName: string, fyStart: string): string {
  const name = esc(ledgerName);
  return `
    <TALLYMESSAGE xmlns:UDF="TallyUDF">
     <LEDGER NAME="${name}" RESERVEDNAME="">
      <STARTINGFROM>${fyStart}</STARTINGFROM>
      <CURRENCYNAME>₹</CURRENCYNAME>
      <PARENT>Sales Accounts</PARENT>
      <GSTAPPLICABLE> Applicable</GSTAPPLICABLE>
      <TAXTYPE>Others</TAXTYPE>
      <GSTTYPEOFSUPPLY>Goods</GSTTYPEOFSUPPLY>
      <AFFECTSSTOCK>Yes</AFFECTSSTOCK>
      <ISDELETED>No</ISDELETED>
      <LANGUAGENAME.LIST>
       <NAME.LIST TYPE="String"><NAME>${name}</NAME></NAME.LIST>
       <LANGUAGEID> 1033</LANGUAGEID>
      </LANGUAGENAME.LIST>
     </LEDGER>
    </TALLYMESSAGE>`;
}

function buildTaxLedgerBlock(dt: DutiesTaxesMaster): string {
  const dutyHeadMap: Record<string, string> = { CGST: 'CGST', SGST: 'SGST/UTGST', IGST: 'IGST' };
  const dutyHead = dutyHeadMap[dt.tax_component] ?? dt.tax_component;
  const name = esc(dt.tally_ledger_name);
  return `
    <TALLYMESSAGE xmlns:UDF="TallyUDF">
     <LEDGER NAME="${name}" RESERVEDNAME="">
      <CURRENCYNAME>₹</CURRENCYNAME>
      <PARENT>Duties &amp; Taxes</PARENT>
      <TAXTYPE>GST</TAXTYPE>
      <GSTDUTYHEAD>${esc(dutyHead)}</GSTDUTYHEAD>
      <ISDELETED>No</ISDELETED>
      <LANGUAGENAME.LIST>
       <NAME.LIST TYPE="String"><NAME>${name}</NAME></NAME.LIST>
       <LANGUAGEID> 1033</LANGUAGEID>
      </LANGUAGENAME.LIST>
     </LEDGER>
    </TALLYMESSAGE>`;
}

function buildStockItemMasterBlock(s: StockItemMaster, gstPercent: number, fyStart: string): string {
  const halfRate = gstPercent / 2;
  const unit = resolveUom(s.unit, null);
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
            <STATENAME> Any</STATENAME>
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
              <GSTRATEVALUATIONTYPE> Not Applicable</GSTRATEVALUATIONTYPE>
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
        <GSTAPPLICABLE> Applicable</GSTAPPLICABLE>
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

function buildUnitMasterBlock(unitName: string, fyStart: string): string {
  const entry = getCanonical(unitName);
  const formalName = entry?.fullName ?? unitName;
  const gstCode = entry?.gstCode ?? unitName.toUpperCase().replace(/\s+/g, '');
  const gstRepUom = `${gstCode}-${formalName.replace(/\s+/g, '').toUpperCase()}`;
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
          <APPLICABLEFROM>${fyStart}</APPLICABLEFROM>
          <REPORTINGUQCNAME>${esc(gstRepUom)}</REPORTINGUQCNAME>
        </REPORTINGUQCDETAILS.LIST>
      </UNIT>
    </TALLYMESSAGE>`;
}

export type SalesMasterType = 'all' | 'stock_items' | 'sales_ledgers' | 'duties_taxes' | 'customers' | 'ledgers_only';

export function generateSalesMastersXml(input: SalesXmlGeneratorInput, type: SalesMasterType = 'all'): string {
  const fyStart = fyStartFromString(input.financialYear);
  const messages: string[] = [];

  const includeCustomers   = type === 'all' || type === 'customers'    || type === 'ledgers_only';
  const includeSalesLedgers = type === 'all' || type === 'sales_ledgers' || type === 'ledgers_only';
  const includeDuties      = type === 'all' || type === 'duties_taxes'  || type === 'ledgers_only';
  const includeStockItems  = type === 'all' || type === 'stock_items';

  // Customers referenced by the batch.
  // Pass 1: emit individual B2B/named-B2C customer ledgers (skip pooled names like "B2C Debtors").
  // Pass 2: emit Sundry Debtors masters for every ledger name actually used in acceptance records
  //         (e.g. "B2C Debtors") that wasn't already emitted in Pass 1. Fresh Tally companies
  //         don't have these pooled aggregator ledgers, so they must be created explicitly.
  if (includeCustomers) {
    const seenCustomers = new Set<string>();
    for (const inv of input.invoices) {
      const customer = findCustomer(input.customers, inv.buyer_gstin, inv.buyer_name ?? '');
      if (customer && !seenCustomers.has(customer.tally_ledger_name) && !isPooledLedger(customer.tally_ledger_name)) {
        seenCustomers.add(customer.tally_ledger_name);
        messages.push(buildCustomerLedgerBlock(customer, fyStart));
      }
    }
    // Pass 2: acceptance-referenced ledgers (including pooled ones like "B2C Debtors")
    for (const inv of input.invoices) {
      const acc = inv.tally_ledger_acceptance as unknown as Record<string, unknown> | null;
      const cl = (acc?.customerLedger as string | undefined)?.trim();
      if (cl && !seenCustomers.has(cl)) {
        seenCustomers.add(cl);
        // Synthesise a minimal CustomerMaster — no GSTIN → Unregistered (B2C aggregator)
        const synthetic: CustomerMaster = {
          id: '', company_id: '', tally_ledger_name: cl,
          customer_gstin: '', customer_name: cl, trade_name: null,
          state_name: '', is_b2c: true, gstin_valid: true,
          created_at: '', updated_at: '',
        };
        messages.push(buildCustomerLedgerBlock(synthetic, fyStart));
      }
    }
  }

  // Sales ledgers from per-invoice acceptance
  if (includeSalesLedgers) {
    const seenSales = new Set<string>();
    for (const inv of input.invoices) {
      const acc = inv.tally_ledger_acceptance as unknown as Record<string, unknown> | null;
      const sl = acc?.salesLedger as string | undefined;
      if (sl && !seenSales.has(sl)) {
        seenSales.add(sl);
        messages.push(buildSalesLedgerBlock(sl, fyStart));
      }
    }
  }

  // Duties & Taxes
  if (includeDuties) {
    const seenDuties = new Set<string>();
    for (const dt of input.dutiesTaxes) {
      if (!seenDuties.has(dt.tally_ledger_name)) {
        seenDuties.add(dt.tally_ledger_name);
        messages.push(buildTaxLedgerBlock(dt));
      }
    }
  }

  // Stock items (inventory mode only — check per-invoice or batch mode)
  const anyInvoiceIsInventory = input.invoices.some(
    (inv) => (inv.invoice_voucher_mode ?? input.voucherMode ?? 'accounting_only') === 'inventory'
  );
  if (includeStockItems && anyInvoiceIsInventory) {
    // Map: tally_item_name → { rate, hsn } from invoice line items (used when master record has nulls)
    const invoiceItemInfo = new Map<string, { rate: number; hsn: string }>();
    for (const inv of input.invoices) {
      const stockMap = (inv.tally_ledger_acceptance as unknown as Record<string, unknown>)?.stock as Record<string, string> | undefined ?? {};
      for (const item of inv.line_items ?? []) {
        const desc = item.description ?? '';
        const mappedName = stockMap[desc];
        let si: StockItemMaster | null = null;
        if (mappedName) si = input.stockItems.find((s) => s.tally_item_name === mappedName) ?? null;
        if (!si) si = findSalesStockItem(input.stockItems, desc, item.hsn, item.gst_percent, input.stockItemMode);
        if (si && !invoiceItemInfo.has(si.tally_item_name)) {
          invoiceItemInfo.set(si.tally_item_name, {
            rate: item.gst_percent ?? 0,
            hsn: item.hsn ?? '',
          });
        }
        // If the acceptance record references a name not found in DB masters, still emit a master block
        // for it so Tally can resolve the reference. Parse rate/HSN from the name pattern.
        if (mappedName && !invoiceItemInfo.has(mappedName)) {
          const nameRateM = mappedName.match(/@\s*(\d+(?:\.\d+)?)\s*%/i);
          const derivedRate = nameRateM ? Number(nameRateM[1]) : (item.gst_percent ?? 0);
          // HSN is the part before "@" stripped of spaces, or use invoice HSN
          const derivedHsn = nameRateM
            ? mappedName.slice(0, mappedName.indexOf('@')).replace(/[\s.]/g, '')
            : (item.hsn ?? '');
          invoiceItemInfo.set(mappedName, { rate: derivedRate, hsn: derivedHsn });
        }
      }
    }

    // Items present in DB masters — emit normally
    const itemsToExport = input.stockItems.filter((s) => invoiceItemInfo.has(s.tally_item_name));
    const seenUnits = new Set<string>();
    for (const s of itemsToExport) {
      const unit = resolveUom(s.unit, null);
      if (!seenUnits.has(unit)) { seenUnits.add(unit); messages.push(buildUnitMasterBlock(unit, fyStart)); }
    }
    const exportedNames = new Set<string>();
    for (const stockItem of itemsToExport) {
      exportedNames.add(stockItem.tally_item_name);
      const info = invoiceItemInfo.get(stockItem.tally_item_name)!;
      // Rate: prefer master DB value; fall back to invoice line item; last resort: extract from name (e.g. "4601 @ 5%" → 5)
      const nameRateMatch = stockItem.tally_item_name.match(/@\s*(\d+(?:\.\d+)?)\s*%/i);
      const nameRate = nameRateMatch ? Number(nameRateMatch[1]) : null;
      const rate = stockItem.gst_percent ?? (info.rate > 0 ? info.rate : null) ?? nameRate ?? 0;
      // HSN: prefer master DB value; fall back to invoice line item HSN
      const enriched: StockItemMaster = stockItem.hsn_code ? stockItem : { ...stockItem, hsn_code: info.hsn || null };
      messages.push(buildStockItemMasterBlock(enriched, rate, fyStart));
    }

    // Phantom items: referenced in acceptance records but missing from DB masters
    // (caused by old seenStock-by-desc bug). Synthesize minimal master blocks for them.
    const defaultUnit = resolveUom(null, null);
    for (const [name, info] of Array.from(invoiceItemInfo)) {
      if (exportedNames.has(name)) continue;
      if (!seenUnits.has(defaultUnit)) { seenUnits.add(defaultUnit); messages.push(buildUnitMasterBlock(defaultUnit, fyStart)); }
      const phantom: StockItemMaster = {
        id: '', company_id: '', tally_item_name: name, alias_name: null,
        unit: defaultUnit, hsn_code: info.hsn || null, gst_percent: info.rate || null,
        created_at: '', updated_at: '',
      };
      messages.push(buildStockItemMasterBlock(phantom, info.rate, fyStart));
      exportedNames.add(name);
    }

    // Safety net: scan ALL acceptance stockMap values across every invoice.
    // Catches names that slipped through the per-line-item loop due to name-format
    // mismatches between the stockMap key and the DB tally_item_name (e.g. "39189090 @18%"
    // vs "39189090 @ 18%"). Any name that appears in a voucher XML must have a master.
    for (const inv of input.invoices) {
      const stockMap = (inv.tally_ledger_acceptance as unknown as Record<string, unknown>)?.stock as Record<string, string> | undefined ?? {};
      for (const name of Object.values(stockMap)) {
        const trimmed = (name ?? '').trim();
        if (!trimmed || exportedNames.has(trimmed)) continue;
        exportedNames.add(trimmed);
        const nameRateM = trimmed.match(/@\s*(\d+(?:\.\d+)?)\s*%/i);
        const derivedRate = nameRateM ? Number(nameRateM[1]) : 0;
        const derivedHsn = nameRateM
          ? trimmed.slice(0, trimmed.indexOf('@')).replace(/[\s.]/g, '')
          : '';
        if (!seenUnits.has(defaultUnit)) { seenUnits.add(defaultUnit); messages.push(buildUnitMasterBlock(defaultUnit, fyStart)); }
        const phantom: StockItemMaster = {
          id: '', company_id: '', tally_item_name: trimmed, alias_name: null,
          unit: defaultUnit, hsn_code: derivedHsn || null, gst_percent: derivedRate || null,
          created_at: '', updated_at: '',
        };
        messages.push(buildStockItemMasterBlock(phantom, derivedRate, fyStart));
      }
    }
  }

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

// ─── Export Preview ───────────────────────────────────────────────────────────

export interface SalesPreviewRow {
  invoice_number: string;
  invoice_date: string;
  buyer_name: string;
  party_ledger: string;
  ledger_type: 'Customer' | 'Sales' | 'CGST' | 'SGST' | 'IGST' | 'Expense' | 'Round Off' | 'Inventory';
  tally_ledger_name: string;
  amount: number;  // positive = debit, negative = credit (Tally sign convention)
  status: 'OK' | 'Skipped' | 'Warning';
  skip_reason?: string;
  warning?: string;
  // Inventory-mode extras
  qty?: number;
  rate?: number;
  uom?: string;
  item_description?: string;
}

export function buildSalesPreview(input: SalesXmlGeneratorInput): SalesPreviewRow[] {
  return input.voucherMode === 'inventory'
    ? buildSalesInventoryPreview(input)
    : buildSalesAccountingPreview(input);
}

function buildSalesInventoryPreview(input: SalesXmlGeneratorInput): SalesPreviewRow[] {
  const rows: SalesPreviewRow[] = [];

  for (const inv of input.invoices) {
    const d = deriveInvoiceFinancials(inv);
    const acc = inv.tally_ledger_acceptance as unknown as Record<string, string> | null;
    const accCustomer = acc?.customerLedger?.trim() ?? '';
    const resolvedCustomer = findCustomer(input.customers, inv.buyer_gstin, inv.buyer_name ?? '');
    const partyLedger = accCustomer || resolvedCustomer?.tally_ledger_name || (inv.buyer_name ?? '');
    const salesLedger = acc?.salesLedger?.trim() ?? '';
    const stockMap = ((inv.tally_ledger_acceptance as unknown as Record<string, unknown>)?.stock as Record<string, string> | undefined) ?? {};
    const base = { invoice_number: inv.invoice_number, invoice_date: inv.invoice_date, buyer_name: inv.buyer_name ?? '', party_ledger: partyLedger };

    if (!salesLedger) {
      rows.push({ ...base, ledger_type: 'Customer', tally_ledger_name: partyLedger, amount: d.total, status: 'Skipped', skip_reason: 'Accept invoice to set sales ledger' });
      continue;
    }

    // Per-item inventory rows
    for (const item of inv.line_items) {
      const desc = item.description ?? '';
      const mappedName = stockMap[desc];
      let stockItem: StockItemMaster | null = null;
      if (mappedName) stockItem = input.stockItems.find((s) => s.tally_item_name === mappedName) ?? null;
      if (!stockItem) stockItem = findSalesStockItem(input.stockItems, desc, item.hsn, item.gst_percent, input.stockItemMode);
      const itemNet = calcLineAmount(item);
      const uom = resolveUom(stockItem?.unit, item.uom);
      rows.push({
        ...base,
        ledger_type: 'Inventory',
        tally_ledger_name: stockItem ? stockItem.tally_item_name : desc,
        amount: itemNet,
        status: stockItem ? 'OK' : 'Warning',
        warning: stockItem ? undefined : `Stock item "${desc}" not mapped - will book to sales ledger`,
        qty: item.qty, rate: item.rate, uom,
        item_description: desc,
      });
    }

    // Customer row
    const partyStatus: SalesPreviewRow['status'] = (!accCustomer && !resolvedCustomer) ? 'Warning' : 'OK';
    rows.push({ ...base, ledger_type: 'Customer', tally_ledger_name: partyLedger, amount: d.total, status: partyStatus, warning: partyStatus === 'Warning' ? 'Customer not in master' : undefined });

    // Sales row (for unmapped items catch-up)
    rows.push({ ...base, ledger_type: 'Sales', tally_ledger_name: salesLedger, amount: 0, status: 'OK' });

    // Tax rows
    if (inv.tax_type === 'cgst_sgst') {
      if (Math.abs(d.cgst) > 0.001) {
        const l = acc?.cgstLedger?.trim() || findOutputTaxLedger(input.dutiesTaxes, 'CGST', 0) || 'CGST';
        rows.push({ ...base, ledger_type: 'CGST', tally_ledger_name: l, amount: -d.cgst, status: 'OK' });
      }
      if (Math.abs(d.sgst) > 0.001) {
        const l = acc?.sgstLedger?.trim() || findOutputTaxLedger(input.dutiesTaxes, 'SGST', 0) || 'SGST';
        rows.push({ ...base, ledger_type: 'SGST', tally_ledger_name: l, amount: -d.sgst, status: 'OK' });
      }
    } else if (Math.abs(d.igst) > 0.001) {
      const l = acc?.igstLedger?.trim() || findOutputTaxLedger(input.dutiesTaxes, 'IGST', 0) || 'IGST';
      rows.push({ ...base, ledger_type: 'IGST', tally_ledger_name: l, amount: -d.igst, status: 'OK' });
    }

    // Charge rows
    if (inv.charges?.length) {
      for (const charge of inv.charges) {
        if (!charge.amount || charge.amount === 0) continue;
        const el = input.expenseLedgers.find((l) => l.expense_keyword && norm(l.expense_keyword) === norm(charge.description))
          ?? input.expenseLedgers.find((l) => norm(l.tally_ledger_name) === norm(charge.description));
        rows.push({ ...base, ledger_type: 'Expense', tally_ledger_name: el?.tally_ledger_name ?? charge.description, amount: -Math.abs(charge.amount), status: el ? 'OK' : 'Warning', warning: el ? undefined : `No ledger for "${charge.description}"` });
      }
    }

    if (Math.abs(d.round_off) > 0.001) {
      const roLedger = acc?.roLedger?.trim()
        || input.expenseLedgers.find((l) => norm(l.tally_ledger_name).includes('round'))?.tally_ledger_name
        || 'Round Off';
      rows.push({ ...base, ledger_type: 'Round Off', tally_ledger_name: roLedger, amount: -d.round_off, status: 'OK' });
    }
  }

  return rows;
}

function buildSalesAccountingPreview(input: SalesXmlGeneratorInput): SalesPreviewRow[] {
  const rows: SalesPreviewRow[] = [];

  for (const inv of input.invoices) {
    const d = deriveInvoiceFinancials(inv);
    const acc = inv.tally_ledger_acceptance as unknown as Record<string, string> | null;

    const accCustomer = acc?.customerLedger?.trim() ?? '';
    const resolvedCustomer = findCustomer(input.customers, inv.buyer_gstin, inv.buyer_name ?? '');
    const partyLedger = accCustomer || resolvedCustomer?.tally_ledger_name || (inv.buyer_name ?? '');
    const salesLedger = acc?.salesLedger?.trim() ?? '';
    const base = { invoice_number: inv.invoice_number, invoice_date: inv.invoice_date, buyer_name: inv.buyer_name ?? '', party_ledger: partyLedger };

    if (!salesLedger) {
      rows.push({ ...base, ledger_type: 'Customer', tally_ledger_name: partyLedger, amount: d.total, status: 'Skipped', skip_reason: 'Accept invoice to set sales ledger' });
      continue;
    }

    const partyStatus: SalesPreviewRow['status'] = (!accCustomer && !resolvedCustomer) ? 'Warning' : 'OK';
    rows.push({ ...base, ledger_type: 'Customer', tally_ledger_name: partyLedger, amount: d.total, status: partyStatus, warning: partyStatus === 'Warning' ? 'Customer not in master' : undefined });

    const hsnRows = buildFullTaxSummary(inv.line_items ?? [], d.charges_resolved, inv.tax_type, inv.bill_discount_amount ?? 0);
    for (const row of hsnRows) {
      if (Math.abs(row.taxable) > 0.001) {
        rows.push({ ...base, ledger_type: 'Sales', tally_ledger_name: salesLedger, amount: -row.taxable, status: 'OK' });
      }
    }

    if (inv.tax_type === 'cgst_sgst') {
      if (Math.abs(d.cgst) > 0.001) {
        const l = acc?.cgstLedger?.trim() || findOutputTaxLedger(input.dutiesTaxes, 'CGST', 0) || 'CGST';
        rows.push({ ...base, ledger_type: 'CGST', tally_ledger_name: l, amount: -d.cgst, status: 'OK' });
      }
      if (Math.abs(d.sgst) > 0.001) {
        const l = acc?.sgstLedger?.trim() || findOutputTaxLedger(input.dutiesTaxes, 'SGST', 0) || 'SGST';
        rows.push({ ...base, ledger_type: 'SGST', tally_ledger_name: l, amount: -d.sgst, status: 'OK' });
      }
    } else if (Math.abs(d.igst) > 0.001) {
      const l = acc?.igstLedger?.trim() || findOutputTaxLedger(input.dutiesTaxes, 'IGST', 0) || 'IGST';
      rows.push({ ...base, ledger_type: 'IGST', tally_ledger_name: l, amount: -d.igst, status: 'OK' });
    }

    if (inv.charges?.length) {
      for (const charge of inv.charges) {
        if (!charge.amount || charge.amount === 0) continue;
        const q = norm(charge.description);
        const el = input.expenseLedgers.find((l) => l.expense_keyword && norm(l.expense_keyword) === q)
          ?? input.expenseLedgers.find((l) => norm(l.tally_ledger_name) === q);
        rows.push({ ...base, ledger_type: 'Expense', tally_ledger_name: el?.tally_ledger_name ?? charge.description, amount: -Math.abs(charge.amount), status: el ? 'OK' : 'Warning', warning: el ? undefined : `No ledger for "${charge.description}"` });
      }
    }

    if (Math.abs(d.round_off) > 0.001) {
      const roLedger = acc?.roLedger?.trim()
        || input.expenseLedgers.find((l) => norm(l.tally_ledger_name).includes('round'))?.tally_ledger_name
        || 'Round Off';
      rows.push({ ...base, ledger_type: 'Round Off', tally_ledger_name: roLedger, amount: -d.round_off, status: 'OK' });
    }
  }

  return rows;
}
