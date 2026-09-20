-- CoffeeFlow — durable, queryable system log.
--
-- WHY THIS EXISTS
-- Until now the only log we had was console.log inside each edge function.
-- That has three properties that make debugging a live bug painful:
--   1. It is per-function. A failure that starts in organic-orchestrator and
--      surfaces in meta-publish cannot be followed across the hop.
--   2. It is ephemeral. By the time someone notices the symptom (a sync that
--      went stale days ago, a bot that stopped replying) the lines are gone.
--   3. It is not queryable. "Show me every error in the last 24h" is not a
--      question the Supabase log viewer answers across 59 functions.
--
-- system_logs fixes all three: one table, one row per log line, correlated by
-- run_id so a whole invocation reads back as a trace.
--
-- This does NOT replace console.log — the logger writes to both. Console stays
-- useful for tailing a function live; this table is for reading after the fact.

CREATE TABLE IF NOT EXISTS system_logs (
  id          BIGSERIAL   PRIMARY KEY,
  ts          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Which function emitted the line, and which single invocation of it.
  -- run_id is generated per invocation by the logger, so every line from one
  -- run shares it. This is the column that turns scattered lines into a trace.
  fn          TEXT        NOT NULL,
  run_id      UUID        NOT NULL,
  seq         INTEGER     NOT NULL DEFAULT 0,   -- order within the run; ts alone ties

  level       TEXT        NOT NULL,             -- debug | info | warn | error
  -- Short machine-readable key ('sync.start', 'woo.fetch.fail'). Lets you grep
  -- for a specific step without depending on prose that gets reworded.
  event       TEXT,
  message     TEXT        NOT NULL,
  data        JSONB,                            -- structured context

  duration_ms INTEGER,                          -- set on timing lines / run finish
  error_name  TEXT,
  error_stack TEXT,

  -- Set only on the synthetic line the logger writes when a run ends.
  -- Non-null marks this row as a run summary: started | success | partial | error.
  run_status  TEXT
);

-- ── Indexes ────────────────────────────────────────────────────────────
-- Written on every log line, so keep these lean and purposeful — one per
-- question the CLI reader actually asks.

-- "what happened recently" (the default view)
CREATE INDEX IF NOT EXISTS system_logs_ts_idx      ON system_logs (ts DESC);
-- "what happened in <function>"
CREATE INDEX IF NOT EXISTS system_logs_fn_ts_idx   ON system_logs (fn, ts DESC);
-- "show me this whole run" — the trace lookup
CREATE INDEX IF NOT EXISTS system_logs_run_idx     ON system_logs (run_id, seq);
-- "what is broken" — partial, so it stays small and hot even as the table grows
CREATE INDEX IF NOT EXISTS system_logs_errors_idx  ON system_logs (ts DESC)
  WHERE level IN ('warn', 'error');
-- "which runs failed" — also partial; run summaries are a tiny fraction of rows
CREATE INDEX IF NOT EXISTS system_logs_runs_idx    ON system_logs (fn, ts DESC)
  WHERE run_status IS NOT NULL;

COMMENT ON TABLE  system_logs        IS 'Durable cross-function log. Written by supabase/functions/_shared/logger.ts; read with scripts/logs.sh. Purged after 30 days by the system-logs-purge-daily cron.';
COMMENT ON COLUMN system_logs.run_id IS 'One invocation of one function. Join lines on this to reconstruct a trace.';
COMMENT ON COLUMN system_logs.event  IS 'Stable machine-readable step key, e.g. sync.start / woo.fetch.fail. Prefer filtering on this over message text.';

-- ── RLS ────────────────────────────────────────────────────────────────
-- Same convention as the other shared operational tables (see
-- 20260714_mflow_sell_events.sql): functions write with the service role,
-- and the anon/authenticated dashboard roles can read.
--
-- Deliberately NO delete policy: log rows are evidence. The purge job runs as
-- a SECURITY DEFINER function on a fixed age window, which is the only way
-- rows are meant to leave this table.
ALTER TABLE system_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "system_logs_select" ON system_logs;
CREATE POLICY "system_logs_select" ON system_logs
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "system_logs_insert" ON system_logs;
CREATE POLICY "system_logs_insert" ON system_logs
  FOR INSERT TO anon, authenticated WITH CHECK (true);

-- ── Run rollup ─────────────────────────────────────────────────────────
-- Derived, not stored: one row per invocation with its outcome and error
-- count. This is what "which runs failed today" reads, so it does not have to
-- scan every line of every healthy run.
CREATE OR REPLACE VIEW system_log_runs AS
SELECT
  run_id,
  MIN(fn)                                            AS fn,
  MIN(ts)                                            AS started_at,
  MAX(ts)                                            AS ended_at,
  MAX(duration_ms) FILTER (WHERE run_status IS NOT NULL) AS duration_ms,
  -- A run with no terminal line was killed before it could write one (worker
  -- timeout, OOM). Surfacing that as 'incomplete' rather than hiding it is the
  -- whole point — a silent truncation is exactly the bug we keep missing.
  COALESCE(
    MAX(run_status) FILTER (WHERE run_status IN ('success','partial','error')),
    'incomplete'
  )                                                  AS status,
  COUNT(*) FILTER (WHERE level = 'error')            AS errors,
  COUNT(*) FILTER (WHERE level = 'warn')             AS warnings,
  COUNT(*)                                           AS lines
FROM system_logs
GROUP BY run_id;

COMMENT ON VIEW system_log_runs IS 'One row per invocation. status=incomplete means the run never wrote a terminal line — it was killed mid-flight.';

GRANT SELECT ON system_log_runs TO anon, authenticated;

-- ── Retention: 30 days ─────────────────────────────────────────────────
-- 30 days is chosen to cover slow-burn failures. A sync that quietly stops
-- (woo-orders-sync sat ~6 days stale before anyone noticed) or a job on a
-- weekly/monthly cadence needs more history than a fortnight to diagnose.
--
-- Deletes in bounded batches so the daily job never takes a long lock on a
-- table that edge functions are concurrently writing to.
CREATE OR REPLACE FUNCTION purge_system_logs(p_keep_days INTEGER DEFAULT 30)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cutoff  TIMESTAMPTZ := NOW() - (p_keep_days || ' days')::INTERVAL;
  v_batch   INTEGER;
  v_total   INTEGER := 0;
BEGIN
  LOOP
    DELETE FROM system_logs
    WHERE id IN (
      SELECT id FROM system_logs WHERE ts < v_cutoff LIMIT 10000
    );
    GET DIAGNOSTICS v_batch = ROW_COUNT;
    v_total := v_total + v_batch;
    EXIT WHEN v_batch = 0;
  END LOOP;
  RETURN v_total;
END;
$$;

COMMENT ON FUNCTION purge_system_logs IS 'Deletes system_logs rows older than p_keep_days in 10k batches. Returns rows deleted. Run daily by system-logs-purge-daily.';

-- Idempotent reschedule, same shape as the other cron migrations.
SELECT cron.unschedule('system-logs-purge-daily')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'system-logs-purge-daily');

-- 03:30 UTC daily. Daily rather than weekly so each run deletes roughly one
-- day of rows instead of seven — small, predictable, and it never collides
-- with a huge backlog after the job has been down.
SELECT cron.schedule(
  'system-logs-purge-daily',
  '30 3 * * *',
  $$ SELECT purge_system_logs(30); $$
);

-- ── Verify (run manually after this migration applies) ─────────────────
--   SELECT jobname, schedule FROM cron.job WHERE jobname = 'system-logs-purge-daily';
--   SELECT * FROM system_log_runs ORDER BY started_at DESC LIMIT 10;
