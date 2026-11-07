-- Minuto Organic Marketing — consolidated cron registration.
--
-- WHY THIS EXISTS: the health-watchdog flagged 5 strategic crons as
-- "NO runs on record" — meaning they were never registered in prod's
-- cron.job table. The per-feature migrations (20260528_*_cron.sql) were
-- authored but never applied. The worker-tick crons + the watchdog
-- itself ARE registered (they fire), so this isn't a pg_cron-disabled
-- problem — just un-applied DDL.
--
-- This bundles the full strategic-cron set into ONE idempotent script so
-- the whole autonomous pipeline comes online in a single paste. Every
-- block is unschedule-then-schedule, so re-running is safe and this also
-- supersedes the individual migrations.
--
-- Schedules (all UTC):
--   03:30 daily   industry-intelligence-daily   (field intel ingest)
--   04:30 daily   meta-sync-daily               (IG/FB performance)
--   06:00 daily   ga4-sync-daily                (organic landing pages)
--   06:30 daily   evaluator-tick-daily          (experiment scoring)
--   07:00 daily   scout-tick-daily              (signal detection)
--   05:00 Sun+Wed organic-orchestrator-twice-weekly (the strategist)
--   22:00 Sat     ai-visibility-probe-weekly    (GEO/LLMO probe)
--   */3 min       seo-worker-research-tick      (deep-research drain)
--
-- The worker ticks (writer/visual/instagram every 2-3 min) are NOT
-- repeated here — they were already registered and are firing. Re-run
-- their own migrations if the watchdog ever flags them too.

-- ── Strategist: twice-weekly orchestrator (Sun + Wed 05:00 UTC) ────────
-- Also clears the two retired predecessors if they still linger.
SELECT cron.unschedule('organic-content-twice-weekly')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'organic-content-twice-weekly');
SELECT cron.unschedule('seo-orchestrator-twice-weekly')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'seo-orchestrator-twice-weekly');
SELECT cron.unschedule('organic-orchestrator-twice-weekly')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'organic-orchestrator-twice-weekly');
SELECT cron.schedule(
  'organic-orchestrator-twice-weekly',
  '0 5 * * 0,3',
  $$
    SELECT net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/organic-orchestrator',
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := '{"trigger":"cron"}'::jsonb,
      timeout_milliseconds := 240000
    );
  $$
);

-- ── Daily data syncs ───────────────────────────────────────────────────
SELECT cron.unschedule('industry-intelligence-daily')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'industry-intelligence-daily');
SELECT cron.schedule(
  'industry-intelligence-daily',
  '30 3 * * *',
  $$
    SELECT net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/industry-intelligence-sync',
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := '{}'::jsonb,
      timeout_milliseconds := 240000
    );
  $$
);

SELECT cron.unschedule('meta-sync-daily')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'meta-sync-daily');
SELECT cron.schedule(
  'meta-sync-daily',
  '30 4 * * *',
  $$
    SELECT net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/meta-sync?mode=performance',
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := '{}'::jsonb,
      timeout_milliseconds := 150000
    );
  $$
);

SELECT cron.unschedule('ga4-sync-daily')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ga4-sync-daily');
SELECT cron.schedule(
  'ga4-sync-daily',
  '0 6 * * *',
  $$
    SELECT net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/ga4-sync',
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := '{"lookback_days":7}'::jsonb,
      timeout_milliseconds := 120000
    );
  $$
);

-- ── Autonomous learning: evaluator + scout ─────────────────────────────
SELECT cron.unschedule('evaluator-tick-daily')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'evaluator-tick-daily');
SELECT cron.schedule(
  'evaluator-tick-daily',
  '30 6 * * *',
  $$
    SELECT net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/evaluator-tick',
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := '{}'::jsonb,
      timeout_milliseconds := 240000
    );
  $$
);

SELECT cron.unschedule('scout-tick-daily')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'scout-tick-daily');
SELECT cron.schedule(
  'scout-tick-daily',
  '0 7 * * *',
  $$
    SELECT net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/scout-tick',
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := '{}'::jsonb,
      timeout_milliseconds := 120000
    );
  $$
);

-- ── GEO/LLMO weekly probe ──────────────────────────────────────────────
SELECT cron.unschedule('ai-visibility-probe-weekly')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ai-visibility-probe-weekly');
SELECT cron.schedule(
  'ai-visibility-probe-weekly',
  '0 22 * * 6',
  $$
    SELECT net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/ai-visibility-probe',
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := '{}'::jsonb,
      timeout_milliseconds := 240000
    );
  $$
);

-- ── Deep-research worker drain (every 3 min) ───────────────────────────
SELECT cron.unschedule('seo-worker-research-tick')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'seo-worker-research-tick');
SELECT cron.schedule(
  'seo-worker-research-tick',
  '*/3 * * * *',
  $$
    SELECT net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/seo-worker-research',
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := '{}'::jsonb,
      timeout_milliseconds := 150000
    );
  $$
);

-- ── Verify (run after applying) ────────────────────────────────────────
--   SELECT jobname, schedule, active FROM cron.job
--   WHERE jobname IN (
--     'organic-orchestrator-twice-weekly','industry-intelligence-daily',
--     'meta-sync-daily','ga4-sync-daily','evaluator-tick-daily',
--     'scout-tick-daily','ai-visibility-probe-weekly','seo-worker-research-tick'
--   ) ORDER BY jobname;
--   -- Expect 8 rows, all active=true.
