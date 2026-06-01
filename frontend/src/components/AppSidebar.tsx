'use client';

import { useRouter, usePathname } from 'next/navigation';

const NAV = [
  { label: 'Upload', href: '/upload' },
  { label: 'Companies', href: '/companies' },
  {
    label: 'Masters',
    children: [
      { label: 'Supplier Master', href: '/masters/suppliers' },
      { label: 'Stock Items', href: '/masters/stock-items' },
      { label: 'Duties & Taxes', href: '/masters/duties-taxes' },
    ],
  },
  { label: 'Purchase Register', href: '/register' },
];

export default function AppSidebar() {
  const router = useRouter();
  const pathname = usePathname();

  const isActive = (href: string) =>
    href !== '#' && (pathname === href || pathname.startsWith(href + '/'));

  return (
    <aside className="fixed top-0 left-0 h-full w-60 bg-white border-r border-gray-200 flex flex-col z-20">
      <div className="flex items-center gap-2 px-5 py-5 border-b border-gray-100">
        <div className="w-8 h-8 bg-indigo-600 rounded-md flex items-center justify-center shrink-0">
          <span className="text-white font-bold text-sm">T</span>
        </div>
        <span className="text-lg font-semibold text-gray-900">TallyAI</span>
      </div>

      <nav className="flex-1 px-3 py-4 space-y-0.5 overflow-y-auto">
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
    </aside>
  );
}
