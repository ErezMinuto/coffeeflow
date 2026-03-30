-- ============================================================
-- Marketing V2: Auto Campaign Generator + Automations
-- ============================================================

-- 1. WooCommerce product cache (for AI campaign generation)
CREATE TABLE IF NOT EXISTS woo_products (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id           text NOT NULL,
  woo_id            integer NOT NULL,
  name              text NOT NULL,
  slug              text,
  permalink         text,
  price             text,
  regular_price     text,
  sale_price        text,
  short_description text,
  image_url         text,
  image_urls        text[],
  categories        text[],
  stock_status      text DEFAULT 'instock',
  sku               text,
  synced_at         timestamptz DEFAULT now(),
  UNIQUE(user_id, woo_id)
);

ALTER TABLE woo_products ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users see own woo products" ON woo_products
  FOR ALL USING (user_id = current_setting('request.jwt.claims', true)::json->>'sub');

-- 2. Add campaign columns for auto-generation + Resend
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS campaign_type text DEFAULT 'manual';
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS product_ids text[];
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS preheader text;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS cta_text text;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS cta_url text;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS html_content text;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS sent_at timestamptz;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS error text;

-- 3. Automation email templates (write once, run forever)
CREATE TABLE IF NOT EXISTS automation_templates (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id         text NOT NULL,
  automation_type text NOT NULL,  -- 'welcome', 'cart_abandon', 'post_purchase_tips', 'post_purchase_reorder'
  subject         text NOT NULL,
  html_content    text NOT NULL,
  message         text,           -- plain text version for reference
  is_active       boolean DEFAULT true,
  delay_hours     integer DEFAULT 0,  -- hours after trigger to send
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now(),
  UNIQUE(user_id, automation_type)
);

ALTER TABLE automation_templates ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users see own automation templates" ON automation_templates
  FOR ALL USING (user_id = current_setting('request.jwt.claims', true)::json->>'sub');

-- 4. Automation logs (prevent duplicates, track sends)
CREATE TABLE IF NOT EXISTS automation_logs (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id          text NOT NULL,
  automation_type  text NOT NULL,
  recipient_email  text NOT NULL,
  trigger_data     jsonb,          -- order data, cart data, etc.
  status           text DEFAULT 'sent',  -- 'sent', 'failed', 'pending', 'skipped'
  error            text,
  scheduled_for    timestamptz,    -- for delayed sends
  sent_at          timestamptz,
  created_at       timestamptz DEFAULT now()
);

ALTER TABLE automation_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users see own automation logs" ON automation_logs
  FOR ALL USING (user_id = current_setting('request.jwt.claims', true)::json->>'sub');

-- Index for checking duplicate sends
CREATE INDEX IF NOT EXISTS idx_automation_logs_dedup
  ON automation_logs(user_id, automation_type, recipient_email, created_at DESC);

-- Index for pending scheduled sends
CREATE INDEX IF NOT EXISTS idx_automation_logs_pending
  ON automation_logs(status, scheduled_for) WHERE status = 'pending';
