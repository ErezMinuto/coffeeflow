-- CoffeeFlow — make system_log_runs honour RLS instead of bypassing it.
--
-- WHAT THE ADVISOR CAUGHT
--   security_definer_view (ERROR — the only ERROR-level lint on the project):
--   View `public.system_log_runs` is defined with the SECURITY DEFINER property.
--
-- WHY IT MATTERS
-- Postgres views default to `security_invoker = off`, which means the view runs
-- with the rights of its OWNER, not of whoever queries it. system_log_runs is
-- granted to anon and authenticated, so any caller reads system_logs with the
-- owner's privileges — and therefore straight past the row level security on
-- that table.
--
-- Today that changes nothing in practice: the `system_logs_select` policy is
-- `TO anon, authenticated USING (true)`, so the rows an invoker would see are
-- the rows a definer sees. The problem is that the bypass is silent and
-- permanent. The moment anyone tightens that policy — scoping logs per user,
-- hiding a function's lines, redacting error_stack — the table would enforce it
-- and this view would quietly keep serving everything anyway. A policy that one
-- view ignores is not a policy.
--
-- This is the same shape as the purge_system_logs hole fixed in 20260922: the
-- table's own rules are sound, and something built on top of it reaches around
-- them.
--
-- THE FIX
-- `security_invoker = on` makes the view execute as the caller, so RLS on
-- system_logs applies to whoever is querying. Same approach as
-- 20260907_bean_sales_daily_security_invoker.sql.
--
-- ALTER VIEW rather than CREATE OR REPLACE VIEW on purpose: prod has drifted
-- from git before, and restating the body would silently overwrite whatever is
-- actually deployed. This flips the one flag and leaves the definition alone.
ALTER VIEW public.system_log_runs SET (security_invoker = on);

-- With security_invoker on, the caller needs SELECT on the BASE TABLE, not just
-- on the view — otherwise the dashboard starts getting "permission denied for
-- table system_logs".
--
-- 20260920_system_logs.sql wrote an RLS SELECT policy for anon/authenticated but
-- never wrote a matching GRANT; it relied on Supabase's default privileges,
-- which do grant anon on new tables in `public`. That is the same implicit
-- grant that made the cron_job_backup leak possible, so it is worth stating
-- explicitly here instead of depending on it. A GRANT alone exposes nothing —
-- reads are still filtered by the policy.
GRANT SELECT ON public.system_logs TO anon, authenticated;

-- Unchanged, restated so this migration is self-contained.
GRANT SELECT ON public.system_log_runs TO anon, authenticated;

COMMENT ON VIEW public.system_log_runs IS
  'One row per invocation. status=incomplete means the run never wrote a terminal line — it was killed mid-flight. security_invoker=on, so RLS on system_logs applies to the caller rather than the view owner.';

-- ── If you would rather anon could NOT read raw log lines ──────────────
-- Note what this migration does and does not decide. `system_logs_select` is
-- `USING (true)` for anon and authenticated, i.e. the current design is that
-- logs are world-readable to anyone holding the anon key — which ships in the
-- frontend bundle. scripts/logs.sh depends on exactly that.
--
-- If that is not wanted, the fix is to tighten the POLICY, not the view:
--
--   DROP POLICY "system_logs_select" ON public.system_logs;
--   CREATE POLICY "system_logs_select" ON public.system_logs
--     FOR SELECT TO authenticated USING (true);
--
-- That is a deliberate behaviour change (it would break logs.sh's anon reads),
-- so it is left out here. The point of this migration is that once the view is
-- an invoker, such a change would actually take effect — which it would not
-- have before.

-- ── Verify ─────────────────────────────────────────────────────────────
--   -- expect security_invoker=true in the options:
--   SELECT relname, reloptions FROM pg_class WHERE relname = 'system_log_runs';
--
--   -- and the view should still return rows:
--   SELECT * FROM public.system_log_runs ORDER BY started_at DESC LIMIT 5;
