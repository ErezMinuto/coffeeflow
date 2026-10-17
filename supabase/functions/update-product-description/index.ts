/**
 * update-product-description — apply find/replace edits to a WooCommerce
 * product's description (the long_description field, NOT post meta).
 *
 * Used for one-off cleanups of legacy product copy (typos, missing specs,
 * formatting fixes). Each replacement is applied in order; an empty replace
 * deletes the matched text. The function returns counts so the caller can
 * verify how many substitutions actually happened.
 *
 * POST body:
 *   { "product_id": 64877,
 *     "replacements": [{ "find": "...", "replace": "..." }, ...],
 *     "dry_run": false }
 *
 * Response on success:
 *   { success, product_id, product_name,
 *     applied: [{ find, replace, count }, ...],
 *     description_length_before, description_length_after, written: true }
 *
 * On dry_run=true, returns the same shape with written:false and includes
 * description_after for inspection — no WC PUT is issued.
 *
 * Notes:
 *  - Plain string find/replace (NOT regex) — caller controls exact text.
 *  - If find isn't present in the description, count=0 (no error). Useful
 *    for idempotent re-runs.
 *  - Same query-string auth + redirect:'manual' pattern as set-product-faq.
 *  - WOO_URL must be canonical (https://www.minuto.co.il, with www).
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const WOO_URL = (Deno.env.get("WOO_URL") || "").replace(/\/+$/, "");
const WOO_KEY = Deno.env.get("WOO_KEY") || "";
const WOO_SEC = Deno.env.get("WOO_SECRET") || "";

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

interface Replacement { find: string; replace: string }

function validateReplacements(input: unknown): Replacement[] | null {
  if (!Array.isArray(input)) return null;
  const out: Replacement[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const find = (item as Record<string, unknown>).find;
    const replace = (item as Record<string, unknown>).replace;
    if (typeof find !== "string" || find.length === 0) continue;
    if (typeof replace !== "string") continue;
    out.push({ find, replace });
  }
  return out.length > 0 ? out : null;
}

function applyReplacements(text: string, reps: Replacement[]): { result: string; counts: number[] } {
  const counts: number[] = [];
  let result = text;
  for (const { find, replace } of reps) {
    let count = 0;
    let idx = result.indexOf(find);
    while (idx !== -1) {
      count++;
      result = result.slice(0, idx) + replace + result.slice(idx + find.length);
      idx = result.indexOf(find, idx + replace.length);
    }
    counts.push(count);
  }
  return { result, counts };
}

async function fetchProduct(productId: number): Promise<{ id: number; name: string; description: string }> {
  const url =
    `${WOO_URL}/wp-json/wc/v3/products/${productId}` +
    `?consumer_key=${encodeURIComponent(WOO_KEY)}` +
    `&consumer_secret=${encodeURIComponent(WOO_SEC)}`;
  const res = await fetch(url, { redirect: "manual" });
  if (res.status >= 300 && res.status < 400) {
    throw new Error(`WC returned redirect ${res.status} → ${res.headers.get("location") || "(none)"}. WOO_URL must be canonical.`);
  }
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`WC fetch failed (${res.status}): ${t.slice(0, 300)}`);
  }
  const body = await res.json();
  return { id: body.id, name: body.name ?? "", description: body.description ?? "" };
}

async function writeDescription(productId: number, description: string): Promise<{ id: number; name: string }> {
  const url =
    `${WOO_URL}/wp-json/wc/v3/products/${productId}` +
    `?consumer_key=${encodeURIComponent(WOO_KEY)}` +
    `&consumer_secret=${encodeURIComponent(WOO_SEC)}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    redirect: "manual",
    body: JSON.stringify({ description }),
  });
  if (res.status >= 300 && res.status < 400) {
    throw new Error(`WC returned redirect ${res.status} → ${res.headers.get("location") || "(none)"}. WOO_URL must be canonical.`);
  }
  let body: Record<string, unknown>;
  try {
    body = await res.json();
  } catch {
    const t = await res.text().catch(() => "");
    throw new Error(`WC returned non-JSON (status ${res.status}): ${t.slice(0, 300)}`);
  }
  if (!body.id || typeof body.id !== "number") {
    throw new Error(`WC error: ${JSON.stringify(body).slice(0, 500)}`);
  }
  return { id: body.id, name: (body.name as string) ?? "" };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  if (!WOO_URL || !WOO_KEY || !WOO_SEC) {
    return json(500, { error: "WOO_URL, WOO_KEY, or WOO_SECRET not configured" });
  }

  let body: { product_id?: unknown; replacements?: unknown; dry_run?: unknown };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  const productId = Number(body.product_id);
  if (!Number.isInteger(productId) || productId <= 0) {
    return json(400, { error: "product_id must be a positive integer" });
  }

  const replacements = validateReplacements(body.replacements);
  if (!replacements) {
    return json(400, { error: "replacements must be a non-empty array of { find, replace } objects (find non-empty string)" });
  }

  const dryRun = Boolean(body.dry_run);

  let product: { id: number; name: string; description: string };
  try {
    product = await fetchProduct(productId);
  } catch (e) {
    return json(502, { error: `Fetch failed: ${(e as Error).message}` });
  }

  const lengthBefore = product.description.length;
  const { result: newDesc, counts } = applyReplacements(product.description, replacements);
  const applied = replacements.map((r, i) => ({ find: r.find, replace: r.replace, count: counts[i] }));

  if (dryRun) {
    return json(200, {
      success: true,
      dry_run: true,
      product_id: product.id,
      product_name: product.name,
      applied,
      description_length_before: lengthBefore,
      description_length_after: newDesc.length,
      description_after: newDesc,
      written: false,
    });
  }

  if (newDesc === product.description) {
    return json(200, {
      success: true,
      product_id: product.id,
      product_name: product.name,
      applied,
      description_length_before: lengthBefore,
      description_length_after: lengthBefore,
      written: false,
      note: "No matches found — description unchanged. Not writing.",
    });
  }

  let writeRes: { id: number; name: string };
  try {
    writeRes = await writeDescription(productId, newDesc);
  } catch (e) {
    return json(502, { error: `Write failed: ${(e as Error).message}` });
  }

  return json(200, {
    success: true,
    product_id: writeRes.id,
    product_name: writeRes.name || product.name,
    applied,
    description_length_before: lengthBefore,
    description_length_after: newDesc.length,
    written: true,
  });
});
