// Forward-looking monthly budget guard for paid-ad DRAFTS (meta-ads-draft,
// google-ads-draft). Pure: callers fetch the numbers, this decides.
//
// The old guard only looked backwards (month-to-date spend + drafts created
// this month). It ignored what RUNNING campaigns will still spend this month,
// and a big campaign created on the 31st could blow next month's cap. Two
// checks, both must pass (plan docs/plans/2026-11-02-strategist-closed-loop.md A7):
//
//  (a) month:    MTD spend
//              + Σ active daily × days left
//              + Σ committed draft daily × min(its duration, days left)
//              + new daily × min(new duration, days left)          ≤ monthly cap
//  (b) run-rate: Σ active daily + Σ committed draft daily + new daily
//                                                                  ≤ monthly cap / 30
//
// "Committed" = PAUSED drafts that still exist, are not active and were not
// dismissed: Erez may activate any of them, so each counts as if it will run.
// A draft that has gone active is counted once, as active, never twice
// (callers exclude it from `committed`).
//
// Drafts are always created PAUSED and only Erez activates them; this guard
// keeps the queue of drafts he is offered inside the budget he set.

export interface BudgetInputs {
  mtdSpend:          number     // actual spend this month (platform-reported)
  activeDaily:       number[]   // daily budget of each currently ACTIVE campaign
  committedDrafts:   Array<{ daily: number; durationDays: number }>
  newDaily:          number
  newDurationDays:   number
  monthlyCap:        number
  now?:              Date       // for tests; defaults to now
  timeZone?:         string     // ad-account timezone for month boundaries
}

export interface BudgetVerdict {
  ok:             boolean
  daysLeft:       number
  monthProjected: number
  runRate:        number
  runRateCap:     number
  reasons:        string[]
}

const r2 = (n: number) => Math.round(n * 100) / 100

/** Days left in the current month INCLUDING today, in the given time zone. */
export function daysLeftInMonth(now: Date, timeZone = 'Asia/Jerusalem'): number {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(now)
  const get = (t: string) => Number(parts.find(p => p.type === t)?.value)
  const y = get('year'), m = get('month'), d = get('day')
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return daysInMonth - d + 1
}

/** Every number must be finite and >= 0; anything else fails closed. Only a
 *  real number or a non-empty numeric string counts (Postgres numeric columns
 *  arrive as strings): Number(null) / Number('') / Number(false) / Number([])
 *  are all 0, and a missing budget must never read as ₪0. */
function clean(n: unknown): number | null {
  let v: number
  if (typeof n === 'number') v = n
  else if (typeof n === 'string' && n.trim() !== '' && /^-?\d+(\.\d+)?$/.test(n.trim())) v = Number(n)
  else return null
  return Number.isFinite(v) && v >= 0 ? v : null
}

export function checkForwardBudget(input: BudgetInputs): BudgetVerdict {
  const reasons: string[] = []
  const cap = clean(input.monthlyCap)
  const mtd = clean(input.mtdSpend)
  const newDaily = clean(input.newDaily)
  const newDur = clean(input.newDurationDays)
  const active = (input.activeDaily ?? []).map(clean)
  const committed = (input.committedDrafts ?? []).map(c => ({ daily: clean(c?.daily), dur: clean(c?.durationDays) }))
  const daysLeft = daysLeftInMonth(input.now ?? new Date(), input.timeZone)

  if (cap === null || cap === 0 || mtd === null || newDaily === null || newDur === null || newDur < 1
      || active.some(v => v === null) || committed.some(c => c.daily === null || c.dur === null)) {
    return { ok: false, daysLeft, monthProjected: NaN, runRate: NaN, runRateCap: NaN,
      reasons: ['budget inputs missing or invalid: refusing rather than guessing'] }
  }

  const activeSum = (active as number[]).reduce((s, v) => s + v, 0)
  const committedSum = committed.reduce((s, c) => s + (c.daily as number), 0)
  const committedMonth = committed.reduce((s, c) => s + (c.daily as number) * Math.min(Math.max(1, c.dur as number), daysLeft), 0)
  const monthProjected = mtd + activeSum * daysLeft + committedMonth + newDaily * Math.min(newDur, daysLeft)
  const runRate = activeSum + committedSum + newDaily
  const runRateCap = cap / 30

  if (monthProjected > cap) {
    reasons.push(`month: ₪${r2(mtd)} spent + ₪${r2(activeSum)}/day active × ${daysLeft}d + ₪${r2(committedMonth)} queued drafts + this draft ₪${r2(newDaily * Math.min(newDur, daysLeft))} = ₪${r2(monthProjected)} > cap ₪${r2(cap)}`)
  }
  if (runRate > runRateCap) {
    reasons.push(`run-rate: ₪${r2(activeSum)}/day active + ₪${r2(committedSum)}/day queued drafts + ₪${r2(newDaily)}/day this draft = ₪${r2(runRate)}/day > ₪${r2(runRateCap)}/day (cap ÷ 30)`)
  }
  return { ok: reasons.length === 0, daysLeft, monthProjected: r2(monthProjected), runRate: r2(runRate), runRateCap: r2(runRateCap), reasons }
}
