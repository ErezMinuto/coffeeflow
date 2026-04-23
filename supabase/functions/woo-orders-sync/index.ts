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

// Extract gclid (Google Click Identifier) from order meta. PMax and
// auto-tagged Search campaigns append gclid=... to the landing URL; without
// capturing it, the doctor's attribution logic misses these orders entirely
// (the La Marzocco bug). We check three places in priority order:
//   1. A dedicated _gclid meta key (PixelYourSite and some other plugins)
//   2. Query string of _wc_order_attribution_session_entry_url
//      (the WooCommerce "Order Attribution" feature's landing URL)
//   3. Query string of the checkout referer if present
function extractGclid(meta: WooMeta[]): string | null {
  // 1. Direct meta key
  const direct = meta.find(m => ['_gclid', 'gclid', '_ga_gclid'].includes(m.key))?.value;
  if (direct) return String(direct);

  // 2. Parse from session entry URL
  const entryUrl = meta.find(m => m.key === '_wc_order_attribution_session_entry_url')?.value;
  if (entryUrl) {
    try {
      const u = new URL(String(entryUrl));
      const g = u.searchParams.get('gclid');
      if (g) return g;
    } catch { /* bad URL, ignore */ }
  }

  // 3. Attribution source URL (same feature, different key)
  const refUrl = meta.find(m => m.key === '_wc_order_attribution_referrer')?.value;
  if (refUrl) {
    try {
      const u = new URL(String(refUrl));
      const g = u.searchParams.get('gclid');
      if (g) return g;
    } catch { /* ignore */ }
  }

  return null;
}

// Classify a product name into a category Minuto cares about. Used to enrich
// order line items so the doctor can say "this campaign drives 80% machines,
// 20% coffee" — critical for the strategic goal of shifting from 45% machine
// revenue toward more coffee. Rules are pattern-based and tuned to the
// current catalog. Order matters: check most-specific patterns first.
function categorizeProduct(name: string, sku: string): string {
  const n = (name ?? '').toLowerCase();
  const s = (sku ?? '').toLowerCase();
  const text = `${n} ${s}`;

  // Grinders first — "ECM" appears in both grinders and machines, so we need
  // to match the specific grinder models before the generic "machine" brands
  const grinderPatterns = [
    /mahlk[oö]nig/i, /mazzer/i, /eureka/i, /fiorenzato/i, /\bbaratza\b/i,
    /comandante/i, /1zpresso/i, /timemore/i, /\bwilfa\b/i,
    /מטחנ/, /\bgrinder\b/i,
  ];
  if (grinderPatterns.some(p => p.test(text))) return 'grinder';

  // Espresso machines (boutique Italian brands + generic "מכונה" Hebrew)
  const machinePatterns = [
    /la\s*marzocco/i, /\becm\b/i, /profitec/i, /\brocket\b/i, /\blelit\b/i,
    /gaggia/i, /rancilio/i, /nuova\s*simonelli/i, /slayer/i, /linea/i,
    /מכונת אספרסו/, /מכונת קפה/, /\bespresso\s*machine\b/i,
  ];
  if (machinePatterns.some(p => p.test(text))) return 'machine';

  // Coffee beans — the broadest class. Match origin names, blend/single-
  // origin terminology, and Hebrew terms for coffee beans.
  const coffeePatterns = [
    /\bbeans?\b/i, /\bblend\b/i, /\bsingle\s*origin\b/i, /\bespresso\b/i,
    /yirgacheffe|sidamo|guji|ethiopia|kenya|colombia|brazil|costa\s*rica|panama|guatemala/i,
    /פול(?!\w)/, /בלנד/, /ספשלטי/, /אתיופיה|קולומביה|ברזיל|קניה|גואטמלה/,
    /קפה טרי|פולי קפה/,
  ];
  if (coffeePatterns.some(p => p.test(text))) return 'coffee';

  // Accessories — brewing gear, cleaning, scales, etc.
  const accessoryPatterns = [
    /\bfilter\b/i, /\bcleaner\b/i, /\bscale\b/i, /\btamper\b/i, /\bportafilter\b/i,
    /\bkettle\b/i, /\bv60\b/i, /\bchemex\b/i, /\baeropress\b/i,
    /\bmoka\s*pot\b/i, /\bfrench\s*press\b/i,
    /פילטר|מאזניים|טמפר|דוכס|קומקום|מסננת/,
  ];
  if (accessoryPatterns.some(p => p.test(text))) return 'accessory';

  return 'other';
}

async function fetchOrders(after: string, page: number): Promise<WooOrder[]> {
  // Owner's preference: only sync paid orders — processing (paid, awaiting
  // shipment) and completed (paid + shipped). Pending/on-hold/failed are
  // not "real orders" from a revenue perspective.
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
  let forceDaysBack: number | null = null;
  let countOnly = false;
  try {
    const b = await req.json();
    days = b.days ?? 60;
    // count_only: skip upserts, just return Woo's count of real paid orders
    // (processing + completed) for the last N days. Used to diagnose when
    // the owner's dashboard number doesn't match what we have in DB.
    if (b.count_only) countOnly = true;
    // days_back: skip the incremental "latest order" logic and force a
    // backfill of the last N days. Useful when the sync silently missed
    // a gap (e.g. while the cron was failing) — call with {"days_back":10}
    // to re-scan the last 10 days and upsert anything missing.
    if (typeof b.days_back === "number" && b.days_back > 0) forceDaysBack = b.days_back;
  } catch { /* use default */ }

  // Find the highest woo_order_id already stored. Using ID instead of
  // order_date eliminates the gap bug where:
  //   - past sync failures left some days missing
  //   - latest order_date in DB is advanced by later syncs
  //   - incremental sync "after latest_date" then permanently skips the
  //     missing days because they sit BETWEEN the last-in-DB and now
  // Order IDs are monotonically increasing in Woo, so "max_id + 1 onwards"
  // catches every order regardless of date or past failures.
  const { data: maxIdRow } = await supabase
    .from("woo_orders")
    .select("woo_order_id")
    .order("woo_order_id", { ascending: false })
    .limit(1)
    .single();
  const lastSyncedId = (maxIdRow as any)?.woo_order_id ?? 0;

  let after: string;
  if (forceDaysBack !== null) {
    after = new Date(Date.now() - forceDaysBack * 86400_000).toISOString();
  } else {
    // Default: look back 3 days from last synced order's date as a safety
    // buffer — catches any orders where date_created was back-dated, and
    // covers short gaps where sync was failing. The ID filter below is the
    // real gap-proofing; the date just limits how much data we fetch.
    const { data: lastOrder } = await supabase
      .from("woo_orders")
      .select("order_date")
      .eq("woo_order_id", lastSyncedId || 0)
      .maybeSingle();
    const lastOrderDate = (lastOrder as any)?.order_date;
    if (lastOrderDate) {
      const t = new Date(lastOrderDate).getTime() - 3 * 86400_000;
      after = new Date(t).toISOString();
    } else {
      after = new Date(Date.now() - days * 86400_000).toISOString();
    }
  }

  console.log(`[woo-orders-sync] Last synced order_id=${lastSyncedId}, fetching orders after=${after}`);

  // count_only branch — fetch every page from Woo to get a true count
  // (processing + completed), no upserts, just return numbers so we can
  // compare with what's in our DB.
  if (countOnly) {
    const statuses: Record<string, number> = {};
    let totalFromWoo = 0;
    let pageC = 1;
    const ids: number[] = [];
    while (true) {
      const batch = await fetchOrders(after, pageC);
      if (!batch.length) break;
      for (const o of batch) {
        statuses[o.status] = (statuses[o.status] ?? 0) + 1;
        totalFromWoo++;
        ids.push(o.id);
      }
      if (batch.length < 100) break;
      pageC++;
    }
    // Compare with what's in our DB for the same window
    const { data: dbRows } = await supabase
      .from("woo_orders")
      .select("woo_order_id,order_date,status")
      .gte("order_date", after.slice(0, 10));
    const dbIds = new Set(((dbRows ?? []) as any[]).map(r => r.woo_order_id));
    const inWooNotDb = ids.filter(id => !dbIds.has(id));
    return new Response(JSON.stringify({
      after,
      woo_total_paid: totalFromWoo,
      woo_by_status: statuses,
      woo_order_ids: ids,
      db_total: dbIds.size,
      missing_from_db: inWooNotDb,
    }, null, 2), { headers: { ...CORS, "Content-Type": "application/json" } });
  }

  let page = 1;
  let totalFetched = 0;
  let totalSkipped = 0;
  let totalUpserted = 0;
  let totalNew = 0;       // orders with woo_order_id > lastSyncedId
  let totalRefreshed = 0; // orders already in DB — just got status/data refreshed

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
        const gclid = extractGclid(meta);
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
          gclid,
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

    // Populate woo_order_items_enriched — flatten line_items into individual
    // rows with product_category so the doctor can answer "how much coffee
    // vs machine revenue per campaign?". Keyed on (order_id, line_index) so
    // re-running is idempotent. We also denormalize utm + gclid onto each
    // line so aggregation queries don't need to join back.
    const itemRows: any[] = [];
    for (const row of rows as any[]) {
      const orderItems = orders.find(o => o.id === row.woo_order_id)?.line_items ?? [];
      orderItems.forEach((li: WooLineItem, idx: number) => {
        itemRows.push({
          order_id:         row.woo_order_id,
          line_index:       idx,
          product_name:     li.name,
          sku:              li.sku,
          product_category: categorizeProduct(li.name, li.sku),
          quantity:         li.quantity,
          line_total:       parseFloat(li.subtotal) || 0,
          order_date:       row.order_date,
          utm_source:       row.utm_source,
          utm_campaign:     row.utm_campaign,
          gclid:            row.gclid,
          synced_at:        new Date().toISOString(),
        });
      });
    }
    if (itemRows.length > 0) {
      const { error: itemsErr } = await supabase
        .from("woo_order_items_enriched")
        .upsert(itemRows, { onConflict: "order_id,line_index" });
      if (itemsErr) console.error(`[woo-orders-sync] items upsert error:`, itemsErr.message);
    }

    // Split the rows into "new" (id > lastSyncedId) vs "refreshed" (already
    // in DB, status/data just gets updated). The old count conflated them
    // and confused the owner — "21 upserted" sounded like 21 new orders
    // when most were just the 3-day safety buffer re-syncing itself.
    const newRows       = rows.filter((r: any) => r.woo_order_id > lastSyncedId);
    const refreshedRows = rows.filter((r: any) => r.woo_order_id <= lastSyncedId);
    totalNew       += newRows.length;
    totalRefreshed += refreshedRows.length;
    totalFetched   += orders.length;
    totalUpserted  += rows.length;
    console.log(`[woo-orders-sync] Page ${page}: ${orders.length} fetched → ${newRows.length} NEW (id>${lastSyncedId}), ${refreshedRows.length} refreshed, ${orders.length - rows.length} skipped`);

    if (orders.length < 100) break; // last page
    page++;
  }

  console.log(`[woo-orders-sync] Done. New: ${totalNew}, Refreshed: ${totalRefreshed}, Skipped mflow: ${totalSkipped}`);

  return new Response(
    JSON.stringify({
      success: true,
      new_orders: totalNew,          // actual new orders since last sync
      refreshed_orders: totalRefreshed, // existing orders that got status/data update
      fetched: totalFetched,
      skipped_mflow: totalSkipped,
      last_synced_id_before: lastSyncedId,
      window_after: after,
    }),
    { headers: { ...CORS, "Content-Type": "application/json" } },
  );
});
