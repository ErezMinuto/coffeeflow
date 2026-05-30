-- Roll back the woo_products.description column + the daily enricher cron.
--
-- Adding a DB column and pre-staging descriptions via a daily sync was the
-- wrong shape. The agent should READ product descriptions live, on demand,
-- itself — not have them pre-chewed and stored. Replaced by the chat-side
-- read_product(slug_or_url) tool that hits the WC REST API live.
--
-- Apply after 20260530_woo_products_description.sql.

SELECT cron.unschedule('woo-products-enrich-tick')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'woo-products-enrich-tick');

DROP INDEX IF EXISTS idx_woo_products_missing_description;
ALTER TABLE woo_products DROP COLUMN IF EXISTS description;
