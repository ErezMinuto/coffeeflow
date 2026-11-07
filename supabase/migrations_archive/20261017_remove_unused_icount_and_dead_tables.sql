-- Minuto — remove iCount and dead tables (2026-10-17, PR #378).
--
-- Minuto no longer works with iCount at all. Stock is mastered in MFlow (which
-- syncs WooCommerce itself); coffee-bag stock lives in CoffeeFlow
-- products.packed_stock, decremented by stock-update `mflow_sync_sells`.
-- The code side (icount-admin, the coffee-sales report, the מלאי pages) is
-- removed in the same PR.
--
-- INTENTIONALLY KEPT:
--   • coffee_sales_daily + the bean_sales_daily view: the only record of bean
--     sales 2026-06-04..2026-07-12, when sales briefly ran through iCount. The
--     view unions it with MFlow so bean history has no Jun-Jul hole. Read-only
--     history now; nothing writes to it.
--   • inventory_adjustments (minus its iCount rows) + product_sku_map: live
--     audit + SKU map for the MFlow coffee-bag sync.
--   • advisor_scores / advisor_completed_actions: still referenced by the
--     deployed marketing-advisor; removed with that function's cleanup.
--
-- Order matters: unschedule the cron BEFORE icount-admin is deleted from prod.
-- Idempotent: guarded unschedule, IF EXISTS everywhere. The dropped data is not
-- recoverable. Apply to prod only after the PR is approved (dev has no base
-- schema).

BEGIN;

-- 1. iCount cron (called icount-admin nightly to fill the report cache).
SELECT cron.unschedule('coffee-sales-backfill-nightly')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'coffee-sales-backfill-nightly');

-- 2. iCount data.
DROP TABLE IF EXISTS public.coffee_sales_daily_totals;   -- report cache; report removed
DROP TABLE IF EXISTS public.icount_webhook_events;       -- raw iCount webhook log
DELETE FROM public.inventory_adjustments WHERE source = 'icount';
DROP INDEX IF EXISTS public.inventory_adjustments_doc_idx;
ALTER TABLE public.inventory_adjustments DROP COLUMN IF EXISTS icount_doc_id;

-- 3. Tables nothing reads or writes.
DROP TABLE IF EXISTS public.automation_logs;       -- marketing v1; superseded by email_automations
DROP TABLE IF EXISTS public.automation_templates;  -- superseded by email_automation_templates
DROP TABLE IF EXISTS public.mflow_product_map;     -- MFlow stock push removed 2026-08-25
DROP TABLE IF EXISTS public.purchases;             -- empty; never used
DROP TABLE IF EXISTS public.roasting_sessions;     -- 2 test rows from 2026-03; superseded by roasts
DROP TABLE IF EXISTS public.my_table;              -- empty scratch table

-- 4. Rollback snapshot from 20260920_cron_worker_pressure.sql. It copies cron
--    commands, so it holds auth headers; that change has long settled.
DROP TABLE IF EXISTS ops.cron_job_backup_20260920;

-- 5. RPCs never called.
DROP FUNCTION IF EXISTS public.upsert_own_user_info(text, text);
DROP FUNCTION IF EXISTS public.cron_last_run_for_job(text);

COMMIT;

-- Verify (all should return no rows):
--   SELECT jobname FROM cron.job WHERE jobname = 'coffee-sales-backfill-nightly';
--   SELECT 1 FROM inventory_adjustments WHERE source = 'icount';
--   SELECT relname FROM pg_class WHERE relname IN ('coffee_sales_daily_totals','icount_webhook_events',
--     'automation_logs','automation_templates','mflow_product_map','purchases','roasting_sessions',
--     'my_table','cron_job_backup_20260920');
-- And this should still work (Jun-Jul history intact):
--   SELECT source, count(*) FROM bean_sales_daily GROUP BY 1;
