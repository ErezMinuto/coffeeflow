/**
 * CoffeeFlow — iCount Coffee-Sales Reporter (Supabase Edge Function)
 *
 * Read-only bridge to the iCount sales API (credentials never touch the browser).
 * Powers the coffee-beans sales report and its nightly daily-rollup cache.
 *
 * iCount STOCK / INVENTORY management was removed 2026-07-12 (Minuto stopped using
 * iCount for stock). This function no longer creates items, syncs stock, uploads
 * images, or deletes items — it only READS sales documents for reporting.
 *
 * Actions:
 *   coffee_sales           — sales report over a date range (reads the daily cache,
 *                            computes "today" live, self-heals missing final days).
 *   coffee_sales_backfill  — populate / refresh the daily-rollup cache (nightly cron).
 *
 * Verified iCount v3 API contract (base https://api.icount.co.il/api/v3.php):
 *   auth/login          {cid,user,pass} -> {sid}
 *   inventory/get_items {sid} -> {items:[{inventory_item_id,sku,item_type_id,description,...}]}
 *   doc/search          {sid,doctype,start_date,end_date,detail_level:10} -> {results_list}
 *
 * Secrets required: ICOUNT_CID, ICOUNT_USER, ICOUNT_PASS, WOO_URL, WOO_KEY, WOO_SECRET
 *   (Woo creds still needed: the specialty-coffee category SKU set identifies which
 *    iCount sales lines are coffee — including website variation SKUs.)
 *
 * Deploy:
 *   supabase functions deploy icount-admin --project-ref <ref> --no-verify-jwt
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPA_URL = Deno.env.get("SUPABASE_URL")              ?? "";
const SUPA_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
// Used by the coffee-sales daily rollup cache (coffee_sales_daily*). Service-role
// key bypasses RLS. Auto-injected in the edge runtime.
const supabase = createClient(SUPA_URL, SUPA_KEY);

const ICOUNT_BASE = "https://api.icount.co.il/api/v3.php";
const CID  = Deno.env.get("ICOUNT_CID")  ?? "";
const USER = Deno.env.get("ICOUNT_USER") ?? "";
const PASS = Deno.env.get("ICOUNT_PASS") ?? "";

const WOO_URL = (Deno.env.get("WOO_URL") ?? "https://www.minuto.co.il").replace(/\/+$/, "");
const WOO_KEY = Deno.env.get("WOO_KEY") ?? "";
const WOO_SEC = Deno.env.get("WOO_SECRET") ?? "";
const wooAuth = btoa(`${WOO_KEY}:${WOO_SEC}`);

const COFFEE_CATEGORY_SLUG = Deno.env.get("WOO_COFFEE_CATEGORY_SLUG") ?? "פולי-קפה-טרי-מינוטו-specialty-coffee";
const TARGET_TYPE = Number(Deno.env.get("TARGET_ITEM_TYPE_ID") ?? "8");
// Coffee sales report counts type-8 (Minuto) items PLUS resold-coffee items
// matched by name keyword (Veneto etc.) since those aren't tagged type 8.
const EXTRA_COFFEE_KEYWORDS = (Deno.env.get("COFFEE_EXTRA_NAME_KEYWORDS") ?? "veneto")
  .toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
// Israel standard VAT (מע"מ) — coffee is standard-rated. Report revenue is summed
// ex-VAT (line unitprice is net); the incl-VAT total is derived at read time so a
// rate change needs no recompute. Override via ICOUNT_VAT_RATE (e.g. 0.17).
const VAT_RATE = Number(Deno.env.get("ICOUNT_VAT_RATE") ?? "0.18");

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// ── iCount helpers ──────────────────────────────────────────────────────────
async function icount(path: string, body: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${ICOUNT_BASE}/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { _raw: text.slice(0, 500), status: false }; }
}

let cachedSid = "";
async function login(): Promise<string> {
  if (cachedSid) return cachedSid;
  const r = await icount("auth/login", { cid: CID, user: USER, pass: PASS });
  if (!r?.sid) throw new Error(`iCount login failed: ${JSON.stringify(r?.reason ?? r).slice(0, 200)}`);
  cachedSid = r.sid;
  return cachedSid;
}

// A failed iCount call (rate-limit, dead session, non-JSON body) comes back as a
// body with status:false or the _raw parse-failure marker — NOT an HTTP error and
// NOT an empty result set. This is the critical distinction for the sales cache:
// a genuinely empty day (status ok, no docs) must be trusted, but a FAILED fetch
// must never be mistaken for an empty day and cached as ₪0.
function icountFailed(r: any): boolean {
  if (!r || typeof r !== "object") return true;
  if (r._raw !== undefined) return true;                                  // body wasn't JSON
  // A doctype+day with zero documents comes back as status:false + this reason.
  // That's an EMPTY result, not a failed fetch — trust it (e.g. a day with retail
  // sales but no B2B invoices). Only treat other status:false bodies as failures.
  if (r.reason === "no_results_found") return false;
  if (r.status === false || r.status === 0 || r.status === "0") return true;
  return false;
}

// iCount call with the auth fields injected, retried on failure with a fresh login
// in between (a rate-limit or an expired session both clear on re-auth). THROWS if
// it never succeeds, so callers can't silently cache a failed fetch. Callers pass
// only the request-specific fields; sid/cid/user/pass are added here.
async function icountRetry(path: string, body: Record<string, unknown>, tries = 5): Promise<any> {
  let last: any = null;
  for (let i = 0; i < tries; i++) {
    if (i > 0) await sleep(400 * i);           // linear backoff: 0,0.4,0.8,1.2,1.6s
    const sid = await login();
    const r = await icount(path, { ...body, sid, cid: CID, user: USER, pass: PASS });
    if (!icountFailed(r)) return r;
    last = r;
    cachedSid = "";                            // force a fresh session for the next try
  }
  throw new Error(`iCount ${path} failed after ${tries} tries: ${JSON.stringify(last?.reason ?? last?.status ?? last).slice(0, 150)}`);
}

function norm(s: unknown): string { return String(s ?? "").trim(); }
const round2 = (n: number) => Math.round(n * 100) / 100;
// iCount SKUs are "PARENT-size-grind" for website variations; POS uses the parent.
// Grouping by parent joins POS + website sales of one coffee together.
const parentSku = (sku: string) => sku.split("-")[0];

// Current calendar date in Israel (the business timezone). Days strictly before
// this are FINAL — no more sales can land — so they're safe to cache. "Today" is
// still open and is always recomputed live, never cached.
function israelToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Jerusalem" });
}

// ── Woo helpers ─────────────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Bounded-concurrency map (preserves input order). Used to fan out the many
// small iCount/Woo round-trips that otherwise dominate wall-clock time.
async function pMap<T, R>(items: T[], conc: number, fn: (item: T, idx: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(conc, items.length) || 0 }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) break;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

// Inclusive list of YYYY-MM-DD between two dates (UTC). Lets us split a slow
// multi-day doc/search into per-day calls that run concurrently.
function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  const d = new Date(`${from}T00:00:00Z`), end = new Date(`${to}T00:00:00Z`);
  if (isNaN(d.getTime()) || isNaN(end.getTime()) || d > end) return [from];
  for (; d <= end; d.setUTCDate(d.getUTCDate() + 1)) out.push(d.toISOString().slice(0, 10));
  return out.length ? out : [from];
}

// Retries transient failures (network error, 429, 5xx) so a hiccup under batch
// load doesn't get mis-read as "SKU has no Woo match". 4xx (other than 429) and
// redirects fail fast — those are real, not transient.
async function wooGet(pathAndQuery: string): Promise<any> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await sleep(300 * attempt);
    try {
      const res = await fetch(`${WOO_URL}/wp-json/wc/v3/${pathAndQuery}`, {
        headers: { Authorization: `Basic ${wooAuth}` },
        redirect: "manual",
      });
      if (res.status >= 300 && res.status < 400)
        throw new Error(`Woo redirect ${res.status} on ${pathAndQuery} — set WOO_URL to canonical host`);
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`Woo ${pathAndQuery} transient HTTP ${res.status}`);
        continue; // retry
      }
      const text = await res.text();
      if (!res.ok) throw new Error(`Woo ${pathAndQuery} HTTP ${res.status}: ${text.slice(0, 200)}`);
      return JSON.parse(text);
    } catch (e) {
      lastErr = e;
      // network/parse errors are retryable; redirect/4xx already threw above and
      // will just retry then surface — acceptable
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`Woo ${pathAndQuery} failed`);
}

// Collect SKUs of every product+variation in the specialty-coffee category.
// The per-variable-product variation calls were the single biggest cost in the
// coffee-sales report (~21s serial), so they're fanned out concurrently, and the
// whole set is cached briefly (it changes only when the catalog does).
let skuCache: { at: number; skus: Set<string> } | null = null;
const SKU_CACHE_TTL_MS = 10 * 60 * 1000;
async function coffeeCategorySkus(): Promise<Set<string>> {
  if (skuCache && Date.now() - skuCache.at < SKU_CACHE_TTL_MS) return skuCache.skus;
  const cats = await wooGet(`products/categories?slug=${encodeURIComponent(COFFEE_CATEGORY_SLUG)}&per_page=100`);
  if (!Array.isArray(cats) || !cats.length) throw new Error(`Woo category not found: ${COFFEE_CATEGORY_SLUG}`);
  const catId = cats[0].id;
  const skus = new Set<string>();
  const variableIds: number[] = [];
  let page = 1;
  for (;;) {
    const products = await wooGet(`products?category=${catId}&per_page=100&page=${page}&status=publish`);
    if (!Array.isArray(products) || !products.length) break;
    for (const p of products) {
      if (norm(p.sku)) skus.add(norm(p.sku));
      if (p.type === "variable") variableIds.push(p.id);
    }
    if (products.length < 100) break;
    page++;
  }
  // Fetch each variable product's variation SKUs concurrently.
  const varSets = await pMap(variableIds, 6, async (pid) => {
    const out: string[] = [];
    let vp = 1;
    for (;;) {
      const vars = await wooGet(`products/${pid}/variations?per_page=100&page=${vp}`);
      if (!Array.isArray(vars) || !vars.length) break;
      for (const v of vars) if (norm(v.sku)) out.push(norm(v.sku));
      if (vars.length < 100) break;
      vp++;
    }
    return out;
  });
  for (const arr of varSets) for (const s of arr) skus.add(s);
  skuCache = { at: Date.now(), skus };
  return skus;
}

// ── Coffee-beans sales: per-day rollup engine + daily cache ──────────────────
// The report used to compute EVERY day live on every request — cost grew with the
// range and a multi-month view neared the edge-function timeout. Now each FINAL
// day is computed once and stored in coffee_sales_daily(_totals); the report SUMs
// the cache and only "today" is ever computed live. Range length stops mattering.

// One day of sales docs for a doctype. iCount `doc/search` is slow (heavy
// detail_level:10) and its `offset` pagination is unreliable — it can ignore
// offset and re-serve the first page. Fetching ONE DAY per call keeps each call
// small (~never paginates); we still dedupe by doc id and stop the moment a page
// brings nothing new, so it's correct whether offset advances or not.
async function fetchDayDocs(doctype: string, day: string): Promise<any[]> {
  const PAGE = 500;
  const byId = new Map<string, any>();
  let offset = 0;
  for (let page = 0; page < 30; page++) {
    // icountRetry THROWS on a failed fetch (rate-limit/dead session) rather than
    // returning empty — so a rate-limited day can never be cached as ₪0.
    const r = await icountRetry("doc/search", { doctype, start_date: day, end_date: day, detail_level: 10, max_results: PAGE, offset });
    const list = r?.results_list;
    const entries: [string, any][] = Array.isArray(list)
      ? list.map((d, i) => [String(i), d])
      : (list && typeof list === "object" ? Object.entries(list) : []);
    if (!entries.length) break;
    let added = 0;
    for (const [k, d] of entries) {
      const id = `${doctype}:${norm(d?.docnum) || norm(d?.doc_number) || norm(d?.doc_url) || k}`;
      if (!byId.has(id)) { byId.set(id, d); added++; }
    }
    const total = Number(r?.total_results ?? r?.num_results ?? 0);
    if (added === 0) break;                    // offset not advancing → done
    if (entries.length < PAGE) break;          // last (partial) page
    if (total && byId.size >= total) break;    // collected everything
    offset += entries.length;
  }
  return [...byId.values()];
}

// Day-independent coffee metadata (which iCount item ids / SKUs count as coffee,
// and their display names). Computed once and reused for every day in a run.
type CoffeeCtx = { coffeeIds: Set<string>; coffeeSkus: Set<string>; nameBySku: Map<string, string>; itemCount: number };
async function buildCoffeeCtx(): Promise<CoffeeCtx> {
  // Fetch the item catalog with retry, and THROW if it fails or matches no coffee.
  // Otherwise a rate-limited get_items would leave coffeeIds empty → every day
  // would aggregate to ₪0 and get cached as such — the worst silent-corruption mode.
  const r = await icountRetry("inventory/get_items", {});
  const items: any[] = Array.isArray(r?.items) ? r.items : (r?.items && typeof r.items === "object" ? Object.values(r.items) : []);
  if (!items.length) throw new Error("iCount get_items returned no items — refusing to compute (would zero every day)");
  const catSkus = await coffeeCategorySkus().catch(() => new Set<string>()); // Woo down → iCount-only matching
  const isCoffee = (i: any) =>
    String(i.item_type_id) === String(TARGET_TYPE) ||
    EXTRA_COFFEE_KEYWORDS.some((k) => String(i.description ?? "").toLowerCase().includes(k));
  const coffeeItems = items.filter(isCoffee);
  if (!coffeeItems.length) throw new Error("no coffee items matched in iCount catalog — refusing to compute");
  const coffeeIds = new Set(coffeeItems.map((i: any) => String(i.inventory_item_id)));
  // SKU set = iCount coffee SKUs (parent) + Woo specialty-coffee category SKUs
  // (which include the per-size/grind VARIATION SKUs). The latter is how website
  // sales are caught: their iCount lines carry the Woo variation SKU + no item id.
  const coffeeSkus = new Set(coffeeItems.map((i) => norm(i.sku)).filter(Boolean));
  for (const s of catSkus) coffeeSkus.add(s);
  const nameBySku = new Map<string, string>();
  for (const i of coffeeItems) { const s = norm(i.sku); if (s) nameBySku.set(s, norm(i.description)); }
  return { coffeeIds, coffeeSkus, nameBySku, itemCount: items.length };
}

// Aggregate one day into per-coffee rows (grouped by parent SKU). Skips cancelled
// docs, refunded lines, and zero/blank-price bundle components (tasting-kit sample
// coffees whose real revenue sits on the priced kit line).
type DayRollup = { day: string; docCount: number; products: Map<string, { sku: string; name: string; bags: number; revenue: number }> };
async function rollupDay(ctx: CoffeeCtx, day: string): Promise<DayRollup> {
  const lineIsCoffee = (iid: string, sku: string, desc: string) =>
    (iid && ctx.coffeeIds.has(iid)) ||
    (sku && (ctx.coffeeSkus.has(sku) || ctx.coffeeSkus.has(parentSku(sku)))) ||
    EXTRA_COFFEE_KEYWORDS.some((k) => desc.toLowerCase().includes(k));

  const [invrec, invoice] = await Promise.all([
    fetchDayDocs("invrec", day),
    fetchDayDocs("invoice", day),
  ]);
  const products = new Map<string, { sku: string; name: string; bags: number; revenue: number }>();
  let docCount = 0;
  for (const doc of [...invrec, ...invoice]) {
    const cancelled = doc.is_cancelled === true || doc.is_cancelled === "1" || doc.is_cancellation === true || doc.is_cancellation === "1";
    if (cancelled) continue;
    const lines = Array.isArray(doc.items) ? doc.items : (doc.items && typeof doc.items === "object" ? Object.values(doc.items) : []);
    let docHasCoffee = false;
    for (const ln of lines as any[]) {
      const iid = String(ln.inventory_item_id ?? ""), sku = norm(ln.sku), desc = String(ln.description ?? "");
      if (!lineIsCoffee(iid, sku, desc)) continue;
      if (ln.is_refunded === "1" || ln.is_refunded === 1) continue;
      const qty = Number(ln.quantity ?? 0);
      const price = Number(ln.unitprice ?? 0);
      if (!(price > 0)) continue;
      const rev = price * qty;
      // group POS (parent SKU) + website (variation SKU) sales of one coffee together;
      // fall back to item id so the storage key (sku PK) is never empty.
      const key = parentSku(sku) || sku || iid || "unknown";
      const name = ctx.nameBySku.get(parentSku(sku)) || ctx.nameBySku.get(sku) || desc;
      const cur = products.get(key) ?? { sku: key, name, bags: 0, revenue: 0 };
      cur.bags += qty; cur.revenue += rev; if (!cur.name && name) cur.name = name;
      products.set(key, cur);
      docHasCoffee = true;
    }
    if (docHasCoffee) docCount++;
  }
  return { day, docCount, products };
}

// Persist one final day's rollup. Delete-then-insert the day's product rows so a
// recompute can't leave stale SKUs behind, then upsert the day-level totals row
// (the backfill watermark — written even for zero-sales days so they're not
// re-fetched forever).
async function persistDay(rollup: DayRollup): Promise<void> {
  const rows = [...rollup.products.values()].map((p) => ({
    day: rollup.day, sku: p.sku, name: p.name, bags: round2(p.bags), revenue: round2(p.revenue),
  }));
  let totalBags = 0, totalRevenue = 0;
  for (const p of rollup.products.values()) { totalBags += p.bags; totalRevenue += p.revenue; }
  await supabase.from("coffee_sales_daily").delete().eq("day", rollup.day);
  if (rows.length) await supabase.from("coffee_sales_daily").insert(rows);
  await supabase.from("coffee_sales_daily_totals").upsert({
    day: rollup.day, doc_count: rollup.docCount,
    total_bags: round2(totalBags), total_revenue: round2(totalRevenue),
    computed_at: new Date().toISOString(),
  }, { onConflict: "day" });
}

// Coffee-beans sales report over a date range. Reads the daily cache for every
// FINAL day, recomputes "today" (Israel) live, and self-heals a bounded number of
// missing final days inline (persisting them). After a one-time backfill the cache
// is warm, so this is a fast DB aggregate regardless of range length.
async function actionCoffeeSales(fromDate: string, toDate: string) {
  if (!fromDate || !toDate) throw new Error("from_date and to_date are required (YYYY-MM-DD)");
  const t0 = Date.now();
  const today = israelToday();
  const days = daysBetween(fromDate, toDate).filter((d) => d <= today); // ignore future
  const completed = days.filter((d) => d < today);
  const liveDays = days.filter((d) => d === today); // today only, always live

  // 1. Read the cache for the range.
  const [totalsRes, rowsRes] = await Promise.all([
    supabase.from("coffee_sales_daily_totals").select("day,doc_count").gte("day", fromDate).lte("day", toDate),
    supabase.from("coffee_sales_daily").select("day,sku,name,bags,revenue").gte("day", fromDate).lte("day", toDate),
  ]);
  const cachedDays = new Set((totalsRes.data ?? []).map((r: any) => String(r.day).slice(0, 10)));

  // 2. Final days missing from the cache → compute live now (bounded) and persist,
  //    newest first. If more than the cap are missing (cold cache), the rest are
  //    absent from this response and `cache_incomplete` flags it — run the backfill.
  const HEAL_CAP = 40;
  const missing = completed.filter((d) => !cachedDays.has(d));
  const toHeal = missing.slice(-HEAL_CAP);
  const liveWork = [...toHeal, ...liveDays];

  let healed = 0, healFailed = 0, itemCount = 0;
  const liveRollups: DayRollup[] = [];
  if (liveWork.length) {
    const ctx = await buildCoffeeCtx();
    itemCount = ctx.itemCount;
    // Low concurrency: fanning many days out at once is exactly what trips iCount's
    // rate limit and produced the corrupt ₪0 days. A day that still fails after
    // retries is skipped (never cached) and flags the report incomplete.
    const rolls = await pMap(liveWork, 3, async (day) => {
      try { return await rollupDay(ctx, day); }
      catch (e) { console.error(`[coffee_sales] heal ${day} failed: ${e instanceof Error ? e.message : e}`); return null; }
    });
    for (const roll of rolls) {
      if (!roll) { healFailed++; continue; }
      liveRollups.push(roll);
      if (roll.day < today) { await persistDay(roll); healed++; } // never cache today (still open)
    }
  }

  // 3. Aggregate cached rows + live rollups (no overlap: healed/today days weren't
  //    in the cache read).
  const byProduct = new Map<string, { sku: string; name: string; bags: number; revenue: number }>();
  let totalBags = 0, totalRevenue = 0, docCount = 0;
  const add = (sku: string, name: string, bags: number, revenue: number) => {
    const key = sku || "unknown";
    const cur = byProduct.get(key) ?? { sku: key, name, bags: 0, revenue: 0 };
    cur.bags += bags; cur.revenue += revenue; if (!cur.name && name) cur.name = name;
    byProduct.set(key, cur);
    totalBags += bags; totalRevenue += revenue;
  };
  for (const r of rowsRes.data ?? []) add(norm(r.sku), norm(r.name), Number(r.bags), Number(r.revenue));
  for (const t of totalsRes.data ?? []) docCount += Number(t.doc_count ?? 0);
  for (const roll of liveRollups) {
    for (const p of roll.products.values()) add(p.sku, p.name, p.bags, p.revenue);
    docCount += roll.docCount;
  }

  const products = [...byProduct.values()]
    .map((p) => ({ ...p, bags: round2(p.bags), revenue: round2(p.revenue) }))
    .sort((a, b) => b.bags - a.bags);
  const uncached = Math.max(0, missing.length - toHeal.length);
  console.log(`[coffee_sales] ${fromDate}..${toDate} cached=${cachedDays.size} healed=${healed} healFailed=${healFailed} live=${liveDays.length} uncached=${uncached} ${Date.now() - t0}ms`);

  return {
    ok: true, from_date: fromDate, to_date: toDate,
    sales_doc_count: docCount,
    total_bags: round2(totalBags),
    total_revenue: round2(totalRevenue),                          // ex-VAT (net)
    total_revenue_incl_vat: round2(totalRevenue * (1 + VAT_RATE)), // incl-VAT (gross)
    vat_rate: VAT_RATE,
    products,
    // partial if any final day is missing from cache (over the heal cap) or a heal
    // fetch failed — numbers under-count until a backfill/retry fills those days.
    cache_incomplete: uncached > 0 || healFailed > 0,
    _timing: { total_ms: Date.now() - t0, cached_days: cachedDays.size, healed_days: healed, heal_failed: healFailed, live_days: liveDays.length, uncached_days: uncached, items: itemCount },
  };
}

// One-time / nightly cache backfill. Computes every not-yet-cached FINAL day in
// [from,to] (or all of them when force=true), up to `limit` days per call so it
// never hits the timeout. Idempotent; loop while `done` is false to fill a long
// range in chunks.
async function actionCoffeeSalesBackfill(fromDate: string, toDate: string, opts: { force: boolean; limit: number }) {
  if (!fromDate || !toDate) throw new Error("from_date and to_date are required (YYYY-MM-DD)");
  const t0 = Date.now();
  const today = israelToday();
  const days = daysBetween(fromDate, toDate).filter((d) => d < today); // only final days
  if (!days.length) return { ok: true, from_date: fromDate, to_date: toDate, total_days: 0, already_cached: 0, computed: 0, remaining: 0, done: true };

  const { data: totals } = await supabase
    .from("coffee_sales_daily_totals").select("day")
    .gte("day", days[0]).lte("day", days[days.length - 1]);
  const cached = new Set((totals ?? []).map((r: any) => String(r.day).slice(0, 10)));
  const todo = opts.force ? days : days.filter((d) => !cached.has(d));
  const limit = Math.min(Math.max(1, opts.limit || 45), 60);
  const batch = todo.slice(0, limit);

  let computed = 0;
  const failed: string[] = [];
  if (batch.length) {
    const ctx = await buildCoffeeCtx();
    // Low concurrency + retry keeps iCount from rate-limiting a big fan-out into
    // silent empties. A day that still fails is NOT persisted (left uncached) so a
    // later run retries it, rather than caching a wrong ₪0.
    const rolls = await pMap(batch, 4, async (day) => {
      try { return await rollupDay(ctx, day); }
      catch (e) { console.error(`[coffee_sales_backfill] ${day} failed: ${e instanceof Error ? e.message : e}`); return null; }
    });
    for (const roll of rolls) {
      if (roll) { await persistDay(roll); computed++; }
      else failed.push("(failed)");
    }
  }
  // untried days remaining in the range + days that failed this pass (still uncached)
  const remaining = Math.max(0, todo.length - batch.length) + failed.length;
  console.log(`[coffee_sales_backfill] ${fromDate}..${toDate} computed=${computed} failed=${failed.length} remaining=${remaining} ${Date.now() - t0}ms`);
  return {
    ok: true, from_date: fromDate, to_date: toDate,
    total_days: days.length, already_cached: cached.size,
    computed, failed: failed.length, remaining, done: remaining === 0,
    _timing: { total_ms: Date.now() - t0 },
  };
}

// ── HTTP ────────────────────────────────────────────────────────────────────
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  if (!CID || !USER || !PASS) return json({ error: "iCount credentials not configured (ICOUNT_CID/USER/PASS)" }, 500);
  if (!WOO_KEY || !WOO_SEC)   return json({ error: "Woo credentials not configured (WOO_KEY/WOO_SECRET)" }, 500);

  let body: any = {};
  try { body = await req.json(); } catch { /* empty */ }
  const action = String(body.action ?? "");

  try {
    switch (action) {
      case "coffee_sales": return json(await actionCoffeeSales(String(body.from_date ?? ""), String(body.to_date ?? "")));
      case "coffee_sales_backfill": return json(await actionCoffeeSalesBackfill(
        String(body.from_date ?? ""), String(body.to_date ?? ""),
        { force: body.force === true, limit: Number(body.limit ?? 45) },
      ));
      default: return json({ error: `unknown action: ${action || "(none)"} — this function now serves coffee_sales only` }, 400);
    }
  } catch (e) {
    return json({ error: String(e instanceof Error ? e.message : e) }, 500);
  }
});
