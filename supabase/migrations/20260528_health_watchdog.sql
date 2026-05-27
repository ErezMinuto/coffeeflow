-- Minuto Organic Marketing — health watchdog support.
--
-- Two pieces:
--   1. RPC `cron_last_run_for_job(text)` — exposes cron.job_run_details
--      so health-watchdog can detect silent crons. Direct access from
--      PostgREST isn't possible (cron.job_run_details lives in the cron
--      schema, not exposed by default + the join to cron.job is needed).
--   2. Cron `health-watchdog-daily` at 08:00 UTC.
--
-- SECURITY DEFINER on the RPC so the edge function's service_role JWT
-- can read cron metadata. Returns ONLY the last-run summary, not raw
-- run logs (no sensitive data exposed).

CREATE OR REPLACE FUNCTION cron_last_run_for_job(p_jobname TEXT)
RETURNS TABLE(start_time TIMESTAMPTZ, status TEXT, return_message TEXT)
LANGUAGE sql
SECURITY DEFINER
SET search_path = cron, public
AS $$
  SELECT jrd.start_time, jrd.status, jrd.return_message
  FROM cron.job_run_details jrd
  JOIN cron.job j ON j.jobid = jrd.jobid
  WHERE j.jobname = p_jobname
  ORDER BY jrd.start_time DESC
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION cron_last_run_for_job(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cron_last_run_for_job(TEXT) TO service_role;

-- Watchdog cron — daily 08:00 UTC. After scout (07:00) so any cron-fire
-- failures from earlier in the day window are detectable.
SELECT cron.unschedule('health-watchdog-daily')
WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'health-watchdog-daily'
);

SELECT cron.schedule(
  'health-watchdog-daily',
  '0 8 * * *',  -- 08:00 UTC daily
  $$
    SELECT net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/health-watchdog',
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := '{}'::jsonb,
      timeout_milliseconds := 60000   -- watchdog is mostly DB queries; 60s is plenty
    );
  $$
);
