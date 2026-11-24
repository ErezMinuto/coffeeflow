-- Phase 2 (hands): four more kinds of live change the change log can record.
-- Widens the target_type check from 5 to 9 values. No row changes: every
-- existing value stays allowed. Safe to re-run.
--   seo_meta          Rank Math title / description / focus keyword on a post, page or product
--   term_seo_meta     the same on a product category
--   term_description  product category text (WooCommerce)
--   product_status    WooCommerce product status (publish / draft / pending / private)

ALTER TABLE public.site_change_log DROP CONSTRAINT IF EXISTS site_change_log_target_type_check;
ALTER TABLE public.site_change_log ADD CONSTRAINT site_change_log_target_type_check CHECK (target_type IN (
  'post_faq', 'product_faq', 'product_description', 'post_content', 'post_featured_image',
  'seo_meta', 'term_seo_meta', 'term_description', 'product_status'
));
