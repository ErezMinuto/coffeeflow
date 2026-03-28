/**
 * CoffeeFlow — Employee Bot (Supabase Edge Function)
 *
 * Simple flow — everything happens in the GROUP chat:
 *   - Thursday reminder → one message to the group
 *   - Employees reply with availability in the group (free Hebrew text)
 *   - Bot matches them by Telegram first+last name against employees list
 *   - No /start, no private chat, no registration needed
 *
 * ?action=remind  → send weekly availability request to group
 * ?action=publish → publish approved schedule to group
 */

import { serve }        from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const BOT_TOKEN  = Deno.env.get("EMPLOYEE_BOT_TOKEN")        ?? "";
const GROUP_ID   = Deno.env.get("EMPLOYEE_GROUP_CHAT_ID")    ?? "";
const SUPA_URL   = Deno.env.get("SUPABASE_URL")              ?? "";
const SUPA_KEY   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const CLAUDE_KEY = Deno.env.get("ANTHROPIC_API_KEY")         ?? "";

const supabase = createClient(SUPA_URL, SUPA_KEY);

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
  const diff = d.getDay() === 0 ? 7 : 7 - d.getDay();
  d.setDate(d.getDate() + diff);
  return d.toISOString().split("T")[0];
}

// ── Claude: detect availability + extract days ────────────────────────────────

interface ParseResult {
  is_availability: boolean;
  days: Record<string, boolean | string>;
}

async function parseMessage(text: string): Promise<ParseResult> {
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
      system: `You help a coffee shop manager collect employee work availability.
Determine if a Hebrew message is an employee reporting their available work days.
Return JSON only, no other text.

If it IS availability:
{"is_availability":true,"days":{"sun":true,"tue":"14:00","fri":true}}

Keys: sun=ראשון, mon=שני, tue=שלישי, wed=רביעי, thu=חמישי, fri=שישי
Value: true=full day, "HH:MM"=available until that time, omit=not available

"כל הימים" → all 6 days true
"לא יכול" / "אין לי" → {"is_availability":true,"days":{}}

If it is NOT availability (greeting, question, unrelated chat):
{"is_availability":false,"days":{}}`,
      messages: [{ role: "user", content: text }],
    }),
  });
  const json = await res.json();
  const raw  = json.content?.[0]?.text ?? "{}";
  try {
    const clean = raw.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(clean);
    const days: Record<string, boolean | string> = {};
    for (const [k, v] of Object.entries(parsed.days ?? {})) {
      if (!DAY_CODES.includes(k)) continue;
      if (v === true || (typeof v === "string" && /^\d{2}:\d{2}$/.test(v))) {
        days[k] = v as boolean | string;
      }
    }
    return { is_availability: !!parsed.is_availability, days };
  } catch {
    return { is_availability: false, days: {} };
  }
}

// ── Match Telegram user to employee ──────────────────────────────────────────

async function findEmployee(telegramId: number, firstName: string, lastName: string) {
  // First try by telegram_id (already linked)
  const { data: byId } = await supabase
    .from("employees")
    .select("*")
    .eq("telegram_id", telegramId)
    .eq("active", true)
    .limit(1);
  if (byId?.[0]) return byId[0];

  // Try matching by full name (first + last)
  const fullName = [firstName, lastName].filter(Boolean).join(" ");
  const searches = [fullName, firstName].filter(Boolean);

  for (const name of searches) {
    const { data } = await supabase
      .from("employees")
      .select("*")
      .ilike("name", `%${name}%`)
      .eq("active", true)
      .limit(1);
    if (data?.[0]) {
      // Auto-link telegram_id for future messages
      await supabase.from("employees")
        .update({ telegram_id: telegramId })
        .eq("id", data[0].id);
      return data[0];
    }
  }

  return null;
}

// ── Handlers ──────────────────────────────────────────────────────────────────

async function handleRemind() {
  await send(GROUP_ID,
    `📅 <b>זמינות לשבוע הבא</b>\n\n` +
    `שלחו כאן את הימים שתוכלו לעבוד 👇\n\n` +
    `לדוגמה:\n` +
    `<code>ראשון, שלישי, שישי</code>\n` +
    `<code>ראשון, שלישי עד 14:00, שישי</code>\n` +
    `<code>כל הימים</code>\n` +
    `<code>לא יכול השבוע</code>`
  );
  return new Response(JSON.stringify({ ok: true }));
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

  const chatId     = String(message.chat.id);
  const chatType   = message.chat.type;
  const text       = message.text.trim();
  const telegramId = message.from?.id;
  const firstName  = message.from?.first_name ?? "";
  const lastName   = message.from?.last_name  ?? "";

  // Only handle group messages (ignore private, ignore commands)
  if (chatType === "private" || text.startsWith("/")) return new Response("ok");

  // Only handle our group
  if (chatId !== GROUP_ID) return new Response("ok");

  // Check if this looks like availability
  const parsed = await parseMessage(text);
  if (!parsed.is_availability) return new Response("ok");

  // Find the employee
  const emp = await findEmployee(telegramId, firstName, lastName);
  if (!emp) {
    // Can't match — ask them to make sure their Telegram name matches
    await send(GROUP_ID,
      `@${message.from?.username ?? firstName} — לא מצאתי אותך במערכת 🤔\n` +
      `בדוק עם המנהל שהשם שלך הוזן נכון.`
    );
    return new Response("ok");
  }

  const week = nextSunday();

  // Upsert availability
  const { data: existing } = await supabase
    .from("availability_submissions")
    .select("id")
    .eq("employee_id", emp.id)
    .eq("week_start", week)
    .limit(1);

  if (existing?.[0]) {
    await supabase.from("availability_submissions")
      .update({ days: parsed.days, submitted_at: new Date().toISOString() })
      .eq("id", existing[0].id);
  } else {
    await supabase.from("availability_submissions")
      .insert({ employee_id: emp.id, week_start: week, days: parsed.days });
  }

  const entries = Object.entries(parsed.days);
  if (entries.length === 0) {
    await send(GROUP_ID, `✅ <b>${emp.name}</b> — נשמר, לא יכול השבוע הבא`);
  } else {
    const list = entries.map(([d, v]) =>
      v === true ? DAY_HE[d] : `${DAY_HE[d]} (עד ${v})`
    ).join(", ");
    await send(GROUP_ID, `✅ <b>${emp.name}</b> — ${list}`);
  }

  return new Response("ok");
}

// ── Main ──────────────────────────────────────────────────────────────────────

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
