-- =============================================================================
-- Bot rate limiting: tumbling-window counter per (telegram_id, bot_name).
--
-- Each bot pre-checks this on every webhook invocation via the
-- check_bot_rate_limit RPC. If a telegram_id exceeds the per-window limit,
-- the bot drops the request without calling Claude or touching the DB.
--
-- Tumbling window (not sliding) for simplicity: when the current window is
-- older than p_window_seconds, reset to now with count=1. Otherwise
-- increment and compare against p_limit.
--
-- Defense in depth against:
--   - Insider flooding (disgruntled employee with webhook secret)
--   - Automated scraping if webhook secret leaks
--   - Runaway automation loops
--
-- Applied directly to prod via the management API — CLI migrations are
-- drifted. Idempotent so re-running is safe.
-- =============================================================================

CREATE TABLE IF NOT EXISTS bot_rate_limit (
  telegram_id   TEXT        NOT NULL,
  bot_name      TEXT        NOT NULL,
  window_start  TIMESTAMPTZ NOT NULL DEFAULT now(),
  request_count INTEGER     NOT NULL DEFAULT 1,
  PRIMARY KEY (telegram_id, bot_name)
);

-- Cheap periodic cleanup: rows whose window is more than 1 hour old can be
-- dropped. Run manually via SQL editor or add a pg_cron job later.
CREATE INDEX IF NOT EXISTS bot_rate_limit_window_idx ON bot_rate_limit (window_start);

ALTER TABLE bot_rate_limit ENABLE ROW LEVEL SECURITY;

-- Only the service role can touch this table. The bots all use the service
-- role key, and we don't want anon/authenticated clients to read or tamper
-- with rate-limit state.
DROP POLICY IF EXISTS "service_only_select" ON bot_rate_limit;
DROP POLICY IF EXISTS "service_only_insert" ON bot_rate_limit;
DROP POLICY IF EXISTS "service_only_update" ON bot_rate_limit;
DROP POLICY IF EXISTS "service_only_delete" ON bot_rate_limit;

-- RLS enabled but with no anon/authenticated policies means only the service
-- role bypasses RLS and can read/write. That's the intended behavior.

GRANT SELECT, INSERT, UPDATE, DELETE ON bot_rate_limit TO service_role;

-- ── check_bot_rate_limit RPC ──────────────────────────────────────────────────
-- Atomic upsert-and-compare. Returns TRUE if the request is within the limit,
-- FALSE if the caller should be rate-limited. SECURITY DEFINER so it runs as
-- the function owner (superuser) and can touch the RLS-locked table even when
-- called from an anon context — but we only expose it to service_role anyway.

CREATE OR REPLACE FUNCTION check_bot_rate_limit(
  p_telegram_id   TEXT,
  p_bot_name      TEXT,
  p_limit         INTEGER,
  p_window_seconds INTEGER
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  INSERT INTO bot_rate_limit (telegram_id, bot_name, window_start, request_count)
  VALUES (p_telegram_id, p_bot_name, now(), 1)
  ON CONFLICT (telegram_id, bot_name) DO UPDATE SET
    window_start = CASE
      WHEN bot_rate_limit.window_start < now() - (p_window_seconds || ' seconds')::interval
        THEN now()
      ELSE bot_rate_limit.window_start
    END,
    request_count = CASE
      WHEN bot_rate_limit.window_start < now() - (p_window_seconds || ' seconds')::interval
        THEN 1
      ELSE bot_rate_limit.request_count + 1
    END
  RETURNING request_count INTO v_count;

  RETURN v_count <= p_limit;
END;
$$;

REVOKE ALL ON FUNCTION check_bot_rate_limit(TEXT, TEXT, INTEGER, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION check_bot_rate_limit(TEXT, TEXT, INTEGER, INTEGER) TO service_role;
