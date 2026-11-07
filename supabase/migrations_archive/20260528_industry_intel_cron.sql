-- Minuto Organic Marketing — industry intelligence daily ingest.
--
-- Pulls RSS from active industry_sources, deduplicates, Claude-summarizes
-- new articles, writes to industry_articles. Orchestrator reads from
-- there on Sun/Wed.
--
-- Schedule: 03:30 UTC daily. Sequence with the other crons:
--   03:30 UTC: industry-intelligence-sync (new — populates insights for the day)
--   04:30 UTC: meta-sync-daily (Meta organic + paid metrics)
--   05:00 UTC: organic-orchestrator (Sun/Wed only — consumes everything above)
--   06:00 UTC: ga4-sync-daily (GA4 landing-page metrics)
--
-- Idempotent: unschedule first, then schedule.

SELECT cron.unschedule('industry-intelligence-daily')
WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'industry-intelligence-daily'
);

SELECT cron.schedule(
  'industry-intelligence-daily',
  '30 3 * * *',  -- 03:30 UTC daily (1h before meta-sync, 1.5h before orchestrator)
  $$
    SELECT net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/industry-intelligence-sync',
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := '{}'::jsonb,
      -- 9 sources × up to 5 articles × ~3-5s/article (fetch + Haiku synth)
      -- = ~3min worst case. Cap at 4min.
      timeout_milliseconds := 240000
    );
  $$
);

-- Verify:
--   SELECT jobname, schedule, active FROM cron.job WHERE jobname='industry-intelligence-daily';
