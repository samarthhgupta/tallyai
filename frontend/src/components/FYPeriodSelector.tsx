'use client';

import { useEffect, useState } from 'react';
import { getFYList, currentFY, type FYPeriod } from '@/lib/fyPeriod';

// FY-only selector - month is no longer user-selectable.
// Period month is derived per invoice from invoice_date when saving.

interface Props {
  value: string;           // financial_year string, e.g. 'FY 2026-27'
  onChange: (fy: string) => void;
}

export default function FYPeriodSelector({ value, onChange }: Props) {
  const [fyList] = useState<string[]>(getFYList);

  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="text-sm border border-gray-300 rounded-md px-3 py-1.5 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-indigo-500"
    >
      {fyList.map((fy) => (
        <option key={fy} value={fy}>{fy}</option>
      ))}
    </select>
  );
}

// Hook for pages that need a financial year with localStorage sync
export function useFYPeriod() {
  const [financialYear, setFYState] = useState<string>('');

  useEffect(() => {
    // Migrate old FYPeriod object or plain string
    try {
      const raw = localStorage.getItem('tallyai_fy_period');
      if (raw) {
        const parsed = JSON.parse(raw);
        // Support both old { financial_year } object and plain string
        const fy = typeof parsed === 'string' ? parsed : parsed.financial_year;
        setFYState(fy || currentFY());
        return;
      }
    } catch { /* ignore */ }
    setFYState(currentFY());
  }, []);

  const update = (fy: string) => {
    setFYState(fy);
    localStorage.setItem('tallyai_fy_period', JSON.stringify(fy));
  };

  // Legacy: some callers expect { period, update } where period is FYPeriod.
  // Return a shim so old call sites that read period.financial_year still work.
  const period: FYPeriod | null = financialYear
    ? { financial_year: financialYear, period_month: '', period_label: '' }
    : null;

  return { period, financialYear, update };
}
