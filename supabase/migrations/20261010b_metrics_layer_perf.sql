-- mx_web_orders, faster. Same columns and results as 20261010_metrics_layer.sql.
--
-- The first version matched campaign names in a LATERAL subquery that the
-- planner re-ran per order over the whole campaign directory; on production
-- volumes the checks query hit the 100 s gateway timeout. Campaign lookups
-- are now computed once (MATERIALIZED CTEs) and joined by equality.
-- Measured on PGlite at 4k orders / 60k sale lines: 3.5 s → 0.12 s.

CREATE OR REPLACE VIEW mx_web_orders
WITH (security_invoker = true) AS
WITH sales AS MATERIALIZED (
  SELECT woocommerce_order_id,
         min((transaction_date AT TIME ZONE 'Asia/Jerusalem')::date) AS day,
         round(sum(line_revenue_exc_tax), 2)                         AS revenue_ex_vat
  FROM mflow_revenue
  WHERE channel = 'ecosite' AND woocommerce_order_id IS NOT NULL
  GROUP BY woocommerce_order_id
),
-- Campaign lookups computed ONCE, then joined by equality. (The first version
-- matched names in a LATERAL subquery that re-ran per order and timed out.)
camps AS MATERIALIZED (
  SELECT platform, campaign_id, mx_norm(name) AS nname FROM mx_campaigns
),
by_name AS MATERIALIZED (
  SELECT platform, nname, min(campaign_id) AS campaign_id
  FROM camps WHERE nname IS NOT NULL GROUP BY 1, 2
),
classified AS MATERIALIZED (
  SELECT s.woocommerce_order_id AS woo_order_id, s.day, s.revenue_ex_vat,
         w.customer_email, w.utm_source, w.utm_medium, w.utm_campaign, w.gclid,
         (w.woo_order_id IS NULL) AS missing_woo_row,
         CASE
           WHEN w.gclid IS NOT NULL
             OR (lower(coalesce(w.utm_source,'')) LIKE '%google%'
                 AND lower(coalesce(w.utm_medium,'')) ~ '(cpc|ppc|paid|pmax|shopping)')      THEN 'google_ads'
           WHEN lower(coalesce(w.utm_source,'')) ~ '(facebook|^fb$|instagram|^ig$|meta)'
             AND lower(coalesce(w.utm_medium,'')) ~ '(cpc|cpm|paid|ads?$|paid_social)'       THEN 'meta_ads'
           WHEN lower(coalesce(w.utm_source,'')) = 'email'
             OR lower(coalesce(w.utm_medium,'')) = 'email'                                   THEN 'email'
           WHEN w.tracking_type = 'organic'                                                  THEN 'organic_search'
           WHEN lower(coalesce(w.utm_source,'')) ~ '(facebook|^fb$|instagram|^ig$|meta)'     THEN 'social'
           WHEN w.tracking_type = 'referral'                                                 THEN 'referral'
           WHEN w.tracking_type = 'typein'                                                   THEN 'direct'
           ELSE 'other'
         END AS source_group,
         trim(w.utm_campaign)  AS utm_campaign_trim,
         mx_norm(w.utm_campaign) AS utm_campaign_norm
  FROM sales s
  LEFT JOIN woo_orders w ON w.woo_order_id = s.woocommerce_order_id
),
p AS MATERIALIZED (
  SELECT c.*, CASE c.source_group WHEN 'google_ads' THEN 'google' WHEN 'meta_ads' THEN 'meta' END AS ad_platform
  FROM classified c
)
SELECT
  p.woo_order_id, p.day, p.revenue_ex_vat, p.customer_email,
  p.source_group,                         -- google_ads | meta_ads | email | organic_search | social | referral | direct | other
  p.utm_source, p.utm_medium, p.utm_campaign, p.gclid, p.missing_woo_row,
  p.ad_platform,
  coalesce(gm.campaign_id, byid.campaign_id, bn.campaign_id)           AS campaign_id,
  CASE
    WHEN gm.campaign_id   IS NOT NULL THEN 'gclid'
    WHEN byid.campaign_id IS NOT NULL THEN 'utm_campaign_id'
    WHEN bn.campaign_id   IS NOT NULL THEN 'utm_campaign_name'
    WHEN p.ad_platform    IS NOT NULL THEN 'unattributed'
  END                                                                   AS attribution
FROM p
LEFT JOIN google_click_mapping gm
       ON p.ad_platform = 'google' AND gm.gclid = p.gclid
LEFT JOIN camps byid
       ON p.ad_platform IS NOT NULL AND byid.platform = p.ad_platform
      AND byid.campaign_id = p.utm_campaign_trim
LEFT JOIN by_name bn
       ON p.ad_platform IS NOT NULL AND bn.platform = p.ad_platform
      AND bn.nname = p.utm_campaign_norm;
