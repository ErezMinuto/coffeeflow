-- RFM customer segmentation — computed from woo_orders by the rfm-sync edge
-- function, refreshed nightly. Each customer (keyed by email) gets scored on
-- Recency, Frequency, Monetary using quintile rankings across all customers,
-- then assigned to a named segment for targeting.

CREATE TABLE IF NOT EXISTS customer_rfm (
  email             TEXT PRIMARY KEY,
  first_order_date  DATE    NOT NULL,
  last_order_date   DATE    NOT NULL,
  order_count       INTEGER NOT NULL,
  total_spent_ils   NUMERIC(10,2) NOT NULL,
  days_since_last   INTEGER NOT NULL,
  r_score           SMALLINT NOT NULL CHECK (r_score BETWEEN 1 AND 5),
  f_score           SMALLINT NOT NULL CHECK (f_score BETWEEN 1 AND 5),
  m_score           SMALLINT NOT NULL CHECK (m_score BETWEEN 1 AND 5),
  segment           TEXT NOT NULL,      -- champion|loyal|big_spender|at_risk|new|regular|lost
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS customer_rfm_segment_idx ON customer_rfm (segment);
CREATE INDEX IF NOT EXISTS customer_rfm_last_order_idx ON customer_rfm (last_order_date DESC);

ALTER TABLE customer_rfm ENABLE ROW LEVEL SECURITY;
CREATE POLICY crfm_select ON customer_rfm FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY crfm_insert ON customer_rfm FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY crfm_update ON customer_rfm FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY crfm_delete ON customer_rfm FOR DELETE TO anon, authenticated USING (true);

-- Seed the RFM contact groups so they're ready to use in the Marketing
-- dashboard immediately. rfm-sync will populate members on each run.
INSERT INTO contact_groups (name, description) VALUES
  ('rfm_champions',     'RFM: לקוחות VIP — קנו לאחרונה, הרבה, והרבה כסף. קהל לשיווק סאבסקריפשן + הפניות.'),
  ('rfm_loyal',         'RFM: לקוחות נאמנים — קונים באופן עקבי. טוב לאפסייל/בלנדים חדשים.'),
  ('rfm_big_spenders',  'RFM: לקוחות בעלי AOV גבוה אבל תדירות נמוכה. טוב למוצרי מתנה/פרמיום.'),
  ('rfm_at_risk',       'RFM: לקוחות שהיו טובים ועזבו — לא קנו מעל 60 יום למרות שהיו פעילים. יעד winback קריטי.'),
  ('rfm_new',           'RFM: לקוחות חדשים — הזמנה ראשונה ב-30 הימים האחרונים. לנרטר לקראת הזמנה שנייה.'),
  ('rfm_lost',          'RFM: לקוחות שאבדו — לא קנו מעל 6 חודשים. רוב הזמן לא שווה להוציא עליהם.')
ON CONFLICT DO NOTHING;
