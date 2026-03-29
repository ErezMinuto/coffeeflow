/**
 * CoffeeFlow — Telegram Bot Webhook (Supabase Edge Function)
 *
 * Send any free Hebrew text in the group to add a waiting customer.
 * Claude AI extracts the name, phone, product and SKU automatically.
 *
 * Commands:
 *   /tasks          → list all pending waiting customers
 *   /done <number>  → mark customer #N as handled
 *
 * Environment secrets (Supabase → Edge Functions → Secrets):
 *   TELEGRAM_BOT_TOKEN       — bot token from BotFather
 *   TELEGRAM_CHAT_ID         — team group chat ID
 *   COFFEEFLOW_USER_ID       — your Clerk user ID
 *   ANTHROPIC_API_KEY        — Claude API key
 *   SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are injected automatically
 */

import { serve }        from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ── Config ─────────────────────────────────────────────────────────────────

const BOT_TOKEN      = Deno.env.get("TELEGRAM_BOT_TOKEN")           ?? "";
const ALLOWED_CHAT   = Deno.env.get("TELEGRAM_CHAT_ID")             ?? "";
const USER_ID        = Deno.env.get("COFFEEFLOW_USER_ID")           ?? "";
const ANTHROPIC_KEY  = Deno.env.get("ANTHROPIC_API_KEY")            ?? "";
const SUPA_URL       = Deno.env.get("SUPABASE_URL")                 ?? "";
const SUPA_KEY       = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")    ?? "";
const WEBHOOK_SECRET = Deno.env.get("TASKS_BOT_WEBHOOK_SECRET")     ?? "";

const supabase = createClient(SUPA_URL, SUPA_KEY);

// ── Telegram helper ─────────────────────────────────────────────────────────

async function reply(chatId: string | number, text: string) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  });
}

// ── Claude AI extractor ────────────────────────────────────────────────────

interface Extracted {
  is_customer_request: boolean;
  is_handled:          boolean;
  handled_customer:    string;
  customer_name:       string;
  phone:               string;
  product:             string;
  sku:                 string;
}

async function extractWithClaude(text: string): Promise<Extracted | null> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key":         ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type":      "application/json",
    },
    body: JSON.stringify({
      model:      "claude-haiku-4-5",
      max_tokens: 300,
      system: `אתה עוזר לחנות קפה וציוד קפה ישראלית.
הודעות בקבוצה הן בעברית. יש שני סוגי הודעות רלוונטיות:

1. הוספת לקוח ממתין — לקוח שרוצה לדעת מתי מוצר חוזר למלאי
2. עדכון טיפול — עובד מדווח שטיפל בלקוח / עדכן לקוח שהמוצר חזר

החזר JSON בלבד, ללא טקסט נוסף:
{
  "is_customer_request": true/false,
  "customer_name": "שם הלקוח החדש",
  "phone": "טלפון",
  "product": "שם המוצר",
  "sku": "מקט אם צוין",
  "is_handled": true/false,
  "handled_customer": "שם הלקוח שטופל"
}

דוגמאות לטיפול: "עדכנתי את דוד", "טיפלתי בשרה לוי", "דוד כהן טופל", "יצרתי קשר עם ירון"
אם שדה לא קיים — החזר מחרוזת ריקה "".`,
      messages: [{ role: "user", content: text }],
    }),
  });

  const json = await res.json();
  const raw  = json.content?.[0]?.text ?? "";

  try {
    // Claude sometimes wraps JSON in markdown code fences — strip them
    const clean = raw.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
    return JSON.parse(clean) as Extracted;
  } catch {
    console.error("Claude parse error:", raw);
    return null;
  }
}

// ── Handlers ───────────────────────────────────────────────────────────────

async function handleMarkedDone(chatId: string, customerName: string) {
  const { data } = await supabase
    .from("waiting_customers")
    .select("*")
    .eq("is_handled", false)
    .ilike("customer_name", `%${customerName}%`)
    .limit(1);

  const row = data?.[0];
  if (!row) {
    await reply(chatId, `⚠️ לא מצאתי לקוח בשם "${customerName}" ברשימת הממתינים`);
    return;
  }

  await supabase
    .from("waiting_customers")
    .update({ is_handled: true })
    .eq("id", row.id);

  await reply(chatId, `✅ <b>${row.customer_name}</b> סומן כטופל`);
}

async function handleFreeText(chatId: string, text: string, fromName: string) {
  const extracted = await extractWithClaude(text);

  if (!extracted) return;

  // Employee marked a customer as handled
  if (extracted.is_handled && extracted.handled_customer) {
    await handleMarkedDone(chatId, extracted.handled_customer);
    return;
  }

  if (!extracted.is_customer_request) return; // unrelated message — ignore silently

  const { customer_name, phone, product, sku } = extracted;

  if (!customer_name) {
    await reply(chatId, "⚠️ לא הצלחתי לזהות שם לקוח — נסה שוב עם פרטים ברורים יותר");
    return;
  }

  const productFull = [product, sku ? `מקט: ${sku}` : ""].filter(Boolean).join(" | ");

  const { error } = await supabase.from("waiting_customers").insert({
    user_id:       USER_ID,
    customer_name,
    phone:         phone   || null,
    product:       productFull || null,
    notes:         `נוסף ע"י ${fromName} דרך טלגרם | הודעה מקורית: ${text}`,
  });

  if (error) {
    console.error("Insert error:", error);
    await reply(chatId, "❌ שגיאה בשמירה — נסה שוב");
    return;
  }

  const lines = [
    `✅ <b>נוסף לרשימת ממתינים!</b>`,
    `👤 ${customer_name}`,
    phone       ? `📞 ${phone}`       : "",
    product     ? `📦 ${product}`     : "",
    sku         ? `🔢 מקט: ${sku}`    : "",
  ].filter(Boolean).join("\n");

  await reply(chatId, lines);
}

async function handleTasks(chatId: string) {
  const { data, error } = await supabase
    .from("waiting_customers")
    .select("*")
    .eq("is_handled", false)
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
    `לסימון כטופל: <code>/done 1</code>`
  );
}

async function handleDone(chatId: string, text: string) {
  const num = parseInt(text.replace(/^\/done\s*/i, "").trim());

  if (isNaN(num) || num < 1) {
    await reply(chatId, "❓ פורמט: /done מספר — לדוגמה: <code>/done 2</code>\nראה מספרים ב-/tasks");
    return;
  }

  const { data } = await supabase
    .from("waiting_customers")
    .select("*")
    .eq("is_handled", false)
    .order("created_at", { ascending: false });

  const row = data?.[num - 1];
  if (!row) {
    await reply(chatId, `⚠️ אין לקוח במספר ${num} — בדוק /tasks`);
    return;
  }

  const { error } = await supabase
    .from("waiting_customers")
    .update({ is_handled: true })
    .eq("id", row.id);

  if (error) { await reply(chatId, "❌ שגיאה בעדכון"); return; }

  await reply(chatId, `✅ <b>${row.customer_name}</b> סומן כטופל`);
}

// ── Main ───────────────────────────────────────────────────────────────────

serve(async (req) => {
  try {
    // Verify Telegram webhook secret token
    if (WEBHOOK_SECRET) {
      const tgSecret = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
      if (tgSecret !== WEBHOOK_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }
    }

    const body    = await req.json();
    const message = body.message;
    if (!message?.text) return new Response("ok");

    const chatId   = String(message.chat.id);
    const text     = message.text.trim();
    const fromName = message.from?.first_name ?? "מישהו";

    if (chatId !== ALLOWED_CHAT) return new Response("ok");

    const lower = text.toLowerCase();

    if      (lower.startsWith("/tasks")) await handleTasks(chatId);
    else if (lower.startsWith("/done"))  await handleDone(chatId, text);
    else if (!lower.startsWith("/"))     await handleFreeText(chatId, text, fromName);

    return new Response("ok");
  } catch (err) {
    console.error("Webhook error:", err);
    return new Response("ok");
  }
});
