'use client';

import { useRouter, usePathname } from 'next/navigation';
import { useCompany } from '@/lib/companyContext';
import { signOut } from '@/lib/auth';
import { useSidebar } from '@/lib/sidebarContext';
import { useTheme } from '@/lib/themeContext';

const NAV = [
  { label: 'Upload', href: '/upload', icon: '📤' },
  { label: 'Companies', href: '/companies', icon: '🏢' },
  {
    label: 'Masters',
    icon: '📋',
    children: [
      { label: 'Sundry Creditors', href: '/masters/suppliers', icon: '👥' },
      { label: 'Sundry Debtors', href: '/masters/customers', icon: '🧑‍💼' },
      { label: 'Stock Items', href: '/masters/stock-items', icon: '📦' },
      { label: 'Purchase Ledgers', href: '/masters/purchase-ledger', icon: '📒' },
      { label: 'Sales Ledgers', href: '/masters/sales-ledger', icon: '📒' },
      { label: 'Expense Ledgers', href: '/masters/expense-ledgers', icon: '💸' },
      { label: 'Duties & Taxes', href: '/masters/duties-taxes', icon: '🏛️' },
      { label: 'Voucher Types', href: '/masters/voucher-types', icon: '🏷️' },
      { label: 'Import from Tally XML', href: '/masters/import-xml', icon: '📂' },
    ],
  },
  { label: 'Purchase Register', href: '/register', icon: '📊' },
  { label: 'Export to Tally', href: '/xml', icon: '💾' },
  {
    label: 'Sales',
    icon: '🧾',
    children: [
      { label: 'Sales PDF Upload', href: '/sales/upload', icon: '📤' },
      { label: 'Sales Excel Import', href: '/sales/excel-import', icon: '📥' },
      { label: 'Sales Register', href: '/sales/register', icon: '📈' },
      { label: 'Sales Export', href: '/sales/xml', icon: '💾' },
    ],
  },
];

export default function AppSidebar() {
  const router = useRouter();
  const pathname = usePathname();
  const { company, clearCompany } = useCompany();
  const { collapsed, toggle } = useSidebar();
  const { theme, toggleTheme } = useTheme();

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
    <aside
      className={`fixed top-0 left-0 h-full bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-700 flex flex-col z-20 transition-all duration-200 ${
        collapsed ? 'w-16' : 'w-60'
      }`}
    >
      {/* Logo */}
      <div className={`flex items-center gap-2 border-b border-gray-100 dark:border-gray-700 shrink-0 ${collapsed ? 'px-3 py-4 justify-center' : 'px-5 py-4'}`}>
        <div className="w-8 h-8 bg-indigo-600 rounded-md flex items-center justify-center shrink-0">
          <span className="text-white font-bold text-sm">T</span>
        </div>
        {!collapsed && <span className="text-lg font-semibold text-gray-900 dark:text-gray-100">TallyAI</span>}
      </div>

      {/* Company context banner */}
      {!collapsed ? (
        company ? (
          <div className="px-4 py-3 bg-indigo-50 dark:bg-indigo-900/30 border-b border-indigo-100 dark:border-indigo-800 shrink-0">
            <p className="text-xs text-indigo-500 dark:text-indigo-400 font-medium uppercase tracking-wider mb-0.5">Company</p>
            <p className="text-sm font-semibold text-indigo-900 dark:text-indigo-200 truncate leading-tight" title={company.name}>
              {company.name}
            </p>
            <button
              onClick={handleChangeCompany}
              className="text-xs text-indigo-500 dark:text-indigo-400 hover:text-indigo-700 dark:hover:text-indigo-300 mt-1 font-medium transition-colors"
            >
              Change →
            </button>
          </div>
        ) : (
          <button
            onClick={() => router.push('/select-company')}
            className="mx-4 my-3 px-3 py-2 bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-700 rounded-lg text-xs text-amber-700 dark:text-amber-400 font-medium hover:bg-amber-100 dark:hover:bg-amber-900/50 transition-colors text-left shrink-0"
          >
            No company selected →
          </button>
        )
      ) : (
        <div className={`flex justify-center py-2 border-b border-gray-100 dark:border-gray-700 shrink-0`}>
          <div
            title={company?.name ?? 'Select company'}
            onClick={() => !company && router.push('/select-company')}
            className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold cursor-pointer ${
              company ? 'bg-indigo-100 dark:bg-indigo-800 text-indigo-700 dark:text-indigo-300' : 'bg-amber-100 dark:bg-amber-800 text-amber-700'
            }`}
          >
            {company ? company.name.charAt(0).toUpperCase() : '?'}
          </div>
        </div>
      )}

      {/* Nav */}
      <nav className="flex-1 px-2 py-3 space-y-0.5 overflow-y-auto">
        {NAV.map((item) => {
          if ('children' in item && item.children) {
            const sectionActive = item.children.some((c) => isActive(c.href));
            if (collapsed) {
              // Collapsed: show each child as an icon button
              return item.children.map((child) => (
                <button
                  key={child.href}
                  title={child.label}
                  onClick={() => router.push(child.href)}
                  className={`w-full flex justify-center items-center py-2 rounded-md transition-colors ${
                    isActive(child.href)
                      ? 'bg-indigo-50 dark:bg-indigo-900/50 text-indigo-700 dark:text-indigo-300'
                      : 'text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800'
                  }`}
                >
                  <span className="text-base">{child.icon}</span>
                </button>
              ));
            }
            return (
              <div key={item.label}>
                <div className={`px-3 py-1.5 text-xs font-semibold uppercase tracking-wider mt-2 ${
                  sectionActive ? 'text-indigo-600 dark:text-indigo-400' : 'text-gray-400 dark:text-gray-500'
                }`}>
                  {item.label}
                </div>
                {item.children.map((child) => (
                  <button
                    key={child.href}
                    onClick={() => router.push(child.href)}
                    className={`w-full text-left pl-5 pr-3 py-2 rounded-md text-sm transition-colors ${
                      isActive(child.href)
                        ? 'bg-indigo-50 dark:bg-indigo-900/50 text-indigo-700 dark:text-indigo-300 font-medium'
                        : 'text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800'
                    }`}
                  >
                    <span className="mr-2">{child.icon}</span>{child.label}
                  </button>
                ))}
              </div>
            );
          }
          // Top-level item
          const disabled = Boolean('disabled' in item && (item as { disabled?: boolean }).disabled);
          if (collapsed) {
            return (
              <button
                key={item.label}
                title={item.label}
                onClick={() => !disabled && router.push(item.href)}
                className={`w-full flex justify-center items-center py-2 rounded-md transition-colors ${
                  isActive(item.href)
                    ? 'bg-indigo-50 dark:bg-indigo-900/50 text-indigo-700 dark:text-indigo-300'
                    : disabled
                    ? 'text-gray-300 dark:text-gray-600 cursor-not-allowed'
                    : 'text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800'
                }`}
              >
                <span className="text-base">{item.icon}</span>
              </button>
            );
          }
          return (
            <button
              key={item.label}
              onClick={() => !disabled && router.push(item.href)}
              className={`w-full text-left px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                isActive(item.href)
                  ? 'bg-indigo-50 dark:bg-indigo-900/50 text-indigo-700 dark:text-indigo-300'
                  : disabled
                  ? 'text-gray-400 dark:text-gray-600 cursor-not-allowed'
                  : 'text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800'
              }`}
            >
              <span className="mr-2">{item.icon}</span>{item.label}
              {disabled && <span className="text-xs ml-1 font-normal">(soon)</span>}
            </button>
          );
        })}
      </nav>

      {/* Bottom controls */}
      <div className="border-t border-gray-100 dark:border-gray-700 px-2 py-2 space-y-1 shrink-0">
        {/* Theme toggle */}
        <button
          onClick={toggleTheme}
          title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          className={`w-full rounded-md text-sm text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 hover:text-gray-700 dark:hover:text-gray-200 transition-colors ${
            collapsed ? 'flex justify-center py-2' : 'text-left px-3 py-2'
          }`}
        >
          {collapsed ? (
            <span className="text-base">{theme === 'dark' ? '☀️' : '🌙'}</span>
          ) : (
            <>{theme === 'dark' ? '☀️ Light mode' : '🌙 Dark mode'}</>
          )}
        </button>

        {/* Sign out */}
        <button
          onClick={handleSignOut}
          title="Sign out"
          aria-label="Sign out"
          className={`w-full rounded-md text-sm text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 hover:text-gray-700 dark:hover:text-gray-200 transition-colors ${
            collapsed ? 'flex justify-center py-2' : 'text-left px-3 py-2'
          }`}
        >
          {collapsed ? <span className="text-base">🚪</span> : 'Sign out'}
        </button>

        {/* Collapse toggle */}
        <button
          onClick={toggle}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className={`w-full rounded-md text-sm text-gray-400 dark:text-gray-500 hover:bg-gray-50 dark:hover:bg-gray-800 hover:text-gray-600 dark:hover:text-gray-300 transition-colors ${
            collapsed ? 'flex justify-center py-2' : 'text-left px-3 py-2'
          }`}
        >
          {collapsed ? '→' : '← Collapse'}
        </button>
      </div>
    </aside>
  );
}
