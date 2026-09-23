// Minuto SEO Agent — temporal context.
//
// WHY: neither planner knew what day it was. Checked 2026-09-23 — the
// orchestrator's user message and the mission-worker's system prompt contain
// no date, no month, no season and no holiday calendar. Every window handed
// to the model was RELATIVE ("last 30 days", "published in last 7 days"), so
// the strategist had no way to locate itself in the year. It was not
// declining to plan around Sukkot or around the end of iced-coffee season —
// it could not, because nothing in its context said when "now" was.
//
// This module supplies that as FACTS ONLY: today's date in Israel, the month,
// the season, and the upcoming holidays with how many days out they are. It
// deliberately does NOT suggest what to write. Per the admin's standing
// preference, prompt scaffolding that feeds the agent ideas ("e.g. try a
// seasonal hook") makes it an automation rather than an autonomous planner —
// data in, judgment left to the model.
//
// Holiday dates come from Hebcal's public API (Israel schedule) rather than a
// hardcoded table, so they stay correct in future years without a redeploy.
// Every failure path degrades to "date + season, no holiday list" — the
// calendar is never allowed to take a planning cycle down.

const HEBCAL_ENDPOINT = 'https://www.hebcal.com/hebcal'
const ISRAEL_TZ = 'Asia/Jerusalem'

export interface UpcomingHoliday {
  title:    string   // English title, e.g. "Sukkot I"
  hebrew:   string   // Hebrew title, e.g. "סוכות יום א׳"
  date:     string   // YYYY-MM-DD
  daysAway: number
}

export interface CalendarContext {
  todayIso:  string            // YYYY-MM-DD, Israel time
  weekday:   string            // e.g. "Wednesday"
  month:     string            // e.g. "September"
  season:    string            // e.g. "autumn"
  holidays:  UpcomingHoliday[]
  /** Set when the holiday lookup failed — the block still renders without it. */
  holidayError?: string
}

// Today in Israel, not in UTC. Edge functions run in UTC and the daily story
// is queued around midnight, so a UTC date can name yesterday locally.
function israelToday(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: ISRAEL_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now)
}

function israelPart(now: Date, opts: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: ISRAEL_TZ, ...opts }).format(now)
}

// Meteorological seasons, northern hemisphere. Israel's practical coffee year
// tracks these closely enough — the point is only to tell the model where in
// the year it is, not to prescribe anything from it.
function seasonFor(monthIndex1to12: number): string {
  if (monthIndex1to12 >= 3  && monthIndex1to12 <= 5)  return 'spring'
  if (monthIndex1to12 >= 6  && monthIndex1to12 <= 8)  return 'summer'
  if (monthIndex1to12 >= 9  && monthIndex1to12 <= 11) return 'autumn'
  return 'winter'
}

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function daysBetweenIso(fromIso: string, toIso: string): number {
  const a = Date.parse(`${fromIso}T00:00:00Z`)
  const b = Date.parse(`${toIso}T00:00:00Z`)
  return Math.round((b - a) / 86_400_000)
}

async function fetchHolidays(todayIso: string, lookaheadDays: number): Promise<UpcomingHoliday[]> {
  const params = new URLSearchParams({
    v: '1', cfg: 'json',
    maj: 'on',    // major holidays
    min: 'on',    // minor holidays
    mod: 'on',    // modern Israeli national days
    nx:  'off',   // no Rosh Chodesh
    ss:  'off',   // no special Shabbatot
    mf:  'off',   // no minor fasts
    i:   'on',    // Israel schedule (one day of Yom Tov, not two)
    // Default language: `title` comes back in English, `hebrew` carries the
    // Hebrew name. Passing lg=he would make both fields Hebrew and lose the
    // English one, so it is deliberately omitted.
    start: todayIso,
    end:   addDaysIso(todayIso, lookaheadDays),
  })

  // Hebcal is a third party on the critical path of a planning cycle, so it
  // gets a short leash: 8s, then we plan without it.
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 8_000)
  try {
    const res = await fetch(`${HEBCAL_ENDPOINT}?${params}`, { signal: ctrl.signal })
    if (!res.ok) throw new Error(`hebcal HTTP ${res.status}`)
    const body = await res.json() as { items?: Array<Record<string, unknown>> }
    return (body.items ?? [])
      .filter(it => String(it.category ?? '') === 'holiday')
      .map(it => {
        const date = String(it.date ?? '').slice(0, 10)
        return {
          title:    String(it.title ?? ''),
          hebrew:   String(it.hebrew ?? ''),
          date,
          daysAway: daysBetweenIso(todayIso, date),
        }
      })
      .filter(h => h.date && h.daysAway >= 0)
      .sort((a, b) => a.daysAway - b.daysAway)
  } finally {
    clearTimeout(timer)
  }
}

export async function getCalendarContext(
  opts: { now?: Date; lookaheadDays?: number } = {},
): Promise<CalendarContext> {
  const now      = opts.now ?? new Date()
  const todayIso = israelToday(now)
  const monthNum = Number(todayIso.slice(5, 7))

  const base: CalendarContext = {
    todayIso,
    weekday: israelPart(now, { weekday: 'long' }),
    month:   israelPart(now, { month: 'long' }),
    season:  seasonFor(monthNum),
    holidays: [],
  }

  try {
    base.holidays = await fetchHolidays(todayIso, opts.lookaheadDays ?? 75)
  } catch (e) {
    // Fail open. A calendar outage costs us the holiday list, never the cycle.
    base.holidayError = (e as Error)?.message ?? String(e)
    console.warn(`[calendarContext] holiday lookup failed (non-fatal): ${base.holidayError}`)
  }

  return base
}

// Renders the block injected into planner prompts. Facts, no guidance.
export function renderCalendarBlock(ctx: CalendarContext): string {
  // A multi-day festival lands as one row per day (Sukkot alone is 8), which
  // would drown the rest of the block. Cap the list; the near dates are the
  // ones that matter for a two-week planning horizon.
  const MAX_ROWS = 10
  const shown = ctx.holidays.slice(0, MAX_ROWS)
  const more  = ctx.holidays.length - shown.length

  const holidayLines = shown.length > 0
    ? shown.map(h => {
        const when = h.daysAway === 0 ? 'TODAY'
          : h.daysAway === 1 ? 'tomorrow'
          : `in ${h.daysAway} days`
        return `  • ${h.date} (${when}) — ${h.title}${h.hebrew ? ` / ${h.hebrew}` : ''}`
      }).join('\n') + (more > 0 ? `\n  … and ${more} more in the lookahead window` : '')
    : ctx.holidayError
      ? `  (holiday calendar unavailable this cycle: ${ctx.holidayError})`
      : '  (no holidays in the lookahead window)'

  return `=== TODAY / CALENDAR (Israel) ===

Today is ${ctx.weekday}, ${ctx.todayIso}. Month: ${ctx.month}. Season: ${ctx.season}.

Upcoming Israeli / Jewish holidays:
${holidayLines}

This is factual context about where in the year you are. Nothing here obliges
you to make content seasonal or holiday-themed — weigh it against the demand
and performance data like any other signal.`
}
