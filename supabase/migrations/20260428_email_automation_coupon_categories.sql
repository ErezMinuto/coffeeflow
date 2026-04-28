-- Restrict the welcome-email 10% coupon to coffee products only.
-- Owner explicitly chose allowlist over denylist:
--   "give 10% only on minuto specialty coffee"
-- The single category covers all SKUs eligible for the discount —
-- everything else (machines, grinders, accessories) won't get the
-- discount applied at checkout, even though the coupon code is on the
-- customer's account.
--
-- Stored as a slugs array (not category IDs) because:
--   • slugs are human-readable, owner can edit via Table Editor
--   • slugs are stable across WooCommerce reorganizations
--   • IDs are resolved at coupon-creation time via WC REST API
--
-- Idempotent: ALTER ... ADD COLUMN IF NOT EXISTS + UPDATE.

ALTER TABLE email_automation_templates
  ADD COLUMN IF NOT EXISTS coupon_product_category_slugs TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Resilience layer: cache the resolved WooCommerce category IDs once,
-- so subsequent coupons don't re-query and slug renames don't break us.
-- WC category IDs are stable across renames; the slug is just a label.
-- If the admin restructures categories (deletes / replaces), they can
-- empty this column to force re-resolution from slugs on the next run.
ALTER TABLE email_automation_templates
  ADD COLUMN IF NOT EXISTS coupon_product_category_ids INT[] NOT NULL DEFAULT ARRAY[]::INT[];

UPDATE email_automation_templates
SET coupon_product_category_slugs = ARRAY['פולי-קפה-טרי-מינוטו-specialty-coffee'],
    updated_at = NOW()
WHERE trigger_type = 'first_purchase';

COMMENT ON COLUMN email_automation_templates.coupon_product_category_slugs IS
  'Source-of-truth list of WooCommerce category slugs the coupon applies to. Resolved to IDs via WC REST API on first use, then cached in coupon_product_category_ids. Empty = no restriction.';

COMMENT ON COLUMN email_automation_templates.coupon_product_category_ids IS
  'Cached numeric IDs from resolving coupon_product_category_slugs. WC IDs are stable across slug renames so this stays valid. To force re-resolution after a category restructure: UPDATE ... SET coupon_product_category_ids = ARRAY[]::INT[].';
