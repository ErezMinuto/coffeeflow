-- Google Search Console — organic search performance per keyword per day
-- Synced via google-search-sync edge function

CREATE TABLE IF NOT EXISTS google_search_console (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date        DATE NOT NULL,
  keyword     TEXT NOT NULL,           -- the search query
  page        TEXT,                    -- landing page URL
  clicks      INT NOT NULL DEFAULT 0,
  impressions INT NOT NULL DEFAULT 0,
  ctr         FLOAT NOT NULL DEFAULT 0, -- 0.0 to 1.0
  position    FLOAT NOT NULL DEFAULT 0, -- avg position (1 = top)
  synced_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(date, keyword, page)
);

-- Index for common query patterns
CREATE INDEX IF NOT EXISTS gsc_date_idx     ON google_search_console (date DESC);
CREATE INDEX IF NOT EXISTS gsc_keyword_idx  ON google_search_console (keyword);
CREATE INDEX IF NOT EXISTS gsc_clicks_idx   ON google_search_console (clicks DESC);

-- RLS: org-wide shared table
ALTER TABLE google_search_console ENABLE ROW LEVEL SECURITY;

CREATE POLICY "gsc_shared_select" ON google_search_console
  FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY "gsc_shared_insert" ON google_search_console
  FOR INSERT TO anon, authenticated WITH CHECK (true);

CREATE POLICY "gsc_shared_update" ON google_search_console
  FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);

CREATE POLICY "gsc_shared_delete" ON google_search_console
  FOR DELETE TO anon, authenticated USING (true);
