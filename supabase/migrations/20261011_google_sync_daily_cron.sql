-- Google Ads sync, daily, plus a one-off 90-day click backfill.
--
-- WHY: google-sync had no schedule (manual button in Settings only). The last
-- run before 2026-10-10 was 2026-08-21, so for seven weeks the advisor, the
-- strategist and the dashboard saw no Google spend or results, and gclid
-- attribution matched 0% of Google orders.
--
-- SLOT: 02:45 UTC. On the collision-free grid from 20260920_cron_worker_pressure
-- (dailies on :00/:15/:30/:45/:55, never two in one minute) nothing else runs
-- in hour 02, and it lands before the weekly advisor (03:55 Mon), meta-sync
-- (04:00) and everything that reads Google data after it.
--
-- AUTH: the anon key is read from Vault when the job fires, so no key is
-- written into this file or into cron.job.command. The function verifies the
-- JWT at the gateway and uses its own service-role env internally.
--
-- click_days=30: a machine or grinder purchase can land weeks after the click.

SELECT cron.unschedule('google-sync-daily')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'google-sync-daily');

SELECT cron.schedule(
  'google-sync-daily',
  '45 2 * * *',
  $$
    SELECT net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/google-sync?mode=performance&click_days=30',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets
                                       WHERE name = 'SUPABASE_ANON_KEY' LIMIT 1)
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 60000
    );
  $$
);

-- One-off: fetch the full 90 days of click_view now, to fill the gap left by
-- the seven weeks without syncs (clicks from late August to late September
-- were never mapped). The function answers 202 at once and works in the
-- background; progress is in sync_log.
SELECT net.http_post(
  url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/google-sync?mode=performance&click_days=90',
  headers := jsonb_build_object(
    'Content-Type',  'application/json',
    'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets
                                   WHERE name = 'SUPABASE_ANON_KEY' LIMIT 1)
  ),
  body := '{}'::jsonb,
  timeout_milliseconds := 60000
);
