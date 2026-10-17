/**
 * CoffeeFlow — Green-coffee low-stock alert (Supabase Edge Function)
 *
 * Replaces the green-stock alert that used to run inside the MFlow Railway
 * scraper (workers/mflow-scraper/alert.js), now that MFlow/Railway is retired.
 *
 * Daily (pg_cron): reads `origins`, flags any with < THRESHOLD_DAYS of green
 * coffee left (stock / daily_average), writes a short Hebrew Telegram alert
 * (Claude-generated, plain fallback) to the team group chat. Silent when all OK.
 *
 * Test without sending:  POST { "test": true }  → returns the computed list +
 * message but sends nothing.
 *
 * Secrets: COFFEEFLOW_USER_ID, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
 *          ANTHROPIC_API_KEY (optional), SUPABASE_URL/SERVICE_ROLE_KEY (auto).
 *
 * Deploy: supabase functions deploy green-stock-alert --project-ref <ref> --no-verify-jwt
 */

import { serve }        from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPA_URL  = Deno.env.get("SUPABASE_URL")              ?? "";
const SUPA_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const USER_ID   = Deno.env.get("COFFEEFLOW_USER_ID")        ?? "";
const TG_TOKEN  = Deno.env.get("TELEGRAM_BOT_TOKEN")        ?? "";
const TG_CHAT   = Deno.env.get("TELEGRAM_CHAT_ID")          ?? "";
const ANTHROPIC = Deno.env.get("ANTHROPIC_API_KEY")         ?? "";
const THRESHOLD_DAYS = Number(Deno.env.get("GREEN_STOCK_THRESHOLD_DAYS") ?? "14");

const supabase = createClient(SUPA_URL, SUPA_KEY);

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

const daysLeft = (o: any) => (o.daily_average > 0 ? Number(o.stock ?? 0) / o.daily_average : Infinity);

async function sendTelegram(message: string): Promise<boolean> {
  const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TG_CHAT, text: message, parse_mode: "Markdown" }),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) console.error("Telegram error:", data.description);
  return !!data.ok;
}

function plainMessage(lowStock: any[]): string {
  let m = "☕ *מינוטו — התראת מלאי פולי גלם*\n\n";
  for (const o of lowStock) {
    m += `⚠️ *${o.name}*\n`;
    m += `מלאי גלם: ${Number(o.stock ?? 0).toFixed(1)} ק״ג\n`;
    m += `ממוצע יומי: ${o.daily_average} ק״ג\n`;
    m += `נותרו: ${daysLeft(o).toFixed(1)} ימים\n\n`;
  }
  return m;
}

async function claudeMessage(lowStock: any[]): Promise<string> {
  const lines = lowStock.map((o) =>
    `${o.name}: ${Number(o.stock ?? 0).toFixed(1)} ק״ג גלם, ${o.daily_average} ק״ג ליום בממוצע, ${daysLeft(o).toFixed(1)} ימים נותרו`
  ).join("\n");

  const prompt = `את/ה עוזר/ת של בית הקלייה מינוטו קפה ברחובות.
לפולי הגלם של המקורות הבאים נותרו פחות מ-${THRESHOLD_DAYS} ימי מלאי:

${lines}

כתוב/כתבי הודעת התראה קצרה ומעשית בעברית למנהל הקלייה.
ציין/ציני כמה ימים נותרו לכל מקור והצע/הציעי לקלות אם יש מלאי גלם.
השתמש/י באימוג'ים במקום מקפים או נקודות. עברית טבעית, ללא מקפים ארוכים.
פורמט Telegram Markdown (*מודגש*). קצר וברור.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 500, messages: [{ role: "user", content: prompt }] }),
  });
  const data = await res.json();
  if (data?.content?.[0]?.text) return data.content[0].text;
  throw new Error("Claude API failed: " + JSON.stringify(data).slice(0, 200));
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  let body: any = {};
  try { body = await req.json(); } catch { /* cron calls with empty body */ }
  const testOnly = body?.test === true;

  try {
    let q = supabase.from("origins").select("id, name, roasted_stock, stock, daily_average");
    if (USER_ID) q = q.eq("user_id", USER_ID);
    const { data: origins, error } = await q;
    if (error) throw error;

    const lowStock = (origins ?? []).filter((o) => daysLeft(o) < THRESHOLD_DAYS)
      .sort((a, b) => daysLeft(a) - daysLeft(b));

    if (lowStock.length === 0) {
      return json({ ok: true, low_stock: 0, sent: false, note: "all origins above threshold" });
    }

    const message = ANTHROPIC ? await claudeMessage(lowStock) : plainMessage(lowStock);

    if (testOnly) {
      return json({ ok: true, test: true, low_stock: lowStock.length, would_send: true,
        origins: lowStock.map((o) => ({ name: o.name, stock: o.stock, daily_average: o.daily_average, days_left: Number(daysLeft(o).toFixed(1)) })),
        message });
    }

    const sent = await sendTelegram(message);
    return json({ ok: true, low_stock: lowStock.length, sent, origins: lowStock.map((o) => o.name) });
  } catch (e) {
    return json({ error: String(e instanceof Error ? e.message : e) }, 500);
  }
});
