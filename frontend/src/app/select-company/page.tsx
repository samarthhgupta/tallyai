'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { getMyCompanies, type Company } from '@/lib/db';
import { useCompany } from '@/lib/companyContext';
import { deriveStateFromGstin } from '@/lib/suppliers';

export default function SelectCompanyPage() {
  const router = useRouter();
  const { setCompany } = useCompany();
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    getSession().then(async (session) => {
      if (!session) { router.replace('/login'); return; }
      try {
        const list = await getMyCompanies();
        setCompanies(list);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : 'Failed to load companies');
      } finally {
        setLoading(false);
      }
    });
  }, [router]);

  const handleSelect = (c: Company) => {
    setCompany(c);
    router.push('/upload');
  };

  const stateName = (c: Company) => {
    if (c.state_name) return c.state_name;
    if (c.gstin) return deriveStateFromGstin(c.gstin) ?? '';
    return '';
  };

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center px-4">
      {/* Logo */}
      <div className="flex items-center gap-3 mb-10">
        <div className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center">
          <span className="text-white font-bold text-lg">T</span>
        </div>
        <span className="text-2xl font-bold text-gray-900">TallyAI</span>
      </div>

      <div className="w-full max-w-md">
        <h1 className="text-xl font-semibold text-gray-900 mb-1 text-center">Select a Company</h1>
        <p className="text-sm text-gray-500 text-center mb-7">
          All masters and transactions will be scoped to the selected company.
        </p>

        {loading && (
          <div className="flex justify-center py-10">
            <div className="animate-spin rounded-full h-7 w-7 border-b-2 border-indigo-600" />
          </div>
        )}

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700 mb-4">{error}</div>
        )}

        {!loading && companies.length === 0 && !error && (
          <div className="text-center py-8">
            <p className="text-gray-500 text-sm mb-4">No companies found.</p>
            <button
              onClick={() => router.push('/companies')}
              className="px-5 py-2 bg-indigo-600 text-white text-sm font-semibold rounded-lg hover:bg-indigo-700 transition-colors"
            >
              Add a Company
            </button>
          </div>
        )}

        <div className="space-y-3">
          {companies.map((c) => (
            <button
              key={c.id}
              onClick={() => handleSelect(c)}
              className="w-full text-left bg-white border border-gray-200 rounded-xl px-5 py-4 hover:border-indigo-400 hover:shadow-sm transition-all group"
            >
              <div className="flex items-center justify-between">
                <div className="min-w-0">
                  <p className="font-semibold text-gray-900 group-hover:text-indigo-700 transition-colors truncate">
                    {c.name}
                  </p>
                  <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                    {c.gstin && (
                      <span className="text-xs text-gray-400 font-mono">{c.gstin}</span>
                    )}
                    {stateName(c) && (
                      <span className="text-xs text-gray-400">{stateName(c)}</span>
                    )}
                    {!c.gstin && !c.tally_company_name && (
                      <span className="text-xs text-amber-600 flex items-center gap-1">
                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01" />
                        </svg>
                        Incomplete setup
                      </span>
                    )}
                  </div>
                </div>
                <svg className="w-5 h-5 text-gray-300 group-hover:text-indigo-500 transition-colors shrink-0 ml-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </div>
            </button>
          ))}
        </div>

        {!loading && companies.length > 0 && (
          <div className="mt-5 text-center">
            <button
              onClick={() => router.push('/companies')}
              className="text-sm text-indigo-600 hover:text-indigo-800 font-medium"
            >
              Manage companies →
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
