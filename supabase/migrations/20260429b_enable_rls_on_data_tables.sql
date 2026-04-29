-- Supabase flagged 4 tables as `rls_disabled_in_public` — critical
-- security warning. Without RLS enabled, anyone with the project's
-- public anon key can read/write/delete any row in these tables.
-- The anon key is embedded in the dashboard's JS bundle, so this
-- effectively means "anyone who views the dashboard source can read
-- the entire ad-platform sync database".
--
-- Verified: none of these tables are read by the frontend code
-- (grep'd dashboard/src and src for `from('<table>')`). They're written
-- and read only by edge functions running with the service_role key,
-- which bypasses RLS. So enabling RLS without adding any policy is the
-- correct posture: service role keeps full access; anon is fully denied.
--
-- This is intentionally MORE restrictive than the "allow all for anon,
-- authenticated" pattern used by user-facing tables (user_roles,
-- email_automation_templates, form_submissions, etc.) because there's
-- no legitimate anon-key access path to these data tables.

ALTER TABLE google_campaign_settings   ENABLE ROW LEVEL SECURITY;
ALTER TABLE google_conversion_actions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta_ad_adsets             ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta_ads                   ENABLE ROW LEVEL SECURITY;

-- Verification (run after applying):
--   SELECT tablename, rowsecurity FROM pg_tables
--    WHERE schemaname = 'public'
--      AND tablename IN ('google_campaign_settings', 'google_conversion_actions',
--                        'meta_ad_adsets', 'meta_ads');
--   All four should show rowsecurity = true.
