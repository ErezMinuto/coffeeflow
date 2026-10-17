-- weekly-market-research: send the service-role key.
--
-- marketing-advisor now refuses callers that are neither an admin nor the
-- service role (its verify_jwt is off, and the brain chat it serves can edit
-- live ad campaigns). This job was the one caller of it that sent no
-- Authorization header; every other cron job reads the key from the vault
-- entry cron_service_role_key, as this one now does.
--
-- Apply BEFORE redeploying marketing-advisor, or Monday's run gets a 403.
-- Schedule, body and timeout are unchanged from 20261017_weekly_market_research_cron.sql.
-- Idempotent.

SELECT cron.unschedule('weekly-market-research')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'weekly-market-research');

SELECT cron.schedule(
  'weekly-market-research',
  '55 3 * * 1',
  $$
    SELECT net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/marketing-advisor',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key' LIMIT 1),
        'Content-Type', 'application/json'
      ),
      body := jsonb_build_object('trigger', 'cron', 'agent', 'market_research'),
      timeout_milliseconds := 300000
    );
  $$
);
