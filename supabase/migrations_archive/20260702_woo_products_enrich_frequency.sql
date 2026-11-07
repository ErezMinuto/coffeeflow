-- Minuto — sync the WooCommerce catalog into woo_products more often.
--
-- woo_products is what CoffeeFlow reads for its product list (stock-page search,
-- marketing). It used to be populated by the MFlow scraper (decommissioned), and
-- woo-products-enrich only UPDATED existing rows — so new WooCommerce products
-- never appeared in CoffeeFlow. woo-products-enrich now UPSERTS (creates missing
-- rows too), so it fully owns the sync.
--
-- Bumped from once-daily (02:30) to every 4 hours so a newly-added product shows
-- up in CoffeeFlow within a few hours instead of the next day. The job pages the
-- whole catalog (~85s); every 4h (6×/day) is a fine load.
--
-- Idempotent: re-scheduling the same jobname updates it.

SELECT cron.schedule(
  'woo-products-enrich-tick',
  '30 */4 * * *',  -- every 4 hours, at :30
  $$
    SELECT net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/woo-products-enrich',
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := '{}'::jsonb,
      timeout_milliseconds := 150000
    );
  $$
);
