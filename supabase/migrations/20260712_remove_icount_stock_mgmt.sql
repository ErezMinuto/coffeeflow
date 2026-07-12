-- Minuto — remove iCount STOCK / INVENTORY management.
--
-- Minuto stopped working with iCount for stock management (2026-07-12). This
-- unschedules the cron that auto-created iCount inventory items for new Woo
-- products (icount-admin `create_missing`). It was already unscheduled directly
-- in prod on 2026-07-12; this migration records that change so git matches prod.
--
-- What is INTENTIONALLY LEFT untouched:
--   • coffee-sales-backfill-nightly cron — the coffee-sales REPORT still reads
--     iCount sales documents; that report was kept.
--   • green-stock-alert-daily / coffeeflow-stock-check — green-coffee + Woo
--     stock checks; neither uses iCount inventory sync.
--   • icount_webhook_events / inventory_adjustments / product_sku_map tables —
--     kept (inventory_adjustments still audits manual stock edits + goods
--     receipt; product_sku_map still maps coffee-bag SKUs → products.packed_stock).
--
-- Idempotent: guarded unschedule. Safe to re-run.

SELECT cron.unschedule('icount-create-missing')
WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'icount-create-missing'
);

-- Verify (should return no rows):
--   SELECT jobname FROM cron.job WHERE jobname = 'icount-create-missing';
