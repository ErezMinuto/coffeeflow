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

// Returns { sun: true, tue: "14:00", fri: true } — true=full day, "HH:MM"=until that time
async function parseDays(text: string): Promise<Record<string, boolean | string>> {
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
      system: `Extract work day availability from Hebrew text.
Return a JSON object only, no other text.
Keys: sun=ראשון, mon=שני, tue=שלישי, wed=רביעי, thu=חמישי, fri=שישי
Value: true = available full day, "HH:MM" = available until that time, omit key = not available.

"כל הימים" → {"sun":true,"mon":true,"tue":true,"wed":true,"thu":true,"fri":true}
"לא יכול" → {}
"ראשון, שלישי עד 14:00, שישי" → {"sun":true,"tue":"14:00","fri":true}
"שני וחמישי עד 13:00" → {"mon":true,"thu":"13:00"}`,
      messages: [{ role: "user", content: text }],
    }),
  });
  const json = await res.json();
  const raw  = json.content?.[0]?.text ?? "{}";
  try {
    const clean = raw.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(clean);
    if (typeof parsed !== "object" || Array.isArray(parsed)) return {};
    // Validate keys and values
    const result: Record<string, boolean | string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (!DAY_CODES.includes(k)) continue;
      if (v === true || (typeof v === "string" && /^\d{2}:\d{2}$/.test(v))) {
        result[k] = v as boolean | string;
      }
    }
    return result;
  } catch { return {}; }
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
      `לדוגמה:\n` +
      `<code>ראשון, שלישי, שישי</code>\n` +
      `<code>ראשון, שלישי עד 14:00, שישי</code>\n` +
      `<code>כל הימים</code>\n` +
      `<code>לא יכול השבוע</code>\n\n` +
      `אפשר לציין "עד שעה" לכל יום בנפרד 🕑`
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
    } else if (emp && emp.name === "__AWAITING_NAME__") {
      await send(chatId, `👋 כבר שאלתי — מה שמך המלא?`);
    } else {
      // Mark this telegram_id as awaiting name input
      await supabase.from("employees")
        .delete()
        .eq("telegram_id", telegramId)
        .eq("name", "__AWAITING_NAME__");
      await supabase.from("employees").insert({
        user_id:     "pending",
        name:        "__AWAITING_NAME__",
        telegram_id: telegramId,
        active:      false,
      });
      await send(chatId,
        `👋 ברוך הבא למערכת סידור העבודה של מינוטו קפה!\n\n` +
        `מה שמך המלא? (כפי שהמנהל הזין אותך במערכת)`
      );
    }
    return new Response("ok");
  }

  // ── Waiting for name — match against manager-added employees ─────────────
  if (emp && emp.name === "__AWAITING_NAME__") {
    // Search for an existing employee with this name (no telegram_id yet)
    const { data: matches } = await supabase
      .from("employees")
      .select("*")
      .ilike("name", `%${text}%`)
      .is("telegram_id", null)
      .limit(1);

    const match = matches?.[0];

    if (!match) {
      await send(chatId,
        `⚠️ לא מצאתי עובד בשם "<b>${text}</b>" במערכת.\n\n` +
        `בדוק עם המנהל שהשם זהה למה שהוזן, ושלח שוב.`
      );
      return new Response("ok");
    }

    // Link telegram_id to the existing employee record
    await supabase.from("employees")
      .update({ telegram_id: telegramId })
      .eq("id", match.id);

    // Delete the temporary __AWAITING_NAME__ row
    await supabase.from("employees").delete().eq("id", emp.id);

    if (match.active) {
      await send(chatId,
        `✅ זוהית! שלום <b>${match.name}</b> 👋\n\n` +
        `אתה מחובר למערכת. כשתקבל תזכורת בנוגע לזמינות, פשוט שלח לי את הימים שנוח לך.`
      );
    } else {
      await send(chatId,
        `✅ זוהית! שלום <b>${match.name}</b> 👋\n\n` +
        `החשבון שלך עדיין לא פעיל. המנהל יפעיל אותך בקרוב.`
      );
    }
    return new Response("ok");
  }

  // ── Not linked yet ───────────────────────────────────────────────────────
  if (!emp || !emp.active) {
    await send(chatId,
      `שלח /start כדי להתחבר למערכת.`
    );
    return new Response("ok");
  }

  // ── Active employee — parse availability ─────────────────────────────────
  const daysObj = await parseDays(text);
  const week    = nextSunday();

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

  const entries = Object.entries(daysObj);
  if (entries.length === 0) {
    await send(chatId, `✅ נשמר — לא יכול השבוע הבא.\nאם תשתנה תוכנית, שלח שוב.`);
  } else {
    const list = entries.map(([d, v]) =>
      v === true ? DAY_HE[d] : `${DAY_HE[d]} (עד ${v})`
    ).join(", ");
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
