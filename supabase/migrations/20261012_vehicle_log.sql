-- =============================================================================
-- Vehicle log (יומן רכב)
--
-- Who had the shared work car, and when — so a traffic fine can be traced to
-- the driver. Rows are written by a Telegram bot through the service role key
-- (bypasses RLS). The CoffeeFlow "יומן רכב" page reads them as admin only.
--
--   drivers        one row per Telegram user; approved by the admin in the bot
--   vehicle_trips  one row per take→return; ended_at NULL = car is out now
--                  end_reason: returned (pressed return) | handover (next
--                  driver took the car before this one pressed return) | admin
--
-- Read access: public.is_admin() (user_roles.role = 'admin' for the Clerk sub).
-- No insert/update/delete policies: only the service role writes.
-- =============================================================================

CREATE TABLE IF NOT EXISTS drivers (
  telegram_id bigint PRIMARY KEY,
  name        text NOT NULL,
  approved    boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS vehicle_trips (
  id          bigserial PRIMARY KEY,
  driver_id   bigint NOT NULL REFERENCES drivers(telegram_id),
  started_at  timestamptz NOT NULL DEFAULT now(),
  ended_at    timestamptz,
  end_reason  text CHECK (end_reason IN ('returned', 'handover', 'admin')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);

-- One car: at most one open trip at any moment.
CREATE UNIQUE INDEX IF NOT EXISTS vehicle_trips_one_open
  ON vehicle_trips ((true)) WHERE ended_at IS NULL;

CREATE INDEX IF NOT EXISTS vehicle_trips_started_idx ON vehicle_trips (started_at);

ALTER TABLE drivers       ENABLE ROW LEVEL SECURITY;
ALTER TABLE vehicle_trips ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "drivers_select_admin_only"       ON drivers;
DROP POLICY IF EXISTS "vehicle_trips_select_admin_only" ON vehicle_trips;

CREATE POLICY "drivers_select_admin_only"
  ON drivers FOR SELECT
  TO anon, authenticated
  USING (public.is_admin());

CREATE POLICY "vehicle_trips_select_admin_only"
  ON vehicle_trips FOR SELECT
  TO anon, authenticated
  USING (public.is_admin());

-- -----------------------------------------------------------------------------
-- Read helpers. All SECURITY INVOKER (the default), so the RLS policies above
-- still apply: a non-admin caller gets zero rows. Day/time arguments are
-- Israel local time; the conversion (incl. DST) happens here, not in the client.
-- -----------------------------------------------------------------------------

-- Trips that overlap [from_day 00:00, to_day+1 00:00) Israel time.
CREATE OR REPLACE FUNCTION vehicle_trips_between(from_day date, to_day date)
RETURNS TABLE (id bigint, driver_name text, started_at timestamptz, ended_at timestamptz, end_reason text)
LANGUAGE sql STABLE AS $$
  SELECT t.id, d.name, t.started_at, t.ended_at, t.end_reason
  FROM vehicle_trips t
  JOIN drivers d ON d.telegram_id = t.driver_id
  WHERE t.started_at < ((to_day + 1)::timestamp AT TIME ZONE 'Asia/Jerusalem')
    AND coalesce(t.ended_at, now()) >= (from_day::timestamp AT TIME ZONE 'Asia/Jerusalem')
  ORDER BY t.started_at DESC;
$$;

-- Who had the car at a given Israel-local moment (used for traffic fines).
CREATE OR REPLACE FUNCTION vehicle_driver_at(local_ts timestamp)
RETURNS TABLE (driver_name text, started_at timestamptz, ended_at timestamptz, end_reason text)
LANGUAGE sql STABLE AS $$
  SELECT d.name, t.started_at, t.ended_at, t.end_reason
  FROM vehicle_trips t
  JOIN drivers d ON d.telegram_id = t.driver_id
  WHERE t.started_at <= (local_ts AT TIME ZONE 'Asia/Jerusalem')
    AND coalesce(t.ended_at, now()) >= (local_ts AT TIME ZONE 'Asia/Jerusalem')
  ORDER BY t.started_at;
$$;

-- All trips touching one Israel-local day (the bot's /day command).
CREATE OR REPLACE FUNCTION vehicle_trips_on_day(local_day date)
RETURNS TABLE (driver_name text, started_at timestamptz, ended_at timestamptz, end_reason text)
LANGUAGE sql STABLE AS $$
  SELECT d.name, t.started_at, t.ended_at, t.end_reason
  FROM vehicle_trips t
  JOIN drivers d ON d.telegram_id = t.driver_id
  WHERE t.started_at < ((local_day + 1)::timestamp AT TIME ZONE 'Asia/Jerusalem')
    AND coalesce(t.ended_at, now()) >= (local_day::timestamp AT TIME ZONE 'Asia/Jerusalem')
  ORDER BY t.started_at;
$$;

GRANT EXECUTE ON FUNCTION vehicle_trips_between(date, date) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION vehicle_driver_at(timestamp)      TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION vehicle_trips_on_day(date)        TO anon, authenticated, service_role;
