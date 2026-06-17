'use client';
import { useSidebar } from '@/lib/sidebarContext';
import AppSidebar from './AppSidebar';
import type { ReactNode } from 'react';

export default function AppLayout({ children }: { children: ReactNode }) {
  const { collapsed } = useSidebar();
  return (
    <div className="flex min-h-screen bg-gray-50 dark:bg-gray-900 transition-colors">
      <AppSidebar />
      <div className={`flex-1 min-w-0 transition-all duration-200 ${collapsed ? 'ml-16' : 'ml-60'}`}>
        {children}
      </div>
    </div>
  );
}
