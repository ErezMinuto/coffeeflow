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

// ── Security helpers ─────────────────────────────────────────────────────────

const RATE_LIMIT_PER_WINDOW = 20;
const RATE_LIMIT_WINDOW_SECONDS = 60;

async function checkRateLimit(telegramId: string | number | undefined): Promise<boolean> {
  if (!telegramId) return true;
  try {
    const { data, error } = await supabase.rpc("check_bot_rate_limit", {
      p_telegram_id:    String(telegramId),
      p_bot_name:       "employee-bot",
      p_limit:          RATE_LIMIT_PER_WINDOW,
      p_window_seconds: RATE_LIMIT_WINDOW_SECONDS,
    });
    if (error) {
      console.error("rate-limit RPC error, allowing request:", error.message);
      return true;
    }
    return data === true;
  } catch (e: any) {
    console.error("rate-limit RPC threw, allowing request:", e?.message);
    return true;
  }
}

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

// ── Helpers ──────────────────────────────────────────────────────────────────

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// Persistent reply keyboard for active employees in private DM. Tapping a
// button sends the button text as a normal message, which the existing
// regex handlers pick up.
const ATTENDANCE_KEYBOARD = {
  keyboard: [
    [{ text: "🟢 נכנסתי" }, { text: "🔴 יצאתי" }],
    [{ text: "📊 דוח" }, { text: "🗓️ סידור" }, { text: "📅 זמינות" }],
  ],
  resize_keyboard:  true,
  is_persistent:    true,
};

const POSITION_LABEL_HE: Record<string, string> = {
  opening:  "פתיחת קפה",
  cafe:     "בית קפה",
  roasting: "קלייה",
  store1:   "חנות",
  store2:   "חנות",
  store3:   "חנות",
  store4:   "חנות",
};

async function send(
  chatId: number | string,
  text: string,
  opts: { keyboard?: typeof ATTENDANCE_KEYBOARD | { remove_keyboard: true } } = {},
) {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
  };
  if (opts.keyboard) body.reply_markup = opts.keyboard;
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
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
  // Strip zero-width chars and directional marks (U+200B–U+200F, U+202A–U+202E, U+FEFF)
  // that mobile keyboards sometimes prepend to RTL Hebrew text. Without this,
  // /^נכנסתי/ silently fails to match on phones.
  const rawText    = message.text;
  const text       = rawText.replace(/[​-‏‪-‮﻿]/g, "").trim();
  const telegramId = message.from?.id;
  const firstName  = message.from?.first_name ?? "";

  if (rawText !== text) {
    console.log(`webhook: stripped invisible chars from text. raw_len=${rawText.length} clean_len=${text.length}`);
  }
  console.log(`webhook: chatType=${chatType} chatId=${chatId} telegramId=${telegramId} text="${text}"`);

  // Allow private chats for availability, only allow our group for registration
  const isPrivate = chatType === "private";
  if (!isPrivate && chatId !== GROUP_ID) {
    console.log(`webhook: ignored — not private and not group (GROUP_ID=${GROUP_ID})`);
    return new Response("ok");
  }

  // /start in private DM → welcome + persistent keyboard.
  if (isPrivate && (text === "/start" || text.startsWith("/start "))) {
    const greet = firstName ? `שלום ${firstName}! 👋` : "שלום! 👋";
    await send(chatId,
      `${greet}\n\nברוכים הבאים לבוט הנוכחות של מינוטו.\n\n` +
      `לחצו על כפתור למטה כדי להחתים כניסה / יציאה או לראות את שעות החודש. ⌨️\n\n` +
      `אם עוד לא נרשמתם, שלחו את השם המלא ומספר טלפון בהודעה אחת:\n` +
      `<code>ישראל ישראלי 0501234567</code>`,
      { keyboard: ATTENDANCE_KEYBOARD },
    );
    return new Response("ok");
  }

  if (text.startsWith("/")) return new Response("ok");

  // Strip leading non-Hebrew chars (emojis, spaces, punctuation) so tapping
  // a "🟢 נכנסתי" button matches the same regex as plain typed text.
  const matchText = text.replace(/^[^א-ת]+/, "");

  // ── Rate limit ─────────────────────────────────────────────────────────
  if (!(await checkRateLimit(telegramId))) {
    console.warn(`employee-bot rate-limited telegram_id=${telegramId}`);
    return new Response("ok");
  }

  // ── Injection pre-filter ───────────────────────────────────────────────
  if (looksLikeInjection(text)) {
    console.warn(`employee-bot rejected injection attempt from telegram_id=${telegramId}: "${text.slice(0, 100)}"`);
    return new Response("ok");
  }

  // ── Group redirect: נכנסתי / יצאתי in the group falls through silently
  // otherwise. Send a one-liner pointing the employee at the private DM
  // so they know where to go next time.
  if (!isPrivate && /^(נכנסתי|יצאתי)\b/.test(matchText)) {
    const word = /^נכנסתי\b/.test(matchText) ? "נכנסתי" : "יצאתי";
    await send(chatId,
      `${firstName || "היי"}, שלחו <b>${word}</b> בצ'אט הפרטי איתי, ` +
      `לא בקבוצה: <a href="https://t.me/minuto_team_bot">@minuto_team_bot</a>`,
    );
    return new Response("ok");
  }

  // ── Attendance check-in / check-out (private DM only) ──────────────────
  // Free-text "נכנסתי" or "יצאתי". startsWith so "נכנסתי!" / "יצאתי לעבודה" still match.
  if (isPrivate) {
    const isCheckIn  = /^נכנסתי\b/.test(matchText);
    const isCheckOut = /^יצאתי\b/.test(matchText);
    if (isCheckIn || isCheckOut) {
      const eventType = isCheckIn ? "in" : "out";
      const { data: empRows } = await supabase
        .from("employees")
        .select("id, name")
        .eq("telegram_id", telegramId)
        .eq("active", true)
        .limit(1);
      const emp = empRows?.[0];
      if (!emp) {
        await send(chatId,
          `שלח קודם את שמך ומספר טלפון כדי להירשם 👆\nלדוגמה: <code>ישראל ישראלי 0501234567</code>`
        );
        return new Response("ok");
      }

      const now = new Date();
      const { error: insertErr } = await supabase
        .from("attendance_events")
        .insert({
          employee_id: emp.id,
          event_type:  eventType,
          event_at:    now.toISOString(),
          source:      "telegram",
        });
      if (insertErr) {
        console.error(`attendance: insert error for ${emp.name}:`, insertErr);
        await send(chatId, `❌ שגיאה ברישום הנוכחות. נסה שוב.`);
        return new Response("ok");
      }

      const timeStr = new Intl.DateTimeFormat("he-IL", {
        timeZone: "Asia/Jerusalem",
        hour: "2-digit",
        minute: "2-digit",
      }).format(now);
      const verb = isCheckIn ? "נכנסת" : "יצאת";
      await send(chatId, `✅ ${verb} ב-${timeStr}`, { keyboard: ATTENDANCE_KEYBOARD });
      console.log(`attendance: ${emp.name} (${emp.id}) ${eventType} @ ${now.toISOString()}`);
      return new Response("ok");
    }
  }

  // ── Monthly hours report (private DM only) ─────────────────────────────
  // Triggers: "דוח", "השעות שלי", "כמה שעות".
  if (isPrivate) {
    const wantsReport =
      /^דוח\b/.test(matchText) ||
      /השעות\s+שלי/.test(matchText) ||
      /כמה\s+שעות/.test(matchText);
    if (wantsReport) {
      const { data: empRows } = await supabase
        .from("employees")
        .select("id, name")
        .eq("telegram_id", telegramId)
        .eq("active", true)
        .limit(1);
      const emp = empRows?.[0];
      if (!emp) {
        await send(chatId,
          `שלח קודם את שמך ומספר טלפון כדי להירשם 👆\nלדוגמה: <code>ישראל ישראלי 0501234567</code>`,
        );
        return new Response("ok");
      }

      // Current Israel-local month boundaries.
      const israelDateFmt = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Jerusalem",
        year: "numeric", month: "2-digit", day: "2-digit",
      });
      const todayStr = israelDateFmt.format(new Date());
      const [yearStr, monthStr] = todayStr.split("-");
      const year  = parseInt(yearStr);
      const month = parseInt(monthStr);

      const offsetFor = (ymd: string): number => {
        const probe = new Date(`${ymd}T12:00:00Z`);
        const tz = new Intl.DateTimeFormat("en-US", {
          timeZone: "Asia/Jerusalem",
          timeZoneName: "shortOffset",
        }).formatToParts(probe).find(p => p.type === "timeZoneName")?.value ?? "GMT+3";
        return parseInt(tz.replace("GMT", "").replace("+", "")) || 3;
      };
      const monthStartIL = `${yearStr}-${monthStr}-01`;
      const nextMonth    = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, "0")}-01`;
      const startUTC = new Date(`${monthStartIL}T00:00:00Z`);
      startUTC.setUTCHours(startUTC.getUTCHours() - offsetFor(monthStartIL));
      const endUTC = new Date(`${nextMonth}T00:00:00Z`);
      endUTC.setUTCHours(endUTC.getUTCHours() - offsetFor(nextMonth));

      const { data: events } = await supabase
        .from("attendance_events")
        .select("event_type, event_at")
        .eq("employee_id", emp.id)
        .gte("event_at", startUTC.toISOString())
        .lt("event_at", endUTC.toISOString())
        .order("event_at", { ascending: true });

      // Group by Israel-local date, pair in/out per day.
      const byDate = new Map<string, { in: Date; out: Date | null }[]>();
      const pendingIn = new Map<string, Date>();
      let openShifts = 0;
      for (const ev of events ?? []) {
        const date = israelDateFmt.format(new Date(ev.event_at));
        if (!byDate.has(date)) byDate.set(date, []);
        if (ev.event_type === "in") {
          pendingIn.set(date, new Date(ev.event_at));
        } else {
          const inAt = pendingIn.get(date);
          if (inAt) {
            byDate.get(date)!.push({ in: inAt, out: new Date(ev.event_at) });
            pendingIn.delete(date);
          }
        }
      }
      // Anything still pending = open shift (in without out).
      for (const [date, inAt] of pendingIn.entries()) {
        byDate.get(date)!.push({ in: inAt, out: null });
        openShifts++;
      }

      let totalHours = 0;
      let workedDays = 0;
      for (const pairs of byDate.values()) {
        let dayHours = 0;
        for (const p of pairs) {
          if (p.out) dayHours += (p.out.getTime() - p.in.getTime()) / 3_600_000;
        }
        if (dayHours > 0) {
          totalHours += dayHours;
          workedDays++;
        }
      }

      const monthLabelHe = [
        "ינואר","פברואר","מרץ","אפריל","מאי","יוני",
        "יולי","אוגוסט","ספטמבר","אוקטובר","נובמבר","דצמבר",
      ][month - 1];

      let reply = `📊 <b>דוח החודש (${monthLabelHe} ${year})</b>\n\n` +
                  `ימי עבודה: <b>${workedDays}</b>\n` +
                  `סה"כ שעות: <b>${totalHours.toFixed(1)}</b>`;
      if (openShifts > 0) {
        reply += `\n\n⚠️ ${openShifts} משמרות ללא החתמת יציאה. שלחו <b>יצאתי</b> או פנו למנהל.`;
      }
      await send(chatId, reply, { keyboard: ATTENDANCE_KEYBOARD });
      console.log(`report: ${emp.name} (${emp.id}) hours=${totalHours.toFixed(1)} days=${workedDays} open=${openShifts}`);
      return new Response("ok");
    }
  }

  // ── Schedule view (private DM only) ────────────────────────────────────
  // Trigger words: "סידור", "המשמרות שלי", "מתי אני עובד".
  if (isPrivate) {
    const wantsSchedule =
      /^סידור\b/.test(matchText) ||
      /המשמרות\s+שלי/.test(matchText) ||
      /מתי\s+אני\s+עובד/.test(matchText);
    if (wantsSchedule) {
      const { data: empRows } = await supabase
        .from("employees")
        .select("id, name")
        .eq("telegram_id", telegramId)
        .eq("active", true)
        .limit(1);
      const emp = empRows?.[0];
      if (!emp) {
        await send(chatId,
          `שלח קודם את שמך ומספר טלפון כדי להירשם 👆\nלדוגמה: <code>ישראל ישראלי 0501234567</code>`,
        );
        return new Response("ok");
      }

      // Most recent schedule covering today or upcoming.
      const today = new Date();
      const todayStr = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Jerusalem",
        year: "numeric", month: "2-digit", day: "2-digit",
      }).format(today);
      // Look at this week's schedule (Sunday on or before today) plus future.
      const probeDate = new Date(`${todayStr}T12:00:00Z`);
      const wd = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Jerusalem", weekday: "short",
      }).format(probeDate).toLowerCase();
      const dowIdx = ["sun","mon","tue","wed","thu","fri","sat"]
        .findIndex(c => wd.startsWith(c));
      const sundayDate = new Date(probeDate);
      sundayDate.setUTCDate(sundayDate.getUTCDate() - (dowIdx === -1 ? 0 : dowIdx));
      const sundayStr = sundayDate.toISOString().slice(0, 10);

      const { data: schedules } = await supabase
        .from("schedules")
        .select("id, week_start")
        .gte("week_start", sundayStr)
        .order("week_start", { ascending: true })
        .limit(2);

      if (!schedules?.length) {
        await send(chatId, `📅 עוד לא פורסם סידור לשבוע הקרוב.`,
          { keyboard: ATTENDANCE_KEYBOARD });
        return new Response("ok");
      }

      // Find this employee in each week's assignments.
      const sectionLines: string[] = [];
      for (const sched of schedules) {
        const { data: assigns } = await supabase
          .from("schedule_assignments")
          .select("day, position, employee_name")
          .eq("schedule_id", sched.id)
          .ilike("employee_name", emp.name);

        if (!assigns?.length) continue;

        // Header for this week.
        const weekStartDate = new Date(`${sched.week_start}T12:00:00Z`);
        const weekEndDate   = new Date(weekStartDate);
        weekEndDate.setUTCDate(weekEndDate.getUTCDate() + 5);
        const fmtShort = (d: Date) =>
          `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
        sectionLines.push(`📅 <b>שבוע ${fmtShort(weekStartDate)} — ${fmtShort(weekEndDate)}</b>`);

        // Order assignments by day.
        const dayOrder = ["sun","mon","tue","wed","thu","fri"];
        const sorted = [...assigns].sort(
          (a, b) => dayOrder.indexOf(a.day) - dayOrder.indexOf(b.day),
        );
        for (const a of sorted) {
          const dayIdx = dayOrder.indexOf(a.day);
          const date = new Date(weekStartDate);
          date.setUTCDate(date.getUTCDate() + dayIdx);
          const label = POSITION_LABEL_HE[a.position] ?? a.position;
          sectionLines.push(
            `• ${DAY_HE[a.day]} ${fmtShort(date)} — ${label}`,
          );
        }
        sectionLines.push("");
      }

      if (sectionLines.length === 0) {
        await send(chatId,
          `📅 לא משובצ/ת לאף משמרת בשבועות הקרובים.`,
          { keyboard: ATTENDANCE_KEYBOARD });
        return new Response("ok");
      }

      await send(chatId, sectionLines.join("\n").trim(),
        { keyboard: ATTENDANCE_KEYBOARD });
      console.log(`schedule: ${emp.name} (${emp.id}) sent ${schedules.length} weeks`);
      return new Response("ok");
    }
  }

  // ── Availability prompt (private DM only) ──────────────────────────────
  // User taps "📅 זמינות" → bot replies with the same prompt the cron sends,
  // and the user's free-text reply gets handled by the existing classifier.
  if (isPrivate) {
    const wantsAvailability =
      /^זמינות\b/.test(matchText) ||
      /הזמינות\s+שלי/.test(matchText);
    if (wantsAvailability) {
      const week = nextSunday();
      // DD/MM Israel-local of the upcoming week.
      const friday = new Date(`${week}T12:00:00Z`);
      friday.setUTCDate(friday.getUTCDate() + 5);
      const fmtShort = (d: Date) =>
        `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      const sundayDt = new Date(`${week}T12:00:00Z`);

      await send(chatId,
        `📅 <b>זמינות לשבוע ${fmtShort(sundayDt)} — ${fmtShort(friday)}</b>\n\n` +
        `שלחו את הימים שאתם פנויים השבוע 👇\n\n` +
        `דוגמאות:\n` +
        `<code>ראשון, שני, שישי</code>\n` +
        `<code>שני, חמישי עד 14:00, שישי</code>\n` +
        `<code>כל הימים</code>  |  <code>לא יכול השבוע</code>`,
        { keyboard: ATTENDANCE_KEYBOARD },
      );
      return new Response("ok");
    }
  }

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
      await send(chatId, `👋 <b>${existing[0].name}</b>, כבר רשום/ה במערכת!`,
        { keyboard: ATTENDANCE_KEYBOARD });
      return new Response("ok");
    }

    // Check if name already exists. Only bind this telegram_id to an
    // existing record if that record currently has NO telegram_id (i.e.
    // it was pre-created by an admin in the dashboard and is waiting for
    // the employee to register). If the existing record already has a
    // telegram_id, this would be a hijack — an attacker who knows a
    // coworker's name could bind their own Telegram account to it and
    // impersonate them. Refuse the rebind and alert the user.
    const { data: byName } = await supabase
      .from("employees")
      .select("id, name, telegram_id")
      .ilike("name", result.name)
      .limit(1);

    if (byName?.[0]) {
      const existingRecord = byName[0];
      if (existingRecord.telegram_id) {
        // Already bound to someone else — refuse and log.
        console.warn(
          `employee-bot refused hijack attempt: name="${result.name}" ` +
          `attacker_tg=${telegramId} existing_tg=${existingRecord.telegram_id}`
        );
        await send(chatId,
          `⚠️ השם "${result.name}" כבר רשום במערכת עם חשבון אחר.\n` +
          `אם זה אתה, פנה למנהל כדי לעדכן את החשבון.`
        );
        return new Response("ok");
      }
      // Safe to bind — record has no telegram_id yet, likely pre-created by admin
      await supabase.from("employees")
        .update({ telegram_id: telegramId, ...(result.phone ? { phone: result.phone } : {}) })
        .eq("id", existingRecord.id);
      await send(chatId, `✅ <b>${existingRecord.name}</b>, נרשמת בהצלחה! 🎉`,
        { keyboard: ATTENDANCE_KEYBOARD });
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
      await send(chatId,
        `✅ <b>${result.name}</b>, נוספת לרשימה! 🎉\n` +
        `המנהל יגדיר את התפקיד שלך בקרוב. ` +
        `אחרי שתאושרו, שלחו <code>/start</code> כדי לקבל את כפתורי הנוכחות.`,
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

  // ── Private-DM fallback ────────────────────────────────────────────────
  // Anything that lands here in private was a real DM that didn't match
  // any handler. Reply with a hint so employees never see total silence.
  if (isPrivate) {
    await send(chatId,
      `🤔 לא הבנתי.\n\n` +
      `🟢 שלחו <b>נכנסתי</b> בכניסה למשמרת\n` +
      `🔴 שלחו <b>יצאתי</b> בסיום\n` +
      `📊 שלחו <b>דוח</b> כדי לראות שעות החודש`,
    );
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
      if (action === "diagnose") {
        // One-shot diagnostic: ask Telegram what webhook is set, plus a
        // hash-only echo of our local secret so we can spot a mismatch
        // without exposing the secret.
        const wh = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo`);
        const me = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getMe`);
        const whJson = await wh.json();
        const meJson = await me.json();
        const localSecretHash = WEBHOOK_SECRET
          ? await sha256(WEBHOOK_SECRET).then(s => s.slice(0, 12))
          : null;
        return new Response(JSON.stringify({
          bot:               meJson?.result ?? null,
          webhook:           whJson?.result ?? null,
          local_secret_set:  !!WEBHOOK_SECRET,
          local_secret_hash: localSecretHash,
          group_id_set:      !!GROUP_ID,
        }, null, 2), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
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
