/**
 * CoffeeFlow — Employee Bot (Supabase Edge Function)
 *
 * Onboarding: employees write their Hebrew name in the group → auto-registered
 * Availability: employees reply with days in the group → auto-saved
 * Manager sets roles in CoffeeFlow after registration
 *
 * ?action=onboard  → post "write your name" message to group
 * ?action=remind   → post weekly availability request to group
 * ?action=publish  → publish approved schedule to group
 */

import { serve }        from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const BOT_TOKEN      = Deno.env.get("EMPLOYEE_BOT_TOKEN")          ?? "";
const GROUP_ID       = Deno.env.get("EMPLOYEE_GROUP_CHAT_ID")      ?? "";
const SUPA_URL       = Deno.env.get("SUPABASE_URL")                ?? "";
const SUPA_KEY       = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")   ?? "";
const CLAUDE_KEY     = Deno.env.get("ANTHROPIC_API_KEY")           ?? "";
const WEBHOOK_SECRET = Deno.env.get("EMPLOYEE_BOT_WEBHOOK_SECRET") ?? "";

const supabase = createClient(SUPA_URL, SUPA_KEY);

const ALLOWED_ORIGIN = Deno.env.get("COFFEEFLOW_ORIGIN") ?? "https://coffeeflow-thaf.vercel.app";
const corsHeaders = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-coffeeflow-secret, x-action",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ── Helpers ──────────────────────────────────────────────────────────────────

async function send(chatId: number | string, text: string) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  });
}

const DAY_CODES = ["sun", "mon", "tue", "wed", "thu", "fri"];
const DAY_HE: Record<string, string> = {
  sun: "ראשון", mon: "שני", tue: "שלישי",
  wed: "רביעי", thu: "חמישי", fri: "שישי",
};

function nextSunday(): string {
  const d = new Date();
  const dow = d.getDay();
  // If today is Sunday, use today (current week). Otherwise jump to next Sunday.
  const diff = dow === 0 ? 0 : 7 - dow;
  d.setDate(d.getDate() + diff);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

// ── Claude: classify message ──────────────────────────────────────────────────

interface ParseResult {
  type: "name" | "availability" | "other";
  name?: string;
  phone?: string;
  days?: Record<string, boolean | string>;
}

async function classifyMessage(text: string): Promise<ParseResult> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": CLAUDE_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      max_tokens: 200,
      system: `You help a coffee shop manager with employee scheduling.
Classify a Hebrew group chat message into one of three types and return JSON only.

1. "name" — employee writing their Hebrew name and optionally phone number to register
   {"type":"name","name":"טליה אלבז","phone":"050-1234567"}
   phone is optional, extract if present, otherwise omit

2. "availability" — employee reporting available work days
   {"type":"availability","days":{"sun":true,"tue":"14:00","fri":true}}
   Keys: sun=ראשון, mon=שני, tue=שלישי, wed=רביעי, thu=חמישי, fri=שישי
   Value: true=full day, "HH:MM"=until that time
   "כל הימים"→all 6 true, "לא יכול"→{}

3. "other" — anything else (greetings, questions, unrelated)
   {"type":"other"}`,
      messages: [{ role: "user", content: text }],
    }),
  });
  const json = await res.json();
  const raw  = json.content?.[0]?.text ?? "{}";
  try {
    const clean = raw.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(clean);

    if (parsed.type === "name" && parsed.name) {
      return { type: "name", name: parsed.name, phone: parsed.phone };
    }

    if (parsed.type === "availability") {
      const days: Record<string, boolean | string> = {};
      for (const [k, v] of Object.entries(parsed.days ?? {})) {
        if (!DAY_CODES.includes(k)) continue;
        if (v === true || (typeof v === "string" && /^\d{2}:\d{2}$/.test(v))) {
          days[k] = v as boolean | string;
        }
      }
      return { type: "availability", days };
    }

    return { type: "other" };
  } catch {
    return { type: "other" };
  }
}

// ── Handlers ──────────────────────────────────────────────────────────────────

async function handleOnboard() {
  await send(GROUP_ID,
    `👋 <b>ברוכים הבאים לסידור העבודה של מינוטו!</b>\n\n` +
    `כדי להצטרף — שלחו את שמכם המלא ומספר טלפון כאן בקבוצה 👇\n\n` +
    `לדוגמה: <code>טליה אלבז 0501234567</code>`
  );
  return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders });
}

async function handleRemind() {
  const { data: employees, error: empError } = await supabase
    .from("employees")
    .select("telegram_id, name")
    .eq("active", true)
    .not("telegram_id", "is", null);

  if (empError) {
    console.error("handleRemind DB error:", empError);
    return new Response(JSON.stringify({ ok: false, error: empError.message, sent: 0 }), {
      status: 500, headers: corsHeaders,
    });
  }

  console.log(`handleRemind: found ${employees?.length ?? 0} employees`);

  let sent = 0, failed = 0;
  for (const emp of employees ?? []) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: String(emp.telegram_id),
          text:
            `📅 <b>היי ${emp.name}!</b>\n\n` +
            `שלח/י את הימים שאתה/את פנוי/ה השבוע הבא 👇\n\n` +
            `הימים האפשריים: <b>ראשון, שני, שלישי, רביעי, חמישי, שישי</b>\n\n` +
            `דוגמאות לפורמט:\n` +
            `<code>ראשון, שני, שישי</code>\n` +
            `<code>שני, חמישי עד 14:00, שישי</code>\n` +
            `<code>כל הימים</code>  |  <code>לא יכול השבוע</code>`,
          parse_mode: "HTML",
        }),
      });
      const tg = await res.json();
      if (tg.ok) {
        sent++;
      } else {
        failed++;
        console.error(`Telegram reject for ${emp.name} (${emp.telegram_id}):`, tg.description);
      }
    } catch (e) {
      failed++;
      console.error(`Send error for ${emp.name}:`, e);
    }
  }

  console.log(`handleRemind done: sent=${sent}, failed=${failed}`);
  return new Response(JSON.stringify({ ok: true, sent, failed }), { headers: corsHeaders });
}

async function handlePublish(req: Request) {
  const { text } = await req.json();
  await send(GROUP_ID, text);
  return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders });
}

async function handleWebhook(req: Request) {
  const body    = await req.json();
  const message = body.message;
  if (!message?.text) return new Response("ok");

  const chatId     = String(message.chat.id);
  const chatType   = message.chat.type;
  const text       = message.text.trim();
  const telegramId = message.from?.id;
  const firstName  = message.from?.first_name ?? "";

  console.log(`webhook: chatType=${chatType} chatId=${chatId} telegramId=${telegramId} text="${text}"`);

  // Allow private chats for availability, only allow our group for registration
  const isPrivate = chatType === "private";
  if (!isPrivate && chatId !== GROUP_ID) {
    console.log(`webhook: ignored — not private and not group (GROUP_ID=${GROUP_ID})`);
    return new Response("ok");
  }
  if (text.startsWith("/")) return new Response("ok");

  // If message contains a phone number pattern, treat as name registration
  const phonePattern = /05\d[\d\-]{7,8}/;
  const hasPhone = phonePattern.test(text);
  const result = await classifyMessage(text);
  console.log(`webhook: claude classified as type=${result.type}`, JSON.stringify(result));

  // Fallback: if Claude returned "other" but message has phone → force name classification
  const finalResult = (result.type === "other" && hasPhone)
    ? await (async () => {
        const nameOnly = text.replace(phonePattern, "").trim();
        const phone    = text.match(phonePattern)?.[0] ?? undefined;
        return { type: "name" as const, name: nameOnly, phone };
      })()
    : result;

  // ── Name registration ──────────────────────────────────────────────────────
  if (finalResult.type === "name" && finalResult.name) {
    const result = finalResult;
    // Check if already registered by telegram_id
    const { data: existing } = await supabase
      .from("employees")
      .select("id, name")
      .eq("telegram_id", telegramId)
      .limit(1);

    if (existing?.[0]) {
      await send(GROUP_ID, `👋 <b>${existing[0].name}</b> — אתה כבר רשום במערכת!`);
      return new Response("ok");
    }

    // Check if name already exists (update telegram_id)
    const { data: byName } = await supabase
      .from("employees")
      .select("id, name")
      .ilike("name", result.name)
      .limit(1);

    if (byName?.[0]) {
      await supabase.from("employees")
        .update({ telegram_id: telegramId, ...(result.phone ? { phone: result.phone } : {}) })
        .eq("id", byName[0].id);
      await send(GROUP_ID, `✅ <b>${byName[0].name}</b> — נרשמת בהצלחה! 🎉`);
    } else {
      // Create new employee record
      await supabase.from("employees").insert({
        user_id:     "pending",
        name:        result.name,
        phone:       result.phone ?? null,
        telegram_id: telegramId,
        role:        "general",
        max_days:    5,
        active:      false,
      });
      await send(GROUP_ID,
        `✅ <b>${result.name}</b> — נוספת לרשימה! 🎉\n` +
        `המנהל יגדיר את התפקיד שלך בקרוב.`
      );
    }
    return new Response("ok");
  }

  // ── Availability ───────────────────────────────────────────────────────────
  if (finalResult.type === "availability") {
    const result = finalResult;
    // Find employee by telegram_id
    const { data: empRows, error: empErr } = await supabase
      .from("employees")
      .select("*")
      .eq("telegram_id", telegramId)
      .eq("active", true)
      .limit(1);

    console.log(`availability: lookup telegram_id=${telegramId} active=true → found=${empRows?.length ?? 0}`, empErr ?? "");

    const emp = empRows?.[0];
    if (!emp) {
      console.log(`availability: employee not found for telegram_id=${telegramId}`);
      await send(chatId,
        `שלח קודם את שמך ומספר טלפון כדי להירשם 👆\nלדוגמה: <code>ישראל ישראלי 0501234567</code>`
      );
      return new Response("ok");
    }

    const week = nextSunday();
    const days = result.days!;
    console.log(`availability: saving for ${emp.name} week=${week} days=`, JSON.stringify(days));

    const { data: existing } = await supabase
      .from("availability_submissions")
      .select("id")
      .eq("employee_id", emp.id)
      .eq("week_start", week)
      .limit(1);

    let saveError = null;
    if (existing?.[0]) {
      const { error } = await supabase.from("availability_submissions")
        .update({ days, submitted_at: new Date().toISOString() })
        .eq("id", existing[0].id);
      saveError = error;
    } else {
      const { error } = await supabase.from("availability_submissions")
        .insert({ employee_id: emp.id, week_start: week, days });
      saveError = error;
    }

    if (saveError) {
      console.error(`availability: DB save error for ${emp.name}:`, saveError);
      await send(chatId, `❌ שגיאה בשמירת הזמינות. נסה שוב מאוחר יותר.`);
      return new Response("ok");
    }

    console.log(`availability: saved successfully for ${emp.name}`);
    const entries = Object.entries(days);
    if (entries.length === 0) {
      await send(chatId, `✅ נרשם — לא יכול השבוע הבא`);
    } else {
      const list = entries.map(([d, v]) =>
        v === true ? DAY_HE[d] : `${DAY_HE[d]} (עד ${v})`
      ).join(", ");
      await send(chatId, `✅ נרשם! הימים שלך: <b>${list}</b>`);
    }
    return new Response("ok");
  }

  return new Response("ok");
}

// ── Main ──────────────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const action = new URL(req.url).searchParams.get("action") ?? req.headers.get("x-action");

    // Action endpoints (onboard/remind/publish) — protected by CORS origin
    if (action) {
      if (action === "onboard") return await handleOnboard();
      if (action === "remind")  return await handleRemind();
      if (action === "publish") return await handlePublish(req);
    }

    // Telegram webhook — verify X-Telegram-Bot-Api-Secret-Token header
    if (WEBHOOK_SECRET) {
      const tgSecret = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
      if (tgSecret !== WEBHOOK_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }
    }

    return await handleWebhook(req);
  } catch (err) {
    console.error("Employee bot error:", err);
    return new Response("ok");
  }
});
