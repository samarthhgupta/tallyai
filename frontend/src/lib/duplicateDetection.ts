import type { StoredInvoice } from '@/types/invoice';

export interface DuplicateGroup {
  vendorName: string;
  vendorGstin: string | null;
  invoiceNumber: string;
  financialYear: string | null;
  invoices: StoredInvoice[];
}

function normInvoiceNo(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase().replace(/[\s\-./]/g, '');
}

function normVendorName(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Detects duplicate invoices within a list of StoredInvoice records.
 *
 * Primary key: vendor_gstin + invoice_number + financial_year
 * Fallback (no GSTIN): normalized vendor_name + invoice_number + financial_year
 *
 * Financial year scoping prevents cross-year false positives (same invoice
 * number from a different year is legitimate).
 *
 * Returns only groups where 2 or more invoices share the same key.
 */
export function detectDuplicates(invoices: StoredInvoice[]): DuplicateGroup[] {
  const groups = new Map<string, StoredInvoice[]>();

  for (const inv of invoices) {
    const invNo = normInvoiceNo(inv.invoice_number);
    if (!invNo) continue;

    const fy = inv.financial_year ?? '';
    let key: string;

    if (inv.vendor_gstin?.trim()) {
      key = `gstin:${inv.vendor_gstin.trim().toUpperCase()}|${invNo}|${fy}`;
    } else {
      key = `name:${normVendorName(inv.vendor_name)}|${invNo}|${fy}`;
    }

    const group = groups.get(key) ?? [];
    group.push(inv);
    groups.set(key, group);
  }

  const result: DuplicateGroup[] = [];
  for (const group of Array.from(groups.values())) {
    if (group.length >= 2) {
      const rep = group[0];
      result.push({
        vendorName: rep.vendor_name ?? 'Unknown Vendor',
        vendorGstin: rep.vendor_gstin ?? null,
        invoiceNumber: rep.invoice_number ?? '',
        financialYear: rep.financial_year ?? null,
        invoices: group,
      });
    }
  }

  // Sort by vendor name then invoice number for stable display order
  result.sort((a, b) =>
    a.vendorName.localeCompare(b.vendorName) || a.invoiceNumber.localeCompare(b.invoiceNumber),
  );

  return result;
}
