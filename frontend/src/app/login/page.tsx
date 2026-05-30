'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

// Login not required yet — redirect straight to upload
export default function LoginPage() {
  const router = useRouter();
  useEffect(() => { router.replace('/upload'); }, [router]);
  return (
    <div className="flex items-center justify-center min-h-screen">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600" />
    </div>
  );
}
