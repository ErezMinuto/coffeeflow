-- Voice-of-Customer + Psychology — data infrastructure
--
-- Purpose: collect the actual Hebrew language that Minuto's customers use
-- (questions, objections, praise, complaints) from every public source we
-- can access, then distill it into a structured "VoC library" that the
-- content + ad agents inject into their prompts.
--
-- Architecture:
--   RAW tables  — one row per source item (one IG comment, one review, etc.)
--                 Populated by sync extensions. Low-signal until distilled.
--   voc_insights — Claude-distilled patterns: objections, motivations,
--                 questions, emotional language. High-signal. Agents read
--                 from here.
--
-- Deliberate scope limit: we only capture PUBLIC customer language today
-- (comments, reviews, order notes). DMs are private and require additional
-- Meta app permissions we don't have (instagram_manage_messages,
-- pages_messaging) — planned for follow-up pending Meta app review.

-- ============================================================================
-- RAW COLLECTION — per-source tables
-- ============================================================================

-- Instagram post comments. Pulled via Graph API /{ig-media-id}/comments using
-- existing instagram_basic + pages_read_engagement permissions.
CREATE TABLE IF NOT EXISTS instagram_comments (
  comment_id          TEXT PRIMARY KEY,
  post_id             TEXT NOT NULL,
  text                TEXT,
  username            TEXT,
  like_count          INT,
  replies_count       INT,
  created_time        TIMESTAMPTZ,
  parent_comment_id   TEXT,                 -- for threaded replies
  synced_at           TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ig_comments_post ON instagram_comments(post_id);
CREATE INDEX IF NOT EXISTS idx_ig_comments_time ON instagram_comments(created_time DESC);

-- Facebook page post comments. Same pattern.
CREATE TABLE IF NOT EXISTS facebook_comments (
  comment_id          TEXT PRIMARY KEY,
  post_id             TEXT NOT NULL,
  message             TEXT,
  from_name           TEXT,
  from_id             TEXT,
  like_count          INT,
  comment_count       INT,                  -- nested replies count
  created_time        TIMESTAMPTZ,
  parent_comment_id   TEXT,
  synced_at           TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_fb_comments_post ON facebook_comments(post_id);
CREATE INDEX IF NOT EXISTS idx_fb_comments_time ON facebook_comments(created_time DESC);

-- Product reviews scraped from minuto.co.il. Most WooCommerce sites expose
-- reviews at /product/{slug}/ in HTML — we fetch and extract.
CREATE TABLE IF NOT EXISTS product_reviews (
  review_id           TEXT PRIMARY KEY,     -- composite: sku:author:date or DOM-derived id
  product_slug        TEXT,                  -- URL slug for the product
  product_name        TEXT,
  product_category    TEXT,                  -- reuse the category taxonomy from woo_order_items_enriched
  rating              INT,                   -- 1-5
  author              TEXT,
  title               TEXT,
  body                TEXT,
  verified_buyer      BOOLEAN,
  created_date        DATE,
  synced_at           TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_reviews_product ON product_reviews(product_slug);
CREATE INDEX IF NOT EXISTS idx_reviews_rating ON product_reviews(rating);

-- Google Business Profile reviews (when we can fetch them via Places or
-- Business Profile API). Single table since sources all produce the same shape.
CREATE TABLE IF NOT EXISTS google_business_reviews (
  review_id           TEXT PRIMARY KEY,     -- Google's review reference
  author_name         TEXT,
  rating              INT,                   -- 1-5
  text                TEXT,
  language            TEXT,
  created_time        TIMESTAMPTZ,
  synced_at           TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_google_biz_reviews_time ON google_business_reviews(created_time DESC);

-- Capture customer_note on orders. WooCommerce returns this field — it's
-- whatever the customer typed at checkout. Often the most raw pre-purchase
-- language we get: "הזמנתי בשביל אבא שלי שאוהב קפה חזק".
ALTER TABLE woo_orders
  ADD COLUMN IF NOT EXISTS customer_note TEXT;

-- ============================================================================
-- DISTILLED VoC LIBRARY — Claude-mined patterns
-- ============================================================================

-- Each row is a distilled insight: an objection, motivation, question,
-- trigger, praise pattern, or complaint. Pattern text is the canonical form;
-- example_phrases are the actual Hebrew quotes that led to this pattern.
CREATE TABLE IF NOT EXISTS voc_insights (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  insight_type        TEXT NOT NULL,         -- 'objection' | 'motivation' | 'question' | 'trigger' | 'praise' | 'complaint'
  pattern             TEXT NOT NULL,         -- canonical Hebrew phrasing of the pattern
  real_meaning        TEXT,                  -- what the customer is actually saying behind the words
  suggested_response  TEXT,                  -- how we should address it in copy
  frequency           INT DEFAULT 1,         -- how many raw quotes support this pattern
  example_phrases     JSONB DEFAULT '[]',    -- array of actual quotes
  customer_stage      TEXT,                  -- 'gateway' | 'discovery' | 'commitment' | 'mastery' | 'identity'
  product_context     TEXT,                  -- 'coffee' | 'machine' | 'grinder' | 'accessory' | 'general'
  source_breakdown    JSONB DEFAULT '{}',    -- { instagram_comments: 3, facebook_comments: 1, reviews: 2, order_notes: 1 }
  confidence          TEXT DEFAULT 'medium', -- 'high' | 'medium' | 'low'
  first_seen_at       TIMESTAMPTZ DEFAULT NOW(),
  last_mined_at       TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_voc_type ON voc_insights(insight_type);
CREATE INDEX IF NOT EXISTS idx_voc_stage ON voc_insights(customer_stage);
CREATE INDEX IF NOT EXISTS idx_voc_product ON voc_insights(product_context);
CREATE INDEX IF NOT EXISTS idx_voc_freq ON voc_insights(frequency DESC);

-- Mining audit — records each voc-mine run so we know what was processed
-- and when. Lets us re-mine incrementally (only new comments/reviews).
CREATE TABLE IF NOT EXISTS voc_mining_runs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at          TIMESTAMPTZ DEFAULT NOW(),
  finished_at         TIMESTAMPTZ,
  sources_processed   JSONB,                  -- { instagram_comments: 45, facebook_comments: 12, product_reviews: 8 }
  insights_created    INT DEFAULT 0,
  insights_updated    INT DEFAULT 0,
  error_msg           TEXT,
  status              TEXT DEFAULT 'running'  -- 'running' | 'success' | 'error'
);

-- ============================================================================
-- INSTAGRAM DMs — added once instagram_business_manage_messages is granted
-- ============================================================================
--
-- Data handling rules (Meta App Review compliance):
--   1. Raw messages retained for 30 days only (see purge cron in follow-up)
--   2. Aggregated insights extracted in voc_insights are retained
--   3. Sender usernames stripped before mining — voc_insights has no PII
--   4. Only admin dashboard users see aggregated insights — never raw DMs
--
-- The thread structure is stored separately from individual messages so we
-- can look at conversation-level patterns (long thread = engaged customer,
-- many short threads = repetitive inquiry types).

CREATE TABLE IF NOT EXISTS instagram_dm_threads (
  conversation_id     TEXT PRIMARY KEY,
  participant_id      TEXT,                   -- the customer's IG user id
  participant_username TEXT,                   -- PII: stripped before mining
  message_count       INT,
  unread_count        INT,
  last_message_time   TIMESTAMPTZ,
  first_synced_at     TIMESTAMPTZ DEFAULT NOW(),
  last_synced_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ig_dm_threads_last_msg ON instagram_dm_threads(last_message_time DESC);

CREATE TABLE IF NOT EXISTS instagram_dms (
  message_id          TEXT PRIMARY KEY,
  conversation_id     TEXT NOT NULL,
  sender_id           TEXT,                   -- either customer's or Minuto's IG id
  sender_username     TEXT,                   -- PII: stripped before mining
  is_from_minuto      BOOLEAN,                -- true if Minuto sent, false if customer
  message             TEXT,
  attachments         JSONB,                  -- media, shares, stickers — used only for completeness, not mined
  created_time        TIMESTAMPTZ,
  synced_at           TIMESTAMPTZ DEFAULT NOW(),
  purged              BOOLEAN DEFAULT FALSE   -- flip to TRUE and NULL out `message` after 30 days
);
CREATE INDEX IF NOT EXISTS idx_ig_dms_conversation ON instagram_dms(conversation_id);
CREATE INDEX IF NOT EXISTS idx_ig_dms_time ON instagram_dms(created_time DESC);
CREATE INDEX IF NOT EXISTS idx_ig_dms_unpurged ON instagram_dms(purged) WHERE purged = FALSE;
