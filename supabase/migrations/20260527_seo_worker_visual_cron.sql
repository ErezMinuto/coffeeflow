-- Minuto SEO Agent — Visual Worker cron tick.
--
-- Polls the seo_tasks queue every 2 minutes and processes one
-- visual_generation task per invocation. See:
--   supabase/functions/seo-worker-visual/index.ts (the worker)
--   supabase/functions/seo-agent/db.ts            (claimNextTask)
--
-- Filename note: split from the writer's cron migration so Sessions A
-- and B (running in parallel worktrees) don't collide on the same file.
-- Both migrations land independently; pg_cron job names are unique
-- across them.
--
-- Cadence: every 2 minutes. The orchestrator currently emits at most ~2
-- visual tasks per Sunday run; a 2-min tick clears the backlog within
-- minutes of the writer finishing the matching text task. The
-- worker's per-tick cost is ~zero when the queue is empty (single
-- indexed SELECT on seo_tasks(task_type, status, scheduled_for)) so the
-- frequent poll is cheap.
--
-- Coordination with the writer worker: visual tasks with a
-- parent_task_id won't claim until the worker observes the parent
-- text task as 'completed' (the worker re-queues itself if the parent
-- isn't ready yet — non-permanent failure, attempts increments). With
-- max_attempts=3 default + 2-min cadence, the writer has ~6 minutes
-- to land its WP draft before the visual task gives up. Typical writer
-- runs are <60s, so this is comfortable headroom.
--
-- Idempotent: unschedule first, then schedule. Re-running this migration
-- is safe — it just refreshes the schedule entry.
--
-- pg_cron + pg_net are already installed in this project (verified via
-- 20260428e_email_automation_daily_cron.sql and the existing organic-
-- agent twice-weekly cron).

SELECT cron.unschedule('seo-worker-visual-tick')
WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'seo-worker-visual-tick'
);

SELECT cron.schedule(
  'seo-worker-visual-tick',
  '*/2 * * * *',  -- every 2 minutes
  $$
    SELECT net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/seo-worker-visual',
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := '{}'::jsonb,
      -- Most renders finish in 20-60s (Gemini Image) or 30-90s (Vertex
      -- composite). Cap at 4 min so a stuck render doesn't block the
      -- next tick from running. The worker's internal lock_until (10
      -- min by default in claimNextTask) plus the sweeper guarantee a
      -- crashed/timeout-killed row is eventually re-claimable.
      timeout_milliseconds := 240000
    );
  $$
);

-- ── Verify (run manually after this migration applies) ─────────────────
--   SELECT jobname, schedule, command FROM cron.job
--   WHERE jobname = 'seo-worker-visual-tick';
--
-- Watch a run:
--   SELECT * FROM cron.job_run_details
--   WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname='seo-worker-visual-tick')
--   ORDER BY start_time DESC LIMIT 5;
--
-- Inspect completed visual tasks (image_url + attached media):
--   SELECT id, status, result_data
--   FROM seo_tasks
--   WHERE task_type = 'visual_generation'
--     AND status IN ('completed','failed')
--   ORDER BY updated_at DESC
--   LIMIT 10;
