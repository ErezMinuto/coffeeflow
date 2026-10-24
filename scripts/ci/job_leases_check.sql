-- Checks acquire_job_lease / release_job_lease (migration 20261024c_job_leases).
-- Always ends in RAISE EXCEPTION, so every write is rolled back.
--
-- Dry-run before applying the migration (nothing persists):
--   BEGIN; <migration file>; <this file>; ROLLBACK;
-- After applying, run this file on its own.
DO $t$
DECLARE
  r   jsonb := '{}'::jsonb;
  who text;
  ok  boolean;
BEGIN
  DELETE FROM job_leases WHERE name = 'ci-check';
  r := r || jsonb_build_object('first_acquires',     CASE WHEN acquire_job_lease('ci-check', 'run-a', 600) THEN 'pass' ELSE 'FAIL' END);
  r := r || jsonb_build_object('second_refused',     CASE WHEN NOT acquire_job_lease('ci-check', 'run-b', 600) THEN 'pass' ELSE 'FAIL' END);
  r := r || jsonb_build_object('holder_reacquires',  CASE WHEN acquire_job_lease('ci-check', 'run-a', 600) THEN 'pass' ELSE 'FAIL' END);
  -- The call and the read are separate statements: a subquery in the same
  -- statement reads the snapshot from before the call.
  ok := release_job_lease('ci-check', 'run-b');
  r := r || jsonb_build_object('other_cannot_release', CASE WHEN NOT ok
    AND (SELECT holder FROM job_leases WHERE name = 'ci-check') = 'run-a' THEN 'pass' ELSE 'FAIL' END);
  UPDATE job_leases SET expires_at = now() - interval '1 second' WHERE name = 'ci-check';
  ok := acquire_job_lease('ci-check', 'run-b', 600);
  r := r || jsonb_build_object('expired_taken_over', CASE WHEN ok
    AND (SELECT holder FROM job_leases WHERE name = 'ci-check') = 'run-b' THEN 'pass' ELSE 'FAIL' END);
  ok := release_job_lease('ci-check', 'run-b');
  r := r || jsonb_build_object('holder_releases',    CASE WHEN ok
    AND NOT EXISTS (SELECT 1 FROM job_leases WHERE name = 'ci-check') THEN 'pass' ELSE 'FAIL' END);
  r := r || jsonb_build_object('free_again',         CASE WHEN acquire_job_lease('ci-check', 'run-c', 600) THEN 'pass' ELSE 'FAIL' END);
  BEGIN
    PERFORM acquire_job_lease('ci-check', 'run-c', 0);
    r := r || '{"rejects_bad_ttl":"FAIL"}';
  EXCEPTION WHEN invalid_parameter_value THEN r := r || '{"rejects_bad_ttl":"pass"}';
  END;
  FOREACH who IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    r := r || jsonb_build_object(who || '_denied', CASE WHEN
          NOT has_function_privilege(who, 'acquire_job_lease(text,text,integer)', 'EXECUTE')
      AND NOT has_function_privilege(who, 'release_job_lease(text,text)', 'EXECUTE')
      AND NOT has_table_privilege(who, 'job_leases', 'SELECT')
      THEN 'pass' ELSE 'FAIL' END);
  END LOOP;
  r := r || jsonb_build_object('service_role_allowed', CASE WHEN
        has_function_privilege('service_role', 'acquire_job_lease(text,text,integer)', 'EXECUTE')
    AND has_function_privilege('service_role', 'release_job_lease(text,text)', 'EXECUTE')
    THEN 'pass' ELSE 'FAIL' END);
  RAISE EXCEPTION 'DRYRUN_RESULT %', r::text;
END
$t$;
