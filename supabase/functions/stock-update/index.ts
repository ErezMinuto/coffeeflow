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
 * MFlow stock PUSH was removed 2026-08-25, same reason: Minuto does not manage
 * stock in MFlow. The MFlow relationship is now strictly INBOUND — we read its
 * sells feed to decrement packed_stock (mflow_sync_sells) and to build the
 * revenue ledger (mflow_sync_revenue). Nothing writes inventory back to it.
 * Removed with it: mflow_push, mflow_refresh_map (its product-id cache) and
 * mflow_enable_stock (which switched manage_stock ON for MFlow products —
 * exactly the thing we are not doing). The mflow_product_map table is now
 * unused; left in place rather than dropped, since dropping is irreversible
 * and an empty table costs nothing.
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
// Minuto's POS / business system. READ-ONLY as far as inventory is concerned:
// coffee-bag stock is mastered in CoffeeFlow (products.packed_stock) and is
// never written back to MFlow. We consume its /sells feed only. Auth =
// public/secret key pair (NOT the old scraper's email/password), REST v3.
const MFLOW_BASE = (Deno.env.get("MFLOW_BASE") ?? "https://my.mflow.co.il").replace(/\/+$/, "");
const MFLOW_PUB  = Deno.env.get("MFLOW_PUBLIC_KEY") ?? "";
const MFLOW_SEC  = Deno.env.get("MFLOW_SECRET_KEY") ?? "";
const mflowConfigured = () => !!(MFLOW_PUB && MFLOW_SEC);

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

// ── MFlow sells → packed_stock sync ──────────────────────────────────────────
// Pull recent sells and match coffee-bag lines by MFlow product_id (SKU prefixes
// overlap across coffees, so product_id is the only safe key). Reports the doc-type
// mix + per-product units.
//
// Writes only when body.apply === true (the */15 cron passes it); apply:false is
// a read-only dry run of the same matching, safe to call for diagnosis.
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

  // Classify each sell + match coffee lines by MFlow product_id. Drafts are
  // ignored. Signed qty: a sale is negative, because it reduces packed_stock.
  //
  // THE SIGN COMES FROM MFLOW, NOT FROM US. A credit document already carries
  // NEGATIVE line quantities, so negating every line handles sales and returns
  // in one rule. The previous version instead flipped the sign whenever
  // return_parent_id was set — but that field marks a SALE that was later
  // credited, not a return (see classifySell for the measurement), so every
  // such document ADDED stock that should have been deducted, a double error.
  //
  // That is exactly what happened to doc 3117789 on 2026-08-16: a plain +₪600
  // sale of 6 Aristo + 6 Dark Chocolate, carrying return_parent_id 3125649,
  // which put 12 bags INTO stock instead of taking 12 out — a 24-bag swing that
  // was mistaken at the time for a broken sync.
  //
  // הוחזר is skipped like a draft: the sale and its (invisible) credit net to
  // zero units, and a document already applied while it read Completed is held
  // off by the idempotency check below rather than re-applied on the flip.
  const classTally: Record<string, number> = {};
  const perProduct = new Map<number, { name: string; units: number }>();  // net bags sold (report)
  const sample: any[] = [];
  const toApply: { id: number; type: string; status: string; isReturn: boolean; source: string; date: any; delta: Map<number, number> }[] = [];
  let alreadyProcessed = 0, skippedDraft = 0, skippedReturned = 0;

  for (const s of sells) {
    const statusStr = String(s.sell_status?.status ?? s.status ?? "?");
    // Label only — a credit document is one whose own net value is negative.
    const isReturn = Number(s.total_before_tax ?? 0) < 0;
    const isDraft = statusStr === "draft" || s.status === "draft";
    const isReturnedSale = statusStr === "הוחזר";
    const klass = `${s.type ?? "?"}/${statusStr}${isReturn ? "/return" : ""}`;
    classTally[klass] = (classTally[klass] ?? 0) + 1;

    const lines = Array.isArray(s.sell_items) ? s.sell_items : [];
    const coffee: any[] = [];
    const delta = new Map<number, number>();
    for (const ln of lines) {
      const cf = mflowIdToCF.get(Number(ln.product_id));
      if (cf == null) continue;
      const raw = Number(ln.quantity ?? 0);
      const signed = -raw;                                  // sale reduces packed_stock; MFlow signs credits itself
      coffee.push({ cf_product: cf, sku: ln.sku, qty: raw, signed });
      delta.set(cf, (delta.get(cf) ?? 0) + signed);
      const cur = perProduct.get(cf) ?? { name: cfById.get(cf)?.name?.slice(0, 28) ?? String(cf), units: 0 };
      cur.units += -signed;                                  // report "bags sold" as positive
      perProduct.set(cf, cur);
    }
    if (!coffee.length) continue;
    if (processed.has(Number(s.id))) { alreadyProcessed++; continue; }
    if (isDraft) { skippedDraft++; continue; }
    if (isReturnedSale) { skippedReturned++; continue; }
    toApply.push({ id: Number(s.id), type: String(s.type ?? ""), status: statusStr, isReturn, source: String(s.sell_source ?? ""), date: s.transaction_date, delta });
    if (sample.length < 25) sample.push({ sell_id: s.id, status: statusStr, is_return: isReturn, source: s.sell_source, date: s.transaction_date, coffee: coffee.map((c) => ({ cf: c.cf_product, signed: c.signed })) });
  }

  // Apply: net the new sells per product, adjust packed_stock (clamp ≥0), record each sell.
  let applied = 0;
  const appliedByProduct = new Map<number, number>();
  for (const t of toApply) for (const [cf, dq] of t.delta) appliedByProduct.set(cf, (appliedByProduct.get(cf) ?? 0) + dq);
  const failedProducts = new Set<number>();
  const clamped: { cf_product: number; units_lost: number }[] = [];
  if (apply && toApply.length) {
    for (const [cf, rawDq] of appliedByProduct) {
      const dq = Math.round(rawDq);
      if (!dq) continue;
      // Atomic: apply_packed_stock_delta re-reads packed_stock under a row lock
      // and applies the delta in one statement. cfById was loaded before the
      // MFlow paging above, so using it for the arithmetic would overwrite any
      // packing coffee-bot recorded while we were fetching sells.
      const { data: res, error: updErr } = await supabase.rpc("apply_packed_stock_delta", {
        p_product_id: cf,
        p_delta:      dq,
      });
      const row = Array.isArray(res) ? res[0] : res;
      if (updErr || !row) {
        // Don't record this product's sells — leaving them unseen means the next
        // run retries the delta instead of losing it to an applied:true marker.
        console.error(`packed_stock delta failed for product ${cf}:`, updErr?.message ?? "product not found");
        failedProducts.add(cf);
        continue;
      }
      const before = Number(row.packed_before);
      const after  = Number(row.packed_after);
      const lost   = Number(row.units_lost ?? 0);
      if (lost) clamped.push({ cf_product: cf, units_lost: lost });
      await supabase.from("inventory_adjustments").insert({
        source: "mflow_sell", sku: cfById.get(cf)?.sku ?? String(cf), description: cfById.get(cf)?.name ?? null,
        qty_delta: dq, packed_before: before, packed_after: after, applied: true,
        note: `mflow sells sync ${fromDate}..${toDate}`
          + (lost ? ` — clamped at 0, ${lost} unit(s) not deducted` : ""),
      });
    }
    // A sell is recorded only when every product it touches applied cleanly.
    const recordable = toApply.filter((t) => ![...t.delta.keys()].some((cf) => failedProducts.has(cf)));
    const rows = recordable.map((t) => ({
      mflow_sell_id: t.id, type: t.type, status: t.status, is_return: t.isReturn, source: t.source,
      transaction_date: t.date, coffee_delta: Object.fromEntries(t.delta), applied: true,
    }));
    for (let i = 0; i < rows.length; i += 200) {
      const { error: insErr } = await supabase.from("mflow_sell_events").insert(rows.slice(i, i + 200));
      if (insErr) console.error("mflow_sell_events insert failed:", insErr.message);
    }
    applied = recordable.length;
  }

  return json({
    ok: true, apply, from_date: fromDate, to_date: toDate,
    sells_fetched: sells.length, class_tally: classTally,
    coffee_products_mapped: mflowIdToCF.size,
    new_eligible: toApply.length, already_processed: alreadyProcessed, skipped_draft: skippedDraft,
    // Sales marked הוחזר — sale plus invisible credit nets to zero units.
    skipped_returned_sale: skippedReturned || undefined, applied,
    // Non-empty means stock did NOT move for those products; their sells were
    // deliberately left unrecorded and will retry on the next run.
    failed_products: failedProducts.size ? [...failedProducts] : undefined,
    // Sales that hit the ≥0 clamp — these units are gone and will NOT retry.
    clamped: clamped.length ? clamped : undefined,
    per_product_bags_sold: [...perProduct.entries()].map(([cf, v]) => ({ cf_product: cf, name: v.name, bags: v.units })).sort((a, b) => b.bags - a.bags),
    applied_by_product: apply ? [...appliedByProduct.entries()].map(([cf, dq]) => ({ cf_product: cf, delta: dq })) : undefined,
    sample,
  });
}

// ── MFlow sells → revenue ledger (mflow_sell_lines) ──────────────────────────
// SEPARATE from handleMflowSyncSells on purpose. That one owns packed_stock;
// this one only ever writes mflow_sell_lines and never touches inventory, so a
// revenue backfill cannot corrupt real stock.
//
// Writes only when body.apply === true. apply:false is a full read-only report
// including a reconciliation of summed line revenue against each document's own
// header total — which is what validates the discount assumption before any
// number is stored.
type SellClass = 'counted' | 'return' | 'excluded'

// The trap: price QUOTES (הצעת מחיר) and CANCELLED docs (בוטל) come back from
// the same /sells/list endpoint as real sales. Summing without excluding them
// invents revenue that never happened. EcoSite web orders sit at 'Processing',
// not 'Completed', so requiring 'Completed' would silently drop the entire
// online channel.
//
// HOW A RETURN IS ACTUALLY MARKED — measured on the complete May-2026 window
// (1,445 documents pulled raw from /sells/list, 2026-08-22):
//
//   • return_parent_id does NOT mean "this document is a return". It points
//     FORWARD from a sale to the credit document raised against it later. All
//     43 May documents carrying it had a POSITIVE total_before_tax — e.g. doc
//     3117789, +₪600, twelve bags of beans, return_parent_id 3125649.
//   • flags.is_return_and_credit_order was true on ZERO of the 1,445.
//   • A real credit is signed BY MFLOW IN THE DATA: the document carries
//     negative line quantities and a negative header (4 such docs in May).
//
// So the sign is already in the payload and must simply be respected. Deriving
// it from return_parent_id flipped 43 genuine sales negative in May alone,
// understating the month by ₪127,049 — double their ₪63,524 value.
//
// הוחזר ("returned") is a THIRD case: the original sale, still positive, whose
// credit document is not exposed by /sells/list at all (fetching one by id
// returns "No Record Found"). It nets to zero, so it is excluded rather than
// counted or flipped — and reported, so the choice stays visible. Caveat: a
// PARTIAL return would lose the retained portion this way. 3 docs in May.
function classifySell(s: any): { cls: SellClass; status: string; isReturn: boolean } {
  const status   = String(s.sell_status?.status ?? s.status ?? '?');
  // A credit document is one whose own net value is negative. Nothing else.
  const isReturn = Number(s.total_before_tax ?? 0) < 0;
  if (status === 'draft' || s.status === 'draft') return { cls: 'excluded', status, isReturn };
  if (status === 'הצעת מחיר')                     return { cls: 'excluded', status, isReturn };
  if (status === 'בוטל')                          return { cls: 'excluded', status, isReturn };
  if (status === 'הוחזר')                         return { cls: 'excluded', status, isReturn };
  if (isReturn)                                    return { cls: 'return',   status, isReturn };
  if (status === 'Completed' || status === 'Processing') return { cls: 'counted', status, isReturn };
  // Unknown status → excluded, but the caller reports it. A status we have
  // never seen must not silently become revenue OR silently vanish.
  return { cls: 'excluded', status, isReturn };
}

// A document's effective VAT rate, taken from its own numbers so a rate change
// does not silently rot this code. Falls back to 18% on tax-free or zero docs.
function vatRateOf(s: any): number {
  const tbt = Number(s.total_before_tax ?? 0);
  const tax = Number(s.tax_amount ?? 0);
  if (s.is_tax_free || !(tbt > 0) || !(tax > 0)) return 0.18;
  return tax / tbt;
}

// DOCUMENT-LEVEL DISCOUNT. Separate from each line's own discount_amount, and
// previously ignored entirely — which silently overstated revenue.
//
//   discount_type 'percentage' → discount_amount is a percent of the line total
//   discount_type 'fixed'      → discount_amount is a shekel figure INCLUDING
//                                VAT, apportioned across lines pro-rata
//
// Verified against MFlow's own header total_before_tax on every May document:
// applying this closed 1,380 of the 1,432 reconciliations that the old
// line-discount-only formula got wrong on 92 of them.
function docDiscountFactor(s: any, grossExTax: number): { scale: number; flat: number } {
  const d = Number(s.discount_amount ?? 0);
  if (!d) return { scale: 1, flat: 0 };
  if (String(s.discount_type ?? '') === 'percentage') return { scale: 1 - d / 100, flat: 0 };
  if (!grossExTax) return { scale: 1, flat: 0 };
  return { scale: 1, flat: d / (1 + vatRateOf(s)) };
}

// Header-level shipping, e.g. delivery.shipping.shipping_charges = 30 (VAT-inc).
// It is real revenue but has no line item, so it is REPORTED as a reconciliation
// residual rather than invented as a synthetic line. ₪992 ex-VAT in May 2026.
function shippingExTax(s: any): number {
  const c = Number(s?.delivery?.shipping?.shipping_charges ?? 0);
  return c > 0 ? c / (1 + vatRateOf(s)) : 0;
}

function channelOf(src: string, wooId: unknown): string {
  if (wooId != null) return 'ecosite';
  const s = src.toLowerCase();
  if (s.startsWith('pos'))         return 'pos';
  if (s.startsWith('ecosite'))     return 'ecosite';
  if (s.startsWith('back office')) return 'back_office';
  return 'other';
}

async function handleMflowSyncRevenue(body: any) {
  if (!mflowConfigured()) return json({ error: "MFlow not configured" }, 500);
  const apply    = body.apply === true;
  const toDate   = String(body.to_date ?? new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Jerusalem" }));
  const days     = Number(body.days ?? 7);
  const fromDate = String(body.from_date ?? new Date(Date.now() - days * 86400000).toLocaleDateString("en-CA", { timeZone: "Asia/Jerusalem" }));
  const maxPages = Math.max(1, Math.min(200, Number(body.max_pages ?? 60)));

  // MFlow product_id → CoffeeFlow product, for the bean lines. Non-coffee lines
  // are still recorded (revenue is revenue) with cf_product_id null.
  const { data: skuRows } = await supabase.from("product_sku_map").select("sku, product_id");
  const skuToProduct = new Map<string, number>();
  for (const r of skuRows ?? []) skuToProduct.set(String(r.sku).trim(), r.product_id);
  const idsRes = await mflow("/api/v3/products/ids");
  const mflowIdToCF = new Map<number, number>();
  for (const p of (idsRes.data?.data?.products ?? [])) {
    const cf = skuToProduct.get(String(p.sku).trim());
    if (cf != null) mflowIdToCF.set(Number(p.id), cf);
  }

  const sells: any[] = [];
  let truncated = false;
  for (let page = 1; page <= maxPages; page++) {
    const r = await mflow(`/api/v3/sells/list?start_date=${fromDate}&end_date=${toDate}&per_page=50&page=${page}`);
    if (!r.ok) return json({ ok: false, error: "sells fetch failed", http: r.status, from_date: fromDate, to_date: toDate });
    const c = r.data?.data;
    const list = Array.isArray(c?.list) ? c.list : (Array.isArray(c) ? c : []);
    if (!list.length) break;
    sells.push(...list);
    const lastPage = c?.pagination?.last_page;
    if (lastPage && page >= lastPage) break;
    if (list.length < 50) break;
    // Never claim a complete window we did not actually read.
    if (page === maxPages && lastPage && lastPage > maxPages) truncated = true;
  }

  const now = new Date().toISOString();
  const rows: Record<string, unknown>[] = [];
  const byClass: Record<string, number> = {};
  const unknownStatuses: Record<string, number> = {};
  const revenueByChannel: Record<string, number> = {};
  const mismatches: any[] = [];
  let linesTotal = 0, unmappedCoffeeLike = 0;
  let reconciled = 0, mismatchCount = 0, mismatchValue = 0, shippingExVat = 0;
  let zeroLineDocs = 0, zeroLineValue = 0;

  for (const s of sells) {
    const { cls, status, isReturn } = classifySell(s);
    byClass[`${status}${isReturn ? '/return' : ''}`] = (byClass[`${status}${isReturn ? '/return' : ''}`] ?? 0) + 1;
    if (cls === 'excluded' && status !== 'draft' && status !== 'הצעת מחיר' && status !== 'בוטל' && status !== 'הוחזר') {
      unknownStatuses[status] = (unknownStatuses[status] ?? 0) + 1;
    }
    const lines = Array.isArray(s.sell_items) ? s.sell_items : [];
    // NO SIGN MULTIPLIER. MFlow already signs a credit with negative line
    // quantities; multiplying by anything flips genuine sales. See classifySell.
    let sellSum = 0;

    // Document-level discount needs the document's gross before it can be
    // apportioned, so the lines are priced in two passes.
    const grossOf = (ln: any) =>
      Number(ln.quantity ?? 0) * Number(ln.unit_price_exc_tax ?? 0) - Number(ln.discount_amount ?? 0);
    const docGross = lines.reduce((a: number, ln: any) => a + grossOf(ln), 0);
    const { scale, flat } = docDiscountFactor(s, docGross);

    // Zero-line documents are consolidating invoices: they carry a header total
    // but no items, and the sales they consolidate are already counted through
    // their own lines. A line ledger correctly stores nothing for them — but
    // they are counted and reported so the header gap they open is not a mystery.
    if (cls !== 'excluded' && !lines.length) {
      zeroLineDocs++;
      zeroLineValue += Number(s.total_before_tax ?? 0);
    }

    for (const ln of lines) {
      linesTotal++;
      const qty    = Number(ln.quantity ?? 0);
      const unitEx = Number(ln.unit_price_exc_tax ?? 0);
      const disc   = Number(ln.discount_amount ?? 0);
      const gross  = qty * unitEx - disc;
      // Line discount, then the document discount apportioned pro-rata.
      const rev    = gross * scale - (docGross ? flat * (gross / docGross) : 0);
      sellSum += rev;
      const cf = mflowIdToCF.get(Number(ln.product_id)) ?? null;
      if (cf == null && String(ln.sku ?? '').length > 0 && String(ln.product_name ?? '').includes('פולי')) unmappedCoffeeLike++;

      if (cls !== 'excluded') {
        revenueByChannel[channelOf(String(s.sell_source ?? ''), s.woocommerce_order_id)] =
          (revenueByChannel[channelOf(String(s.sell_source ?? ''), s.woocommerce_order_id)] ?? 0) + rev;
      }
      rows.push({
        mflow_sell_id: Number(s.id),
        line_id:       Number(ln.id),
        is_return:     isReturn,
        transaction_date: s.transaction_date,
        sell_source:   String(s.sell_source ?? ''),
        channel:       channelOf(String(s.sell_source ?? ''), s.woocommerce_order_id),
        woocommerce_order_id: s.woocommerce_order_id ?? null,
        status,
        status_class:  cls,
        sku:           ln.sku ?? null,
        mflow_product_id: ln.product_id ?? null,
        variation_id:  ln.variation_id ?? null,
        cf_product_id: cf,
        product_name:  ln.product_name ?? null,
        variation_name: ln.variation_name ?? null,
        quantity:      qty,
        unit_price_exc_tax: unitEx,
        discount_amount: disc,
        item_tax:      Number(ln.item_tax ?? 0),
        line_revenue_exc_tax: Number(rev.toFixed(4)),
        dpp_exc_tax:   ln.dpp_exc_tax ?? null,
        synced_at:     now,           // every upsert, never a column DEFAULT
      });
    }

    // RECONCILIATION — the check that validates the pricing rules before any of
    // this is trusted. Header total_before_tax is MFlow's own ex-VAT figure and
    // carries its own sign, so our summed lines must match it as-is.
    //
    // Zero-line consolidating documents are skipped: they have no lines to sum,
    // so scoring them would report a permanent phantom gap.
    //
    // COUNT EVERY MISMATCH, list only a sample. The previous version pushed to a
    // list capped at 15 and reported only that list — which read as "just 15
    // tiny mismatches" when May alone actually had 92 of them, hiding the
    // document-discount bug completely.
    if (cls !== 'excluded' && lines.length) {
      const header   = Number(s.total_before_tax ?? 0);
      const ship     = shippingExTax(s);
      shippingExVat += ship;
      // Shipping has no line, so the ledger cannot hold it; credit it here so
      // the residual reflects genuinely unexplained money only.
      const delta = header - (sellSum + ship);
      reconciled++;
      if (Math.abs(delta) > 0.05) {
        mismatchCount++;
        mismatchValue += delta;
        if (mismatches.length < 15) {
          mismatches.push({ sell_id: s.id, status, header_ex_vat: header, summed_lines: Number(sellSum.toFixed(4)), shipping_ex_vat: Number(ship.toFixed(4)), delta: Number(delta.toFixed(4)) });
        }
      }
    }
  }

  // DEDUPE BEFORE UPSERT. Postgres rejects a batch containing the same
  // conflict key twice ("ON CONFLICT DO UPDATE command cannot affect row a
  // second time"). Paging over a window that is still being written to — i.e.
  // the CURRENT month — can return the same sell on two pages, so the same
  // (sell, line, is_return) lands in one batch. Static months never tripped it,
  // which is why only the newest chunk failed. Last occurrence wins: later
  // pages carry the fresher copy of a document that changed mid-scan.
  const byKey = new Map<string, Record<string, unknown>>();
  for (const r of rows) byKey.set(`${r.mflow_sell_id}|${r.line_id}|${r.is_return}`, r);
  const deduped = [...byKey.values()];
  const dupesDropped = rows.length - deduped.length;

  // PURGE BEFORE REWRITE — required by any run that can change is_return.
  //
  // is_return is part of the primary key, so a row stored under the OLD, wrong
  // classification is not overwritten by the corrected one: the upsert inserts a
  // second row and the document is then counted twice, once with each sign. An
  // in-place backfill without this step is worse than no backfill.
  //
  // Scoped to the document ids actually fetched — never a blind date-range
  // delete, so a truncated or partly-failed window cannot erase rows it is not
  // about to replace.
  const purge = body.purge === true;
  let purgedFor = 0;
  if (apply && purge && !truncated) {
    const ids = [...new Set(sells.map((s: any) => Number(s.id)).filter((n: number) => Number.isFinite(n)))];
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const { error } = await supabase.from("mflow_sell_lines").delete().in("mflow_sell_id", chunk);
      if (error) return json({ ok: false, error: `purge failed: ${error.message}`, purged_for_docs: purgedFor });
      purgedFor += chunk.length;
    }
  }

  let written = 0;
  if (apply && deduped.length > 0) {
    for (let i = 0; i < deduped.length; i += 500) {
      const { error } = await supabase
        .from("mflow_sell_lines")
        .upsert(deduped.slice(i, i + 500), { onConflict: "mflow_sell_id,line_id,is_return" });
      if (error) return json({ ok: false, error: `upsert failed: ${error.message}`, written });
      written += deduped.slice(i, i + 500).length;
    }
  }

  return json({
    ok: true, apply, from_date: fromDate, to_date: toDate,
    sells_fetched: sells.length, lines: linesTotal, rows_built: rows.length, written,
    // Documents whose existing rows were cleared before rewriting. Backfilling a
    // window WITHOUT purge:true leaves the old, wrongly-signed rows in place.
    purged_for_docs: purge ? purgedFor : undefined,
    purge_skipped_truncated: (apply && purge && truncated) || undefined,
    // Non-zero is normal on the current month (a sell seen on two pages while
    // the window is still being written to), and should be 0 on closed months.
    duplicate_rows_dropped: dupesDropped || undefined,
    truncated_window: truncated || undefined,
    class_tally: byClass,
    // Non-empty means a status we have never classified showed up. It was
    // EXCLUDED from revenue — decide deliberately, don't leave it drifting.
    unknown_statuses: Object.keys(unknownStatuses).length ? unknownStatuses : undefined,
    revenue_ex_vat_by_channel: Object.fromEntries(Object.entries(revenueByChannel).map(([k, v]) => [k, Number(v.toFixed(2))])),
    // Reconciliation against MFlow's own header totals. mismatch_count is the
    // TRUE count; header_mismatches is only the first 15 as a sample. A healthy
    // window reconciles ~99% of documents and leaves a residual near zero.
    reconciled_docs: reconciled,
    mismatch_count: mismatchCount,
    mismatch_value_ex_vat: Number(mismatchValue.toFixed(2)),
    // Header-level shipping. Real revenue with no line item, so it is NOT stored
    // in mflow_sell_lines — reported here so the omission is explicit.
    shipping_ex_vat_not_stored: Number(shippingExVat.toFixed(2)) || undefined,
    // Consolidating invoices: header value, zero lines, and the sales behind
    // them are already counted individually. Stored as nothing, on purpose.
    zero_line_docs: zeroLineDocs || undefined,
    zero_line_header_value: Number(zeroLineValue.toFixed(2)) || undefined,
    header_mismatches: mismatches.length ? mismatches : undefined,
    // Bean-looking lines with no CoffeeFlow product mapping — these contribute
    // revenue but no bean volume, so a high count means product_sku_map is thin.
    unmapped_coffee_like_lines: unmappedCoffeeLike || undefined,
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
  if (body.action === "mflow_sync_revenue") {
    try { return await handleMflowSyncRevenue(body); }
    catch (e) {
      console.error("mflow_sync_revenue error:", (e as Error).message);
      return json({ error: (e as Error).message }, 500);
    }
  }

  if (body.action === "mflow_get") {
    try { return await handleMflowGet(body); }
    catch (e) { return json({ error: (e as Error).message }, 500); }
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
