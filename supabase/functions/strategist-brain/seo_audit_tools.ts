// SEO audit tools for the strategist (SEO agent build plan, Phase 1: "eyes").
// They read the weekly audit data (site crawl, Search Console per search +
// page, page speed, Google index status, GA4) and hand it to the pure
// analysis in seo_audit_analysis.ts. Read-only.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.116.0'
import { selectAll } from '../_shared/select_all.ts'
import {
  AUDIT_AREAS, CRAWL_ISSUES, SEARCH_VIEWS, coverage, crawlIssues, inlinkCounts, materialSignals, pageKey, pagesWithIssue,
  searchTotals, searchView, valuePerSession,
  type CoverageRow, type CrawlPage, type DataState, type QpRow, type SearchView, type Signal,
} from './seo_audit_analysis.ts'

const CRAWL_COLS = 'url, page_type, status, final_url, redirects, title, meta_description, h1, h1_count, canonical, robots_meta, x_robots_tag, word_count, schema_types, internal_links, images, images_missing_alt, response_ms'
const DAY = 864e5
const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10)

async function latestCrawl(supabase: SupabaseClient): Promise<{ id: string; finished_at: string; urls_total: number } | null> {
  const { data } = await supabase.from('site_crawls').select('id, finished_at, urls_total').eq('status', 'done')
    .order('finished_at', { ascending: false }).limit(1).maybeSingle()
  return (data as { id: string; finished_at: string; urls_total: number } | null) ?? null
}

async function crawlPages(supabase: SupabaseClient, crawlId: string): Promise<CrawlPage[]> {
  return await selectAll<CrawlPage>((from, to) => supabase.from('site_crawl_pages').select(CRAWL_COLS).eq('crawl_id', crawlId).order('url').range(from, to), { label: 'site_crawl_pages', maxRows: 10_000 })
}

async function queryPageWindows(supabase: SupabaseClient): Promise<{ end: string | null; cur: QpRow[]; prev: QpRow[] }> {
  const { data } = await supabase.from('gsc_query_page').select('period_end').eq('period_days', 28).order('period_end', { ascending: false }).limit(1).maybeSingle()
  const end = (data as { period_end: string } | null)?.period_end ?? null
  if (!end) return { end: null, cur: [], prev: [] }
  const prevEnd = isoDay(Date.parse(end) - 28 * DAY)
  const read = (e: string) => selectAll<QpRow>((from, to) => supabase.from('gsc_query_page').select('query, page, clicks, impressions, position').eq('period_days', 28).eq('period_end', e).order('query').order('page').range(from, to), { label: 'gsc_query_page', maxRows: 150_000 })
  const [cur, prev] = await Promise.all([read(end), read(prevEnd)])
  return { end, cur, prev }
}

async function organicSessionsByPage(supabase: SupabaseClient, days = 28): Promise<Map<string, { sessions: number; conversions: number }>> {
  const since = isoDay(Date.now() - days * DAY)
  const rows = await selectAll<{ page_path: string; sessions: number; conversions: number }>((from, to) =>
    supabase.from('ga4_pages_daily').select('page_path, sessions, conversions').eq('channel_group', 'Organic Search').gte('date', since).order('date').order('page_path').range(from, to), { label: 'ga4_pages_daily' })
  const out = new Map<string, { sessions: number; conversions: number }>()
  for (const r of rows) {
    const k = pageKey(r.page_path)
    const v = out.get(k) ?? { sessions: 0, conversions: 0 }
    v.sessions += r.sessions ?? 0; v.conversions += r.conversions ?? 0
    out.set(k, v)
  }
  return out
}

/** Web revenue per site session, last 28 days: the rough price of one extra visit. */
async function visitValue(supabase: SupabaseClient): Promise<{ value_per_session_ils: number | null; method: string }> {
  const since = isoDay(Date.now() - 28 * DAY)
  const [orders, sessions] = await Promise.all([
    selectAll<{ total: number }>((from, to) => supabase.from('woo_orders').select('total').in('status', ['completed', 'processing']).gte('order_date', since).order('order_date').range(from, to), { label: 'woo_orders' }),
    selectAll<{ sessions: number }>((from, to) => supabase.from('ga4_pages_daily').select('sessions').gte('date', since).order('date').order('page_path').range(from, to), { label: 'ga4_pages_daily' }),
  ])
  const revenue = orders.reduce((s, r) => s + Number(r.total ?? 0), 0)
  const visits = sessions.reduce((s, r) => s + Number(r.sessions ?? 0), 0)
  return {
    value_per_session_ils: valuePerSession(revenue, visits),
    method: 'web-shop revenue (Woo orders, completed+processing, incl. VAT) ÷ GA4 sessions across synced channels, last 28 days. Directional: use it to RANK findings (extra monthly visits × this), not as a forecast.',
  }
}

async function dataState(supabase: SupabaseClient): Promise<DataState> {
  const since = new Date(Date.now() - 8 * DAY).toISOString()
  const one = async (table: string, col: string, filter?: (q: any) => any) => {
    let q = supabase.from(table).select(col).order(col, { ascending: false }).limit(1)
    if (filter) q = filter(q)
    const { data } = await q.maybeSingle()
    return ((data as Record<string, string> | null)?.[col]) ?? null
  }
  const count = async (table: string, f: (q: any) => any) => {
    const { count } = await f(supabase.from(table).select('*', { count: 'exact', head: true }))
    return count ?? 0
  }
  const [crawl, qp, ga4, ads, ai, orders, speedOk, speedRefused, inspOk, inspFail] = await Promise.all([
    one('site_crawls', 'finished_at', (q) => q.eq('status', 'done')),
    one('gsc_query_page', 'period_end'),
    one('ga4_pages_daily', 'synced_at'),
    one('google_ads', 'synced_at').catch(() => null),
    one('ai_visibility_probes', 'ran_at').catch(() => null),
    one('woo_orders', 'synced_at'),
    count('page_speed', (q) => q.gte('measured_at', since).is('error', null)),
    count('page_speed', (q) => q.gte('measured_at', since).not('error', 'is', null)),
    count('gsc_url_inspection', (q) => q.gte('inspected_at', since).is('error', null)),
    count('gsc_url_inspection', (q) => q.gte('inspected_at', since).not('error', 'is', null)),
  ])
  return { crawl_finished_at: crawl, query_page_end: qp, ga4_synced_at: ga4, ads_synced_at: ads, ai_probe_at: ai, orders_synced_at: orders, speed_ok: speedOk, speed_refused: speedRefused, inspect_ok: inspOk, inspect_failed: inspFail }
}

/** What conclude_brief checks the audit against: the coverage map and the signals it must answer. */
export async function auditContext(supabase: SupabaseClient): Promise<{ coverage: CoverageRow[]; signals: Signal[] }> {
  const [state, d] = await Promise.all([dataState(supabase), auditData(supabase)])
  return { coverage: coverage(state), signals: materialSignals(d.pages, d.cur, d.prev) }
}

// ── One load per tick ───────────────────────────────────────────────────────
// The model often calls several of these tools in ONE step (e.g. opening the
// page list for 8 crawl issues before dismissing them). Each used to reload the
// whole crawl, Search Console and GA4; eight copies at once hit the edge
// worker's resource limit (546 WORKER_RESOURCE_LIMIT, run c0e8430f). The data
// only changes with the weekly job, so it is loaded once per invocation and
// shared by every tool call in it.

interface AuditData { crawl: { id: string; finished_at: string; urls_total: number } | null; crawlId: string | null; pages: CrawlPage[]; end: string | null; cur: QpRow[]; prev: QpRow[]; organic: Map<string, { sessions: number; conversions: number }> }
// Scoped to the request's own Supabase client (strategist-brain creates one
// per invocation): the shared data disappears with the tick, even if the tick
// throws, and two invocations never see each other's copy.
const cache = new WeakMap<SupabaseClient, Promise<AuditData>>()

/** Frees this tick's shared audit data early (it is released with the client anyway). */
export function clearAuditCache(supabase: SupabaseClient): void { cache.delete(supabase) }

/**
 * The audit data, loaded at most once per invocation. The promise is stored
 * the moment the load STARTS (synchronously), so calls made in parallel in
 * the same step all wait on that one load instead of starting their own.
 */
function auditData(supabase: SupabaseClient): Promise<AuditData> {
  const hit = cache.get(supabase)
  if (hit) return hit
  const data = (async (): Promise<AuditData> => {
    const crawl = await latestCrawl(supabase)
    const [pages, qp, organic] = await Promise.all([
      crawl ? crawlPages(supabase, crawl.id) : Promise.resolve([] as CrawlPage[]),
      queryPageWindows(supabase),
      organicSessionsByPage(supabase),
    ])
    return { crawl, crawlId: crawl?.id ?? null, pages, end: qp.end, cur: qp.cur, prev: qp.prev, organic }
  })()
  cache.set(supabase, data)
  // A failed load must not stay cached.
  data.catch(() => { if (cache.get(supabase) === data) cache.delete(supabase) })
  return data
}

/** Search clicks/impressions per page, computed once per Search Console window. */
type PageClicks = ReadonlyMap<string, { readonly clicks: number; readonly impressions: number }>
const clicksCache = new WeakMap<readonly QpRow[], PageClicks>()
export function clicksByPage(rows: readonly QpRow[]): PageClicks {
  const hit = clicksCache.get(rows)
  if (hit) return hit
  const m = new Map<string, { clicks: number; impressions: number }>()
  for (const r of rows) { const k = pageKey(r.page); const v = m.get(k) ?? { clicks: 0, impressions: 0 }; v.clicks += r.clicks; v.impressions += r.impressions; m.set(k, v) }
  clicksCache.set(rows, m)
  return m
}

// ── Tools ───────────────────────────────────────────────────────────────────

export async function getSeoAuditOverview(supabase: SupabaseClient) {
  const state = await dataState(supabase)
  const { crawl, pages, end, cur, prev } = await auditData(supabase)
  const since = new Date(Date.now() - 8 * DAY).toISOString()
  const [{ data: speed }, { data: insp }, value] = await Promise.all([
    supabase.from('page_speed').select('url, page_type, performance_score, lcp_ms, cls, tbt_ms, field_lcp_p75_ms, field_inp_p75_ms, field_cls_p75, field_category, error').gte('measured_at', since).order('measured_at', { ascending: false }).limit(12),
    supabase.from('gsc_url_inspection').select('url, verdict, coverage_state, google_canonical, user_canonical, error').gte('inspected_at', since).order('inspected_at', { ascending: false }).limit(120),
    visitValue(supabase).catch((e) => ({ value_per_session_ils: null, method: `unavailable: ${e instanceof Error ? e.message : String(e)}` })),
  ])
  const inspected = (insp ?? []) as Array<{ url: string; verdict: string | null; coverage_state: string | null; google_canonical: string | null; user_canonical: string | null; error: string | null }>
  const coverageStates: Record<string, number> = {}
  for (const r of inspected) if (!r.error) coverageStates[r.coverage_state ?? 'unknown'] = (coverageStates[r.coverage_state ?? 'unknown'] ?? 0) + 1

  // Search traffic per page type, so losses can be seen by type.
  const typeOf = new Map(pages.map((p) => [pageKey(p.final_url ?? p.url), p.page_type ?? 'other']))
  const byType: Record<string, { clicks: number; clicks_prev: number; impressions: number }> = {}
  for (const [rows, field] of [[cur, 'clicks'], [prev, 'clicks_prev']] as const) {
    for (const r of rows) {
      const t = typeOf.get(pageKey(r.page)) ?? 'not_in_crawl'
      byType[t] ??= { clicks: 0, clicks_prev: 0, impressions: 0 }
      byType[t][field] += r.clicks
      if (field === 'clicks') byType[t].impressions += r.impressions
    }
  }

  return {
    data_as_of: state,
    coverage: coverage(state),
    visit_value: value,
    crawl: crawl ? { finished_at: crawl.finished_at, pages: pages.length, ...crawlIssues(pages) } : { error: 'no finished crawl yet — the weekly job has not run' },
    search: end ? { window_end: end, window_days: 28, ...searchTotals(cur, prev), by_page_type: byType } : { error: 'no Search Console per search + page data yet' },
    page_speed: speed ?? [],
    index_status: { inspected: inspected.length, by_coverage_state: coverageStates, not_indexed: inspected.filter((r) => !r.error && r.verdict && r.verdict !== 'PASS').slice(0, 20), canonical_mismatch: inspected.filter((r) => r.google_canonical && r.user_canonical && pageKey(r.google_canonical) !== pageKey(r.user_canonical)).slice(0, 20) },
    // Every one of these must be answered in seo_audit: inside a finding's
    // signals[] or in dismissed_signals with a reason. conclude_brief refuses otherwise.
    signals_to_address: materialSignals(pages, cur, prev),
    issue_ids: CRAWL_ISSUES.map((d) => d.id),
    search_views: SEARCH_VIEWS,
  }
}

export async function getSeoIssuePages(supabase: SupabaseClient, input: { issue?: string; page_type?: string; limit?: number }) {
  const issue = String(input?.issue ?? '')
  if (!CRAWL_ISSUES.some((d) => d.id === issue)) return { error: `unknown issue; one of: ${CRAWL_ISSUES.map((d) => d.id).join(', ')}` }
  const { crawlId, pages, cur, organic } = await auditData(supabase)
  if (!crawlId) return { error: 'no finished crawl yet' }
  const limit = Math.min(Math.max(Math.trunc(Number(input?.limit ?? 30)) || 30, 1), 100)
  const clicks = clicksByPage(cur)
  let hit = pagesWithIssue(pages, issue)
  if (input?.page_type) hit = hit.filter((p) => p.page_type === input.page_type)
  const rows = hit.map((p) => {
    const k = pageKey(p.final_url ?? p.url)
    return {
      url: p.url, page_type: p.page_type, status: p.status, title: p.title, title_length: (p.title ?? '').length,
      meta_description_length: (p.meta_description ?? '').length, h1: p.h1, word_count: p.word_count, canonical: p.canonical,
      search_clicks_28d: clicks.get(k)?.clicks ?? 0, search_impressions_28d: clicks.get(k)?.impressions ?? 0,
      organic_sessions_28d: organic.get(k)?.sessions ?? 0,
    }
  }).sort((a, b) => (b.organic_sessions_28d - a.organic_sessions_28d) || (b.search_impressions_28d - a.search_impressions_28d))
  return { issue, label: CRAWL_ISSUES.find((d) => d.id === issue)!.label, total: rows.length, pages: rows.slice(0, limit), sorted_by: 'organic sessions, then search impressions (money first)' }
}

export async function getSearchPageMap(supabase: SupabaseClient, input: { view?: string; limit?: number }) {
  const view = String(input?.view ?? '') as SearchView
  if (!SEARCH_VIEWS.includes(view)) return { error: `view must be one of: ${SEARCH_VIEWS.join(', ')}` }
  const limit = Math.min(Math.max(Math.trunc(Number(input?.limit ?? 25)) || 25, 1), 60)
  const { end, cur, prev } = await auditData(supabase)
  if (!end) return { error: 'no Search Console per search + page data yet' }
  return { view, window_end: end, window_days: 28, rows: searchView(view, cur, prev, limit) }
}

export async function getPageReport(supabase: SupabaseClient, input: { url?: string }) {
  const key = pageKey(String(input?.url ?? ''))
  if (!input?.url) return { error: 'url required' }
  const { crawlId, pages, end, cur, prev, organic: organicMap } = await auditData(supabase)
  const page = pages.find((p) => pageKey(p.final_url ?? p.url) === key || pageKey(p.url) === key) ?? null
  const inlinks = inlinkCounts(pages).get(key) ?? 0
  const mine = (rows: QpRow[]) => rows.filter((r) => pageKey(r.page) === key).sort((a, b) => b.impressions - a.impressions)
  const organic = organicMap.get(key) ?? { sessions: 0, conversions: 0 }
  const { data: insp } = await supabase.from('gsc_url_inspection').select('url, inspected_at, verdict, coverage_state, indexing_state, google_canonical, user_canonical, last_crawl_time, rich_results, error').order('inspected_at', { ascending: false }).limit(300)
  const inspection = ((insp ?? []) as Array<Record<string, unknown>>).find((r) => pageKey(String(r.url ?? '')) === key) ?? null
  return {
    page: key,
    crawl: page ? { ...page, internal_links: (page.internal_links ?? []).length, inlinks_from_other_pages: inlinks } : { error: crawlId ? 'not in the latest crawl (not in the sitemap?)' : 'no crawl yet' },
    search: end ? { window_end: end, queries_now: mine(cur).slice(0, 25), queries_previous: mine(prev).slice(0, 25) } : { error: 'no Search Console per search + page data yet' },
    organic_28d: organic,
    index_status: inspection,
  }
}

export const SEO_AUDIT_TOOL_DEFS = [
  {
    name: 'get_seo_audit_overview',
    description: `START HERE for the weekly SEO audit. One call returns: data freshness and a COVERAGE map of all ${Object.keys(AUDIT_AREAS).length} SEO areas the owner requires (covered / partial / blind — an area the map marks blind can only get the verdict 'blind'); signals_to_address — every material signal in the data, each of which your seo_audit must answer (inside a finding's signals[] or in dismissed_signals with a reason); every crawl issue with counts and example URLs; Search Console clicks/impressions now vs the previous 28 days, split by page type; page speed; Google index status; and visit_value (web revenue per session) for putting a money figure on each finding.`,
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_seo_issue_pages',
    description: 'All pages hit by ONE crawl issue (ids are listed in the overview), each with its search clicks/impressions and organic sessions over 28 days, sorted money first. Use it to size a finding and to name the exact pages to fix.',
    input_schema: { type: 'object', properties: { issue: { type: 'string' }, page_type: { type: 'string', description: 'optional: home | product | category | post | page | other' }, limit: { type: 'number' } }, required: ['issue'] },
  },
  {
    name: 'get_search_page_map',
    description: 'Search Console per search AND page, current vs previous 28 days. views: page_losses (pages that lost the most clicks, with the searches they lost), query_losses, ctr_gaps (on Google\'s first page but far fewer clicks than the position normally gets — usually the title or description), cannibalization (one search split across several of our pages), striking_distance (positions 8–20 with real demand).',
    input_schema: { type: 'object', properties: { view: { type: 'string', enum: SEARCH_VIEWS }, limit: { type: 'number' } }, required: ['view'] },
  },
  {
    name: 'get_page_report',
    description: 'Everything about ONE page: what the crawl found (title, description, H1, words, markup, links in and out, images), its searches now and before, organic sessions, and Google\'s index status. Use before proposing a fix for a specific page.',
    input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  },
] as const

export async function dispatchSeoAuditTool(supabase: SupabaseClient, name: string, input: Record<string, unknown>): Promise<unknown | undefined> {
  switch (name) {
    case 'get_seo_audit_overview': return await getSeoAuditOverview(supabase)
    case 'get_seo_issue_pages':    return await getSeoIssuePages(supabase, input as { issue?: string; page_type?: string; limit?: number })
    case 'get_search_page_map':    return await getSearchPageMap(supabase, input as { view?: string; limit?: number })
    case 'get_page_report':        return await getPageReport(supabase, input as { url?: string })
    default:                       return undefined
  }
}
