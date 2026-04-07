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

interface WooOrder {
  id:            number;
  date_created:  string;
  status:        string;
  total:         string;
  currency:      string;
  line_items:    WooLineItem[];
  billing:       { email?: string };
}

async function fetchOrders(after: string, page: number): Promise<WooOrder[]> {
  const params = new URLSearchParams({
    per_page: "100",
    page: String(page),
    after,
    status: "completed,processing",
    orderby: "date",
    order: "asc",
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
  let totalUpserted = 0;

  while (true) {
    const orders = await fetchOrders(after, page);
    if (!orders.length) break;

    const rows = orders.map((o: WooOrder) => ({
      woo_order_id:   o.id,
      order_date:     o.date_created.slice(0, 10),
      status:         o.status,
      total:          parseFloat(o.total) || 0,
      currency:       o.currency ?? "ILS",
      customer_email: o.billing?.email ?? null,
      items: (o.line_items ?? []).map((li: WooLineItem) => ({
        product_name: li.name,
        sku:          li.sku,
        quantity:     li.quantity,
        subtotal:     parseFloat(li.subtotal) || 0,
      })),
      synced_at: new Date().toISOString(),
    }));

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

    totalFetched   += orders.length;
    totalUpserted  += rows.length;
    console.log(`[woo-orders-sync] Page ${page}: ${orders.length} orders`);

    if (orders.length < 100) break; // last page
    page++;
  }

  console.log(`[woo-orders-sync] Done. Fetched: ${totalFetched}, Upserted: ${totalUpserted}`);

  return new Response(
    JSON.stringify({ success: true, fetched: totalFetched, upserted: totalUpserted, after }),
    { headers: { ...CORS, "Content-Type": "application/json" } },
  );
});
