-- CoffeeFlow — follow-up to 20260920_cron_worker_pressure.sql.
--
-- Run AFTER that migration. Two things it did not cover:
--
--   1. system-logs-purge-daily was created after the collision-free grid was
--      designed and sits on '30 3 * * *', the same minute as
--      industry-intelligence-daily. Moved to 02:00, a minute no other job uses.
--      (chat-messages-purge-daily at 03:40 already collides with nothing.)
--
--   2. cron.job_run_details was never purged. On 2026-10-02 it held 592k rows
--      back to March and took 491 MB of a 692 MB database. cron_job_health
--      scans it per job, so every call hit the statement timeout and
--      health-watchdog silently skipped its cron checks — which is why the
--      2026-10-02 outage raised no alert.
--
-- Retention is 14 days, not 7: the watchdog judges weekly jobs by their last
-- run, and a 7-day window would delete that run right around the time the next
-- one is due, producing false "silent" alerts.

-- ── 1. Take the log purge off the 03:30 collision ──────────────────────
SELECT cron.alter_job(jobid, schedule := '0 2 * * *')
  FROM cron.job
 WHERE jobname = 'system-logs-purge-daily';

-- ── 2. One-time purge of the backlog ───────────────────────────────────
DELETE FROM cron.job_run_details
 WHERE end_time < now() - interval '14 days'
    OR (end_time IS NULL AND start_time < now() - interval '14 days');

-- ── 3. Keep it purged ──────────────────────────────────────────────────
-- 02:30 is free of every recurring tick and every other daily job.
SELECT cron.schedule(
  'cron-run-details-purge-daily',
  '30 2 * * *',
  $$DELETE FROM cron.job_run_details WHERE end_time < now() - interval '14 days'$$
);

-- ── Verify (run after applying) ────────────────────────────────────────
--   -- every active schedule unique (should return no rows):
--   SELECT schedule, count(*), string_agg(jobname, ', ')
--     FROM cron.job WHERE active GROUP BY schedule HAVING count(*) > 1;
--
--   -- history is small again, and the watchdog RPC answers instantly:
--   SELECT count(*), min(start_time) FROM cron.job_run_details;
--   SELECT * FROM cron_job_health('meta-sync-daily');
--
-- The DELETE frees the space for reuse but does not shrink the file on disk.
-- To hand the ~450 MB back, run this on its own (brief lock on the table):
--   VACUUM FULL cron.job_run_details;
