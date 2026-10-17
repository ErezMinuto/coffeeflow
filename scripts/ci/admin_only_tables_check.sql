-- Access test for 20261017_admin_only_sensitive_tables.sql.
--
-- Runs every check as anon, a signed-in stranger, the employee and an admin
-- (simulated JWT claims, no real tokens), then RAISES with the results — so the
-- transaction always rolls back and nothing it inserts is kept. Safe on prod:
--
--   run it through the Management API / SQL editor; read the DRYRUN_RESULT
--   line in the error. Expected after the migration:
--     anon      every table DENIED, self_grant_admin blocked
--     stranger  every table 0,       self_grant_admin blocked
--     employee  every table 0 (user_roles 1 = own row), self_grant_admin blocked
--     admin     every table "all N", self_grant_admin ALLOWED
DO $t$
DECLARE
  r jsonb := '{"anon":{},"stranger":{},"employee":{},"admin":{}}'::jsonb;
  n bigint;
  admin_sub text := (SELECT user_id FROM public.user_roles WHERE role = 'admin' ORDER BY created_at LIMIT 1);
  emp_sub   text := (SELECT user_id FROM public.user_roles WHERE role = 'employee' LIMIT 1);
  tbl text;
  want_total jsonb := jsonb_build_object(
    'chat_messages', (SELECT count(*) FROM public.chat_messages), 'seo_tasks', (SELECT count(*) FROM public.seo_tasks),
    'seo_metrics', (SELECT count(*) FROM public.seo_metrics), 'agent_missions', (SELECT count(*) FROM public.agent_missions),
    'oauth_tokens', (SELECT count(*) FROM public.oauth_tokens), 'user_roles', (SELECT count(*) FROM public.user_roles));
  who text;
BEGIN
  FOR who IN SELECT unnest(ARRAY['anon','stranger','employee','admin']) LOOP
    IF who = 'anon' THEN
      PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true); EXECUTE 'SET LOCAL ROLE anon';
    ELSE
      PERFORM set_config('request.jwt.claims', json_build_object('role','authenticated','sub',
        CASE who WHEN 'admin' THEN admin_sub WHEN 'employee' THEN emp_sub ELSE 'user_test_stranger' END)::text, true);
      EXECUTE 'SET LOCAL ROLE authenticated';
    END IF;
    FOREACH tbl IN ARRAY ARRAY['chat_messages','seo_tasks','seo_metrics','agent_missions','oauth_tokens','user_roles'] LOOP
      BEGIN
        EXECUTE format('SELECT count(*) FROM public.%I', tbl) INTO n;
        r := jsonb_set(r, ARRAY[who, tbl], to_jsonb(CASE WHEN n = (want_total->>tbl)::bigint THEN 'all ' || n ELSE n::text END), true);
      EXCEPTION WHEN insufficient_privilege THEN
        r := jsonb_set(r, ARRAY[who, tbl], '"DENIED"', true);
      END;
      IF NOT r ? who THEN r := r || jsonb_build_object(who, '{}'::jsonb); END IF;
    END LOOP;
    -- Can this caller make themselves admin?
    BEGIN
      EXECUTE format('INSERT INTO public.user_roles (user_id, role) VALUES (%L, %L)', 'user_test_escalation_' || who, 'admin');
      r := jsonb_set(r, ARRAY[who, 'self_grant_admin'], '"ALLOWED"', true);
    EXCEPTION WHEN insufficient_privilege OR check_violation THEN
      r := jsonb_set(r, ARRAY[who, 'self_grant_admin'], '"blocked"', true);
    WHEN others THEN
      r := jsonb_set(r, ARRAY[who, 'self_grant_admin'], to_jsonb('blocked: ' || SQLSTATE), true);
    END;
    EXECUTE 'RESET ROLE';
  END LOOP;
  RAISE EXCEPTION 'DRYRUN_RESULT %', r::text;
END
$t$;
