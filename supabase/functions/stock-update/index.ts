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
