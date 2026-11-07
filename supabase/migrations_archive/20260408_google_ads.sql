-- Google Ads creative table
-- Stores RSA (Responsive Search Ad) headlines + descriptions per ad
-- Synced by google-sync edge function alongside campaign metrics

CREATE TABLE IF NOT EXISTS google_ads (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ad_id         TEXT NOT NULL UNIQUE,
  ad_group_id   TEXT NOT NULL,
  ad_group_name TEXT,
  campaign_id   TEXT NOT NULL,
  campaign_name TEXT,
  status        TEXT,                   -- ENABLED, PAUSED, REMOVED
  ad_strength   TEXT,                   -- EXCELLENT, GOOD, AVERAGE, POOR, PENDING
  headlines     JSONB NOT NULL DEFAULT '[]',   -- ["כותרת 1", "כותרת 2", ...]
  descriptions  JSONB NOT NULL DEFAULT '[]',   -- ["תיאור 1", "תיאור 2"]
  final_urls    JSONB NOT NULL DEFAULT '[]',
  impressions   INT     DEFAULT 0,
  clicks        INT     DEFAULT 0,
  cost          NUMERIC DEFAULT 0,
  ctr           NUMERIC DEFAULT 0,
  conversions   NUMERIC DEFAULT 0,
  synced_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS google_ads_campaign_idx ON google_ads (campaign_id);
CREATE INDEX IF NOT EXISTS google_ads_status_idx   ON google_ads (status);

ALTER TABLE google_ads ENABLE ROW LEVEL SECURITY;
CREATE POLICY "shared_all" ON google_ads FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
