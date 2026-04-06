/**
 * CoffeeFlow — Coffee Bot (@minuto_coffee_bot)
 *
 * Private packing reports from employees.
 *
 * Commands:
 *   /stock            → show current packed bag inventory
 *
 * Free text:
 *   "ארזתי 20 שקיות Ethiopia Light" → deducts roasted stock, logs packing
 */

import { serve }        from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const BOT_TOKEN     = Deno.env.get("COFFEE_BOT_TOKEN")          ?? "";
const USER_ID       = Deno.env.get("COFFEEFLOW_USER_ID")        ?? "";
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY")         ?? "";
const SUPA_URL      = Deno.env.get("SUPABASE_URL")              ?? "";
const SUPA_KEY      = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const supabase = createClient(SUPA_URL, SUPA_KEY);

async function send(chatId: string | number, text: string) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  });
}

// ── Claude: extract packing intent ─────────────────────────────────────────

async function extractPacking(text: string): Promise<{ product: string; bags: number } | null> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key":         ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type":      "application/json",
    },
    body: JSON.stringify({
      model:      "claude-haiku-4-5",
      max_tokens: 100,
      system: `Extract packing info from a Hebrew message. Return JSON only.
Examples:
  "ארזתי 20 שקיות אתיופיה" → {"product":"אתיופיה","bags":20}
  "עשיתי 15 קניה לייט"     → {"product":"קניה לייט","bags":15}
  "packed 30 ethiopia"      → {"product":"ethiopia","bags":30}
  unrelated message          → {"product":"","bags":0}`,
      messages: [{ role: "user", content: text }],
    }),
  });

  const json = await res.json();
  const raw  = json.content?.[0]?.text ?? "";
  try {
    const clean = raw.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(clean);
    if (parsed.product && parsed.bags > 0) return { product: parsed.product, bags: parsed.bags };
    return null;
  } catch {
    return null;
  }
}

// ── Handlers ────────────────────────────────────────────────────────────────

async function handleStock(chatId: string) {
  const { data: products } = await supabase
    .from("products")
    .select("name, size, packed_stock")
    .eq("user_id", USER_ID)
    .order("name");

  if (!products || products.length === 0) {
    await send(chatId, "📦 אין מוצרים מוגדרים");
    return;
  }

  const lines = products.map(p => {
    const stock = p.packed_stock ?? 0;
    const icon  = stock === 0 ? "🔴" : stock < 10 ? "🟡" : "🟢";
    return `${icon} ${p.name} ${p.size}g: <b>${stock}</b> שקיות`;
  }).join("\n");

  await send(chatId, `📦 <b>מלאי שקיות ארוזות:</b>\n\n${lines}`);
}

async function handlePacking(chatId: string, fromName: string, productName: string, bagsCount: number) {
  const { data: products } = await supabase.from("products").select("*").eq("user_id", USER_ID);

  if (!products || products.length === 0) {
    await send(chatId, "❌ לא נמצאו מוצרים במערכת");
    return;
  }

  const stripAccents = (s: string) =>
    s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  const norm    = stripAccents(productName.toLowerCase().trim());
  const matches = products.filter(p => {
    const pNorm = stripAccents(p.name.toLowerCase());
    return pNorm.includes(norm) || norm.includes(pNorm);
  });

  if (matches.length === 0) {
    const list = products.map(p => `• ${p.name} ${p.size}g`).join("\n");
    await send(chatId, `⚠️ לא מצאתי מוצר בשם "<b>${productName}</b>"\n\nמוצרים זמינים:\n${list}`);
    return;
  }

  if (matches.length > 1) {
    const list = matches.map((p, i) => `${i + 1}. ${p.name} ${p.size}g`).join("\n");
    await send(chatId, `❓ מצאתי כמה מוצרים תואמים:\n\n${list}\n\nנסה שוב עם שם מדויק יותר`);
    return;
  }

  const product = matches[0];
  const sizeKg  = product.size / 1000;
  const recipe: Array<{ sourceType: string; sourceId?: number; originId?: number; percentage: number }> = product.recipe ?? [];

  if (recipe.length === 0) {
    await send(chatId, `❌ למוצר "${product.name}" אין מתכון מוגדר`);
    return;
  }

  const { data: origins  } = await supabase.from("origins").select("*").eq("user_id", USER_ID);
  const { data: profiles } = await supabase.from("roast_profiles").select("*");

  interface Deduction {
    type: "origin" | "profile";
    id: number; name: string;
    kgNeeded: number; currentStock: number; minStock: number | null;
  }

  const deductions: Deduction[] = [];
  for (const ing of recipe) {
    const kgNeeded = bagsCount * sizeKg * (ing.percentage / 100);
    if (ing.sourceType === "profile" && ing.sourceId) {
      const p = profiles?.find(p => p.id === ing.sourceId);
      if (p) deductions.push({ type: "profile", id: p.id, name: p.name, kgNeeded, currentStock: p.roasted_stock ?? 0, minStock: p.min_stock ?? null });
    } else {
      const o = origins?.find(o => o.id === (ing.sourceId || ing.originId));
      if (o) deductions.push({ type: "origin", id: o.id, name: o.name, kgNeeded, currentStock: o.roasted_stock ?? 0, minStock: o.critical_stock ?? null });
    }
  }

  const shortages = deductions.filter(d => d.currentStock < d.kgNeeded);
  if (shortages.length > 0) {
    const lines = shortages.map(s => `• ${s.name}: יש ${s.currentStock.toFixed(1)} ק"ג, צריך ${s.kgNeeded.toFixed(2)} ק"ג`).join("\n");
    await send(chatId, `⛔ <b>אין מספיק מלאי קלוי:</b>\n\n${lines}`);
    return;
  }

  for (const d of deductions) {
    const newStock = parseFloat((d.currentStock - d.kgNeeded).toFixed(3));
    if (d.type === "origin") {
      await supabase.from("origins").update({ roasted_stock: newStock }).eq("id", d.id);
    } else {
      await supabase.from("roast_profiles").update({ roasted_stock: newStock }).eq("id", d.id);
    }
  }

  const newPackedStock = (product.packed_stock ?? 0) + bagsCount;
  await supabase.from("products").update({ packed_stock: newPackedStock }).eq("id", product.id);

  await supabase.from("packing_logs").insert({
    user_id:          USER_ID,
    product_id:       product.id,
    product_name:     `${product.name} ${product.size}g`,
    bags_count:       bagsCount,
    roasted_deducted: deductions.map(d => ({
      name: d.name, kg: parseFloat(d.kgNeeded.toFixed(3)),
      kg_per_bag: parseFloat((d.kgNeeded / bagsCount).toFixed(6)),
      type: d.type, source_id: d.id,
    })),
    reported_by: fromName,
  });

  const deductionLines = deductions.map(d => `  • ${d.name}: ${d.kgNeeded.toFixed(2)} ק"ג`).join("\n");
  let msg = [
    `✅ <b>נרשמה אריזה!</b>`,
    `📦 ${product.name} ${product.size}g × ${bagsCount} שקיות`,
    ``,
    `♻️ נוכה מהמלאי הקלוי:`,
    deductionLines,
    ``,
    `📊 מלאי ארוז כעת: <b>${newPackedStock} שקיות</b>`,
  ].join("\n");

  const alerts = deductions
    .filter(d => d.minStock !== null && (d.currentStock - d.kgNeeded) < d.minStock!)
    .map(d => `⚠️ ${d.name}: נותרו ${(d.currentStock - d.kgNeeded).toFixed(1)} ק"ג (מינימום: ${d.minStock} ק"ג)`);

  if (alerts.length > 0) msg += `\n\n🚨 <b>התראת מלאי נמוך!</b>\n${alerts.join("\n")}`;

  await send(chatId, msg);
}

// ── Main ────────────────────────────────────────────────────────────────────

serve(async (req) => {
  try {
    const body    = await req.json();
    const message = body.message;
    if (!message?.text) return new Response("ok");

    const chatId   = String(message.chat.id);
    const text     = message.text.trim();
    const fromName = message.from?.first_name ?? "עובד";
    const lower    = text.toLowerCase();

    if (lower.startsWith("/stock")) {
      await handleStock(chatId);
    } else if (!lower.startsWith("/")) {
      const packing = await extractPacking(text);
      if (packing) {
        await handlePacking(chatId, fromName, packing.product, packing.bags);
      } else {
        await send(chatId,
          `לא הבנתי 🤔\n\n` +
          `לדיווח אריזה:\n<code>ארזתי 20 שקיות אתיופיה</code>\n\n` +
          `לצפייה במלאי:\n<code>/stock</code>`
        );
      }
    }

    return new Response("ok");
  } catch (err) {
    console.error("coffee-bot error:", err);
    return new Response("ok");
  }
});
