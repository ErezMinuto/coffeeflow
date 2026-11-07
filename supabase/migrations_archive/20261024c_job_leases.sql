-- =============================================================================
-- job_leases: "only one run at a time" for background jobs.
--
-- Why: organic-orchestrator had no active-run claim. A manual run overlapping
-- the cron (or two crons when one ran long) planned from the same queue state
-- and inserted duplicate task batches.
--
-- A Postgres advisory lock can't cover this: the cycle is many PostgREST
-- requests in a background edge task, and an advisory lock dies with the
-- request's transaction. A lease row with an expiry does survive across
-- requests, and a run that is hard-killed loses it when it expires.
--
--   acquire_job_lease(name, holder, ttl_seconds) → true when the caller now
--     holds the lease (it was free, expired, or already the caller's).
--   release_job_lease(name, holder) → true when the caller's lease was removed.
--
-- Service role only. Idempotent and additive.
-- =============================================================================

CREATE TABLE IF NOT EXISTS job_leases (
  name        text PRIMARY KEY,
  holder      text NOT NULL,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);
ALTER TABLE job_leases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON job_leases FROM anon, authenticated;

CREATE OR REPLACE FUNCTION acquire_job_lease(p_name text, p_holder text, p_ttl_seconds integer)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_got text;
BEGIN
  IF p_name IS NULL OR p_holder IS NULL OR p_ttl_seconds IS NULL OR p_ttl_seconds <= 0 THEN
    RAISE EXCEPTION 'acquire_job_lease: name, holder and a positive ttl are required' USING ERRCODE = '22023';
  END IF;
  INSERT INTO job_leases AS l (name, holder, acquired_at, expires_at)
  VALUES (p_name, p_holder, now(), now() + make_interval(secs => p_ttl_seconds))
  ON CONFLICT (name) DO UPDATE
     SET holder = EXCLUDED.holder, acquired_at = EXCLUDED.acquired_at, expires_at = EXCLUDED.expires_at
   WHERE l.expires_at < now() OR l.holder = EXCLUDED.holder
  RETURNING holder INTO v_got;
  RETURN v_got IS NOT NULL;
END;
$$;

CREATE OR REPLACE FUNCTION release_job_lease(p_name text, p_holder text)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH d AS (DELETE FROM job_leases WHERE name = p_name AND holder = p_holder RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM d);
$$;

REVOKE ALL ON FUNCTION acquire_job_lease(text, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION release_job_lease(text, text)          FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION acquire_job_lease(text, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION release_job_lease(text, text)          TO service_role;
