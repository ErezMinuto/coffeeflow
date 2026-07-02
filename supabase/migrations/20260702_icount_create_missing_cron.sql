-- Minuto — auto-create iCount items for new WooCommerce products.
--
-- Why: a product added in WooCommerce does NOT appear in iCount on its own
-- (iCount's native "automatic inventory learning" only creates it on first sale,
-- and the real-time webhook path is blocked by the site's reCAPTCHA plugin).
-- This cron calls icount-admin `create_missing`, which lists Woo products whose
-- SKU isn't in iCount yet and creates each via inventory/add_item (matched by
-- SKU). New products land in iCount within ~10 minutes.
--
-- Note: iCount often returns `item_creation_failed` even though the item WAS
-- saved; create_missing reconciles against the catalog and trusts that.
--
-- Schedule: every 10 minutes. Steady-state ticks are cheap (nothing missing →
-- no writes). limit 25/tick drains any backlog over a couple of ticks.
--
-- icount-admin is deployed with --no-verify-jwt, so no auth header is needed.
-- Idempotent: unschedule first, then schedule. Safe to re-run.

SELECT cron.unschedule('icount-create-missing')
WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'icount-create-missing'
);

SELECT cron.schedule(
  'icount-create-missing',
  '*/10 * * * *',  -- every 10 minutes
  $$
    SELECT net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/icount-admin',
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := '{"action":"create_missing","dry_run":false,"limit":25}'::jsonb,
      timeout_milliseconds := 150000
    );
  $$
);

-- Verify:
--   SELECT jobname, schedule, active FROM cron.job WHERE jobname='icount-create-missing';
--
-- Watch runs:
--   SELECT start_time, status, return_message
--   FROM cron.job_run_details
--   WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname='icount-create-missing')
--   ORDER BY start_time DESC LIMIT 10;
