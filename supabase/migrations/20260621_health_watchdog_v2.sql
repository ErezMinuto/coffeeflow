-- Minuto — health-watchdog v2 support.
--
-- Why: woo-orders-sync silently froze for 12 days (2026-06-09 → 2026-06-21)
-- because its cron was NEVER registered in prod (the 2026-06-01 migration was
-- written but never applied). The v1 watchdog couldn't catch it: it only read
-- run history (cron.job_run_details), and a job that doesn't exist has no
-- history to read. It also never checked whether the DATA was advancing.
--
-- This adds one RPC: cron_job_health(jobname) — returns whether the job
-- EXISTS, whether it's ACTIVE, its schedule, and its last run's time+status.
-- The edge function uses it to flag missing/inactive/silent/failed crons, on
-- top of a new data-freshness layer that reads max(timestamp) per critical
-- table (the ground-truth "is the data actually moving?" signal).
--
-- SECURITY DEFINER so the edge function's service_role can read the cron
-- schema (not exposed via PostgREST by default). Returns only summary
-- metadata, no raw run logs.
--
-- Idempotent. The v1 RPC cron_last_run_for_job is left in place (still
-- referenced as a graceful-degradation fallback).

CREATE OR REPLACE FUNCTION cron_job_health(p_jobname TEXT)
RETURNS TABLE(active BOOLEAN, schedule TEXT, last_start TIMESTAMPTZ, last_status TEXT)
LANGUAGE sql
SECURITY DEFINER
SET search_path = cron, public
AS $$
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
      LIMIT 1) AS last_status
  FROM cron.job j
  WHERE j.jobname = p_jobname;
$$;

REVOKE ALL ON FUNCTION cron_job_health(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cron_job_health(TEXT) TO service_role;

-- Verify:
--   SELECT * FROM cron_job_health('woo-orders-sync-daily');
--   SELECT * FROM cron_job_health('does-not-exist');  -- returns 0 rows
