-- Minuto Organic Marketing — industry-intelligence ingester.
--
-- Daily-pulled RSS articles from a curated list of marketing + coffee
-- industry sources, Claude-summarized into actionable insights for the
-- strategist. Decoupled from market_research (which is Meta Ad Library
-- competitor ads only) — this is broader content/news from the field.
--
-- Two tables:
--   1. industry_sources       — curated list of RSS feeds (admin-editable)
--   2. industry_articles      — one row per ingested article; deduped via UNIQUE(url)
--
-- The strategist reads from industry_articles (top-N most-recent OR
-- most-relevant per cycle), via a helper in services/. When an article
-- meaningfully shapes planning, the strategist references it in
-- self_reflection; admin can choose to record it as a durable best-practice
-- learning via the chat tool.

CREATE TABLE IF NOT EXISTS industry_sources (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,         -- 'Ahrefs Blog'
  rss_url     TEXT NOT NULL UNIQUE,  -- 'https://ahrefs.com/blog/feed/'
  category    TEXT NOT NULL,         -- 'marketing' | 'seo' | 'social' | 'coffee'
  active      BOOLEAN NOT NULL DEFAULT true,
  -- Per-source quality knob: cap how many articles per sync run we keep
  -- from this feed. Some feeds are noisy (10+ posts/day); marketing/SEO
  -- ones often quality-light. Default 5 per sync run per source.
  max_per_run INTEGER NOT NULL DEFAULT 5,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed the canonical sources. Admin can disable any by setting active=false.
INSERT INTO industry_sources (name, rss_url, category, max_per_run) VALUES
  ('Ahrefs Blog',          'https://ahrefs.com/blog/feed/',                       'seo',       3),
  ('Backlinko',            'https://backlinko.com/feed',                          'seo',       3),
  ('Search Engine Land',   'https://searchengineland.com/feed',                   'seo',       5),
  ('Animalz',              'https://www.animalz.co/blog/rss/',                    'marketing', 3),
  ('Buffer Blog',          'https://buffer.com/resources/rss/',                   'social',    3),
  ('Later Blog',           'https://later.com/blog/feed/',                        'social',    3),
  ('Sprudge',              'https://sprudge.com/feed',                            'coffee',    5),
  ('Perfect Daily Grind',  'https://perfectdailygrind.com/feed/',                 'coffee',    5),
  ('Cafe Imports Blog',    'https://www.cafeimports.com/north-america/blog/feed/', 'coffee',   3)
ON CONFLICT (rss_url) DO NOTHING;

CREATE TABLE IF NOT EXISTS industry_articles (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id       UUID NOT NULL REFERENCES industry_sources(id) ON DELETE CASCADE,
  source_name     TEXT NOT NULL,                  -- denormalized for cheap reads
  source_category TEXT NOT NULL,
  url             TEXT NOT NULL UNIQUE,           -- dedup key — never re-summarize same article
  title           TEXT NOT NULL,
  published_at    TIMESTAMPTZ,                    -- from RSS, may be null
  raw_content     TEXT,                           -- first ~5KB of article body; bigger = wasted storage
  -- Claude-generated. 2-4 sentences in English (strategist context language).
  -- Should be actionable: 'X argues Y about content marketing; relevant for
  -- Minuto because Z'. NOT a generic abstract.
  insight         TEXT,
  -- 0..1. Claude's self-rated relevance to Minuto's organic stack.
  -- Strategist only sees articles >= 0.5 by default to limit noise.
  relevance       NUMERIC,
  -- Tags surfaced by Claude for filtering: ['hook_design','seo_technical',
  -- 'instagram_growth','trend_alert','case_study']
  tags            TEXT[],
  summarized_at   TIMESTAMPTZ,                    -- null = pending summarization
  fetched_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS industry_articles_summarized_idx
  ON industry_articles (summarized_at DESC) WHERE summarized_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS industry_articles_relevance_idx
  ON industry_articles (relevance DESC, summarized_at DESC)
  WHERE summarized_at IS NOT NULL AND relevance IS NOT NULL;

CREATE INDEX IF NOT EXISTS industry_articles_pending_idx
  ON industry_articles (fetched_at) WHERE summarized_at IS NULL;

ALTER TABLE industry_sources  ENABLE ROW LEVEL SECURITY;
ALTER TABLE industry_articles ENABLE ROW LEVEL SECURITY;

-- Verify:
--   SELECT COUNT(*) FROM industry_sources WHERE active;  -- expect 9
--   SELECT COUNT(*) FROM industry_articles;              -- expect 0 initially
