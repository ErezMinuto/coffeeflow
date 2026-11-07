-- Abandoned-cart go-live floor.
--
-- Owner decision (2026-06-01): when abandoned-cart goes live we do NOT want
-- to email the pre-existing backlog of pending carts. The automation should
-- only ever remind about carts abandoned from the go-live date forward.
--
-- Without a floor this is impossible to avoid: cart_1 has a 4-day lookback
-- (cart_2 has 8), so the very first enabled cron tick would sweep in every
-- pending cart from the previous several days and blast them at once.
--
-- Fix: a per-template floor date. The scheduler's findAbandonedCartCandidates
-- drops any cart whose order_date is before not_before_date (compared by
-- store-local calendar date — matches "start from today's carts"). NULL
-- means no floor (first_purchase / refill_reminder leave it NULL and are
-- unaffected).
--
-- This statement is RESTRICTIVE only — it narrows who can ever be emailed.
-- It does NOT enable anything; both abandoned_cart templates stay
-- enabled=false until the owner explicitly flips them after copy review.
--
-- Idempotent.

ALTER TABLE email_automation_templates
  ADD COLUMN IF NOT EXISTS not_before_date date;

COMMENT ON COLUMN email_automation_templates.not_before_date IS
  'Abandoned-cart go-live floor: ignore carts whose order_date is before this date. NULL = no floor. Set per trigger_type.';

-- Start counting abandoned carts from 2026-06-01 (today). Carts abandoned
-- before this are ignored permanently; carts from today onward are eligible
-- once delay_days passes.
UPDATE email_automation_templates
  SET not_before_date = '2026-06-01'
  WHERE trigger_type IN ('abandoned_cart_1', 'abandoned_cart_2');

-- Verify:
--   SELECT trigger_type, enabled, not_before_date
--   FROM email_automation_templates
--   WHERE trigger_type LIKE 'abandoned_cart%';
