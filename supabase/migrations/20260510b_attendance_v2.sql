-- =============================================================================
-- Attendance v2 — refined reminder rules per owner spec (2026-05-10):
--
-- Position end times (weekday Sun-Thu):
--   opening (barista):  07:30 → 16:30  (9h)
--   store1-4 (others):  09:30 → 18:30  (9h)
--
-- Friday & holidays: everyone ends by 15:00:
--   opening (barista):       07:30 → 15:00
--   cafe (coffee helper):    07:45 → 15:00
--   store1-4 (others):       09:00 → 15:00
--
-- Reminder rules:
--   - Check-in:  10 min after scheduled start, if no 'in' event → DM once
--   - Check-out: 30 min after scheduled end,   if no 'out' event → DM once
--
-- Idempotent. Safe to re-run.
-- =============================================================================

-- Holiday table (Friday-rules apply to these dates).
CREATE TABLE IF NOT EXISTS attendance_holidays (
  holiday_date DATE PRIMARY KEY,
  label        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE attendance_holidays ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  EXECUTE 'DROP POLICY IF EXISTS "shared_select" ON attendance_holidays';
  EXECUTE 'DROP POLICY IF EXISTS "shared_insert" ON attendance_holidays';
  EXECUTE 'DROP POLICY IF EXISTS "shared_update" ON attendance_holidays';
  EXECUTE 'DROP POLICY IF EXISTS "shared_delete" ON attendance_holidays';

  EXECUTE 'CREATE POLICY "shared_select" ON attendance_holidays
             FOR SELECT TO anon, authenticated USING (true)';
  EXECUTE 'CREATE POLICY "shared_insert" ON attendance_holidays
             FOR INSERT TO anon, authenticated WITH CHECK (true)';
  EXECUTE 'CREATE POLICY "shared_update" ON attendance_holidays
             FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true)';
  EXECUTE 'CREATE POLICY "shared_delete" ON attendance_holidays
             FOR DELETE TO anon, authenticated USING (true)';
END $$;

GRANT ALL ON attendance_holidays TO anon, authenticated;

-- Split grace into two settings, default to owner spec (10 / 30).
ALTER TABLE attendance_settings
  ADD COLUMN IF NOT EXISTS checkin_grace_minutes  INT NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS checkout_grace_minutes INT NOT NULL DEFAULT 30;

-- If anyone customized the v1 single-field default, copy it to checkin.
UPDATE attendance_settings
SET checkin_grace_minutes = reminder_grace_minutes
WHERE reminder_grace_minutes IS NOT NULL
  AND reminder_grace_minutes <> 5
  AND id = 1;

ALTER TABLE attendance_settings DROP COLUMN IF EXISTS reminder_grace_minutes;

-- Extend reminders_sent PK with reminder_type so we can track 'in' and 'out'
-- DMs separately (each fires at most once per shift).
ALTER TABLE attendance_reminders_sent
  ADD COLUMN IF NOT EXISTS reminder_type TEXT NOT NULL DEFAULT 'in'
  CHECK (reminder_type IN ('in', 'out'));

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'attendance_reminders_sent_pkey'
      AND conrelid = 'attendance_reminders_sent'::regclass
  ) THEN
    ALTER TABLE attendance_reminders_sent DROP CONSTRAINT attendance_reminders_sent_pkey;
  END IF;
END $$;

ALTER TABLE attendance_reminders_sent
  ADD CONSTRAINT attendance_reminders_sent_pkey
  PRIMARY KEY (employee_id, shift_date, position, reminder_type);

-- Re-schedule cron from every-15min to every-10min, broaden hours to cover
-- both DST states (Israel UTC+2 winter / +3 summer).
SELECT cron.unschedule('attendance-reminder')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'attendance-reminder');

SELECT cron.schedule(
  'attendance-reminder',
  '*/10 3-20 * * 0-5',  -- every 10 min, 03:00-20:00 UTC, Sun-Fri
  $$
    SELECT net.http_post(
      url := app.supabase_url() || '/functions/v1/attendance-reminder',
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := '{}'::jsonb,
      timeout_milliseconds := 30000
    );
  $$
);
