-- Cache of blog posts published on minuto.co.il, auto-refreshed by the
-- marketing-advisor edge function during runMarketResearch. The organic
-- agent reads this table and refuses to recommend topics already covered.
--
-- Solves the "agent keeps re-recommending posts I already wrote" problem
-- without relying on the owner clicking ✓ in the triage queue.
CREATE TABLE IF NOT EXISTS minuto_blog_posts (
  id            BIGSERIAL PRIMARY KEY,
  url           TEXT UNIQUE NOT NULL,
  title         TEXT NOT NULL,
  published_at  TIMESTAMPTZ,
  description   TEXT,
  first_seen    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS minuto_blog_posts_published_idx
  ON minuto_blog_posts (published_at DESC NULLS LAST);

ALTER TABLE minuto_blog_posts ENABLE ROW LEVEL SECURITY;
CREATE POLICY mbp_select ON minuto_blog_posts FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY mbp_insert ON minuto_blog_posts FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY mbp_update ON minuto_blog_posts FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY mbp_delete ON minuto_blog_posts FOR DELETE TO anon, authenticated USING (true);
