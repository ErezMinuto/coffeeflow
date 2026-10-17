/**
 * set-product-faq — write FAQ JSON to a WooCommerce product's post meta.
 *
 * Used by the dashboard / one-off scripts to push AI-generated or hand-written
 * Q&A into the `_minuto_faq_published` post meta key. The minuto-product-faq
 * WP plugin reads from that key and renders the accordion + FAQPage JSON-LD.
 *
 * POST body: { "product_id": 65135, "faq": [{ "q": "...", "a": "..." }, ...] }
 *
 * Response on success:
 *   { "success": true, "product_id": 65135, "product_name": "...", "faq_count": 5 }
 *
 * Notes:
 *  - Uses query-string auth + redirect:'manual' to dodge the WC POST→GET
 *    redirect-strips-body bug (see CLAUDE.md memory).
 *  - WOO_URL must be canonical (https://www.minuto.co.il with www).
 *  - Validates response shape — HTTP 200 alone is not enough.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

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
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  if (!WOO_URL || !WOO_KEY || !WOO_SEC) {
    return json(500, { error: "WOO_URL, WOO_KEY, or WOO_SECRET not configured" });
  }

  let body: { product_id?: unknown; faq?: unknown };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  const productId = Number(body.product_id);
  if (!Number.isInteger(productId) || productId <= 0) {
    return json(400, { error: "product_id must be a positive integer" });
  }

  const faq = validateFaq(body.faq);
  if (!faq) {
    return json(400, { error: "faq must be a non-empty array of { q, a } objects" });
  }

  // Stored as JSON string — same shape the plugin's get_published_faq expects.
  const faqJson = JSON.stringify(faq);

  // Query-string auth + manual redirect → avoids POST→GET body-strip bug.
  const wcUrl =
    `${WOO_URL}/wp-json/wc/v3/products/${productId}` +
    `?consumer_key=${encodeURIComponent(WOO_KEY)}` +
    `&consumer_secret=${encodeURIComponent(WOO_SEC)}`;

  const wcRes = await fetch(wcUrl, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    redirect: "manual",
    body: JSON.stringify({
      meta_data: [{ key: META_KEY, value: faqJson }],
    }),
  });

  // Detect a redirect (would mean WOO_URL isn't canonical).
  if (wcRes.status >= 300 && wcRes.status < 400) {
    const loc = wcRes.headers.get("location") || "(none)";
    return json(502, {
      error: `WC returned redirect ${wcRes.status} → ${loc}. WOO_URL must be canonical (https://www.minuto.co.il, with www).`,
    });
  }

  // Parse response. WC returns JSON on both success and error paths.
  let wcBody: Record<string, unknown>;
  try {
    wcBody = await wcRes.json();
  } catch {
    const text = await wcRes.text().catch(() => "");
    return json(502, {
      error: `WC returned non-JSON (status ${wcRes.status}): ${text.slice(0, 300)}`,
    });
  }

  // Validate response shape — WC error responses have { code, message, data }.
  if (!wcBody.id || typeof wcBody.id !== "number") {
    return json(502, {
      error: `WC error: ${JSON.stringify(wcBody).slice(0, 500)}`,
    });
  }

  return json(200, {
    success: true,
    product_id: wcBody.id,
    product_name: wcBody.name ?? null,
    faq_count: faq.length,
    meta_key: META_KEY,
  });
});
