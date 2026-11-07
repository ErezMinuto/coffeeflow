-- Lock purge_system_logs to service_role, like its siblings.
--
-- purge_system_logs(p_keep_days) is SECURITY DEFINER (runs as postgres) and
-- deletes every system_logs row older than p_keep_days. In prod, anon and
-- authenticated had EXECUTE on it (verified 2026-11-07 with
-- has_function_privilege), so anyone holding the public anon key could
--   POST /rest/v1/rpc/purge_system_logs  {"p_keep_days":0}
-- and wipe the whole debugging/audit trail. purge_chat_messages and
-- purge_packing_logs were already locked; this one was missed.
--
-- The only legitimate caller is the pg_cron job system-logs-purge-daily
-- (SELECT purge_system_logs(30)), which runs as postgres, the function owner,
-- so it is unaffected. Nothing in src/, supabase/functions/ or scripts/ calls it.
--
-- Revoking FROM PUBLIC alone is not enough: Supabase grants EXECUTE to anon and
-- authenticated explicitly (default privileges), so all three are revoked.
--
-- Defence in depth: the function now refuses p_keep_days < 7 (or NULL), so a
-- mistyped cron command or manual call cannot empty the table either. The
-- body is otherwise unchanged and the cron's 30-day window is unaffected.
-- CREATE OR REPLACE keeps the function's ACL; the REVOKE/GRANT below runs
-- after it anyway.
--
-- Check: scripts/ci/purge_functions_check.sql (run by scripts/qa-scan.sh --db).

CREATE OR REPLACE FUNCTION public.purge_system_logs(p_keep_days integer DEFAULT 30) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_cutoff  TIMESTAMPTZ;
  v_batch   INTEGER;
  v_total   INTEGER := 0;
BEGIN
  IF p_keep_days IS NULL OR p_keep_days < 7 THEN
    RAISE EXCEPTION 'purge_system_logs: p_keep_days must be >= 7 (got %)', p_keep_days
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_cutoff := NOW() - (p_keep_days || ' days')::INTERVAL;
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

REVOKE ALL ON FUNCTION public.purge_system_logs(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_system_logs(integer) TO service_role;

COMMENT ON FUNCTION public.purge_system_logs(integer) IS 'Deletes system_logs rows older than p_keep_days in 10k batches. Returns rows deleted. Run daily by system-logs-purge-daily. Refuses p_keep_days < 7 or NULL. EXECUTE revoked from anon/authenticated/PUBLIC: SECURITY DEFINER + caller-supplied window would let the anon key wipe the table.';
