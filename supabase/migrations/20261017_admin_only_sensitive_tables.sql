-- CoffeeFlow — take the public anon key off the most sensitive tables.
--
-- WHAT WAS WRONG (found by Gemini QA, confirmed against prod 2026-10-17)
-- The anon key ships in both frontend bundles, so "anon" means "anyone on the
-- internet". With it, anyone could:
--   * read oauth_tokens            — the Meta and Google access/refresh tokens
--   * write user_roles             — insert themselves as 'admin', which then
--                                    passes is_admin() and every gate built on it
--   * read/write/delete chat_messages, seo_tasks, agent_missions, and insert
--     seo_metrics                  — the agent's conversations and work queue
--
-- "authenticated" is not enough either: the Clerk instance allows open sign-up,
-- so any stranger can mint a valid authenticated token. These tables are for
-- admins only. Edge functions use the service role, which bypasses RLS, and
-- the frontends (dashboard since #393/#395, main app before that) send the
-- signed-in user's Clerk token, so is_admin() sees who they are.
--
-- Checked before writing: nothing reaches these tables with the anon key —
-- no edge function (all service role), no SECURITY INVOKER RPC, no main-app
-- read except user_roles via get_role_for_user (SECURITY DEFINER, unaffected).
-- Dashboard realtime on seo_tasks / agent_missions joins with the Clerk token
-- since #395, and realtime applies these same policies.
--
-- ROLLBACK: the previous policies are copied to ops.policy_backup_20261017.
-- Recreate one with:
--   SELECT format('CREATE POLICY %I ON public.%I AS %s FOR %s TO %s%s%s;',
--          policyname, tablename, permissive, cmd, array_to_string(roles, ','),
--          coalesce(' USING (' || qual || ')', ''), coalesce(' WITH CHECK (' || with_check || ')', ''))
--     FROM ops.policy_backup_20261017 WHERE tablename = '...';
-- and GRANT SELECT, INSERT, UPDATE, DELETE ON public.<table> TO anon;

-- ── 0. Rollback point ──────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS ops;
REVOKE ALL ON SCHEMA ops FROM anon, authenticated;
CREATE TABLE IF NOT EXISTS ops.policy_backup_20261017 AS
  SELECT now() AS saved_at, p.*
    FROM pg_policies p
   WHERE p.schemaname = 'public'
     AND p.tablename IN ('chat_messages','seo_tasks','seo_metrics','agent_missions','oauth_tokens','user_roles');
REVOKE ALL ON ops.policy_backup_20261017 FROM anon, authenticated;

-- ── 1. Five tables: admins only, for everything ────────────────────────
DO $lock$
DECLARE
  t text;
  p record;
BEGIN
  FOREACH t IN ARRAY ARRAY['chat_messages','seo_tasks','seo_metrics','agent_missions','oauth_tokens'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = t LOOP
      EXECUTE format('DROP POLICY %I ON public.%I', p.policyname, t);
    END LOOP;
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS PERMISSIVE FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin())',
      t || '_admin_only', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
  END LOOP;
END
$lock$;

-- ── 2. user_roles: anyone may read their own row, only admins may write ─
-- auth_select_own stays (a user reading their own role). The frontends get
-- roles through get_role_for_user / is_admin, both SECURITY DEFINER, so they
-- are unaffected by any of this.
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow all access to user_roles" ON public.user_roles;
DROP POLICY IF EXISTS user_roles_admin_all ON public.user_roles;
CREATE POLICY user_roles_admin_all ON public.user_roles
  AS PERMISSIVE FOR ALL TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());
REVOKE ALL ON public.user_roles FROM anon;

-- ── Verify (run after applying) ────────────────────────────────────────
--   -- no anon access left on the six tables (want 0 rows):
--   SELECT table_name, privilege_type FROM information_schema.role_table_grants
--    WHERE table_schema = 'public' AND grantee = 'anon'
--      AND table_name IN ('chat_messages','seo_tasks','seo_metrics','agent_missions','oauth_tokens','user_roles');
--
--   -- and every policy on them now requires is_admin(), except auth_select_own:
--   SELECT tablename, policyname, roles, qual FROM pg_policies
--    WHERE schemaname = 'public'
--      AND tablename IN ('chat_messages','seo_tasks','seo_metrics','agent_missions','oauth_tokens','user_roles');
