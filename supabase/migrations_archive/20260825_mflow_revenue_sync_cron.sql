-- MFlow sells → mflow_sell_lines revenue ledger cron.
--
-- WHY THIS EXISTS. mflow_sync_revenue had NO cron at all. The 13-month
-- backfill on 2026-08-22 populated the ledger and then nothing ever advanced
-- it: by 2026-08-25 max(transaction_date) was still 2026-08-22, three days
-- stale and growing, while mflow-sells-sync (stock) ran fine every 15 min.
-- MFlow is the single source of revenue truth, so a frozen ledger silently
-- understates every revenue number downstream of it.
--
-- Same failure shape as woo-orders-sync in 2026-06 (healthy function, no
-- schedule, six days of silent staleness). Both jobs are therefore also
-- registered in health-watchdog's EXPECTED_CRONS + EXPECTED_FRESH_DATA in
-- this same change — an unmonitored sync is how this happens in the first
-- place.
--
-- WINDOW + CADENCE. Hourly at :20, three days back. Hourly is plenty for a
-- reporting ledger (the stock sync is the latency-sensitive one), and :20
-- keeps it clear of mflow-sells-sync at :00/:15/:30/:45 so the two never
-- contend for MFlow's 30 req/min budget. One run is ~1 /products/ids call
-- plus ~3-4 sells pages for a 3-day window.
--
-- Three days rather than one because MFlow documents keep changing after
-- they are written: EcoSite orders sit at 'Processing' before reaching
-- 'Completed', and back-office documents get edited. A rolling re-scan picks
-- those up.
--
-- WHY purge:true. is_return is part of the ledger's primary key
-- (mflow_sell_id, line_id, is_return), so a re-classified document is
-- INSERTED ALONGSIDE its old row rather than replacing it, and gets counted
-- twice with opposite signs. purge deletes the rows for exactly the document
-- ids just fetched — never a blind date-range delete — and the function skips
-- it entirely when the page window was truncated. It also cleans up lines
-- removed from an edited document, which a plain upsert would leave behind.
--
-- The trade-off, stated plainly: purge deletes before it re-inserts, so a
-- failure in between leaves that window short until the next hourly run
-- re-fetches and repairs it. Bounded and self-healing, and the correct trade
-- against double-counted revenue, which is silent and permanent.
--
-- stock-update is deployed --no-verify-jwt, so no auth header is needed
-- (pg_net crons send none).
-- Idempotent: unschedule first, then schedule. Safe to re-run.

SELECT cron.unschedule('mflow-revenue-sync')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'mflow-revenue-sync');

SELECT cron.schedule(
  'mflow-revenue-sync',
  '20 * * * *',
  $$
    SELECT net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/stock-update',
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := '{"action":"mflow_sync_revenue","days":3,"apply":true,"purge":true}'::jsonb,
      timeout_milliseconds := 150000
    );
  $$
);

-- Verify:
--   SELECT jobname, schedule, active FROM cron.job WHERE jobname='mflow-revenue-sync';
--   SELECT max(transaction_date), max(synced_at) FROM mflow_sell_lines;
