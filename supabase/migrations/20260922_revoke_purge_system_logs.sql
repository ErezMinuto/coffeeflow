-- CoffeeFlow — stop `anon` being able to delete the entire system log.
--
-- WHAT THE ADVISOR CAUGHT
--   anon_security_definer_function_executable:
--   Function `public.purge_system_logs(p_keep_days integer)` can be executed by
--   the `anon` role as a `SECURITY DEFINER` function via
--   `/rest/v1/rpc/purge_system_logs`.
--
-- WHY IT MATTERS
-- 20260920_system_logs.sql is explicit that log rows are evidence:
--
--     "Deliberately NO delete policy: log rows are evidence. The purge job runs
--      as a SECURITY DEFINER function on a fixed age window, which is the only
--      way rows are meant to leave this table."
--
-- The RLS policy holds up — there is no DELETE policy, so neither anon nor
-- authenticated can delete a row directly. But purge_system_logs is
-- SECURITY DEFINER, so it runs with the owner's rights and bypasses RLS
-- entirely, and PostgREST exposes every function in `public` as an RPC. Default
-- EXECUTE therefore handed anon a delete path straight around the policy.
--
-- It is not even age-limited in practice: p_keep_days is a caller-supplied
-- parameter, so `POST /rest/v1/rpc/purge_system_logs {"p_keep_days": 0}` with
-- nothing but the anon key — which ships inside the frontend bundle — deletes
-- every row in system_logs. The "fixed age window" is fixed only by the
-- convention that the cron job passes 30.
--
-- That is precisely the failure this table exists to make debuggable: someone
-- wipes the trail of an incident, accidentally or otherwise, and the next
-- investigation starts blind.
--
-- WHY REVOKING IS SAFE
-- The only caller is the `system-logs-purge-daily` cron job, which runs the
-- statement `SELECT purge_system_logs(30);` as the job owner, not as anon or
-- authenticated. Nothing in the dashboard or any edge function calls it
-- (edge functions use the service role, which is unaffected either way).
-- Verified by searching the repo for every reference to the function.
--
-- NOT DONE HERE: the advisor lists ten other SECURITY DEFINER functions that
-- anon can execute. Most are deliberate — get_role_for_user is documented in
-- CLAUDE.md as "safe to call with anon key", and is_admin / get_my_role /
-- can_manage_schedule are the role checks the dashboard depends on. A blanket
-- revoke would break login. They need deciding one at a time, not in a sweep.

REVOKE EXECUTE ON FUNCTION public.purge_system_logs(integer) FROM anon;
REVOKE EXECUTE ON FUNCTION public.purge_system_logs(integer) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.purge_system_logs(integer) FROM PUBLIC;

COMMENT ON FUNCTION public.purge_system_logs IS
  'Deletes system_logs rows older than p_keep_days in 10k batches. Returns rows deleted. Run daily by system-logs-purge-daily. EXECUTE is revoked from anon/authenticated/PUBLIC on purpose: it is SECURITY DEFINER, so leaving it callable over /rest/v1/rpc lets anyone with the anon key pass p_keep_days=0 and wipe the table, bypassing the deliberate absence of a DELETE policy.';

-- ── Verify ─────────────────────────────────────────────────────────────
--   -- should return no rows for anon/authenticated/PUBLIC:
--   SELECT grantee, privilege_type
--     FROM information_schema.routine_privileges
--    WHERE routine_name = 'purge_system_logs'
--      AND grantee IN ('anon', 'authenticated', 'PUBLIC');
--
--   -- and the daily purge should keep succeeding:
--   SELECT status, return_message, start_time
--     FROM cron.job_run_details d JOIN cron.job j USING (jobid)
--    WHERE j.jobname = 'system-logs-purge-daily'
--    ORDER BY start_time DESC LIMIT 3;
