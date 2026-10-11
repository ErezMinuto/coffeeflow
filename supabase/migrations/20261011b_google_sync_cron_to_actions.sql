-- Move the daily Google sync from pg_cron to GitHub Actions
-- (.github/workflows/google-sync-daily.yml).
--
-- The pg_cron job from 20261011_google_sync_daily_cron.sql read the anon key
-- from Vault and was rejected with 401. Rather than depend on that key, the
-- schedule now runs on GitHub with the repo's existing service-role secret,
-- which also keeps it off the Micro instance's background-worker budget
-- (the cause of the 2026-09-20 outage).
SELECT cron.unschedule('google-sync-daily')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'google-sync-daily');
