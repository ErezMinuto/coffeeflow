-- Owner: "remove all uneeded hardcoded mistakes, like supabase url" — pulled
-- the Supabase project URL out of the cron migration into a single helper
-- function. Future URL changes (custom domain, project migration, etc.) are
-- a one-line UPDATE on this function instead of a diff across SQL files.
--
-- Why a function and not a Postgres SETTING (current_setting('app.url')):
--   Functions are discoverable in pg_dump, schema browsers, and grep.
--   Settings are invisible unless you know to query pg_settings. Function
--   wins on findability.
--
-- Idempotent. Safe to re-run.

CREATE SCHEMA IF NOT EXISTS app;

CREATE OR REPLACE FUNCTION app.supabase_url() RETURNS TEXT
LANGUAGE SQL IMMUTABLE PARALLEL SAFE AS $$
  SELECT 'https://ytydgldyeygpzmlxvpvb.supabase.co'
$$;

COMMENT ON FUNCTION app.supabase_url() IS
  'Single source of truth for the Supabase project URL. Used by pg_cron jobs and any pg_net calls. Update with: CREATE OR REPLACE FUNCTION app.supabase_url() RETURNS TEXT LANGUAGE SQL IMMUTABLE PARALLEL SAFE AS $$ SELECT ''<new URL>'' $$;';

-- Re-schedule the email-automation cron to use the function so future
-- URL changes don''t require touching this job. Drop the existing job
-- by name first, idempotent re-create.

SELECT cron.unschedule('email-automation-first-purchase-daily')
WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'email-automation-first-purchase-daily'
);

SELECT cron.schedule(
  'email-automation-first-purchase-daily',
  '0 10 * * *',  -- daily at 10:00 UTC (~13:00 Israel)
  $$
    SELECT net.http_post(
      url := app.supabase_url() || '/functions/v1/email-automation-scheduler',
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := '{}'::jsonb,
      timeout_milliseconds := 60000
    );
  $$
);

-- Verification (read-only):
--   SELECT jobname, schedule, command FROM cron.job
--    WHERE jobname = 'email-automation-first-purchase-daily';
--   SELECT app.supabase_url();
