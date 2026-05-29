'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

// Auth not required yet — redirect straight to dashboard
export default function LoginPage() {
  const router = useRouter();
  useEffect(() => { router.replace('/dashboard'); }, [router]);
  return (
    <div className="flex items-center justify-center min-h-screen">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600" />
    </div>
  );
}
