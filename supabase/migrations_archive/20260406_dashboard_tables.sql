-- OAuth tokens (one row per platform)
CREATE TABLE IF NOT EXISTS oauth_tokens (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform       TEXT NOT NULL UNIQUE,  -- 'meta' | 'google'
  access_token   TEXT NOT NULL,
  refresh_token  TEXT,
  expires_at     TIMESTAMPTZ,
  account_name   TEXT,
  account_id     TEXT,
  meta           JSONB DEFAULT '{}',
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

-- Meta organic posts
CREATE TABLE IF NOT EXISTS meta_organic_posts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id        TEXT NOT NULL UNIQUE,
  post_type      TEXT DEFAULT 'post',  -- 'post' | 'reel' | 'story'
  message        TEXT,
  created_at     TIMESTAMPTZ,
  reach          INT DEFAULT 0,
  impressions    INT DEFAULT 0,
  likes          INT DEFAULT 0,
  comments       INT DEFAULT 0,
  shares         INT DEFAULT 0,
  saves          INT DEFAULT 0,
  thumbnail_url  TEXT,
  synced_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Meta account daily insights
CREATE TABLE IF NOT EXISTS meta_daily_insights (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date           DATE NOT NULL UNIQUE,
  reach          INT DEFAULT 0,
  impressions    INT DEFAULT 0,
  follower_count INT DEFAULT 0,
  profile_views  INT DEFAULT 0,
  synced_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Meta ad campaigns
CREATE TABLE IF NOT EXISTS meta_ad_campaigns (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id    TEXT NOT NULL,
  date           DATE NOT NULL,
  name           TEXT,
  status         TEXT,
  objective      TEXT,
  spend          NUMERIC DEFAULT 0,
  impressions    INT DEFAULT 0,
  clicks         INT DEFAULT 0,
  cpm            NUMERIC DEFAULT 0,
  cpc            NUMERIC DEFAULT 0,
  ctr            NUMERIC DEFAULT 0,
  conversions    INT DEFAULT 0,
  synced_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(campaign_id, date)
);

-- Google Ads campaigns
CREATE TABLE IF NOT EXISTS google_campaigns (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id       TEXT NOT NULL,
  date              DATE NOT NULL,
  name              TEXT,
  status            TEXT,
  impressions       INT DEFAULT 0,
  clicks            INT DEFAULT 0,
  cost              NUMERIC DEFAULT 0,
  ctr               NUMERIC DEFAULT 0,
  cpc               NUMERIC DEFAULT 0,
  conversions       NUMERIC DEFAULT 0,
  conversion_value  NUMERIC DEFAULT 0,
  roas              NUMERIC DEFAULT 0,
  synced_at         TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(campaign_id, date)
);

-- Sync log
CREATE TABLE IF NOT EXISTS sync_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform    TEXT NOT NULL,
  status      TEXT NOT NULL,  -- 'success' | 'error'
  records     INT DEFAULT 0,
  error_msg   TEXT,
  started_at  TIMESTAMPTZ DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER oauth_tokens_updated_at
  BEFORE UPDATE ON oauth_tokens
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- RLS (Row Level Security) — enable for production
-- ALTER TABLE oauth_tokens ENABLE ROW LEVEL SECURITY;
