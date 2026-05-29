'use client';

import { useRouter } from 'next/navigation';

interface Company {
  id: string;
  name: string;
}

interface NavbarProps {
  companies?: Company[];
  selectedCompanyId?: string;
  onCompanyChange?: (id: string) => void;
}

export default function Navbar({ companies = [], selectedCompanyId, onCompanyChange }: NavbarProps) {
  const router = useRouter();

  return (
    <nav className="bg-white border-b border-gray-200 shadow-sm">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          {/* Logo */}
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-indigo-600 rounded-md flex items-center justify-center">
              <span className="text-white font-bold text-sm">T</span>
            </div>
            <span className="text-lg font-semibold text-gray-900">TallyAI</span>
          </div>

          {/* Right side */}
          <div className="flex items-center gap-4">
            {companies.length > 0 && onCompanyChange && (
              <select
                value={selectedCompanyId || ''}
                onChange={(e) => onCompanyChange(e.target.value)}
                className="text-sm border border-gray-300 rounded-md px-3 py-1.5 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                <option value="" disabled>Select company</option>
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            )}

            <button
              onClick={() => router.replace('/dashboard')}
              className="text-sm text-gray-600 hover:text-gray-900 px-3 py-1.5 rounded-md hover:bg-gray-100 transition-colors"
            >
              Dashboard
            </button>
          </div>
        </div>
      </div>
    </nav>
  );
}
