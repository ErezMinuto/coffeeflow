-- =============================================================================
-- Vehicle log (יומן רכב)
--
-- Who had the shared work car, and when — so a traffic fine can be traced to
-- the driver. Employees log it from the existing employee-bot (attendance bot)
-- via a separate "🚙 יומן רכב" menu; the bot writes with the service role key
-- (bypasses RLS). The CoffeeFlow "יומן רכב" page reads it as admin only.
--
-- One row per take → return. ended_at NULL = the car is out right now.
-- end_reason: returned  — the driver pressed "החזרתי"
--             handover  — the next driver took the car before this one
--                         pressed return; closed at the handover moment
--             admin     — closed by hand
--
-- Drivers are the existing active employees (employees.telegram_id), so there
-- is no separate driver registration. driver_name is a snapshot: deleting an
-- employee later sets employee_id NULL but keeps the trip, because fines can
-- arrive months afterwards.
-- =============================================================================

CREATE TABLE IF NOT EXISTS vehicle_trips (
  id           bigserial PRIMARY KEY,
  employee_id  bigint REFERENCES employees(id) ON DELETE SET NULL,
  driver_name  text NOT NULL,
  started_at   timestamptz NOT NULL DEFAULT now(),
  ended_at     timestamptz,
  end_reason   text CHECK (end_reason IN ('returned', 'handover', 'admin')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (ended_at IS NULL OR ended_at >= started_at),
  CHECK ((ended_at IS NULL) = (end_reason IS NULL))
);

-- One car: at most one open trip at any moment.
CREATE UNIQUE INDEX IF NOT EXISTS vehicle_trips_one_open
  ON vehicle_trips ((true)) WHERE ended_at IS NULL;

CREATE INDEX IF NOT EXISTS vehicle_trips_started_idx ON vehicle_trips (started_at);

ALTER TABLE vehicle_trips ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "vehicle_trips_select_admin_only" ON vehicle_trips;
CREATE POLICY "vehicle_trips_select_admin_only"
  ON vehicle_trips FOR SELECT
  TO anon, authenticated
  USING (public.is_admin());

-- -----------------------------------------------------------------------------
-- Read helpers. SECURITY INVOKER (the default), so the policy above still
-- applies: a non-admin caller gets zero rows. Day/time arguments are Israel
-- local time; the conversion (incl. DST) happens here, not in the client.
-- -----------------------------------------------------------------------------

-- Trips that overlap [from_day 00:00, to_day+1 00:00) Israel time.
CREATE OR REPLACE FUNCTION vehicle_trips_between(from_day date, to_day date)
RETURNS TABLE (id bigint, driver_name text, started_at timestamptz, ended_at timestamptz, end_reason text)
LANGUAGE sql STABLE AS $$
  SELECT t.id, t.driver_name, t.started_at, t.ended_at, t.end_reason
  FROM vehicle_trips t
  WHERE t.started_at < ((to_day + 1)::timestamp AT TIME ZONE 'Asia/Jerusalem')
    AND coalesce(t.ended_at, now()) >= (from_day::timestamp AT TIME ZONE 'Asia/Jerusalem')
  ORDER BY t.started_at DESC;
$$;

-- Who had the car at a given Israel-local moment (used for traffic fines).
CREATE OR REPLACE FUNCTION vehicle_driver_at(local_ts timestamp)
RETURNS TABLE (driver_name text, started_at timestamptz, ended_at timestamptz, end_reason text)
LANGUAGE sql STABLE AS $$
  SELECT t.driver_name, t.started_at, t.ended_at, t.end_reason
  FROM vehicle_trips t
  WHERE t.started_at <= (local_ts AT TIME ZONE 'Asia/Jerusalem')
    AND coalesce(t.ended_at, now()) >= (local_ts AT TIME ZONE 'Asia/Jerusalem')
  ORDER BY t.started_at;
$$;

GRANT EXECUTE ON FUNCTION vehicle_trips_between(date, date) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION vehicle_driver_at(timestamp)      TO anon, authenticated, service_role;
