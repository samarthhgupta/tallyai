'use client';

import { useEffect, useState } from 'react';
import {
  getFYList,
  getMonthsForFY,
  loadFYPeriod,
  saveFYPeriod,
  type FYPeriod,
  type MonthOption,
} from '@/lib/fyPeriod';

interface Props {
  value: FYPeriod;
  onChange: (p: FYPeriod) => void;
}

export default function FYPeriodSelector({ value, onChange }: Props) {
  const [fyList] = useState<string[]>(getFYList);
  const [months, setMonths] = useState<MonthOption[]>([]);

  // Rebuild month list whenever FY changes
  useEffect(() => {
    const list = getMonthsForFY(value.financial_year);
    setMonths(list);
    // If current period_month doesn't belong to new FY, pick first available
    const stillValid = list.some((m) => m.period_month === value.period_month);
    if (!stillValid && list.length > 0) {
      const next: FYPeriod = {
        financial_year: value.financial_year,
        period_month: list[0].period_month,
        period_label: list[0].period_label,
      };
      saveFYPeriod(next);
      onChange(next);
    }
  }, [value.financial_year]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleFYChange = (fy: string) => {
    const list = getMonthsForFY(fy);
    const first = list[0];
    const next: FYPeriod = {
      financial_year: fy,
      period_month: first?.period_month ?? '',
      period_label: first?.period_label ?? '',
    };
    saveFYPeriod(next);
    onChange(next);
  };

  const handleMonthChange = (period_month: string) => {
    const opt = months.find((m) => m.period_month === period_month);
    if (!opt) return;
    const next: FYPeriod = {
      financial_year: value.financial_year,
      period_month: opt.period_month,
      period_label: opt.period_label,
    };
    saveFYPeriod(next);
    onChange(next);
  };

  return (
    <div className="flex items-center gap-2">
      <select
        value={value.financial_year}
        onChange={(e) => handleFYChange(e.target.value)}
        className="text-sm border border-gray-300 rounded-md px-3 py-1.5 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-indigo-500"
      >
        {fyList.map((fy) => (
          <option key={fy} value={fy}>{fy}</option>
        ))}
      </select>

      <select
        value={value.period_month}
        onChange={(e) => handleMonthChange(e.target.value)}
        disabled={months.length === 0}
        className="text-sm border border-gray-300 rounded-md px-3 py-1.5 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50"
      >
        {months.map((m) => (
          <option key={m.period_month} value={m.period_month}>{m.period_label}</option>
        ))}
      </select>
    </div>
  );
}

// Hook for pages that need FYPeriod state with localStorage sync
export function useFYPeriod() {
  const [period, setPeriod] = useState<FYPeriod | null>(null);

  useEffect(() => {
    setPeriod(loadFYPeriod());
  }, []);

  const update = (p: FYPeriod) => {
    saveFYPeriod(p);
    setPeriod(p);
  };

  return { period, update };
}
