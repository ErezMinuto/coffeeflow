-- ─────────────────────────────────────────────────────────────────────────
-- Audit: which public-schema tables are reachable via the Data API?
--
-- Run this in Supabase Dashboard → SQL Editor (prod project
-- ytydgldyeygpzmlxvpvb) ahead of the Oct 30, 2026 enforcement.
--
-- For each table in `public` it reports:
--   • rls_enabled        — true if RLS is on
--   • policy_count       — number of RLS policies attached
--   • anon_privs         — privileges granted to the `anon` role
--   • authenticated_privs — privileges granted to the `authenticated` role
--   • exposure           — derived posture (see CASE below)
--
-- Posture meanings:
--   service_role_only   — Edge functions only. Anon can't reach it. Fine.
--   anon_exposed_rls    — Anon can hit PostgREST; RLS gates rows. Intended
--                         for dashboard reads under the current model.
--   anon_exposed_no_rls — Anon can hit PostgREST AND no RLS — table is wide
--                         open. Investigate before Oct 30.
--   anon_grant_no_rls   — Has anon grants but RLS off; same risk as above.
--   review              — Anything else. Eyeball it.
-- ─────────────────────────────────────────────────────────────────────────

WITH grants AS (
  SELECT
    table_name,
    grantee,
    string_agg(DISTINCT privilege_type, ',' ORDER BY privilege_type) AS privs
  FROM information_schema.role_table_grants
  WHERE table_schema = 'public'
    AND grantee IN ('anon', 'authenticated')
  GROUP BY table_name, grantee
),
policies AS (
  SELECT tablename, COUNT(*) AS policy_count
  FROM pg_policies
  WHERE schemaname = 'public'
  GROUP BY tablename
)
SELECT
  t.tablename                                                  AS table_name,
  t.rowsecurity                                                AS rls_enabled,
  COALESCE(p.policy_count, 0)                                  AS policy_count,
  COALESCE(MAX(g.privs) FILTER (WHERE g.grantee = 'anon'), '') AS anon_privs,
  COALESCE(MAX(g.privs) FILTER (WHERE g.grantee = 'authenticated'), '') AS authenticated_privs,
  CASE
    WHEN COALESCE(MAX(g.privs) FILTER (WHERE g.grantee = 'anon'), '') = ''
     AND COALESCE(MAX(g.privs) FILTER (WHERE g.grantee = 'authenticated'), '') = ''
      THEN 'service_role_only'
    WHEN MAX(g.privs) FILTER (WHERE g.grantee = 'anon') IS NOT NULL
     AND t.rowsecurity = true
      THEN 'anon_exposed_rls'
    WHEN MAX(g.privs) FILTER (WHERE g.grantee = 'anon') IS NOT NULL
     AND t.rowsecurity = false
      THEN 'anon_exposed_no_rls'
    WHEN MAX(g.privs) FILTER (WHERE g.grantee = 'authenticated') IS NOT NULL
     AND t.rowsecurity = false
      THEN 'anon_grant_no_rls'
    ELSE 'review'
  END                                                          AS exposure
FROM pg_tables t
LEFT JOIN grants   g ON g.table_name = t.tablename
LEFT JOIN policies p ON p.tablename  = t.tablename
WHERE t.schemaname = 'public'
GROUP BY t.tablename, t.rowsecurity, p.policy_count
ORDER BY
  CASE
    WHEN COALESCE(MAX(g.privs) FILTER (WHERE g.grantee = 'anon'), '') = ''
     AND COALESCE(MAX(g.privs) FILTER (WHERE g.grantee = 'authenticated'), '') = ''
      THEN 3                                  -- service_role_only last
    WHEN MAX(g.privs) FILTER (WHERE g.grantee = 'anon') IS NOT NULL
     AND t.rowsecurity = false
      THEN 0                                  -- anon_exposed_no_rls first (riskiest)
    WHEN MAX(g.privs) FILTER (WHERE g.grantee = 'authenticated') IS NOT NULL
     AND t.rowsecurity = false
      THEN 1
    WHEN MAX(g.privs) FILTER (WHERE g.grantee = 'anon') IS NOT NULL
      THEN 2
    ELSE 4
  END,
  t.tablename;
