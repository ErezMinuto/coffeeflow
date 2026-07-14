/**
 * CoffeeFlow — Manual Stock Update (Supabase Edge Function)
 *
 * Called from the admin "Stock" pages. Routes each change to its master system:
 *   • SKU is a coffee bag (in product_sku_map) → adjust CoffeeFlow products.packed_stock
 *   • otherwise                                → adjust WooCommerce stock_quantity
 *
 * Every change is written to inventory_adjustments for audit.
 *
 * iCount mirroring was removed 2026-07-12 (Minuto stopped using iCount for stock).
 * Buying-cost tracking (previously mastered in iCount's cost_amount) was dropped
 * with it — goods receipt now records quantity + optional sale price to Woo only.
 *
 * Deploy:
 *   supabase functions deploy stock-update --project-ref <ref> --no-verify-jwt
 */

import { serve }        from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPA_URL = Deno.env.get("SUPABASE_URL")              ?? "";
const SUPA_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const WOO_URL  = (Deno.env.get("WOO_URL") ?? "").replace(/\/+$/, "");
const WOO_KEY  = Deno.env.get("WOO_KEY")                   ?? "";
const WOO_SEC  = Deno.env.get("WOO_SECRET")                ?? "";

const supabase = createClient(SUPA_URL, SUPA_KEY);
const wooAuth  = btoa(`${WOO_KEY}:${WOO_SEC}`);

// ── MFlow (ERP) config ───────────────────────────────────────────────────────
// Minuto's business inventory system. Coffee-bag stock master stays CoffeeFlow
// (products.packed_stock); we PUSH the absolute value to MFlow, which then
// auto-syncs it to WooCommerce. Auth = public/secret key pair (NOT the old
// scraper's email/password). REST v3, absolute-set stock writes.
const MFLOW_BASE = (Deno.env.get("MFLOW_BASE") ?? "https://my.mflow.co.il").replace(/\/+$/, "");
const MFLOW_PUB  = Deno.env.get("MFLOW_PUBLIC_KEY") ?? "";
const MFLOW_SEC  = Deno.env.get("MFLOW_SECRET_KEY") ?? "";
// The roasted-bags warehouse (discovery: the only MFlow warehouse, "מינוטו קפה בע"מ").
const MFLOW_LOCATION_ID = Number(Deno.env.get("MFLOW_LOCATION_ID") ?? "706");
const mflowConfigured = () => !!(MFLOW_PUB && MFLOW_SEC);

// Build the CoffeeFlow-product → MFlow-product-id map. A coffee bag is any product
// with at least one SKU in product_sku_map; we resolve it to an MFlow product by
// trying each of its SKUs against MFlow's SKU→id catalog (/products/ids).
async function mflowCoffeeTargets(onlyIds: number[] | null): Promise<{
  targets: { id: number; name: string; packed_stock: number; mflowId: number | null; usedSku: string | null; skus: string[] }[];
}> {
  const { data: prods } = await supabase
    .from("products").select("id, name, packed_stock").order("id");
  const { data: skuRows } = await supabase
    .from("product_sku_map").select("sku, product_id");
  const skusByProduct = new Map<number, string[]>();
  for (const r of skuRows ?? []) {
    const arr = skusByProduct.get(r.product_id) ?? [];
    arr.push(String(r.sku).trim());
    skusByProduct.set(r.product_id, arr);
  }
  const ids = await mflow("/api/v3/products/ids");
  const mflowBySku = new Map<string, number>();
  for (const p of (ids.data?.data?.products ?? [])) if (p?.sku) mflowBySku.set(String(p.sku).trim(), Number(p.id));

  const idSet = onlyIds && onlyIds.length ? new Set(onlyIds) : null;
  const targets = (prods ?? [])
    .filter((p: any) => skusByProduct.has(p.id) && (!idSet || idSet.has(p.id)))
    .map((p: any) => {
      const skus = skusByProduct.get(p.id) ?? [];
      let mflowId: number | null = null, usedSku: string | null = null;
      for (const s of skus) if (mflowBySku.has(s)) { mflowId = mflowBySku.get(s)!; usedSku = s; break; }
      return { id: p.id, name: String(p.name ?? "").slice(0, 45), packed_stock: Math.max(0, Math.round(Number(p.packed_stock ?? 0))), mflowId, usedSku, skus };
    });
  return { targets };
}

// MFlow rate limit is 30 requests / MINUTE per key. Throttle to ~27/min (a
// 2.2s min gap between calls) so we never trip it, and retry on a 429 (wait for
// the window to roll over). Module-level cursor persists across calls on a warm
// instance. Keep per-invocation call counts modest (batch big jobs) so the edge
// wall-clock isn't exceeded at 2.2s/call.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let _mflowLastCall = 0;
const MFLOW_MIN_GAP_MS = 2200;
async function mflow(path: string, opts: { method?: string; body?: unknown } = {}, tries = 5): Promise<{ status: number; ok: boolean; data: any }> {
  for (let attempt = 0; attempt < tries; attempt++) {
    const gap = _mflowLastCall + MFLOW_MIN_GAP_MS - Date.now();
    if (gap > 0) await sleep(gap);
    _mflowLastCall = Date.now();
    const res = await fetch(`${MFLOW_BASE}${path}`, {
      method: opts.method ?? "GET",
      headers: {
        "x-mflow-public-key": MFLOW_PUB,
        "x-mflow-secret-key": MFLOW_SEC,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    let data: any;
    try { data = JSON.parse(text); } catch { data = { _raw: text.slice(0, 600) }; }
    if (res.status === 429 && attempt < tries - 1) { await sleep(8000); continue; } // window rollover
    return { status: res.status, ok: res.ok, data };
  }
  return { status: 429, ok: false, data: { message: "rate limited after retries" } };
}

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// ── WooCommerce helpers (variation-aware) ────────────────────────────────────
async function wooFindBySku(sku: string) {
  const url = `${WOO_URL}/wp-json/wc/v3/products?sku=${encodeURIComponent(sku)}&per_page=1`;
  const res = await fetch(url, { headers: { Authorization: `Basic ${wooAuth}` } });
  if (!res.ok) throw new Error(`WC lookup failed (${res.status})`);
  const data = await res.json();
  if (!Array.isArray(data) || data.length === 0) return null;
  const p = data[0];
  return {
    id: p.id as number,
    parentId: Number(p.parent_id ?? 0),
    name: p.name as string,
    manageStock: p.manage_stock === true,
    stockQuantity: p.stock_quantity === null ? null : Number(p.stock_quantity),
    regularPrice: p.regular_price === "" || p.regular_price == null ? null : String(p.regular_price),
    price: p.price === "" || p.price == null ? null : String(p.price),
  };
}

async function wooSetPrice(productId: number, parentId: number, regularPrice: number) {
  const url = parentId > 0
    ? `${WOO_URL}/wp-json/wc/v3/products/${parentId}/variations/${productId}`
    : `${WOO_URL}/wp-json/wc/v3/products/${productId}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: { Authorization: `Basic ${wooAuth}`, "Content-Type": "application/json" },
    body: JSON.stringify({ regular_price: String(regularPrice) }),
  });
  if (!res.ok) throw new Error(`WC price write failed (${res.status}) ${(await res.text()).slice(0, 160)}`);
  const p = await res.json();
  return p.regular_price === "" || p.regular_price == null ? null : String(p.regular_price);
}

async function wooSetStock(productId: number, parentId: number, qty: number) {
  const url = parentId > 0
    ? `${WOO_URL}/wp-json/wc/v3/products/${parentId}/variations/${productId}`
    : `${WOO_URL}/wp-json/wc/v3/products/${productId}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: { Authorization: `Basic ${wooAuth}`, "Content-Type": "application/json" },
    body: JSON.stringify({ stock_quantity: qty, manage_stock: true }),
  });
  if (!res.ok) throw new Error(`WC write failed (${res.status}) ${(await res.text()).slice(0, 160)}`);
  const p = await res.json();
  return p.stock_quantity === null ? null : Number(p.stock_quantity);
}

// ── Product editor: overwrite price and/or stock on WooCommerce ──────────────
// Absolute set (not a delta). Blank field = leave untouched. Coffee bags
// (in product_sku_map) are price-only here — their stock master is CoffeeFlow
// packed_stock (packing flow), so stock edits are skipped for them.
async function handleProductSet(body: any) {
  const dryRun = body.dry_run !== false;
  const sku = String(body.sku ?? "").trim();
  if (!sku) return json({ error: "sku is required" }, 400);

  const hasPrice = body.price !== undefined && body.price !== null && String(body.price).trim() !== "";
  const hasStock = body.stock !== undefined && body.stock !== null && String(body.stock).trim() !== "";
  const price = hasPrice ? Number(body.price) : null;
  const stock = hasStock ? Number(body.stock) : null;
  if (hasPrice && (!Number.isFinite(price as number) || (price as number) < 0)) return json({ error: "price must be a non-negative number" }, 400);
  if (hasStock && (!Number.isFinite(stock as number) || (stock as number) < 0)) return json({ error: "stock must be a non-negative number" }, 400);
  // For a real write we need at least one field; a dry-run with no fields just
  // reads current values (used to populate the editor when a product is picked).
  if (!dryRun && !hasPrice && !hasStock) return json({ error: "nothing to update — enter a price and/or a stock value" }, 400);

  // Coffee bag? → price-only here.
  const { data: skuMap } = await supabase.from("product_sku_map").select("product_id").eq("sku", sku).maybeSingle();
  const isCoffee = !!skuMap;

  // Woo current
  let wc: Awaited<ReturnType<typeof wooFindBySku>> = null;
  let wooErr: string | null = null;
  try { wc = await wooFindBySku(sku); } catch (e) { wooErr = (e as Error).message; }

  const wooView = wc ? { name: wc.name, id: wc.id, is_variation: wc.parentId > 0, price: wc.regularPrice, stock: wc.stockQuantity, manage_stock: wc.manageStock } : (wooErr ? { status: "error", error: wooErr } : { status: "no_woo_match" });
  const name = wc?.name || null;

  const base = {
    ok: true, dry_run: dryRun, sku, name, is_coffee: isCoffee,
    intended: { price: hasPrice ? price : null, stock: hasStock ? stock : null },
    woo: wooView,
    stock_skipped_coffee: isCoffee && hasStock,
  };

  if (dryRun) return json(base);

  const applied: any = { woo: {} };
  // ── PRICE ──
  if (hasPrice && wc) {
    try { applied.woo.price = await wooSetPrice(wc.id, wc.parentId, price as number); } catch (e) { applied.woo.price_error = (e as Error).message; }
  }
  // ── STOCK (non-coffee only) ──
  if (hasStock && !isCoffee) {
    if (wc && wc.manageStock && wc.stockQuantity !== null) {
      try { applied.woo.stock = await wooSetStock(wc.id, wc.parentId, stock as number); } catch (e) { applied.woo.stock_error = (e as Error).message; }
    } else if (wc) { applied.woo.stock_skipped = "manage_stock_off"; }
  }

  // ── Audit ──
  await supabase.from("inventory_adjustments").insert({
    source: "edit", sku, description: name,
    qty_delta: hasStock && !isCoffee && wc && wc.stockQuantity !== null ? (stock as number) - wc.stockQuantity : 0,
    woo_product_id: wc?.id ?? null,
    woo_before: wc?.stockQuantity ?? null,
    woo_after: hasStock && !isCoffee ? applied.woo.stock ?? null : null,
    applied: true,
    note: `price/stock edit${hasPrice ? ` · price→${price}` : ""}${hasStock ? (isCoffee ? " · coffee stock skipped" : ` · stock→${stock}`) : ""}`.slice(0, 280),
  });

  return json({ ...base, applied });
}

// ── Goods receipt (non-coffee only) ──────────────────────────────────────────
// For each line: WooCommerce is master for stock (read current + add qty) and for
// the sale price. Coffee bags (in product_sku_map) are rejected — those stay on
// the packing/packed_stock flow.
//
// Each item may carry, alongside {sku, qty}:
//   • price — new sale price (VAT-inclusive consumer price). Written to Woo.
//             Omit/blank/unchanged → left as-is.
// A dry run writes nothing; it returns each line's current sale price so the page
// can pre-fill the editable field.
async function handleReceive(body: any) {
  const dryRun = body.dry_run !== false; // default to a safe preview
  const supplier = String(body.supplier ?? "").trim() || null;
  const rawItems: any[] = Array.isArray(body.items) ? body.items : [];
  const num = (v: unknown) => (v === undefined || v === null || String(v).trim() === "" ? null : Number(v));
  const items = rawItems
    .map((it) => ({ sku: String(it.sku ?? "").trim(), qty: Number(it.qty), price: num(it.price) }))
    .filter((it) => it.sku);
  if (items.length === 0) return json({ error: "items[] is required (each {sku, qty})" }, 400);
  for (const it of items) {
    if (!Number.isFinite(it.qty) || it.qty <= 0)
      return json({ error: `qty for SKU "${it.sku}" must be a positive number` }, 400);
    if (it.price !== null && (!Number.isFinite(it.price) || it.price < 0))
      return json({ error: `price for SKU "${it.sku}" must be a non-negative number` }, 400);
  }

  const results: any[] = [];
  for (const { sku, qty, price } of items) {
    const line: any = { sku, qty, woo: null, status: "ok" };
    try {
      // Coffee bag? → reject (packing flow owns these)
      const { data: skuMap } = await supabase
        .from("product_sku_map").select("product_id").eq("sku", sku).maybeSingle();
      if (skuMap) { line.status = "rejected_coffee"; results.push(line); continue; }

      // ── WooCommerce (master: stock + sale price) ──
      const wc = await wooFindBySku(sku);
      const saleBefore = wc?.regularPrice != null ? Number(wc.regularPrice) : null;
      const wantSale   = price !== null && (saleBefore === null || price !== saleBefore);

      line.current = { sale: saleBefore };
      if (wantSale) line.intended_price = price;

      if (!wc) {
        line.woo = { status: "no_woo_match" };
      } else if (!wc.manageStock || wc.stockQuantity === null) {
        line.name = wc.name;
        line.woo = { status: "untracked", name: wc.name };
      } else {
        line.name = wc.name;
        const before = wc.stockQuantity;
        const after  = before + qty;
        if (!dryRun) {
          const written = await wooSetStock(wc.id, wc.parentId, after);
          line.woo = { status: "updated", before, after: written, id: wc.id, is_variation: wc.parentId > 0 };
        } else {
          line.woo = { status: "would_update", before, after, is_variation: wc.parentId > 0 };
        }
      }
      // sale price → Woo (real runs only)
      if (wantSale && wc && !dryRun) {
        try { line.woo = { ...(line.woo ?? {}), sale_after: await wooSetPrice(wc.id, wc.parentId, price as number) }; }
        catch (e) { line.woo = { ...(line.woo ?? {}), sale_error: (e as Error).message }; }
      }

      // overall line status
      const wooFailed = line.woo && !["updated", "would_update"].includes(line.woo.status);
      if (wooFailed) line.status = "no_match";

      // ── Audit (real runs only) ──
      if (!dryRun && line.status !== "rejected_coffee") {
        await supabase.from("inventory_adjustments").insert({
          source: "receive", supplier, sku, description: line.name ?? null, qty_delta: qty,
          woo_product_id: line.woo?.id ?? null,
          woo_before: line.woo?.before ?? null, woo_after: line.woo?.after ?? null,
          sale_price: wantSale ? price : null,
          applied: line.woo?.status === "updated",
          note: `supplier intake${wantSale ? ` · price→${price}` : ""}`,
        });
      }
    } catch (e) {
      line.status = "error";
      line.error = (e as Error).message;
      console.error(`receive ${sku} error:`, (e as Error).message);
    }
    results.push(line);
  }

  return json({ ok: true, dry_run: dryRun, supplier, count: results.length, results });
}

// ── MFlow discovery (READ-ONLY) ──────────────────────────────────────────────
// One-shot reconnaissance before wiring the stock push: matches our coffee bags
// to MFlow products by SKU, lists warehouses (to pick the roasted-bags location),
// and samples one product's /stock/list to learn its single/variable shape. No
// writes. Safe to run any time.
async function handleMflowDiscover(_body: any) {
  if (!mflowConfigured()) return json({ error: "MFlow not configured (set MFLOW_PUBLIC_KEY / MFLOW_SECRET_KEY)" }, 500);

  // Our coffee bags + every SKU that maps to each (product_sku_map is authoritative;
  // products.sku is lossy — leading zeros stripped).
  const { data: prods } = await supabase
    .from("products").select("id, name, size, packed_stock").order("id");
  const { data: skuRows } = await supabase
    .from("product_sku_map").select("sku, product_id, label");
  const skusByProduct = new Map<number, { sku: string; label: string }[]>();
  for (const r of skuRows ?? []) {
    const arr = skusByProduct.get(r.product_id) ?? [];
    arr.push({ sku: String(r.sku).trim(), label: r.label });
    skusByProduct.set(r.product_id, arr);
  }

  // MFlow SKU → product_id (one lightweight call for the whole catalog).
  const ids = await mflow("/api/v3/products/ids");
  const mflowProducts: any[] = ids.data?.data?.products ?? [];
  const mflowBySku = new Map<string, number>();
  for (const p of mflowProducts) if (p?.sku) mflowBySku.set(String(p.sku).trim(), Number(p.id));

  // Warehouses (to identify the roasted-bags location_id).
  const warehouses = await mflow("/api/v3/business-locations/warehouses");

  // Match every coffee product by trying each of its SKUs.
  const products = (prods ?? []).map((p: any) => {
    const skus = skusByProduct.get(p.id) ?? [];
    let matched_sku: string | null = null, mflow_product_id: number | null = null;
    for (const s of skus) {
      if (mflowBySku.has(s.sku)) { matched_sku = s.sku; mflow_product_id = mflowBySku.get(s.sku)!; break; }
    }
    return {
      product_id: p.id, name: String(p.name ?? "").slice(0, 60), size: p.size, packed_stock: p.packed_stock,
      our_skus: skus.map((s) => s.sku), matched_sku, mflow_product_id,
    };
  });

  // Probe EVERY matched product's stock/list to learn (a) whether manage-stock is
  // enabled (the write endpoint needs enable_stock=1), and (b) the single/variable
  // shape + location_ids. Sequential — one-off recon, ~18 calls.
  const stock_probe: any[] = [];
  let manage_off = 0, readable = 0;
  for (const m of products) {
    if (!m.mflow_product_id) continue;
    const r = await mflow(`/api/v3/products/${m.mflow_product_id}/stock/list`);
    const manageDisabled = r.status === 422 && /manage stock/i.test(String(r.data?.message ?? ""));
    if (manageDisabled) manage_off++;
    if (r.ok) readable++;
    stock_probe.push({
      product_id: m.product_id, mflow_product_id: m.mflow_product_id, sku: m.matched_sku,
      status: r.status,
      manage_stock_enabled: !manageDisabled,
      product_type: r.ok ? r.data?.data?.product_type ?? null : null,
      locations: r.ok ? (r.data?.data?.stocks ?? r.data?.data?.variations ?? null) : null,
      message: r.ok ? null : (r.data?.message ?? null),
    });
  }

  return json({
    ok: true,
    ids_call: { status: ids.status, ok: ids.ok, total: ids.data?.data?.total ?? mflowProducts.length },
    warehouses: { status: warehouses.status, ok: warehouses.ok, data: warehouses.data?.data ?? warehouses.data },
    coffee_products: products.length,
    matched: products.filter((m) => m.mflow_product_id).length,
    unmatched: products.filter((m) => !m.mflow_product_id).length,
    manage_stock_off: manage_off,
    stock_readable: readable,
    products,
    stock_probe,
  });
}

// Parse an optional CoffeeFlow product-id filter from the request body: a
// product_ids array, a single product_id, else null (= all coffee bags).
function parseIds(body: any): number[] | null {
  if (Array.isArray(body.product_ids) && body.product_ids.length) return body.product_ids.map(Number).filter((n: number) => Number.isFinite(n));
  if (body.product_id != null) return [Number(body.product_id)];
  return null;
}

// ── MFlow enable stock-management (WRITE) ────────────────────────────────────
// Flip manage_stock=true on coffee products via the product-update endpoint.
// Verified once (Intenso) that this is a clean partial update — variations are
// untouched — so the rollout just PUTs manage_stock per product (1 call each,
// rate-throttled). dry_run (default) previews. product_id / product_ids limit
// the set; all:true does every mapped bag.
async function handleMflowEnableStock(body: any) {
  if (!mflowConfigured()) return json({ error: "MFlow not configured" }, 500);
  const dryRun = body.dry_run !== false;
  const ids = parseIds(body);
  const doAll = body.all === true;
  if (!ids && !doAll) return json({ error: "pass product_id / product_ids or all:true" }, 400);

  const { targets } = await mflowCoffeeTargets(doAll ? null : ids);
  const results: any[] = [];
  let enabled = 0, failed = 0, skipped = 0;
  for (const t of targets) {
    if (!t.mflowId) { skipped++; results.push({ product_id: t.id, name: t.name, status: "no_mflow_match" }); continue; }
    if (dryRun) { results.push({ product_id: t.id, name: t.name, mflow_product_id: t.mflowId, status: "would_enable" }); continue; }
    const upd = await mflow(`/api/v3/products/update/${t.mflowId}`, { method: "PUT", body: { manage_stock: true } });
    if (upd.ok) { enabled++; results.push({ product_id: t.id, name: t.name, mflow_product_id: t.mflowId, status: "enabled" }); }
    else { failed++; results.push({ product_id: t.id, name: t.name, mflow_product_id: t.mflowId, status: "failed", http: upd.status, message: upd.data?.message ?? null }); }
  }
  console.log(`[mflow_enable_stock] dry=${dryRun} targets=${targets.length} enabled=${enabled} failed=${failed} skipped=${skipped}`);
  return json({ ok: true, dry_run: dryRun, targets: targets.length, enabled, failed, skipped, results });
}

// ── MFlow product search (READ-ONLY) ─────────────────────────────────────────
// Find MFlow products by name/SKU keyword — used to resolve SKUs for coffee bags
// that aren't yet in product_sku_map.
async function handleMflowSearch(body: any) {
  if (!mflowConfigured()) return json({ error: "MFlow not configured" }, 500);
  const term = String(body.search ?? body.q ?? "").trim();
  if (!term) return json({ error: "search term required (search)" }, 400);
  const r = await mflow(`/api/v3/products/search?search=${encodeURIComponent(term)}&per_page=25`);
  return json({ ok: r.ok, status: r.status, results: r.data?.data ?? r.data });
}

// ── MFlow sells fetch (READ-ONLY inspection) ─────────────────────────────────
// Pull recent sells and match coffee-bag lines by MFlow product_id (SKU prefixes
// overlap across coffees, so product_id is the only safe key). Reports the doc-type
// mix + per-product units so we can decide which doc types actually move stock,
// BEFORE wiring the packed_stock decrement. No writes.
async function handleMflowSyncSells(body: any) {
  if (!mflowConfigured()) return json({ error: "MFlow not configured" }, 500);
  const days = Number(body.days ?? 3);
  const toDate = String(body.to_date ?? new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Jerusalem" }));
  const fromDate = String(body.from_date ?? new Date(Date.now() - days * 86400000).toLocaleDateString("en-CA", { timeZone: "Asia/Jerusalem" }));

  // MFlow product_id → CoffeeFlow product (via product_sku_map + /products/ids).
  const { data: skuRows } = await supabase.from("product_sku_map").select("sku, product_id");
  const skuToProduct = new Map<string, number>();
  for (const r of skuRows ?? []) skuToProduct.set(String(r.sku).trim(), r.product_id);
  const { data: prods } = await supabase.from("products").select("id, name, packed_stock, sku");
  const cfById = new Map<number, any>((prods ?? []).map((p: any) => [p.id, p]));
  const idsRes = await mflow("/api/v3/products/ids");
  const mflowIdToCF = new Map<number, number>();
  for (const p of (idsRes.data?.data?.products ?? [])) {
    const cf = skuToProduct.get(String(p.sku).trim());
    if (cf != null) mflowIdToCF.set(Number(p.id), cf);
  }

  // Fetch sells in the window (paginated, bounded). Live shape: data.data.list[]
  // with data.data.pagination; line items are in sell_items[].
  const sells: any[] = [];
  for (let page = 1; page <= 40; page++) {
    const r = await mflow(`/api/v3/sells/list?start_date=${fromDate}&end_date=${toDate}&per_page=50&page=${page}`);
    if (!r.ok) return json({ ok: false, error: "sells fetch failed", http: r.status, message: r.data?.message ?? null, from_date: fromDate, to_date: toDate });
    const c = r.data?.data;
    const list = Array.isArray(c?.list) ? c.list : (Array.isArray(c) ? c : []);
    if (!list.length) break;
    sells.push(...list);
    const lastPage = c?.pagination?.last_page;
    if (lastPage && page >= lastPage) break;
    if (list.length < 50) break;
  }

  // Idempotency: which of these sells have we already applied?
  const apply = body.apply === true;
  const sellIds = sells.map((s: any) => Number(s.id)).filter((n: number) => Number.isFinite(n));
  const processed = new Set<number>();
  for (let i = 0; i < sellIds.length; i += 300) {
    const { data: seen } = await supabase.from("mflow_sell_events").select("mflow_sell_id").in("mflow_sell_id", sellIds.slice(i, i + 300));
    for (const r of seen ?? []) processed.add(Number(r.mflow_sell_id));
  }

  // Classify each sell + match coffee lines by MFlow product_id. A completed
  // "sell" reduces stock; a return (return_parent_id / is_return_and_credit_order /
  // status "הוחזר") adds it back; drafts are ignored. Signed qty: sale negative.
  const classTally: Record<string, number> = {};
  const perProduct = new Map<number, { name: string; units: number }>();  // net bags sold (report)
  const sample: any[] = [];
  const toApply: { id: number; type: string; status: string; isReturn: boolean; source: string; date: any; delta: Map<number, number> }[] = [];
  let alreadyProcessed = 0, skippedDraft = 0;

  for (const s of sells) {
    const statusStr = String(s.sell_status?.status ?? s.status ?? "?");
    const isReturn = s.return_parent_id != null || s?.flags?.is_return_and_credit_order === true || statusStr === "הוחזר";
    const isDraft = statusStr === "draft" || s.status === "draft";
    const klass = `${s.type ?? "?"}/${statusStr}${isReturn ? "/return" : ""}`;
    classTally[klass] = (classTally[klass] ?? 0) + 1;

    const lines = Array.isArray(s.sell_items) ? s.sell_items : [];
    const coffee: any[] = [];
    const delta = new Map<number, number>();
    for (const ln of lines) {
      const cf = mflowIdToCF.get(Number(ln.product_id));
      if (cf == null) continue;
      const raw = Number(ln.quantity ?? 0);
      const signed = isReturn ? raw : -raw;                 // sale reduces packed_stock
      coffee.push({ cf_product: cf, sku: ln.sku, qty: raw, signed });
      delta.set(cf, (delta.get(cf) ?? 0) + signed);
      const cur = perProduct.get(cf) ?? { name: cfById.get(cf)?.name?.slice(0, 28) ?? String(cf), units: 0 };
      cur.units += -signed;                                  // report "bags sold" as positive
      perProduct.set(cf, cur);
    }
    if (!coffee.length) continue;
    if (processed.has(Number(s.id))) { alreadyProcessed++; continue; }
    if (isDraft) { skippedDraft++; continue; }
    toApply.push({ id: Number(s.id), type: String(s.type ?? ""), status: statusStr, isReturn, source: String(s.sell_source ?? ""), date: s.transaction_date, delta });
    if (sample.length < 25) sample.push({ sell_id: s.id, status: statusStr, is_return: isReturn, source: s.sell_source, date: s.transaction_date, coffee: coffee.map((c) => ({ cf: c.cf_product, signed: c.signed })) });
  }

  // Apply: net the new sells per product, adjust packed_stock (clamp ≥0), record each sell.
  let applied = 0;
  const appliedByProduct = new Map<number, number>();
  for (const t of toApply) for (const [cf, dq] of t.delta) appliedByProduct.set(cf, (appliedByProduct.get(cf) ?? 0) + dq);
  if (apply && toApply.length) {
    for (const [cf, dq] of appliedByProduct) {
      if (!dq) continue;
      const before = Number(cfById.get(cf)?.packed_stock ?? 0);
      const after = Math.max(0, before + dq);
      await supabase.from("products").update({ packed_stock: after }).eq("id", cf);
      await supabase.from("inventory_adjustments").insert({
        source: "mflow_sell", sku: cfById.get(cf)?.sku ?? String(cf), description: cfById.get(cf)?.name ?? null,
        qty_delta: dq, packed_before: before, packed_after: after, applied: true,
        note: `mflow sells sync ${fromDate}..${toDate}`,
      });
    }
    const rows = toApply.map((t) => ({
      mflow_sell_id: t.id, type: t.type, status: t.status, is_return: t.isReturn, source: t.source,
      transaction_date: t.date, coffee_delta: Object.fromEntries(t.delta), applied: true,
    }));
    for (let i = 0; i < rows.length; i += 200) await supabase.from("mflow_sell_events").insert(rows.slice(i, i + 200));
    applied = toApply.length;
  }

  return json({
    ok: true, apply, from_date: fromDate, to_date: toDate,
    sells_fetched: sells.length, class_tally: classTally,
    coffee_products_mapped: mflowIdToCF.size,
    new_eligible: toApply.length, already_processed: alreadyProcessed, skipped_draft: skippedDraft, applied,
    per_product_bags_sold: [...perProduct.entries()].map(([cf, v]) => ({ cf_product: cf, name: v.name, bags: v.units })).sort((a, b) => b.bags - a.bags),
    applied_by_product: apply ? [...appliedByProduct.entries()].map(([cf, dq]) => ({ cf_product: cf, delta: dq })) : undefined,
    sample,
  });
}

// ── MFlow raw GET (READ-ONLY debug) ──────────────────────────────────────────
// Proxy an arbitrary GET under /api/v3/ (e.g. products/view/{id}) for lookups.
async function handleMflowGet(body: any) {
  if (!mflowConfigured()) return json({ error: "MFlow not configured" }, 500);
  const path = String(body.path ?? "");
  if (!path.startsWith("/api/v3/")) return json({ error: "path must start with /api/v3/" }, 400);
  const r = await mflow(path);
  return json({ status: r.status, ok: r.ok, data: r.data });
}

// ── MFlow map refresh ────────────────────────────────────────────────────────
// Resolve each coffee bag to its MFlow product + active grind variations and cache
// it in mflow_product_map, so the frequent push doesn't re-resolve every run (MFlow
// caps at 30 req/min). Costs 1 (/products/ids) + 1 (/variations/list) per bag —
// batch with product_ids to stay under the cap. Run occasionally (catalog changes).
async function handleMflowRefreshMap(body: any) {
  if (!mflowConfigured()) return json({ error: "MFlow not configured" }, 500);
  const dryRun = body.dry_run === true;                          // default: really refresh
  const doAll = body.all === true;
  const ids = parseIds(body);
  if (!ids && !doAll) return json({ error: "pass product_id / product_ids or all:true" }, 400);

  const { targets } = await mflowCoffeeTargets(doAll ? null : ids);   // 1 call: /products/ids
  const results: any[] = [];
  let mapped = 0, unmatched = 0, failed = 0;
  for (const t of targets) {
    if (!t.mflowId) { unmatched++; results.push({ product_id: t.id, name: t.name, status: "no_mflow_match", skus: t.skus }); continue; }
    const vr = await mflow(`/api/v3/products/${t.mflowId}/variations/list?per_page=100`);
    let kind: string, variationIds: number[] = [];
    if (vr.ok) {
      variationIds = (vr.data?.data?.variations ?? [])
        .filter((v: any) => v?.is_inactive !== true)
        .map((v: any) => Number(v.id)).filter((n: number) => Number.isFinite(n));
      if (!variationIds.length) { failed++; results.push({ product_id: t.id, name: t.name, mflow_product_id: t.mflowId, status: "no_active_variations" }); continue; }
      kind = "variable";
    } else if (vr.status === 422 && /single product/i.test(String(vr.data?.message ?? ""))) {
      kind = "single";
    } else {
      failed++; results.push({ product_id: t.id, name: t.name, mflow_product_id: t.mflowId, status: "variations_error", http: vr.status, message: vr.data?.message ?? null }); continue;
    }
    if (!dryRun) {
      await supabase.from("mflow_product_map").upsert({
        product_id: t.id, mflow_product_id: t.mflowId, kind, variation_ids: variationIds,
        matched_sku: t.usedSku, refreshed_at: new Date().toISOString(),
      }, { onConflict: "product_id" });
    }
    mapped++;
    results.push({ product_id: t.id, name: t.name, mflow_product_id: t.mflowId, kind, grind_variations: variationIds.length, status: dryRun ? "would_map" : "mapped" });
  }
  console.log(`[mflow_refresh_map] dry=${dryRun} targets=${targets.length} mapped=${mapped} unmatched=${unmatched} failed=${failed}`);
  return json({ ok: true, dry_run: dryRun, targets: targets.length, mapped, unmatched, failed, results });
}

// ── MFlow stock PUSH ─────────────────────────────────────────────────────────
// Push each coffee bag's packed_stock to MFlow as the ABSOLUTE quantity at the
// roasted-bags warehouse (which auto-syncs to WooCommerce). CoffeeFlow is master;
// one-way mirror, absolute-set → idempotent + self-healing. Reads the cached
// mflow_product_map (populated by mflow_refresh_map) so it's just ONE /stock/update
// call per bag — cheap enough for a frequent cron under the 30 req/min cap.
// Stock is the whole-bean pool: variable products set the SAME qty on every grind
// variation (all grinds orderable up to the real bag count); single products take
// the quantity directly. dry_run (default) previews. product_id(s) limit the set.
// NOTE: MFlow needs enable_stock=1 per product or the write 422s.
async function handleMflowPush(body: any) {
  if (!mflowConfigured()) return json({ error: "MFlow not configured (set MFLOW_PUBLIC_KEY / MFLOW_SECRET_KEY)" }, 500);
  const dryRun = body.dry_run !== false;                         // default dry-run
  const locationId = Number(body.location_id ?? MFLOW_LOCATION_ID);
  const ids = parseIds(body);

  // Read the cached mapping + current packed_stock — both DB, no MFlow calls.
  let q = supabase.from("mflow_product_map").select("product_id, mflow_product_id, kind, variation_ids, matched_sku");
  if (ids && ids.length) q = q.in("product_id", ids);
  const { data: maps } = await q;
  if (!maps || !maps.length) return json({ ok: true, dry_run: dryRun, count: 0, pushed: 0, note: "mflow_product_map empty for this set — run mflow_refresh_map first", results: [] });
  const { data: prods } = await supabase.from("products").select("id, name, packed_stock").in("id", maps.map((m: any) => m.product_id));
  const pById = new Map<number, any>((prods ?? []).map((p: any) => [p.id, p]));

  const results: any[] = [];
  let pushed = 0, failed = 0;
  for (const m of maps) {
    const p = pById.get(m.product_id);
    if (!p) continue;
    const qty = Math.max(0, Math.round(Number(p.packed_stock ?? 0)));
    const name = String(p.name ?? "").slice(0, 45);
    const variationIds: number[] = Array.isArray(m.variation_ids) ? m.variation_ids : [];
    const mflowProduct = m.kind === "single"
      ? { type: "single", quantity: qty }
      : { type: "variable", variations: variationIds.map((variation_id: number) => ({ variation_id, quantity: qty })) };

    if (dryRun) {
      results.push({ product_id: m.product_id, name, mflow_product_id: m.mflow_product_id, kind: m.kind, would_set: qty, grind_variations: variationIds.length, status: "would_push" });
      continue;
    }
    const r = await mflow(`/api/v3/products/${m.mflow_product_id}/stock/update`, {
      method: "POST",
      body: { stocks: [{ location_id: locationId, product: mflowProduct }] },
    });
    if (r.ok) {
      pushed++;
      await supabase.from("products").update({ last_synced_at: new Date().toISOString() }).eq("id", m.product_id);
      results.push({ product_id: m.product_id, name, mflow_product_id: m.mflow_product_id, kind: m.kind, set: qty, status: "pushed" });
    } else {
      failed++;
      results.push({ product_id: m.product_id, name, mflow_product_id: m.mflow_product_id, kind: m.kind, attempted: qty, status: "failed", http: r.status, message: r.data?.message ?? null, errors: r.data?.errors ?? null });
    }
  }
  console.log(`[mflow_push] dry=${dryRun} loc=${locationId} n=${maps.length} pushed=${pushed} failed=${failed}`);
  return json({ ok: true, dry_run: dryRun, location_id: locationId, count: maps.length, pushed, failed, results });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { status: 200, headers: CORS });
  if (req.method !== "POST")    return json({ error: "Method not allowed" }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }

  // Multi-line supplier goods receipt (non-coffee → Woo).
  if (body.action === "receive") {
    try { return await handleReceive(body); }
    catch (e) {
      console.error("receive error:", (e as Error).message);
      return json({ error: (e as Error).message }, 500);
    }
  }

  // Product editor: overwrite price and/or stock on both systems.
  if (body.action === "product_set") {
    try { return await handleProductSet(body); }
    catch (e) {
      console.error("product_set error:", (e as Error).message);
      return json({ error: (e as Error).message }, 500);
    }
  }

  // MFlow READ-ONLY discovery (SKU matching, warehouses, stock shape).
  if (body.action === "mflow_discover") {
    try { return await handleMflowDiscover(body); }
    catch (e) {
      console.error("mflow_discover error:", (e as Error).message);
      return json({ error: (e as Error).message }, 500);
    }
  }

  // MFlow READ-ONLY product search (resolve SKUs by name/keyword).
  if (body.action === "mflow_search") {
    try { return await handleMflowSearch(body); }
    catch (e) {
      console.error("mflow_search error:", (e as Error).message);
      return json({ error: (e as Error).message }, 500);
    }
  }

  // MFlow sells fetch (read-only inspection of recent coffee sales).
  if (body.action === "mflow_sync_sells") {
    try { return await handleMflowSyncSells(body); }
    catch (e) {
      console.error("mflow_sync_sells error:", (e as Error).message);
      return json({ error: (e as Error).message }, 500);
    }
  }

  // MFlow raw GET (read-only lookup).
  if (body.action === "mflow_get") {
    try { return await handleMflowGet(body); }
    catch (e) { return json({ error: (e as Error).message }, 500); }
  }

  // MFlow enable stock-management (guarded write, before/after snapshot).
  if (body.action === "mflow_enable_stock") {
    try { return await handleMflowEnableStock(body); }
    catch (e) {
      console.error("mflow_enable_stock error:", (e as Error).message);
      return json({ error: (e as Error).message }, 500);
    }
  }

  // MFlow map refresh (cache product_id + variation_ids). dry_run optional.
  if (body.action === "mflow_refresh_map") {
    try { return await handleMflowRefreshMap(body); }
    catch (e) {
      console.error("mflow_refresh_map error:", (e as Error).message);
      return json({ error: (e as Error).message }, 500);
    }
  }

  // MFlow stock push (packed_stock → MFlow absolute set). dry_run default.
  if (body.action === "mflow_push") {
    try { return await handleMflowPush(body); }
    catch (e) {
      console.error("mflow_push error:", (e as Error).message);
      return json({ error: (e as Error).message }, 500);
    }
  }

  // ── Legacy single-SKU manual adjust (sku + signed delta) ──
  const sku   = String(body.sku ?? "").trim();
  const delta = Number(body.delta);
  if (!sku)                          return json({ error: "SKU is required" }, 400);
  if (!Number.isFinite(delta) || delta === 0) return json({ error: "delta must be a non-zero number" }, 400);

  try {
    // ── Coffee bag? (CoffeeFlow is master) ──
    const { data: skuMap } = await supabase
      .from("product_sku_map").select("product_id").eq("sku", sku).maybeSingle();

    if (skuMap) {
      const { data: prod } = await supabase
        .from("products").select("id, name, size, packed_stock").eq("id", skuMap.product_id).maybeSingle();
      if (!prod) return json({ error: "SKU mapped to a product that no longer exists" }, 404);

      const before = Number(prod.packed_stock ?? 0);
      const after  = Math.max(0, before + delta);
      await supabase.from("products").update({ packed_stock: after }).eq("id", prod.id);
      await supabase.from("inventory_adjustments").insert({
        source: "manual", sku, description: `${prod.name} ${prod.size ?? ""}g`.trim(),
        qty_delta: delta, packed_before: before, packed_after: after, applied: true,
        note: "manual admin page",
      });
      return json({
        ok: true, target: "coffeeflow", sku,
        name: `${prod.name} ${prod.size ?? ""}g`.trim(),
        before, after, clamped: before + delta < 0,
      });
    }

    // ── Otherwise WooCommerce is master ──
    const wc = await wooFindBySku(sku);
    if (!wc) return json({ error: `SKU "${sku}" not found in WooCommerce or coffee map` }, 404);
    if (!wc.manageStock || wc.stockQuantity === null)
      return json({ error: `"${wc.name}" does not have stock management enabled in WooCommerce` }, 409);

    const before = wc.stockQuantity;
    const after  = Math.max(0, before + delta);
    const written = await wooSetStock(wc.id, wc.parentId, after);
    await supabase.from("inventory_adjustments").insert({
      source: "manual", sku, description: wc.name,
      qty_delta: delta, woo_product_id: wc.id, woo_before: before, woo_after: written, applied: true,
      note: "manual admin page",
    });
    return json({
      ok: true, target: "woocommerce", sku, name: wc.name,
      before, after: written, clamped: before + delta < 0,
      is_variation: wc.parentId > 0,
    });
  } catch (e) {
    console.error("stock-update error:", (e as Error).message);
    return json({ error: (e as Error).message }, 500);
  }
});
