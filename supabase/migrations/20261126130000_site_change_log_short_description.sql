-- Phase 2 (hands): one more kind of live change the change log can record.
-- Widens the target_type check from 9 to 10 values. No row changes: every
-- existing value stays allowed. Safe to re-run.
--   product_short_description  WooCommerce product short description (shown next to the price)

ALTER TABLE public.site_change_log DROP CONSTRAINT IF EXISTS site_change_log_target_type_check;
ALTER TABLE public.site_change_log ADD CONSTRAINT site_change_log_target_type_check CHECK (target_type IN (
  'post_faq', 'product_faq', 'product_description', 'post_content', 'post_featured_image',
  'seo_meta', 'term_seo_meta', 'term_description', 'product_status',
  'product_short_description'
));
