import { serve }        from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")        ?? "";
const CHAT_ID   = Deno.env.get("TELEGRAM_CHAT_ID")          ?? "";
const SUPA_URL  = Deno.env.get("SUPABASE_URL")              ?? "";
const SUPA_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const WOO_URL   = Deno.env.get("WOO_URL")                   ?? "";
const WOO_KEY   = Deno.env.get("WOO_KEY")                   ?? "";
const WOO_SEC   = Deno.env.get("WOO_SECRET")                ?? "";

const supabase = createClient(SUPA_URL, SUPA_KEY);
const wooAuth  = btoa(`${WOO_KEY}:${WOO_SEC}`);

// One "✅ <name>" button per customer — telegram-bot (same bot token, so it
// receives the press) marks that customer handled. No numbers to type.
function doneKeyboard(rows: any[]) {
  return {
    inline_keyboard: rows.map((r) => [{
      text: `✅ ${r.customer_name}`.slice(0, 60),
      callback_data: `done:${r.id}`,
    }]),
  };
}

async function sendTelegram(text: string, replyMarkup?: unknown) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: CHAT_ID, text, parse_mode: "HTML",
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    }),
  });
}

async function checkStockBySku(sku: string) {
  const url = `${WOO_URL}/wp-json/wc/v3/products?sku=${encodeURIComponent(sku)}&per_page=1`;
  const res  = await fetch(url, { headers: { Authorization: `Basic ${wooAuth}` } });
  const text = await res.text();
  console.log(`WC API [${sku}] status=${res.status} body=${text.slice(0, 300)}`);
  if (!res.ok) return null;
  const data = JSON.parse(text);
  if (!data.length) return null;
  return { inStock: data[0].stock_status === "instock", name: data[0].name };
}

function extractSku(productText: string): string | null {
  const m = productText.match(/(?:מקט|sku)[:\s]+([A-Za-z0-9\-]+)/i);
  return m ? m[1].trim() : null;
}

serve(async (_req) => {
  try {
    const { data: pending } = await supabase
      .from("waiting_customers")
      .select("*")
      .eq("is_handled", false)
      // Alert once per customer. Without this the hourly cron re-sent the
      // same "back in stock" message every run until someone marked it done.
      .is("notified_at", null);

    if (!pending || pending.length === 0)
      return new Response(JSON.stringify({ checked: 0, notified: 0 }));

    const skuMap: Record<string, any[]> = {};
    for (const wc of pending) {
      if (!wc.product) continue;
      const sku = extractSku(wc.product);
      if (!sku) continue;
      if (!skuMap[sku]) skuMap[sku] = [];
      skuMap[sku].push(wc);
    }

    let notified = 0;

    for (const [sku, customers] of Object.entries(skuMap)) {
      const stock = await checkStockBySku(sku);
      if (!stock?.inStock) continue;

      const customerLines = customers.map((wc: any, i: number) => {
        const phone = wc.phone ? ` — 📞 <code>${wc.phone}</code>` : "";
        return `${i + 1}. <b>${wc.customer_name}</b>${phone}`;
      }).join("\n");

      await sendTelegram([
        `🛍️ <b>מוצר חזר למלאי!</b>`,
        ``,
        `📦 ${stock.name}`,
        `🔢 מקט: ${sku}`,
        ``,
        `👥 <b>לקוחות ממתינים (${customers.length}):</b>`,
        customerLines,
        ``,
        `✅ לסימון כטופל לחצו על הכפתור`,
      ].join("\n"), doneKeyboard(customers));

      await supabase
        .from("waiting_customers")
        .update({ notified_at: new Date().toISOString() })
        .in("id", customers.map((wc: any) => wc.id));

      notified += customers.length;
    }

    const skus = Object.keys(skuMap);
    return new Response(JSON.stringify({ checked: skus.length, skus, notified }));
  } catch (err) {
    console.error("Stock check error:", err);
    return new Response("error", { status: 500 });
  }
});
