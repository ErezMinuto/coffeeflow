/**
 * CoffeeFlow — WooCommerce Stock Webhook (Supabase Edge Function)
 *
 * Receives product.updated events from WooCommerce.
 * When a product is back in stock, finds matching waiting customers
 * and sends a Telegram notification to the team group.
 */

import { serve }        from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const BOT_TOKEN        = Deno.env.get("TELEGRAM_BOT_TOKEN")        ?? "";
const CHAT_ID          = Deno.env.get("TELEGRAM_CHAT_ID")          ?? "";
const SUPA_URL         = Deno.env.get("SUPABASE_URL")              ?? "";
const SUPA_KEY         = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const WOO_WEBHOOK_SECRET = Deno.env.get("WOO_WEBHOOK_SECRET")      ?? "";

const supabase = createClient(SUPA_URL, SUPA_KEY);

// ── WooCommerce HMAC-SHA256 signature verification ────────────────────────────
// WooCommerce signs the raw body with the webhook secret using HMAC-SHA256,
// base64-encodes the result, and sends it as X-WC-Webhook-Signature.
async function verifyWooSignature(req: Request, rawBody: string): Promise<boolean> {
  if (!WOO_WEBHOOK_SECRET) return false;   // secret not set → deny all
  const signature = req.headers.get("X-WC-Webhook-Signature") ?? "";
  if (!signature) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(WOO_WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const sigBytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const computed = btoa(String.fromCharCode(...new Uint8Array(sigBytes)));
  return computed === signature;
}

async function sendTelegram(text: string) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: "HTML" }),
  });
}

function findMatches(waitingCustomers: any[], productName: string, sku: string) {
  // 1. Match by SKU (most reliable)
  if (sku) {
    const skuMatches = waitingCustomers.filter(wc =>
      wc.product?.includes(sku)
    );
    if (skuMatches.length > 0) return skuMatches;
  }

  // 2. Match by product name words (2+ chars)
  const words = productName
    .toLowerCase()
    .split(/\s+/)
    .filter(w => w.length > 2);

  return waitingCustomers.filter(wc => {
    if (!wc.product) return false;
    const lower = wc.product.toLowerCase();
    return words.filter(w => lower.includes(w)).length >= 2;
  });
}

serve(async (req) => {
  try {
    // ── HMAC signature verification ─────────────────────────────────────────
    const rawBody = await req.text();
    const valid   = await verifyWooSignature(req, rawBody);
    if (!valid) {
      console.error("WooCommerce webhook: invalid or missing HMAC signature");
      return new Response("Unauthorized", { status: 401 });
    }

    const body = JSON.parse(rawBody);

    // Only act when product is back in stock
    if (body.stock_status !== "instock") return new Response("ok");

    const productName: string = body.name ?? "";
    const sku: string         = body.sku  ?? "";

    if (!productName) return new Response("ok");

    // Load all un-notified waiting customers
    const { data: pending } = await supabase
      .from("waiting_customers")
      .select("*")
      .is("notified_at", null);

    if (!pending || pending.length === 0) return new Response("ok");

    const matches = findMatches(pending, productName, sku);
    if (matches.length === 0) return new Response("ok");

    // Build Telegram message
    const customerLines = matches.map((wc, i) => {
      const phone   = wc.phone   ? ` — 📞 ${wc.phone}`   : "";
      const product = wc.product ? `\n   📦 ${wc.product}` : "";
      return `${i + 1}. <b>${wc.customer_name}</b>${phone}${product}`;
    }).join("\n");

    const msg = [
      `🛍️ <b>מוצר חזר למלאי!</b>`,
      ``,
      `📦 ${productName}`,
      sku ? `🔢 מקט: ${sku}` : null,
      ``,
      `👥 <b>לקוחות ממתינים (${matches.length}):</b>`,
      customerLines,
      ``,
      `✅ לסימון כטופל שלחו <code>/done [מספר]</code> בקבוצה`,
    ].filter(l => l !== null).join("\n");

    await sendTelegram(msg);

    // Mark matched customers as notified
    await supabase
      .from("waiting_customers")
      .update({ notified_at: new Date().toISOString() })
      .in("id", matches.map((wc: any) => wc.id));

    console.log(`Notified ${matches.length} customers for: ${productName}`);
    return new Response("ok");

  } catch (err) {
    console.error("WooCommerce webhook error:", err);
    return new Response("ok");
  }
});
