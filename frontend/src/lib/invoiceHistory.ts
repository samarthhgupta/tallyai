// Stores fingerprints of previously extracted invoices in localStorage.
// Used to detect cross-session duplicates before they reach Tally.

const KEY = 'tallyai_invoice_history';

export interface InvoiceFingerprint {
  id: string;           // random uuid
  invoice_number: string;
  vendor_name: string;
  invoice_date: string;
  total: number;
  uploaded_at: string;  // ISO date string
}

export function loadHistory(): InvoiceFingerprint[] {
  if (typeof window === 'undefined') return [];
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]');
  } catch {
    return [];
  }
}

function norm(s: string | null | undefined) {
  return (s ?? '').trim().toLowerCase().replace(/\s+/g, '');
}

export function findDuplicate(
  invoiceNumber: string,
  vendorName: string,
): InvoiceFingerprint | null {
  if (!invoiceNumber) return null;
  const history = loadHistory();
  return history.find(
    (f) =>
      norm(f.invoice_number) === norm(invoiceNumber) &&
      norm(f.vendor_name) === norm(vendorName),
  ) ?? null;
}

export function recordInvoice(
  invoiceNumber: string,
  vendorName: string,
  invoiceDate: string,
  total: number,
): void {
  if (!invoiceNumber) return;
  const history = loadHistory();
  // Don't record duplicates
  if (findDuplicate(invoiceNumber, vendorName)) return;
  history.push({
    id: crypto.randomUUID(),
    invoice_number: invoiceNumber,
    vendor_name: vendorName,
    invoice_date: invoiceDate,
    total,
    uploaded_at: new Date().toISOString(),
  });
  localStorage.setItem(KEY, JSON.stringify(history));
}

export function removeFromHistory(invoiceNumber: string, vendorName: string): void {
  const history = loadHistory().filter(
    (f) => !(norm(f.invoice_number) === norm(invoiceNumber) && norm(f.vendor_name) === norm(vendorName)),
  );
  localStorage.setItem(KEY, JSON.stringify(history));
}
