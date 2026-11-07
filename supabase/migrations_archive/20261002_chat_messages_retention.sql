-- CoffeeFlow — keep SEO/organic agent chat history for at most 60 days.
--
-- chat_messages had no retention: every turn of the admin chat (user message,
-- each assistant tool_use turn, each tool result, final text) plus the
-- orchestrator's 'briefings-system' notes accumulated forever. The business
-- decision is two months, max.
--
-- Same shape as purge_system_logs (20260920_system_logs.sql): a SECURITY
-- DEFINER function deleting in 10k batches, run daily by pg_cron, with
-- EXECUTE revoked from anon/authenticated/PUBLIC up front — see
-- 20260922_revoke_purge_system_logs.sql for why a callable purge RPC with a
-- caller-supplied window is a wipe-the-table hole.
--
-- Rows are deleted by their own created_at, so a session that straddles the
-- cutoff loses only its oldest turns. That is safe for the chat handler:
-- storedToApiMessages replays from the first user row and patches/drops any
-- tool_use↔tool_result pair the cutoff splits.
--
-- Long-lived knowledge does NOT live here: seo_learnings (record_learning) is
-- a separate table and is untouched.
--
-- The first run deletes the existing backlog older than 60 days in one go.

CREATE INDEX IF NOT EXISTS chat_messages_created_at_idx
  ON chat_messages (created_at);

CREATE OR REPLACE FUNCTION purge_chat_messages(p_keep_days INTEGER DEFAULT 60)
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
    DELETE FROM chat_messages
    WHERE id IN (
      SELECT id FROM chat_messages WHERE created_at < v_cutoff LIMIT 10000
    );
    GET DIAGNOSTICS v_batch = ROW_COUNT;
    v_total := v_total + v_batch;
    EXIT WHEN v_batch = 0;
  END LOOP;
  RETURN v_total;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.purge_chat_messages(integer) FROM anon;
REVOKE EXECUTE ON FUNCTION public.purge_chat_messages(integer) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.purge_chat_messages(integer) FROM PUBLIC;

COMMENT ON FUNCTION public.purge_chat_messages IS
  'Deletes chat_messages rows older than p_keep_days (default 60) in 10k batches. Returns rows deleted. Run daily by chat-messages-purge-daily. EXECUTE revoked from anon/authenticated/PUBLIC: SECURITY DEFINER + caller-supplied window would let the anon key wipe the table.';

-- Idempotent reschedule, same shape as the other cron migrations.
SELECT cron.unschedule('chat-messages-purge-daily')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'chat-messages-purge-daily');

-- 03:40 UTC daily — ten minutes after system-logs-purge-daily so the two
-- never run on top of each other.
SELECT cron.schedule(
  'chat-messages-purge-daily',
  '40 3 * * *',
  $$ SELECT purge_chat_messages(60); $$
);

-- ── Verify (run manually after this migration applies) ─────────────────
--   SELECT jobname, schedule FROM cron.job WHERE jobname = 'chat-messages-purge-daily';
--   SELECT min(created_at), count(*) FROM chat_messages;   -- min ≥ now() - 60 days after first run
--   SELECT status, return_message, start_time
--     FROM cron.job_run_details d JOIN cron.job j USING (jobid)
--    WHERE j.jobname = 'chat-messages-purge-daily'
--    ORDER BY start_time DESC LIMIT 3;
