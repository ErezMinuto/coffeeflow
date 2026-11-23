// SEO audit analysis — pure functions, no database (SEO agent build plan, Phase 1).
// The strategist's audit tools (seo_audit_tools.ts) read the data and pass it
// here. Tested by seo_audit_analysis_test.ts.
//
// These functions FIND and MEASURE; they never decide what matters. Ranking by
// money and choosing fixes is the strategist's job. The coverage map is
// deterministic so blind spots are reported by code, not left to the model's
// memory.

// ── The 23 areas of the owner's SEO requirements (doc: "SEO Expert Requirements — Minuto") ──
export const AUDIT_AREAS = {
  keyword_map:       'Search demand and keyword map',
  crawl_index:       'Crawling and indexing',
  site_health:       'Site health',
  speed_mobile:      'Speed and mobile',
  structured_data:   'Structured data',
  on_page:           'On-page (titles, descriptions, headings)',
  category_pages:    'Category pages',
  product_pages:     'Product pages',
  shopping:          'Google Shopping and free listings',
  content:           'Content',
  internal_links:    'Internal links and site structure',
  images_video:      'Images and video',
  authority:         'Authority and links',
  local:             'Local search',
  brand:             'Brand and reputation',
  ai_search:         'AI search',
  seasons:           'Seasons and events',
  conversion:        'Turning visitors into buyers',
  paid_coordination: 'Working with paid ads',
  other_engines:     'Other search engines',
  site_changes:      'Site changes and migrations',
  competitors:       'Competitors',
  measurement:       'Measurement',
} as const
export type AuditArea = keyof typeof AUDIT_AREAS
export const AUDIT_AREA_KEYS = Object.keys(AUDIT_AREAS) as AuditArea[]

// ── URLs ────────────────────────────────────────────────────────────────────

/** One key per page across crawl, Search Console and GA4: decoded path, trailing slash, lower case. */
export function pageKey(urlOrPath: string | null | undefined): string {
  if (!urlOrPath) return ''
  let path = String(urlOrPath)
  try { if (/^https?:\/\//i.test(path)) path = new URL(path).pathname } catch { /* keep as is */ }
  path = path.split('?')[0].split('#')[0]
  try { path = decodeURIComponent(path) } catch { /* keep encoded */ }
  if (!path.startsWith('/')) path = '/' + path
  if (!path.endsWith('/') && !/\.[a-z0-9]{2,5}$/i.test(path)) path += '/'
  return path.toLowerCase()
}

// ── Crawl ───────────────────────────────────────────────────────────────────

export interface CrawlPage {
  url: string
  page_type: string | null
  status: number | null
  final_url: string | null
  redirects: number | null
  title: string | null
  meta_description: string | null
  h1: string | null
  h1_count: number | null
  canonical: string | null
  robots_meta: string | null
  x_robots_tag: string | null
  word_count: number | null
  schema_types: string[] | null
  internal_links: string[] | null
  images: number | null
  images_missing_alt: number | null
  response_ms: number | null
}

/** How many OTHER crawled pages link to each page. */
export function inlinkCounts(pages: CrawlPage[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const p of pages) {
    const self = pageKey(p.final_url ?? p.url)
    for (const l of new Set((p.internal_links ?? []).map(pageKey))) {
      if (l && l !== self) counts.set(l, (counts.get(l) ?? 0) + 1)
    }
  }
  return counts
}

const ok = (p: CrawlPage) => p.status === 200
const len = (s: string | null) => (s ?? '').trim().length
const noindex = (p: CrawlPage) => /noindex/i.test(`${p.robots_meta ?? ''} ${p.x_robots_tag ?? ''}`)
const has = (p: CrawlPage, ...types: string[]) => (p.schema_types ?? []).some((t) => types.includes(t))
const THIN_WORDS = 250

interface IssueDef { id: string; area: AuditArea; label: string; test: (p: CrawlPage, ctx: { inlinks: Map<string, number>; dupTitles: Set<string>; dupDescs: Set<string> }) => boolean }

export const CRAWL_ISSUES: IssueDef[] = [
  { id: 'http_error',            area: 'site_health',     label: 'listed in the sitemap but does not answer 200',            test: (p) => p.status !== 200 },
  { id: 'redirected_in_sitemap', area: 'site_health',     label: 'listed in the sitemap but redirects',                      test: (p) => (p.redirects ?? 0) > 0 },
  { id: 'slow_response',         area: 'speed_mobile',    label: 'server took over 2.5 s to answer',                          test: (p) => ok(p) && (p.response_ms ?? 0) > 2500 },
  { id: 'noindex_in_sitemap',    area: 'crawl_index',     label: 'listed in the sitemap but tells Google not to index it',   test: (p) => ok(p) && noindex(p) },
  { id: 'missing_canonical',     area: 'crawl_index',     label: 'no canonical tag',                                         test: (p) => ok(p) && !p.canonical },
  { id: 'canonical_elsewhere',   area: 'crawl_index',     label: 'canonical points to a different page',                     test: (p) => ok(p) && !!p.canonical && pageKey(p.canonical) !== pageKey(p.final_url ?? p.url) },
  { id: 'missing_title',         area: 'on_page',         label: 'no title',                                                 test: (p) => ok(p) && len(p.title) === 0 },
  { id: 'title_too_long',        area: 'on_page',         label: 'title over 60 characters (Google cuts it)',                test: (p) => ok(p) && len(p.title) > 60 },
  { id: 'title_too_short',       area: 'on_page',         label: 'title under 20 characters',                                test: (p) => ok(p) && len(p.title) > 0 && len(p.title) < 20 },
  { id: 'duplicate_title',       area: 'on_page',         label: 'same title as another page',                               test: (p, c) => ok(p) && len(p.title) > 0 && c.dupTitles.has((p.title ?? '').trim()) },
  { id: 'missing_description',   area: 'on_page',         label: 'no Google description',                                    test: (p) => ok(p) && len(p.meta_description) === 0 },
  { id: 'description_too_long',  area: 'on_page',         label: 'Google description over 160 characters',                   test: (p) => ok(p) && len(p.meta_description) > 160 },
  { id: 'description_too_short', area: 'on_page',         label: 'Google description under 70 characters',                   test: (p) => ok(p) && len(p.meta_description) > 0 && len(p.meta_description) < 70 },
  { id: 'duplicate_description', area: 'on_page',         label: 'same Google description as another page',                  test: (p, c) => ok(p) && len(p.meta_description) > 0 && c.dupDescs.has((p.meta_description ?? '').trim()) },
  { id: 'missing_h1',            area: 'on_page',         label: 'no H1 heading',                                            test: (p) => ok(p) && (p.h1_count ?? 0) === 0 },
  { id: 'multiple_h1',           area: 'on_page',         label: 'more than one H1 heading',                                 test: (p) => ok(p) && (p.h1_count ?? 0) > 1 },
  { id: 'thin_category',         area: 'category_pages',  label: `category page with under ${THIN_WORDS} words of content`, test: (p) => ok(p) && p.page_type === 'category' && (p.word_count ?? 0) < THIN_WORDS },
  { id: 'thin_product',          area: 'product_pages',   label: `product page with under ${THIN_WORDS} words of content`,  test: (p) => ok(p) && p.page_type === 'product' && (p.word_count ?? 0) < THIN_WORDS },
  { id: 'thin_post',             area: 'content',         label: `blog post with under ${THIN_WORDS} words of content`,     test: (p) => ok(p) && p.page_type === 'post' && (p.word_count ?? 0) < THIN_WORDS },
  { id: 'missing_product_schema', area: 'structured_data', label: 'product page without Product markup',                     test: (p) => ok(p) && p.page_type === 'product' && !has(p, 'Product') },
  { id: 'missing_article_schema', area: 'structured_data', label: 'blog post without Article markup',                        test: (p) => ok(p) && p.page_type === 'post' && !has(p, 'Article', 'BlogPosting', 'NewsArticle') },
  { id: 'missing_breadcrumb',    area: 'structured_data', label: 'no BreadcrumbList markup',                                 test: (p) => ok(p) && ['product', 'category', 'post'].includes(p.page_type ?? '') && !has(p, 'BreadcrumbList') },
  { id: 'images_missing_alt',    area: 'images_video',    label: 'images without alt text',                                  test: (p) => ok(p) && (p.images_missing_alt ?? 0) > 0 },
  { id: 'orphan',                area: 'internal_links',  label: 'no other page links to it',                                test: (p, c) => ok(p) && p.page_type !== 'home' && (c.inlinks.get(pageKey(p.final_url ?? p.url)) ?? 0) === 0 },
]

function duplicates(values: Array<string | null>): Set<string> {
  const seen = new Map<string, number>()
  for (const v of values) { const k = (v ?? '').trim(); if (k) seen.set(k, (seen.get(k) ?? 0) + 1) }
  return new Set([...seen].filter(([, n]) => n > 1).map(([k]) => k))
}

export interface CrawlIssueSummary { id: string; area: AuditArea; label: string; count: number; examples: string[] }

export function crawlIssues(pages: CrawlPage[], examples = 5): { by_issue: CrawlIssueSummary[]; pages_by_type: Record<string, number>; status_counts: Record<string, number> } {
  const live = pages.filter(ok)
  const ctx = { inlinks: inlinkCounts(pages), dupTitles: duplicates(live.map((p) => p.title)), dupDescs: duplicates(live.map((p) => p.meta_description)) }
  const by_issue: CrawlIssueSummary[] = []
  for (const def of CRAWL_ISSUES) {
    const hit = pages.filter((p) => def.test(p, ctx))
    if (hit.length) by_issue.push({ id: def.id, area: def.area, label: def.label, count: hit.length, examples: hit.slice(0, examples).map((p) => p.url) })
  }
  const pages_by_type: Record<string, number> = {}
  const status_counts: Record<string, number> = {}
  for (const p of pages) {
    pages_by_type[p.page_type ?? 'other'] = (pages_by_type[p.page_type ?? 'other'] ?? 0) + 1
    status_counts[String(p.status ?? 0)] = (status_counts[String(p.status ?? 0)] ?? 0) + 1
  }
  return { by_issue, pages_by_type, status_counts }
}

/** Pages hit by one crawl issue (all of them, for get_seo_issue_pages). */
export function pagesWithIssue(pages: CrawlPage[], issueId: string): CrawlPage[] {
  const def = CRAWL_ISSUES.find((d) => d.id === issueId)
  if (!def) return []
  const live = pages.filter(ok)
  const ctx = { inlinks: inlinkCounts(pages), dupTitles: duplicates(live.map((p) => p.title)), dupDescs: duplicates(live.map((p) => p.meta_description)) }
  return pages.filter((p) => def.test(p, ctx))
}

// ── Search Console per search + page ────────────────────────────────────────

export interface QpRow { query: string; page: string; clicks: number; impressions: number; position: number }

// Typical click-through rate by position on Google (organic, desktop+mobile
// blended; industry studies 2024-25). Used only to spot pages far BELOW it.
const EXPECTED_CTR: Record<number, number> = { 1: 0.28, 2: 0.15, 3: 0.10, 4: 0.07, 5: 0.05, 6: 0.04, 7: 0.03, 8: 0.025, 9: 0.02, 10: 0.02 }
export function expectedCtr(position: number): number {
  const p = Math.min(Math.max(Math.round(position), 1), 10)
  return EXPECTED_CTR[p]
}

const sum = (rows: QpRow[], f: (r: QpRow) => number) => rows.reduce((s, r) => s + f(r), 0)

function byKey<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>()
  for (const r of rows) { const k = key(r); const a = m.get(k); if (a) a.push(r); else m.set(k, [r]) }
  return m
}

export type SearchView = 'page_losses' | 'query_losses' | 'ctr_gaps' | 'cannibalization' | 'striking_distance'
export const SEARCH_VIEWS: SearchView[] = ['page_losses', 'query_losses', 'ctr_gaps', 'cannibalization', 'striking_distance']

export function searchTotals(cur: QpRow[], prev: QpRow[]) {
  return {
    clicks: sum(cur, (r) => r.clicks), clicks_prev: sum(prev, (r) => r.clicks),
    impressions: sum(cur, (r) => r.impressions), impressions_prev: sum(prev, (r) => r.impressions),
    pages_with_impressions: new Set(cur.map((r) => pageKey(r.page))).size,
    queries: new Set(cur.map((r) => r.query)).size,
  }
}

export function searchView(view: SearchView, cur: QpRow[], prev: QpRow[], limit = 25): unknown[] {
  if (view === 'page_losses' || view === 'query_losses') {
    const key = view === 'page_losses' ? (r: QpRow) => pageKey(r.page) : (r: QpRow) => r.query
    const c = byKey(cur, key), p = byKey(prev, key)
    const keys = new Set([...c.keys(), ...p.keys()])
    const out = [...keys].map((k) => {
      const cr = c.get(k) ?? [], pr = p.get(k) ?? []
      const clicks = sum(cr, (r) => r.clicks), clicksPrev = sum(pr, (r) => r.clicks)
      const row: Record<string, unknown> = {
        [view === 'page_losses' ? 'page' : 'query']: k,
        clicks, clicks_prev: clicksPrev, change: clicks - clicksPrev,
        impressions: sum(cr, (r) => r.impressions), impressions_prev: sum(pr, (r) => r.impressions),
      }
      if (view === 'page_losses') {
        // The searches this page lost the most clicks on.
        const cq = byKey(cr, (r) => r.query), pq = byKey(pr, (r) => r.query)
        row.top_lost_queries = [...new Set([...cq.keys(), ...pq.keys()])]
          .map((q) => ({ query: q, change: sum(cq.get(q) ?? [], (r) => r.clicks) - sum(pq.get(q) ?? [], (r) => r.clicks) }))
          .filter((x) => x.change < 0).sort((a, b) => a.change - b.change).slice(0, 3)
      }
      return row
    })
    return out.filter((r) => (r.change as number) < 0).sort((a, b) => (a.change as number) - (b.change as number)).slice(0, limit)
  }
  if (view === 'ctr_gaps') {
    return cur.filter((r) => r.position > 0 && r.position <= 10 && r.impressions >= 50)
      .map((r) => {
        const expected = expectedCtr(r.position) * r.impressions
        return { query: r.query, page: pageKey(r.page), position: Math.round(r.position * 10) / 10, impressions: r.impressions, clicks: r.clicks, expected_clicks: Math.round(expected), click_gap: Math.round(expected - r.clicks) }
      })
      .filter((r) => r.clicks < r.expected_clicks * 0.6)
      .sort((a, b) => b.click_gap - a.click_gap).slice(0, limit)
  }
  if (view === 'cannibalization') {
    const out: unknown[] = []
    for (const [query, rows] of byKey(cur, (r) => r.query)) {
      const total = sum(rows, (r) => r.impressions)
      if (total < 30) continue
      const pages = byKey(rows, (r) => pageKey(r.page))
      const sharing = [...pages].map(([page, rs]) => ({ page, impressions: sum(rs, (r) => r.impressions), clicks: sum(rs, (r) => r.clicks), position: Math.round((sum(rs, (r) => r.position * r.impressions) / Math.max(sum(rs, (r) => r.impressions), 1)) * 10) / 10 }))
        .filter((x) => x.impressions >= total * 0.1)
      if (sharing.length >= 2) out.push({ query, impressions: total, pages: sharing.sort((a, b) => b.impressions - a.impressions) })
    }
    return (out as Array<{ impressions: number }>).sort((a, b) => b.impressions - a.impressions).slice(0, limit)
  }
  // striking_distance: ranked 8–20 with real demand — a push could reach the first page's top.
  return cur.filter((r) => r.position >= 8 && r.position <= 20 && r.impressions >= 100)
    .map((r) => ({ query: r.query, page: pageKey(r.page), position: Math.round(r.position * 10) / 10, impressions: r.impressions, clicks: r.clicks }))
    .sort((a, b) => b.impressions - a.impressions).slice(0, limit)
}

// ── Value of a visit ────────────────────────────────────────────────────────

/**
 * Average web revenue per site session over the window: a rough price tag
 * for one extra visit, so findings can be ranked by money. Directional only —
 * organic visitors may convert better or worse than the average.
 */
export function valuePerSession(webRevenueIls: number, sessions: number): number | null {
  if (!(sessions > 0) || !(webRevenueIls >= 0)) return null
  return Math.round((webRevenueIls / sessions) * 100) / 100
}

// ── Coverage: which areas the audit can see this week ───────────────────────

export interface DataState {
  crawl_finished_at:  string | null
  query_page_end:     string | null
  speed_ok:           number
  speed_refused:      number
  inspect_ok:         number
  inspect_failed:     number
  ga4_synced_at:      string | null
  ads_synced_at:      string | null
  ai_probe_at:        string | null
  orders_synced_at:   string | null
}

export type CoverageStatus = 'covered' | 'partial' | 'blind'
export interface CoverageRow { area: AuditArea; name: string; status: CoverageStatus; sees: string; missing: string | null }

function fresh(iso: string | null, days: number, now: number): boolean {
  if (!iso) return false
  const t = Date.parse(iso)
  return Number.isFinite(t) && now - t <= days * 864e5
}

export function coverage(s: DataState, now = Date.now()): CoverageRow[] {
  const crawl = fresh(s.crawl_finished_at, 8, now)
  const qp = fresh(s.query_page_end, 10, now)
  const ga4 = fresh(s.ga4_synced_at, 3, now)
  const row = (area: AuditArea, status: CoverageStatus, sees: string, missing: string | null = null): CoverageRow => ({ area, name: AUDIT_AREAS[area], status, sees, missing })
  const needCrawl = 'a site crawl from the last 8 days (weekly job seo-audit-weekly.yml)'
  const needQp = 'Search Console per search + page from the last 10 days (weekly job)'
  return [
    row('keyword_map', qp ? 'covered' : 'blind', qp ? 'every search tied to the page that ranks for it, current vs previous 28 days' : 'nothing per page', qp ? null : needQp),
    row('crawl_index', crawl && s.inspect_ok > 0 ? 'covered' : crawl ? 'partial' : 'blind', `${crawl ? 'sitemap, robots.txt, noindex and canonicals on every page' : 'nothing'}${s.inspect_ok ? `; Google index status for ${s.inspect_ok} money pages` : ''}`, crawl ? (s.inspect_ok ? null : `Google index status (URL Inspection${s.inspect_failed ? `: ${s.inspect_failed} requests failed` : ' did not run'})`) : needCrawl),
    row('site_health', crawl ? 'partial' : 'blind', crawl ? 'status codes and redirects of every sitemap page' : 'nothing', crawl ? 'broken links inside page content, HTTPS/mixed content, uptime and malware checks' : needCrawl),
    row('speed_mobile', s.speed_ok > 0 ? 'covered' : crawl ? 'partial' : 'blind', s.speed_ok > 0 ? `Google PageSpeed for ${s.speed_ok} page types, plus server response time per page` : crawl ? 'server response time per page only' : 'nothing', s.speed_ok > 0 ? null : `Google PageSpeed results (${s.speed_refused ? `${s.speed_refused} requests refused — add a PAGESPEED_API_KEY repo secret` : 'not measured yet'})`),
    row('structured_data', crawl ? 'partial' : 'blind', crawl ? 'which markup types each page carries' : 'nothing', crawl ? 'validation of the markup against Google rich-result rules' : needCrawl),
    row('on_page', crawl ? 'covered' : 'blind', crawl ? 'titles, Google descriptions, H1s, canonicals on every page' : 'nothing', crawl ? null : needCrawl),
    row('category_pages', crawl && qp ? 'covered' : crawl || qp ? 'partial' : 'blind', 'category content, markup, searches and traffic', crawl && qp ? null : `${crawl ? '' : needCrawl}${!crawl && !qp ? '; ' : ''}${qp ? '' : needQp}`),
    row('product_pages', crawl && qp ? 'covered' : crawl || qp ? 'partial' : 'blind', 'product content, markup, searches and traffic', crawl && qp ? null : `${crawl ? '' : needCrawl}${!crawl && !qp ? '; ' : ''}${qp ? '' : needQp}`),
    row('shopping', 'blind', 'nothing', 'Merchant Center status: the Google login needs the Shopping (Content API) permission'),
    row('content', crawl && qp ? 'covered' : crawl || qp ? 'partial' : 'blind', 'blog posts: length, searches, losses, posts competing for the same search', crawl && qp ? null : needQp),
    row('internal_links', crawl ? 'covered' : 'blind', crawl ? 'every internal link between sitemap pages, inlinks and orphans' : 'nothing', crawl ? null : needCrawl),
    row('images_video', crawl ? 'partial' : 'blind', crawl ? 'images and missing alt text per page' : 'nothing', 'image file sizes and video (YouTube) data'),
    row('authority', 'blind', 'nothing', 'a backlink tool (Ahrefs or Semrush): approved only if it earns more than it costs'),
    row('local', 'blind', 'nothing', 'Google Business Profile access (approved by the owner; the connection is not built yet)'),
    row('brand', qp ? 'partial' : 'blind', qp ? 'searches for the Minuto name and which page answers them' : 'nothing', 'what else shows for "Minuto" on Google (knowledge panel, reviews, third-party pages)'),
    row('ai_search', fresh(s.ai_probe_at, 9, now) ? 'partial' : 'blind', fresh(s.ai_probe_at, 9, now) ? 'weekly checks of whether AI assistants mention Minuto' : 'nothing recent', 'checks for every assistant (only Claude is always on)'),
    row('seasons', 'partial', 'the date and upcoming holidays (calendar in the snapshot) plus past-year search data where it exists', 'search demand forecasts per season'),
    row('conversion', ga4 ? 'partial' : 'blind', ga4 ? 'sessions and conversions per landing page (GA4)' : 'nothing', 'reliable revenue per landing page (GA4 conversion value is not populated)'),
    row('paid_coordination', fresh(s.ads_synced_at, 3, now) && qp ? 'covered' : 'partial', 'Google Ads keywords and Search Console searches side by side', fresh(s.ads_synced_at, 3, now) ? null : 'fresh Google Ads data'),
    row('other_engines', 'blind', 'nothing', 'Bing Webmaster Tools access'),
    row('site_changes', crawl ? 'partial' : 'blind', crawl ? 'week-on-week crawl differences' : 'nothing', 'a check before theme, plugin or URL changes go live'),
    row('competitors', 'partial', 'competitors named by AI assistants and competitor ads', 'competitor rankings for Minuto\'s searches (needs a rank/backlink tool)'),
    row('measurement', ga4 && qp && fresh(s.orders_synced_at, 3, now) ? 'covered' : 'partial', 'Search Console, GA4 and orders freshness', ga4 && qp && fresh(s.orders_synced_at, 3, now) ? null : 'one of Search Console / GA4 / orders is stale'),
  ]
}

// ── Signals the audit must answer ───────────────────────────────────────────
// The first real audit (2026-11-23) looked at the right views and still left
// the biggest losses out. So code lists every material signal in the data,
// and the audit is refused until each one is either part of a finding or
// dismissed with a reason. Thresholds decide what is big enough to answer;
// they never decide what it means.

export interface Signal { id: string; kind: string; area: AuditArea; summary: string; size: number }

const TYPE_AREA: Record<string, AuditArea> = { category: 'category_pages', product: 'product_pages', post: 'content', home: 'brand', page: 'on_page' }
const areaOfType = (t: string | null | undefined): AuditArea => TYPE_AREA[t ?? ''] ?? 'keyword_map'

export function materialSignals(pages: CrawlPage[], cur: QpRow[], prev: QpRow[]): Signal[] {
  const out: Signal[] = []
  const typeOf = new Map(pages.map((p) => [pageKey(p.final_url ?? p.url), p.page_type ?? 'other']))

  // 1. A whole page type losing search clicks.
  const byType = new Map<string, { now: number; before: number }>()
  for (const [rows, k] of [[cur, 'now'], [prev, 'before']] as const) {
    for (const r of rows) {
      const t = typeOf.get(pageKey(r.page)) ?? 'not_in_crawl'
      const v = byType.get(t) ?? { now: 0, before: 0 }
      v[k] += r.clicks
      byType.set(t, v)
    }
  }
  for (const [t, v] of byType) {
    const drop = v.before - v.now
    if (v.before >= 100 && drop >= v.before * 0.15) {
      out.push({ id: `type_loss:${t}`, kind: 'type_loss', area: areaOfType(t), size: drop, summary: `${t} pages: ${v.before} → ${v.now} search clicks over 28 days (−${Math.round((drop / v.before) * 100)}%)` })
    }
  }
  // 2. Single pages losing clicks.
  for (const r of (searchView('page_losses', cur, prev, 8) as Array<{ page: string; clicks: number; clicks_prev: number; change: number }>)) {
    if (r.change <= -20) out.push({ id: `page_loss:${r.page}`, kind: 'page_loss', area: areaOfType(typeOf.get(r.page)), size: -r.change, summary: `${r.page}: ${r.clicks_prev} → ${r.clicks} search clicks` })
  }
  // 3. First-page positions earning far fewer clicks than they should.
  for (const r of (searchView('ctr_gaps', cur, prev, 8) as Array<{ query: string; page: string; position: number; clicks: number; expected_clicks: number; click_gap: number }>)) {
    if (r.click_gap >= 30) out.push({ id: `ctr_gap:${r.query}|${r.page}`, kind: 'ctr_gap', area: 'on_page', size: r.click_gap, summary: `"${r.query}" → ${r.page}: position ${r.position}, ${r.clicks} clicks vs ~${r.expected_clicks} expected` })
  }
  // 4. One search split across several of our pages.
  for (const r of (searchView('cannibalization', cur, prev, 5) as Array<{ query: string; impressions: number; pages: unknown[] }>)) {
    if (r.impressions >= 300) out.push({ id: `cannibal:${r.query}`, kind: 'cannibalization', area: 'content', size: r.impressions, summary: `"${r.query}" (${r.impressions} impressions) split across ${r.pages.length} of our pages` })
  }
  // 5. Near the first page with real demand.
  for (const r of (searchView('striking_distance', cur, prev, 5) as Array<{ query: string; page: string; position: number; impressions: number }>)) {
    if (r.impressions >= 500) out.push({ id: `striking:${r.query}|${r.page}`, kind: 'striking_distance', area: 'keyword_map', size: r.impressions, summary: `"${r.query}" → ${r.page}: position ${r.position}, ${r.impressions} impressions` })
  }
  // 6. Crawl issues on many pages.
  for (const i of crawlIssues(pages).by_issue) {
    if (i.count >= 5) out.push({ id: `crawl:${i.id}`, kind: 'crawl_issue', area: i.area, size: i.count, summary: `${i.count} pages: ${i.label}` })
  }
  return out.slice(0, 50)
}

// ── The audit the strategist hands in (conclude_brief.seo_audit) ────────────

export interface SeoFinding {
  area: AuditArea
  title: string
  evidence: string
  pages: string[]
  est_monthly_value_ils: number | null
  value_method: string
  no_value_reason: string
  effort: 'low' | 'medium' | 'high'
  fix: string
  signals: string[]
}
export interface BlindSpot { area: AuditArea; why: string; needed: string }
export type Verdict = 'problem' | 'ok' | 'blind'
export interface AreaVerdict { area: AuditArea; verdict: Verdict; note: string }
export interface DismissedSignal { id: string; reason: string }
export interface SeoAudit {
  findings: SeoFinding[]
  blind_spots: BlindSpot[]
  area_verdicts: AreaVerdict[]
  dismissed_signals: DismissedSignal[]
  signals_checked: number
}

const EFFORTS = new Set(['low', 'medium', 'high'])
const VERDICTS = new Set(['problem', 'ok', 'blind'])

/**
 * Checks and tidies the audit. Problems go back to the model to fix; nothing
 * is silently dropped. With `ctx` (always in production) it also enforces:
 *   - a verdict for every one of the 23 areas, consistent with the coverage
 *     map (an area the data cannot see can only be 'blind');
 *   - every 'problem' area has a finding and every finding's area is a 'problem';
 *   - every material signal is part of a finding or dismissed with a reason;
 *   - an unpriced finding says why;
 *   - every blind or partial area from the coverage map is in blind_spots
 *     (added by code: the model can add to the list, never shorten it).
 */
export function normaliseSeoAudit(
  raw: unknown,
  ctx?: { coverage: CoverageRow[]; signals: Signal[] },
): { ok: true; audit: SeoAudit } | { ok: false; problems: string[] } {
  const problems: string[] = []
  if (!raw || typeof raw !== 'object') return { ok: false, problems: ['seo_audit is required: { findings, blind_spots, area_verdicts, dismissed_signals }'] }
  const r = raw as Record<string, unknown>
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
  const area = (v: unknown, at: string): AuditArea | null => {
    if (typeof v === 'string' && (AUDIT_AREA_KEYS as string[]).includes(v)) return v as AuditArea
    problems.push(`${at}.area must be one of: ${AUDIT_AREA_KEYS.join(', ')}`)
    return null
  }

  // Findings.
  const findings: SeoFinding[] = []
  if (!Array.isArray(r.findings)) problems.push('seo_audit.findings must be an array (empty if nothing was found)')
  for (const [i, f] of (Array.isArray(r.findings) ? r.findings : []).slice(0, 40).entries()) {
    const at = `seo_audit.findings[${i}]`
    const x = (f ?? {}) as Record<string, unknown>
    const a = area(x.area, at)
    const title = str(x.title), evidence = str(x.evidence), fix = str(x.fix)
    if (!title) problems.push(`${at}.title is required`)
    if (!evidence) problems.push(`${at}.evidence is required: the numbers behind it, from the audit tools`)
    if (!fix) problems.push(`${at}.fix is required`)
    const effort = str(x.effort)
    if (!EFFORTS.has(effort)) problems.push(`${at}.effort must be low, medium or high`)
    const v = x.est_monthly_value_ils
    const value = v == null || v === '' ? null : Number(v)
    if (value != null && !(Number.isFinite(value) && value >= 0)) problems.push(`${at}.est_monthly_value_ils must be a non-negative number, or left out`)
    if (value != null && !str(x.value_method)) problems.push(`${at}.value_method is required when a value is given`)
    if (value == null && ctx && !str(x.no_value_reason)) problems.push(`${at} has no est_monthly_value_ils: give one (extra visits × visit_value) or say why in no_value_reason`)
    if (a && title && evidence && fix && EFFORTS.has(effort)) {
      findings.push({
        area: a, title, evidence, fix, effort: effort as SeoFinding['effort'],
        pages: (Array.isArray(x.pages) ? x.pages : []).filter((p): p is string => typeof p === 'string').slice(0, 20),
        est_monthly_value_ils: value != null && Number.isFinite(value) ? Math.round(value) : null,
        value_method: str(x.value_method),
        no_value_reason: value == null ? str(x.no_value_reason) : '',
        signals: (Array.isArray(x.signals) ? x.signals : []).filter((s): s is string => typeof s === 'string'),
      })
    }
  }

  // Blind spots the model listed.
  const modelBlind: BlindSpot[] = []
  if (!Array.isArray(r.blind_spots)) problems.push('seo_audit.blind_spots must be an array')
  for (const [i, b] of (Array.isArray(r.blind_spots) ? r.blind_spots : []).slice(0, 30).entries()) {
    const at = `seo_audit.blind_spots[${i}]`
    const x = (b ?? {}) as Record<string, unknown>
    const a = area(x.area, at)
    if (a && str(x.why) && str(x.needed)) modelBlind.push({ area: a, why: str(x.why), needed: str(x.needed) })
    else if (a) problems.push(`${at} needs why and needed`)
  }

  // Area verdicts.
  const verdicts: AreaVerdict[] = []
  if (ctx) {
    if (!Array.isArray(r.area_verdicts)) problems.push(`seo_audit.area_verdicts must list all ${AUDIT_AREA_KEYS.length} areas, each with verdict problem | ok | blind and a one-line note`)
    const seen = new Set<string>()
    for (const [i, v] of (Array.isArray(r.area_verdicts) ? r.area_verdicts : []).entries()) {
      const at = `seo_audit.area_verdicts[${i}]`
      const x = (v ?? {}) as Record<string, unknown>
      const a = area(x.area, at)
      const verdict = str(x.verdict)
      if (!VERDICTS.has(verdict)) { problems.push(`${at}.verdict must be problem, ok or blind`); continue }
      if (!a) continue
      if (seen.has(a)) { problems.push(`${at}: ${a} is listed twice`); continue }
      seen.add(a)
      verdicts.push({ area: a, verdict: verdict as Verdict, note: str(x.note) })
    }
    const missing = AUDIT_AREA_KEYS.filter((k) => !seen.has(k))
    if (Array.isArray(r.area_verdicts) && missing.length) problems.push(`seo_audit.area_verdicts is missing: ${missing.join(', ')}`)
    const cov = new Map(ctx.coverage.map((c) => [c.area, c]))
    for (const v of verdicts) {
      if (cov.get(v.area)?.status === 'blind' && v.verdict !== 'blind') problems.push(`area_verdicts ${v.area}: the coverage map shows this area is blind (${cov.get(v.area)?.missing ?? 'no data'}), so its verdict can only be 'blind'`)
      if (v.verdict === 'problem' && !findings.some((f) => f.area === v.area)) problems.push(`area_verdicts ${v.area} is 'problem' but no finding has area ${v.area}`)
      if (!v.note) problems.push(`area_verdicts ${v.area} needs a one-line note (what you checked, or why it is blind)`)
    }
    for (const f of findings) {
      const v = verdicts.find((x) => x.area === f.area)
      if (v && v.verdict === 'blind') problems.push(`finding "${f.title}" is in ${f.area}, which is blind (no data): an area you cannot see cannot have findings — remove the finding or move it to the area its evidence comes from`)
      else if (v && v.verdict !== 'problem') problems.push(`finding "${f.title}" is in ${f.area}, but that area's verdict is '${v.verdict}' (make it 'problem')`)
    }
  }

  // Signals.
  const dismissed: DismissedSignal[] = []
  for (const [i, d] of (Array.isArray(r.dismissed_signals) ? r.dismissed_signals : []).entries()) {
    const x = (d ?? {}) as Record<string, unknown>
    if (str(x.id) && str(x.reason)) dismissed.push({ id: str(x.id), reason: str(x.reason) })
    else problems.push(`seo_audit.dismissed_signals[${i}] needs id and reason`)
  }
  if (ctx) {
    const known = new Set(ctx.signals.map((s) => s.id))
    const answered = new Set([...findings.flatMap((f) => f.signals), ...dismissed.map((d) => d.id)])
    const open = ctx.signals.filter((s) => !answered.has(s.id))
    if (open.length) {
      problems.push(`${open.length} material signal(s) are not answered. Each must be in a finding's signals[] or in dismissed_signals with a reason: ${open.map((s) => `${s.id} (${s.summary})`).join(' | ')}`)
    }
    // Ids that are not in today's list are ignored rather than refused: they
    // answer nothing, and refusing them would block a brief if the weekly data
    // refreshed mid-run. Every real signal still has to be answered above.
    void known
  }

  if (problems.length) return { ok: false, problems }

  // Blind spots: the coverage map's blind and partial gaps, always; the
  // model's own wording wins where it covered the same area.
  const blind_spots: BlindSpot[] = [...modelBlind]
  if (ctx) {
    for (const c of ctx.coverage) {
      if (c.status === 'covered' || !c.missing || blind_spots.some((b) => b.area === c.area)) continue
      blind_spots.push({ area: c.area, why: c.status === 'blind' ? 'no data for this area' : `only partly visible: sees ${c.sees}`, needed: c.missing })
    }
  }
  // Money first; unpriced last.
  findings.sort((a, b) => (b.est_monthly_value_ils ?? -1) - (a.est_monthly_value_ils ?? -1))
  return { ok: true, audit: { findings, blind_spots, area_verdicts: verdicts, dismissed_signals: dismissed, signals_checked: ctx?.signals.length ?? 0 } }
}
