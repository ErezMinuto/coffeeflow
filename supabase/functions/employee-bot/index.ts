/**
 * CoffeeFlow — Employee Bot (Supabase Edge Function)
 *
 * Handles:
 *   - Employee self-registration via /start
 *   - Weekly availability collection (free Hebrew text, Claude-parsed)
 *   - ?action=remind  → send Thursday availability reminders
 *   - ?action=publish → publish approved schedule to team group
 */

import { serve }        from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const BOT_TOKEN  = Deno.env.get("EMPLOYEE_BOT_TOKEN")        ?? "";
const SUPA_URL   = Deno.env.get("SUPABASE_URL")              ?? "";
const SUPA_KEY   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const CLAUDE_KEY = Deno.env.get("ANTHROPIC_API_KEY")         ?? "";

const supabase = createClient(SUPA_URL, SUPA_KEY);

// ── Helpers ─────────────────────────────────────────────────────────────────

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
  const diff = d.getDay() === 0 ? 7 : 7 - d.getDay();
  d.setDate(d.getDate() + diff);
  return d.toISOString().split("T")[0];
}

async function parseDays(text: string): Promise<string[]> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": CLAUDE_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      max_tokens: 100,
      system: `Extract work day codes from Hebrew text. Return JSON array only, no other text.
Codes: sun=ראשון/א, mon=שני/ב, tue=שלישי/ג, wed=רביעי/ד, thu=חמישי/ה, fri=שישי/ו
"כל הימים"/"הכל" → ["sun","mon","tue","wed","thu","fri"]
"לא יכול"/"אין לי" → []
Examples: "ראשון שלישי שישי" → ["sun","tue","fri"]`,
      messages: [{ role: "user", content: text }],
    }),
  });
  const json = await res.json();
  const raw  = json.content?.[0]?.text ?? "[]";
  try {
    const clean = raw.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(clean);
    return Array.isArray(parsed) ? parsed.filter((d: string) => DAY_CODES.includes(d)) : [];
  } catch { return []; }
}

// ── Handlers ─────────────────────────────────────────────────────────────────

async function handleRemind() {
  const week = nextSunday();
  const { data: emps } = await supabase
    .from("employees")
    .select("*")
    .eq("active", true)
    .not("telegram_id", "is", null);

  let sent = 0;
  for (const emp of emps ?? []) {
    await send(emp.telegram_id,
      `👋 שלום <b>${emp.name}</b>!\n\n` +
      `אנא שלח את הימים שתוכל לעבוד בשבוע הבא.\n\n` +
      `לדוגמה:\n<code>ראשון, שלישי, שישי</code>\n` +
      `או: <code>כל הימים</code>\n` +
      `או: <code>לא יכול השבוע</code>`
    );
    sent++;
  }
  return new Response(JSON.stringify({ ok: true, sent }));
}

async function handlePublish(req: Request) {
  const { chat_id, text } = await req.json();
  await send(chat_id, text);
  return new Response(JSON.stringify({ ok: true }));
}

async function handleWebhook(req: Request) {
  const body    = await req.json();
  const message = body.message;
  if (!message?.text) return new Response("ok");

  const chatId     = message.chat.id;
  const chatType   = message.chat.type;
  const text       = message.text.trim();
  const telegramId = message.from?.id;
  const firstName  = message.from?.first_name ?? "";

  // Only handle private messages
  if (chatType !== "private") return new Response("ok");

  // Lookup employee by telegram_id
  const { data: rows } = await supabase
    .from("employees")
    .select("*")
    .eq("telegram_id", telegramId)
    .limit(1);
  const emp = rows?.[0];

  // ── /start ───────────────────────────────────────────────────────────────
  if (text.startsWith("/start")) {
    if (emp?.active) {
      await send(chatId,
        `👋 שלום <b>${emp.name}</b>! אתה רשום במערכת.\n` +
        `שלח לי את הימים שתוכל לעבוד השבוע הבא.`
      );
    } else if (emp && !emp.active) {
      await send(chatId, `⏳ בקשתך ממתינה לאישור המנהל. נעדכן אותך בקרוב.`);
    } else {
      // New employee — mark as PENDING, ask for name
      await supabase.from("employees").insert({
        user_id:     "pending",
        name:        "__PENDING__",
        telegram_id: telegramId,
        active:      false,
      });
      await send(chatId,
        `👋 ברוך הבא למערכת סידור העבודה של מינוטו קפה!\n\n` +
        `מה שמך המלא?`
      );
    }
    return new Response("ok");
  }

  // ── Waiting for name (just registered) ──────────────────────────────────
  if (emp && emp.name === "__PENDING__") {
    await supabase.from("employees")
      .update({ name: text })
      .eq("id", emp.id);
    await send(chatId,
      `✅ תודה <b>${text}</b>!\n` +
      `בקשתך נשלחה למנהל לאישור.\n` +
      `ברגע שתאושר תוכל לשלוח זמינות 😊`
    );
    return new Response("ok");
  }

  // ── Not approved yet ────────────────────────────────────────────────────
  if (!emp || !emp.active) {
    await send(chatId, `⏳ בקשתך עדיין ממתינה לאישור המנהל.`);
    return new Response("ok");
  }

  // ── Active employee — parse availability ─────────────────────────────────
  const days = await parseDays(text);
  const week = nextSunday();

  const daysObj = Object.fromEntries(DAY_CODES.map(d => [d, days.includes(d)]));

  // Upsert availability for next week
  const { data: existing } = await supabase
    .from("availability_submissions")
    .select("id")
    .eq("employee_id", emp.id)
    .eq("week_start", week)
    .limit(1);

  if (existing?.[0]) {
    await supabase.from("availability_submissions")
      .update({ days: daysObj, submitted_at: new Date().toISOString() })
      .eq("id", existing[0].id);
  } else {
    await supabase.from("availability_submissions")
      .insert({ employee_id: emp.id, week_start: week, days: daysObj });
  }

  if (days.length === 0) {
    await send(chatId, `✅ נשמר — לא יכול השבוע הבא.\nאם תשתנה תוכנית, שלח שוב.`);
  } else {
    const list = days.map((d: string) => DAY_HE[d]).join(", ");
    await send(chatId,
      `✅ <b>נשמר!</b>\n` +
      `הימים שלך לשבוע הבא:\n📅 ${list}\n\n` +
      `אם תרצה לשנות — פשוט שלח שוב.`
    );
  }

  return new Response("ok");
}

// ── Main ─────────────────────────────────────────────────────────────────────

serve(async (req) => {
  try {
    const action = new URL(req.url).searchParams.get("action");
    if (action === "remind")  return await handleRemind();
    if (action === "publish") return await handlePublish(req);
    return await handleWebhook(req);
  } catch (err) {
    console.error("Employee bot error:", err);
    return new Response("ok");
  }
});
