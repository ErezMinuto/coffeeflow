-- Checks that employee-bot's confirm-opening insert works against the real
-- schedules table (migration 20261018c). Inserts the row confirm-opening would
-- insert for the newest schedule, then always ends in RAISE EXCEPTION, so
-- nothing persists. Prints only pass/fail words.
--
-- Dry-run before applying the migration (nothing persists):
--   BEGIN; <migration file>; <this file>; ROLLBACK;
-- After applying, run this file on its own.
DO $t$
DECLARE
  r      jsonb := '{}'::jsonb;
  s_id   bigint;
  row_id uuid;
BEGIN
  r := r || jsonb_build_object('schedule_id_type_matches', CASE WHEN
    (SELECT data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'opening_shift_confirmations' AND column_name = 'schedule_id')
    = (SELECT data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'schedules' AND column_name = 'id')
    THEN 'pass' ELSE 'FAIL' END);

  SELECT id INTO s_id FROM schedules ORDER BY created_at DESC LIMIT 1;
  BEGIN
    INSERT INTO opening_shift_confirmations (schedule_id, shift_date, day_code, employee_name, telegram_id, status)
    VALUES (s_id, DATE '2000-01-02', 'sun', 'check', NULL, 'pending')
    RETURNING id INTO row_id;
    r := r || jsonb_build_object('insert_with_real_schedule_id', CASE WHEN row_id IS NOT NULL THEN 'pass' ELSE 'FAIL' END);
    r := r || jsonb_build_object('lookup_by_schedule_and_date', CASE WHEN EXISTS (
      SELECT 1 FROM opening_shift_confirmations WHERE schedule_id = s_id AND shift_date = DATE '2000-01-02')
      THEN 'pass' ELSE 'FAIL' END);
  EXCEPTION WHEN others THEN
    r := r || jsonb_build_object('insert_with_real_schedule_id', 'FAIL: ' || SQLERRM);
  END;

  RAISE EXCEPTION 'opening_confirmations_check (rolled back): %', r;
END $t$;
