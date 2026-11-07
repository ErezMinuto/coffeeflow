import { serve }        from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.116.0";
import { isServiceCaller, unauthorized } from "../_shared/service_caller.ts";
import { createLogger, type Logger } from "../_shared/logger.ts";

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

async function sendTelegram(text: string, replyMarkup?: unknown, log?: Logger) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: CHAT_ID, text, parse_mode: "HTML",
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    }),
  });
  // A rejected send used to vanish: the customers were still marked notified.
  if (!res.ok) log?.error("telegram.send.fail", `Telegram sendMessage HTTP ${res.status}`, { status: res.status });
}

async function checkStockBySku(sku: string, log?: Logger) {
  const url = `${WOO_URL}/wp-json/wc/v3/products?sku=${encodeURIComponent(sku)}&per_page=1`;
  const res  = await fetch(url, { headers: { Authorization: `Basic ${wooAuth}` } });
  const text = await res.text();
  console.log(`WC API [${sku}] status=${res.status} body=${text.slice(0, 300)}`);
  if (!res.ok) { log?.warn("woo.fetch.fail", `WC products?sku HTTP ${res.status}`, { sku, status: res.status }); return null; }
  const data = JSON.parse(text);
  if (!data.length) return null;
  return { inStock: data[0].stock_status === "instock", name: data[0].name };
}

function extractSku(productText: string): string | null {
  const m = productText.match(/(?:מקט|sku)[:\s]+([A-Za-z0-9\-]+)/i);
  return m ? m[1].trim() : null;
}

serve(async (req) => {
  // verify_jwt is off, so the caller is checked here. Only the
  // coffeeflow-stock-check cron calls this; it alerts the team group.
  if (!(await isServiceCaller(req))) return unauthorized();
  // Created after the auth check so an unauthenticated caller cannot write log rows.
  const log = createLogger("woo-stock-check");
  try {
    const { data: pending, error: pendingErr } = await supabase
      .from("waiting_customers")
      .select("*")
      .eq("is_handled", false)
      // Alert once per customer. Without this the hourly cron re-sent the
      // same "back in stock" message every run until someone marked it done.
      .is("notified_at", null);

    if (pendingErr) log.error("pending.fetch.fail", "waiting_customers read failed", { code: pendingErr.code, message: pendingErr.message });

    if (!pending || pending.length === 0) {
      await log.finish(pendingErr ? "error" : "success", { pending: 0, checked: 0, notified: 0 });
      return new Response(JSON.stringify({ checked: 0, notified: 0, run_id: log.runId }));
    }

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
      const stock = await checkStockBySku(sku, log);
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
      ].join("\n"), doneKeyboard(customers), log);

      const { error: markErr } = await supabase
        .from("waiting_customers")
        .update({ notified_at: new Date().toISOString() })
        .in("id", customers.map((wc: any) => wc.id));
      // Not marked → the next hourly run alerts the same customers again.
      if (markErr) log.error("notified.mark.fail", "notified_at update failed", { sku, customers: customers.length, code: markErr.code, message: markErr.message });

      notified += customers.length;
    }

    const skus = Object.keys(skuMap);
    // Pending customers whose product text has no parsable SKU are never checked.
    const noSku = pending.length - Object.values(skuMap).reduce((n, c) => n + c.length, 0);
    if (noSku > 0) log.warn("pending.no_sku", `${noSku} waiting customer(s) have no SKU in the product text`, { count: noSku });
    await log.finish("success", { pending: pending.length, checked: skus.length, notified, no_sku: noSku });
    return new Response(JSON.stringify({ checked: skus.length, skus, notified, run_id: log.runId }));
  } catch (err) {
    console.error("Stock check error:", err);
    log.error("run.throw", "stock check aborted by an unhandled error", undefined, err);
    await log.finish("error");
    return new Response(JSON.stringify({ error: "error", run_id: log.runId }), { status: 500 });
  }
});
