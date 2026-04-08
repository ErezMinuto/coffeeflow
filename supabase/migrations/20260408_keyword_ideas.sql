-- Google Keyword Planner data: Israeli coffee market demand
CREATE TABLE IF NOT EXISTS keyword_ideas (
  keyword            TEXT PRIMARY KEY,
  avg_monthly_searches BIGINT DEFAULT 0,
  competition        TEXT,           -- 'LOW' | 'MEDIUM' | 'HIGH' | 'UNSPECIFIED'
  competition_index  FLOAT DEFAULT 0, -- 0–100
  low_top_bid_micros BIGINT DEFAULT 0,
  high_top_bid_micros BIGINT DEFAULT 0,
  synced_at          TIMESTAMPTZ DEFAULT NOW()
);

-- RLS: shared org-wide table
ALTER TABLE keyword_ideas ENABLE ROW LEVEL SECURITY;
CREATE POLICY "shared_all" ON keyword_ideas
  FOR ALL TO anon, authenticated
  USING (true) WITH CHECK (true);

-- Index for fast ordered reads in marketing-advisor
CREATE INDEX IF NOT EXISTS keyword_ideas_monthly_searches_idx
  ON keyword_ideas (avg_monthly_searches DESC);
