-- Add tracking_type column to woo_orders
-- Used to identify order origin: 'Tag', 'API' = real customer orders
-- 'Advanced Purchase Tracking (APT)' = mflow B2B invoices → should not exist here

ALTER TABLE woo_orders
  ADD COLUMN IF NOT EXISTS tracking_type TEXT;

-- Remove any mflow orders already synced by mistake
-- (orders where _wc_order_attribution_source_type = Advanced Purchase Tracking)
-- NOTE: these orders don't have tracking_type yet (column just added),
-- so deletion must be done by the user manually if they know the order IDs,
-- OR by re-running the sync which will no longer re-insert them.
-- The safest approach: delete all rows and do a fresh 60-day sync,
-- since the sync is incremental only from the latest stored date anyway.
-- Uncomment and run only if you want a clean slate:
-- TRUNCATE woo_orders;
