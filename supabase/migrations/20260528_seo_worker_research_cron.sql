-- Minuto SEO Agent — cron tick for the deep-research worker.
--
-- Polls seo-worker-research every 3 minutes. Each invocation processes
-- AT MOST one deep_research task (claimNextTask is atomic). Empty-queue
-- runs no-op in ~50ms.
--
-- Why 3 minutes (vs writer's 2 / visual's 5):
--   • Research turns are bounded at 5; each turn can take 30-60s (Claude
--     + web_search server-side). End-to-end up to ~3-5 min per task.
--   • Deep-research is a low-volume queue — orchestrator emits 0-1 per
--     cycle (twice weekly), admin queues ad hoc via chat tool.
--   • 3-min cadence drains the queue well within the time a single task
--     completes, without burning invocations on empty polls.
--
-- timeout_milliseconds 300000 = 5min (matches max turn budget). The edge
-- function itself uses 120s per Claude turn × 5 turns + tool execution
-- overhead → real cap is ~6 min but Supabase edge gateway caps at 150s
-- per http_post; the worker streams turn-by-turn internally so each
-- http_post just kicks off ONE task and returns.
--
-- Sibling crons:
--   - seo-worker-writer-tick      (every 2 min, text_generation tasks)
--   - seo-worker-visual-tick      (every 5 min, visual_generation tasks)
-- All three share seo_tasks table but filter on different task_type so
-- they don't contend (claimNextTask query is scoped by task_type).
--
-- The worker is deployed with --no-verify-jwt so no auth header is needed.
--
-- Idempotent: unschedule existing job first, then re-register.

SELECT cron.unschedule('seo-worker-research-tick')
WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'seo-worker-research-tick'
);

SELECT cron.schedule(
  'seo-worker-research-tick',
  '*/3 * * * *',  -- every 3 minutes
  $$
    SELECT net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/seo-worker-research',
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := '{}'::jsonb,
      timeout_milliseconds := 150000  -- 2.5min; matches Supabase edge gateway cap
    );
  $$
);

-- ── Verify (run manually after this migration applies) ────────────────
--   SELECT jobname, schedule FROM cron.job WHERE jobname = 'seo-worker-research-tick';
--
-- Watch runs:
--   SELECT start_time, status, return_message
--   FROM cron.job_run_details
--   WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname='seo-worker-research-tick')
--   ORDER BY start_time DESC LIMIT 10;
--
-- Manual ad-hoc trigger (for smoke test):
--   SELECT net.http_post(
--     url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/seo-worker-research',
--     headers := jsonb_build_object('Content-Type', 'application/json'),
--     body := '{}'::jsonb
--   );
