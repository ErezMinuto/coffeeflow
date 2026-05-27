-- Minuto SEO Agent — GA4 landing-page performance.
--
-- Populated daily by `ga4-sync` edge function. One row per
-- (date, page_path, channel_group) tuple — usually we only sync the
-- Organic Search channel since this feeds the SEO orchestrator, but
-- the schema accepts any channel so it's reusable for future use.
--
-- Why this schema vs raw GA4 events:
--   • Cheap reads from the orchestrator (single query, no aggregation)
--   • Channel filter on read so we can scope strategy by traffic source
--   • Conversion fields are GA4 "key event" counts + values (post-2024)
--
-- All additive. Safe to apply on prod.

CREATE TABLE IF NOT EXISTS ga4_pages_daily (
  date                  DATE        NOT NULL,
  page_path             TEXT        NOT NULL,
  channel_group         TEXT        NOT NULL DEFAULT 'Organic Search',

  -- Volume
  sessions              INTEGER     NOT NULL DEFAULT 0,
  active_users          INTEGER     NOT NULL DEFAULT 0,
  engaged_sessions      INTEGER     NOT NULL DEFAULT 0,
  screen_page_views     INTEGER     NOT NULL DEFAULT 0,

  -- Quality
  bounce_rate           NUMERIC,    -- 0.0–1.0
  avg_session_duration  NUMERIC,    -- seconds

  -- Outcome — GA4 "key events" are what conversions look like post-2024.
  -- conversions = COUNT of key events; conversion_value = SUM of their values.
  conversions           NUMERIC     NOT NULL DEFAULT 0,
  conversion_value      NUMERIC     NOT NULL DEFAULT 0,

  synced_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (date, page_path, channel_group)
);

-- Primary read path for the orchestrator: aggregate across last N days,
-- filter to Organic Search, sort by conversions DESC. Index covers it.
CREATE INDEX IF NOT EXISTS ga4_pages_daily_channel_date_idx
  ON ga4_pages_daily (channel_group, date DESC);

-- Secondary: page-level lookups across the date range (used when the
-- orchestrator wants to attribute a specific blog post's performance).
CREATE INDEX IF NOT EXISTS ga4_pages_daily_page_date_idx
  ON ga4_pages_daily (page_path, date DESC);

-- Service-role-only: ga4-sync writes via service_role which bypasses RLS.
-- RLS on with no policy = service role keeps full access, anon denied.
ALTER TABLE ga4_pages_daily ENABLE ROW LEVEL SECURITY;

-- Verify post-apply:
--   SELECT COUNT(*) FROM ga4_pages_daily;  -- expect 0
--   SELECT indexname FROM pg_indexes WHERE tablename='ga4_pages_daily';
