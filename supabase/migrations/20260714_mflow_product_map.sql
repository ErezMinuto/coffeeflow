-- MFlow product mapping cache.
--
-- The MFlow API rate limit is 30 requests / MINUTE. Resolving a coffee bag to its
-- MFlow product (via /products/ids) and reading its grind variations
-- (/products/{id}/variations/list) on every stock push would blow that cap for a
-- 20-bag catalog. Those facts are stable, so we cache them here: a periodic
-- "refresh" populates the map (paced), and the frequent stock push then needs
-- just ONE /stock/update call per bag.
--
-- One row per CoffeeFlow coffee product (products.id). kind + variation_ids drive
-- the /stock/update payload shape: 'single' pushes product.quantity; 'variable'
-- pushes quantity onto every listed active variation_id.

CREATE TABLE IF NOT EXISTS mflow_product_map (
  product_id        BIGINT PRIMARY KEY,             -- → products.id (coffee bag)
  mflow_product_id  BIGINT NOT NULL,                -- MFlow product id
  kind              TEXT   NOT NULL DEFAULT 'variable', -- 'single' | 'variable'
  variation_ids     JSONB  NOT NULL DEFAULT '[]',   -- active MFlow variation ids (variable only)
  matched_sku       TEXT,                           -- the SKU that resolved the match
  refreshed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS — match product_sku_map (anon + authenticated full access; edge fns use the
-- service role which bypasses RLS anyway).
ALTER TABLE mflow_product_map ENABLE ROW LEVEL SECURITY;
CREATE POLICY "mflow_product_map_select" ON mflow_product_map FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "mflow_product_map_insert" ON mflow_product_map FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY "mflow_product_map_update" ON mflow_product_map FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "mflow_product_map_delete" ON mflow_product_map FOR DELETE TO anon, authenticated USING (true);
