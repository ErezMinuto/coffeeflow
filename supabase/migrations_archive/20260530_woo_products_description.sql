-- Minuto SEO Agent — long product descriptions for the catalog.
--
-- woo_products only carried short_description. The agent needs the FULL
-- product description (origin story, deep tasting notes, processing detail,
-- brew tips) so it can:
--   1) write articles that genuinely reference Minuto's products, not
--      generic educational content,
--   2) SEARCH across the full text (e.g. "anaerobic" / "co-fermentation"
--      may only appear in the long description, not in name/short_desc),
--   3) automatically learn about new products as they're added.
--
-- This adds a nullable `description` text column + a daily cron that
-- invokes the woo-products-enrich edge function to fetch long descriptions
-- from the WC REST API and upsert them. The existing product sync (which
-- writes name/price/short_description/etc.) is unaffected — the enricher
-- only touches the new column. NULL means "not yet fetched"; the next
-- enrich run picks it up.

ALTER TABLE woo_products ADD COLUMN IF NOT EXISTS description text;

-- Partial index to speed up "which products still need enriching" queries.
CREATE INDEX IF NOT EXISTS idx_woo_products_missing_description
  ON woo_products (woo_id)
  WHERE description IS NULL AND stock_status = 'instock';

-- ── Cron: woo-products-enrich-tick (daily 02:30 UTC) ──────────────────
-- Backfills description for any in-stock product where it's still NULL,
-- and refreshes the rest in chunks so they stay current. Edge runtime
-- bounds each invocation; the enricher works in pages and the cron just
-- runs daily — no rush.
SELECT cron.unschedule('woo-products-enrich-tick')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'woo-products-enrich-tick');

SELECT cron.schedule(
  'woo-products-enrich-tick',
  '30 2 * * *',  -- 02:30 UTC daily (off-peak)
  $$
    SELECT net.http_post(
      url := 'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/woo-products-enrich',
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := '{}'::jsonb,
      timeout_milliseconds := 150000
    );
  $$
);

-- ── Verify ────────────────────────────────────────────────────────────
--   SELECT count(*) FROM woo_products WHERE description IS NULL AND stock_status='instock';
--   -- After the first enrich run that count should drop substantially.
--   SELECT jobname, schedule, active FROM cron.job WHERE jobname='woo-products-enrich-tick';
