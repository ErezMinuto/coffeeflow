/**
 * CoffeeFlow — Telegram Bot Webhook (Supabase Edge Function)
 *
 * Commands (team group chat only):
 *   /task <free text>   → add a waiting customer — free Hebrew text, bot extracts name + phone
 *   /tasks              → list pending waiting customers
 *   /done <number>      → mark waiting customer #N as handled
 *
 * Examples:
 *   /task ירון מנחם, רוצה לדעת כשמקינטה מוקה מקט 387874 חוזרת למלאי, טלפון 0547373737
 *   /task דנה כהן 052-9876543 Kenya Light 250g
 *
 * Environment variables (Supabase dashboard → Edge Functions → Secrets):
 *   TELEGRAM_BOT_TOKEN    — bot token from BotFather
 *   TELEGRAM_CHAT_ID      — team group chat ID  (e.g. -1001234567890)
 *   COFFEEFLOW_USER_ID    — your Clerk user ID  (find it in CoffeeFlow → Settings)
 *
 * SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically.
 */

import { serve }        from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ── Config ────────────────────────────────────────────────────────────────────

const BOT_TOKEN    = Deno.env.get("TELEGRAM_BOT_TOKEN")        ?? "";
const ALLOWED_CHAT = Deno.env.get("TELEGRAM_CHAT_ID")          ?? "";
const USER_ID      = Deno.env.get("COFFEEFLOW_USER_ID")        ?? "";
const SUPA_URL     = Deno.env.get("SUPABASE_URL")              ?? "";
const SUPA_KEY     = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const supabase = createClient(SUPA_URL, SUPA_KEY);

// ── Telegram helper ───────────────────────────────────────────────────────────

async function reply(chatId: string | number, text: string) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  });
}

// ── Free-text parser ──────────────────────────────────────────────────────────
// Extracts customer_name, phone, and product from a Hebrew free-text string.
//
// Strategy:
//   1. Find Israeli phone number anywhere in the text
//   2. Strip the phone (and surrounding label like "טלפון") → clean text
//   3. Split clean text on first comma: left = name, right = product/request

interface ParsedTask {
  customer_name: string;
  phone:         string;
  product:       string;
  notes:         string; // always stores the original full text
}

function parseTask(raw: string): ParsedTask {
  // Israeli phone: 05X-XXXXXXX, 05XXXXXXXX, +972-5X-XXXXXXX, etc.
  const phoneRe = /(?:\+972[-\s]?|0)(?:5\d|[23489]\d)[-\s]?\d{3}[-\s]?\d{4}/g;
  const phoneMatches = raw.match(phoneRe);
  const phone = phoneMatches ? phoneMatches[0].replace(/[-\s]/g, "") : "";

  // Strip phone + preceding label (טלפון / נייד / מספר) from text
  let clean = raw
    .replace(/[,\s]*(טלפון|נייד|מס'?|מספר)[:\s]*/gi, ", ")
    .replace(phoneRe, "")
    .replace(/,\s*,/g, ",")
    .replace(/,\s*$/,  "")
    .trim();

  // Split on first comma → name | product description
  const commaIdx      = clean.indexOf(",");
  const customer_name = (commaIdx !== -1 ? clean.slice(0, commaIdx) : clean).trim();
  const product       = (commaIdx !== -1 ? clean.slice(commaIdx + 1) : "").trim();

  return { customer_name, phone, product, notes: raw };
}

// ── Command handlers ──────────────────────────────────────────────────────────

async function handleTask(chatId: string, text: string, fromName: string) {
  const content = text.replace(/^\/task\s*/i, "").trim();

  if (!content) {
    await reply(chatId,
      "❓ <b>שלח את פרטי הלקוח אחרי /task, לדוגמה:</b>\n" +
      "<code>/task ירון מנחם, רוצה מקינטה מוקה מקט 387874, טלפון 0547373737</code>"
    );
    return;
  }

  const parsed = parseTask(content);

  if (!parsed.customer_name) {
    await reply(chatId, "⚠️ לא הצלחתי לזהות שם לקוח — נסה שוב");
    return;
  }

  const { error } = await supabase.from("waiting_customers").insert({
    user_id:       USER_ID,
    customer_name: parsed.customer_name,
    phone:         parsed.phone,
    product:       parsed.product || parsed.notes,
    notes:         `נוסף ע"י ${fromName} דרך טלגרם`,
  });

  if (error) {
    console.error("Insert error:", error);
    await reply(chatId, "❌ שגיאה בשמירה — בדוק את הלוגים");
    return;
  }

  const lines = [
    `✅ <b>נוסף לרשימת ממתינים!</b>`,
    `👤 ${parsed.customer_name}`,
    parsed.phone   ? `📞 ${parsed.phone}`   : "",
    parsed.product ? `📦 ${parsed.product}` : "",
  ].filter(Boolean).join("\n");

  await reply(chatId, lines);
}

async function handleTasks(chatId: string) {
  const { data, error } = await supabase
    .from("waiting_customers")
    .select("*")
    .is("notified_at", null)
    .order("created_at", { ascending: false });

  if (error) { await reply(chatId, "❌ שגיאה בטעינת הרשימה"); return; }

  if (!data || data.length === 0) {
    await reply(chatId, "✅ אין לקוחות ממתינים כרגע 🎉");
    return;
  }

  const lines = data.map((wc, i) => {
    const phone   = wc.phone   ? ` | 📞 ${wc.phone}`   : "";
    const product = wc.product ? ` | 📦 ${wc.product}` : "";
    return `${i + 1}. <b>${wc.customer_name}</b>${phone}${product}`;
  }).join("\n");

  await reply(chatId,
    `📋 <b>לקוחות ממתינים (${data.length}):</b>\n\n${lines}\n\n` +
    `לסימון כטופל: /done 1`
  );
}

async function handleDone(chatId: string, text: string) {
  const num = parseInt(text.replace(/^\/done\s*/i, "").trim());

  if (isNaN(num) || num < 1) {
    await reply(chatId, "❓ פורמט: /done מספר — לדוגמה: <code>/done 2</code>\nראה את המספרים ב-/tasks");
    return;
  }

  const { data } = await supabase
    .from("waiting_customers")
    .select("*")
    .is("notified_at", null)
    .order("created_at", { ascending: false });

  const row = data?.[num - 1];
  if (!row) {
    await reply(chatId, `⚠️ אין לקוח במספר ${num} — בדוק /tasks`);
    return;
  }

  const { error } = await supabase
    .from("waiting_customers")
    .update({ notified_at: new Date().toISOString() })
    .eq("id", row.id);

  if (error) { await reply(chatId, "❌ שגיאה בעדכון"); return; }

  await reply(chatId, `✅ <b>${row.customer_name}</b> סומן כטופל`);
}

// ── Main handler ──────────────────────────────────────────────────────────────

serve(async (req) => {
  try {
    const body    = await req.json();
    const message = body.message;
    if (!message?.text) return new Response("ok");

    const chatId   = String(message.chat.id);
    const text     = message.text.trim();
    const fromName = message.from?.first_name ?? "מישהו";

    // Only act in the configured group
    if (chatId !== ALLOWED_CHAT) return new Response("ok");

    const lower = text.toLowerCase();
    if      (lower.startsWith("/task"))  await handleTask(chatId, text, fromName);
    else if (lower.startsWith("/tasks")) await handleTasks(chatId);
    else if (lower.startsWith("/done"))  await handleDone(chatId, text);

    return new Response("ok");
  } catch (err) {
    console.error("Webhook error:", err);
    return new Response("ok");
  }
});
