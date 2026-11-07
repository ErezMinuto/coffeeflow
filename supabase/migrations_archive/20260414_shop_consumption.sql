-- Track roasted coffee taken from the roastery to the coffee shop grinders.
-- Different from packing_logs: measured in grams, not bags, no recipe math.
-- Deducts directly from origins.roasted_stock or roast_profiles.roasted_stock.
CREATE TABLE IF NOT EXISTS shop_consumption_logs (
  id          BIGSERIAL PRIMARY KEY,
  user_id     TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('origin','profile')),
  source_id   BIGINT NOT NULL,
  source_name TEXT NOT NULL,
  grams       INTEGER NOT NULL CHECK (grams > 0),
  reported_by TEXT,
  taken_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS shop_consumption_logs_taken_at_idx
  ON shop_consumption_logs (taken_at DESC);

ALTER TABLE shop_consumption_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY scl_select ON shop_consumption_logs FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY scl_insert ON shop_consumption_logs FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY scl_update ON shop_consumption_logs FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY scl_delete ON shop_consumption_logs FOR DELETE TO anon, authenticated USING (true);
