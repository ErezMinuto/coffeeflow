-- Minuto — coffee-sales daily rollup cache.
--
-- Why this exists: the coffee-sales report (icount-admin `coffee_sales`) is
-- computed 100% live against iCount `doc/search`, one call per DAY per doctype.
-- Cost grows linearly with the range, so a multi-month report fans out hundreds
-- of slow calls and approaches the edge-function wall-clock ceiling.
--
-- Key insight: PAST invoices never change. A completed day's coffee totals are
-- immutable, so we compute each finished day ONCE, store the per-coffee rollup
-- here, and serve any range as a fast DB aggregate. Only "today" (Israel tz) is
-- ever recomputed live. This makes range length stop mattering.
--
-- Two tables:
--   coffee_sales_daily         — one row per (day, coffee sku): bags + net ex-VAT
--                                revenue for that day. The report SUMs across the
--                                range grouped by sku.
--   coffee_sales_daily_totals  — one row per computed day: doc_count + day totals.
--                                Doubles as the BACKFILL WATERMARK: a row here
--                                means "this day is computed" (even a zero-sales
--                                day gets a row), so the backfill knows what to skip.
--
-- Conventions match the strategist tables: gen-random PKs where relevant, RLS
-- enabled inline right after CREATE (so the SQL-editor RLS linter doesn't block a
-- multi-statement run), permissive anon/authenticated policies. The edge function
-- writes with the service-role key (bypasses RLS); policies exist so the dashboard
-- could read directly if ever needed.
--
-- Additive + idempotent. Safe to re-run.

CREATE TABLE IF NOT EXISTS coffee_sales_daily (
  day      DATE    NOT NULL,
  sku      TEXT    NOT NULL,
  name     TEXT,
  bags     NUMERIC NOT NULL DEFAULT 0,
  revenue  NUMERIC NOT NULL DEFAULT 0,   -- net, ex-VAT
  PRIMARY KEY (day, sku)
);
ALTER TABLE coffee_sales_daily ENABLE ROW LEVEL SECURITY;
-- range read: WHERE day BETWEEN from AND to
CREATE INDEX IF NOT EXISTS coffee_sales_daily_day_idx ON coffee_sales_daily (day);

CREATE TABLE IF NOT EXISTS coffee_sales_daily_totals (
  day           DATE PRIMARY KEY,
  doc_count     INTEGER NOT NULL DEFAULT 0,
  total_bags    NUMERIC NOT NULL DEFAULT 0,
  total_revenue NUMERIC NOT NULL DEFAULT 0,   -- net, ex-VAT
  computed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE coffee_sales_daily_totals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "csd_sel"  ON coffee_sales_daily        FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "csd_ins"  ON coffee_sales_daily        FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY "csd_upd"  ON coffee_sales_daily        FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "csd_del"  ON coffee_sales_daily        FOR DELETE TO anon, authenticated USING (true);
CREATE POLICY "csdt_sel" ON coffee_sales_daily_totals FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "csdt_ins" ON coffee_sales_daily_totals FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY "csdt_upd" ON coffee_sales_daily_totals FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
