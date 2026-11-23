-- SEO agent build plan, Phase 1 ("eyes"): the data the strategist needs to
-- audit the whole site every week.
--
--   gsc_query_page       Search Console clicks/impressions per (search, page),
--                        summed over a window (28 days), current + previous.
--                        Ties every search to the page that ranks for it.
--   site_crawls          one row per weekly crawl of every sitemap URL
--   site_crawl_pages     what the crawl found on each page
--   page_speed           Google PageSpeed (lab + real-user field data) per page type
--   gsc_url_inspection   Google's own index status for the pages that earn money
--   strategic_briefs.seo_audit   the audit the strategist writes each week
--
-- Written by google-search-sync (service role) and the weekly GitHub job
-- .github/workflows/seo-audit-weekly.yml (service role). Admins read them in
-- the dashboard. Everything here describes public pages; no customer data.
-- Additive only.

-- ── Search Console per search + page ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.gsc_query_page (
  period_end   date    NOT NULL,          -- last day of the window
  period_days  integer NOT NULL CHECK (period_days BETWEEN 1 AND 90),
  query        text    NOT NULL,
  page         text    NOT NULL,
  clicks       integer NOT NULL DEFAULT 0,
  impressions  integer NOT NULL DEFAULT 0,
  ctr          real    NOT NULL DEFAULT 0,
  position     real    NOT NULL DEFAULT 0,
  synced_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (period_end, period_days, query, page)
);
CREATE INDEX IF NOT EXISTS gsc_query_page_page_idx ON public.gsc_query_page (page, period_end DESC);

-- ── Site crawl ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.site_crawls (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  status       text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed')),
  urls_total   integer,
  urls_ok      integer,
  urls_error   integer,
  robots_txt   text,                      -- the site's robots.txt as fetched
  sitemaps     jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{url, urls}]
  error        text
);

CREATE TABLE IF NOT EXISTS public.site_crawl_pages (
  crawl_id            uuid NOT NULL REFERENCES public.site_crawls(id) ON DELETE CASCADE,
  url                 text NOT NULL,      -- as listed in the sitemap (or found by a link)
  page_type           text,               -- home | product | category | post | page | other
  in_sitemap          boolean NOT NULL DEFAULT true,
  status              integer,            -- final HTTP status (0 = fetch failed)
  final_url           text,               -- after redirects
  redirects           integer NOT NULL DEFAULT 0,
  title               text,
  meta_description    text,
  h1                  text,
  h1_count            integer,
  canonical           text,
  robots_meta         text,               -- <meta name="robots">
  x_robots_tag        text,               -- X-Robots-Tag header
  lang                text,
  word_count          integer,            -- visible text in the main content
  schema_types        text[],             -- JSON-LD @type values
  internal_links      text[],             -- internal paths this page links to (deduped)
  external_links      integer,
  images              integer,
  images_missing_alt  integer,
  html_bytes          integer,
  response_ms         integer,
  error               text,
  fetched_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (crawl_id, url)
);

-- ── Page speed ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.page_speed (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  measured_at        timestamptz NOT NULL DEFAULT now(),
  url                text NOT NULL,
  page_type          text,
  strategy           text NOT NULL DEFAULT 'mobile' CHECK (strategy IN ('mobile', 'desktop')),
  performance_score  real,               -- 0..1 (Lighthouse lab)
  lcp_ms             integer,            -- lab
  cls                real,               -- lab
  tbt_ms             integer,            -- lab
  field_lcp_p75_ms   integer,            -- real users (Chrome UX Report), when Google has enough data
  field_inp_p75_ms   integer,
  field_cls_p75      real,
  field_category     text,               -- FAST | AVERAGE | SLOW (overall)
  error              text
);
CREATE INDEX IF NOT EXISTS page_speed_url_idx ON public.page_speed (url, measured_at DESC);

-- ── Google index status (URL Inspection API) ───────────────────────────────
CREATE TABLE IF NOT EXISTS public.gsc_url_inspection (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inspected_at      timestamptz NOT NULL DEFAULT now(),
  url               text NOT NULL,
  verdict           text,                -- PASS | NEUTRAL | FAIL | …
  coverage_state    text,                -- e.g. "Submitted and indexed"
  indexing_state    text,
  robots_txt_state  text,
  page_fetch_state  text,
  google_canonical  text,
  user_canonical    text,
  last_crawl_time   timestamptz,
  rich_results      jsonb,               -- detected rich result types + issues
  error             text
);
CREATE INDEX IF NOT EXISTS gsc_url_inspection_url_idx ON public.gsc_url_inspection (url, inspected_at DESC);

-- ── The strategist's weekly audit ───────────────────────────────────────────
ALTER TABLE public.strategic_briefs ADD COLUMN IF NOT EXISTS seo_audit jsonb NOT NULL DEFAULT '{}'::jsonb;

-- ── Access: admins read, functions/jobs write with the service role ────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['gsc_query_page', 'site_crawls', 'site_crawl_pages', 'page_speed', 'gsc_url_inspection'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_admin_read', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (public.is_admin())', t || '_admin_read', t);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon', t);
    EXECUTE format('GRANT SELECT ON TABLE public.%I TO authenticated', t);
    EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', t);
  END LOOP;
END $$;
