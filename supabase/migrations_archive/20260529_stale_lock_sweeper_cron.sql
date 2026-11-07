-- Minuto SEO Agent — stale-lock sweeper (pure pg_cron, no edge function).
--
-- Backstop for the self-healing claimNextTask (which reclaims expired-lock
-- 'processing' rows on each worker tick). This sweeper is a TYPE-AGNOSTIC
-- safety net that runs entirely inside Postgres every 10 minutes — fully
-- autonomous, independent of any edge function, worker cadence, OR the
-- admin opening the chat. Fulfils the agent's dev request b5b12604.
--
-- Why both? claimNextTask recovers a stuck row of type X only when worker X
-- next ticks. This sweeper recovers ANY stuck row on a fixed cadence even if
-- that worker's own cron is paused/missing — and it's the strongest "works
-- without you" guarantee since it's a plain DB job.
--
-- Recovery logic (mirrors claimNextTask so the two never fight):
--   • status='processing' AND locked_until < now() (lock expired) AND it's
--     been stuck a while (locked_until older than 15 min, so we don't race a
--     worker that just took a long-but-legitimate lock):
--       - attempts <  max_attempts → reset to 'pending' (clear worker_id +
--         locked_until) so the next worker tick reclaims it.
--       - attempts >= max_attempts → mark 'failed' (crash-loop giveup), so a
--         task that keeps dying mid-run doesn't get retried forever.
--
-- Idempotent: unschedule then schedule.

SELECT cron.unschedule('stale-lock-sweeper')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'stale-lock-sweeper');

SELECT cron.schedule(
  'stale-lock-sweeper',
  '*/10 * * * *',  -- every 10 minutes
  $$
    -- Recover recoverable stuck rows → pending.
    UPDATE seo_tasks
       SET status = 'pending', locked_until = NULL, worker_id = NULL
     WHERE status = 'processing'
       AND locked_until IS NOT NULL
       AND locked_until < now() - interval '15 minutes'
       AND attempts < max_attempts;

    -- Give up on crash-loopers → failed.
    UPDATE seo_tasks
       SET status = 'failed', locked_until = NULL,
           error_msg = 'stale lock + attempts exhausted — recovered by stale-lock-sweeper'
     WHERE status = 'processing'
       AND locked_until IS NOT NULL
       AND locked_until < now() - interval '15 minutes'
       AND attempts >= max_attempts;
  $$
);

-- ── Verify ────────────────────────────────────────────────────────────
--   SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'stale-lock-sweeper';
--   -- Watch what it touches:
--   SELECT id, task_type, status, attempts, max_attempts, locked_until
--   FROM seo_tasks WHERE status = 'processing' AND locked_until < now()
--   ORDER BY locked_until;
