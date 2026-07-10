/**
 * CoffeeFlow — iCount Webhook (Supabase Edge Function)
 *
 * Receives iCount document webhooks (invoice / invoice-receipt) and keeps the
 * WooCommerce master stock in sync for sales made directly in iCount
 * (POS / back-office). Website sales are handled by WooCommerce natively and
 * are intentionally skipped here.
 *
 * Flow per document:
 *   1. Auth: optional shared token in the URL query (?token=…) vs ICOUNT_WEBHOOK_SECRET.
 *   2. Capture the raw payload into icount_webhook_events (idempotent on doctype-docnum).
 *   3. If `based_on_order` is set → treat as order-derived (likely website) → skip stock.
 *   4. Otherwise, per line item: resolve the WooCommerce product by SKU and
 *      decrement stock_quantity (and products.packed_stock for coffee).
 *
 * SAFETY: all stock writes are gated behind ICOUNT_DECREMENT_ENABLED. When it is
 * not "true", the function is LOG-ONLY: it records what it *would* change in
 * inventory_adjustments (applied=false) and never calls the WooCommerce write API.
 *
 * Deploy:
 *   supabase functions deploy icount-webhook --project-ref <ref> --no-verify-jwt
 */

import { serve }        from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPA_URL  = Deno.env.get("SUPABASE_URL")              ?? "";
const SUPA_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const WOO_URL   = Deno.env.get("WOO_URL")                   ?? "";
const WOO_KEY   = Deno.env.get("WOO_KEY")                   ?? "";
const WOO_SEC   = Deno.env.get("WOO_SECRET")                ?? "";
const WEBHOOK_SECRET   = Deno.env.get("ICOUNT_WEBHOOK_SECRET")   ?? "";   // optional ?token= guard
const HEADER_SECRET    = Deno.env.get("ICOUNT_HEADER_SECRET")    ?? "";   // iCount's X-iCount-Secret header
const DECREMENT_ENABLED = (Deno.env.get("ICOUNT_DECREMENT_ENABLED") ?? "").toLowerCase() === "true";

const supabase = createClient(SUPA_URL, SUPA_KEY);
const wooAuth  = btoa(`${WOO_KEY}:${WOO_SEC}`);

interface IcountItem {
  sku?: string;
  inventory_item_makat?: string;
  description?: string;
  quantity?: string | number;
  is_refunded?: string | number;
}

// ── WooCommerce helpers ──────────────────────────────────────────────────────
// SKU search returns simple products AND variations. A variation object carries
// parent_id > 0, and its stock must be written via the variation sub-endpoint.
async function wooFindBySku(sku: string) {
  const url = `${WOO_URL}/wp-json/wc/v3/products?sku=${encodeURIComponent(sku)}&per_page=1`;
  const res = await fetch(url, { headers: { Authorization: `Basic ${wooAuth}` } });
  if (!res.ok) {
    console.error(`WC GET sku=${sku} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
    return null;
  }
  const data = await res.json();
  if (!Array.isArray(data) || data.length === 0) return null;
  const p = data[0];
  return {
    id: p.id as number,
    parentId: Number(p.parent_id ?? 0),   // > 0 => this is a variation
    name: p.name as string,
    manageStock: p.manage_stock === true,
    stockQuantity: p.stock_quantity === null ? null : Number(p.stock_quantity),
  };
}

async function wooSetStock(productId: number, parentId: number, qty: number) {
  // Variation stock lives at /products/{parent}/variations/{id}; simple at /products/{id}
  const url = parentId > 0
    ? `${WOO_URL}/wp-json/wc/v3/products/${parentId}/variations/${productId}`
    : `${WOO_URL}/wp-json/wc/v3/products/${productId}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: { Authorization: `Basic ${wooAuth}`, "Content-Type": "application/json" },
    body: JSON.stringify({ stock_quantity: qty, manage_stock: true }),
  });
  if (!res.ok) {
    throw new Error(`WC PUT ${url.replace(WOO_URL, "")} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  const p = await res.json();
  return p.stock_quantity === null ? null : Number(p.stock_quantity);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { status: 200 });
  if (req.method !== "POST")    return new Response("Method not allowed", { status: 405 });

  // ── 1. Auth — iCount sends a static per-account header (X-iCount-Secret).
  //      A ?token= URL guard is also accepted as an alternative. ───────────────
  const headerOk = HEADER_SECRET !== "" && (req.headers.get("X-iCount-Secret") ?? "") === HEADER_SECRET;
  const tokenOk  = WEBHOOK_SECRET !== "" && (new URL(req.url).searchParams.get("token") ?? "") === WEBHOOK_SECRET;
  if (HEADER_SECRET || WEBHOOK_SECRET) {
    if (!headerOk && !tokenOk) {
      console.error("icount-webhook: auth failed (no valid X-iCount-Secret header or token)");
      return new Response("Unauthorized", { status: 401 });
    }
  } else {
    console.warn("icount-webhook: no secret configured — endpoint is UNAUTHENTICATED (capture mode)");
  }

  const rawBody = await req.text();
  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    console.error("icount-webhook: body is not JSON");
    return new Response("Bad Request", { status: 400 });
  }

  const doctype = String(payload.doctype ?? "");
  const docnum  = String(payload.docnum  ?? payload.inv_rec_number ?? "");
  const docId   = `${doctype}-${docnum}`;
  const basedOnOrder = String(payload.based_on_order ?? "").trim();
  const channel = basedOnOrder ? "order_based" : "icount_direct";

  // Capture headers (small allowlist; avoid storing anything secret-bearing verbatim)
  const headers: Record<string, string> = {};
  for (const [k, v] of req.headers) {
    if (["host", "content-type", "user-agent", "x-forwarded-for"].includes(k.toLowerCase())) headers[k] = v;
  }

  // ── 2. Idempotency: skip if we already processed this document ─────────────
  const { data: existing } = await supabase
    .from("icount_webhook_events")
    .select("id, processed")
    .eq("icount_doc_id", docId)
    .maybeSingle();

  if (existing?.processed) {
    console.log(`icount-webhook: duplicate ${docId} (already processed)`);
    return new Response(JSON.stringify({ ok: true, duplicate: true, doc: docId }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }

  // Upsert the raw capture row (idempotent on icount_doc_id)
  await supabase.from("icount_webhook_events").upsert({
    icount_doc_id:  docId,
    doctype, docnum,
    doc_date:       payload.dateissued || null,
    total_with_vat: payload.totalwithvat ? Number(payload.totalwithvat) : null,
    based_on_order: basedOnOrder || null,
    channel,
    raw_payload:    payload,
    headers,
    processed:      false,
  }, { onConflict: "icount_doc_id" });

  // ── 3. Per line item: route by item type ──────────────────────────────────
  //   Coffee bags  → CoffeeFlow products.packed_stock is master (NOT WooCommerce).
  //                  Decrement on every sale channel — Woo doesn't manage them, so
  //                  there's no double-count risk and we want every bag sale counted.
  //   Other items  → WooCommerce stock_quantity is master. Decrement only for direct
  //                  iCount sales; website / order-based docs are already handled by
  //                  Woo natively → skip them.
  const items: IcountItem[] = Array.isArray(payload.items) ? payload.items : [];
  let coffeeHits = 0, wooHits = 0, wrote = 0;
  const notes: string[] = [];

  for (const it of items) {
   try {
    const sku = String(it.sku ?? it.inventory_item_makat ?? "").trim();
    const qty = Number(it.quantity ?? 0);
    if (!sku || !qty) continue;

    const refunded = String(it.is_refunded ?? "0") === "1";
    const delta = refunded ? qty : -qty;   // sale lowers stock; refund returns it

    const adj: Record<string, unknown> = {
      source: "icount", icount_doc_id: docId, sku, description: it.description ?? null,
      qty_delta: delta, applied: false,
    };

    // Is this SKU a CoffeeFlow-managed coffee bag? (many SKUs → one bag)
    const { data: skuMap } = await supabase
      .from("product_sku_map")
      .select("product_id")
      .eq("sku", sku)
      .maybeSingle();

    const prod = skuMap
      ? (await supabase.from("products").select("id, packed_stock").eq("id", skuMap.product_id).maybeSingle()).data
      : null;

    if (prod) {
      // ── Coffee bag → CoffeeFlow is master; decrement packed_stock ──
      coffeeHits++;
      const current = Number(prod.packed_stock ?? 0);
      adj.packed_before = current;
      const newPacked = Math.max(0, current + delta);
      if (current + delta < 0) notes.push(`${sku}: bag stock would go negative`);
      if (DECREMENT_ENABLED) {
        await supabase.from("products").update({ packed_stock: newPacked }).eq("id", prod.id);
        adj.packed_after = newPacked;
        adj.applied = true;
        wrote++;
      } else {
        adj.note = `log_only coffee (intended ${current} → ${newPacked})`;
      }
      await supabase.from("inventory_adjustments").insert(adj);
      continue;
    }

    // ── Non-coffee item → WooCommerce is master ──
    if (basedOnOrder) {
      adj.note = `skipped_order_based (Woo native) order=${basedOnOrder}`;
      notes.push(`${sku}: order-based → Woo native`);
      await supabase.from("inventory_adjustments").insert(adj);
      continue;
    }

    const wc = await wooFindBySku(sku);
    if (!wc) {
      adj.note = "no_woo_match";
      notes.push(`${sku}: no Woo match`);
      await supabase.from("inventory_adjustments").insert(adj);
      continue;
    }
    wooHits++;
    adj.woo_product_id = wc.id;
    adj.woo_before     = wc.stockQuantity;

    if (!wc.manageStock || wc.stockQuantity === null) {
      adj.note = "manage_stock_off";
      notes.push(`${sku}: manage_stock off`);
      await supabase.from("inventory_adjustments").insert(adj);
      continue;
    }

    let newQty = wc.stockQuantity + delta;
    if (newQty < 0) { notes.push(`${sku}: would go negative`); newQty = 0; }

    if (DECREMENT_ENABLED) {
      try {
        const after = await wooSetStock(wc.id, wc.parentId, newQty);
        adj.woo_after = after;
        adj.applied   = true;
        wrote++;
      } catch (e) {
        adj.note = `woo_write_error: ${(e as Error).message}`.slice(0, 280);
        notes.push(`${sku}: write error`);
      }
    } else {
      adj.note = `log_only woo (intended ${wc.stockQuantity} → ${newQty})`;
    }

    await supabase.from("inventory_adjustments").insert(adj);
   } catch (itemErr) {
      // One bad line item must never abort the whole document.
      const m = (itemErr as Error).message ?? String(itemErr);
      notes.push(`item ${String(it?.sku ?? it?.inventory_item_makat ?? "?")}: ${m}`.slice(0, 160));
      console.error(`icount-webhook: ${docId} item error:`, m);
      try {
        await supabase.from("inventory_adjustments").insert({
          source: "icount", icount_doc_id: docId,
          sku: String(it?.sku ?? it?.inventory_item_makat ?? ""), qty_delta: 0, applied: false,
          note: `item_error: ${m}`.slice(0, 280),
        });
      } catch { /* ignore */ }
    }
  }

  const matched = coffeeHits + wooHits;
  const action = items.length === 0 ? "no_items"
    : matched === 0 ? "no_match"
    : DECREMENT_ENABLED ? "stock_updated" : "logged_only";

  await supabase.from("icount_webhook_events")
    .update({ processed: true, action_taken: action, processed_at: new Date().toISOString(),
              note: notes.join("; ").slice(0, 500) || null })
    .eq("icount_doc_id", docId);

  console.log(`icount-webhook: ${docId} action=${action} coffee=${coffeeHits} woo=${wooHits} wrote=${wrote} enabled=${DECREMENT_ENABLED}`);
  return new Response(JSON.stringify({ ok: true, doc: docId, action, coffee: coffeeHits, woo: wooHits, wrote, decrement_enabled: DECREMENT_ENABLED }), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
});
