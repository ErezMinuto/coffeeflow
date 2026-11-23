/**
 * set-product-faq — write FAQ JSON to a WooCommerce product's post meta.
 *
 * Used by the dashboard / one-off scripts to push AI-generated or hand-written
 * Q&A into the `_minuto_faq_published` post meta key. The minuto-product-faq
 * WP plugin reads from that key and renders the accordion + FAQPage JSON-LD.
 *
 * POST body: { "product_id": 65135, "faq": [{ "q": "...", "a": "..." }, ...] }
 *
 * Optional "change": { change_id?, requested_by?, reason?, approved_by?, undo_of? }
 *   (see _shared/site_change_log.ts). Every write saves the FAQ it replaces in
 *   public.site_change_log first; if that backup can't be saved, nothing is
 *   written. An empty faq is accepted only with change.undo_of (restoring "no FAQ").
 *
 * Response on success:
 *   { "success": true, "product_id": 65135, "product_name": "...", "faq_count": 5, "change_id": "<uuid>" }
 *
 * Notes:
 *  - Uses query-string auth + redirect:'manual' to dodge the WC POST→GET
 *    redirect-strips-body bug (see CLAUDE.md memory).
 *  - WOO_URL must be canonical (https://www.minuto.co.il with www).
 *  - Validates response shape — HTTP 200 alone is not enough.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { isServiceCaller, unauthorized } from "../_shared/service_caller.ts";
import { beginChange, finishChange, parseChangeContext } from "../_shared/site_change_log.ts";
import { readProduct, siteEnv, writeProduct } from "../_shared/site_io.ts";

const WOO_URL = (Deno.env.get("WOO_URL") || "").replace(/\/+$/, "");
const WOO_KEY = Deno.env.get("WOO_KEY") || "";
const WOO_SEC = Deno.env.get("WOO_SECRET") || "";

const META_KEY = "_minuto_faq_published";

const cors = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, x-client-info, apikey",
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

interface FaqItem { q: string; a: string }

function validateFaq(input: unknown): FaqItem[] | null {
  if (!Array.isArray(input)) return null;
  const out: FaqItem[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const q = typeof (item as Record<string, unknown>).q === "string" ? ((item as Record<string, unknown>).q as string).trim() : "";
    const a = typeof (item as Record<string, unknown>).a === "string" ? ((item as Record<string, unknown>).a as string).trim() : "";
    if (!q || !a) continue;
    out.push({ q, a });
  }
  return out.length > 0 ? out : null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  // verify_jwt is off, so the caller is checked here. Writes live FAQ on any WooCommerce product. Only generate-product-faq (with
  // the service key) or an operator with the service key calls it.
  if (!(await isServiceCaller(req))) return unauthorized(cors);
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  if (!WOO_URL || !WOO_KEY || !WOO_SEC) {
    return json(500, { error: "WOO_URL, WOO_KEY, or WOO_SECRET not configured" });
  }

  let body: { product_id?: unknown; faq?: unknown; change?: unknown };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  const productId = Number(body.product_id);
  if (!Number.isInteger(productId) || productId <= 0) {
    return json(400, { error: "product_id must be a positive integer" });
  }

  const ctx = parseChangeContext(body.change);
  // An empty FAQ is only accepted when undoing a change to a product that had
  // none — restoring "no FAQ" is the point of that undo.
  const faq = validateFaq(body.faq) ?? (ctx.undo_of && Array.isArray(body.faq) && body.faq.length === 0 ? [] : null);
  if (!faq) {
    return json(400, { error: "faq must be a non-empty array of { q, a } objects" });
  }

  // Back up the FAQ this write replaces. No backup → no write.
  const env = siteEnv({ wpUrl: WOO_URL, wooKey: WOO_KEY, wooSecret: WOO_SEC });
  let changeId: string;
  try {
    const current = await readProduct(env, productId);
    changeId = await beginChange({
      target_type:   "product_faq",
      target_id:     productId,
      target_url:    current.permalink || null,
      target_title:  current.name || null,
      before:        current.faq,
      before_source: "woo_rest",
      after:         faq,
      source_fn:     "set-product-faq",
      ctx,
    });
  } catch (e) {
    return json(502, { error: `Not written: could not back up the current FAQ first (${(e as Error).message})` });
  }

  let written: { id: number; name: string };
  try {
    written = await writeProduct(env, productId, { faq });
  } catch (e) {
    const error = `WC error: ${(e as Error).message}`;
    await finishChange(changeId, { ok: false, error });
    return json(502, { error, change_id: changeId });
  }

  // Record the FAQ as WooCommerce stored it, so a later undo compares like with like.
  let stored: unknown = undefined;
  try { stored = (await readProduct(env, productId)).faq; } catch { /* keep `after` as sent */ }
  const logged = await finishChange(changeId, { ok: true, after: stored });

  return json(200, {
    success: true,
    change_id: changeId,
    ...(logged.logged ? {} : { change_log_warning: logged.error }),
    product_id: written.id,
    product_name: written.name || null,
    faq_count: faq.length,
    meta_key: META_KEY,
  });
});
