/**
 * CoffeeFlow — Attendance Reminder (Supabase Edge Function)
 *
 * Triggered by pg_cron every 15 minutes during operating hours.
 * For each schedule_assignment scheduled for today (Israel local date):
 *   - look up the position's start time
 *   - if (now Israel) > start_time + grace AND no 'in' event today → DM
 *   - record in attendance_reminders_sent so we ping at most once per shift
 *
 * Skip check-out reminders for v1 — manager will spot empty cells in the grid.
 */

import { serve }        from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const BOT_TOKEN = Deno.env.get("EMPLOYEE_BOT_TOKEN")        ?? "";
const SUPA_URL  = Deno.env.get("SUPABASE_URL")              ?? "";
const SUPA_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const supabase = createClient(SUPA_URL, SUPA_KEY);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Position start times — must stay in sync with src/components/schedule/Schedule.jsx
// "make it simple": hardcode here. If the manager changes a schedule time, edit
// both files. Friday variants override the weekday time.
const POSITION_START: Record<string, { weekday: string | null; friday?: string }> = {
  opening:  { weekday: "07:30" },
  cafe:     { weekday: null, friday: "07:45" },         // Friday-only position
  roasting: { weekday: null },                          // no scheduled start
  store1:   { weekday: "09:30", friday: "09:00" },
  store2:   { weekday: "09:30", friday: "09:00" },
  store3:   { weekday: "09:30", friday: "09:00" },
  store4:   { weekday: "09:30", friday: "09:00" },
};

const DAY_CODES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

async function send(chatId: number | string, text: string) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  });
}

// Israel-local date+time helpers (avoid TZ drift between server UTC and shop time).
function israelParts(now = new Date()): { date: string; dayCode: string; hhmm: string } {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", weekday: "short",
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map(p => [p.type, p.value]));
  const date    = `${parts.year}-${parts.month}-${parts.day}`;
  const hhmm    = `${parts.hour}:${parts.minute}`;
  const wd      = (parts.weekday || "").toLowerCase();
  // en-CA short weekday → "sun, mon, tue, wed, thu, fri, sat"
  const dayCode = DAY_CODES.find(c => wd.startsWith(c)) ?? "sun";
  return { date, dayCode, hhmm };
}

// Sunday of the week containing the given Israel-local date (YYYY-MM-DD).
function sundayOfWeek(israelDate: string): string {
  // Build a Date at noon UTC of that Israel date to dodge DST edge cases,
  // then walk back to the Sunday.
  const d = new Date(`${israelDate}T12:00:00Z`);
  // Day-of-week in Israel for that moment.
  const wdShort = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem", weekday: "short",
  }).format(d).toLowerCase();
  const dow = DAY_CODES.findIndex(c => wdShort.startsWith(c));
  const back = dow === -1 ? 0 : dow; // sun=0, mon=1, ...
  d.setUTCDate(d.getUTCDate() - back);
  const y  = d.getUTCFullYear();
  const m  = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function startOfIsraelDayUTC(israelDate: string): string {
  // Israel is UTC+2 (winter) / UTC+3 (summer). To get the UTC instant for
  // local-midnight, build "YYYY-MM-DDT00:00:00" in Israel TZ and convert.
  // Cheap trick: format both midnight UTC and the local view, compute offset.
  const localMidnight = new Date(`${israelDate}T00:00:00`);
  // localMidnight is in the runtime's TZ (assume UTC on Supabase) — that's wrong.
  // Use Intl roundtrip to extract offset.
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Jerusalem",
    timeZoneName: "shortOffset",
  });
  const parts = fmt.formatToParts(new Date(`${israelDate}T12:00:00Z`));
  const tz    = parts.find(p => p.type === "timeZoneName")?.value ?? "GMT+3";
  // tz like "GMT+3" or "GMT+2"
  const offsetHours = parseInt(tz.replace("GMT", "").replace("+", "")) || 3;
  const utc = new Date(`${israelDate}T00:00:00Z`);
  utc.setUTCHours(utc.getUTCHours() - offsetHours);
  return utc.toISOString();
}

async function run(): Promise<{ checked: number; pinged: number; skipped: number }> {
  const now = new Date();
  const { date: today, dayCode, hhmm: nowHHMM } = israelParts(now);

  // No reminders on Saturday.
  if (dayCode === "sat") return { checked: 0, pinged: 0, skipped: 0 };

  // Reminder grace from settings (default 5).
  const { data: settings } = await supabase
    .from("attendance_settings")
    .select("reminder_grace_minutes")
    .eq("id", 1)
    .single();
  const grace = settings?.reminder_grace_minutes ?? 5;

  // This week's schedule.
  const weekStart = sundayOfWeek(today);
  const { data: sched } = await supabase
    .from("schedules")
    .select("id")
    .eq("week_start", weekStart)
    .limit(1);
  const scheduleId = sched?.[0]?.id;
  if (!scheduleId) {
    console.log(`no schedule for week_start=${weekStart}`);
    return { checked: 0, pinged: 0, skipped: 0 };
  }

  // Today's assignments.
  const { data: assignments } = await supabase
    .from("schedule_assignments")
    .select("position, employee_name")
    .eq("schedule_id", scheduleId)
    .eq("day", dayCode);

  if (!assignments || assignments.length === 0) {
    return { checked: 0, pinged: 0, skipped: 0 };
  }

  const dayStartUTC = startOfIsraelDayUTC(today);

  // Already-pinged keys for today.
  const { data: alreadyPinged } = await supabase
    .from("attendance_reminders_sent")
    .select("employee_id, position")
    .eq("shift_date", today);
  const pingedSet = new Set((alreadyPinged ?? []).map(r => `${r.employee_id}:${r.position}`));

  let pinged = 0;
  let skipped = 0;

  for (const a of assignments) {
    if (!a.employee_name) { skipped++; continue; }

    const cfg = POSITION_START[a.position];
    const startTime = (dayCode === "fri" ? cfg?.friday : cfg?.weekday) ?? cfg?.weekday;
    if (!startTime) { skipped++; continue; } // position has no defined start (roasting)

    // Compute "now is past start + grace" in HH:MM string compare.
    const [sh, sm] = startTime.split(":").map(Number);
    const startMin = sh * 60 + sm + grace;
    const [nh, nm] = nowHHMM.split(":").map(Number);
    const nowMin   = nh * 60 + nm;
    if (nowMin < startMin) { skipped++; continue; } // shift hasn't started yet

    // Resolve employee by name (schedule stores text), require active + telegram_id.
    const { data: empRows } = await supabase
      .from("employees")
      .select("id, name, telegram_id")
      .ilike("name", a.employee_name)
      .eq("active", true)
      .not("telegram_id", "is", null)
      .limit(1);
    const emp = empRows?.[0];
    if (!emp) { skipped++; continue; }

    if (pingedSet.has(`${emp.id}:${a.position}`)) { skipped++; continue; }

    // Has a check-in already today?
    const { data: events } = await supabase
      .from("attendance_events")
      .select("id")
      .eq("employee_id", emp.id)
      .eq("event_type", "in")
      .gte("event_at", dayStartUTC)
      .limit(1);
    if (events && events.length > 0) { skipped++; continue; }

    // Ping.
    await send(emp.telegram_id,
      `👋 שלום ${emp.name}!\nאנחנו לא רואים שהחתמת כניסה היום.\n` +
      `אם הגעת — שלח <b>נכנסתי</b> כדי לרשום את הכניסה.`
    );
    await supabase.from("attendance_reminders_sent").insert({
      employee_id: emp.id,
      shift_date:  today,
      position:    a.position,
    });
    pinged++;
  }

  return { checked: assignments.length, pinged, skipped };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  try {
    const result = await run();
    console.log("attendance-reminder:", JSON.stringify(result));
    return new Response(JSON.stringify({ ok: true, ...result }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: any) {
    console.error("attendance-reminder error:", err);
    return new Response(JSON.stringify({ ok: false, error: err?.message ?? String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
