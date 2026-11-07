-- Minuto — woo-orders-sync daily cron.
--
-- Why this exists: woo-orders-sync had NO version-controlled schedule. It
-- ran via some ad-hoc/manual trigger that lapsed around 2026-05-26, so
-- woo_orders silently froze at order 80722 while live orders climbed past
-- 80850. Discovered 2026-06-01: the synced table was ~6 days stale, which
-- starved every consumer that reads woo_orders — refill_reminder and
-- first_purchase candidate finders, plus the dashboard's revenue numbers.
--
-- The function itself was healthy the whole time (a manual {"days_back":12}
-- call backfilled 33 missing paid orders on 2026-06-01). The failure was
-- purely that nothing was calling it on a schedule. This migration fixes
-- the root cause by giving it a real cron, the same way meta-sync and
-- ga4-sync got theirs on 2026-05-28.
--
-- Schedule: 09:30 UTC daily — 30 min before the email-automation cron
-- (0 10 * * *, see 20260428e_email_automation_daily_cron.sql) so that
-- refill_reminder / first_purchase see fresh paid orders when they run.
-- Daily (not Sun/Wed) because the dashboard and the abandoned-cart recovery
-- both benefit from same-day data, and the sync is incremental + cheap.
--
-- NOTE on abandoned-cart: as of 2026-06-01 the abandoned-cart recovery
-- check no longer depends on this table — it queries WooCommerce LIVE
-- (email-automation-scheduler fetchLatestPaidByEmail) precisely because a
-- stale woo_orders would have emailed customers who already paid. This cron
-- is still needed for the OTHER woo_orders consumers listed above.
--
-- Empty body {} runs the function's default incremental sync (max stored
-- woo_order_id + a 3-day safety buffer), which catches every new paid order
-- regardless of past gaps.
--
-- Idempotent: unschedule first, then schedule. Safe to re-run.

SELECT cron.unschedule('woo-orders-sync-daily')
WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'woo-orders-sync-daily'
);

SELECT cron.schedule(
  'woo-orders-sync-daily',
  '30 9 * * *',  -- 09:30 UTC daily (30 min before the 10:00 email-automation cron)
  $$
    SELECT net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/woo-orders-sync',
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := '{}'::jsonb,
      timeout_milliseconds := 150000
    );
  $$
);

-- Verify:
--   SELECT jobname, schedule, active FROM cron.job WHERE jobname='woo-orders-sync-daily';
--
-- Watch runs:
--   SELECT start_time, status, return_message
--   FROM cron.job_run_details
--   WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname='woo-orders-sync-daily')
--   ORDER BY start_time DESC LIMIT 10;
