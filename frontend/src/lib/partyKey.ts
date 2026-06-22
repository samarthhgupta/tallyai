// Unified party key resolver.
// Returns the GSTIN (uppercased) if valid, otherwise a normalised name key.
// Both purchase and sales learning use this key for vendor_ledger_preferences writes.

const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

export function isValidGstin(gstin: string | null | undefined): boolean {
  if (!gstin?.trim()) return false;
  return GSTIN_REGEX.test(gstin.trim().toUpperCase());
}

export function normalisePartyName(name: string): string {
  return name.trim().toUpperCase().replace(/[^A-Z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

// Pooled/generic ledger names that should never be learned as party-specific preferences.
// normalisePartyName strips non-alphanumeric chars (including hyphens), so any
// hyphenated variant like "WALK-IN CUSTOMER" normalises to "WALKIN CUSTOMER".
const POOLED_LEDGER_NAMES = new Set([
  'CASH', 'CASH SALES', 'RETAIL CUSTOMER', 'RETAIL CUSTOMERS',
  'WALK IN CUSTOMER', 'WALKIN CUSTOMER',
  'MISCELLANEOUS', 'SUNDRY DEBTORS', 'SUNDRY CREDITORS',
  'CASH PURCHASE', 'CASH PURCHASES',
  // Settlement/aggregator pools
  'B2C DEBTORS', 'PAYTM SETTLEMENTS', 'UPI SETTLEMENTS',
  'AMAZON SETTLEMENTS', 'FLIPKART SETTLEMENTS', 'MYNTRA SETTLEMENTS',
]);

export function isPooledLedger(name: string | null | undefined): boolean {
  if (!name?.trim()) return true;
  return POOLED_LEDGER_NAMES.has(normalisePartyName(name));
}

// Returns null if the name is empty/pooled and GSTIN is invalid — caller should skip learning.
export function resolvePartyKey(
  gstin: string | null | undefined,
  name: string | null | undefined,
): string | null {
  if (isValidGstin(gstin)) return gstin!.trim().toUpperCase();
  const n = name?.trim() ?? '';
  if (!n || isPooledLedger(n)) return null;
  return `NAME:${normalisePartyName(n)}`;
}
