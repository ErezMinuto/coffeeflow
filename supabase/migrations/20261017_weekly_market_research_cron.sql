-- Replace weekly-marketing-advisor with a cron that only runs market research.
--
-- weekly-marketing-advisor sent {"agent":"all"}, which fired market_research
-- plus the two Google Ads strategists that fed the deleted /advisor page. The
-- strategists are removed; the market_research table is still read by the
-- unified plan, meta_ads_strategist and the seo-agent, so this job calls
-- market_research directly. The function now answers "all" with 400.
--
-- market_research runs synchronously (the old orchestrator fired it
-- fire-and-forget), so the request gets a long pg_net timeout.
-- '55 3 * * 1' is the slot 20260920_cron_worker_pressure.sql assigned to the
-- old job, off the :00 minute.
--
-- Apply BEFORE the function is redeployed: the new job calls a mode the
-- current deployment already has, so this order never skips a week.
-- Idempotent.

SELECT cron.unschedule('weekly-marketing-advisor')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'weekly-marketing-advisor');

SELECT cron.unschedule('weekly-market-research')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'weekly-market-research');

SELECT cron.schedule(
  'weekly-market-research',
  '55 3 * * 1',
  $$
    SELECT net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/marketing-advisor',
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := jsonb_build_object('trigger', 'cron', 'agent', 'market_research'),
      timeout_milliseconds := 300000
    );
  $$
);
