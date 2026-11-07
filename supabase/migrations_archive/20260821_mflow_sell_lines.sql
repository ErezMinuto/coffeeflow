-- MFlow revenue ledger — one row per sell LINE.
--
-- WHY A SEPARATE TABLE FROM mflow_sell_events
-- mflow_sell_events is the stock ledger: it exists to make packed_stock
-- decrements idempotent, and its `applied` flag means "stock was adjusted".
-- Overloading it with money would tie revenue backfills to inventory writes,
-- and a backfill bug would then corrupt real stock. This table is written by a
-- code path that never touches products.packed_stock.
--
-- WHY LINES, NOT SELLS
-- The north-star is gross profit on BEANS. That needs per-SKU quantity and
-- price, which only exists at line level. Header totals can't answer "how many
-- 330g bags of Jungle moved this month".
--
-- KEY: (mflow_sell_id, line_id, is_return)
-- MFlow reuses ONE document id for a sale and its later return — it sets
-- return_parent_id and moves transaction_date on the SAME id. Keying on the id
-- alone means the return either overwrites the sale or is skipped entirely.
-- (That is a live, open bug on the stock side; this table is built not to
-- inherit it.)
CREATE TABLE IF NOT EXISTS mflow_sell_lines (
  mflow_sell_id      BIGINT      NOT NULL,
  line_id            BIGINT      NOT NULL,
  is_return          BOOLEAN     NOT NULL DEFAULT FALSE,

  transaction_date   TIMESTAMPTZ NOT NULL,
  sell_source        TEXT,                    -- raw MFlow value, e.g. 'POS', 'EcoSite (#82221)'
  channel            TEXT        NOT NULL,    -- normalised: pos | ecosite | back_office | other
  woocommerce_order_id BIGINT,                -- set on EcoSite rows; the join key back to woo_orders

  status             TEXT        NOT NULL,    -- raw MFlow status
  -- counted  = real revenue
  -- return   = real revenue, negative
  -- excluded = draft / הצעת מחיר (price quote) / בוטל (cancelled) / unknown
  -- Quotes and cancellations come from the SAME sells endpoint as real sales;
  -- summing without excluding them invents revenue that never happened.
  status_class       TEXT        NOT NULL CHECK (status_class IN ('counted','return','excluded')),

  sku                TEXT,
  mflow_product_id   BIGINT,
  variation_id       BIGINT,
  cf_product_id      BIGINT,                  -- CoffeeFlow products.id, NULL for non-coffee
  product_name       TEXT,
  variation_name     TEXT,                    -- carries the grind choice

  quantity           NUMERIC(12,3) NOT NULL DEFAULT 0,
  unit_price_exc_tax NUMERIC(12,4),
  discount_amount    NUMERIC(12,4) NOT NULL DEFAULT 0,
  item_tax           NUMERIC(12,4) NOT NULL DEFAULT 0,
  -- Revenue EXCLUDING VAT, signed (returns negative). Assumption baked in:
  -- discount_amount is per-line and ex-tax. The ingester's dry run reconciles
  -- the sum of these against the header's total_before_tax, so a wrong
  -- assumption surfaces as a reported mismatch instead of skewed revenue.
  line_revenue_exc_tax NUMERIC(14,4) NOT NULL DEFAULT 0,

  -- MFlow's own cost field. STORED FOR COMPARISON ONLY — never for margin.
  -- It is per-variation and largely unmaintained: of one bean product's six
  -- grind variations, one carried a real cost (22) and the other five simply
  -- equalled the sell price (58.47). Real COGS comes from CoffeeFlow's own
  -- calculateProductCost (green cost + roast weight-loss + gas + labour + bag).
  dpp_exc_tax        NUMERIC(12,4),

  -- Written on EVERY upsert, deliberately NOT via DEFAULT now(). A DEFAULT
  -- fires on INSERT only, so an id-keyed upsert freezes it and the freshness
  -- watchdog reports STALE while the sync is healthy. That exact false alarm
  -- has already happened once on meta_organic_posts.
  synced_at          TIMESTAMPTZ NOT NULL,

  PRIMARY KEY (mflow_sell_id, line_id, is_return)
);

-- Revenue rollups are always date-ranged and usually channel- or SKU-sliced.
CREATE INDEX IF NOT EXISTS mflow_sell_lines_date_idx
  ON mflow_sell_lines (transaction_date DESC) WHERE status_class <> 'excluded';
CREATE INDEX IF NOT EXISTS mflow_sell_lines_product_idx
  ON mflow_sell_lines (cf_product_id, transaction_date DESC) WHERE cf_product_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS mflow_sell_lines_channel_idx
  ON mflow_sell_lines (channel, transaction_date DESC);
CREATE INDEX IF NOT EXISTS mflow_sell_lines_woo_idx
  ON mflow_sell_lines (woocommerce_order_id) WHERE woocommerce_order_id IS NOT NULL;

-- Same org-wide shared RLS as the rest of the business tables.
ALTER TABLE mflow_sell_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY "mflow_sell_lines_select" ON mflow_sell_lines FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "mflow_sell_lines_insert" ON mflow_sell_lines FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY "mflow_sell_lines_update" ON mflow_sell_lines FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
