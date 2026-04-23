-- Meta Ads Audit — ad-set + ad snapshots for Campaign Doctor
--
-- Context: meta_ad_campaigns is daily time-series of insights, but targeting
-- and creative change rarely. We store ad-set and ad data as latest-state
-- snapshots (one row per entity) — overwritten on each sync. The doctor
-- needs the current audience + creative, not the daily history.

-- ── Ad sets (where targeting/audience lives) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS meta_ad_adsets (
  adset_id            TEXT PRIMARY KEY,
  campaign_id         TEXT NOT NULL,
  name                TEXT,
  status              TEXT,               -- ACTIVE | PAUSED | DELETED | ARCHIVED
  effective_status    TEXT,               -- ACTIVE | PAUSED | CAMPAIGN_PAUSED | IN_PROCESS | etc
  optimization_goal   TEXT,               -- OFFSITE_CONVERSIONS | LINK_CLICKS | REACH | etc
  billing_event       TEXT,               -- IMPRESSIONS | LINK_CLICKS | etc
  bid_strategy        TEXT,               -- LOWEST_COST_WITHOUT_CAP | COST_CAP | LOWEST_COST_WITH_BID_CAP | etc
  daily_budget        NUMERIC,            -- ILS (converted from minor units by sync)
  lifetime_budget     NUMERIC,            -- ILS
  budget_remaining    NUMERIC,            -- ILS
  targeting           JSONB,              -- full targeting spec: age, geo, interests, custom_audiences, behaviors, placements
  promoted_object     JSONB,              -- pixel_id, custom_event_type, page_id — what we're optimizing for
  destination_type    TEXT,               -- WEBSITE | MESSENGER | APP | ON_AD | INSTAGRAM_DIRECT
  learning_stage_info JSONB,              -- { status: LEARNING | SUCCESS | LIMITED, exit_reason?: string }
  created_time        TIMESTAMPTZ,
  updated_time        TIMESTAMPTZ,
  synced_at           TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_meta_ad_adsets_campaign ON meta_ad_adsets(campaign_id);
CREATE INDEX IF NOT EXISTS idx_meta_ad_adsets_status   ON meta_ad_adsets(effective_status);

-- ── Ads (creative level) ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS meta_ads (
  ad_id               TEXT PRIMARY KEY,
  adset_id            TEXT NOT NULL,
  campaign_id         TEXT NOT NULL,
  name                TEXT,
  status              TEXT,
  effective_status    TEXT,
  creative_id         TEXT,
  creative_type       TEXT,               -- IMAGE | VIDEO | CAROUSEL | SLIDESHOW | DYNAMIC
  title               TEXT,               -- headline
  body                TEXT,               -- primary text
  call_to_action      TEXT,               -- SHOP_NOW | LEARN_MORE | SIGN_UP | etc
  link_url            TEXT,
  image_url           TEXT,
  video_id            TEXT,
  created_time        TIMESTAMPTZ,
  updated_time        TIMESTAMPTZ,
  synced_at           TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_meta_ads_adset    ON meta_ads(adset_id);
CREATE INDEX IF NOT EXISTS idx_meta_ads_campaign ON meta_ads(campaign_id);
CREATE INDEX IF NOT EXISTS idx_meta_ads_status   ON meta_ads(effective_status);

-- ── Google Ads campaign settings (bidding + network) ─────────────────────────
-- google_campaigns is daily time-series; this is the latest-state config snapshot.
CREATE TABLE IF NOT EXISTS google_campaign_settings (
  campaign_id                 TEXT PRIMARY KEY,
  name                        TEXT,
  status                      TEXT,
  advertising_channel_type    TEXT,        -- SEARCH | PERFORMANCE_MAX | DISPLAY | VIDEO | SHOPPING
  bidding_strategy_type       TEXT,        -- MAXIMIZE_CONVERSIONS | TARGET_CPA | TARGET_ROAS | MANUAL_CPC | MAXIMIZE_CONVERSION_VALUE
  target_cpa_micros           BIGINT,      -- null unless TARGET_CPA
  target_roas                 NUMERIC,     -- null unless TARGET_ROAS
  target_search_network       BOOLEAN,     -- Search Partners expansion (silent budget drain)
  target_content_network      BOOLEAN,     -- Display expansion
  target_partner_search       BOOLEAN,
  daily_budget_micros         BIGINT,
  budget_delivery_method      TEXT,        -- STANDARD | ACCELERATED
  synced_at                   TIMESTAMPTZ DEFAULT NOW()
);

-- ── Google conversion action roles ──────────────────────────────────────────
-- Needed to detect soft-conversion-primary issue authoritatively instead of
-- heuristically. If "Add to cart" has primary_for_goal=true, that's the bug.
CREATE TABLE IF NOT EXISTS google_conversion_actions (
  action_id             TEXT PRIMARY KEY,
  name                  TEXT,
  category              TEXT,               -- PURCHASE | ADD_TO_CART | BEGIN_CHECKOUT | PAGE_VIEW | etc
  type                  TEXT,               -- WEBPAGE | GOOGLE_ANALYTICS_4_CUSTOM | UPLOAD_CLICKS | etc
  status                TEXT,
  primary_for_goal      BOOLEAN,            -- true = counted in "Conversions" column (bids on this)
  include_in_conversions BOOLEAN,
  counting_type         TEXT,               -- ONE_PER_CLICK | MANY_PER_CLICK
  attribution_model     TEXT,               -- DATA_DRIVEN | LAST_CLICK | FIRST_CLICK | etc
  value_type            TEXT,               -- DEFAULT | DIFFERENT_VALUES | NO_VALUE
  synced_at             TIMESTAMPTZ DEFAULT NOW()
);

-- ── Access ───────────────────────────────────────────────────────────────────
-- Matches the pattern used by meta_ad_campaigns / google_campaigns: no RLS.
-- Edge functions write via service_role (bypasses RLS anyway); the dashboard
-- reads via anon, which inherits schema-level grants from Supabase defaults.
-- If we later decide to turn RLS on globally, we'll do it in one migration
-- covering all ads tables at once to keep the pattern uniform.
