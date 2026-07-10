/**
 * CoffeeFlow — iCount Admin (Supabase Edge Function)
 *
 * Server-side bridge to the iCount inventory API (credentials never touch the
 * browser). Called from the admin "iCount" page. Two jobs:
 *
 *   1. set_types  — set item_type_id=8 ("פולי קפה מינוטו") on every iCount item
 *                   whose SKU is in the Woo specialty-coffee category.
 *   2. set_images — upload each iCount item's matching WooCommerce product image
 *                   (matched by SKU). Runs in batches (offset/limit) so it never
 *                   hits the edge-function timeout. Skips items that already have
 *                   an image or have no Woo match.
 *
 * Verified iCount v3 API contract (base https://api.icount.co.il/api/v3.php):
 *   auth/login            {cid,user,pass} -> {sid}
 *   inventory/get_items   {sid} -> {items_count, items:[{inventory_item_id,sku,item_type_id,...}]}
 *   inventory/get_item_types -> {item_types:{"8":"פולי קפה מינוטו", ...}}
 *   inventory/update_item {sid,inventory_item_id,item_type_id}
 *   inventory/get_item_images {sid,inventory_item_id} -> {images:[{file_id,url,is_main_image}]}
 *   inventory/add_item_image  MULTIPART form: sid,cid,user,pass,inventory_item_id + file field "image"
 *
 * Secrets required: ICOUNT_CID, ICOUNT_USER, ICOUNT_PASS, WOO_URL, WOO_KEY, WOO_SECRET
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

async function getAllItems(sid: string): Promise<any[]> {
  const r = await icount("inventory/get_items", { sid, cid: CID, user: USER, pass: PASS });
  const items = r?.items;
  if (Array.isArray(items)) return items;
  if (items && typeof items === "object") return Object.values(items);
  return [];
}

async function getItemImages(sid: string, itemId: string): Promise<any[]> {
  const r = await icount("inventory/get_item_images", { sid, cid: CID, user: USER, pass: PASS, inventory_item_id: itemId });
  return Array.isArray(r?.images) ? r.images.filter((i: any) => !i.deleted) : [];
}

async function addItemImage(sid: string, itemId: string, buf: ArrayBuffer, mime: string, filename: string): Promise<any> {
  const fd = new FormData();
  fd.set("sid", sid); fd.set("cid", CID); fd.set("user", USER); fd.set("pass", PASS);
  fd.set("inventory_item_id", String(itemId));
  fd.set("image", new Blob([buf], { type: mime || "image/jpeg" }), filename);
  const res = await fetch(`${ICOUNT_BASE}/inventory/add_item_image`, { method: "POST", body: fd });
  return await res.json().catch(() => ({ status: false }));
}

async function deleteItemImage(sid: string, itemId: string, imageId: string | number): Promise<any> {
  return await icount("inventory/delete_item_image", { sid, cid: CID, user: USER, pass: PASS, inventory_item_id: itemId, image_id: imageId });
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

// Find the main image URL for a single SKU (product or variation). Returns null
// if the SKU isn't in Woo or has no image.
async function wooImageForSku(sku: string): Promise<string | null> {
  const products = await wooGet(`products?sku=${encodeURIComponent(sku)}&per_page=1`);
  if (Array.isArray(products) && products.length) {
    const img = products[0]?.images?.[0]?.src;
    if (img) return img;
  }
  // maybe it's a variation SKU
  const vars = await wooGet(`products?sku=${encodeURIComponent(sku)}&per_page=1&type=variation`).catch(() => null);
  if (Array.isArray(vars) && vars.length) {
    const img = vars[0]?.image?.src ?? vars[0]?.images?.[0]?.src;
    if (img) return img;
  }
  return null;
}

// Given a full Woo image URL, return the best SQUARE variant for the iCount POS
// app (recommends 150x150). WordPress generates -150x150 / -300x300 crops; pick
// the first that exists and is a real thumbnail (guards against the ~2MB
// fallback some non-generated sizes return). Falls back to the full URL.
async function squareImageUrl(src: string): Promise<string> {
  const clean = src.split("?")[0];
  const dot = clean.lastIndexOf(".");
  if (dot < 0) return src;
  const baseUrl = clean.slice(0, dot), ext = clean.slice(dot);
  for (const size of ["-150x150", "-300x300"]) {
    const cand = baseUrl + size + ext;
    try {
      const r = await fetch(cand);
      if (r.ok) {
        const buf = await r.arrayBuffer();
        if (buf.byteLength > 0 && buf.byteLength < 500_000) return cand;
      }
    } catch { /* try next size */ }
  }
  return src;
}

// Woo stock for a SKU: a number = managed stock; null = found but not tracking
// stock (e.g. variable parent); undefined = SKU not in Woo.
async function wooStockForSku(sku: string): Promise<number | null | undefined> {
  const products = await wooGet(`products?sku=${encodeURIComponent(sku)}&per_page=1`);
  if (Array.isArray(products) && products.length) {
    const p = products[0];
    if (p.manage_stock === true && typeof p.stock_quantity === "number") return p.stock_quantity;
    return null;
  }
  return undefined;
}

function itemSku(it: any): string { return norm(it.sku ?? it.makat ?? it.barcode); }
function itemId(it: any): string { return String(it.inventory_item_id ?? it.id ?? ""); }
function itemType(it: any): string { return String(it.item_type_id ?? ""); }

// Every published Woo product (simple + variable PARENT) that carries a SKU.
// iCount tracks ONE item per product keyed by the (parent) SKU — variations stay
// in Woo — so this is the unit we mirror into iCount.
async function allWooProducts(): Promise<{ id: number; sku: string; name: string; price: number | null }[]> {
  const out: { id: number; sku: string; name: string; price: number | null }[] = [];
  let page = 1;
  for (;;) {
    const products = await wooGet(`products?per_page=100&page=${page}&status=publish`);
    if (!Array.isArray(products) || !products.length) break;
    for (const p of products) {
      const sku = norm(p.sku);
      if (!sku) continue;
      out.push({ id: p.id, sku, name: norm(p.name), price: p.price === "" || p.price == null ? null : Number(p.price) });
    }
    if (products.length < 100) break;
    if (++page > 40) break; // safety cap (~4000 products)
  }
  return out;
}

// Create one iCount inventory item from a Woo product via inventory/add_item.
// Field names per the iCount API spec: `unitprice` + `unit_price_includes_vat`
// for the VAT-inclusive consumer price (NOT unitprice_incvat — that's update_item).
// Buying price (cost_amount) is left unset (captured later at goods-receipt).
// Coffee SKUs are tagged item_type_id=8. iCount requires a UNIQUE description,
// so a duplicate name is retried disambiguated as "name (sku)".
async function icountCreateItem(sid: string, p: { sku: string; name: string; price: number | null }, isCoffee: boolean): Promise<any> {
  const fields: Record<string, unknown> = { sid, cid: CID, user: USER, pass: PASS, sku: p.sku };
  if (p.price != null && Number.isFinite(p.price)) { fields.unitprice = p.price; fields.unit_price_includes_vat = true; }
  if (isCoffee) fields.item_type_id = TARGET_TYPE;
  const name = p.name || p.sku;
  let r = await icount("inventory/add_item", { ...fields, description: name });
  if (r?.reason === "duplicate_description")
    r = await icount("inventory/add_item", { ...fields, description: `${name} (${p.sku})` });
  return r;
}

// Give an iCount item its matching Woo product image as a 150x150 square (the
// iCount POS needs a square), tagged with SQ_MARKER so it isn't redone. Best-effort.
async function ensureSquareImage(sid: string, id: string, sku: string): Promise<string> {
  try {
    const existing = await getItemImages(sid, id);
    if (existing.some((i: any) => String(i.filename ?? "").includes(SQ_MARKER))) return "already_square";
    const fullUrl = await wooImageForSku(sku).catch(() => null);
    if (!fullUrl) return "no_woo_image";
    const sqUrl = await squareImageUrl(fullUrl);
    const r = await fetch(sqUrl);
    if (!r.ok) return "fetch_failed";
    const buf = await r.arrayBuffer();
    const mime = r.headers.get("content-type") ?? "image/jpeg";
    for (const img of existing) await deleteItemImage(sid, id, img.file_id);
    const up = await addItemImage(sid, id, buf, mime, `${sku}${SQ_MARKER}.jpg`);
    return up?.status === true ? "squared" : "upload_failed";
  } catch (e) { return `image_error: ${String(e instanceof Error ? e.message : e).slice(0, 80)}`; }
}

// ── Actions ─────────────────────────────────────────────────────────────────

// Create iCount items for every published Woo product whose SKU isn't in iCount
// yet — so a product added in WooCommerce gets a matching iCount item (same SKU)
// on the next run. dry_run (default) reports what's missing; a real run creates
// up to `limit` of them (the rest follow on the next tick / cron run).
async function actionCreateMissing({ dryRun, limit }: { dryRun: boolean; limit: number }) {
  const sid = await login();
  const [items, wooProducts, coffeeSkus] = await Promise.all([
    getAllItems(sid),
    allWooProducts(),
    coffeeCategorySkus().catch(() => new Set<string>()),
  ]);
  const existing = new Set(items.map(itemSku).filter(Boolean));
  const missing  = wooProducts.filter((p) => !existing.has(p.sku));
  const batch    = missing.slice(0, limit);

  if (dryRun) {
    return {
      ok: true, dry_run: true,
      woo_products: wooProducts.length,
      icount_items_with_sku: existing.size,
      missing: missing.length,
      would_create: batch.map((p) => ({ sku: p.sku, name: p.name, price: p.price, coffee: coffeeSkus.has(p.sku) })),
    };
  }

  // Attempt each create; keep the raw response for reconciliation.
  async function createOne(p: { sku: string; name: string; price: number | null }): Promise<any> {
    try { return { p, r: await icountCreateItem(sid, p, coffeeSkus.has(p.sku)) }; }
    catch (e) { return { p, r: { status: false, reason: String(e instanceof Error ? e.message : e).slice(0, 160) } }; }
  }

  const CONC = 4;
  const attempts: any[] = new Array(batch.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(CONC, batch.length) }, async () => {
    for (;;) { const i = cursor++; if (i >= batch.length) break; attempts[i] = await createOne(batch[i]); }
  }));

  // Reconcile: iCount sometimes returns item_creation_failed even though the item
  // was actually saved. Re-read the catalog and trust that over the response.
  // (Skip the extra fetch on empty ticks — the common cron case with nothing new.)
  const afterItems = batch.length ? await getAllItems(sid) : items;
  const skuToId = new Map<string, string>();
  for (const it of afterItems) { const s = itemSku(it); if (s) skuToId.set(s, itemId(it)); }
  const afterSkus = new Set(skuToId.keys());
  const results: any[] = attempts.map(({ p, r }) => {
    const newId = r?.inventory_item_id ?? r?.id ?? null;
    const nowExists = afterSkus.has(p.sku);
    if (r?.status === true || newId)                 return { sku: p.sku, name: p.name, status: "created", id: String(newId ?? skuToId.get(p.sku) ?? "") };
    if (nowExists && !existing.has(p.sku))           return { sku: p.sku, name: p.name, status: "created_despite_error", id: skuToId.get(p.sku) ?? "" };
    if (r?.reason === "duplicate_sku" || nowExists)  return { sku: p.sku, name: p.name, status: "already_exists" };
    return { sku: p.sku, name: p.name, status: "failed", reason: JSON.stringify(r?.reason ?? r?._raw ?? r).slice(0, 200) };
  });

  // Give each newly-created item its matching Woo product image (150x150 square
  // for the iCount POS). Bounded concurrency; failures don't fail the create.
  const toImage = results.filter((r) => (r.status === "created" || r.status === "created_despite_error") && r.id);
  let ic = 0;
  await Promise.all(Array.from({ length: Math.min(4, toImage.length) }, async () => {
    for (;;) { const i = ic++; if (i >= toImage.length) break; toImage[i].image = await ensureSquareImage(sid, toImage[i].id, toImage[i].sku); }
  }));

  const created = results.filter((r) => r.status === "created" || r.status === "created_despite_error").length;
  const existed = results.filter((r) => r.status === "already_exists").length;
  const imaged  = results.filter((r) => r.image === "squared").length;
  return {
    ok: true, dry_run: false,
    missing_total: missing.length, attempted: batch.length, created, already_exists: existed, imaged,
    remaining: missing.length - created - existed,
    results,
  };
}

// Confirm config + counts for the page header.
async function actionStatus() {
  const sid = await login();
  const [items, types] = await Promise.all([
    getAllItems(sid),
    icount("inventory/get_item_types", { sid, cid: CID, user: USER, pass: PASS }),
  ]);
  const withSku = items.filter((i) => itemSku(i));
  return {
    ok: true,
    icount_total_items: items.length,
    items_with_sku: withSku.length,
    target_type_id: TARGET_TYPE,
    target_type_label: types?.item_types?.[String(TARGET_TYPE)] ?? null,
    already_target_type: items.filter((i) => itemType(i) === String(TARGET_TYPE)).length,
  };
}

// Match coffee-category SKUs to iCount items; optionally apply item_type_id=8.
async function actionSetTypes(dryRun: boolean) {
  const sid = await login();
  const [coffeeSkus, items] = await Promise.all([coffeeCategorySkus(), getAllItems(sid)]);

  const icountSkus = new Set(items.map(itemSku).filter(Boolean));
  const matched = items
    .filter((i) => itemSku(i) && coffeeSkus.has(itemSku(i)))
    .map((i) => ({ id: itemId(i), sku: itemSku(i), name: norm(i.description), from: itemType(i) }));
  const toChange = matched.filter((m) => m.from !== String(TARGET_TYPE));
  const missingInIcount = [...coffeeSkus].filter((s) => !icountSkus.has(s));

  if (dryRun) {
    return {
      ok: true, dry_run: true, target_type_id: TARGET_TYPE,
      coffee_skus: coffeeSkus.size, matched: matched.length,
      to_change: toChange.length, already_set: matched.length - toChange.length,
      missing_in_icount: missingInIcount,
      preview: toChange,
    };
  }

  let updated = 0; const failures: any[] = [];
  for (const m of toChange) {
    const r = await icount("inventory/update_item", {
      sid, cid: CID, user: USER, pass: PASS,
      inventory_item_id: m.id, item_type_id: TARGET_TYPE,
    });
    if (r?.status === true) updated++;
    else failures.push({ id: m.id, sku: m.sku, reason: r?.reason ?? "?" });
  }
  return { ok: true, dry_run: false, target_type_id: TARGET_TYPE, matched: matched.length, updated, failed: failures.length, failures };
}

// Upload Woo images to a batch of iCount items. Stateless cursor via offset.
async function actionSetImages(opts: { offset: number; limit: number; dryRun: boolean; force: boolean }) {
  const { offset, limit, dryRun, force } = opts;
  const sid = await login();
  const all = (await getAllItems(sid))
    .filter((i) => itemSku(i))
    .sort((a, b) => Number(itemId(a)) - Number(itemId(b)));

  const batch = all.slice(offset, offset + limit);
  const results: any[] = [];
  let uploaded = 0, skippedHasImage = 0, skippedNoWoo = 0, failed = 0;

  for (const it of batch) {
    const id = itemId(it), sku = itemSku(it);
    const existing = await getItemImages(sid, id);
    if (existing.length && !force) { skippedHasImage++; results.push({ id, sku, status: "has_image" }); continue; }

    const imgUrl = await wooImageForSku(sku).catch(() => null);
    if (!imgUrl) { skippedNoWoo++; results.push({ id, sku, status: "no_woo_image" }); continue; }

    if (dryRun) { results.push({ id, sku, status: "would_upload", img: imgUrl }); continue; }

    try {
      const imgRes = await fetch(imgUrl);
      if (!imgRes.ok) { failed++; results.push({ id, sku, status: "fetch_failed" }); continue; }
      const buf = await imgRes.arrayBuffer();
      const mime = imgRes.headers.get("content-type") ?? "image/jpeg";
      const ext = (imgUrl.split("?")[0].split(".").pop() ?? "jpg").slice(0, 4);
      const up = await addItemImage(sid, id, buf, mime, `${sku}.${ext}`);
      if (up?.status === true) { uploaded++; results.push({ id, sku, status: "uploaded" }); }
      else { failed++; results.push({ id, sku, status: "upload_failed", reason: up?.reason ?? "?" }); }
    } catch (e) {
      failed++; results.push({ id, sku, status: "error", reason: String(e).slice(0, 120) });
    }
  }

  const nextOffset = offset + batch.length;
  return {
    ok: true, dry_run: dryRun, total_with_sku: all.length,
    offset, limit, processed: batch.length, next_offset: nextOffset, done: nextOffset >= all.length,
    uploaded, skipped_has_image: skippedHasImage, skipped_no_woo: skippedNoWoo, failed,
    results,
  };
}

// Replace each item's image(s) with a SQUARE 150x150 (POS-friendly). Deletes the
// existing full-size image, uploads the square variant named with a marker so
// re-runs skip already-squared items (idempotent / resumable). Batched by offset.
const SQ_MARKER = "_sq150";
async function actionSquareImages(opts: { offset: number; limit: number; dryRun: boolean }) {
  const { offset, limit, dryRun } = opts;
  const sid = await login();
  const all = (await getAllItems(sid))
    .filter((i) => itemSku(i))
    .sort((a, b) => Number(itemId(a)) - Number(itemId(b)));

  const batch = all.slice(offset, offset + limit);

  async function processOne(it: any): Promise<any> {
    const id = itemId(it), sku = itemSku(it);
    const existing = await getItemImages(sid, id);
    if (existing.some((i: any) => String(i.filename ?? "").includes(SQ_MARKER)))
      return { id, sku, status: "already_square" };
    const fullUrl = await wooImageForSku(sku).catch(() => null);
    if (!fullUrl) return { id, sku, status: "no_woo_image" };
    const sqUrl = await squareImageUrl(fullUrl);
    if (dryRun) return { id, sku, status: "would_square", img: sqUrl };
    try {
      const r = await fetch(sqUrl);
      if (!r.ok) return { id, sku, status: "fetch_failed" };
      const buf = await r.arrayBuffer();
      const mime = r.headers.get("content-type") ?? "image/jpeg";
      for (const img of existing) await deleteItemImage(sid, id, img.file_id);
      const up = await addItemImage(sid, id, buf, mime, `${sku}${SQ_MARKER}.jpg`);
      return up?.status === true
        ? { id, sku, status: "squared", img: sqUrl }
        : { id, sku, status: "upload_failed", reason: up?.reason ?? "?" };
    } catch (e) {
      return { id, sku, status: "error", reason: String(e).slice(0, 120) };
    }
  }

  // Concurrency pool — iCount latency dominates, so run several items in flight.
  const CONC = 6;
  const results: any[] = new Array(batch.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(CONC, batch.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= batch.length) break;
      results[i] = await processOne(batch[i]);
    }
  }));

  let squared = 0, alreadySquare = 0, skippedNoWoo = 0, failed = 0;
  for (const r of results) {
    if (r.status === "squared") squared++;
    else if (r.status === "already_square") alreadySquare++;
    else if (r.status === "no_woo_image") skippedNoWoo++;
    else if (r.status !== "would_square") failed++;
  }

  const nextOffset = offset + batch.length;
  return {
    ok: true, dry_run: dryRun, total_with_sku: all.length,
    offset, limit, processed: batch.length, next_offset: nextOffset, done: nextOffset >= all.length,
    squared, already_square: alreadySquare, skipped_no_woo: skippedNoWoo, failed, results,
  };
}

// Woo publish-status for a SKU (status=any so drafts are visible). Returns the
// status string + name, or null if the SKU isn't in Woo at all.
async function wooStatusForSku(sku: string): Promise<{ status: string; name: string } | null> {
  const products = await wooGet(`products?sku=${encodeURIComponent(sku)}&status=any&per_page=1`);
  if (Array.isArray(products) && products.length) return { status: String(products[0].status), name: String(products[0].name ?? "") };
  return null;
}

// Delete iCount items whose Woo product is draft/unpublished (status != publish).
// Items published, or with no Woo match, are left alone. iCount may block delete
// for items on past invoices — those are reported as delete_blocked, not forced.
async function actionDeleteHidden(opts: { offset: number; limit: number; dryRun: boolean }) {
  const { offset, limit, dryRun } = opts;
  const sid = await login();
  const all = (await getAllItems(sid)).filter((i) => itemSku(i)).sort((a, b) => Number(itemId(a)) - Number(itemId(b)));
  const batch = all.slice(offset, offset + limit);

  async function processOne(it: any): Promise<any> {
    const id = itemId(it), sku = itemSku(it), name = norm(it.description);
    let woo: { status: string; name: string } | null;
    try { woo = await wooStatusForSku(sku); }
    catch (e) { return { id, sku, status: "woo_error", reason: String(e).slice(0, 80) }; }
    if (!woo) return { id, sku, status: "no_woo_match" };
    if (woo.status === "publish") return { id, sku, status: "published" };
    if (dryRun) return { id, sku, name, woo_status: woo.status, status: "would_delete" };
    let r = await icount("inventory/delete_item", { sid, cid: CID, user: USER, pass: PASS, inventory_item_id: id });
    // iCount blocks deleting an item that still has stock — zero it then retry.
    if (r?.status !== true && /stock/i.test(String(r?.reason ?? ""))) {
      await icount("inventory/update_item", { sid, cid: CID, user: USER, pass: PASS, inventory_item_id: id, stock: 0 });
      r = await icount("inventory/delete_item", { sid, cid: CID, user: USER, pass: PASS, inventory_item_id: id });
    }
    return r?.status === true
      ? { id, sku, name, woo_status: woo.status, status: "deleted" }
      : { id, sku, name, woo_status: woo.status, status: "delete_blocked", reason: r?.reason ?? "?" };
  }

  const CONC = 6;
  const results: any[] = new Array(batch.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(CONC, batch.length) }, async () => {
    for (;;) { const i = cursor++; if (i >= batch.length) break; results[i] = await processOne(batch[i]); }
  }));

  const tally: Record<string, number> = {};
  for (const r of results) tally[r.status] = (tally[r.status] ?? 0) + 1;
  const nextOffset = offset + batch.length;
  return {
    ok: true, dry_run: dryRun, total_with_sku: all.length,
    offset, limit, processed: batch.length, next_offset: nextOffset, done: nextOffset >= all.length,
    tally, hits: results.filter((r) => ["would_delete", "deleted", "delete_blocked"].includes(r.status)),
  };
}

// Collect SKUs (parent + variations) of every Woo product whose NAME contains
// `keyword` (status=any so drafts count). Woo `search` also hits descriptions,
// so we re-filter on the product name.
async function wooSkusByName(keyword: string): Promise<{ skus: Set<string>; products: any[] }> {
  const skus = new Set<string>();
  const products: any[] = [];
  let page = 1;
  for (;;) {
    const list = await wooGet(`products?search=${encodeURIComponent(keyword)}&status=any&per_page=100&page=${page}`);
    if (!Array.isArray(list) || !list.length) break;
    for (const p of list) {
      if (!String(p.name ?? "").includes(keyword)) continue;
      if (norm(p.sku)) skus.add(norm(p.sku));
      products.push({ sku: norm(p.sku), name: p.name, status: p.status, type: p.type });
      if (p.type === "variable") {
        let vp = 1;
        for (;;) {
          const vars = await wooGet(`products/${p.id}/variations?per_page=100&page=${vp}`);
          if (!Array.isArray(vars) || !vars.length) break;
          for (const v of vars) if (norm(v.sku)) skus.add(norm(v.sku));
          if (vars.length < 100) break;
          vp++;
        }
      }
    }
    if (list.length < 100) break;
    page++;
  }
  return { skus, products };
}

// Delete iCount items whose Woo product NAME contains `keyword` (e.g. "אייס").
// Zeroes stock first (iCount blocks deleting items with stock), then deletes.
// The matched set is small, so it runs in a single call (concurrency pool).
async function actionDeleteNamed(keyword: string, dryRun: boolean) {
  const sid = await login();
  const { skus, products } = await wooSkusByName(keyword);
  const matched = (await getAllItems(sid)).filter((i) => itemSku(i) && skus.has(itemSku(i)));

  if (dryRun) {
    return {
      ok: true, dry_run: true, keyword, woo_name_matches: products.length, matched: matched.length,
      items: matched.map((it) => ({ id: itemId(it), sku: itemSku(it), name: norm(it.description), stock: it.stock })),
    };
  }

  async function processOne(it: any): Promise<any> {
    const id = itemId(it), sku = itemSku(it), name = norm(it.description);
    let r = await icount("inventory/delete_item", { sid, cid: CID, user: USER, pass: PASS, inventory_item_id: id });
    if (r?.status !== true && /stock/i.test(String(r?.reason ?? ""))) {
      await icount("inventory/update_item", { sid, cid: CID, user: USER, pass: PASS, inventory_item_id: id, stock: 0 });
      r = await icount("inventory/delete_item", { sid, cid: CID, user: USER, pass: PASS, inventory_item_id: id });
    }
    return r?.status === true
      ? { id, sku, name, status: "deleted" }
      : { id, sku, name, status: "delete_blocked", reason: r?.reason ?? "?" };
  }

  const CONC = 6;
  const results: any[] = new Array(matched.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(CONC, matched.length) }, async () => {
    for (;;) { const i = cursor++; if (i >= matched.length) break; results[i] = await processOne(matched[i]); }
  }));
  const deleted = results.filter((r) => r.status === "deleted").length;
  return { ok: true, dry_run: false, keyword, matched: matched.length, deleted, blocked: results.length - deleted, results };
}

// Sync NON-COFFEE stock: set each iCount item's stock = its Woo stock_quantity.
// Coffee items (SKU in the specialty-coffee category) are skipped — their master
// is CoffeeFlow packed_stock. Items with no Woo match or untracked Woo stock are
// left unchanged. Batched + concurrent. dry-run shows current -> target.
async function actionStockSync(opts: { offset: number; limit: number; dryRun: boolean }) {
  const { offset, limit, dryRun } = opts;
  const sid = await login();
  const [coffeeSkus, allRaw] = await Promise.all([coffeeCategorySkus(), getAllItems(sid)]);
  const all = allRaw.filter((i) => itemSku(i)).sort((a, b) => Number(itemId(a)) - Number(itemId(b)));
  const batch = all.slice(offset, offset + limit);

  async function processOne(it: any): Promise<any> {
    const id = itemId(it), sku = itemSku(it);
    const current = Number(it.stock ?? 0);
    if (coffeeSkus.has(sku)) return { id, sku, status: "skip_coffee" };
    let wooStock: number | null | undefined;
    try { wooStock = await wooStockForSku(sku); }
    catch (e) { return { id, sku, status: "woo_error", reason: String(e).slice(0, 80) }; }
    if (wooStock === undefined) return { id, sku, status: "no_woo_match" };
    if (wooStock === null) return { id, sku, status: "woo_untracked" };
    if (current === wooStock) return { id, sku, status: "in_sync", stock: current };
    if (dryRun) return { id, sku, status: "would_set", from: current, to: wooStock };
    const r = await icount("inventory/update_item", { sid, cid: CID, user: USER, pass: PASS, inventory_item_id: id, stock: wooStock });
    return r?.status === true
      ? { id, sku, status: "set", from: current, to: wooStock }
      : { id, sku, status: "set_failed", from: current, to: wooStock, reason: r?.reason ?? "?" };
  }

  const CONC = 6;
  const results: any[] = new Array(batch.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(CONC, batch.length) }, async () => {
    for (;;) { const i = cursor++; if (i >= batch.length) break; results[i] = await processOne(batch[i]); }
  }));

  const tally: Record<string, number> = {};
  for (const r of results) tally[r.status] = (tally[r.status] ?? 0) + 1;
  const nextOffset = offset + batch.length;
  return {
    ok: true, dry_run: dryRun, total_with_sku: all.length,
    offset, limit, processed: batch.length, next_offset: nextOffset, done: nextOffset >= all.length,
    tally, changes: results.filter((r) => r.status === "would_set" || r.status === "set" || r.status === "set_failed"),
  };
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
  const action = String(body.action ?? "status");

  try {
    switch (action) {
      case "status":     return json(await actionStatus());
      case "set_types":  return json(await actionSetTypes(body.dry_run !== false)); // default dry-run
      case "set_images": return json(await actionSetImages({
        offset: Number(body.offset ?? 0),
        limit:  Math.min(Number(body.limit ?? 15), 40),
        dryRun: body.dry_run !== false, // default dry-run
        force:  body.force === true,
      }));
      case "square_images": return json(await actionSquareImages({
        offset: Number(body.offset ?? 0),
        limit:  Math.min(Number(body.limit ?? 30), 60),
        dryRun: body.dry_run !== false, // default dry-run
      }));
      case "delete_hidden": return json(await actionDeleteHidden({
        offset: Number(body.offset ?? 0),
        limit:  Math.min(Number(body.limit ?? 30), 60),
        dryRun: body.dry_run !== false, // default dry-run
      }));
      case "coffee_sales": return json(await actionCoffeeSales(String(body.from_date ?? ""), String(body.to_date ?? "")));
      case "coffee_sales_backfill": return json(await actionCoffeeSalesBackfill(
        String(body.from_date ?? ""), String(body.to_date ?? ""),
        { force: body.force === true, limit: Number(body.limit ?? 45) },
      ));
      case "delete_named": return json(await actionDeleteNamed(String(body.keyword ?? ""), body.dry_run !== false));
      case "stock_sync": return json(await actionStockSync({
        offset: Number(body.offset ?? 0),
        limit:  Math.min(Number(body.limit ?? 30), 60),
        dryRun: body.dry_run !== false, // default dry-run
      }));
      case "create_missing": return json(await actionCreateMissing({
        dryRun: body.dry_run !== false, // default dry-run
        limit:  Math.min(Number(body.limit ?? 25), 100),
      }));
      default: return json({ error: `unknown action: ${action}` }, 400);
    }
  } catch (e) {
    return json({ error: String(e instanceof Error ? e.message : e) }, 500);
  }
});
