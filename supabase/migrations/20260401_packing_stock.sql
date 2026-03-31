-- Add packed_stock tracking to products
ALTER TABLE products ADD COLUMN IF NOT EXISTS packed_stock     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS min_packed_stock INTEGER NOT NULL DEFAULT 0;

-- Packing activity log
CREATE TABLE IF NOT EXISTS packing_logs (
  id                 BIGSERIAL PRIMARY KEY,
  user_id            TEXT NOT NULL,
  product_id         BIGINT,
  product_name       TEXT NOT NULL,
  bags_count         INTEGER NOT NULL,
  roasted_deducted   JSONB NOT NULL DEFAULT '[]',
  reported_by        TEXT,
  packed_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
