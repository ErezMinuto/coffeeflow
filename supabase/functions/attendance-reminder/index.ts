/**
 * CoffeeFlow — Attendance Reminder (Supabase Edge Function)
 *
 * Triggered by pg_cron every 10 minutes during operating hours.
 * For each schedule_assignment scheduled for today (Israel-local):
 *
 *   Check-in reminder:  if now > start + checkin_grace AND no 'in' event
 *                       today → DM once (recorded as reminder_type='in').
 *
 *   Check-out reminder: if now > end + checkout_grace AND has 'in' but no
 *                       'out' event today → DM once (reminder_type='out').
 *                       Skipped entirely when the employee never checked
 *                       in (the check-in DM already handled that case).
 *
 * Friday rules (shorter shift, 15:00 close) also apply to dates listed in
 * attendance_holidays.
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

// Per-position shift windows. Hardcoded to match what the Schedule UI
// publishes — if the manager changes a shift time on the schedule grid,
// also update this map.
//
// Friday rules apply to Friday AND any date in attendance_holidays.
type ShiftTimes = { start: string; end: string };
type PositionConfig = { weekday?: ShiftTimes; friday?: ShiftTimes };

const POSITION_TIMES: Record<string, PositionConfig> = {
  opening:  { weekday: { start: "07:30", end: "16:30" }, friday: { start: "07:30", end: "15:00" } },
  cafe:     {                                            friday: { start: "07:45", end: "15:00" } },
  roasting: {},                                          // no scheduled window
  store1:   { weekday: { start: "09:30", end: "18:30" }, friday: { start: "09:00", end: "15:00" } },
  store2:   { weekday: { start: "09:30", end: "18:30" }, friday: { start: "09:00", end: "15:00" } },
  store3:   { weekday: { start: "09:30", end: "18:30" }, friday: { start: "09:00", end: "15:00" } },
  store4:   { weekday: { start: "09:30", end: "18:30" }, friday: { start: "09:00", end: "15:00" } },
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
  const dayCode = DAY_CODES.find(c => wd.startsWith(c)) ?? "sun";
  return { date, dayCode, hhmm };
}

// Sunday of the week containing the given Israel-local date (YYYY-MM-DD).
function sundayOfWeek(israelDate: string): string {
  const d = new Date(`${israelDate}T12:00:00Z`);
  const wdShort = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem", weekday: "short",
  }).format(d).toLowerCase();
  const dow = DAY_CODES.findIndex(c => wdShort.startsWith(c));
  const back = dow === -1 ? 0 : dow;
  d.setUTCDate(d.getUTCDate() - back);
  const y  = d.getUTCFullYear();
  const m  = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function startOfIsraelDayUTC(israelDate: string): string {
  const probe = new Date(`${israelDate}T12:00:00Z`);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Jerusalem",
    timeZoneName: "shortOffset",
  });
  const tz = fmt.formatToParts(probe).find(p => p.type === "timeZoneName")?.value ?? "GMT+3";
  const offsetHours = parseInt(tz.replace("GMT", "").replace("+", "")) || 3;
  const utc = new Date(`${israelDate}T00:00:00Z`);
  utc.setUTCHours(utc.getUTCHours() - offsetHours);
  return utc.toISOString();
}

function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

async function isHoliday(israelDate: string): Promise<boolean> {
  const { data } = await supabase
    .from("attendance_holidays")
    .select("holiday_date")
    .eq("holiday_date", israelDate)
    .limit(1);
  return (data?.length ?? 0) > 0;
}

interface RunStats {
  checked: number;
  pinged_in: number;
  pinged_out: number;
  skipped: number;
}

async function run(): Promise<RunStats> {
  const stats: RunStats = { checked: 0, pinged_in: 0, pinged_out: 0, skipped: 0 };

  const now = new Date();
  const { date: today, dayCode, hhmm: nowHHMM } = israelParts(now);
  const nowMin = hhmmToMinutes(nowHHMM);

  // No reminders on Saturday.
  if (dayCode === "sat") return stats;

  const useFridayRules = dayCode === "fri" || await isHoliday(today);

  // Settings.
  const { data: settings } = await supabase
    .from("attendance_settings")
    .select("checkin_grace_minutes, checkout_grace_minutes")
    .eq("id", 1)
    .single();
  const checkinGrace  = settings?.checkin_grace_minutes  ?? 10;
  const checkoutGrace = settings?.checkout_grace_minutes ?? 30;

  // This week's schedule.
  const weekStart = sundayOfWeek(today);
  const { data: sched } = await supabase
    .from("schedules")
    .select("id")
    .eq("week_start", weekStart)
    .limit(1);
  const scheduleId = sched?.[0]?.id;
  if (!scheduleId) return stats;

  const { data: assignments } = await supabase
    .from("schedule_assignments")
    .select("position, employee_name")
    .eq("schedule_id", scheduleId)
    .eq("day", dayCode);
  if (!assignments?.length) return stats;

  stats.checked = assignments.length;

  const dayStartUTC = startOfIsraelDayUTC(today);

  // Already-pinged keys for today (combined 'in'+'out').
  const { data: alreadyPinged } = await supabase
    .from("attendance_reminders_sent")
    .select("employee_id, position, reminder_type")
    .eq("shift_date", today);
  const pingedSet = new Set(
    (alreadyPinged ?? []).map(r => `${r.employee_id}:${r.position}:${r.reminder_type}`),
  );

  for (const a of assignments) {
    if (!a.employee_name) { stats.skipped++; continue; }

    const cfg = POSITION_TIMES[a.position];
    const times = useFridayRules ? cfg?.friday : cfg?.weekday;
    if (!times) { stats.skipped++; continue; }

    const startMin = hhmmToMinutes(times.start);
    const endMin   = hhmmToMinutes(times.end);

    const wantInPing  = nowMin >= startMin + checkinGrace;
    const wantOutPing = nowMin >= endMin   + checkoutGrace;
    if (!wantInPing && !wantOutPing) { stats.skipped++; continue; }

    // Resolve employee by name (schedule stores text).
    const { data: empRows } = await supabase
      .from("employees")
      .select("id, name, telegram_id")
      .ilike("name", a.employee_name)
      .eq("active", true)
      .not("telegram_id", "is", null)
      .limit(1);
    const emp = empRows?.[0];
    if (!emp) { stats.skipped++; continue; }

    // Today's events for this employee.
    const { data: events } = await supabase
      .from("attendance_events")
      .select("event_type")
      .eq("employee_id", emp.id)
      .gte("event_at", dayStartUTC);
    const hasIn  = (events ?? []).some(e => e.event_type === "in");
    const hasOut = (events ?? []).some(e => e.event_type === "out");

    // Check-in reminder.
    if (wantInPing
        && !hasIn
        && !pingedSet.has(`${emp.id}:${a.position}:in`)) {
      await send(emp.telegram_id,
        `👋 שלום ${emp.name}!\nהמשמרת התחילה ב-${times.start} ואין החתמת כניסה.\n` +
        `אם הגעת — שלח <b>נכנסתי</b> כדי לרשום את הכניסה.`,
      );
      await supabase.from("attendance_reminders_sent").insert({
        employee_id: emp.id, shift_date: today,
        position: a.position, reminder_type: "in",
      });
      stats.pinged_in++;
    }

    // Check-out reminder — only if they checked in but haven't checked out.
    if (wantOutPing
        && hasIn
        && !hasOut
        && !pingedSet.has(`${emp.id}:${a.position}:out`)) {
      await send(emp.telegram_id,
        `👋 שלום ${emp.name}!\nהמשמרת הסתיימה ב-${times.end} ואין החתמת יציאה.\n` +
        `שלח <b>יצאתי</b> כדי לסגור את המשמרת.`,
      );
      await supabase.from("attendance_reminders_sent").insert({
        employee_id: emp.id, shift_date: today,
        position: a.position, reminder_type: "out",
      });
      stats.pinged_out++;
    }
  }

  return stats;
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
