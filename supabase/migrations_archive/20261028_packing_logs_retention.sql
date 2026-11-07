-- CoffeeFlow — keep packing history (packing_logs) for 10 days only.
--
-- Business decision 2026-10-28: packing history older than 10 days is not
-- needed. The backlog (490 rows, 2026-03-31 → 2026-10-18) was deleted by hand
-- the same day; this job keeps it that way.
--
-- Safe for stock: packed_stock / roasted_stock live on products and
-- roast_profiles. packing_logs is an audit trail only — nothing references it
-- by foreign key and no trigger reads it. The Packaging page lists it and
-- lets a recent entry be corrected; corrections only ever touch recent rows.
--
-- Same shape as purge_chat_messages (20261002_chat_messages_retention.sql),
-- but the window is fixed inside the function (no parameter), so even if
-- EXECUTE were ever re-granted the caller could not widen what gets deleted.

CREATE INDEX IF NOT EXISTS packing_logs_packed_at_idx
  ON packing_logs (packed_at);

CREATE OR REPLACE FUNCTION purge_packing_logs()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted INTEGER;
BEGIN
  DELETE FROM packing_logs WHERE packed_at < NOW() - INTERVAL '10 days';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.purge_packing_logs() FROM anon;
REVOKE EXECUTE ON FUNCTION public.purge_packing_logs() FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.purge_packing_logs() FROM PUBLIC;

COMMENT ON FUNCTION public.purge_packing_logs IS
  'Deletes packing_logs rows with packed_at older than 10 days. Returns rows deleted. Run daily by packing-logs-purge-daily. EXECUTE revoked from anon/authenticated/PUBLIC.';

-- Idempotent reschedule, same shape as the other cron migrations.
SELECT cron.unschedule('packing-logs-purge-daily')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'packing-logs-purge-daily');

-- 03:50 UTC daily — a free slot ten minutes after chat-messages-purge-daily
-- (03:40), keeping the cron grid at one job per slot.
SELECT cron.schedule(
  'packing-logs-purge-daily',
  '50 3 * * *',
  $$ SELECT purge_packing_logs(); $$
);

-- ── Verify (run manually after this migration applies) ─────────────────
--   SELECT jobname, schedule FROM cron.job WHERE jobname = 'packing-logs-purge-daily';
--   SELECT min(packed_at), count(*) FROM packing_logs;   -- min ≥ now() - 10 days after a run
--   SELECT status, return_message, start_time
--     FROM cron.job_run_details d JOIN cron.job j USING (jobid)
--    WHERE j.jobname = 'packing-logs-purge-daily'
--    ORDER BY start_time DESC LIMIT 3;
