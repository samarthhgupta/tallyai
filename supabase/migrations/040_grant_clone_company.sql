-- Migration 040: Grant EXECUTE on clone_company() to authenticated users.
--
-- Without this the Supabase RPC call fails with:
--   "permission denied for function clone_company"
-- The function uses SECURITY DEFINER so it runs as the function owner
-- (postgres, which bypasses RLS) — the GRANT only controls whether
-- an authenticated user can invoke it, not what it can do internally.

GRANT EXECUTE ON FUNCTION clone_company(UUID, TEXT) TO authenticated;
