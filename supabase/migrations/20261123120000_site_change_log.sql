-- Site change log: every write the agent stack makes to the live site
-- (minuto.co.il), with the value it replaced, so any change can be undone.
-- SEO agent build plan, Phase 0 ("safety first").
--
-- One row per change. A row is also the approval request: the admin chat
-- can no longer write live content directly, it files a 'proposed' row that
-- the owner approves (or rejects) in the dashboard's approvals inbox.
--
--   proposed  → approved by the owner → applying (old value saved in `before`)
--             → applied, or failed (the site write errored; nothing changed)
--   proposed  → rejected
--   applied   → undone   (the undo itself is a new 'applied' row, undo_of = id)
--
-- Additive only: one new table, one new ops_profile row. Nothing existing
-- is altered.

CREATE TABLE IF NOT EXISTS public.site_change_log (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at     timestamptz NOT NULL DEFAULT now(),
  -- What was changed.
  target_type    text NOT NULL CHECK (target_type IN (
                   'post_faq',            -- FAQ block on a blog post (minuto-product-faq plugin)
                   'product_faq',         -- FAQ block on a WooCommerce product
                   'product_description', -- WooCommerce product long description
                   'post_content',        -- WordPress post title and/or body
                   'post_featured_image'  -- WordPress post featured_media
                 )),
  target_id      bigint NOT NULL,          -- WP post id / Woo product id
  target_url     text,
  target_title   text,
  -- The values. `before` is filled when the change is applied, read from the
  -- site just before writing. `after` is what was (or will be) written.
  before         jsonb,
  after          jsonb NOT NULL,
  before_source  text,                     -- how `before` was read (e.g. 'wp_rest', 'woo_rest', 'live_page')
  -- Who and why.
  source_fn      text NOT NULL,            -- edge function that wrote it
  requested_by   text,                     -- 'chat', 'strategist', an operator, …
  reason         text,
  approved_by    text,                     -- Clerk user id of the approver, or 'service' for operator calls
  approved_at    timestamptz,
  -- Lifecycle.
  status         text NOT NULL DEFAULT 'proposed'
                 CHECK (status IN ('proposed', 'applying', 'applied', 'rejected', 'failed', 'undone')),
  applied_at     timestamptz,
  error          text,
  reject_reason  text,
  undo_of        uuid REFERENCES public.site_change_log(id) ON DELETE RESTRICT,
  undone_at      timestamptz,
  undone_by      text,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS site_change_log_status_idx  ON public.site_change_log (status, created_at DESC);
CREATE INDEX IF NOT EXISTS site_change_log_target_idx  ON public.site_change_log (target_type, target_id, created_at DESC);

-- Admins read it in the dashboard. Every write goes through edge functions
-- with the service role (they also write to the site), so no write policy.
ALTER TABLE public.site_change_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS site_change_log_admin_read ON public.site_change_log;
CREATE POLICY site_change_log_admin_read ON public.site_change_log
  FOR SELECT TO authenticated USING (public.is_admin());

REVOKE ALL ON TABLE public.site_change_log FROM anon;
GRANT SELECT ON TABLE public.site_change_log TO authenticated;
GRANT ALL ON TABLE public.site_change_log TO service_role;

-- The twice-weekly content planner (organic-orchestrator) stops queueing blog
-- posts until the strategist owns SEO (build plan, Phase 4). Instagram and the
-- FAQ proposals keep running. Set "paused": false to turn blog posts back on.
INSERT INTO public.ops_profile (key, value, description)
VALUES ('seo_blog_planner', '{"paused": true}'::jsonb,
        'organic-orchestrator blog posts. paused=true until the strategist owns SEO (SEO agent build plan, Phase 4); Instagram and FAQ proposals keep running.')
ON CONFLICT (key) DO NOTHING;
