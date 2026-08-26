-- cron_job_health: expose the last SUCCESSFUL run, not just the last run.
--
-- WHY. health-watchdog's cron_failed check looks only at the most recent run,
-- so it cannot tell "this job is dead" from "this job hiccuped once and will
-- retry". For a DAILY cron a single transient failure produces ERROR alerts for
-- a full 24 hours about something already fixed, with no action available.
--
-- That is exactly what happened on 2026-08-26: a project-wide outage failed one
-- run each of industry-intelligence-daily and meta-sync-daily. Both had
-- succeeded on 08-24 and 08-25 and both would retry on schedule, but the
-- watchdog kept raising two ERRORs because "most recent = failed" stays true
-- until tomorrow's run.
--
-- With last_success the watchdog can suppress a failure that has a recent
-- success behind it, and rely on the existing cron_silent check (which is
-- already budgeted per job via max_silence_hours) to catch a job that has
-- genuinely stopped working. No real failure is hidden: a job failing EVERY run
-- stops producing successes and cron_silent fires on its own budget.
--
-- DROP + CREATE rather than CREATE OR REPLACE: the RETURNS TABLE signature
-- changes, and Postgres will not replace a function whose result type differs.
-- The watchdog degrades safely in the gap — it already skips the cron check
-- when the RPC errors, and treats a missing last_success as "unknown" and keeps
-- alerting, so a partially-applied deploy is noisy rather than blind.

DROP FUNCTION IF EXISTS public.cron_job_health(text);

CREATE FUNCTION public.cron_job_health(p_jobname text)
RETURNS TABLE(
  active       boolean,
  schedule     text,
  last_start   timestamptz,
  last_status  text,
  last_success timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'cron', 'public'
AS $function$
  SELECT
    j.active,
    j.schedule,
    (SELECT jrd.start_time
       FROM cron.job_run_details jrd
      WHERE jrd.jobid = j.jobid
      ORDER BY jrd.start_time DESC
      LIMIT 1) AS last_start,
    (SELECT jrd.status
       FROM cron.job_run_details jrd
      WHERE jrd.jobid = j.jobid
      ORDER BY jrd.start_time DESC
      LIMIT 1) AS last_status,
    -- The newest run that actually SUCCEEDED, regardless of what has happened
    -- since. This is the signal that separates a blip from a dead job.
    (SELECT jrd.start_time
       FROM cron.job_run_details jrd
      WHERE jrd.jobid = j.jobid
        AND jrd.status = 'succeeded'
      ORDER BY jrd.start_time DESC
      LIMIT 1) AS last_success
  FROM cron.job j
  WHERE j.jobname = p_jobname;
$function$;

-- The watchdog calls this with the service role; anon/authenticated keep the
-- same access they had, since the function is SECURITY DEFINER and only reads
-- cron metadata.
GRANT EXECUTE ON FUNCTION public.cron_job_health(text) TO anon, authenticated, service_role;

-- Verify:
--   SELECT * FROM cron_job_health('meta-sync-daily');
