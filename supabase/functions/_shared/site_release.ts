// The weekly release: when it is due, and which queued changes go out.
// Pure (no I/O); tested in site_release_test.ts.

export interface ReleaseSettings { enabled: boolean; weekday: number; hour: number; tz: string }

/** ops_profile 'seo_weekly_release' → settings. Anything missing or odd → switched off, Sunday 10:00 Israel. */
export function releaseSettings(v: unknown): ReleaseSettings {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const int = (x: unknown, lo: number, hi: number, d: number) => (Number.isInteger(x) && (x as number) >= lo && (x as number) <= hi ? x as number : d)
  return {
    enabled: o.enabled === true,
    weekday: int(o.weekday, 0, 6, 0),
    hour: int(o.hour, 0, 23, 10),
    tz: typeof o.tz === 'string' && o.tz ? o.tz : 'Asia/Jerusalem',
  }
}

/** The local date (YYYY-MM-DD), weekday (0 = Sunday) and hour in a time zone. */
export function localNow(now: Date, tz: string): { date: string; weekday: number; hour: number } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', weekday: 'short' })
    .formatToParts(now).map((p) => [p.type, p.value]))
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday)
  return { date: `${parts.year}-${parts.month}-${parts.day}`, weekday, hour: Number(parts.hour) }
}

/** The release date if a release is due now (right weekday, at or after the hour), else null. */
export function releaseDue(now: Date, s: ReleaseSettings): string | null {
  if (!s.enabled) return null
  const l = localNow(now, s.tz)
  return l.weekday === s.weekday && l.hour >= s.hour ? l.date : null
}

/**
 * The page a change touches. Posts, pages and products share one WordPress id
 * space, so every post or product field of the same id is the same page;
 * product categories are terms, a separate id space.
 */
export function pageKey(targetType: string, targetId: number): string {
  return (targetType === 'term_seo_meta' || targetType === 'term_description' ? 'term:' : 'post:') + targetId
}

export interface QueuedChange { id: string; target_type: string; target_id: number; approved_at: string | null; bundle_id?: string | null; bundle_seq?: number | null }

/**
 * One change per page, oldest approval first; the rest wait for the next
 * release. The steps of a merge (same bundle_id) are one unit: they go out
 * together, in bundle_seq order, or all wait (a merge may touch the same page
 * twice: the redirect and the status of the post it retires).
 */
export function pickRelease<T extends QueuedChange>(queued: readonly T[]): { publish: T[]; defer: T[] } {
  const units = new Map<string, T[]>()
  for (const c of queued) {
    const k = c.bundle_id ? `bundle:${c.bundle_id}` : `change:${c.id}`
    units.set(k, [...(units.get(k) ?? []), c])
  }
  const first = (u: T[]) => u.reduce((m, c) => (String(c.approved_at ?? '') < m ? String(c.approved_at ?? '') : m), String(u[0].approved_at ?? ''))
  const ordered = [...units.values()]
    .map((u) => [...u].sort((a, b) => Number(a.bundle_seq ?? 0) - Number(b.bundle_seq ?? 0)))
    .sort((a, b) => first(a).localeCompare(first(b)) || a[0].id.localeCompare(b[0].id))
  const seen = new Set<string>(), publish: T[] = [], defer: T[] = []
  for (const u of ordered) {
    const keys = new Set(u.map((c) => pageKey(c.target_type, c.target_id)))
    if ([...keys].some((k) => seen.has(k))) { defer.push(...u); continue }
    keys.forEach((k) => seen.add(k)); publish.push(...u)
  }
  return { publish, defer }
}
