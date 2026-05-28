-- Minuto SEO Agent — cron tick for the technical-SEO worker.
--
-- Polls seo-worker-techseo every 3 minutes. Each invocation processes AT
-- MOST one technical_seo task (claimNextTask is atomic): resolves the
-- target article, skips if it already has FAQ, else authors a Hebrew FAQ
-- proposal with Claude and stores it review_required=true (NO live write —
-- the admin approves via approve_post_faq). Empty queue → ~50ms no-op.
--
-- Low-volume queue (the orchestrator emits a handful of FAQ candidates
-- per cycle), so 3 min drains comfortably without burning invocations.
--
-- Sibling worker ticks: writer (2m), visual (5m), instagram (2m),
-- research (3m). All share seo_tasks but filter on distinct task_type.
--
-- Deployed with --no-verify-jwt (matches the other worker ticks).
-- Idempotent: unschedule then schedule.

SELECT cron.unschedule('seo-worker-techseo-tick')
WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'seo-worker-techseo-tick'
);

SELECT cron.schedule(
  'seo-worker-techseo-tick',
  '*/3 * * * *',  -- every 3 minutes
  $$
    SELECT net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/seo-worker-techseo',
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := '{}'::jsonb,
      timeout_milliseconds := 150000  -- 2.5min; matches Supabase edge gateway cap
    );
  $$
);

-- ── Verify ────────────────────────────────────────────────────────────
--   SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'seo-worker-techseo-tick';
-- Manual drain:
--   SELECT net.http_post(
--     url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/seo-worker-techseo',
--     headers := jsonb_build_object('Content-Type','application/json'), body := '{}'::jsonb);
