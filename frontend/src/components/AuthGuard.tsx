'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { isSupabaseConfigured, supabase } from '@/lib/supabase';
import type { Session } from '@supabase/supabase-js';

interface AuthGuardProps {
  children: (session: Session) => React.ReactNode;
}

function NotConfigured() {
  return (
    <div className="flex items-center justify-center min-h-screen bg-gray-50">
      <div className="max-w-md w-full mx-4 bg-white rounded-lg border border-amber-200 shadow-sm p-8 text-center">
        <div className="w-12 h-12 bg-amber-100 rounded-full flex items-center justify-center mx-auto mb-4">
          <svg className="w-6 h-6 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
          </svg>
        </div>
        <h2 className="text-lg font-semibold text-gray-900 mb-2">Setup Required</h2>
        <p className="text-sm text-gray-600 mb-4">
          Supabase is not configured. To get TallyAI running, add these secrets in your GitHub repository:
        </p>
        <div className="bg-gray-50 rounded-md p-3 text-left text-xs font-mono text-gray-700 space-y-1 mb-4">
          <div>NEXT_PUBLIC_SUPABASE_URL</div>
          <div>NEXT_PUBLIC_SUPABASE_ANON_KEY</div>
          <div>NEXT_PUBLIC_BACKEND_URL</div>
        </div>
        <p className="text-xs text-gray-500">
          Go to <span className="font-medium">GitHub → Settings → Secrets → Actions</span>, add the keys, then re-run the deployment workflow.
        </p>
      </div>
    </div>
  );
}

export default function AuthGuard({ children }: AuthGuardProps) {
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isSupabaseConfigured()) {
      setLoading(false);
      return;
    }

    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) {
        router.replace('/tallyai/login');
      } else {
        setSession(session);
      }
      setLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!session) {
        router.replace('/tallyai/login');
      } else {
        setSession(session);
      }
    });

    return () => subscription.unsubscribe();
  }, [router]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600" />
      </div>
    );
  }

  if (!isSupabaseConfigured()) return <NotConfigured />;
  if (!session) return null;

  return <>{children(session)}</>;
}
