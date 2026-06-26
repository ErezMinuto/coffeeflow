-- Minuto Strategist Brain — cron schedules.
--
-- Two jobs mirror the function's two entry points (see
-- supabase/functions/strategist-brain/index.ts):
--
--   kickoff (weekly) — opens ONE thinking run seeded with a fresh business
--     snapshot, after a month-to-date spend kill-switch check. Monday 06:00 UTC
--     (~09:00 Israel summer), so a fresh "State of Minuto" lands at the start of
--     the week. The single-active-run unique index means a second kickoff over
--     an in-progress run is a no-op, so cadence is safe to bump to daily later
--     by changing only this schedule.
--
--   advance (every 2 min) — claims the active run and pushes it through several
--     ReAct steps per invocation, checkpointing between ticks. Idle + cheap when
--     no run is active (one indexed SELECT, no Claude call), so a tight cadence
--     just minimizes brief latency without real cost.
--
-- Budget gates FREQUENCY, never a running run's depth: the kickoff kill-switch
-- skips a WHOLE run once the $150/mo ceiling is hit; it never truncates a run
-- that's already thinking.
--
-- The function is deployed with --no-verify-jwt, so no auth header is needed
-- (same as the other strategic crons). Idempotent: unschedule then schedule.

-- ── kickoff: weekly ──────────────────────────────────────────────────────────
SELECT cron.unschedule('strategist-brain-kickoff-weekly')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'strategist-brain-kickoff-weekly');

SELECT cron.schedule(
  'strategist-brain-kickoff-weekly',
  '0 6 * * 1',  -- Monday 06:00 UTC
  $$
    SELECT net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/strategist-brain?mode=kickoff&trigger=cron',
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := '{}'::jsonb,
      timeout_milliseconds := 60000
    );
  $$
);

-- ── advance: every 2 minutes ─────────────────────────────────────────────────
SELECT cron.unschedule('strategist-brain-advance')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'strategist-brain-advance');

SELECT cron.schedule(
  'strategist-brain-advance',
  '*/2 * * * *',  -- every 2 min
  $$
    SELECT net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/strategist-brain?mode=advance',
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := '{}'::jsonb,
      timeout_milliseconds := 120000
    );
  $$
);

-- Verify:
--   SELECT jobname, schedule, active FROM cron.job WHERE jobname LIKE 'strategist-brain%';
--
-- Watch runs:
--   SELECT start_time, status, return_message
--   FROM cron.job_run_details
--   WHERE jobid IN (SELECT jobid FROM cron.job WHERE jobname LIKE 'strategist-brain%')
--   ORDER BY start_time DESC LIMIT 20;
