-- Metrics layer: one definition for every marketing number.
--
-- WHY: until now each agent and dashboard page computed its own numbers, five
-- different "revenue" definitions among them (Woo order totals with VAT, Woo
-- lines, MFlow ex-VAT, iCount coffee-only, Google's reported conversion
-- value), and ad conversions inflated 6-12x. The strategist graded its
-- theses on web revenue alone, about 7.6% of the business.
--
-- DEFINITIONS (decided by the owner, 2026-10-10)
--   Revenue    MFlow (mflow_revenue), ex-VAT, returns netted (MFlow signs them
--              negative). All channels: pos (café), ecosite (web),
--              back_office (B2B). This is the north star.
--   Purchase   A real web order: an MFlow ecosite sale with a WooCommerce id.
--              Ad-platform "conversions" are diagnostics only.
--   Attribution  gclid → google_click_mapping, then utm_campaign matched to a
--              campaign id or name. Anything else is UNATTRIBUTED and shown as
--              such. No spend-share estimates.
--   Paid ROAS  attributed web revenue ÷ spend. Web only: café and B2B sales
--              cannot be tied to a click.
--   Days       Asia/Jerusalem calendar days.
--
-- Everything here is a view or a STABLE function over existing tables; it
-- stores nothing and needs no sync.

-- ── helpers ────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION mx_norm(t text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT nullif(trim(regexp_replace(lower(coalesce(t, '')), '[_[:space:]|-]+', ' ', 'g')), '')
$$;

-- ── 1. revenue by day and channel (the north star) ────────────────────────

CREATE OR REPLACE VIEW mx_revenue_daily
WITH (security_invoker = true) AS
SELECT
  (transaction_date AT TIME ZONE 'Asia/Jerusalem')::date                AS day,
  channel,                                                              -- pos | ecosite | back_office | other
  round(sum(line_revenue_exc_tax), 2)                                   AS revenue_ex_vat,
  round(sum(line_revenue_exc_tax) FILTER (WHERE is_return), 2)          AS returns_ex_vat,
  count(DISTINCT mflow_sell_id) FILTER (WHERE NOT is_return)            AS sales
FROM mflow_revenue
GROUP BY 1, 2;

COMMENT ON VIEW mx_revenue_daily IS
  'THE revenue number. MFlow, ex-VAT, returns netted, per Israel day and channel '
  '(pos=café, ecosite=web, back_office=B2B). Use this for any revenue figure.';

-- ── 2. campaign directory (latest name per campaign) ──────────────────────

CREATE OR REPLACE VIEW mx_campaigns
WITH (security_invoker = true) AS
SELECT DISTINCT ON (platform, campaign_id) platform, campaign_id, name
FROM (
  SELECT 'google'::text AS platform, campaign_id, name, date FROM google_campaigns
  UNION ALL
  SELECT 'meta'::text,               campaign_id, name, date FROM meta_ad_campaigns
) c
ORDER BY platform, campaign_id, date DESC;

-- ── 3. web orders with their attribution ──────────────────────────────────

CREATE OR REPLACE VIEW mx_web_orders
WITH (security_invoker = true) AS
WITH sales AS (
  SELECT woocommerce_order_id,
         min((transaction_date AT TIME ZONE 'Asia/Jerusalem')::date) AS day,
         round(sum(line_revenue_exc_tax), 2)                         AS revenue_ex_vat
  FROM mflow_revenue
  WHERE channel = 'ecosite' AND woocommerce_order_id IS NOT NULL
  GROUP BY woocommerce_order_id
),
o AS (
  SELECT s.woocommerce_order_id AS woo_order_id, s.day, s.revenue_ex_vat,
         w.customer_email, w.utm_source, w.utm_medium, w.utm_campaign, w.gclid,
         w.tracking_type,
         lower(coalesce(w.utm_source, ''))  AS src,
         lower(coalesce(w.utm_medium, ''))  AS med,
         (w.woo_order_id IS NULL)           AS missing_woo_row
  FROM sales s
  LEFT JOIN woo_orders w ON w.woo_order_id = s.woocommerce_order_id
),
classified AS (
  SELECT o.*,
    CASE
      WHEN gclid IS NOT NULL
        OR (src LIKE '%google%' AND med ~ '(cpc|ppc|paid|pmax|shopping)')        THEN 'google_ads'
      WHEN src ~ '(facebook|^fb$|instagram|^ig$|meta)'
        AND med ~ '(cpc|cpm|paid|ads?$|paid_social)'                              THEN 'meta_ads'
      WHEN src = 'email' OR med = 'email'                                        THEN 'email'
      WHEN tracking_type = 'organic'                                             THEN 'organic_search'
      WHEN src ~ '(facebook|^fb$|instagram|^ig$|meta)'                           THEN 'social'
      WHEN tracking_type = 'referral'                                            THEN 'referral'
      WHEN tracking_type = 'typein'                                              THEN 'direct'
      ELSE 'other'
    END AS source_group
  FROM o
)
SELECT
  c.woo_order_id, c.day, c.revenue_ex_vat, c.customer_email,
  c.source_group,                         -- google_ads | meta_ads | email | organic_search | social | referral | direct | other
  c.utm_source, c.utm_medium, c.utm_campaign, c.gclid, c.missing_woo_row,
  CASE c.source_group WHEN 'google_ads' THEN 'google' WHEN 'meta_ads' THEN 'meta' END AS ad_platform,
  coalesce(gm.campaign_id, byid.campaign_id, byname.campaign_id)       AS campaign_id,
  CASE
    WHEN gm.campaign_id     IS NOT NULL THEN 'gclid'
    WHEN byid.campaign_id   IS NOT NULL THEN 'utm_campaign_id'
    WHEN byname.campaign_id IS NOT NULL THEN 'utm_campaign_name'
    WHEN c.source_group IN ('google_ads','meta_ads') THEN 'unattributed'
  END                                                                   AS attribution
FROM classified c
LEFT JOIN google_click_mapping gm
       ON c.source_group = 'google_ads' AND gm.gclid = c.gclid
LEFT JOIN mx_campaigns byid
       ON gm.campaign_id IS NULL
      AND c.source_group IN ('google_ads','meta_ads')
      AND byid.platform = CASE c.source_group WHEN 'google_ads' THEN 'google' ELSE 'meta' END
      AND byid.campaign_id = trim(c.utm_campaign)
LEFT JOIN LATERAL (
  SELECT k.campaign_id FROM mx_campaigns k
  WHERE gm.campaign_id IS NULL AND byid.campaign_id IS NULL
    AND c.source_group IN ('google_ads','meta_ads')
    AND k.platform = CASE c.source_group WHEN 'google_ads' THEN 'google' ELSE 'meta' END
    AND mx_norm(k.name) = mx_norm(c.utm_campaign)
  ORDER BY k.campaign_id LIMIT 1
) byname ON true;

COMMENT ON VIEW mx_web_orders IS
  'One row per real web order (MFlow ecosite, ex-VAT) with its traffic source and, '
  'for paid traffic, the campaign it is attributed to (gclid, then utm_campaign as '
  'id or name). attribution = unattributed means paid traffic we could not place.';

-- ── 4. paid spend per day and campaign ────────────────────────────────────

CREATE OR REPLACE VIEW mx_paid_daily
WITH (security_invoker = true) AS
SELECT 'google'::text AS platform, campaign_id, name, date AS day,
       coalesce(cost, 0)          AS spend,
       coalesce(clicks, 0)        AS clicks,
       coalesce(impressions, 0)   AS impressions,
       primary_conversions        AS platform_purchases,   -- Google's own count; diagnostic only
       primary_conversion_value   AS platform_value
FROM google_campaigns
UNION ALL
SELECT 'meta', campaign_id, name, date,
       coalesce(spend, 0), coalesce(clicks, 0), coalesce(impressions, 0),
       purchases, purchase_value
FROM meta_ad_campaigns;

-- ── 5. summaries the agents and dashboard call ────────────────────────────

-- Paid performance per campaign over a window, plus one UNATTRIBUTED row per
-- platform with the paid orders no campaign could claim.
CREATE OR REPLACE FUNCTION mx_paid_summary(p_days int DEFAULT 14, p_end date DEFAULT NULL)
RETURNS TABLE (
  platform text, campaign_id text, name text,
  spend numeric, clicks bigint, impressions bigint, platform_purchases numeric,
  orders bigint, revenue_ex_vat numeric, real_roas numeric, real_cpa numeric
)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  WITH bounds AS (
    SELECT coalesce(p_end, (now() AT TIME ZONE 'Asia/Jerusalem')::date)            AS d1,
           coalesce(p_end, (now() AT TIME ZONE 'Asia/Jerusalem')::date) - (p_days - 1) AS d0
  ),
  spend AS (
    SELECT p.platform, p.campaign_id,
           sum(p.spend) AS spend, sum(p.clicks)::bigint AS clicks,
           sum(p.impressions)::bigint AS impressions,
           sum(p.platform_purchases) AS platform_purchases
    FROM mx_paid_daily p, bounds b
    WHERE p.day BETWEEN b.d0 AND b.d1
    GROUP BY 1, 2
  ),
  sales AS (
    SELECT w.ad_platform AS platform, w.campaign_id,
           count(*)::bigint AS orders, sum(w.revenue_ex_vat) AS revenue
    FROM mx_web_orders w, bounds b
    WHERE w.ad_platform IS NOT NULL AND w.day BETWEEN b.d0 AND b.d1
    GROUP BY 1, 2
  )
  SELECT coalesce(s.platform, a.platform)          AS platform,
         coalesce(s.campaign_id, a.campaign_id)    AS campaign_id,
         CASE WHEN coalesce(s.campaign_id, a.campaign_id) IS NULL THEN '(unattributed)'
              ELSE k.name END                      AS name,
         round(s.spend, 2), s.clicks, s.impressions, s.platform_purchases,
         coalesce(a.orders, 0),
         round(coalesce(a.revenue, 0), 2),
         CASE WHEN s.spend > 0 THEN round(coalesce(a.revenue, 0) / s.spend, 2) END,
         CASE WHEN coalesce(a.orders, 0) > 0 AND s.spend > 0 THEN round(s.spend / a.orders, 2) END
  FROM spend s
  FULL JOIN sales a ON a.platform = s.platform AND a.campaign_id IS NOT DISTINCT FROM s.campaign_id
  LEFT JOIN mx_campaigns k
         ON k.platform = coalesce(s.platform, a.platform)
        AND k.campaign_id = coalesce(s.campaign_id, a.campaign_id)
  WHERE coalesce(s.spend, 0) > 0 OR coalesce(a.orders, 0) > 0
  ORDER BY 1, s.spend DESC NULLS LAST
$$;

COMMENT ON FUNCTION mx_paid_summary IS
  'Per-campaign spend vs attributed web revenue (MFlow ex-VAT) for the last p_days '
  'ending p_end (default today, Israel). Rows with campaign_id NULL are paid orders '
  'no campaign could claim. real_roas is attributed revenue ÷ spend.';

-- Revenue by channel for a window and the window before it, for trend.
CREATE OR REPLACE FUNCTION mx_revenue_summary(p_days int DEFAULT 30, p_end date DEFAULT NULL)
RETURNS TABLE (channel text, revenue_ex_vat numeric, sales bigint,
               prev_revenue_ex_vat numeric, prev_sales bigint, change_pct numeric)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  WITH b AS (
    SELECT coalesce(p_end, (now() AT TIME ZONE 'Asia/Jerusalem')::date) AS d1
  ),
  cur AS (
    SELECT r.channel, sum(r.revenue_ex_vat) AS rev, sum(r.sales)::bigint AS sales
    FROM mx_revenue_daily r, b WHERE r.day BETWEEN b.d1 - (p_days - 1) AND b.d1 GROUP BY 1
  ),
  prev AS (
    SELECT r.channel, sum(r.revenue_ex_vat) AS rev, sum(r.sales)::bigint AS sales
    FROM mx_revenue_daily r, b WHERE r.day BETWEEN b.d1 - (2 * p_days - 1) AND b.d1 - p_days GROUP BY 1
  ),
  j AS (
    SELECT coalesce(c.channel, p.channel) AS channel,
           coalesce(c.rev, 0) AS rev, coalesce(c.sales, 0) AS sales,
           coalesce(p.rev, 0) AS prev, coalesce(p.sales, 0) AS prev_sales
    FROM cur c FULL JOIN prev p ON p.channel = c.channel
  )
  SELECT channel, round(rev, 2), sales, round(prev, 2), prev_sales,
         CASE WHEN prev <> 0 THEN round(100 * (rev - prev) / abs(prev), 1) END
  FROM j
  UNION ALL
  SELECT 'total', round(sum(rev), 2), sum(sales)::bigint, round(sum(prev), 2), sum(prev_sales)::bigint,
         CASE WHEN sum(prev) <> 0 THEN round(100 * (sum(rev) - sum(prev)) / abs(sum(prev)), 1) END
  FROM j
$$;

COMMENT ON FUNCTION mx_revenue_summary IS
  'Revenue (MFlow ex-VAT) per channel plus a total row, for the last p_days and the '
  'p_days before. The strategist''s north star is the total row.';

GRANT SELECT ON mx_revenue_daily, mx_campaigns, mx_web_orders, mx_paid_daily
  TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION mx_paid_summary(int, date), mx_revenue_summary(int, date), mx_norm(text)
  TO anon, authenticated, service_role;
