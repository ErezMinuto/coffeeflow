-- Sanity checks for the metrics layer. Output is ONLY ratios and yes/no:
-- the repo is public, so its run logs are too. Never select amounts here.
WITH
w AS (SELECT * FROM mx_web_orders WHERE day >= (now() AT TIME ZONE 'Asia/Jerusalem')::date - 29),
r AS (SELECT * FROM mx_revenue_daily WHERE day >= (now() AT TIME ZONE 'Asia/Jerusalem')::date - 29),
base AS (SELECT sum(line_revenue_exc_tax) AS rev FROM mflow_revenue
         WHERE (transaction_date AT TIME ZONE 'Asia/Jerusalem')::date >= (now() AT TIME ZONE 'Asia/Jerusalem')::date - 29)
SELECT
  (SELECT abs(coalesce(sum(revenue_ex_vat),0) - coalesce((SELECT rev FROM base),0)) < 1 FROM r)          AS revenue_daily_matches_mflow,
  (SELECT round(100.0 * sum(revenue_ex_vat) FILTER (WHERE channel='ecosite') / nullif(sum(revenue_ex_vat),0), 1) FROM r) AS web_share_pct,
  (SELECT round(100.0 * count(*) FILTER (WHERE missing_woo_row) / nullif(count(*),0), 1) FROM w)          AS web_orders_missing_woo_pct,
  (SELECT round(100.0 * count(*) FILTER (WHERE ad_platform IS NOT NULL) / nullif(count(*),0), 1) FROM w)  AS web_orders_paid_pct,
  (SELECT round(100.0 * count(*) FILTER (WHERE ad_platform='google' AND campaign_id IS NOT NULL)
          / nullif(count(*) FILTER (WHERE ad_platform='google'),0), 1) FROM w)                            AS google_orders_attributed_pct,
  (SELECT round(100.0 * count(*) FILTER (WHERE ad_platform='meta' AND campaign_id IS NOT NULL)
          / nullif(count(*) FILTER (WHERE ad_platform='meta'),0), 1) FROM w)                              AS meta_orders_attributed_pct,
  (SELECT count(*) > 0 FROM mx_paid_summary(30))                                                          AS paid_summary_has_rows,
  (SELECT count(*) > 0 FROM mx_revenue_summary(30))                                                       AS revenue_summary_has_rows;
