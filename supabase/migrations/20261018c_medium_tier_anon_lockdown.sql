-- CoffeeFlow — take the public anon key off the remaining writable tables:
-- the AI agents' inputs, the sync/sales data, the roasting and schedule data,
-- and the logs. Follow-up to 20261017b_critical_tables_staff_and_admin.sql.
--
-- WHAT WAS WRONG (audit 2026-10-18)
-- 42 public tables had an anon grant AND a policy letting anon/public insert,
-- update or delete. The anon key ships in both frontend bundles, so anyone
-- could rewrite them. Worst: the tables the agents READ as input (strategist
-- briefs/theses/signals, market research, competitor pages, advisor reports,
-- keyword ideas, the Gemini prompt cache) — a prompt-injection channel into
-- agents that hold write tools (ads drafts, blog publish, email).
--
-- THREE TIERS
--   ADMIN READ, SERVICE WRITE — only edge functions write these (service role,
--     bypasses RLS); only the admin dashboard reads them (it has no non-admin
--     users; see #398). Views over them (mx_*, mflow_revenue) are
--     security_invoker and are read by functions and the admin SeoMetricsPanel.
--   ADMIN READ + UPDATE — strategic_recommendations, strategist_signals: the
--     dashboard (StrategicBriefPanel / NeedsYou) changes their status.
--   KNOWN STAFF — the main app's tables. Every existing rule is kept and ANDed
--     with is_staff(), exactly as in 20261017b. cost_settings additionally
--     becomes per-user (user_id = the caller's Clerk id), as the app reads it.
--
-- Checked before writing: every edge function reaching these tables uses the
-- service role (only artisan-import used the CALLER's key, as a probe — now
-- gated with isStaff() in the same PR); the main app writes via supabase-js
-- with the Clerk token on HTTP and realtime (#397). Tables that no longer
-- exist are skipped (coffee_sales_daily_totals was dropped 2026-10-17).
--
-- ROLLBACK: previous policies are in ops.policy_backup_20261018c; the restore
-- query is in 20261017_admin_only_sensitive_tables.sql, plus
-- GRANT SELECT, INSERT, UPDATE, DELETE ON public.<table> TO anon (and to
-- authenticated for the admin tiers).

-- ── 0. Rollback point ──────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS ops;
REVOKE ALL ON SCHEMA ops FROM anon, authenticated;
CREATE TABLE IF NOT EXISTS ops.policy_backup_20261018c AS
  SELECT now() AS saved_at, p.*
    FROM pg_policies p
   WHERE p.schemaname = 'public'
     AND p.tablename IN (
       'advisor_completed_actions','advisor_reports','advisor_scores','agent_cost_ledger','campaign_events',
       'coffee_sales_daily','coffee_sales_daily_totals','competitor_pages','gemini_prompt_cache','google_ads',
       'google_campaigns','google_search_console','inventory_adjustments','keyword_ideas','market_research',
       'meta_ad_campaigns','meta_daily_insights','meta_organic_posts','mflow_sell_events','mflow_sell_lines',
       'minuto_blog_posts','shop_consumption_logs','attendance_reminders_sent','strategic_briefs',
       'strategic_theses','strategist_runs','sync_log','system_logs','woo_products',
       'strategic_recommendations','strategist_signals',
       'artisan_profiles','attendance_holidays','attendance_settings','operators','origins','packing_logs',
       'roast_components','roast_profile_ingredients','roast_profiles','roasts','schedules','cost_settings');
REVOKE ALL ON ops.policy_backup_20261018c FROM anon, authenticated;

-- ── 1. Admin read; only the service role writes ────────────────────────
DO $admin_read$
DECLARE
  t text;
  p record;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    -- agent inputs
    'strategic_briefs','strategic_theses','strategist_runs','market_research','competitor_pages',
    'advisor_reports','advisor_scores','advisor_completed_actions','keyword_ideas','gemini_prompt_cache',
    'minuto_blog_posts','meta_organic_posts','campaign_events','agent_cost_ledger',
    -- synced / derived data
    'google_ads','google_campaigns','google_search_console','meta_ad_campaigns','meta_daily_insights',
    'woo_products','mflow_sell_events','mflow_sell_lines','coffee_sales_daily','coffee_sales_daily_totals',
    'inventory_adjustments','shop_consumption_logs','attendance_reminders_sent',
    -- logs
    'sync_log','system_logs'] LOOP
    IF to_regclass(format('public.%I', t)) IS NULL THEN
      RAISE NOTICE 'skip %: no such table', t;
      CONTINUE;
    END IF;
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = t LOOP
      EXECUTE format('DROP POLICY %I ON public.%I', p.policyname, t);
    END LOOP;
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS PERMISSIVE FOR SELECT TO authenticated USING (public.is_admin())',
      t || '_admin_read', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.%I FROM authenticated', t);
  END LOOP;
END
$admin_read$;

-- ── 2. Admin read + update (the dashboard sets their status) ───────────
DO $admin_update$
DECLARE
  t text;
  p record;
BEGIN
  FOREACH t IN ARRAY ARRAY['strategic_recommendations','strategist_signals'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = t LOOP
      EXECUTE format('DROP POLICY %I ON public.%I', p.policyname, t);
    END LOOP;
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS PERMISSIVE FOR SELECT TO authenticated USING (public.is_admin())',
      t || '_admin_read', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS PERMISSIVE FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin())',
      t || '_admin_update', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
    EXECUTE format('REVOKE INSERT, DELETE, TRUNCATE ON public.%I FROM authenticated', t);
  END LOOP;
END
$admin_update$;

-- ── 3. Known staff: keep every rule, add is_staff(), drop anon ─────────
DO $staff$
DECLARE
  t text;
  p record;
  using_clause text;
  check_clause text;
BEGIN
  FOREACH t IN ARRAY ARRAY['roasts','roast_components','roast_profiles','roast_profile_ingredients','origins',
                           'operators','packing_logs','artisan_profiles','schedules','attendance_holidays',
                           'attendance_settings'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    FOR p IN
      SELECT * FROM pg_policies
       WHERE schemaname = 'public' AND tablename = t
         AND roles && ARRAY['anon','authenticated','public']::name[]
    LOOP
      using_clause := CASE WHEN p.cmd = 'INSERT' THEN ''
                           ELSE format(' USING ((%s) AND public.is_staff())', coalesce(p.qual, 'true')) END;
      check_clause := CASE WHEN p.cmd IN ('INSERT','UPDATE','ALL')
                           THEN format(' WITH CHECK ((%s) AND public.is_staff())', coalesce(p.with_check, p.qual, 'true'))
                           ELSE '' END;
      EXECUTE format('DROP POLICY %I ON public.%I', p.policyname, t);
      EXECUTE format('CREATE POLICY %I ON public.%I AS %s FOR %s TO authenticated%s%s',
                     p.policyname, t, p.permissive, p.cmd, using_clause, check_clause);
    END LOOP;
    EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
  END LOOP;
END
$staff$;

-- ── 4. cost_settings: your own row, and only if you are staff ──────────
DO $cost$
DECLARE
  p record;
BEGIN
  ALTER TABLE public.cost_settings ENABLE ROW LEVEL SECURITY;
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'cost_settings' LOOP
    EXECUTE format('DROP POLICY %I ON public.cost_settings', p.policyname);
  END LOOP;
  CREATE POLICY cost_settings_own_row ON public.cost_settings AS PERMISSIVE FOR ALL TO authenticated
    USING (user_id::text = (auth.jwt() ->> 'sub') AND public.is_staff())
    WITH CHECK (user_id::text = (auth.jwt() ->> 'sub') AND public.is_staff());
  REVOKE ALL ON public.cost_settings FROM anon;
END
$cost$;

-- ── Verify ─────────────────────────────────────────────────────────────
-- scripts/ci/medium_tier_check.sql (runs as anon / stranger / employee /
-- schedule manager / admin, always rolls back).
