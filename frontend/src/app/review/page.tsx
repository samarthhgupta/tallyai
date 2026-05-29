'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

// Review page is not yet active — extraction results are shown inline on the dashboard.
export default function ReviewPage() {
  const router = useRouter();
  useEffect(() => { router.replace('/dashboard'); }, [router]);
  return (
    <div className="flex items-center justify-center min-h-screen">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600" />
    </div>
  );
}
