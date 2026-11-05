// Our Google keyword research, for the blog keyword gate
// (_shared/blog_keyword_gate.ts): Search Console queries (last 90 days,
// aggregated per query) and the Google Ads keywords we bid on (keyword_ideas,
// filled by google-sync; avg_monthly_searches there is ad impressions).
// Read-only. Both tables are synced twice a day.

import { blogResearchProblems, cannibalVerdict, indexResearch, normKeyword, type ResearchKeyword } from './blog_keyword_gate.ts'
import type { CannibalizationResult } from '../seo-agent/cannibalizationCheck.ts'
import { selectAll } from './select_all.ts'

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
  // Paged: one PostgREST response stops at 1,000 rows whatever .limit() says,
  // and these rows are summed, so a single request gave arbitrary totals.
  const [gscRows, adsRows] = await Promise.all([
    selectAll<Record<string, unknown>>((from, to) =>
      supabase.from('google_search_console').select('keyword, page, impressions, clicks, position, date')
        .neq('keyword', '__page__').gte('date', since).order('id').range(from, to), { label: 'google_search_console read' }),
    selectAll<Record<string, unknown>>((from, to) =>
      supabase.from('keyword_ideas').select('keyword, avg_monthly_searches, synced_at').order('keyword').range(from, to), { label: 'keyword_ideas read' }),
  ])
  const adsResearch: ResearchKeyword[] = adsRows
    .filter(r => typeof r.keyword === 'string' && r.keyword.trim())
    .map(r => ({ source: 'google_ads' as const, keyword: String(r.keyword).trim(), impressions: Number(r.avg_monthly_searches) || 0 }))
    .sort((x, y) => y.impressions - x.impressions)
  const maxOf = (rows: Array<Record<string, unknown>>, k: string) =>
    rows.reduce<string | null>((m, r) => (typeof r[k] === 'string' && (!m || (r[k] as string) > m) ? r[k] as string : m), null)
  return { rows: [...aggregateGsc(gscRows), ...adsResearch], gsc_as_of: maxOf(gscRows, 'date'), ads_as_of: maxOf(adsRows, 'synced_at') }
}

/** The full live gate for one blog keyword: research grounding + strict
 *  cannibalization (WordPress posts + Search Console ranking page). Shared by
 *  the executor (before drafting) and the critic (as context). `cannibal`
 *  injects the WordPress check (checkCannibalizationForQueue) for testing. */
export async function checkBlogKeywordLive(
  supabase: Db,
  params: Record<string, unknown> | undefined,
  title: string,
  cannibal: (keyword: string, title: string) => Promise<CannibalizationResult>,
): Promise<{ ok: boolean; reason: string; conflicts: Array<{ title: string; link: string; status: string }> }> {
  const research = await fetchKeywordResearch(supabase)
  const index = indexResearch(research.rows)
  const grounded = blogResearchProblems(params, index)
  if (grounded.length) return { ok: false, reason: grounded.join('; '), conflicts: [] }
  const kw = String(params?.keyword)
  const v = cannibalVerdict(await cannibal(kw, title), index.get(`search_console|${normKeyword(kw)}`)?.ranking_page)
  return { ok: !v.block, reason: v.reason, conflicts: v.conflicts }
}
