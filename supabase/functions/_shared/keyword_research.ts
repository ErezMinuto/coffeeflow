// Our Google keyword research, for the blog keyword gate
// (_shared/blog_keyword_gate.ts): Search Console queries (last 90 days,
// aggregated per query) and the Google Ads keywords we bid on (keyword_ideas,
// filled by google-sync; avg_monthly_searches there is ad impressions).
// Read-only. Both tables are synced twice a day.

import type { ResearchKeyword } from './blog_keyword_gate.ts'

// deno-lint-ignore no-explicit-any
type Db = { from(table: string): any }

const r1 = (n: number) => Math.round(n * 10) / 10

/** Pure: aggregate daily GSC rows (keyword, page, impressions, clicks, position)
 *  per keyword. Position is impression-weighted; ranking_page = the page with
 *  the most impressions for that keyword. */
export function aggregateGsc(rows: Array<Record<string, unknown>>): ResearchKeyword[] {
  const by = new Map<string, { keyword: string; imp: number; clicks: number; posW: number; pages: Map<string, number> }>()
  for (const r of rows) {
    const kw = typeof r.keyword === 'string' ? r.keyword.trim() : ''
    if (!kw) continue
    const imp = Number(r.impressions) || 0
    const a = by.get(kw) ?? { keyword: kw, imp: 0, clicks: 0, posW: 0, pages: new Map<string, number>() }
    a.imp += imp
    a.clicks += Number(r.clicks) || 0
    a.posW += (Number(r.position) || 0) * imp
    if (typeof r.page === 'string' && r.page) a.pages.set(r.page, (a.pages.get(r.page) ?? 0) + imp)
    by.set(kw, a)
  }
  return [...by.values()].map(a => ({
    source: 'search_console' as const,
    keyword: a.keyword,
    impressions: a.imp,
    clicks: a.clicks,
    position: a.imp > 0 ? r1(a.posW / a.imp) : null,
    ranking_page: [...a.pages.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? null,
  })).sort((x, y) => y.impressions - x.impressions)
}

export interface KeywordResearch {
  rows:          ResearchKeyword[]
  gsc_as_of:     string | null
  ads_as_of:     string | null
}

export async function fetchKeywordResearch(supabase: Db, days = 90): Promise<KeywordResearch> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)
  const [gsc, ads] = await Promise.all([
    supabase.from('google_search_console').select('keyword, page, impressions, clicks, position, date')
      .gte('date', since).order('date', { ascending: false }).limit(20_000),
    supabase.from('keyword_ideas').select('keyword, avg_monthly_searches, synced_at').limit(2_000),
  ])
  if (gsc.error) throw new Error(`google_search_console read failed: ${gsc.error.message}`)
  if (ads.error) throw new Error(`keyword_ideas read failed: ${ads.error.message}`)
  const gscRows = (gsc.data ?? []) as Array<Record<string, unknown>>
  const adsRows = (ads.data ?? []) as Array<Record<string, unknown>>
  const adsResearch: ResearchKeyword[] = adsRows
    .filter(r => typeof r.keyword === 'string' && r.keyword.trim())
    .map(r => ({ source: 'google_ads' as const, keyword: String(r.keyword).trim(), impressions: Number(r.avg_monthly_searches) || 0 }))
    .sort((x, y) => y.impressions - x.impressions)
  const maxOf = (rows: Array<Record<string, unknown>>, k: string) =>
    rows.reduce<string | null>((m, r) => (typeof r[k] === 'string' && (!m || (r[k] as string) > m) ? r[k] as string : m), null)
  return { rows: [...aggregateGsc(gscRows), ...adsResearch], gsc_as_of: maxOf(gscRows, 'date'), ads_as_of: maxOf(adsRows, 'synced_at') }
}
