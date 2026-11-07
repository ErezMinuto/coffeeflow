-- Minuto — opening-shift confirmation tracking.
--
-- Why this exists: the barista assigned to the 07:30 opening (position
-- 'opening' in schedule_assignments) gets a Telegram DM the EVENING BEFORE
-- their shift asking them to tap "✅ מאשר". If they don't confirm, the next
-- morning they get a follow-up reminder AND the manager is alerted.
--
-- This table is the state ledger so the crons are idempotent: exactly one row
-- per (schedule_id, shift_date), so a barista is never double-messaged and the
-- follow-up/alert only fire while the row is still 'pending'.
--
-- The reminder is driven entirely off the PUBLISHED, hand-edited schedule:
-- employee-bot's confirm-opening action reads schedule_assignments (which the
-- manager edits in the dashboard before publishing) for schedules whose
-- status = 'published'. Hence the published_at column added below.
--
-- Conventions follow the rest of the repo: gen_random_uuid() PKs,
-- created_at/updated_at defaults, org-wide shared RLS (anon + authenticated,
-- USING(true)). Mirrors 20260626_strategist_brain_tables.sql.

-- ───────────────────────────────────────────────────────────────────────────
-- 1. schedules.published_at — set by the dashboard publish() flow. The
--    confirmation cron only considers schedules that have actually been
--    published (status='published'), never a draft the manager is still editing.
-- ───────────────────────────────────────────────────────────────────────────
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. opening_shift_confirmations — one row per opening shift being tracked.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS opening_shift_confirmations (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id        UUID NOT NULL,                 -- schedules.id this opening belongs to
  shift_date         DATE NOT NULL,                 -- the actual calendar date of the opening shift
  day_code           TEXT NOT NULL,                 -- sun|mon|tue|wed|thu|fri (schedule_assignments.day)
  employee_name      TEXT NOT NULL,                 -- name as it appears in schedule_assignments
  telegram_id        TEXT,                          -- resolved from employees.telegram_id at send time
  status             TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'confirmed')),
  sent_at            TIMESTAMPTZ,                   -- when the first DM went out (evening before)
  reminder_count     INT NOT NULL DEFAULT 0,        -- how many follow-up nudges have been sent
  last_reminded_at   TIMESTAMPTZ,
  confirmed_at       TIMESTAMPTZ,                   -- when the barista tapped ✅
  manager_alerted_at TIMESTAMPTZ,                   -- when we escalated an unconfirmed opening to the manager
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One tracked confirmation per opening shift → the evening cron upserts on this
-- key and never sends a second DM for the same day.
CREATE UNIQUE INDEX IF NOT EXISTS opening_shift_confirmations_unique_idx
  ON opening_shift_confirmations (schedule_id, shift_date);

-- Follow-up cron scans pending rows by date.
CREATE INDEX IF NOT EXISTS opening_shift_confirmations_pending_idx
  ON opening_shift_confirmations (shift_date)
  WHERE status = 'pending';

-- ───────────────────────────────────────────────────────────────────────────
-- 3. RLS — org-wide shared table (anon key = org API key; Clerk JWT =
--    authenticated). Mirrors 20260403_shared_tables_rls.sql. The edge function
--    uses the service-role key (bypasses RLS); these policies let the dashboard
--    read confirmation status with the anon key.
-- ───────────────────────────────────────────────────────────────────────────
ALTER TABLE opening_shift_confirmations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "opening_shift_confirmations_shared_select" ON opening_shift_confirmations
  FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "opening_shift_confirmations_shared_insert" ON opening_shift_confirmations
  FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY "opening_shift_confirmations_shared_update" ON opening_shift_confirmations
  FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "opening_shift_confirmations_shared_delete" ON opening_shift_confirmations
  FOR DELETE TO anon, authenticated USING (true);
