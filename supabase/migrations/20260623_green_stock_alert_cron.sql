-- Minuto — green-coffee low-stock alert daily cron.
--
-- Why this exists: this alert used to run inside the MFlow Railway scraper
-- (workers/mflow-scraper/alert.js, 05:00 Asia/Jerusalem). MFlow/Railway was
-- retired once iCount became the POS, so the alert was ported to the
-- green-stock-alert edge function. This cron is its new schedule.
--
-- What it does: reads `origins`, flags any with < 14 days of green coffee left
-- (stock / daily_average), and posts a short Hebrew Telegram alert to the team
-- group chat. Silent when all origins are above the threshold.
--
-- Schedule: 03:00 UTC daily (~06:00 Israel summer / 05:00 winter) — early
-- morning, roughly matching the old 05:00 Israel run.
--
-- The function is deployed with --no-verify-jwt, so no auth header is needed
-- (same as the other strategic crons).
--
-- Idempotent: unschedule first, then schedule. Safe to re-run.

SELECT cron.unschedule('green-stock-alert-daily')
WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'green-stock-alert-daily'
);

SELECT cron.schedule(
  'green-stock-alert-daily',
  '0 3 * * *',  -- 03:00 UTC daily
  $$
    SELECT net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/green-stock-alert',
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := '{}'::jsonb,
      timeout_milliseconds := 60000
    );
  $$
);

-- Verify:
--   SELECT jobname, schedule, active FROM cron.job WHERE jobname='green-stock-alert-daily';
--
-- Watch runs:
--   SELECT start_time, status, return_message
--   FROM cron.job_run_details
--   WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname='green-stock-alert-daily')
--   ORDER BY start_time DESC LIMIT 10;
