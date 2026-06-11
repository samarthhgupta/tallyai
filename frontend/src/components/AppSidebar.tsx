'use client';

import { useRouter, usePathname } from 'next/navigation';
import { useCompany } from '@/lib/companyContext';
import { signOut } from '@/lib/auth';

const NAV = [
  { label: 'Upload', href: '/upload' },
  { label: 'Companies', href: '/companies' },
  {
    label: 'Masters',
    children: [
      { label: 'Supplier Master', href: '/masters/suppliers' },
      { label: 'Stock Items', href: '/masters/stock-items' },
      { label: 'Purchase Ledgers', href: '/masters/purchase-ledger' },
      { label: 'Expense Ledgers', href: '/masters/expense-ledgers' },
      { label: 'Duties & Taxes', href: '/masters/duties-taxes' },
      { label: 'Voucher Types', href: '/masters/voucher-types' },
    ],
  },
  { label: 'Purchase Register', href: '/register' },
  { label: 'Export to Tally', href: '/xml' },
];

export default function AppSidebar() {
  const router = useRouter();
  const pathname = usePathname();
  const { company, clearCompany } = useCompany();

  const isActive = (href: string) =>
    href !== '#' && (pathname === href || pathname.startsWith(href + '/'));

  const handleChangeCompany = () => {
    clearCompany();
    router.push('/select-company');
  };

  const handleSignOut = async () => {
    clearCompany();
    await signOut();
    router.push('/login');
  };

  return (
    <aside className="fixed top-0 left-0 h-full w-60 bg-white border-r border-gray-200 flex flex-col z-20">
      {/* Logo */}
      <div className="flex items-center gap-2 px-5 py-4 border-b border-gray-100">
        <div className="w-8 h-8 bg-indigo-600 rounded-md flex items-center justify-center shrink-0">
          <span className="text-white font-bold text-sm">T</span>
        </div>
        <span className="text-lg font-semibold text-gray-900">TallyAI</span>
      </div>

      {/* Company context banner */}
      {company ? (
        <div className="px-4 py-3 bg-indigo-50 border-b border-indigo-100">
          <p className="text-xs text-indigo-500 font-medium uppercase tracking-wider mb-0.5">Company</p>
          <p className="text-sm font-semibold text-indigo-900 truncate leading-tight" title={company.name}>
            {company.name}
          </p>
          <button
            onClick={handleChangeCompany}
            className="text-xs text-indigo-500 hover:text-indigo-700 mt-1 font-medium transition-colors"
          >
            Change →
          </button>
        </div>
      ) : (
        <button
          onClick={() => router.push('/select-company')}
          className="mx-4 my-3 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-700 font-medium hover:bg-amber-100 transition-colors text-left"
        >
          No company selected - click to select →
        </button>
      )}

      <nav className="flex-1 px-3 py-4 space-y-0.5 overflow-y-auto" style={{paddingBottom: '0'}}>
        {NAV.map((item) => {
          if ('children' in item && item.children) {
            const sectionActive = item.children.some((c) => isActive(c.href));
            return (
              <div key={item.label}>
                <div className={`px-3 py-1.5 text-xs font-semibold uppercase tracking-wider mt-2 ${
                  sectionActive ? 'text-indigo-600' : 'text-gray-400'
                }`}>
                  {item.label}
                </div>
                {item.children.map((child) => (
                  <button
                    key={child.href}
                    onClick={() => router.push(child.href)}
                    className={`w-full text-left pl-5 pr-3 py-2 rounded-md text-sm ${
                      isActive(child.href)
                        ? 'bg-indigo-50 text-indigo-700 font-medium'
                        : 'text-gray-600 hover:bg-gray-50'
                    }`}
                  >
                    {child.label}
                  </button>
                ))}
              </div>
            );
          }
          const disabled = Boolean('disabled' in item && (item as { disabled?: boolean }).disabled);
          return (
            <button
              key={item.label}
              onClick={() => !disabled && router.push(item.href)}
              className={`w-full text-left px-3 py-2 rounded-md text-sm font-medium ${
                isActive(item.href)
                  ? 'bg-indigo-50 text-indigo-700'
                  : disabled
                  ? 'text-gray-400 cursor-not-allowed'
                  : 'text-gray-600 hover:bg-gray-50'
              }`}
            >
              {item.label}
              {disabled && <span className="text-xs ml-1 font-normal">(soon)</span>}
            </button>
          );
        })}
      </nav>

      {/* Sign out */}
      <div className="px-3 py-3 border-t border-gray-100">
        <button
          onClick={handleSignOut}
          className="w-full text-left px-3 py-2 rounded-md text-sm text-gray-500 hover:bg-gray-50 hover:text-gray-700 transition-colors"
        >
          Sign out
        </button>
      </div>
    </aside>
  );
}
