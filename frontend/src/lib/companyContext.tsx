'use client';

import { createContext, useContext, useState, useEffect, type ReactNode } from 'react';
import type { Company } from './db';

const STORAGE_KEY = 'tallyai_selected_company';

interface CompanyContextValue {
  company: Company | null;
  setCompany: (c: Company) => void;
  clearCompany: () => void;
  loading: boolean;
}

const CompanyContext = createContext<CompanyContextValue>({
  company: null,
  setCompany: () => {},
  clearCompany: () => {},
  loading: true,
});

export function CompanyProvider({ children }: { children: ReactNode }) {
  const [company, setCompanyState] = useState<Company | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) setCompanyState(JSON.parse(raw) as Company);
    } catch { /* corrupt storage — ignore */ }
    setLoading(false);
  }, []);

  const setCompany = (c: Company) => {
    setCompanyState(c);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(c));
  };

  const clearCompany = () => {
    setCompanyState(null);
    localStorage.removeItem(STORAGE_KEY);
  };

  return (
    <CompanyContext.Provider value={{ company, setCompany, clearCompany, loading }}>
      {children}
    </CompanyContext.Provider>
  );
}

export function useCompany() {
  return useContext(CompanyContext);
}
