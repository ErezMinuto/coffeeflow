/**
 * CoffeeFlow — Coffee Bot (@minuto_coffee_bot)
 *
 * Private packing reports from employees.
 *
 * Commands:
 *   /stock            → show current packed bag inventory
 *   /shop             → show grams taken to the coffee shop this week
 *
 * Free text:
 *   "ארזתי 20 שקיות Ethiopia Light"           → packing: deducts roasted stock by recipe, adds packed bags
 *   "ארזתי 660 גר דיי בנסה לבית הקפה"          → shop consumption: deducts grams directly from roasted stock
 */

import { serve }        from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const BOT_TOKEN      = Deno.env.get("COFFEE_BOT_TOKEN")           ?? "";
const USER_ID        = Deno.env.get("COFFEEFLOW_USER_ID")         ?? "";
const ANTHROPIC_KEY  = Deno.env.get("ANTHROPIC_API_KEY")          ?? "";
const SUPA_URL       = Deno.env.get("SUPABASE_URL")               ?? "";
const SUPA_KEY       = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")  ?? "";
const WEBHOOK_SECRET = Deno.env.get("COFFEE_BOT_WEBHOOK_SECRET")  ?? "";

const supabase = createClient(SUPA_URL, SUPA_KEY);

// ── Security helpers ─────────────────────────────────────────────────────────

// Rate limit: 20 messages per telegram_id per 60-second window.
// Per-bot (check_bot_rate_limit in SQL uses (telegram_id, bot_name) as PK).
const RATE_LIMIT_PER_WINDOW = 20;
const RATE_LIMIT_WINDOW_SECONDS = 60;

async function checkRateLimit(telegramId: string | number | undefined): Promise<boolean> {
  if (!telegramId) return true; // Can't rate-limit anonymous/missing sender — don't block
  try {
    const { data, error } = await supabase.rpc("check_bot_rate_limit", {
      p_telegram_id:    String(telegramId),
      p_bot_name:       "coffee-bot",
      p_limit:          RATE_LIMIT_PER_WINDOW,
      p_window_seconds: RATE_LIMIT_WINDOW_SECONDS,
    });
    if (error) {
      console.error("rate-limit RPC error, allowing request:", error.message);
      return true; // Fail open — don't break the bot if the RPC is down
    }
    return data === true;
  } catch (e: any) {
    console.error("rate-limit RPC threw, allowing request:", e?.message);
    return true;
  }
}

// Reject messages that look like prompt injection attempts before they reach
// Claude. Crude pattern match — bounded protection since the JSON output
// schema already limits what a successful injection can do, but cheap enough
// to add another layer. Covers English patterns; Hebrew attempts are rare.
const INJECTION_PATTERNS = [
  /ignore\s+(all|previous|the|above|prior)/i,
  /disregard\s+(all|previous|the|above|prior)/i,
  /forget\s+(everything|all|previous|the\s+above)/i,
  /new\s+instructions?/i,
  /system\s*:\s*/i,
  /\[INST\]/i,
  /\[\/INST\]/i,
  /<\|im_start\|>/i,
  /<\|im_end\|>/i,
  /you\s+are\s+(now|actually)/i,
];

function looksLikeInjection(text: string): boolean {
  return INJECTION_PATTERNS.some((p) => p.test(text));
}

async function send(chatId: string | number, text: string) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  });
}

// ── Claude: extract packing intent ─────────────────────────────────────────

interface Product { id: number; name: string; size: number; [key: string]: unknown }

async function extractPacking(
  text: string,
  products: Product[],
): Promise<{ productId: number; bags: number } | null> {
  const productList = products
    .map(p => `id:${p.id} → "${p.name} ${p.size}g"`)
    .join("\n");

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
      system: `אתה מזהה דיווחי אריזה מהודעות עברית.
רשימת המוצרים הזמינים:
${productList}

החזר JSON בלבד:
  {"product_id": <id של המוצר המתאים>, "bags": <כמות שקיות>}
אם לא מדובר בדיווח אריזה, או שהמוצר לא קיים ברשימה:
  {"product_id": 0, "bags": 0}

דוגמאות: "ארזתי 20 אתיופיה" → זהה לפי שם קרוב ברשימה. "אתיופיה דיי בנסה חד זני קלייה בהירה" — מצא את המוצר הכי קרוב גם אם הניסוח שונה.`,
      messages: [{ role: "user", content: text }],
    }),
  });

  const json = await res.json();
  const raw  = json.content?.[0]?.text ?? "";
  try {
    const clean = raw.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(clean);
    if (parsed.product_id > 0 && parsed.bags > 0) {
      return { productId: parsed.product_id, bags: parsed.bags };
    }
    return null;
  } catch {
    return null;
  }
}

// ── Claude: extract shop-consumption intent ────────────────────────────────
// Shop consumption = roasted coffee taken from the roastery to the coffee
// shop grinders. Measured in grams (or kg), not bags, and does NOT use the
// product recipe — it's a direct deduction from a single origin or profile.
//
// Trigger phrase: "לבית הקפה" / "לבית קפה" / "לחנות" anywhere in the text.

interface Origin          { id: number; name: string; roasted_stock: number | null; critical_stock: number | null }
interface RoastProfile    { id: number; name: string; roasted_stock: number | null; min_stock: number | null }

function isShopConsumption(text: string): boolean {
  return /לבית\s*הקפה|לבית\s*קפה|לחנות/.test(text);
}

async function extractShopConsumption(
  text: string,
  origins: Origin[],
  profiles: RoastProfile[],
): Promise<{ sourceType: "origin" | "profile"; sourceId: number; grams: number } | null> {
  const originList  = origins.map(o  => `origin:${o.id}  → "${o.name}"`).join("\n");
  const profileList = profiles.map(p => `profile:${p.id} → "${p.name}"`).join("\n");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key":         ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type":      "application/json",
    },
    body: JSON.stringify({
      model:      "claude-haiku-4-5",
      max_tokens: 120,
      system: `אתה מזהה דיווחים על קפה קלוי שנלקח לבית הקפה.
מקורות זמינים (מוצא ירוק):
${originList}

פרופילי קלייה זמינים:
${profileList}

החזר JSON בלבד:
  {"source_type": "origin" | "profile", "source_id": <id>, "grams": <מספר שלם בגרמים>}

המרה: "1 ק״ג" או "1 קג" או "1 kg" = 1000 גרם. "0.5 ק״ג" = 500 גרם. "גר" או "גרם" = גרמים.
בחר origin אם השם מזכיר מוצא ספציפי (אתיופיה, דיי בנסה, קולומביה וכו׳).
בחר profile אם השם מזכיר תערובת/בלנד/פרופיל קלייה.

אם לא מדובר בקפה שנלקח לבית הקפה, או שאין התאמה:
  {"source_type": "origin", "source_id": 0, "grams": 0}`,
      messages: [{ role: "user", content: text }],
    }),
  });

  const json = await res.json();
  const raw  = json.content?.[0]?.text ?? "";
  try {
    const clean  = raw.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(clean);
    if (
      (parsed.source_type === "origin" || parsed.source_type === "profile") &&
      parsed.source_id > 0 &&
      parsed.grams > 0
    ) {
      return {
        sourceType: parsed.source_type,
        sourceId:   parsed.source_id,
        grams:      Math.round(parsed.grams),
      };
    }
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

async function handlePacking(chatId: string, fromName: string, productId: number, bagsCount: number, allProducts: Product[]) {
  const product = allProducts.find(p => p.id === productId);

  if (!product) {
    const list = allProducts.map(p => `• ${p.name} ${p.size}g`).join("\n");
    await send(chatId, `⚠️ לא מצאתי את המוצר במערכת\n\nמוצרים זמינים:\n${list}`);
    return;
  }
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

async function handleShopStock(chatId: string) {
  // Show grams taken to the shop in the last 7 days, grouped by source.
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data: logs } = await supabase
    .from("shop_consumption_logs")
    .select("source_name, grams")
    .eq("user_id", USER_ID)
    .gte("taken_at", since);

  if (!logs || logs.length === 0) {
    await send(chatId, "☕ לא נלקח קפה לבית הקפה ב-7 הימים האחרונים");
    return;
  }

  const totals = new Map<string, number>();
  for (const l of logs) totals.set(l.source_name, (totals.get(l.source_name) ?? 0) + l.grams);

  const lines = [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, g]) => `• ${name}: <b>${(g / 1000).toFixed(2)} ק"ג</b>`)
    .join("\n");

  await send(chatId, `☕ <b>נלקח לבית הקפה (7 ימים אחרונים):</b>\n\n${lines}`);
}

async function handleShopConsumption(
  chatId:     string,
  fromName:   string,
  sourceType: "origin" | "profile",
  sourceId:   number,
  grams:      number,
  origins:    Origin[],
  profiles:   RoastProfile[],
) {
  const source = sourceType === "origin"
    ? origins.find(o  => o.id === sourceId)
    : profiles.find(p => p.id === sourceId);

  if (!source) {
    await send(chatId, "⚠️ לא מצאתי את המקור במערכת");
    return;
  }

  const kgNeeded    = grams / 1000;
  const currentKg   = source.roasted_stock ?? 0;
  const minStockKg  = sourceType === "origin"
    ? (source as Origin).critical_stock
    : (source as RoastProfile).min_stock;

  if (currentKg < kgNeeded) {
    await send(chatId,
      `⛔ <b>אין מספיק מלאי קלוי:</b>\n\n` +
      `• ${source.name}: יש ${currentKg.toFixed(2)} ק"ג, צריך ${kgNeeded.toFixed(3)} ק"ג`
    );
    return;
  }

  const newStock = parseFloat((currentKg - kgNeeded).toFixed(3));
  if (sourceType === "origin") {
    await supabase.from("origins").update({ roasted_stock: newStock }).eq("id", sourceId);
  } else {
    await supabase.from("roast_profiles").update({ roasted_stock: newStock }).eq("id", sourceId);
  }

  await supabase.from("shop_consumption_logs").insert({
    user_id:     USER_ID,
    source_type: sourceType,
    source_id:   sourceId,
    source_name: source.name,
    grams,
    reported_by: fromName,
  });

  let msg = [
    `✅ <b>נרשמה העברה לבית הקפה!</b>`,
    `☕ ${source.name}: ${grams} גרם (${kgNeeded.toFixed(3)} ק"ג)`,
    ``,
    `📊 מלאי קלוי כעת: <b>${newStock.toFixed(2)} ק"ג</b>`,
  ].join("\n");

  if (minStockKg !== null && minStockKg !== undefined && newStock < minStockKg) {
    msg += `\n\n🚨 <b>התראת מלאי נמוך!</b>\n⚠️ ${source.name}: נותרו ${newStock.toFixed(2)} ק"ג (מינימום: ${minStockKg} ק"ג)`;
  }

  await send(chatId, msg);
}

// ── Main ────────────────────────────────────────────────────────────────────

serve(async (req) => {
  try {
    // ── Webhook authentication ─────────────────────────────────────────────
    // Reject any request that doesn't carry the Telegram secret token header.
    // This is set when the webhook is registered via Telegram's setWebhook
    // API with ?secret_token=... and echoed back on every update. Without
    // this check, anyone on the internet could forge Telegram updates.
    if (WEBHOOK_SECRET) {
      const tgSecret = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
      if (tgSecret !== WEBHOOK_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }
    }

    const body    = await req.json();
    const message = body.message;
    if (!message?.text) return new Response("ok");

    const chatId      = String(message.chat.id);
    const text        = message.text.trim();
    const telegramId  = message.from?.id;
    const lower       = text.toLowerCase();

    // ── Rate limit ─────────────────────────────────────────────────────────
    // 20 messages per telegram_id per 60-second window. Silently drops
    // excess requests — don't reply, or the attacker gets feedback.
    if (!(await checkRateLimit(telegramId))) {
      console.warn(`coffee-bot rate-limited telegram_id=${telegramId}`);
      return new Response("ok");
    }

    // ── Injection pre-filter ───────────────────────────────────────────────
    // Reject obvious prompt-injection attempts before they reach Claude.
    if (looksLikeInjection(text)) {
      console.warn(`coffee-bot rejected injection attempt from telegram_id=${telegramId}: "${text.slice(0, 100)}"`);
      await send(chatId, "לא הבנתי 🤔 — שלח דיווח אריזה כמו 'ארזתי 20 שקיות אתיופיה' או /stock");
      return new Response("ok");
    }

    // Prefer the Hebrew name stored in employees table over the Telegram profile name
    let fromName = message.from?.first_name ?? "עובד";
    if (telegramId) {
      const { data: emp } = await supabase
        .from("employees")
        .select("name")
        .eq("telegram_id", telegramId)
        .maybeSingle();
      if (emp?.name) fromName = emp.name;
    }

    if (lower.startsWith("/stock")) {
      await handleStock(chatId);
    } else if (lower.startsWith("/shop")) {
      await handleShopStock(chatId);
    } else if (!lower.startsWith("/")) {
      // Shop consumption takes priority — triggered by "לבית הקפה" / "לחנות".
      // Same message may contain "ארזתי", but the destination phrase is what
      // distinguishes a shop transfer (grams) from a packing report (bags).
      if (isShopConsumption(text)) {
        const [{ data: origins }, { data: profiles }] = await Promise.all([
          supabase.from("origins").select("id, name, roasted_stock, critical_stock").eq("user_id", USER_ID),
          supabase.from("roast_profiles").select("id, name, roasted_stock, min_stock"),
        ]);

        if ((!origins || origins.length === 0) && (!profiles || profiles.length === 0)) {
          await send(chatId, "❌ לא נמצאו מקורות קפה במערכת");
          return new Response("ok");
        }

        const shop = await extractShopConsumption(text, (origins ?? []) as Origin[], (profiles ?? []) as RoastProfile[]);
        if (shop) {
          await handleShopConsumption(
            chatId, fromName,
            shop.sourceType, shop.sourceId, shop.grams,
            (origins ?? []) as Origin[], (profiles ?? []) as RoastProfile[],
          );
        } else {
          await send(chatId,
            `לא הבנתי איזה קפה וכמה 🤔\n\n` +
            `דוגמה:\n<code>ארזתי 660 גר דיי בנסה לבית הקפה</code>`
          );
        }
        return new Response("ok");
      }

      // Fetch products once — passed to both Claude (for smart matching) and handlePacking
      const { data: allProducts } = await supabase
        .from("products")
        .select("*")
        .eq("user_id", USER_ID);

      if (!allProducts || allProducts.length === 0) {
        await send(chatId, "❌ לא נמצאו מוצרים במערכת");
        return new Response("ok");
      }

      const packing = await extractPacking(text, allProducts as Product[]);
      if (packing) {
        await handlePacking(chatId, fromName, packing.productId, packing.bags, allProducts as Product[]);
      } else {
        const list = (allProducts as Product[]).map(p => `• ${p.name} ${p.size}g`).join("\n");
        await send(chatId,
          `לא הבנתי 🤔\n\n` +
          `לדיווח אריזה:\n<code>ארזתי 20 שקיות אתיופיה</code>\n\n` +
          `להעברה לבית הקפה:\n<code>ארזתי 660 גר דיי בנסה לבית הקפה</code>\n\n` +
          `לצפייה במלאי:\n<code>/stock</code>   <code>/shop</code>\n\n` +
          `מוצרים במערכת:\n${list}`
        );
      }
    }

    return new Response("ok");
  } catch (err) {
    console.error("coffee-bot error:", err);
    return new Response("ok");
  }
});
