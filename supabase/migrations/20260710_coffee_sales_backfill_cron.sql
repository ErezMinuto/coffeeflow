-- Minuto — nightly coffee-sales cache backfill cron.
--
-- Keeps coffee_sales_daily / coffee_sales_daily_totals current: each night it
-- asks icount-admin to compute any not-yet-cached FINAL day in a rolling ~10-day
-- lookback window. The backfill action is idempotent (skips days already in the
-- totals watermark), so a 10-day window cheaply self-heals any missed nights
-- without recomputing settled days.
--
-- Only days strictly before "today" (Asia/Jerusalem) are finalizable — today is
-- still open, so the report always recomputes it live and it is never cached.
--
-- Schedule: 01:30 UTC daily (~03:30 Israel summer / 04:30 winter) — well after
-- the business day closes, so "yesterday" is settled.
--
-- icount-admin is deployed with --no-verify-jwt, so no auth header is needed
-- (same as the other strategic crons). Run this AFTER the function carrying the
-- `coffee_sales_backfill` action is deployed.
--
-- Idempotent: unschedule first, then schedule. Safe to re-run.

SELECT cron.unschedule('coffee-sales-backfill-nightly')
WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'coffee-sales-backfill-nightly'
);

SELECT cron.schedule(
  'coffee-sales-backfill-nightly',
  '30 1 * * *',  -- 01:30 UTC daily
  $$
    SELECT net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/icount-admin',
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := jsonb_build_object(
        'action',    'coffee_sales_backfill',
        'from_date', to_char((now() AT TIME ZONE 'Asia/Jerusalem')::date - 10, 'YYYY-MM-DD'),
        'to_date',   to_char((now() AT TIME ZONE 'Asia/Jerusalem')::date - 1,  'YYYY-MM-DD')
      ),
      timeout_milliseconds := 120000
    );
  $$
);

-- Verify:
--   SELECT jobname, schedule, active FROM cron.job WHERE jobname='coffee-sales-backfill-nightly';
--
-- Watch runs:
--   SELECT start_time, status, return_message
--   FROM cron.job_run_details
--   WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname='coffee-sales-backfill-nightly')
--   ORDER BY start_time DESC LIMIT 10;
