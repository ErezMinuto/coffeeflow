-- MFlow sells → CoffeeFlow stock decrement (idempotency + audit).
--
-- CoffeeFlow products.packed_stock is the master for coffee-bag stock. Packing
-- (coffee-bot) increments it; sales must decrement it. Sales now happen in MFlow
-- (POS), so a periodic job pulls MFlow sells and applies the net bag movement to
-- packed_stock. This table records every sell we've already applied so re-runs
-- never double-count.
--
-- One row per MFlow sell id. coffee_delta is the signed per-product bag movement
-- we applied ({cf_product_id: qty}); a normal sale is negative, a return positive.

CREATE TABLE IF NOT EXISTS mflow_sell_events (
  mflow_sell_id    BIGINT PRIMARY KEY,          -- MFlow sells.id
  type             TEXT,                         -- MFlow sell type (e.g. 'sell')
  status           TEXT,                         -- sell_status (Completed / הוחזר / draft …)
  is_return        BOOLEAN NOT NULL DEFAULT FALSE,
  source           TEXT,                         -- sell_source (POS / …)
  transaction_date TIMESTAMPTZ,
  coffee_delta     JSONB NOT NULL DEFAULT '{}',  -- {cf_product_id: signed_qty} applied to packed_stock
  applied          BOOLEAN NOT NULL DEFAULT FALSE, -- false = seen but not stock-adjusted (draft/no-coffee)
  processed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS mflow_sell_events_date_idx ON mflow_sell_events (transaction_date DESC);

ALTER TABLE mflow_sell_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "mflow_sell_events_select" ON mflow_sell_events FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "mflow_sell_events_insert" ON mflow_sell_events FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY "mflow_sell_events_update" ON mflow_sell_events FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
