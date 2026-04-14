-- Self-growing index of competitor Facebook Pages for Meta Ad Library research.
--
-- Rows get added two ways:
--   1. Seeded on migration with known Israeli specialty-coffee competitors.
--   2. Auto-discovered by runMarketResearch: any new hostname appearing in
--      Serper organic results gets its homepage scraped for a Facebook URL,
--      the vanity name is resolved to a numeric page_id via the Graph API,
--      and the row is inserted with discovery_source='serper_auto'.
--
-- runMarketResearch then queries Ad Library with search_page_ids=[...] over
-- every row where fb_page_id IS NOT NULL. Agents see ads from ANY brand the
-- research phase has discovered, without a code change.
CREATE TABLE IF NOT EXISTS competitor_pages (
  id                BIGSERIAL PRIMARY KEY,
  domain            TEXT UNIQUE,              -- e.g. "nahatcoffee.com" (nullable for seed entries without a known site)
  fb_vanity         TEXT,                     -- e.g. "Nachatcafe" — the path segment on facebook.com/...
  fb_page_id        TEXT,                     -- resolved numeric page ID (nullable until resolved)
  name              TEXT,                     -- human-readable competitor name
  discovery_source  TEXT NOT NULL DEFAULT 'seed', -- 'seed' | 'serper_auto' | 'manual'
  resolve_attempts  INT NOT NULL DEFAULT 0,   -- bounds the Graph API probes when a vanity won't resolve
  last_error        TEXT,                     -- last failure message (null if healthy)
  first_seen        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_checked      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS competitor_pages_fb_page_id_idx ON competitor_pages (fb_page_id) WHERE fb_page_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS competitor_pages_domain_idx     ON competitor_pages (domain)     WHERE domain IS NOT NULL;

ALTER TABLE competitor_pages ENABLE ROW LEVEL SECURITY;
CREATE POLICY cp_select ON competitor_pages FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY cp_insert ON competitor_pages FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY cp_update ON competitor_pages FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY cp_delete ON competitor_pages FOR DELETE TO anon, authenticated USING (true);

-- No seed. The table fills itself from Serper organic results on the first
-- market_research run. Any Israeli coffee brand ranking on קפה ספשלטי /
-- פולי קפה / etc. gets scraped for its Facebook vanity URL and added
-- automatically. Same pipeline handles new competitors that emerge later
-- without any code change.
