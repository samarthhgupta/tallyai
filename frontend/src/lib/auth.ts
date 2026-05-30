'use client';

import { getSupabase } from './supabase';

export async function getSession() {
  const { data } = await getSupabase().auth.getSession();
  return data.session;
}

export async function getUser() {
  const { data } = await getSupabase().auth.getUser();
  return data.user;
}

export async function signIn(email: string, password: string) {
  const { data, error } = await getSupabase().auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

export async function signOut() {
  await getSupabase().auth.signOut();
}

export async function getUserProfile() {
  const user = await getUser();
  if (!user) return null;
  const { data } = await getSupabase()
    .from('user_profiles')
    .select('*')
    .eq('id', user.id)
    .single();
  return data;
}
