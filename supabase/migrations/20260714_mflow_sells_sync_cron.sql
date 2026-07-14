-- MFlow sells → CoffeeFlow packed_stock sync cron.
--
-- Pulls recent MFlow sells every 15 min and applies the net coffee-bag movement to
-- products.packed_stock (CoffeeFlow is master; sales decrement, returns add back).
-- Idempotent via mflow_sell_events (each sell id applied once), so a rolling 2-day
-- window is safe — it re-scans recent sells but only applies new ones, catching
-- late-arriving / just-completed sales. ~3 MFlow calls per run (1 /products/ids +
-- ~2 sells pages), well under MFlow's 30 req/min cap.
--
-- stock-update is deployed --no-verify-jwt, so no auth header needed.
-- Idempotent: unschedule first, then schedule. Safe to re-run.

SELECT cron.unschedule('mflow-sells-sync')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'mflow-sells-sync');

SELECT cron.schedule(
  'mflow-sells-sync',
  '*/15 * * * *',
  $$
    SELECT net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/stock-update',
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := '{"action":"mflow_sync_sells","days":2,"apply":true}'::jsonb,
      timeout_milliseconds := 120000
    );
  $$
);

-- Verify:  SELECT jobname, schedule, active FROM cron.job WHERE jobname='mflow-sells-sync';
