-- CoffeeFlow — stop the recurring "Database not usable" / "Data API 5xx" outage.
--
-- WHAT WENT WRONG (2026-09-20)
-- Two Supabase lint items fire together — "Database not usable
-- (CONNECT_TIMEOUT)" and "Data API error rate is persistently high" — but they
-- are one fault. The evidence:
--
--   * Every failed cron run reports  return_message = 'job startup timeout'.
--     pg_cron could not LAUNCH a background worker. Those jobs showing 510s
--     durations were not working for 510s; they were queued for a worker slot
--     that never came, then gave up.
--   * Postgres logged  'could not accept SSL connection: EOF detected'  — it
--     was alive and listening, but could not complete handshakes.
--   * pooler and realtime stayed healthy throughout, because they already HELD
--     their connections. Only NEW connections failed.
--   * Only 21 of 60 connections were in use, and the Data API window that
--     tripped the lint had just 42 requests. Not connection exhaustion, and
--     not request load.
--
-- The one thing that explains all of it: the postmaster could not FORK new
-- processes. Both a pg_cron background worker and a client backend are forked
-- by the postmaster. When that fork fails you get exactly this pair of
-- symptoms while everything already connected keeps working.
--
-- WHY IT RECURS ON A SCHEDULE
-- The instance is Micro (max_connections=60 confirms it; ~1GB RAM) and its
-- background-worker budget is tiny:
--
--     max_worker_processes = 6
--
-- Four are permanently held: the pg_cron launcher, the autovacuum launcher,
-- the logical replication launcher (realtime) and the pg_net worker. That
-- leaves TWO. Against those two the server promises:
--
--     cron.max_running_jobs            = 32
--     autovacuum_max_workers           =  3
--     max_parallel_workers             =  2
--     max_logical_replication_workers  =  4
--
-- And 38 active jobs were scheduled so that ELEVEN fire at minute :00 and :30
-- of every hour, five of them colliding on '*/2'.
--
-- In normal operation each job finishes in 0.1-0.5s, so the collision is
-- survivable. It stops being survivable when the box has no memory headroom:
-- eleven simultaneous fork() requests on a 1GB instance is the shove that tips
-- it, and once forking fails the failures pile up and it stays wedged.
--
-- So the collision is the TRIGGER; the undersized instance is the CAUSE. This
-- migration removes the trigger. It does not add memory — see the closing note.
--
-- WHAT THIS MIGRATION DOES
--   1. Collapses the five '*/2' jobs and the two '*/3' jobs into two
--      dispatchers. net.http_post is asynchronous — it enqueues into pg_net and
--      returns in milliseconds — so one worker can fire a whole group.
--   2. Drops those pollers from every 2-3 minutes to every 5. All seven are
--      `claimNextTask` queue workers with an idle path, so the only effect is
--      that a queued task waits a few minutes longer. Poller invocations fall
--      from ~4,560/day to ~2,016/day.
--   3. Re-times EVERY recurring job onto a provably collision-free grid, so no
--      two of them ever want a worker in the same minute.
--
-- The result: peak simultaneous forks goes from 11 to 1.
--
--   minute:  0        1      2      3      4      5      8      10     15
--            (daily)  reel   wrk-a  missn  wrk-b  mflow  attnd  stock  (daily)
--
-- Minutes 0, 15, 30, 45 and 55 are left completely free of recurring ticks,
-- and every daily/weekly job is placed on one of them.
--
-- DELIBERATELY NOT DONE: collapsing the five ga4-sync jobs into one. They call
-- the same function with different channel arguments, and their spacing is
-- deliberate — firing them together would mean five concurrent GA4 syncs, i.e.
-- trading a fork spike for a memory spike. Job COUNT was never the problem;
-- SIMULTANEITY was. They are staggered below instead.
--
-- Rollback: the pre-change cron.job table is snapshotted below.

-- ── 0. Rollback point ──────────────────────────────────────────────────
-- Already created during the 2026-09-20 incident triage, so this is a no-op
-- there; the IF NOT EXISTS keeps the ORIGINAL pre-change snapshot rather than
-- overwriting it with a half-migrated state.
CREATE TABLE IF NOT EXISTS public.cron_job_backup_20260920 AS
  SELECT * FROM cron.job;

COMMENT ON TABLE public.cron_job_backup_20260920 IS
  'Snapshot of cron.job before 20260920_cron_worker_pressure.sql. Restore one schedule with: SELECT cron.alter_job(j.jobid, schedule := b.schedule) FROM cron.job j JOIN public.cron_job_backup_20260920 b USING (jobname) WHERE j.jobname = ...;';

-- ── 1. Collapse the high-frequency pollers, and slow them to every 5m ──
-- Each original command is a single `SELECT net.http_post(...);` with no
-- dollar-quoting (verified against prod before writing this), so they can be
-- rewritten to PERFORM and concatenated.
--
-- Each post keeps its OWN BEGIN/EXCEPTION block. Without that, one failing post
-- would abort the job and silently drop the rest — independence that separate
-- jobs used to give for free.
--
-- The two groups sit on offset '*/5' grids (2,7,12,... and 4,9,14,...) so they
-- never land in the same minute as each other or as any other tick job.
--
-- NOTE: these commands embed a service-role Authorization header. They are
-- copied column-to-column inside the database and never printed, so no
-- credential passes through a shell, a log or a diff.
DO $dispatch$
DECLARE
  v_cmd   text;
  v_names text[];
  v_name  text;
  r       record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('*/2 * * * *', 'cf-dispatch-workers-a', '2-57/5 * * * *'),
      ('*/3 * * * *', 'cf-dispatch-workers-b', '4-59/5 * * * *')
    ) AS t(old_schedule, new_name, new_schedule)
  LOOP
    SELECT string_agg(
             'DO $w$ BEGIN ' ||
             regexp_replace(command, '^\s*SELECT', 'PERFORM', 'i') ||
             ' EXCEPTION WHEN OTHERS THEN RAISE WARNING ''cf-dispatch %: %'', ' ||
             quote_literal(jobname) || ', SQLERRM; END $w$;',
             E'\n' ORDER BY jobname),
           array_agg(jobname ORDER BY jobname)
      INTO v_cmd, v_names
    FROM cron.job
    WHERE active AND schedule = r.old_schedule AND jobname <> r.new_name;

    -- Only act when there is something to collapse, so re-running is a no-op.
    IF v_cmd IS NOT NULL AND COALESCE(array_length(v_names, 1), 0) >= 2 THEN
      PERFORM cron.schedule(r.new_name, r.new_schedule, v_cmd);
      FOREACH v_name IN ARRAY v_names LOOP
        PERFORM cron.unschedule(v_name);
      END LOOP;
      RAISE NOTICE 'collapsed % job(s) into % on %',
        array_length(v_names, 1), r.new_name, r.new_schedule;
    END IF;
  END LOOP;
END
$dispatch$;

-- ── 2. Re-time every remaining job onto the collision-free grid ────────
-- Recurring ticks each own a distinct residue class; daily and weekly jobs go
-- on minutes 0/15/30/45/55, which no tick ever occupies. Hour and day-of-week
-- are preserved except where noted.
DO $stagger$
DECLARE
  r       record;
  v_jobid bigint;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      -- ── recurring ticks: same cadence, each on its own minutes ──
      ('reel-render-dispatch',                  '1-56/5 * * * *'),
      ('mission-worker-tick',                   '3-53/10 * * * *'),
      ('mflow-sells-sync',                      '5-50/15 * * * *'),
      ('attendance-reminder',                   '8-58/10 3-20 * * 0-5'),
      ('coffeeflow-stock-check',               '10 * * * *'),
      ('mflow-revenue-sync',                   '25 * * * *'),
      ('woo-products-enrich-tick',             '40 */4 * * *'),

      -- ── nightly / daily / weekly, on tick-free minutes ──
      ('coffee-sales-backfill-nightly',         '0 1 * * *'),
      ('green-stock-alert-daily',               '0 3 * * *'),
      ('opening-shift-confirm-followup',       '15 3 * * *'),
      ('industry-intelligence-daily',          '30 3 * * *'),
      ('purge-old-media-weekly',               '45 3 * * 0'),
      ('weekly-marketing-advisor',             '55 3 * * 1'),
      ('meta-sync-daily',                       '0 4 * * *'),
      ('unified-plan-daily',                    '0 5 * * *'),
      ('organic-orchestrator-twice-weekly',    '15 5 * * 0,3'),
      -- the ga4 family keeps its 06:00 window, spaced 15m instead of 10m
      ('ga4-sync-daily',                        '0 6 * * *'),
      ('ga4-sync-paid-social',                 '15 6 * * *'),
      ('ga4-sync-paid-search',                 '30 6 * * *'),
      ('ga4-sync-direct',                      '45 6 * * *'),
      ('ga4-sync-referral',                    '55 6 * * *'),
      ('evaluator-tick-daily',                  '0 7 * * *'),
      ('scout-tick-daily',                     '15 7 * * *'),
      ('strategist-evaluator-daily',           '30 7 * * *'),
      ('strategist-brain-kickoff-weekly',      '45 7 * * 1'),
      ('health-watchdog-daily',                 '0 8 * * *'),
      ('woo-orders-sync-daily',                 '0 9 * * *'),
      ('email-automation-first-purchase-daily', '0 10 * * *'),
      ('employee-availability-reminder-weekly', '0 15 * * 3'),
      ('opening-shift-confirm-evening',         '0 17 * * *'),
      ('ai-visibility-probe-weekly',            '0 22 * * 6')
    ) AS t(jobname, new_schedule)
  LOOP
    SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = r.jobname;
    IF v_jobid IS NOT NULL THEN
      PERFORM cron.alter_job(v_jobid, schedule := r.new_schedule);
    ELSE
      RAISE NOTICE 'skipped % — no such job', r.jobname;
    END IF;
  END LOOP;
END
$stagger$;

-- ── Verify (run after applying) ────────────────────────────────────────
--   -- every active schedule should now be unique:
--   SELECT schedule, count(*), string_agg(jobname, ', ')
--     FROM cron.job WHERE active GROUP BY schedule HAVING count(*) > 1;
--
--   -- and this should stay empty:
--   SELECT j.jobname, d.return_message, d.start_time
--     FROM cron.job_run_details d JOIN cron.job j USING (jobid)
--    WHERE d.status = 'failed' AND d.start_time > now() - interval '1 hour';

-- ── STILL OUTSTANDING — needs a human decision ─────────────────────────
-- This removes the trigger, not the underlying fragility. Two settings still
-- promise far more workers than the instance owns, and NEITHER is reachable
-- from a migration — they are not settable via ALTER SYSTEM on Supabase and
-- need a restart:
--
--   cron.max_running_jobs  32 -> 3   (stop promising 32 workers when 2 exist)
--   max_worker_processes    6 -> 10  (real headroom for autovacuum + pg_cron)
--
-- Both are set from the Supabase dashboard (Database -> Settings) or the
-- Management API. If the outage recurs after this migration, the honest answer
-- is that Micro (~1GB RAM) is undersized for 38 cron jobs and 59 edge
-- functions, and the fix is Compute -> Small.
