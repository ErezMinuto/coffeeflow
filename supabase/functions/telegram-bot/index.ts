/**
 * CoffeeFlow — Telegram Bot Webhook (Supabase Edge Function)
 *
 * Send any free Hebrew text in the group to add a waiting customer.
 * Claude AI extracts the name, phone, product and SKU automatically.
 *
 * Commands:
 *   /tasks          → list all pending waiting customers
 *   /done <number>  → mark customer #N as handled
 *   /stock          → show current packed bag inventory per product
 *
 * Packing reports (free text):
 *   "ארזתי 20 שקיות Ethiopia Light"  →  deducts roasted stock via recipe
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
  is_packing_report:   boolean;
  packing_product:     string;
  packing_bags:        number;
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
הודעות בקבוצה הן בעברית. יש שלושה סוגי הודעות רלוונטיות:

1. הוספת לקוח ממתין — לקוח שרוצה לדעת מתי מוצר חוזר למלאי
2. עדכון טיפול — עובד מדווח שטיפל בלקוח / עדכן לקוח שהמוצר חזר
3. דיווח אריזה — עובד מדווח כמה שקיות ארז
   דוגמאות: "ארזתי 20 שקיות אתיופיה", "עשיתי 15 שקיות קניה לייט", "packed 30 bags of ethiopia light"

החזר JSON בלבד, ללא טקסט נוסף:
{
  "is_customer_request": true/false,
  "customer_name": "שם הלקוח החדש",
  "phone": "טלפון",
  "product": "שם המוצר",
  "sku": "מקט אם צוין",
  "is_handled": true/false,
  "handled_customer": "שם הלקוח שטופל",
  "is_packing_report": true/false,
  "packing_product": "שם המוצר שנארז",
  "packing_bags": 0
}

דוגמאות לטיפול: "עדכנתי את דוד", "טיפלתי בשרה לוי", "דוד כהן טופל", "יצרתי קשר עם ירון"
אם שדה לא קיים — החזר מחרוזת ריקה "" או 0 למספרים.`,
      messages: [{ role: "user", content: text }],
    }),
  });

  const json = await res.json();
  const raw  = json.content?.[0]?.text ?? "";

  try {
    const clean = raw.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
    return JSON.parse(clean) as Extracted;
  } catch {
    console.error("Claude parse error:", raw);
    return null;
  }
}

// ── Waiting customer handlers ──────────────────────────────────────────────

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

// ── Packing handlers ───────────────────────────────────────────────────────

async function handleStock(chatId: string) {
  const { data: products, error } = await supabase
    .from("products")
    .select("id, name, size, packed_stock")
    .eq("user_id", USER_ID)
    .order("name");

  if (error || !products || products.length === 0) {
    await reply(chatId, "📦 אין מוצרים מוגדרים");
    return;
  }

  const lines = products.map(p => {
    const stock = p.packed_stock ?? 0;
    const icon  = stock === 0 ? "🔴" : stock < 10 ? "🟡" : "🟢";
    return `${icon} ${p.name} ${p.size}g: <b>${stock}</b> שקיות`;
  }).join("\n");

  await reply(chatId, `📦 <b>מלאי שקיות ארוזות:</b>\n\n${lines}`);
}

async function handlePacking(chatId: string, productName: string, bagsCount: number, fromName: string) {
  if (!productName || bagsCount <= 0) {
    await reply(chatId, "⚠️ לא הצלחתי לזהות מוצר או כמות — נסה שוב, למשל: <code>ארזתי 20 שקיות Ethiopia Light</code>");
    return;
  }

  // 1. Load products
  const { data: products } = await supabase
    .from("products")
    .select("*")
    .eq("user_id", USER_ID);

  if (!products || products.length === 0) {
    await reply(chatId, "❌ לא נמצאו מוצרים במערכת");
    return;
  }

  // 2. Fuzzy match by product name
  const normalizedInput = productName.toLowerCase().trim();
  const matches = products.filter(p =>
    p.name.toLowerCase().includes(normalizedInput) ||
    normalizedInput.includes(p.name.toLowerCase())
  );

  if (matches.length === 0) {
    await reply(chatId, `⚠️ לא מצאתי מוצר בשם "<b>${productName}</b>"\n\nהשתמש ב-/stock לרשימת המוצרים`);
    return;
  }

  if (matches.length > 1) {
    const list = matches.map((p, i) => `${i + 1}. ${p.name} ${p.size}g`).join("\n");
    await reply(chatId, `❓ מצאתי כמה מוצרים תואמים:\n\n${list}\n\nנסה שוב עם שם מדויק יותר`);
    return;
  }

  const product = matches[0];
  const sizeKg  = product.size / 1000;
  const recipe: Array<{ sourceType: string; sourceId?: number; originId?: number; percentage: number }> = product.recipe ?? [];

  if (recipe.length === 0) {
    await reply(chatId, `❌ למוצר "${product.name}" אין מתכון מוגדר`);
    return;
  }

  // 3. Load origins and profiles
  const { data: origins  } = await supabase.from("origins").select("*").eq("user_id", USER_ID);
  const { data: profiles } = await supabase.from("roast_profiles").select("*").eq("user_id", USER_ID);

  // 4. Calculate deductions
  interface Deduction {
    type:          "origin" | "profile";
    id:            number;
    name:          string;
    kgNeeded:      number;
    currentStock:  number;
    minStock:      number | null;
  }

  const deductions: Deduction[] = [];

  for (const ing of recipe) {
    const kgNeeded = bagsCount * sizeKg * (ing.percentage / 100);

    if (ing.sourceType === "profile" && ing.sourceId) {
      const profile = profiles?.find(p => p.id === ing.sourceId);
      if (profile) {
        deductions.push({
          type:         "profile",
          id:           profile.id,
          name:         profile.name,
          kgNeeded,
          currentStock: profile.roasted_stock ?? 0,
          minStock:     profile.min_stock      ?? null,
        });
      }
    } else {
      const originId = ing.sourceId || ing.originId;
      const origin   = origins?.find(o => o.id === originId);
      if (origin) {
        deductions.push({
          type:         "origin",
          id:           origin.id,
          name:         origin.name,
          kgNeeded,
          currentStock: origin.roasted_stock  ?? 0,
          minStock:     origin.critical_stock ?? null,
        });
      }
    }
  }

  // 5. Check sufficient stock
  const shortages = deductions.filter(d => d.currentStock < d.kgNeeded);
  if (shortages.length > 0) {
    const lines = shortages.map(s =>
      `• ${s.name}: יש ${s.currentStock.toFixed(1)} ק"ג, צריך ${s.kgNeeded.toFixed(2)} ק"ג`
    ).join("\n");
    await reply(chatId, `⛔ <b>אין מספיק מלאי קלוי:</b>\n\n${lines}`);
    return;
  }

  // 6. Apply deductions
  for (const d of deductions) {
    const newStock = parseFloat((d.currentStock - d.kgNeeded).toFixed(3));
    if (d.type === "origin") {
      await supabase.from("origins").update({ roasted_stock: newStock }).eq("id", d.id);
    } else {
      await supabase.from("roast_profiles").update({ roasted_stock: newStock }).eq("id", d.id);
    }
  }

  // 7. Increment packed_stock
  const newPackedStock = (product.packed_stock ?? 0) + bagsCount;
  await supabase.from("products").update({ packed_stock: newPackedStock }).eq("id", product.id);

  // 8. Log
  await supabase.from("packing_logs").insert({
    user_id:          USER_ID,
    product_id:       product.id,
    product_name:     `${product.name} ${product.size}g`,
    bags_count:       bagsCount,
    roasted_deducted: deductions.map(d => ({ name: d.name, kg: parseFloat(d.kgNeeded.toFixed(3)) })),
    reported_by:      fromName,
  });

  // 9. Build confirmation reply
  const deductionLines = deductions
    .map(d => `  • ${d.name}: ${d.kgNeeded.toFixed(2)} ק"ג`)
    .join("\n");

  let msg = [
    `✅ <b>נרשמה אריזה!</b>`,
    `📦 ${product.name} ${product.size}g × ${bagsCount} שקיות`,
    ``,
    `♻️ נוכה מהמלאי הקלוי:`,
    deductionLines,
    ``,
    `📊 מלאי ארוז כעת: <b>${newPackedStock} שקיות</b>`,
  ].join("\n");

  // 10. Low-stock alerts
  const alerts: string[] = [];
  for (const d of deductions) {
    const remaining = d.currentStock - d.kgNeeded;
    if (d.minStock !== null && remaining < d.minStock) {
      alerts.push(`⚠️ ${d.name}: נותרו ${remaining.toFixed(1)} ק"ג (מינימום: ${d.minStock} ק"ג)`);
    }
  }

  if (alerts.length > 0) {
    msg += `\n\n🚨 <b>התראת מלאי נמוך!</b>\n${alerts.join("\n")}`;
  }

  await reply(chatId, msg);
}

// ── Free text dispatcher ───────────────────────────────────────────────────

async function handleFreeText(chatId: string, text: string, fromName: string) {
  const extracted = await extractWithClaude(text);

  if (!extracted) return;

  // Packing report takes priority
  if (extracted.is_packing_report && extracted.packing_product) {
    await handlePacking(chatId, extracted.packing_product, extracted.packing_bags, fromName);
    return;
  }

  // Employee marked a customer as handled
  if (extracted.is_handled && extracted.handled_customer) {
    await handleMarkedDone(chatId, extracted.handled_customer);
    return;
  }

  if (!extracted.is_customer_request) return;

  const { customer_name, phone, product, sku } = extracted;

  if (!customer_name) {
    await reply(chatId, "⚠️ לא הצלחתי לזהות שם לקוח — נסה שוב עם פרטים ברורים יותר");
    return;
  }

  const productFull = [product, sku ? `מקט: ${sku}` : ""].filter(Boolean).join(" | ");

  const { error } = await supabase.from("waiting_customers").insert({
    user_id:       USER_ID,
    customer_name,
    phone:         phone        || null,
    product:       productFull  || null,
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
    phone   ? `📞 ${phone}`    : "",
    product ? `📦 ${product}`  : "",
    sku     ? `🔢 מקט: ${sku}` : "",
  ].filter(Boolean).join("\n");

  await reply(chatId, lines);
}

// ── Main ───────────────────────────────────────────────────────────────────

serve(async (req) => {
  try {
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
    else if (lower.startsWith("/stock")) await handleStock(chatId);
    else if (!lower.startsWith("/"))     await handleFreeText(chatId, text, fromName);

    return new Response("ok");
  } catch (err) {
    console.error("Webhook error:", err);
    return new Response("ok");
  }
});
