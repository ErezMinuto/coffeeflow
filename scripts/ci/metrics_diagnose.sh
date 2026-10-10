#!/usr/bin/env bash
# Times each metrics-layer object on a database through the Management API.
# Prints durations and ROW COUNTS only (public repo → public logs).
set -uo pipefail
REF="${1:?project ref}"
q() {
  local label="$1" sql="$2" t0 t1 code
  t0=$(date +%s%3N)
  code=$(curl -sS -m 45 -o out.json -w '%{http_code}' -X POST \
    "https://api.supabase.com/v1/projects/$REF/database/query" \
    -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H "Content-Type: application/json" \
    --data "$(jq -n --arg q "$sql" '{query:$q}')")
  t1=$(date +%s%3N)
  if [ "$code" -lt 300 ]; then r="$(jq -c '.[0]' out.json | head -c 200)"; else r="ERR $(head -c 160 out.json | tr '\n' ' ')"; fi
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
