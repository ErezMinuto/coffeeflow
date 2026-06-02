-- Drop the woo_order_id → woo_orders foreign key on email_automations.
--
-- Why this blocks abandoned-cart:
--   email_automations.woo_order_id was created with
--     woo_order_id INT REFERENCES woo_orders(woo_order_id)
--   (see 20260427_email_automations.sql line 114). That FK was harmless
--   for first_purchase + refill_reminder because both only ever reference
--   PAID orders, which woo-orders-sync stores in woo_orders.
--
--   Abandoned-cart is different by design: it nudges customers who placed
--   a PENDING order that was never paid. woo-orders-sync deliberately
--   syncs only completed+processing orders ("woo_orders = paid orders"
--   invariant), so a pending order id is NEVER in woo_orders. The
--   scheduler's INSERT-as-lock (email-automation-scheduler processAutomation)
--   therefore fails the FK with code 23503 (foreign_key_violation) before
--   a single email can send — every abandoned-cart candidate is silently
--   marked 'failed'.
--
-- Fix: drop the FK. woo_order_id stays as a plain INT — it is metadata
--   plus part of the uniq_automation_per_customer_per_order dedup key
--   (trigger_type, customer_email, woo_order_id), neither of which needs
--   referential integrity against woo_orders. first_purchase and
--   refill_reminder are unaffected (their woo_order_ids happen to exist
--   in woo_orders, but nothing depends on the constraint).
--
-- Idempotent. Postgres auto-named the inline FK email_automations_woo_order_id_fkey.

ALTER TABLE email_automations
  DROP CONSTRAINT IF EXISTS email_automations_woo_order_id_fkey;
