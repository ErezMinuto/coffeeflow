-- Cannibalization fixes: the SEO agent can propose merging a blog post into the
-- page that should win a search. A merge is a BUNDLE of logged, undoable steps
-- the owner approves, rejects and undoes as one:
--   1. (optional) post_content: a section carried over into the winning post
--   2. redirect: a 301 from the weaker post to the winning page
--      (minuto-product-faq v0.7.0; target_id = the weaker post, after = target URL, null = none)
--   3. post_status: the weaker post taken offline (publish → draft)
-- Additive only, safe to re-run:
--   * target_type gains 'redirect' and 'post_status' (every existing value stays allowed)
--   * bundle_id / bundle_seq: the steps of one merge, applied in bundle_seq order
--   * ops_profile 'seo_merge_proposals': the agent's switch, OFF until the owner turns it on

ALTER TABLE public.site_change_log DROP CONSTRAINT IF EXISTS site_change_log_target_type_check;
ALTER TABLE public.site_change_log ADD CONSTRAINT site_change_log_target_type_check CHECK (target_type IN (
  'post_faq', 'product_faq', 'product_description', 'post_content', 'post_featured_image',
  'seo_meta', 'term_seo_meta', 'term_description', 'product_status',
  'product_short_description', 'redirect', 'post_status'
));

ALTER TABLE public.site_change_log ADD COLUMN IF NOT EXISTS bundle_id uuid;
ALTER TABLE public.site_change_log ADD COLUMN IF NOT EXISTS bundle_seq smallint;
CREATE INDEX IF NOT EXISTS site_change_log_bundle_idx ON public.site_change_log (bundle_id) WHERE bundle_id IS NOT NULL;

INSERT INTO public.ops_profile (key, value, description)
VALUES ('seo_merge_proposals',
        '{"enabled": false}'::jsonb,
        'Cannibalization merges. enabled:true = the strategist may propose merging a weaker blog post into the page that should win a search (carry-over section, 301 redirect, post taken offline), as one bundle the owner approves, rejects or undoes in the approvals inbox. enabled:false = it may only retitle and link (propose_site_change / propose_internal_link). Needs minuto-product-faq v0.7.0 on the site.')
ON CONFLICT (key) DO NOTHING;
