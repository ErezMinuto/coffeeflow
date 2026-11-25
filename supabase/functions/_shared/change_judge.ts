// Phase 3: judging a live site change against what it was expected to do.
// Pure (no I/O); tested in change_judge_test.ts.

export interface PageStats { clicks: number; impressions: number; position: number | null }
export type Verdict = 'win' | 'loss' | 'neutral' | 'too_little_data'

/** The date a change should be judged: its "Check on: YYYY-MM-DD" line, else 28 days after it went live. */
export function checkDate(reason: string | null | undefined, appliedAt: string): string {
  const m = /Check on:\s*(\d{4}-\d{2}-\d{2})/.exec(reason ?? '')
  if (m) return m[1]
  return new Date(Date.parse(appliedAt) + 28 * 864e5).toISOString().slice(0, 10)
}

/** Clicks, impressions and impression-weighted position of one page in a Search Console window. */
export function pageStats(rows: ReadonlyArray<{ page: string; clicks: number; impressions: number; position: number }>, key: string, keyOf: (url: string) => string): PageStats {
  let clicks = 0, impressions = 0, pos = 0
  for (const r of rows) {
    if (keyOf(r.page) !== key) continue
    clicks += Number(r.clicks) || 0; impressions += Number(r.impressions) || 0; pos += (Number(r.position) || 0) * (Number(r.impressions) || 0)
  }
  return { clicks, impressions, position: impressions ? Math.round((pos / impressions) * 10) / 10 : null }
}

/** Every page's stats in one pass over a window (key → stats), for many lookups. */
export function pageStatsIndex(rows: ReadonlyArray<{ page: string; clicks: number; impressions: number; position: number }>, keyOf: (url: string) => string): Map<string, PageStats> {
  const acc = new Map<string, { clicks: number; impressions: number; pos: number }>()
  for (const r of rows) {
    const k = keyOf(r.page); const a = acc.get(k) ?? { clicks: 0, impressions: 0, pos: 0 }
    const imp = Number(r.impressions) || 0
    a.clicks += Number(r.clicks) || 0; a.impressions += imp; a.pos += (Number(r.position) || 0) * imp
    acc.set(k, a)
  }
  const out = new Map<string, PageStats>()
  for (const [k, a] of acc) out.set(k, { clicks: a.clicks, impressions: a.impressions, position: a.impressions ? Math.round((a.pos / a.impressions) * 10) / 10 : null })
  return out
}
const EMPTY: PageStats = { clicks: 0, impressions: 0, position: null }
/** One page's stats from an index (zeros when Search Console has no rows for it). */
export const statsFor = (idx: ReadonlyMap<string, PageStats>, key: string): PageStats => idx.get(key) ?? EMPTY

/** Several pages as one (a merge: the page kept plus the page redirected into it). Position weighted by impressions. */
export function combineStats(parts: ReadonlyArray<PageStats>): PageStats {
  let clicks = 0, impressions = 0, pos = 0, posImp = 0
  for (const p of parts) {
    clicks += p.clicks; impressions += p.impressions
    if (p.position != null) { pos += p.position * p.impressions; posImp += p.impressions }
  }
  return { clicks, impressions, position: posImp > 0 ? Math.round((pos / posImp) * 10) / 10 : null }
}

export interface Judgement { verdict: Verdict; expected_clicks: number; click_delta: number; site_factor: number; note: string }

/**
 * Before vs after for one page, adjusted for the whole site's trend: the
 * clicks the page "should" have had after = its clicks before × the site's
 * click change, so a seasonal rise or dip is not credited to the change.
 *   too_little_data  under 100 impressions across both windows
 *   win              at least max(5, 20%) clicks above that expectation
 *   loss             at least max(5, 20%) clicks below it, or 3+ positions worse
 *                    on similar impressions
 *   neutral          otherwise
 */
export function judge(before: PageStats, after: PageStats, siteBefore: number, siteAfter: number): Judgement {
  const factor = siteBefore > 0 ? Math.min(2, Math.max(0.5, siteAfter / siteBefore)) : 1
  const expected = Math.round(before.clicks * factor * 10) / 10
  const delta = Math.round((after.clicks - expected) * 10) / 10
  const margin = Math.max(5, expected * 0.2)
  const base = { expected_clicks: expected, click_delta: delta, site_factor: Math.round(factor * 100) / 100 }
  if (before.impressions + after.impressions < 100) return { verdict: 'too_little_data', ...base, note: `${before.impressions + after.impressions} impressions across both windows (under 100)` }
  const posWorse = before.position != null && after.position != null && after.position - before.position >= 3 && after.impressions >= before.impressions * 0.5
  if (delta <= -margin || posWorse) {
    return { verdict: 'loss', ...base, note: posWorse && delta > -margin ? `position ${before.position} → ${after.position}` : `${after.clicks} clicks vs ~${expected} expected` }
  }
  if (delta >= margin) return { verdict: 'win', ...base, note: `${after.clicks} clicks vs ~${expected} expected` }
  return { verdict: 'neutral', ...base, note: `${after.clicks} clicks vs ~${expected} expected (within ±${Math.round(margin)})` }
}
