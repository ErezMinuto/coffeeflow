/**
 * CoffeeFlow — Attendance Export (Supabase Edge Function)
 *
 * POST { year_month: "2026-04" }  → builds an XLSX (one sheet per employee)
 * for the given Israel-local month and emails it to the accountant via Resend.
 *
 * Each sheet rows = one calendar day in the month. For days with multiple
 * in/out pairs, all pairs are collapsed into a single line (first in, last
 * out, sum of paired hours). No break deductions.
 */

import { serve }        from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as XLSX        from "https://esm.sh/xlsx@0.18.5";

const SUPA_URL    = Deno.env.get("SUPABASE_URL")              ?? "";
const SUPA_KEY    = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const RESEND_KEY  = Deno.env.get("RESEND_API_KEY")            ?? "";
const SENDER_EMAIL = Deno.env.get("SENDER_EMAIL")             ?? "info@minuto.co.il";

const supabase = createClient(SUPA_URL, SUPA_KEY);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const DAY_LABELS_HE = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];

// Israel-local YYYY-MM and offset helpers.
function israelOffsetHoursAt(utcInstant: Date): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Jerusalem",
    timeZoneName: "shortOffset",
  });
  const tz = fmt.formatToParts(utcInstant).find(p => p.type === "timeZoneName")?.value ?? "GMT+3";
  return parseInt(tz.replace("GMT", "").replace("+", "")) || 3;
}

function utcInstantForIsraelMidnight(israelDate: string): Date {
  // israelDate = "YYYY-MM-DD"
  const naive = new Date(`${israelDate}T12:00:00Z`); // mid-day to dodge DST
  const offset = israelOffsetHoursAt(naive);
  const utc = new Date(`${israelDate}T00:00:00Z`);
  utc.setUTCHours(utc.getUTCHours() - offset);
  return utc;
}

function israelDateOf(utcIso: string): string {
  const d = new Date(utcIso);
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem",
    year: "numeric", month: "2-digit", day: "2-digit",
  });
  const parts = Object.fromEntries(fmt.formatToParts(d).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function israelTimeOf(utcIso: string): string {
  const d = new Date(utcIso);
  return new Intl.DateTimeFormat("he-IL", {
    timeZone: "Asia/Jerusalem",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(d);
}

function lastMonthYM(): string {
  const now = new Date();
  // Use Israel-local current date so a 02:00 Israel run on day 1 still picks
  // the prior month correctly.
  const israelDate = israelDateOf(now.toISOString());
  const [y, m] = israelDate.split("-").map(Number);
  const prevMonth = m === 1 ? 12 : m - 1;
  const prevYear  = m === 1 ? y - 1 : y;
  return `${prevYear}-${String(prevMonth).padStart(2, "0")}`;
}

function monthRange(yearMonth: string): { startUTC: Date; endUTC: Date; days: string[] } {
  const [y, m] = yearMonth.split("-").map(Number);
  const startStr = `${y}-${String(m).padStart(2, "0")}-01`;
  const startUTC = utcInstantForIsraelMidnight(startStr);
  const nextY = m === 12 ? y + 1 : y;
  const nextM = m === 12 ? 1 : m + 1;
  const endStr = `${nextY}-${String(nextM).padStart(2, "0")}-01`;
  const endUTC = utcInstantForIsraelMidnight(endStr);

  const days: string[] = [];
  // Iterate Israel-local days inside the month.
  const lastDay = new Date(`${endStr}T00:00:00Z`);
  lastDay.setUTCDate(lastDay.getUTCDate() - 1);
  const lastDayStr = lastDay.toISOString().slice(0, 10);
  const lastDayNum = parseInt(lastDayStr.slice(8, 10));
  for (let d = 1; d <= lastDayNum; d++) {
    days.push(`${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
  }
  return { startUTC, endUTC, days };
}

interface DayRow {
  date: string;       // YYYY-MM-DD (Israel)
  dayLabel: string;   // ראשון, שני, ...
  firstIn?: string;   // HH:MM
  lastOut?: string;   // HH:MM
  hours: number;      // decimal
  note: string;
}

function pairEvents(events: { event_type: string; event_at: string }[]): {
  pairs: { in: Date; out: Date | null }[];
  unmatched: string;
} {
  // Sort by event_at asc.
  const sorted = [...events].sort((a, b) => a.event_at.localeCompare(b.event_at));
  const pairs: { in: Date; out: Date | null }[] = [];
  let pendingIn: Date | null = null;
  let warnings: string[] = [];
  for (const e of sorted) {
    if (e.event_type === "in") {
      if (pendingIn) warnings.push("שתי כניסות רצופות");
      pendingIn = new Date(e.event_at);
    } else { // 'out'
      if (!pendingIn) {
        warnings.push("יציאה ללא כניסה");
        continue;
      }
      pairs.push({ in: pendingIn, out: new Date(e.event_at) });
      pendingIn = null;
    }
  }
  if (pendingIn) {
    pairs.push({ in: pendingIn, out: null });
    warnings.push("חסרה החתמת יציאה");
  }
  return { pairs, unmatched: warnings.join("; ") };
}

function buildEmployeeSheet(empName: string, days: string[], eventsByDate: Map<string, any[]>) {
  const aoa: any[][] = [
    [empName],
    [],
    ["תאריך", "יום", "כניסה", "יציאה", "שעות", "הערה"],
  ];
  let totalHours = 0;
  let workedDays = 0;

  for (const date of days) {
    const ev = eventsByDate.get(date) ?? [];
    if (ev.length === 0) {
      aoa.push([date, dayLabelOf(date), "", "", "", ""]);
      continue;
    }
    const { pairs, unmatched } = pairEvents(ev);
    if (pairs.length === 0) {
      aoa.push([date, dayLabelOf(date), "", "", "", unmatched]);
      continue;
    }
    const firstIn = pairs[0].in;
    const lastOut = pairs[pairs.length - 1].out;
    let hours = 0;
    for (const p of pairs) {
      if (p.out) hours += (p.out.getTime() - p.in.getTime()) / 3_600_000;
    }
    totalHours += hours;
    workedDays += 1;
    aoa.push([
      date,
      dayLabelOf(date),
      israelTimeOf(firstIn.toISOString()),
      lastOut ? israelTimeOf(lastOut.toISOString()) : "",
      hours > 0 ? Number(hours.toFixed(2)) : "",
      unmatched,
    ]);
  }

  aoa.push([]);
  aoa.push(["סה״כ ימי עבודה", workedDays, "", "סה״כ שעות", Number(totalHours.toFixed(2))]);

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = [
    { wch: 12 }, { wch: 8 }, { wch: 8 }, { wch: 8 }, { wch: 8 }, { wch: 30 },
  ];
  return ws;
}

function dayLabelOf(israelDate: string): string {
  // Day-of-week for the Israel-local date. Use noon-UTC to dodge DST edges.
  const d = new Date(`${israelDate}T12:00:00Z`);
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem", weekday: "short",
  });
  const wd = fmt.format(d).toLowerCase();
  const codes = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const idx = codes.findIndex(c => wd.startsWith(c));
  return DAY_LABELS_HE[idx === -1 ? 0 : idx];
}

// Sanitize a sheet name for Excel (max 31 chars, no : \ / ? * [ ]).
function safeSheetName(name: string, used: Set<string>): string {
  let n = name.replace(/[:\\/?*\[\]]/g, "").slice(0, 31).trim();
  if (!n) n = "Employee";
  let candidate = n;
  let i = 2;
  while (used.has(candidate)) {
    const suffix = ` (${i})`;
    candidate = n.slice(0, 31 - suffix.length) + suffix;
    i++;
  }
  used.add(candidate);
  return candidate;
}

async function buildAndSend(yearMonth: string) {
  // Settings.
  const { data: settings } = await supabase
    .from("attendance_settings")
    .select("accountant_email")
    .eq("id", 1)
    .single();
  const to = settings?.accountant_email?.trim();
  if (!to) {
    return { ok: false, error: "accountant_email לא מוגדר" };
  }

  // Range.
  const { startUTC, endUTC, days } = monthRange(yearMonth);

  // Only export employees who actually have events this month — empty
  // sheets are noise for the accountant. Active employees with zero events
  // are intentionally skipped here.
  const { data: events } = await supabase
    .from("attendance_events")
    .select("employee_id, event_type, event_at")
    .gte("event_at", startUTC.toISOString())
    .lt("event_at", endUTC.toISOString());

  const empIds = new Set<string>();
  for (const ev of events ?? []) empIds.add(ev.employee_id);

  if (empIds.size === 0) {
    return { ok: false, error: "אין נתוני נוכחות לחודש זה" };
  }

  // Look up names for every employee_id that appeared in events.
  const { data: empRows } = await supabase
    .from("employees")
    .select("id, name")
    .in("id", [...empIds]);
  const nameById = new Map<string, string>();
  for (const e of empRows ?? []) nameById.set(e.id, e.name);

  // Group events by (empId, israel-date).
  const eventsByEmp = new Map<string, Map<string, any[]>>();
  for (const ev of events ?? []) {
    const empMap = eventsByEmp.get(ev.employee_id) ?? new Map<string, any[]>();
    const date = israelDateOf(ev.event_at);
    const dayList = empMap.get(date) ?? [];
    dayList.push(ev);
    empMap.set(date, dayList);
    eventsByEmp.set(ev.employee_id, empMap);
  }

  // Build workbook.
  const wb = XLSX.utils.book_new();
  const usedNames = new Set<string>();
  const sortedEmpIds = [...empIds].sort((a, b) => {
    const na = nameById.get(a) ?? a;
    const nb = nameById.get(b) ?? b;
    return na.localeCompare(nb, "he");
  });
  for (const empId of sortedEmpIds) {
    const empName = nameById.get(empId) ?? "Unknown";
    const ws = buildEmployeeSheet(empName, days, eventsByEmp.get(empId) ?? new Map());
    XLSX.utils.book_append_sheet(wb, ws, safeSheetName(empName, usedNames));
  }

  // SheetJS produces a base64 string directly when asked. Avoids the
  // Uint8Array → binary-string → btoa dance which was producing an empty
  // "content" field that Resend rejected with "invalid_attachment".
  const base64 = XLSX.write(wb, { type: "base64", bookType: "xlsx" }) as string;

  const filename = `attendance_${yearMonth}.xlsx`;
  const subject  = `דו״ח נוכחות — ${yearMonth}`;
  const html = `
    <div dir="rtl" style="font-family: sans-serif; font-size: 14px; color: #333;">
      <p>שלום,</p>
      <p>מצורף דו״ח נוכחות עבור חודש <b>${yearMonth}</b>, גיליון נפרד לכל עובד.</p>
      <p>תודה,<br>מינוטו קפה</p>
    </div>
  `;

  if (!RESEND_KEY) {
    return { ok: false, error: "RESEND_API_KEY not configured" };
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: `Minuto <${SENDER_EMAIL}>`,
      to: [to],
      subject,
      html,
      attachments: [{ filename, content: base64 }],
    }),
  });

  if (!res.ok) {
    const t = await res.text();
    return { ok: false, error: `Resend ${res.status}: ${t.slice(0, 300)}` };
  }
  const body = await res.json();
  return {
    ok: true,
    sent_to: to,
    year_month: yearMonth,
    employee_count: empIds.size,
    resend_id: body?.id ?? "",
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  try {
    let yearMonth = lastMonthYM();
    if (req.method === "POST") {
      try {
        const body = await req.json();
        if (typeof body?.year_month === "string" && /^\d{4}-\d{2}$/.test(body.year_month)) {
          yearMonth = body.year_month;
        }
      } catch { /* empty body OK */ }
    }
    const result = await buildAndSend(yearMonth);
    return new Response(JSON.stringify(result), {
      status: result.ok ? 200 : 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: any) {
    console.error("attendance-export error:", err);
    return new Response(JSON.stringify({ ok: false, error: err?.message ?? String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
