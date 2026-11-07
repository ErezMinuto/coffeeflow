-- Pending Orders — pre-MFlow order tracking
CREATE TABLE IF NOT EXISTS pending_orders (
  id            BIGSERIAL PRIMARY KEY,
  user_id       TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  product_id    BIGINT,
  product_name  TEXT NOT NULL,
  quantity_bags INTEGER NOT NULL,
  expected_date DATE,
  status        TEXT NOT NULL DEFAULT 'pending',
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE pending_orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "shared_select" ON pending_orders FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "shared_insert" ON pending_orders FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY "shared_update" ON pending_orders FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "shared_delete" ON pending_orders FOR DELETE TO anon, authenticated USING (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON pending_orders TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE pending_orders_id_seq TO anon, authenticated;
