-- Minuto Organic Marketing — meta-sync daily cron.
--
-- Without this cron, meta_organic_posts + meta_ad_daily stale by days or
-- weeks (meta-sync only ran on manual dashboard click before now). That
-- starved the IG side of the autonomous reinforcement loop — the
-- orchestrator and the experiment evaluator both read these tables but
-- found old or empty data.
--
-- Schedule: 05:30 UTC daily. Picked to land just before the SEO crons
-- (orchestrator fires Sun/Wed 05:00 UTC — wait, 05:00 already passed by
-- 05:30 so we want it BEFORE the orchestrator. Moving to 04:30 UTC).
--
-- ACTUALLY ordering: orchestrator runs 05:00 Sun/Wed; we want fresh Meta
-- data BEFORE that. So meta-sync at 04:30 UTC daily. Daily (not just
-- Sun/Wed) because:
--   • Per-experiment evaluator on Sun/Wed needs the most-recent IG
--     engagement
--   • Admin manual lookups via chat always see fresh data
--   • meta-sync ?mode=performance is fast (~30s) and cheap — daily is
--     no burden.
--
-- ?mode=performance scope: campaigns daily + adset_daily + placement_daily
-- + ad_daily + ig (organic posts). Skips settings (adsets, ads, account)
-- which rarely change — those can be re-pulled via ?mode=settings on
-- demand from the dashboard.
--
-- Idempotent: unschedule first, then schedule. Safe to re-run.

SELECT cron.unschedule('meta-sync-daily')
WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'meta-sync-daily'
);

SELECT cron.schedule(
  'meta-sync-daily',
  '30 4 * * *',  -- 04:30 UTC daily (30 min before orchestrator's Sun/Wed tick)
  $$
    SELECT net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/meta-sync?mode=performance',
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := '{}'::jsonb,
      timeout_milliseconds := 150000  -- meta-sync's own internal cap
    );
  $$
);

-- Verify:
--   SELECT jobname, schedule, active FROM cron.job WHERE jobname='meta-sync-daily';
--
-- Watch runs:
--   SELECT start_time, status, return_message
--   FROM cron.job_run_details
--   WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname='meta-sync-daily')
--   ORDER BY start_time DESC LIMIT 10;
