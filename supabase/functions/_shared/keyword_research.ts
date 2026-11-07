// Our Google keyword research, for the blog keyword gate
// (_shared/blog_keyword_gate.ts): Search Console queries (last 90 days,
// aggregated per query) and the Google Ads keywords we bid on (keyword_ideas,
// filled by google-sync; avg_monthly_searches there is ad impressions).
// Read-only. Both tables are synced twice a day.

import { blogResearchProblems, cannibalVerdict, indexResearch, normKeyword, type ResearchKeyword } from './blog_keyword_gate.ts'
import type { CannibalizationResult } from '../seo-agent/cannibalizationCheck.ts'
import { selectAll } from './select_all.ts'
import { fetchGscKeywordTotals, type GscKeywordTotal } from './gsc_totals.ts'

// deno-lint-ignore no-explicit-any
type Db = { from(table: string): any; rpc(fn: string, args: Record<string, unknown>): any }

const r1 = (n: number) => Math.round(n * 10) / 10

/** Pure: Search Console keyword totals → research rows, most impressions
 *  first. ranking_page stays null: the sync stores keyword rows without a page
 *  (query+page is not fetched), so Search Console cannot name the ranking URL;
 *  the WordPress check in checkBlogKeywordLive covers existing posts. */
export function gscResearch(totals: GscKeywordTotal[]): ResearchKeyword[] {
  return totals
    .filter(t => t.keyword.trim())
    .map(t => ({
      source: 'search_console' as const,
      keyword: t.keyword.trim(),
      impressions: t.impressions,
      clicks: t.clicks,
      position: t.impressions > 0 ? r1(t.position) : null,
      ranking_page: null,
    }))
    .sort((x, y) => y.impressions - x.impressions)
}

export interface KeywordResearch {
  rows:          ResearchKeyword[]
  gsc_as_of:     string | null
  ads_as_of:     string | null
}

export async function fetchKeywordResearch(supabase: Db, days = 90): Promise<KeywordResearch> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)
  // Search Console totals are summed in the database (gsc_keyword_totals);
  // keyword_ideas is paged because one response stops at 1,000 rows.
  const [gscTotals, adsRows] = await Promise.all([
    fetchGscKeywordTotals(supabase, since),
    selectAll<Record<string, unknown>>((from, to) =>
      supabase.from('keyword_ideas').select('keyword, avg_monthly_searches, synced_at').order('keyword').range(from, to), { label: 'keyword_ideas read' }),
  ])
  const adsResearch: ResearchKeyword[] = adsRows
    .filter(r => typeof r.keyword === 'string' && r.keyword.trim())
    .map(r => ({ source: 'google_ads' as const, keyword: String(r.keyword).trim(), impressions: Number(r.avg_monthly_searches) || 0 }))
    .sort((x, y) => y.impressions - x.impressions)
  const maxOf = (rows: Array<Record<string, unknown>>, k: string) =>
    rows.reduce<string | null>((m, r) => (typeof r[k] === 'string' && (!m || (r[k] as string) > m) ? r[k] as string : m), null)
  const gscAsOf = gscTotals.reduce<string | null>((m, t) => (t.last_date && (!m || t.last_date > m) ? t.last_date : m), null)
  return { rows: [...gscResearch(gscTotals), ...adsResearch], gsc_as_of: gscAsOf, ads_as_of: maxOf(adsRows, 'synced_at') }
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
