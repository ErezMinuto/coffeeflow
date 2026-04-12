-- Market research cache — stores daily competitor/trend scraping results
CREATE TABLE IF NOT EXISTS market_research (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  research_date   DATE NOT NULL,
  source          TEXT NOT NULL,        -- 'competitor_nahat' | 'competitor_agro' | 'competitor_jera' | 'google_suggest' | 'google_trends'
  raw_data        JSONB,
  summary         TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(research_date, source)
);

ALTER TABLE market_research ENABLE ROW LEVEL SECURITY;
CREATE POLICY market_research_select ON market_research FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY market_research_insert ON market_research FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY market_research_update ON market_research FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);

-- Advisor scores — user feedback on which competing strategist won
CREATE TABLE IF NOT EXISTS advisor_scores (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  week_start      DATE NOT NULL,
  winning_agent   TEXT NOT NULL,        -- 'strategist_aggressive' | 'strategist_precise'
  score           INT NOT NULL CHECK (score BETWEEN 1 AND 5),
  feedback_text   TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(week_start)
);

ALTER TABLE advisor_scores ENABLE ROW LEVEL SECURITY;
CREATE POLICY advisor_scores_select ON advisor_scores FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY advisor_scores_insert ON advisor_scores FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY advisor_scores_update ON advisor_scores FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
