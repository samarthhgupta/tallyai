// Supabase is not used in the current no-auth build.
// This stub prevents import errors from pages that haven't been cleaned up yet.
export const supabase = null;
export const isSupabaseConfigured = () => false;
export const getSupabase = () => { throw new Error('Supabase not configured'); };
