-- iCount → stock sync
-- Receives iCount document webhooks (invoice/receipt), captures the raw payload,
-- and (when enabled) decrements WooCommerce master stock for non-website sales.
--
-- Direction of truth:
--   WooCommerce = master inventory for ALL items.
--   iCount POS / back-office sale → decrement Woo stock_quantity (+ products.packed_stock for coffee).
--   Website sales are handled by WooCommerce natively and are NOT touched here
--     (detected via items'/doc's based_on_order being populated — validate before go-live).

-- ── 1. Raw webhook capture + idempotency ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS icount_webhook_events (
  id             BIGSERIAL PRIMARY KEY,
  icount_doc_id  TEXT NOT NULL UNIQUE,            -- composite "<doctype>-<docnum>", e.g. invrec-3000
  doctype        TEXT,
  docnum         TEXT,
  doc_date       DATE,
  total_with_vat NUMERIC(12,2),
  based_on_order TEXT,                            -- non-empty => order-derived (likely website) => skipped
  channel        TEXT,                            -- 'icount_direct' | 'order_based' (best-effort)
  raw_payload    JSONB NOT NULL,
  headers        JSONB,
  processed      BOOLEAN NOT NULL DEFAULT FALSE,  -- true once stock logic has run (idempotency guard)
  action_taken   TEXT,                            -- 'logged_only' | 'stock_updated' | 'ignored_order_based' | 'no_match' | 'error'
  note           TEXT,
  received_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS icount_webhook_events_received_idx  ON icount_webhook_events (received_at DESC);
CREATE INDEX IF NOT EXISTS icount_webhook_events_processed_idx ON icount_webhook_events (processed);

-- ── 2. Stock adjustment audit log ────────────────────────────────────────────
-- One row per SKU we changed (or would have changed, in log-only mode).
CREATE TABLE IF NOT EXISTS inventory_adjustments (
  id             BIGSERIAL PRIMARY KEY,
  source         TEXT NOT NULL DEFAULT 'icount',  -- 'icount' | 'coffee-bot' (future up-leg)
  icount_doc_id  TEXT,                            -- FK-ish back to icount_webhook_events.icount_doc_id
  sku            TEXT NOT NULL,
  description    TEXT,
  qty_delta      NUMERIC(12,3) NOT NULL,          -- negative = sale, positive = refund/production
  woo_product_id INTEGER,                         -- resolved WooCommerce product id (null if unmatched)
  woo_before     NUMERIC(12,3),                   -- Woo stock_quantity before
  woo_after      NUMERIC(12,3),                   -- Woo stock_quantity after (null if not written)
  packed_before  NUMERIC(12,3),                   -- products.packed_stock before (coffee only)
  packed_after   NUMERIC(12,3),
  applied         BOOLEAN NOT NULL DEFAULT FALSE,  -- false in log-only / flag-off mode
  note           TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS inventory_adjustments_doc_idx ON inventory_adjustments (icount_doc_id);
CREATE INDEX IF NOT EXISTS inventory_adjustments_sku_idx ON inventory_adjustments (sku);

-- ── 3. Map iCount SKUs → CoffeeFlow coffee bags (MANY-to-one) ─────────────────
-- A coffee bag is one physical unit per (bag, size), grind-agnostic. But the SKU
-- arriving on an iCount document may be the per-size SKU (POS) or a grind-variant
-- SKU (website, where the product stays a WooCommerce variable product). Mapping
-- many SKUs → one products row lets every variant resolve to the same packed_stock,
-- so we don't have to pin the catalog design before going live.
-- Non-coffee items (machines/accessories) have no row here and fall through to Woo.
CREATE TABLE IF NOT EXISTS product_sku_map (
  sku         TEXT PRIMARY KEY,           -- the SKU as it appears on the iCount line
  product_id  BIGINT NOT NULL,            -- → products.id (coffee bag); no FK: products predates migrations
  label       TEXT,                       -- human note, e.g. "Aristo 250g — espresso grind"
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS product_sku_map_product_idx ON product_sku_map (product_id);

-- ── 4. RLS — match the woo_orders pattern (anon + authenticated full access) ──
ALTER TABLE icount_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_adjustments  ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_sku_map        ENABLE ROW LEVEL SECURITY;

CREATE POLICY "product_sku_map_select" ON product_sku_map FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "product_sku_map_insert" ON product_sku_map FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY "product_sku_map_update" ON product_sku_map FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "product_sku_map_delete" ON product_sku_map FOR DELETE TO anon, authenticated USING (true);

CREATE POLICY "icount_webhook_events_select" ON icount_webhook_events FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "icount_webhook_events_insert" ON icount_webhook_events FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY "icount_webhook_events_update" ON icount_webhook_events FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);

CREATE POLICY "inventory_adjustments_select" ON inventory_adjustments FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "inventory_adjustments_insert" ON inventory_adjustments FOR INSERT TO anon, authenticated WITH CHECK (true);
