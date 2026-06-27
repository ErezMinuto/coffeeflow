-- Minuto Strategist Brain — Phase 2a: executor cron.
--
-- Polls the strategist-executor every 2 minutes. It claims APPROVED
-- recommendations and drafts them into the existing content queue (never sends/
-- publishes). Idle + cheap when nothing is approved (one indexed SELECT, no
-- model call), so a tight cadence just minimizes draft latency after you approve.
--
-- Deploy the function with --no-verify-jwt. Idempotent: unschedule then schedule.

SELECT cron.unschedule('strategist-executor-tick')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'strategist-executor-tick');

SELECT cron.schedule(
  'strategist-executor-tick',
  '*/2 * * * *',
  $$
    SELECT net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/strategist-executor',
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := '{}'::jsonb,
      timeout_milliseconds := 60000
    );
  $$
);

-- Verify:
--   SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'strategist-executor-tick';
