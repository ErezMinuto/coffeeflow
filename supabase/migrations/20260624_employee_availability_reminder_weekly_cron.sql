-- Minuto — weekly employee availability-reminder cron.
--
-- Why this exists: the employee-bot's `remind` action (handleRemind in
-- supabase/functions/employee-bot/index.ts) DMs every active employee asking
-- them to submit next week's available days. Until now it had NO
-- version-controlled schedule — it was fired manually from the "שלח תזכורת
-- זמינות" button on the Schedule page, plus (apparently) an ad-hoc cron that
-- ran on Thursday. This migration moves that to a real, tracked weekly cron
-- on WEDNESDAY, the same way woo-orders-sync / meta-sync got theirs.
--
-- Schedule: Wednesday 18:00 Israel time. pg_cron runs in UTC and Israel is
-- on IDT (UTC+3) from late March to late October, so 18:00 local = 15:00 UTC
-- → '0 15 * * 3' (dow 3 = Wednesday). NOTE: this is a fixed UTC offset, so
-- after the autumn DST switch to IST (UTC+2) the reminder will land at 17:00
-- local until DST returns. Adjust to '0 16 * * 3' in winter if 18:00 sharp
-- matters.
--
-- Empty body {} + ?action=remind hits the same code path as the dashboard
-- button. The function is deployed with --no-verify-jwt so the action
-- endpoint is reachable without an Authorization header.
--
-- Idempotent: first unschedule ANY existing reminder job (matched by command,
-- since the old Thursday job's name isn't tracked here), then schedule the
-- new Wednesday one. Safe to re-run.

-- 1. Remove any pre-existing employee-bot reminder cron (e.g. the old Thursday
--    job), whatever it was named.
DO $$
DECLARE j record;
BEGIN
  FOR j IN
    SELECT jobname
    FROM cron.job
    WHERE command ILIKE '%employee-bot%'
      AND command ILIKE '%remind%'
  LOOP
    PERFORM cron.unschedule(j.jobname);
  END LOOP;
END $$;

-- 2. Also unschedule by our own job name, in case this migration re-runs.
SELECT cron.unschedule('employee-availability-reminder-weekly')
WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'employee-availability-reminder-weekly'
);

-- 3. Schedule the new Wednesday reminder.
SELECT cron.schedule(
  'employee-availability-reminder-weekly',
  '0 15 * * 3',  -- Wed 15:00 UTC = 18:00 IDT (Israel summer time)
  $$
    SELECT net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/employee-bot?action=remind',
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := '{}'::jsonb,
      timeout_milliseconds := 150000
    );
  $$
);

-- Verify:
--   SELECT jobname, schedule, active FROM cron.job WHERE jobname='employee-availability-reminder-weekly';
--
-- Watch runs:
--   SELECT start_time, status, return_message
--   FROM cron.job_run_details
--   WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname='employee-availability-reminder-weekly')
--   ORDER BY start_time DESC LIMIT 10;
