'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { signIn, getSession } from '@/lib/auth';
import { getSupabase } from '@/lib/supabase';
import { useCompany } from '@/lib/companyContext';

export default function LoginPage() {
  const router = useRouter();
  const { loading: companyLoading } = useCompany();
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(true);

  // If already logged in, go straight to select-company
  useEffect(() => {
    if (companyLoading) return;
    getSession().then((s) => {
      if (s) router.replace('/select-company');
      else setChecking(false);
    });
  }, [companyLoading, router]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setInfo('');
    if (!email || !password) { setError('Email and password are required.'); return; }
    setLoading(true);
    try {
      if (mode === 'signin') {
        await signIn(email, password);
        router.replace('/select-company');
      } else {
        const { error: signUpError } = await getSupabase().auth.signUp({ email, password });
        if (signUpError) throw signUpError;
        setInfo('Account created! You can now sign in.');
        setMode('signin');
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setLoading(false);
    }
  };

  if (checking) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center px-4">
      {/* Logo */}
      <div className="flex items-center gap-3 mb-10">
        <div className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center">
          <span className="text-white font-bold text-lg">T</span>
        </div>
        <span className="text-2xl font-bold text-gray-900">TallyAI</span>
      </div>

      <div className="w-full max-w-sm bg-white rounded-2xl shadow-sm border border-gray-200 p-8">
        <h1 className="text-xl font-semibold text-gray-900 mb-1">
          {mode === 'signin' ? 'Sign in' : 'Create account'}
        </h1>
        <p className="text-sm text-gray-500 mb-6">
          {mode === 'signin' ? 'Welcome back to TallyAI.' : 'Set up your TallyAI account.'}
        </p>

        {info && (
          <div className="bg-green-50 border border-green-200 rounded-lg px-4 py-3 text-sm text-green-700 mb-4">
            {info}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              autoFocus
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 bg-indigo-600 text-white text-sm font-semibold rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors"
          >
            {loading ? (mode === 'signin' ? 'Signing in…' : 'Creating account…') : (mode === 'signin' ? 'Sign in' : 'Create account')}
          </button>
        </form>

        <p className="text-center text-sm text-gray-500 mt-5">
          {mode === 'signin' ? "Don't have an account? " : 'Already have an account? '}
          <button
            onClick={() => { setMode(mode === 'signin' ? 'signup' : 'signin'); setError(''); setInfo(''); }}
            className="text-indigo-600 hover:text-indigo-800 font-medium"
          >
            {mode === 'signin' ? 'Create one' : 'Sign in'}
          </button>
        </p>
      </div>
    </div>
  );
}
