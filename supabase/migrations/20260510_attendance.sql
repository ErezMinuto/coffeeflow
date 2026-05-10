-- =============================================================================
-- Attendance / presence module
--
-- Telegram bot: employees write "נכנסתי" / "יצאתי" in private DM.
-- Reminder: 5 min after a scheduled shift starts, ping if no check-in yet.
-- Manager UI: monthly grid, manual edits, XLSX export emailed to accountant.
--
-- Idempotent. Safe to re-run.
-- =============================================================================

-- Each event = one check-in or check-out.
CREATE TABLE IF NOT EXISTS attendance_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  event_type  TEXT NOT NULL CHECK (event_type IN ('in', 'out')),
  event_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source      TEXT NOT NULL DEFAULT 'telegram' CHECK (source IN ('telegram', 'manual')),
  note        TEXT,
  edited_by_user_id TEXT,
  edited_at   TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS attendance_events_emp_at_idx
  ON attendance_events (employee_id, event_at DESC);

CREATE INDEX IF NOT EXISTS attendance_events_at_idx
  ON attendance_events (event_at DESC);

-- Single-row settings (accountant email + reminder grace).
CREATE TABLE IF NOT EXISTS attendance_settings (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  accountant_email       TEXT,
  reminder_grace_minutes INT  NOT NULL DEFAULT 5,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO attendance_settings (id) VALUES (1) ON CONFLICT DO NOTHING;

-- One row per (employee, shift_date, position) once a "missing check-in" DM
-- has been sent — prevents the cron from spamming the same employee every
-- 15 minutes.
CREATE TABLE IF NOT EXISTS attendance_reminders_sent (
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  shift_date  DATE NOT NULL,
  position    TEXT NOT NULL,
  sent_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (employee_id, shift_date, position)
);

-- RLS: shared org-wide access (matches origins/products/schedules pattern).
ALTER TABLE attendance_events            ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_settings          ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_reminders_sent    ENABLE ROW LEVEL SECURITY;

DO $$ DECLARE t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'attendance_events', 'attendance_settings', 'attendance_reminders_sent'
  ]) LOOP
    EXECUTE format('
      DROP POLICY IF EXISTS "shared_select" ON %I;
      DROP POLICY IF EXISTS "shared_insert" ON %I;
      DROP POLICY IF EXISTS "shared_update" ON %I;
      DROP POLICY IF EXISTS "shared_delete" ON %I;

      CREATE POLICY "shared_select" ON %I
        FOR SELECT TO anon, authenticated USING (true);
      CREATE POLICY "shared_insert" ON %I
        FOR INSERT TO anon, authenticated WITH CHECK (true);
      CREATE POLICY "shared_update" ON %I
        FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
      CREATE POLICY "shared_delete" ON %I
        FOR DELETE TO anon, authenticated USING (true);
    ', t, t, t, t, t, t, t, t);
  END LOOP;
END $$;

GRANT ALL ON attendance_events            TO anon, authenticated;
GRANT ALL ON attendance_settings          TO anon, authenticated;
GRANT ALL ON attendance_reminders_sent    TO anon, authenticated;

-- pg_cron: ping every 15 minutes between 06:00–22:00 Israel time
-- (UTC 03:00–19:00 covers DST drift).
SELECT cron.unschedule('attendance-reminder')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'attendance-reminder');

SELECT cron.schedule(
  'attendance-reminder',
  '*/15 3-19 * * 0-5',  -- every 15min, 03:00-19:00 UTC, Sun-Fri
  $$
    SELECT net.http_post(
      url := app.supabase_url() || '/functions/v1/attendance-reminder',
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := '{}'::jsonb,
      timeout_milliseconds := 30000
    );
  $$
);
