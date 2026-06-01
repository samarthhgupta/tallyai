'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useCompany } from '@/lib/companyContext';
import { getSession } from '@/lib/auth';

export default function HomePage() {
  const router = useRouter();
  const { company, loading } = useCompany();

  useEffect(() => {
    if (loading) return;
    getSession().then((session) => {
      if (!session) { router.replace('/login'); return; }
      router.replace(company ? '/upload' : '/select-company');
    });
  }, [loading, company, router]);

  return (
    <div className="flex items-center justify-center min-h-screen">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600" />
    </div>
  );
}
