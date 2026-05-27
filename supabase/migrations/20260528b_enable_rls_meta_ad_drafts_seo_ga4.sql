-- Supabase flagged `rls_disabled_in_public` on three tables created
-- after the prior 20260429b cleanup:
--   1. meta_ad_drafts   — created 20260511b with explicit GRANTs to
--                         anon/authenticated. Actually publicly readable
--                         and writable via the embedded anon key, which
--                         is the most serious of the three.
--   2. seo_learnings    — created 20260527 with DISABLE ROW LEVEL SECURITY.
--                         No anon grants, but still trips the linter.
--   3. ga4_pages_daily  — created 20260528 with DISABLE ROW LEVEL SECURITY.
--                         Same situation as seo_learnings.
--
-- Verified: none are read or written by frontend code (grep'd
-- dashboard/src and src for `from('<table>')`). All access is via edge
-- functions running with the service_role key, which bypasses RLS. So
-- enabling RLS without any policy keeps service-role access intact and
-- denies anon entirely — same posture as 20260429b_enable_rls_on_data_tables.
--
-- For meta_ad_drafts we also revoke the redundant anon/authenticated
-- grants so the table looks like the other service-role-only tables.

ALTER TABLE meta_ad_drafts   ENABLE ROW LEVEL SECURITY;
ALTER TABLE seo_learnings    ENABLE ROW LEVEL SECURITY;
ALTER TABLE ga4_pages_daily  ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON meta_ad_drafts FROM anon, authenticated;
REVOKE ALL ON SEQUENCE meta_ad_drafts_id_seq FROM anon, authenticated;

-- Verification (run post-apply):
--   SELECT tablename, rowsecurity FROM pg_tables
--    WHERE schemaname = 'public'
--      AND tablename IN ('meta_ad_drafts', 'seo_learnings', 'ga4_pages_daily');
--   -- expect rowsecurity = true for all three
--
--   SELECT grantee, privilege_type FROM information_schema.role_table_grants
--    WHERE table_schema = 'public' AND table_name = 'meta_ad_drafts'
--      AND grantee IN ('anon', 'authenticated');
--   -- expect 0 rows
