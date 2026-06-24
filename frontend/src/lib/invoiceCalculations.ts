// Single canonical financial calculation engine.
// Every consumer (Purchase Register, Invoice Detail Panel, Export Preview, XML)
// must derive GST, totals, and round-off from this function — never from stored
// inv.cgst / inv.sgst / inv.igst / inv.total, which may be stale.

import { buildFullTaxSummary, calcLineAmount } from '@/types/invoice';
import type { LineItem, HsnRow, ExtraCharge } from '@/types/invoice';
import { resolveChargeSac } from '@/lib/expenseLedgers';

// Minimal invoice shape required by the canonical engine.
// Both ExtractedInvoice and StoredInvoice satisfy this interface.
export interface InvoiceForDerivation {
  line_items?: LineItem[];
  charges?: ExtraCharge[];
  tax_type: 'cgst_sgst' | 'igst';
  bill_discount_amount?: number | null;
  round_off?: number | null;
}

export interface InvoiceFinancials {
  goods_subtotal: number;
  bill_discount: number;
  net_goods_taxable: number;
  taxable_charges_total: number;
  non_taxable_charges_total: number;
  charges_resolved: ExtraCharge[];   // charges with SAC filled in via resolveChargeSac
  tax_rows: HsnRow[];                // per-HSN/SAC breakdown, same as Purchase Register
  cgst: number;
  sgst: number;
  igst: number;
  total_gst: number;
  round_off: number;                 // from inv.round_off (saved by InvoiceDetailPanel auto-recompute)
  total: number;                     // derived: net_goods + all_charges + gst + round_off
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function deriveInvoiceFinancials(inv: InvoiceForDerivation): InvoiceFinancials {
  const lineItems = inv.line_items ?? [];
  const billDiscount = inv.bill_discount_amount ?? 0;

  // Resolve SAC codes exactly as Purchase Register does
  const charges_resolved: ExtraCharge[] = (inv.charges ?? []).map((c) => ({
    ...c,
    sac: resolveChargeSac(c.description ?? '', c.sac),
  }));

  const goods_subtotal = r2(lineItems.reduce((s, it) => s + calcLineAmount(it), 0));
  const taxable_charges_total = r2(
    charges_resolved.filter((c) => (c.gst_percent ?? 0) > 0).reduce((s, c) => s + c.amount, 0),
  );
  const non_taxable_charges_total = r2(
    charges_resolved.filter((c) => (c.gst_percent ?? 0) === 0).reduce((s, c) => s + c.amount, 0),
  );
  const net_goods_taxable = r2(goods_subtotal - billDiscount);

  // buildFullTaxSummary includes HSN rows (line items, bill-discount-adjusted) + SAC rows (charges)
  const tax_rows = buildFullTaxSummary(lineItems, charges_resolved, inv.tax_type, billDiscount);
  const cgst = r2(tax_rows.reduce((s, row) => s + row.cgst, 0));
  const sgst = r2(tax_rows.reduce((s, row) => s + row.sgst, 0));
  const igst = r2(tax_rows.reduce((s, row) => s + row.igst, 0));
  const total_gst = r2(cgst + sgst + igst);

  // round_off comes from the saved invoice value (auto-computed by InvoiceDetailPanel on every edit)
  const round_off = r2(inv.round_off ?? 0);
  const total = r2(net_goods_taxable + taxable_charges_total + non_taxable_charges_total + total_gst + round_off);

  return {
    goods_subtotal,
    bill_discount: billDiscount,
    net_goods_taxable,
    taxable_charges_total,
    non_taxable_charges_total,
    charges_resolved,
    tax_rows,
    cgst,
    sgst,
    igst,
    total_gst,
    round_off,
    total,
  };
}
