-- CoffeeFlow — Purge Old Media weekly cron.
--
-- Calls the purge-old-media edge function once a week to delete stale
-- throwaway renders from the `marketing` storage bucket (vertex-test/,
-- ig-test/, ig-overlay/, banners/ per their keep-windows). See:
--   supabase/functions/purge-old-media/index.ts
--
-- Cadence: Sundays 03:00 UTC. Low-traffic hour; weekly matches the
-- conservative multi-day keep windows (nothing eligible accumulates fast).
--
-- The cron passes { "commit": true } — the function defaults to a dry run
-- (deletes nothing) when called without it, so an accidental empty POST is
-- harmless.
--
-- Idempotent: unschedule first, then schedule. Re-running is safe.
--
-- pg_cron + pg_net are already installed in this project (see
-- 20260428e_email_automation_daily_cron.sql and the seo-worker crons).

SELECT cron.unschedule('purge-old-media-weekly')
WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'purge-old-media-weekly'
);

SELECT cron.schedule(
  'purge-old-media-weekly',
  '0 3 * * 0',  -- Sundays 03:00 UTC
  $$
    SELECT net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/purge-old-media',
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := '{"commit": true}'::jsonb,
      timeout_milliseconds := 120000
    );
  $$
);

-- ── Verify (run manually after this migration applies) ─────────────────
--   SELECT jobname, schedule, command FROM cron.job
--   WHERE jobname = 'purge-old-media-weekly';
--
-- Watch a run:
--   SELECT * FROM cron.job_run_details
--   WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname='purge-old-media-weekly')
--   ORDER BY start_time DESC LIMIT 5;
