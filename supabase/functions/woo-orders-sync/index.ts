/**
 * CoffeeFlow — WooCommerce Orders Sync
 *
 * Fetches completed + processing orders from the WooCommerce REST API
 * and upserts them into the woo_orders table.
 *
 * By default syncs the last 90 days. Incremental: on subsequent runs
 * it only fetches orders newer than the latest order_date already stored.
 *
 * POST body (optional): { "days": 180 }  — override lookback window
 */

import { serve }        from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const WOO_URL  = Deno.env.get("WOO_URL")                   ?? "";
const WOO_KEY  = Deno.env.get("WOO_KEY")                   ?? "";
const WOO_SEC  = Deno.env.get("WOO_SECRET")                ?? "";
const SUPA_URL = Deno.env.get("SUPABASE_URL")              ?? "";
const SUPA_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const wooAuth = btoa(`${WOO_KEY}:${WOO_SEC}`);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface WooLineItem {
  name:     string;
  sku:      string;
  quantity: number;
  subtotal: string;
}

interface WooMeta {
  key:   string;
  value: string;
}

interface WooOrder {
  id:            number;
  date_created:  string;
  status:        string;
  total:         string;
  currency:      string;
  line_items:    WooLineItem[];
  billing:       { email?: string };
  meta_data:     WooMeta[];
}

// Orders created by mflow (B2B invoicing) have source_type = "Advanced Purchase Tracking (APT)"
// Regular website orders have source_type = "Tag" or "API"
// We skip mflow orders entirely — they are not real customer orders.
const MFLOW_TRACKING_TYPE = "Advanced Purchase Tracking (APT)";

function getTrackingType(meta: WooMeta[]): string | null {
  const m = meta.find(m => m.key === "_wc_order_attribution_source_type");
  return m?.value ? String(m.value) : null;
}

function isMflowOrder(meta: WooMeta[]): boolean {
  const t = getTrackingType(meta);
  return t !== null && t.toLowerCase().includes("advanced purchase tracking");
}

// Extract UTM params from order meta_data
// Plugins like WooCommerce Google Analytics Pro / Pixel Caffeine / PixelYourSite
// store them under various key names — check the most common ones
function extractUtm(meta: WooMeta[]): Record<string, string | null> {
  const find = (...keys: string[]) => {
    for (const k of keys) {
      const m = meta.find(m => m.key === k);
      if (m?.value) return String(m.value);
    }
    return null;
  };
  return {
    utm_source:   find('utm_source',   '_utm_source',   'ga_utm_source',   'woo_ga_utm_source'),
    utm_medium:   find('utm_medium',   '_utm_medium',   'ga_utm_medium',   'woo_ga_utm_medium'),
    utm_campaign: find('utm_campaign', '_utm_campaign', 'ga_utm_campaign', 'woo_ga_utm_campaign'),
    utm_content:  find('utm_content',  '_utm_content',  'ga_utm_content'),
    utm_term:     find('utm_term',     '_utm_term',     'ga_utm_term'),
  };
}

async function fetchOrders(after: string, page: number): Promise<WooOrder[]> {
  const params = new URLSearchParams({
    per_page: "100",
    page: String(page),
    after,
    status: "completed,processing",
    orderby: "date",
    order: "asc",
    _fields: "id,date_created,status,total,currency,line_items,billing,meta_data",
  });
  const url = `${WOO_URL}/wp-json/wc/v3/orders?${params}`;
  const res  = await fetch(url, { headers: { Authorization: `Basic ${wooAuth}` } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`WooCommerce API error ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const supabase = createClient(SUPA_URL, SUPA_KEY);

  let days = 60;
  try { const b = await req.json(); days = b.days ?? 60; } catch { /* use default */ }

  // Find latest order already stored → incremental sync
  const { data: latest } = await supabase
    .from("woo_orders")
    .select("order_date")
    .order("order_date", { ascending: false })
    .limit(1)
    .single();

  const after = latest?.order_date
    ? new Date(latest.order_date).toISOString()  // start from last stored date
    : new Date(Date.now() - days * 86400_000).toISOString();

  console.log(`[woo-orders-sync] Fetching orders after ${after}`);

  let page = 1;
  let totalFetched = 0;
  let totalSkipped = 0;
  let totalUpserted = 0;

  while (true) {
    const orders = await fetchOrders(after, page);
    if (!orders.length) break;

    const rows = orders
      .filter((o: WooOrder) => {
        const meta = o.meta_data ?? [];
        if (isMflowOrder(meta)) {
          console.log(`[woo-orders-sync] Skipping mflow order #${o.id} (tracking: ${getTrackingType(meta)})`);
          totalSkipped++;
          return false;
        }
        return true;
      })
      .map((o: WooOrder) => {
        const meta = o.meta_data ?? [];
        const utm  = extractUtm(meta);
        return {
          woo_order_id:   o.id,
          order_date:     o.date_created.slice(0, 10),
          status:         o.status,
          total:          parseFloat(o.total) || 0,
          currency:       o.currency ?? "ILS",
          customer_email: o.billing?.email ?? null,
          tracking_type:  getTrackingType(meta),
          utm_source:     utm.utm_source,
          utm_medium:     utm.utm_medium,
          utm_campaign:   utm.utm_campaign,
          utm_content:    utm.utm_content,
          utm_term:       utm.utm_term,
          items: (o.line_items ?? []).map((li: WooLineItem) => ({
            product_name: li.name,
            sku:          li.sku,
            quantity:     li.quantity,
            subtotal:     parseFloat(li.subtotal) || 0,
          })),
          synced_at: new Date().toISOString(),
        };
      });

    const { error } = await supabase
      .from("woo_orders")
      .upsert(rows, { onConflict: "woo_order_id" });

    if (error) {
      console.error(`[woo-orders-sync] Upsert error page ${page}:`, error.message);
      return new Response(
        JSON.stringify({ success: false, error: error.message }),
        { status: 500, headers: { ...CORS, "Content-Type": "application/json" } },
      );
    }

    totalFetched  += orders.length;
    totalUpserted += rows.length;
    console.log(`[woo-orders-sync] Page ${page}: ${orders.length} fetched, ${rows.length} upserted, ${orders.length - rows.length} skipped (mflow)`);

    if (orders.length < 100) break; // last page
    page++;
  }

  console.log(`[woo-orders-sync] Done. Fetched: ${totalFetched}, Upserted: ${totalUpserted}, Skipped (mflow): ${totalSkipped}`);

  return new Response(
    JSON.stringify({ success: true, fetched: totalFetched, upserted: totalUpserted, skipped_mflow: totalSkipped, after }),
    { headers: { ...CORS, "Content-Type": "application/json" } },
  );
});
