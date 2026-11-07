-- Minuto Organic Marketing — AI shopping-agent visibility probing.
--
-- Customers are increasingly asking AI agents (Claude, ChatGPT, Perplexity,
-- Gemini) shopping questions like "best Israeli specialty coffee roasters"
-- or "where to buy fresh espresso beans online in Israel". Whether Minuto
-- comes up in those responses is a new organic discovery channel — one
-- with no GSC equivalent.
--
-- This schema lets us periodically query a set of natural-language
-- shopping prompts against multiple LLM providers and parse each response
-- for Minuto mentions + competitor co-mentions. The orchestrator reads
-- the rolling mention rate per query and surfaces it to the strategist
-- as a new context block. The strategist proposes dynamic_experiment
-- tasks (e.g. 'add llms.txt', 'publish authoritative comparison piece')
-- to improve visibility, and the experiment loop's reinforcement
-- mechanism scores them — but using mention rate as the metric, not
-- GA4 conversions.
--
-- Two tables:
--   ai_visibility_queries   — curated list of prompts (admin-editable)
--   ai_visibility_probes    — raw probe responses + parsed mention flags

CREATE TABLE IF NOT EXISTS ai_visibility_queries (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  query           TEXT NOT NULL,           -- The exact prompt sent to the LLM
  language        TEXT NOT NULL DEFAULT 'he',  -- 'he' | 'en' | mixed
  category        TEXT NOT NULL,           -- 'discovery' | 'comparison' | 'brand_specific' | 'product_specific'
  active          BOOLEAN NOT NULL DEFAULT true,
  notes           TEXT,                    -- admin notes about why this query exists
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed queries. Mix of Hebrew + English, mix of discovery (Minuto NOT in
-- prompt) and brand-specific (Minuto in prompt). Discovery prompts measure
-- whether Minuto gets recommended; brand-specific prompts measure how
-- accurately the LLM knows about Minuto.
INSERT INTO ai_visibility_queries (query, language, category, notes) VALUES
  ('What are the best specialty coffee roasters in Israel?', 'en', 'discovery', 'High-level discovery prompt; Minuto should ideally be top 3-5'),
  ('Where can I buy fresh specialty espresso beans online in Israel?', 'en', 'discovery', 'Purchase-intent discovery; we want Minuto here'),
  ('Recommend a single-origin Ethiopian coffee for V60 brewing — Israel based.', 'en', 'product_specific', 'Specific product intent; tests if Minuto Yirgacheffe/Daye Bensa come up'),
  ('What are the best Israeli coffee brands for espresso machines like Lelit Mara?', 'en', 'product_specific', 'Equipment-bridge query; tests Minuto Intenso / Dark Chocolate'),
  ('מה החברות הטובות ביותר לקפה ספיישלטי בישראל?', 'he', 'discovery', 'Hebrew discovery — different LLM weights for non-English'),
  ('איפה לקנות פולי קפה טריים אונליין בישראל?', 'he', 'discovery', 'Hebrew purchase-intent'),
  ('המלץ לי על בית קלייה ישראלי לאספרסו', 'he', 'discovery', 'Hebrew espresso-focused discovery'),
  ('פולי קפה לחליטה ידנית V60 בישראל?', 'he', 'product_specific', 'Hebrew V60-specific'),
  ('What is Minuto Cafe?', 'en', 'brand_specific', 'Brand recognition probe — does the LLM know us at all?'),
  ('Is Minuto coffee good?', 'en', 'brand_specific', 'Brand-sentiment probe'),
  ('מה זה מינוטו קפה?', 'he', 'brand_specific', 'Hebrew brand recognition'),
  ('Best Israeli coffee subscription?', 'en', 'discovery', 'Subscription-intent discovery'),
  ('Compare Israeli specialty coffee roasters', 'en', 'comparison', 'Forces co-mention — see who Minuto gets compared against')
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS ai_visibility_probes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  query_id        UUID NOT NULL REFERENCES ai_visibility_queries(id) ON DELETE CASCADE,
  query_text      TEXT NOT NULL,           -- denormalized for cheap reads
  llm_provider    TEXT NOT NULL,           -- 'claude-sonnet-4-6' | 'perplexity-sonar' | 'gpt-4o' | 'gemini-2.5-flash'
  response_text   TEXT NOT NULL,           -- full LLM response (truncated to ~8KB)
  -- Parse results
  minuto_mentioned          BOOLEAN NOT NULL DEFAULT false,
  minuto_mention_count      INTEGER NOT NULL DEFAULT 0,
  minuto_mention_context    TEXT,          -- ±200 chars around the FIRST Minuto mention
  -- Competitors detected — array of competitor brand names found in response.
  -- Detection uses a static known-competitor list (see brand_voice_no_disparage
  -- memory note) + future Haiku-based dynamic extraction.
  competitors_mentioned     TEXT[] NOT NULL DEFAULT '{}',
  -- Position in response. Lower = mentioned earlier = better visibility.
  -- NULL when not mentioned. Computed from response_text.indexOf().
  minuto_position_chars     INTEGER,
  -- Response-level diagnostics
  response_tokens           INTEGER,
  cost_usd                  NUMERIC,
  error                     TEXT,
  ran_at                    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_visibility_probes_query_recent_idx
  ON ai_visibility_probes (query_id, ran_at DESC);

CREATE INDEX IF NOT EXISTS ai_visibility_probes_provider_recent_idx
  ON ai_visibility_probes (llm_provider, ran_at DESC);

-- For the orchestrator's mention-rate aggregator query.
CREATE INDEX IF NOT EXISTS ai_visibility_probes_recent_mentions_idx
  ON ai_visibility_probes (ran_at DESC) WHERE error IS NULL;

ALTER TABLE ai_visibility_queries ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_visibility_probes  ENABLE ROW LEVEL SECURITY;
