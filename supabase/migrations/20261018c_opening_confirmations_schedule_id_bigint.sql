-- opening_shift_confirmations.schedule_id: uuid → bigint, to match schedules.id.
--
-- 20260709_opening_shift_confirmations.sql declared schedule_id UUID, but
-- schedules.id (and schedule_assignments.schedule_id) are bigint. So every
-- confirm-opening run that found an opener failed on the insert with
-- `invalid input syntax for type uuid: "64"` (HTTP 500 at 17:00 UTC on
-- 2026-10-17, schedule 64), and the table has never held a row: no opener has
-- ever been DMed and the morning follow-up has never had anything to do.
--
-- The table is empty in prod, so the USING cast never runs on real data.
-- Idempotent: skipped once the column is already bigint.

DO $$
BEGIN
  IF (SELECT data_type FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name   = 'opening_shift_confirmations'
         AND column_name  = 'schedule_id') = 'uuid' THEN
    ALTER TABLE public.opening_shift_confirmations
      ALTER COLUMN schedule_id TYPE bigint USING NULL::bigint;
  END IF;
END $$;
