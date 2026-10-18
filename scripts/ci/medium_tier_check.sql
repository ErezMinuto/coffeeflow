-- Access test for 20261018c_medium_tier_anon_lockdown.sql.
--
-- For anon, a signed-in stranger, the employee, the schedule manager and an
-- admin (simulated JWT claims, no real tokens): how many rows each can read in
-- every table, and whether a no-op UPDATE of one row goes through. Ends with
-- RAISE, so the transaction always rolls back — the no-op updates, and any
-- trigger or pg_net request they cause, are discarded. Safe on prod.
--
-- Read the DRYRUN_RESULT line. Per table: "<read>/<update>", where read is
-- "all" (every row visible), a row count, or "DENIED" (no grant), and update
-- is rows updated or "DENIED". "still_anon_writable" lists every public table
-- anon still holds INSERT/UPDATE/DELETE on (should be empty).
-- Expected after the migration:
--   anon             DENIED/DENIED everywhere
--   stranger         0/0 or 0/DENIED everywhere
--   employee         staff tables as before (all/1 where the app lets them
--                    write), admin tables 0/DENIED (A′: 0/0)
--   schedule_manager as employee
--   admin            staff tables all/1, admin-read tables all/DENIED,
--                    strategic_recommendations + strategist_signals all/1
--   cost_settings    own row only (1/1 when the user has one, else 0/0)
DO $t$
DECLARE
  r jsonb := '{}'::jsonb;
  who text;
  sub text;
  tbl text;
  col text;
  n bigint;
  u bigint;
  total bigint;
  rd text;
  wr text;
  tables text[] := ARRAY[
    'strategic_briefs','strategic_theses','strategist_runs','market_research','competitor_pages',
    'advisor_reports','advisor_scores','advisor_completed_actions','keyword_ideas','gemini_prompt_cache',
    'minuto_blog_posts','meta_organic_posts','campaign_events','agent_cost_ledger',
    'google_ads','google_campaigns','google_search_console','meta_ad_campaigns','meta_daily_insights',
    'woo_products','mflow_sell_events','mflow_sell_lines','coffee_sales_daily',
    'inventory_adjustments','shop_consumption_logs','attendance_reminders_sent','sync_log','system_logs',
    'strategic_recommendations','strategist_signals',
    'roasts','roast_components','roast_profiles','roast_profile_ingredients','origins','operators',
    'packing_logs','artisan_profiles','schedules','attendance_holidays','attendance_settings','cost_settings',
    -- views over the admin tables (security_invoker)
    'mflow_revenue','mx_campaigns','mx_paid_daily'];
BEGIN
  FOREACH who IN ARRAY ARRAY['anon','stranger','employee','schedule_manager','admin'] LOOP
    r := r || jsonb_build_object(who, '{}'::jsonb);
    sub := CASE who
      WHEN 'stranger' THEN 'user_test_stranger'
      WHEN 'anon' THEN NULL
      ELSE (SELECT user_id FROM public.user_roles WHERE role = who ORDER BY created_at LIMIT 1) END;
    FOREACH tbl IN ARRAY tables LOOP
      IF to_regclass(format('public.%I', tbl)) IS NULL THEN
        r := jsonb_set(r, ARRAY[who, tbl], '"missing"', true);
        CONTINUE;
      END IF;
      EXECUTE format('SELECT count(*) FROM public.%I', tbl) INTO total;
      -- any updatable column: set it to itself
      SELECT column_name INTO col FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = tbl AND is_generated = 'NEVER' AND is_identity = 'NO'
       ORDER BY (column_name = 'id') DESC, ordinal_position LIMIT 1;
      IF who = 'anon' THEN
        PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true); EXECUTE 'SET LOCAL ROLE anon';
      ELSE
        PERFORM set_config('request.jwt.claims', json_build_object('role','authenticated','sub',sub)::text, true);
        EXECUTE 'SET LOCAL ROLE authenticated';
      END IF;
      BEGIN
        EXECUTE format('SELECT count(*) FROM public.%I', tbl) INTO n;
        rd := CASE WHEN n = total AND n > 0 THEN 'all' ELSE n::text END;
      EXCEPTION
        WHEN insufficient_privilege THEN rd := 'DENIED';
        WHEN others THEN rd := 'err:' || SQLSTATE;
      END;
      IF tbl IN ('mflow_revenue','mx_campaigns','mx_paid_daily') THEN
        wr := '-';
      ELSE
        BEGIN
          EXECUTE format('UPDATE public.%I SET %I = %I WHERE ctid = (SELECT ctid FROM public.%I LIMIT 1)', tbl, col, col, tbl);
          GET DIAGNOSTICS u = ROW_COUNT;
          wr := u::text;
        EXCEPTION
          WHEN insufficient_privilege THEN wr := 'DENIED';
          WHEN others THEN wr := 'err:' || SQLSTATE;
        END;
      END IF;
      EXECUTE 'RESET ROLE';
      r := jsonb_set(r, ARRAY[who, tbl], to_jsonb(rd || '/' || wr), true);
    END LOOP;
  END LOOP;
  r := r || jsonb_build_object('still_anon_writable', (
    SELECT coalesce(jsonb_agg(c.relname ORDER BY c.relname), '[]'::jsonb)
      FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
     WHERE s.nspname = 'public' AND c.relkind IN ('r','p')
       AND (has_table_privilege('anon', c.oid, 'INSERT') OR has_table_privilege('anon', c.oid, 'UPDATE')
            OR has_table_privilege('anon', c.oid, 'DELETE'))
       AND EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname
                    AND p.cmd IN ('INSERT','UPDATE','DELETE','ALL')
                    AND p.roles && ARRAY['anon','public']::name[])));
  RAISE EXCEPTION 'DRYRUN_RESULT %', r::text;
END
$t$;
