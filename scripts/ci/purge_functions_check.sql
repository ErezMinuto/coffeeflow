-- Privilege check for the SECURITY DEFINER purge functions
-- (migration 20261107120000_lock_purge_system_logs.sql).
--
-- Each purge_* function deletes rows as postgres. If anon or authenticated can
-- EXECUTE one, the public anon key can wipe its table over PostgREST
-- (/rest/v1/rpc/<name>). This fails if any of them is re-granted, including a
-- purge_* function added later without a REVOKE.
--
-- Read-only (privilege lookups, plus one purge_system_logs(0) call, made only
-- when the guard is in the source, that must raise before deleting), and ends in RAISE like the other
-- *_check.sql files, so it is safe on prod; scripts/qa-scan.sh --db runs it.
-- Expected: every key "ok" and "detail": {}. A "FAIL" says why under "detail".
DO $t$
DECLARE
  r jsonb := '{}'::jsonb;
  f record;
  who text;
  bad text[];
  detail jsonb := '{}'::jsonb;
BEGIN
  -- The three known ones must exist (a rename would silently skip the loop).
  r := r || jsonb_build_object('known_functions_present', CASE WHEN
        to_regprocedure('public.purge_system_logs(integer)') IS NOT NULL
    AND to_regprocedure('public.purge_chat_messages(integer)') IS NOT NULL
    AND to_regprocedure('public.purge_packing_logs()') IS NOT NULL
    THEN 'ok' ELSE 'FAIL' END);

  -- purge_system_logs refuses a window under 7 days. It is only CALLED when
  -- its source still holds the guard: without it, purge_system_logs(0) would
  -- delete every row before this block's RAISE rolled that back, which is
  -- real IO on prod. With the guard it raises before touching the table.
  IF (SELECT prosrc FROM pg_proc
       WHERE oid = to_regprocedure('public.purge_system_logs(integer)')) NOT LIKE '%p_keep_days < 7%' THEN
    r := r || '{"system_logs_floor":"FAIL"}';
    detail := detail || '{"system_logs_floor":"guard p_keep_days < 7 missing from the source; not called"}';
  ELSE
    BEGIN
      PERFORM public.purge_system_logs(0);
      r := r || '{"system_logs_floor":"FAIL"}';
      detail := detail || '{"system_logs_floor":"purge_system_logs(0) did not raise"}';
    EXCEPTION WHEN invalid_parameter_value THEN r := r || '{"system_logs_floor":"ok"}';
    END;
  END IF;

  FOR f IN
    SELECT p.oid, p.oid::regprocedure::text AS sig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname LIKE 'purge\_%' AND p.prosecdef
    ORDER BY 2
  LOOP
    bad := ARRAY[]::text[];
    FOREACH who IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF has_function_privilege(who, f.oid, 'EXECUTE') THEN
        bad := bad || ('executable by ' || who);
      END IF;
    END LOOP;
    IF NOT has_function_privilege('service_role', f.oid, 'EXECUTE') THEN
      bad := bad || 'service_role cannot execute'::text;
    END IF;
    r := r || jsonb_build_object(f.sig, CASE WHEN cardinality(bad) = 0 THEN 'ok' ELSE 'FAIL' END);
    IF cardinality(bad) > 0 THEN
      detail := detail || jsonb_build_object(f.sig, array_to_string(bad, '; '));
    END IF;
  END LOOP;

  r := r || jsonb_build_object('detail', detail);
  RAISE EXCEPTION 'DRYRUN_RESULT %', r::text;
END
$t$;
