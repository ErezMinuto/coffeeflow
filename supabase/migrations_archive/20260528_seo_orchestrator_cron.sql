-- Minuto SEO Agent — seo-orchestrator twice-weekly cron.
--
-- Activates the new SEO pipeline end-to-end. Without this cron the
-- orchestrator only fires on manual invocation; the workers run on their
-- own 2-minute ticks but have nothing in seo_tasks to drain. This cron
-- closes that loop.
--
-- Schedule: Sun + Wed 05:00 UTC (08:00 Asia/Jerusalem). Picked to:
--   • Run AFTER organic-content-twice-weekly (04:00 UTC) so any shared
--     research data (advisor_reports, market_research) is fresh
--   • Avoid colliding with the now-removed blog-auto-publish-twice-weekly
--     (which used to run at 05:30 UTC). 30-minute buffer in case we
--     ever resurrect it for a parallel A/B.
--   • Land in business hours Israel-time so failures are visible quickly
--
-- Body sends trigger:'cron' so the orchestrator's logs distinguish
-- autonomous runs from manual ones.
--
-- Idempotent: unschedule first, then schedule. Safe to re-run.

SELECT cron.unschedule('seo-orchestrator-twice-weekly')
WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'seo-orchestrator-twice-weekly'
);

SELECT cron.schedule(
  'seo-orchestrator-twice-weekly',
  '0 5 * * 0,3',   -- Sun + Wed 05:00 UTC
  $$
    SELECT net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/seo-orchestrator',
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := '{"trigger":"cron"}'::jsonb,
      -- 4 min — orchestrator's Claude call (Sonnet 4.6 + ~30K context from
      -- the 10 data sources) typically lands in 60-120s. Cap well below
      -- the edge runtime ceiling so a stuck call gets killed before the
      -- next tick.
      timeout_milliseconds := 240000
    );
  $$
);

-- Verify post-apply:
--   SELECT jobname, schedule, active FROM cron.job WHERE jobname='seo-orchestrator-twice-weekly';
--
-- Watch runs:
--   SELECT start_time, status, return_message
--   FROM cron.job_run_details
--   WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname='seo-orchestrator-twice-weekly')
--   ORDER BY start_time DESC LIMIT 10;
--
-- Inspect emitted tasks after a run:
--   SELECT id, task_type, task_subtype, rationale, status
--   FROM seo_tasks
--   WHERE orchestrator_run_id = (
--     SELECT id FROM seo_metrics WHERE source='orchestrator_run' ORDER BY logged_at DESC LIMIT 1
--   )::uuid;
