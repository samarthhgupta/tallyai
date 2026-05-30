// Client-side company storage using localStorage (no auth required)
// Swappable to Supabase once login is enabled.

const KEY = 'tallyai_companies';

export interface LocalCompany {
  id: string;
  name: string;
  gstin: string;
}

export function loadCompanies(): LocalCompany[] {
  if (typeof window === 'undefined') return [];
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]');
  } catch {
    return [];
  }
}

export function saveCompany(name: string, gstin: string): LocalCompany {
  const companies = loadCompanies();
  const company: LocalCompany = {
    id: crypto.randomUUID(),
    name: name.trim(),
    gstin: gstin.trim().toUpperCase(),
  };
  companies.push(company);
  localStorage.setItem(KEY, JSON.stringify(companies));
  return company;
}

export function deleteCompany(id: string): void {
  const companies = loadCompanies().filter((c) => c.id !== id);
  localStorage.setItem(KEY, JSON.stringify(companies));
}

// Normalise for comparison — strip spaces, uppercase
function norm(s: string | null | undefined) {
  return (s ?? '').replace(/\s+/g, '').toUpperCase();
}

export type MatchResult = 'gstin_match' | 'name_match' | 'mismatch' | 'no_buyer_data';

export function matchCompany(
  company: LocalCompany,
  buyerGstin: string | null,
  buyerName: string | null,
): MatchResult {
  if (!buyerGstin && !buyerName) return 'no_buyer_data';
  if (buyerGstin && company.gstin && norm(buyerGstin) === norm(company.gstin)) return 'gstin_match';
  if (buyerName && norm(buyerName).includes(norm(company.name).slice(0, 6))) return 'name_match';
  if (buyerGstin || buyerName) return 'mismatch';
  return 'no_buyer_data';
}
