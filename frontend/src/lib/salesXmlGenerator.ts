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
  //    Use per-invoice accepted ledger names when set; fall back to master resolution.
  if (inv.tax_type === 'cgst_sgst') {
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
  } else if (Math.abs(d.igst) > 0.001) {
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
    const result = buildSalesVoucher(inv, input);
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

export function generateSalesMastersXml(input: SalesXmlGeneratorInput): string {
  const fyStart = fyStartFromString(input.financialYear);
  const messages: string[] = [];

  // Customers referenced by the batch — skip pooled/generic ledgers that already exist in Tally
  const seenCustomers = new Set<string>();
  for (const inv of input.invoices) {
    const customer = findCustomer(input.customers, inv.buyer_gstin, inv.buyer_name ?? '');
    if (customer && !seenCustomers.has(customer.tally_ledger_name) && !isPooledLedger(customer.tally_ledger_name)) {
      seenCustomers.add(customer.tally_ledger_name);
      messages.push(buildCustomerLedgerBlock(customer, fyStart));
    }
  }

  // Sales ledgers from per-invoice acceptance
  const seenSales = new Set<string>();
  for (const inv of input.invoices) {
    const acc = inv.tally_ledger_acceptance as unknown as Record<string, unknown> | null;
    const sl = acc?.salesLedger as string | undefined;
    if (sl && !seenSales.has(sl)) {
      seenSales.add(sl);
      messages.push(buildSalesLedgerBlock(sl, fyStart));
    }
  }

  // Duties & Taxes
  const seenDuties = new Set<string>();
  for (const dt of input.dutiesTaxes) {
    if (!seenDuties.has(dt.tally_ledger_name)) {
      seenDuties.add(dt.tally_ledger_name);
      messages.push(buildTaxLedgerBlock(dt));
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
  ledger_type: 'Customer' | 'Sales' | 'CGST' | 'SGST' | 'IGST' | 'Expense' | 'Round Off';
  tally_ledger_name: string;
  amount: number;  // positive = debit, negative = credit (Tally sign convention)
  status: 'OK' | 'Skipped' | 'Warning';
  skip_reason?: string;
  warning?: string;
}

export function buildSalesPreview(input: SalesXmlGeneratorInput): SalesPreviewRow[] {
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
