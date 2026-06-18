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

function norm(s: unknown): string { return String(s ?? "").trim(); }

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

// ── Woo helpers ─────────────────────────────────────────────────────────────
async function wooGet(pathAndQuery: string): Promise<any> {
  const res = await fetch(`${WOO_URL}/wp-json/wc/v3/${pathAndQuery}`, {
    headers: { Authorization: `Basic ${wooAuth}` },
    redirect: "manual",
  });
  if (res.status >= 300 && res.status < 400)
    throw new Error(`Woo redirect ${res.status} on ${pathAndQuery} — set WOO_URL to canonical host`);
  const text = await res.text();
  if (!res.ok) throw new Error(`Woo ${pathAndQuery} HTTP ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

// Collect SKUs of every product+variation in the specialty-coffee category.
async function coffeeCategorySkus(): Promise<Set<string>> {
  const cats = await wooGet(`products/categories?slug=${encodeURIComponent(COFFEE_CATEGORY_SLUG)}&per_page=100`);
  if (!Array.isArray(cats) || !cats.length) throw new Error(`Woo category not found: ${COFFEE_CATEGORY_SLUG}`);
  const catId = cats[0].id;
  const skus = new Set<string>();
  let page = 1;
  for (;;) {
    const products = await wooGet(`products?category=${catId}&per_page=100&page=${page}&status=publish`);
    if (!Array.isArray(products) || !products.length) break;
    for (const p of products) {
      if (norm(p.sku)) skus.add(norm(p.sku));
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
    if (products.length < 100) break;
    page++;
  }
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

function itemSku(it: any): string { return norm(it.sku ?? it.makat ?? it.barcode); }
function itemId(it: any): string { return String(it.inventory_item_id ?? it.id ?? ""); }
function itemType(it: any): string { return String(it.item_type_id ?? ""); }

// ── Actions ─────────────────────────────────────────────────────────────────

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
      default: return json({ error: `unknown action: ${action}` }, 400);
    }
  } catch (e) {
    return json({ error: String(e instanceof Error ? e.message : e) }, 500);
  }
});
