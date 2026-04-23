-- Doctor v2 — full data infrastructure for intelligent campaign analysis
--
-- Architecture principle (per user's direction):
--   SETTINGS tables    — rare updates, overwritten on manual trigger / daily cron
--   PERFORMANCE tables — fresh every doctor run, time-series where appropriate
--
-- With this split the doctor's data loading becomes a simple read from tables;
-- sync functions fill them, doctor just interprets.
--
-- All tables use CREATE IF NOT EXISTS + ALTER IF NOT EXISTS so re-applying
-- this migration is idempotent.

-- ============================================================================
-- SECTION 1 — GOOGLE ADS SETTINGS (rare updates)
-- ============================================================================

-- Account-level settings. One row per customer_id. Overwritten on settings sync.
CREATE TABLE IF NOT EXISTS google_account_settings (
  customer_id                  TEXT PRIMARY KEY,
  descriptive_name             TEXT,
  currency_code                TEXT,
  time_zone                    TEXT,
  auto_tagging_enabled         BOOLEAN,         -- CRITICAL: tells doctor whether gclid-based attribution is available
  conversion_tracking_status   TEXT,            -- CONVERSION_TRACKING_MANAGED_BY_GOOGLE_ADS | ANALYTICS | NONE
  has_enhanced_conversions     BOOLEAN,
  test_account                 BOOLEAN,
  manager                      BOOLEAN,
  linked_ga4_property_id       TEXT,            -- if linked, the GA4 property feeding conversions
  linked_merchant_center_id    TEXT,
  synced_at                    TIMESTAMPTZ DEFAULT NOW()
);

-- Ad group settings — per ad group config, not performance.
CREATE TABLE IF NOT EXISTS google_ad_group_settings (
  ad_group_id                  TEXT PRIMARY KEY,
  campaign_id                  TEXT NOT NULL,
  name                         TEXT,
  status                       TEXT,            -- ENABLED | PAUSED | REMOVED
  type                         TEXT,            -- SEARCH_STANDARD | DISPLAY_STANDARD | SHOPPING_PRODUCT_ADS | etc.
  cpc_bid_micros               BIGINT,
  target_cpa_micros            BIGINT,          -- if overriding campaign target
  target_roas                  NUMERIC,         -- if overriding campaign target
  audience_signals             JSONB,           -- user lists, in-market, affinity attached
  synced_at                    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_google_ag_settings_campaign ON google_ad_group_settings(campaign_id);

-- Audiences — user lists, remarketing, lookalike/similar. Reference data for
-- figuring out which audiences a campaign could target but isn't, and
-- detecting stale/small lists.
CREATE TABLE IF NOT EXISTS google_audiences (
  audience_id                  TEXT PRIMARY KEY,
  name                         TEXT,
  type                         TEXT,            -- CRM_BASED_USER_LIST | RULE_BASED_USER_LIST | LOOKALIKE | etc.
  description                  TEXT,
  size_for_search              BIGINT,          -- approx size usable on Search network
  size_for_display             BIGINT,
  membership_status            TEXT,            -- OPEN | CLOSED
  membership_life_span_days    INT,             -- how long users stay in the list
  synced_at                    TIMESTAMPTZ DEFAULT NOW()
);

-- Expand campaign settings beyond what's already stored (bidding/network/budget).
-- ad_schedule = dayparting, geo_targets = which regions the campaign serves,
-- device_modifiers = per-device bid adjustments. All as JSONB since shapes vary.
ALTER TABLE google_campaign_settings
  ADD COLUMN IF NOT EXISTS ad_schedule          JSONB,
  ADD COLUMN IF NOT EXISTS geo_targets          JSONB,
  ADD COLUMN IF NOT EXISTS device_modifiers     JSONB,
  ADD COLUMN IF NOT EXISTS final_url_suffix     TEXT,
  ADD COLUMN IF NOT EXISTS tracking_template    TEXT,
  ADD COLUMN IF NOT EXISTS frequency_cap_secs   JSONB,
  ADD COLUMN IF NOT EXISTS start_date           DATE,
  ADD COLUMN IF NOT EXISTS end_date             DATE;

-- ============================================================================
-- SECTION 2 — GOOGLE ADS PERFORMANCE (fresh on doctor run)
-- ============================================================================

-- Expand google_campaigns with impression-share metrics. These come from the
-- same GAQL campaign query we already run, just more SELECT fields — zero
-- extra API calls. Critical for the doctor's budget-cap logic.
ALTER TABLE google_campaigns
  ADD COLUMN IF NOT EXISTS search_impression_share              NUMERIC,
  ADD COLUMN IF NOT EXISTS search_budget_lost_impression_share  NUMERIC,
  ADD COLUMN IF NOT EXISTS search_rank_lost_impression_share    NUMERIC,
  ADD COLUMN IF NOT EXISTS search_top_impression_share          NUMERIC;

-- Keyword-level daily performance. We already store keyword_ideas (account-wide
-- top 150 keywords) but that's not per-campaign and lacks daily resolution.
-- This table enables: "which of MY keywords are wasting money in campaign X".
CREATE TABLE IF NOT EXISTS google_keywords_daily (
  campaign_id               TEXT NOT NULL,
  ad_group_id               TEXT NOT NULL,
  keyword_text              TEXT NOT NULL,
  match_type                TEXT,
  date                      DATE NOT NULL,
  impressions               BIGINT DEFAULT 0,
  clicks                    BIGINT DEFAULT 0,
  cost_micros               BIGINT DEFAULT 0,
  conversions               NUMERIC DEFAULT 0,
  conversion_value          NUMERIC DEFAULT 0,
  ctr                       NUMERIC,
  avg_cpc_micros            BIGINT,
  quality_score             INT,
  search_impression_share   NUMERIC,
  synced_at                 TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (campaign_id, ad_group_id, keyword_text, match_type, date)
);
CREATE INDEX IF NOT EXISTS idx_google_kw_daily_campaign ON google_keywords_daily(campaign_id, date);

-- Search terms report — the ACTUAL queries users typed (vs. the keywords we
-- bid on). The single richest dataset for finding wasteful negatives.
CREATE TABLE IF NOT EXISTS google_search_terms (
  campaign_id         TEXT NOT NULL,
  ad_group_id         TEXT NOT NULL,
  search_term         TEXT NOT NULL,
  triggering_keyword  TEXT,          -- which of our keywords triggered this search
  match_type          TEXT,          -- the match type that caught it
  date                DATE NOT NULL,
  impressions         BIGINT DEFAULT 0,
  clicks              BIGINT DEFAULT 0,
  cost_micros         BIGINT DEFAULT 0,
  conversions         NUMERIC DEFAULT 0,
  conversion_value    NUMERIC DEFAULT 0,
  status              TEXT,           -- ADDED | EXCLUDED | NONE
  synced_at           TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (campaign_id, ad_group_id, search_term, date)
);
CREATE INDEX IF NOT EXISTS idx_google_st_campaign_date ON google_search_terms(campaign_id, date);
CREATE INDEX IF NOT EXISTS idx_google_st_waste ON google_search_terms(campaign_id, conversions, cost_micros);

-- Ad-group-level daily performance. Bridges the gap between campaign daily
-- (already synced) and ad daily. Lets us answer "which ad group inside this
-- campaign is burning money with no conversions".
CREATE TABLE IF NOT EXISTS google_ad_group_daily (
  ad_group_id                TEXT NOT NULL,
  campaign_id                TEXT NOT NULL,
  ad_group_name              TEXT,
  date                       DATE NOT NULL,
  impressions                BIGINT DEFAULT 0,
  clicks                     BIGINT DEFAULT 0,
  cost_micros                BIGINT DEFAULT 0,
  conversions                NUMERIC DEFAULT 0,
  conversion_value           NUMERIC DEFAULT 0,
  ctr                        NUMERIC,
  search_impression_share    NUMERIC,
  synced_at                  TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (ad_group_id, date)
);
CREATE INDEX IF NOT EXISTS idx_google_ag_daily_campaign ON google_ad_group_daily(campaign_id, date);

-- Click-to-campaign mapping — THE fix for the La Marzocco attribution miss.
-- When WooCommerce captures a purchase with gclid=X, we look up here to find
-- which campaign/ad group the click came from. Rolling 90-day window.
CREATE TABLE IF NOT EXISTS google_click_mapping (
  gclid                 TEXT PRIMARY KEY,
  campaign_id           TEXT,
  ad_group_id           TEXT,
  keyword_text          TEXT,
  click_date            DATE,
  device                TEXT,            -- MOBILE | DESKTOP | TABLET
  synced_at             TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_gcm_campaign ON google_click_mapping(campaign_id);
CREATE INDEX IF NOT EXISTS idx_gcm_date ON google_click_mapping(click_date);

-- ============================================================================
-- SECTION 3 — META ADS SETTINGS (rare updates — mostly already covered)
-- ============================================================================

CREATE TABLE IF NOT EXISTS meta_account_settings (
  ad_account_id                TEXT PRIMARY KEY,
  name                         TEXT,
  currency                     TEXT,
  time_zone                    TEXT,
  business_id                  TEXT,
  pixel_id                     TEXT,
  amount_spent                 NUMERIC,           -- lifetime spend
  spend_cap                    NUMERIC,
  account_status               INT,               -- 1=active, 2=disabled, 3=unsettled, etc.
  funding_source               TEXT,
  synced_at                    TIMESTAMPTZ DEFAULT NOW()
);

-- meta_ad_adsets and meta_ads already exist from previous migration — those
-- ARE the settings layer (targeting, creative). No changes needed here.

-- ============================================================================
-- SECTION 4 — META ADS PERFORMANCE (fresh on doctor run)
-- ============================================================================

-- Ad-set daily insights — currently we only have campaign-level daily.
-- Adset-level shows which audience segments actually convert vs. burn budget.
CREATE TABLE IF NOT EXISTS meta_adset_daily (
  adset_id               TEXT NOT NULL,
  campaign_id            TEXT,
  date                   DATE NOT NULL,
  impressions            BIGINT DEFAULT 0,
  clicks                 BIGINT DEFAULT 0,
  spend                  NUMERIC DEFAULT 0,
  conversions            NUMERIC DEFAULT 0,
  cpm                    NUMERIC,
  cpc                    NUMERIC,
  ctr                    NUMERIC,
  frequency              NUMERIC,         -- avg impressions per user (fatigue signal)
  reach                  BIGINT,
  synced_at              TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (adset_id, date)
);
CREATE INDEX IF NOT EXISTS idx_meta_ad_daily_campaign ON meta_adset_daily(campaign_id, date);

-- Placement-level performance — is Instagram Feed converting or Reels burning
-- money? Critical for placement optimization decisions.
CREATE TABLE IF NOT EXISTS meta_placement_daily (
  adset_id               TEXT NOT NULL,
  campaign_id            TEXT,
  publisher_platform     TEXT,            -- facebook | instagram | audience_network | messenger
  platform_position      TEXT,            -- feed | stories | reels | explore | etc.
  date                   DATE NOT NULL,
  impressions            BIGINT DEFAULT 0,
  clicks                 BIGINT DEFAULT 0,
  spend                  NUMERIC DEFAULT 0,
  conversions            NUMERIC DEFAULT 0,
  synced_at              TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (adset_id, publisher_platform, platform_position, date)
);

-- Ad-level daily performance (separate from meta_ads which is creative settings)
CREATE TABLE IF NOT EXISTS meta_ad_daily (
  ad_id                  TEXT NOT NULL,
  adset_id               TEXT,
  campaign_id            TEXT,
  date                   DATE NOT NULL,
  impressions            BIGINT DEFAULT 0,
  clicks                 BIGINT DEFAULT 0,
  spend                  NUMERIC DEFAULT 0,
  conversions            NUMERIC DEFAULT 0,
  ctr                    NUMERIC,
  synced_at              TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (ad_id, date)
);
CREATE INDEX IF NOT EXISTS idx_meta_ad_daily_adset ON meta_ad_daily(adset_id, date);

-- ============================================================================
-- SECTION 5 — WOOCOMMERCE ENRICHMENT
-- ============================================================================

-- Add gclid to orders so we can attribute PMax / auto-tagging clicks.
ALTER TABLE woo_orders
  ADD COLUMN IF NOT EXISTS gclid TEXT;
CREATE INDEX IF NOT EXISTS idx_woo_orders_gclid ON woo_orders(gclid) WHERE gclid IS NOT NULL;

-- Order items, enriched with product category (coffee / machine / grinder /
-- accessory / other). Categorization is heuristic-based in woo-orders-sync
-- from product name patterns. Lets the doctor say "campaign X drives 80%
-- machine revenue, 15% coffee" — critical for the strategic goal of
-- shifting from 45% machine revenue toward more coffee.
CREATE TABLE IF NOT EXISTS woo_order_items_enriched (
  order_id                 BIGINT NOT NULL,
  line_index               INT    NOT NULL,       -- position within the order's line_items array
  product_name             TEXT,
  sku                      TEXT,
  product_category         TEXT,                   -- 'coffee' | 'machine' | 'grinder' | 'accessory' | 'other'
  quantity                 INT,
  line_total               NUMERIC,
  order_date               DATE,
  utm_source               TEXT,                   -- denormalized from woo_orders for fast per-category attribution
  utm_campaign             TEXT,
  gclid                    TEXT,
  synced_at                TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (order_id, line_index)
);
CREATE INDEX IF NOT EXISTS idx_woo_items_category ON woo_order_items_enriched(product_category);
CREATE INDEX IF NOT EXISTS idx_woo_items_utm ON woo_order_items_enriched(utm_source, utm_campaign);
CREATE INDEX IF NOT EXISTS idx_woo_items_gclid ON woo_order_items_enriched(gclid) WHERE gclid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_woo_items_date ON woo_order_items_enriched(order_date);
