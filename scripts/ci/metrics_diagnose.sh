#!/usr/bin/env bash
# Times each metrics-layer object on a database through the Management API.
# Prints durations and ROW COUNTS only (public repo → public logs).
set -uo pipefail
REF="${1:?project ref}"
q() {
  local label="$1" sql="$2" t0 t1 code
  rm -f out.json; t0=$(date +%s%3N)
  code=$(curl -sS -m 45 -o out.json -w '%{http_code}' -X POST \
    "https://api.supabase.com/v1/projects/$REF/database/query" \
    -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H "Content-Type: application/json" \
    --data "$(jq -n --arg q "$sql" '{query:$q}')")
  t1=$(date +%s%3N)
  if [ "$code" = 000 ]; then r="TIMEOUT (no response within cap)"; elif [ "$code" -lt 300 ]; then r="$(jq -c '.[0]' out.json | head -c 200)"; else r="ERR $(head -c 160 out.json | tr '\n' ' ')"; fi
  printf '%-34s %6s ms  %s\n' "$label" "$((t1 - t0))" "$r"
}
q "rows: mflow_sell_lines"     "select count(*) n from mflow_sell_lines"
q "rows: mflow ecosite w/ woo" "select count(*) n from mflow_sell_lines where channel='ecosite' and woocommerce_order_id is not null"
q "rows: woo_orders"           "select count(*) n from woo_orders"
q "rows: google_click_mapping" "select count(*) n from google_click_mapping"
q "rows: google_campaigns"     "select count(*) n from google_campaigns"
q "rows: meta_ad_campaigns"    "select count(*) n from meta_ad_campaigns"
q "mx_campaigns"               "select count(*) n from mx_campaigns"
q "mx_revenue_daily"           "select count(*) n from mx_revenue_daily"
q "mx_web_orders"              "select count(*) n from mx_web_orders"
q "mx_paid_daily"              "select count(*) n from mx_paid_daily"
q "mx_paid_summary(30)"        "select count(*) n from mx_paid_summary(30)"
q "mx_revenue_summary(30)"     "select count(*) n from mx_revenue_summary(30)"
q "role timeouts"              "select rolname, rolconfig from pg_roles where rolname in ('anon','authenticated','service_role')"
# Attribution breakdown: counts and booleans only.
q "paid orders 30d by signal" "select ad_platform, count(*) n, count(*) filter (where gclid is not null) with_gclid, count(*) filter (where utm_campaign is not null) with_utm_campaign, count(*) filter (where utm_medium is not null) with_utm_medium from mx_web_orders where ad_platform is not null and day >= current_date-29 group by 1"
q "gclids found in click map" "select count(*) filter (where m.gclid is not null) found, count(*) total, min(length(w.gclid)) min_len, max(length(w.gclid)) max_len from mx_web_orders w left join google_click_mapping m on m.gclid = w.gclid where w.gclid is not null and w.day >= current_date-29"
q "click map date range" "select min(click_date) first, max(click_date) last, count(*) filter (where click_date >= current_date-29) last30, min(length(gclid)) min_len, max(length(gclid)) max_len from google_click_mapping"
q "utm_campaign looks like" "select ad_platform, count(*) filter (where utm_campaign ~ '^[0-9]+$') numeric_ids, count(*) filter (where utm_campaign ~ '[{}]') unexpanded_macros, count(*) filter (where utm_campaign is not null and utm_campaign !~ '^[0-9]+$' and utm_campaign !~ '[{}]') names from mx_web_orders where ad_platform is not null and day >= current_date-29 group by 1"
q "google sync freshness" "select max(date) last_day, max(synced_at)::date last_sync from google_campaigns"
q "google-sync cron"          "select jobname, schedule, active from cron.job where jobname='google-sync-daily'"
q "last google syncs"         "select status, started_at::timestamp(0), (stats->>'click_days') click_days, (stats->>'click_mapping_rows') click_rows from sync_log where platform='google' order by started_at desc limit 1"
q "recent pg_net replies"     "select json_agg(x) from (select id, status_code, timed_out, left(coalesce(error_msg,''),80) err, created::timestamp(0) at from net._http_response order by created desc limit 5) x"
