/**
 * CoffeeFlow — Manual Stock Update (Supabase Edge Function)
 *
 * Called from the admin "Stock" page. Operator enters a SKU and a signed delta
 * (+N to add, -N to remove); this routes the change the same way the iCount sync
 * does:
 *   • SKU is a coffee bag (in product_sku_map) → adjust CoffeeFlow products.packed_stock
 *   • otherwise                                → adjust WooCommerce stock_quantity
 *
 * Every change is written to inventory_adjustments (source='manual') for audit.
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

const ICOUNT_BASE = "https://api.icount.co.il/api/v3.php";
const ICOUNT_CID  = Deno.env.get("ICOUNT_CID")  ?? "";
const ICOUNT_USER = Deno.env.get("ICOUNT_USER") ?? "";
const ICOUNT_PASS = Deno.env.get("ICOUNT_PASS") ?? "";

const supabase = createClient(SUPA_URL, SUPA_KEY);
const wooAuth  = btoa(`${WOO_KEY}:${WOO_SEC}`);

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

// ── iCount helpers ────────────────────────────────────────────────────────────
// Same v3 contract icount-admin uses: login → sid, get_items lists stock, and
// update_item with `stock` SETS an absolute value (not a delta).
const icountConfigured = () => !!(ICOUNT_CID && ICOUNT_USER && ICOUNT_PASS);

async function icount(path: string, body: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${ICOUNT_BASE}/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { _raw: text.slice(0, 300), status: false }; }
}

let icountSid = "";
async function icountLogin(): Promise<string> {
  if (icountSid) return icountSid;
  const r = await icount("auth/login", { cid: ICOUNT_CID, user: ICOUNT_USER, pass: ICOUNT_PASS });
  if (!r?.sid) throw new Error(`iCount login failed: ${JSON.stringify(r?.reason ?? r).slice(0, 160)}`);
  icountSid = r.sid;
  return icountSid;
}

const icountSku = (it: any) => String(it.sku ?? it.makat ?? it.barcode ?? "").trim();
const icountId  = (it: any) => String(it.inventory_item_id ?? it.id ?? "");

async function icountSetStock(sid: string, itemId: string, stock: number): Promise<void> {
  await icountUpdateItem(sid, itemId, { stock });
}

// Generic update_item with arbitrary fields (stock, price, etc.).
async function icountUpdateItem(sid: string, itemId: string, fields: Record<string, unknown>): Promise<void> {
  const r = await icount("inventory/update_item", {
    sid, cid: ICOUNT_CID, user: ICOUNT_USER, pass: ICOUNT_PASS,
    inventory_item_id: itemId, ...fields,
  });
  if (r?.status !== true) throw new Error(`iCount update_item failed: ${JSON.stringify(r?.reason ?? r).slice(0, 160)}`);
}

// iCount stores both unitprice (ex-VAT) and unitprice_incvat (VAT-inclusive
// consumer price). WooCommerce prices are the VAT-inclusive consumer price, so
// we read/write the *incvat* side to keep the two systems aligned. Verified
// live: update_item with {unitprice_incvat} sets the inclusive price; iCount
// recomputes the ex-VAT side (ILS / 18%).
function icountPriceIncVat(it: any): number | null {
  const v = it.unitprice_incvat ?? it.unitprice ?? it.price ?? null;
  return v == null || v === "" ? null : Number(v);
}

// iCount's BUYING (cost) price. We don't know the canonical field name for this
// account up front, and it isn't documented uniformly, so we detect it: the
// first of these keys that the item actually carries is treated as the cost
// field, and writes go back to that same key. A value of 0/"0" still counts as
// "present" — that's how we learn the real field name even before any cost is
// set. DEFAULT_COST_FIELD is the fallback used only when the item carries none
// of them (first cost ever written for this item).
const COST_FIELDS = [
  "cost", "unitcost", "unit_cost", "cost_price", "costprice",
  "unitcost_incvat", "cost_incvat", "buy_price", "buyprice",
  "purchase_price", "purchaseprice", "supplier_price",
];
const DEFAULT_COST_FIELD = "cost";
function icountCost(it: any): { field: string | null; value: number | null } {
  for (const f of COST_FIELDS) {
    const v = it?.[f];
    if (v !== undefined && v !== null && v !== "") {
      const n = Number(v);
      return { field: f, value: Number.isFinite(n) ? n : null };
    }
  }
  return { field: null, value: null };
}

// Full SKU-keyed map carrying the raw item (so the preview can surface price
// fields for verification and we can read the current sale + cost price).
type IcItem = { id: string; stock: number; name: string; price: number | null; cost: number | null; costField: string | null; raw: any };
async function icountItemMapFull(sid: string): Promise<Map<string, IcItem>> {
  const r = await icount("inventory/get_items", { sid, cid: ICOUNT_CID, user: ICOUNT_USER, pass: ICOUNT_PASS });
  const raw = Array.isArray(r?.items) ? r.items : (r?.items && typeof r.items === "object" ? Object.values(r.items) : []);
  const map = new Map<string, IcItem>();
  for (const it of raw as any[]) {
    const sku = icountSku(it);
    if (sku) {
      const c = icountCost(it);
      map.set(sku, { id: icountId(it), stock: Number(it.stock ?? 0), name: String(it.description ?? ""), price: icountPriceIncVat(it), cost: c.value, costField: c.field, raw: it });
    }
  }
  return map;
}

// ── Product editor: overwrite price and/or stock on BOTH systems ─────────────
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

  // iCount current
  let sid = "";
  let ic: { id: string; stock: number; name: string; price: number | null; raw: any } | undefined;
  let icErr: string | null = null;
  if (icountConfigured()) {
    try { sid = await icountLogin(); ic = (await icountItemMapFull(sid)).get(sku); }
    catch (e) { icErr = (e as Error).message; }
  }

  // Woo current
  let wc: Awaited<ReturnType<typeof wooFindBySku>> = null;
  let wooErr: string | null = null;
  try { wc = await wooFindBySku(sku); } catch (e) { wooErr = (e as Error).message; }

  const wooView = wc ? { name: wc.name, id: wc.id, is_variation: wc.parentId > 0, price: wc.regularPrice, stock: wc.stockQuantity, manage_stock: wc.manageStock } : (wooErr ? { status: "error", error: wooErr } : { status: "no_woo_match" });
  const icView  = ic ? { id: ic.id, name: ic.name, price: ic.price, stock: ic.stock } : (!icountConfigured() ? { status: "not_configured" } : icErr ? { status: "error", error: icErr } : { status: "no_icount_match" });
  const name = wc?.name || ic?.name || null;

  const base = {
    ok: true, dry_run: dryRun, sku, name, is_coffee: isCoffee,
    intended: { price: hasPrice ? price : null, stock: hasStock ? stock : null },
    woo: wooView, icount: icView,
    stock_skipped_coffee: isCoffee && hasStock,
  };

  if (dryRun) return json(base);

  const applied: any = { woo: {}, icount: {} };
  // ── PRICE (both systems) ──
  if (hasPrice) {
    if (wc) { try { applied.woo.price = await wooSetPrice(wc.id, wc.parentId, price as number); } catch (e) { applied.woo.price_error = (e as Error).message; } }
    if (ic) { try { await icountUpdateItem(sid, ic.id, { unitprice_incvat: price, unitprice_incvat_entered: 1 }); applied.icount.price = price; } catch (e) { applied.icount.price_error = (e as Error).message; } }
  }
  // ── STOCK (non-coffee only) ──
  if (hasStock && !isCoffee) {
    if (wc && wc.manageStock && wc.stockQuantity !== null) {
      try { applied.woo.stock = await wooSetStock(wc.id, wc.parentId, stock as number); } catch (e) { applied.woo.stock_error = (e as Error).message; }
    } else if (wc) { applied.woo.stock_skipped = "manage_stock_off"; }
    if (ic) { try { await icountSetStock(sid, ic.id, stock as number); applied.icount.stock = stock; } catch (e) { applied.icount.stock_error = (e as Error).message; } }
  }

  // ── Audit ──
  await supabase.from("inventory_adjustments").insert({
    source: "edit", sku, description: name,
    qty_delta: hasStock && !isCoffee && ic ? (stock as number) - ic.stock : 0,
    woo_product_id: wc?.id ?? null,
    woo_before: wc?.stockQuantity ?? null,
    woo_after: hasStock && !isCoffee ? applied.woo.stock ?? null : null,
    applied: true,
    note: `price/stock edit${hasPrice ? ` · price→${price}` : ""}${hasStock ? (isCoffee ? " · coffee stock skipped" : ` · stock→${stock}`) : ""} · iCount ${ic ? "matched" : "no match"}`.slice(0, 280),
  });

  return json({ ...base, applied });
}

// ── Goods receipt (non-coffee only) ──────────────────────────────────────────
// For each line: WooCommerce is master for stock (read current + add qty) and
// for the sale price; iCount mirrors both. The BUYING (cost) price lives in
// iCount (master) and is also logged to inventory_adjustments. Coffee bags
// (in product_sku_map) are rejected — those stay on the packing/packed_stock flow.
//
// Each item may carry, alongside {sku, qty}:
//   • cost  — new buying price per unit. Compared to the current iCount cost so
//             the UI can flag it (red = went up, green = went down). Written to
//             iCount's cost field + logged. Omit/blank/unchanged → left as-is.
//   • price — new sale price (VAT-inclusive consumer price). Written to Woo +
//             iCount. Omit/blank/unchanged → left as-is.
// A dry run writes nothing; it returns each line's current cost + sale price so
// the page can pre-fill the editable fields and colour the buying price.
async function handleReceive(body: any) {
  const dryRun = body.dry_run !== false; // default to a safe preview
  const supplier = String(body.supplier ?? "").trim() || null;
  const rawItems: any[] = Array.isArray(body.items) ? body.items : [];
  const num = (v: unknown) => (v === undefined || v === null || String(v).trim() === "" ? null : Number(v));
  const items = rawItems
    .map((it) => ({ sku: String(it.sku ?? "").trim(), qty: Number(it.qty), cost: num(it.cost), price: num(it.price) }))
    .filter((it) => it.sku);
  if (items.length === 0) return json({ error: "items[] is required (each {sku, qty})" }, 400);
  for (const it of items) {
    if (!Number.isFinite(it.qty) || it.qty <= 0)
      return json({ error: `qty for SKU "${it.sku}" must be a positive number` }, 400);
    if (it.cost !== null && (!Number.isFinite(it.cost) || it.cost < 0))
      return json({ error: `cost for SKU "${it.sku}" must be a non-negative number` }, 400);
    if (it.price !== null && (!Number.isFinite(it.price) || it.price < 0))
      return json({ error: `price for SKU "${it.sku}" must be a non-negative number` }, 400);
  }

  const haveIcount = icountConfigured();
  let sid = "";
  let imap: Map<string, IcItem> = new Map();
  if (haveIcount) {
    try { sid = await icountLogin(); imap = await icountItemMapFull(sid); }
    catch (e) { console.error("iCount init failed:", (e as Error).message); }
  }

  const results: any[] = [];
  for (const { sku, qty, cost, price } of items) {
    const line: any = { sku, qty, woo: null, icount: null, status: "ok" };
    try {
      // Coffee bag? → reject (packing flow owns these)
      const { data: skuMap } = await supabase
        .from("product_sku_map").select("product_id").eq("sku", sku).maybeSingle();
      if (skuMap) { line.status = "rejected_coffee"; results.push(line); continue; }

      const ic = haveIcount ? imap.get(sku) : undefined;
      // Current buy price (iCount) + sale price (Woo master, iCount fallback),
      // surfaced on every line so the page can pre-fill the editable fields and
      // decide the buying-price colour.
      const costBefore  = ic?.cost ?? null;
      const wantCost    = cost  !== null && (costBefore  === null || cost  !== costBefore);
      // ── WooCommerce (master: stock + sale price) ──
      const wc = await wooFindBySku(sku);
      const saleBefore  = wc?.regularPrice != null ? Number(wc.regularPrice) : (ic?.price ?? null);
      const wantSale    = price !== null && (saleBefore === null || price !== saleBefore);

      line.current = { cost: costBefore, cost_field: ic?.costField ?? null, sale: saleBefore };
      if (wantCost)  line.intended_cost  = cost;
      if (wantSale)  line.intended_price = price;

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

      // ── iCount (mirror +qty stock; buy price master; mirror sale price) ──
      if (!haveIcount) {
        line.icount = { status: "not_configured" };
      } else if (!ic) {
        line.icount = { status: "no_icount_match" };
      } else {
        if (!line.name && ic.name) line.name = ic.name;
        const before = ic.stock;
        const after  = before + qty;
        if (!dryRun) {
          await icountSetStock(sid, ic.id, after);
          line.icount = { status: "updated", before, after, id: ic.id, cost: costBefore };
          // buy price → iCount (write back to the detected field, or the default
          // when this item carries no cost field yet).
          if (wantCost) {
            const field = ic.costField || DEFAULT_COST_FIELD;
            try { await icountUpdateItem(sid, ic.id, { [field]: cost }); line.icount.cost = cost; line.icount.cost_field = field; }
            catch (e) { line.icount.cost_error = (e as Error).message; }
          }
          // sale price → iCount
          if (wantSale) {
            try { await icountUpdateItem(sid, ic.id, { unitprice_incvat: price, unitprice_incvat_entered: 1 }); line.icount.sale_after = price; }
            catch (e) { line.icount.sale_error = (e as Error).message; }
          }
        } else {
          line.icount = { status: "would_update", before, after, id: ic.id, cost: costBefore };
        }
      }

      // overall line status
      const wooFailed = line.woo && !["updated", "would_update"].includes(line.woo.status);
      const icFailed  = line.icount && !["updated", "would_update", "not_configured"].includes(line.icount.status);
      if (wooFailed && icFailed) line.status = "no_match";
      else if (wooFailed || icFailed) line.status = "partial";

      // ── Audit (real runs only) ──
      if (!dryRun && line.status !== "rejected_coffee") {
        await supabase.from("inventory_adjustments").insert({
          source: "receive", supplier, sku, description: line.name ?? null, qty_delta: qty,
          woo_product_id: line.woo?.id ?? null,
          woo_before: line.woo?.before ?? null, woo_after: line.woo?.after ?? null,
          unit_cost: wantCost ? cost : null,
          unit_cost_before: wantCost ? costBefore : null,
          sale_price: wantSale ? price : null,
          applied: line.woo?.status === "updated" || line.icount?.status === "updated",
          note: `supplier intake · iCount ${line.icount?.status ?? "n/a"}` +
                (line.icount?.before != null ? ` (${line.icount.before}→${line.icount.after})` : "") +
                (wantCost ? ` · cost ${costBefore ?? "—"}→${cost}` : "") +
                (wantSale ? ` · price→${price}` : ""),
        });
      }
    } catch (e) {
      line.status = "error";
      line.error = (e as Error).message;
      console.error(`receive ${sku} error:`, (e as Error).message);
    }
    results.push(line);
  }

  return json({ ok: true, dry_run: dryRun, supplier, icount_configured: haveIcount, count: results.length, results });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { status: 200, headers: CORS });
  if (req.method !== "POST")    return json({ error: "Method not allowed" }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }

  // Multi-line supplier goods receipt (non-coffee → Woo + iCount).
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
