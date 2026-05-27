-- Minuto SEO Agent — ga4-sync daily cron.
--
-- Polls GA4 Data API once per day at 06:00 UTC (09:00 Israel) to pull
-- the trailing 7-day window of Organic Search landing-page performance
-- into ga4_pages_daily. Re-syncing the same window every day captures
-- late-arriving conversions (GA4 attribution can take 24-72h to settle).
--
-- Cadence rationale:
--   • Daily is more than enough — orchestrator only runs twice weekly
--   • 7-day lookback per run = ~30 rows/day after the first full sync
--     (the catch-up first run pulls 30 days; subsequent runs are tiny)
--   • Conversions table reaches steady state ~3 days after publish
--
-- Idempotent: unschedule first, then schedule. Safe to re-run.

SELECT cron.unschedule('ga4-sync-daily')
WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'ga4-sync-daily'
);

SELECT cron.schedule(
  'ga4-sync-daily',
  '0 6 * * *',  -- 06:00 UTC daily (09:00 Asia/Jerusalem)
  $$
    SELECT net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/ga4-sync',
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := '{"lookback_days":7}'::jsonb,
      timeout_milliseconds := 120000  -- 2 min; GA4 reports typically return in 5-20s
    );
  $$
);

-- Verify post-apply:
--   SELECT jobname, schedule, active FROM cron.job WHERE jobname='ga4-sync-daily';
--
-- Watch runs:
--   SELECT start_time, status, return_message
--   FROM cron.job_run_details
--   WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname='ga4-sync-daily')
--   ORDER BY start_time DESC LIMIT 10;
