-- =============================================================================
-- Vehicle log: trips added by hand (יומן רכב — נסיעה שלא נרשמה)
--
-- Someone took the car without pressing the bot buttons. An admin adds the
-- trip afterwards from the CoffeeFlow "יומן רכב" page so a fine can still be
-- traced to the driver.
--
-- end_reason 'manual' = the whole trip was entered by an admin. Manual trips
-- are always closed (start + end), so they never affect the bot's "who has
-- the car now" state or the one-open-trip index.
--
-- The table stays read-only to clients (SELECT policy only). Writes go through
-- two SECURITY DEFINER RPCs that check public.is_admin() themselves:
--   vehicle_trip_add_manual     — insert a closed manual trip
--   vehicle_trip_delete_manual  — remove a manual trip entered by mistake
--                                 (bot-recorded trips can't be deleted here)
-- added_by keeps the admin's Clerk user id, since a fine can be disputed.
-- =============================================================================

ALTER TABLE vehicle_trips ADD COLUMN IF NOT EXISTS note     text;
ALTER TABLE vehicle_trips ADD COLUMN IF NOT EXISTS added_by text;

ALTER TABLE vehicle_trips DROP CONSTRAINT IF EXISTS vehicle_trips_end_reason_check;
ALTER TABLE vehicle_trips ADD CONSTRAINT vehicle_trips_end_reason_check
  CHECK (end_reason IN ('returned', 'handover', 'admin', 'manual'));

-- Return type gains `note`, which CREATE OR REPLACE can't do: drop first.
DROP FUNCTION IF EXISTS vehicle_trips_between(date, date);
CREATE FUNCTION vehicle_trips_between(from_day date, to_day date)
RETURNS TABLE (id bigint, driver_name text, started_at timestamptz, ended_at timestamptz, end_reason text, note text)
LANGUAGE sql STABLE AS $$
  SELECT t.id, t.driver_name, t.started_at, t.ended_at, t.end_reason, t.note
  FROM vehicle_trips t
  WHERE t.started_at < ((to_day + 1)::timestamp AT TIME ZONE 'Asia/Jerusalem')
    AND coalesce(t.ended_at, now()) >= (from_day::timestamp AT TIME ZONE 'Asia/Jerusalem')
  ORDER BY t.started_at DESC;
$$;
GRANT EXECUTE ON FUNCTION vehicle_trips_between(date, date) TO anon, authenticated, service_role;

-- Times are Israel local wall-clock, like vehicle_driver_at.
CREATE OR REPLACE FUNCTION vehicle_trip_add_manual(
  p_employee_id bigint, p_started_local timestamp, p_ended_local timestamp, p_note text DEFAULT NULL
) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_name  text;
  v_start timestamptz := p_started_local AT TIME ZONE 'Asia/Jerusalem';
  v_end   timestamptz := p_ended_local   AT TIME ZONE 'Asia/Jerusalem';
  v_id    bigint;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin only' USING ERRCODE = '42501';
  END IF;
  IF p_started_local IS NULL OR p_ended_local IS NULL THEN
    RAISE EXCEPTION 'start and end are required';
  END IF;
  IF v_end <= v_start THEN
    RAISE EXCEPTION 'end must be after start';
  END IF;
  IF v_end > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'end is in the future';
  END IF;
  SELECT name INTO v_name FROM employees WHERE id = p_employee_id;
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'no such employee';
  END IF;

  INSERT INTO vehicle_trips (employee_id, driver_name, started_at, ended_at, end_reason, note, added_by)
  VALUES (p_employee_id, v_name, v_start, v_end, 'manual', nullif(trim(p_note), ''), auth.jwt() ->> 'sub')
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION vehicle_trip_delete_manual(p_id bigint) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin only' USING ERRCODE = '42501';
  END IF;
  DELETE FROM vehicle_trips WHERE id = p_id AND end_reason = 'manual';
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION vehicle_trip_add_manual(bigint, timestamp, timestamp, text) FROM public;
REVOKE ALL ON FUNCTION vehicle_trip_delete_manual(bigint) FROM public;
GRANT EXECUTE ON FUNCTION vehicle_trip_add_manual(bigint, timestamp, timestamp, text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION vehicle_trip_delete_manual(bigint) TO anon, authenticated, service_role;
