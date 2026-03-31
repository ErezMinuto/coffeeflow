-- ============================================================
-- Campaign Events: Resend webhook tracking (opens, clicks, bounces)
-- ============================================================

-- 1. Campaign events table (populated by resend-webhook edge function)
CREATE TABLE IF NOT EXISTS campaign_events (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id          text NOT NULL,
  campaign_id      bigint REFERENCES campaigns(id) ON DELETE SET NULL,
  resend_email_id  text,
  event_type       text NOT NULL,  -- 'sent','delivered','opened','clicked','bounced','complained'
  recipient_email  text NOT NULL,
  event_data       jsonb,          -- link clicked, bounce reason, etc.
  created_at       timestamptz DEFAULT now()
);

ALTER TABLE campaign_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users see own campaign events" ON campaign_events
  FOR ALL USING (user_id = current_setting('request.jwt.claims', true)::json->>'sub');

-- Fast lookups by campaign + event type
CREATE INDEX IF NOT EXISTS idx_campaign_events_campaign
  ON campaign_events(campaign_id, event_type);

-- Dedup: prevent duplicate webhook events
CREATE INDEX IF NOT EXISTS idx_campaign_events_dedup
  ON campaign_events(resend_email_id, event_type);

-- 2. Add aggregate stat columns to campaigns table
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS open_count int DEFAULT 0;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS click_count int DEFAULT 0;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS bounce_count int DEFAULT 0;
