-- Minuto — opening-shift confirmation crons.
--
-- Two daily jobs that drive the barista opening-shift confirmation flow in
-- supabase/functions/employee-bot/index.ts:
--
--   confirm-opening           — evening before. Finds TOMORROW's 07:30 opener
--                               off the published schedule and DMs them a
--                               "✅ מאשר/ת הגעה" button.
--   confirm-opening-followup  — morning of. For any opening still unconfirmed,
--                               re-reminds the barista AND alerts the manager.
--
-- Timing (pg_cron runs in UTC; Israel is UTC+3 on IDT, late Mar–late Oct):
--   20:00 IDT = 17:00 UTC → '0 17 * * *'   (evening send)
--   06:00 IDT = 03:00 UTC → '0 3 * * *'    (morning follow-up + alert)
-- NOTE: fixed UTC offset. After the autumn switch to IST (UTC+2) these land an
-- hour earlier (19:00 / 05:00 local). Bump to '0 18' / '0 4' in winter if the
-- exact local time matters. The barista window (evening → 07:30) is wide, so an
-- hour of drift is harmless.
--
-- Empty body {} + ?action=... hits the same code path an operator could curl.
-- employee-bot is deployed with --no-verify-jwt so the action endpoints are
-- reachable without an Authorization header (same as the availability cron in
-- 20260624_employee_availability_reminder_weekly_cron.sql).
--
-- Idempotent: unschedule our own job names first, then re-register. Safe to re-run.

-- 1. Evening send — tomorrow's opener.
SELECT cron.unschedule('opening-shift-confirm-evening')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'opening-shift-confirm-evening');

SELECT cron.schedule(
  'opening-shift-confirm-evening',
  '0 17 * * *',  -- 17:00 UTC = 20:00 IDT
  $$
    SELECT net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/employee-bot?action=confirm-opening',
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := '{}'::jsonb,
      timeout_milliseconds := 60000
    );
  $$
);

-- 2. Morning follow-up + manager alert — today's opener, if still pending.
SELECT cron.unschedule('opening-shift-confirm-followup')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'opening-shift-confirm-followup');

SELECT cron.schedule(
  'opening-shift-confirm-followup',
  '0 3 * * *',   -- 03:00 UTC = 06:00 IDT
  $$
    SELECT net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/employee-bot?action=confirm-opening-followup',
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := '{}'::jsonb,
      timeout_milliseconds := 60000
    );
  $$
);

-- Verify:
--   SELECT jobname, schedule, active FROM cron.job
--   WHERE jobname IN ('opening-shift-confirm-evening','opening-shift-confirm-followup');
--
-- Watch runs:
--   SELECT start_time, status, return_message
--   FROM cron.job_run_details
--   WHERE jobid IN (SELECT jobid FROM cron.job
--                   WHERE jobname LIKE 'opening-shift-confirm-%')
--   ORDER BY start_time DESC LIMIT 10;
