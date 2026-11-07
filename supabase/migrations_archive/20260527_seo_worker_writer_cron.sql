-- Minuto SEO Agent — cron tick for the Writer worker.
--
-- Polls seo-worker-writer every 2 minutes. Each invocation processes AT
-- MOST one text_generation task (claimNextTask is atomic). If the queue
-- is empty the worker no-ops in ~50ms and returns {processed: 0}.
--
-- Why 2 minutes (not 30 seconds, not 10):
--   • Writer tasks take 30–90s end-to-end (Sonnet call + WP draft push).
--   • 2-min cadence keeps the queue draining without piling up overlapping
--     workers if Claude or WP slows down. claimNextTask's optimistic
--     UPDATE makes concurrent ticks safe, but back-to-back polls of an
--     empty queue burn function invocations for no reason.
--   • At twice-weekly orchestrator cadence the queue rarely exceeds ~10
--     pending text tasks at a time — drains within ~20 min worst case.
--
-- Sibling cron: seo-worker-visual is added by Session B in its own
-- migration (20260527_seo_worker_visual_cron.sql) to avoid merge
-- conflicts. Both workers read from the same seo_tasks table but on
-- different task_type filters so they don't contend.
--
-- The worker function is deployed with --no-verify-jwt so no auth header
-- is needed (matches the pattern in 20260428e_email_automation_daily_cron.sql
-- and 20260523_organic_agent_twice_weekly_cron.sql).
--
-- Idempotent: unschedule existing job first, then re-register. Safe to
-- re-run.

SELECT cron.unschedule('seo-worker-writer-tick')
WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'seo-worker-writer-tick'
);

SELECT cron.schedule(
  'seo-worker-writer-tick',
  '*/2 * * * *',  -- every 2 minutes
  $$
    SELECT net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/seo-worker-writer',
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := '{}'::jsonb,
      timeout_milliseconds := 150000   -- 2.5min; matches Supabase edge gateway cap
    );
  $$
);

-- ── Verify (run manually after this migration applies) ────────────────
--   SELECT jobname, schedule FROM cron.job WHERE jobname = 'seo-worker-writer-tick';
--
-- Watch runs:
--   SELECT start_time, status, return_message
--   FROM cron.job_run_details
--   WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname='seo-worker-writer-tick')
--   ORDER BY start_time DESC LIMIT 10;
