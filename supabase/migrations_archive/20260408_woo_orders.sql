-- WooCommerce Orders — one row per order, line items stored as JSONB
-- Synced by woo-orders-sync edge function

CREATE TABLE IF NOT EXISTS woo_orders (
  id            BIGSERIAL PRIMARY KEY,
  woo_order_id  INTEGER NOT NULL UNIQUE,
  order_date    DATE NOT NULL,
  status        TEXT NOT NULL,                   -- completed, processing, refunded…
  total         NUMERIC(10,2) NOT NULL DEFAULT 0,
  currency      TEXT NOT NULL DEFAULT 'ILS',
  items         JSONB NOT NULL DEFAULT '[]',     -- [{product_name, sku, quantity, subtotal}]
  customer_email TEXT,
  utm_source    TEXT,                            -- e.g. google, facebook
  utm_medium    TEXT,                            -- e.g. cpc, organic
  utm_campaign  TEXT,                            -- campaign name
  utm_content   TEXT,
  utm_term      TEXT,
  synced_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS woo_orders_date_idx    ON woo_orders (order_date DESC);
CREATE INDEX IF NOT EXISTS woo_orders_status_idx  ON woo_orders (status);

ALTER TABLE woo_orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "woo_orders_select" ON woo_orders FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "woo_orders_insert" ON woo_orders FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY "woo_orders_update" ON woo_orders FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
