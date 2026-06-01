// Financial Year + Period utilities for TallyAI.
// Indian FY runs April–March. We store three values per selected period:
//   financial_year: 'FY 2024-25'
//   period_month:   '2024-10'   (YYYY-MM, ISO-sortable)
//   period_label:   'October-24' (human label for display)

const KEY = 'tallyai_fy_period';

export interface FYPeriod {
  financial_year: string;   // 'FY 2024-25'
  period_month: string;     // '2024-10'
  period_label: string;     // 'October-24'
}

// ─── FY list ──────────────────────────────────────────────────────────────────

// Returns FYs from FY 2022-23 up to one year ahead of today.
export function getFYList(): string[] {
  const today = new Date();
  const calYear = today.getFullYear();
  const month = today.getMonth(); // 0-indexed; April = 3
  // Current FY start year
  const currentFYStart = month >= 3 ? calYear : calYear - 1;
  const fys: string[] = [];
  for (let y = 2022; y <= currentFYStart + 1; y++) {
    fys.push(`FY ${y}-${String(y + 1).slice(2)}`);
  }
  return fys.reverse(); // most recent first
}

// Returns the default FY (current financial year).
export function currentFY(): string {
  const today = new Date();
  const y = today.getFullYear();
  const m = today.getMonth();
  const fyStart = m >= 3 ? y : y - 1;
  return `FY ${fyStart}-${String(fyStart + 1).slice(2)}`;
}

// ─── Month list for a given FY ────────────────────────────────────────────────

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export interface MonthOption {
  period_month: string;   // 'YYYY-MM'
  period_label: string;   // 'October-24'
}

// Returns months Apr–Mar for the given FY string (e.g. 'FY 2024-25').
// Months in the future (beyond today) are excluded.
export function getMonthsForFY(fy: string): MonthOption[] {
  // Parse start year from 'FY 2024-25'
  const match = fy.match(/FY (\d{4})-(\d{2})/);
  if (!match) return [];
  const startYear = parseInt(match[1]);
  const endYear = startYear + 1;

  const today = new Date();
  const todayYM = today.getFullYear() * 100 + today.getMonth(); // comparable int

  const months: MonthOption[] = [];
  // April (3) to December (11) of startYear, then January (0) to March (2) of endYear
  const sequence = [
    { year: startYear, month: 3 },  // April
    { year: startYear, month: 4 },
    { year: startYear, month: 5 },
    { year: startYear, month: 6 },
    { year: startYear, month: 7 },
    { year: startYear, month: 8 },
    { year: startYear, month: 9 },
    { year: startYear, month: 10 },
    { year: startYear, month: 11 },
    { year: endYear, month: 0 },    // January
    { year: endYear, month: 1 },
    { year: endYear, month: 2 },    // March
  ];

  for (const { year, month } of sequence) {
    const ym = year * 100 + month;
    if (ym > todayYM) break; // don't show future months
    const mm = String(month + 1).padStart(2, '0');
    const period_month = `${year}-${mm}`;
    const yy = String(year).slice(2);
    const period_label = `${MONTH_NAMES[month]}-${yy}`;
    months.push({ period_month, period_label });
  }
  return months.reverse(); // most recent first
}

// ─── Default period (current month) ──────────────────────────────────────────

export function currentPeriod(): FYPeriod {
  const fy = currentFY();
  const today = new Date();
  const year = today.getFullYear();
  const month = today.getMonth();
  const mm = String(month + 1).padStart(2, '0');
  const yy = String(year).slice(2);
  return {
    financial_year: fy,
    period_month: `${year}-${mm}`,
    period_label: `${MONTH_NAMES[month]}-${yy}`,
  };
}

// ─── Persistence ──────────────────────────────────────────────────────────────

export function loadFYPeriod(): FYPeriod {
  if (typeof window === 'undefined') return currentPeriod();
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as FYPeriod;
  } catch { /* ignore */ }
  return currentPeriod();
}

export function saveFYPeriod(p: FYPeriod): void {
  localStorage.setItem(KEY, JSON.stringify(p));
}

// ─── Derive FYPeriod from invoice date ────────────────────────────────────────
// Used when saving invoices — month comes from invoice date, not user selection.

export function periodFromInvoiceDate(invoiceDate: string, financialYear: string): FYPeriod {
  let year: number;
  let month: number; // 0-indexed
  try {
    if (/^\d{4}-\d{2}-\d{2}/.test(invoiceDate)) {
      year = parseInt(invoiceDate.slice(0, 4));
      month = parseInt(invoiceDate.slice(5, 7)) - 1;
    } else if (/^\d{2}\/\d{2}\/\d{4}/.test(invoiceDate)) {
      const p = invoiceDate.split('/');
      year = parseInt(p[2]);
      month = parseInt(p[1]) - 1;
    } else if (/^\d{8}$/.test(invoiceDate)) {
      year = parseInt(invoiceDate.slice(0, 4));
      month = parseInt(invoiceDate.slice(4, 6)) - 1;
    } else {
      throw new Error('unparseable');
    }
  } catch {
    const now = new Date();
    year = now.getFullYear();
    month = now.getMonth();
  }
  const mm = String(month + 1).padStart(2, '0');
  const yy = String(year).slice(2);
  return {
    financial_year: financialYear,
    period_month: `${year}-${mm}`,
    period_label: `${MONTH_NAMES[month]}-${yy}`,
  };
}
