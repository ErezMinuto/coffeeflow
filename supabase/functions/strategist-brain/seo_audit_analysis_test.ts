// deno run supabase/functions/strategist-brain/seo_audit_analysis_test.ts
import {
  AUDIT_AREA_KEYS, coverage, crawlIssues, expectedCtr, inlinkCounts, normaliseSeoAudit, pageKey, pagesWithIssue,
  searchTotals, searchView, valuePerSession, type CrawlPage, type QpRow,
} from './seo_audit_analysis.ts'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}

// ── pageKey ──
check('pageKey: full URL, encoded Hebrew, query dropped', pageKey('https://www.minuto.co.il/blog/%D7%A7%D7%A4%D7%94/?x=1') === '/blog/קפה/')
check('pageKey: GA4 path without slash', pageKey('/product/A') === '/product/a/')
check('pageKey: file keeps no slash', pageKey('/sitemap.xml') === '/sitemap.xml')

// ── crawl ──
const base: CrawlPage = { url: '', page_type: 'product', status: 200, final_url: null, redirects: 0, title: 'מכונת קפה מעולה לבית | מינוטו', meta_description: 'x'.repeat(120), h1: 'h', h1_count: 1, canonical: null, robots_meta: 'index, follow', x_robots_tag: null, word_count: 600, schema_types: ['Product', 'BreadcrumbList'], internal_links: [], images: 2, images_missing_alt: 0, response_ms: 300 }
const P = (url: string, o: Partial<CrawlPage> = {}): CrawlPage => ({ ...base, url, final_url: url, canonical: url, ...o })
const pages: CrawlPage[] = [
  P('https://www.minuto.co.il/', { page_type: 'home', internal_links: ['/product/a/', '/product-category/beans/'] }),
  P('https://www.minuto.co.il/product/a/', { internal_links: ['/product-category/beans/'] }),
  P('https://www.minuto.co.il/product/b/', { title: 'מכונת קפה מעולה לבית | מינוטו', word_count: 100, schema_types: [] }),           // duplicate title, thin, no schema, orphan
  P('https://www.minuto.co.il/product-category/beans/', { page_type: 'category', word_count: 40, robots_meta: 'noindex, follow', canonical: 'https://www.minuto.co.il/product-category/other/' }),
  P('https://www.minuto.co.il/old/', { page_type: 'page', status: 404 }),
  P('https://www.minuto.co.il/blog/x/', { page_type: 'post', h1_count: 0, schema_types: ['BreadcrumbList'], images_missing_alt: 3, internal_links: ['/product/b/'] }),
]
const inl = inlinkCounts(pages)
check('inlinks counted from other pages', inl.get('/product-category/beans/') === 2 && inl.get('/product/b/') === 1)
const ci = crawlIssues(pages)
const ids = new Set(ci.by_issue.map((i) => i.id))
for (const id of ['http_error', 'duplicate_title', 'thin_product', 'thin_category', 'missing_product_schema', 'noindex_in_sitemap', 'canonical_elsewhere', 'missing_h1', 'missing_article_schema', 'images_missing_alt']) {
  check(`crawl finds ${id}`, ids.has(id), [...ids].join(','))
}
check('orphan: blog post nobody links to', pagesWithIssue(pages, 'orphan').some((p) => p.url.endsWith('/blog/x/')))
check('orphan: linked product is not orphan', !pagesWithIssue(pages, 'orphan').some((p) => p.url.endsWith('/product/a/')))
check('home never counted as orphan', !pagesWithIssue(pages, 'orphan').some((p) => p.page_type === 'home'))
check('404 page not double-counted as on-page issues', !pagesWithIssue(pages, 'missing_h1').some((p) => p.status !== 200))
check('pages by type', ci.pages_by_type.product === 2 && ci.status_counts['404'] === 1)
check('unknown issue → no pages', pagesWithIssue(pages, 'nope').length === 0)

// ── search views ──
const Q = (query: string, page: string, clicks: number, impressions: number, position: number): QpRow => ({ query, page, clicks, impressions, position })
const cur = [
  Q('פולי קפה', 'https://www.minuto.co.il/product-category/beans/', 10, 1000, 3),   // ctr gap (expected 100)
  Q('פולי קפה', 'https://www.minuto.co.il/blog/x/', 2, 400, 9),                      // cannibalization partner
  Q('מטחנה', 'https://www.minuto.co.il/product/a/', 5, 300, 12),                    // striking distance
]
const prev = [
  Q('פולי קפה', 'https://www.minuto.co.il/product-category/beans/', 60, 1100, 2.5),
  Q('מטחנה', 'https://www.minuto.co.il/product/a/', 5, 250, 13),
]
const t = searchTotals(cur, prev)
check('totals', t.clicks === 17 && t.clicks_prev === 65 && t.queries === 2)
const losses = searchView('page_losses', cur, prev) as Array<Record<string, any>>
check('page losses: category lost 50 clicks, with the search it lost', losses[0]?.page === '/product-category/beans/' && losses[0]?.change === -50 && losses[0]?.top_lost_queries?.[0]?.query === 'פולי קפה', JSON.stringify(losses[0]))
check('page losses: only losers listed', losses.every((r) => r.change < 0))
const gaps = searchView('ctr_gaps', cur, prev) as Array<Record<string, any>>
check('ctr gap found at position 3', gaps[0]?.query === 'פולי קפה' && gaps[0]?.expected_clicks === 100 && gaps[0]?.click_gap === 90, JSON.stringify(gaps[0]))
const cann = searchView('cannibalization', cur, prev) as Array<Record<string, any>>
check('cannibalization: one search, two pages', cann.length === 1 && cann[0].pages.length === 2)
const sd = searchView('striking_distance', cur, prev) as Array<Record<string, any>>
check('striking distance: positions 8–20 with 100+ impressions, biggest first', sd.length === 2 && sd[0].query === 'פולי קפה' && sd[1].query === 'מטחנה', JSON.stringify(sd))
check('expected CTR clamps', expectedCtr(0.4) === expectedCtr(1) && expectedCtr(55) === expectedCtr(10))

// ── value ──
check('value per session', valuePerSession(10000, 2000) === 5)
check('value per session: no sessions → null', valuePerSession(100, 0) === null)

// ── coverage ──
{
  const now = Date.parse('2026-11-30T09:00:00Z')
  const none = coverage({ crawl_finished_at: null, query_page_end: null, speed_ok: 0, speed_refused: 0, inspect_ok: 0, inspect_failed: 0, ga4_synced_at: null, ads_synced_at: null, ai_probe_at: null, orders_synced_at: null }, now)
  check('coverage lists all 23 areas', none.length === AUDIT_AREA_KEYS.length && none.length === 23)
  check('no data → on-page blind, with what is needed', none.find((r) => r.area === 'on_page')?.status === 'blind' && !!none.find((r) => r.area === 'on_page')?.missing)
  const full = coverage({ crawl_finished_at: '2026-11-30T03:00:00Z', query_page_end: '2026-11-29', speed_ok: 4, speed_refused: 0, inspect_ok: 50, inspect_failed: 0, ga4_synced_at: '2026-11-30T06:00:00Z', ads_synced_at: '2026-11-30T03:00:00Z', ai_probe_at: '2026-11-28T22:00:00Z', orders_synced_at: '2026-11-30T09:00:00Z' }, now)
  check('fresh data → on-page, internal links, crawl/index covered', ['on_page', 'internal_links', 'crawl_index', 'speed_mobile'].every((a) => full.find((r) => r.area === a)?.status === 'covered'))
  check('still blind without access: authority, local, shopping, other engines', ['authority', 'local', 'shopping', 'other_engines'].every((a) => full.find((r) => r.area === a)?.status === 'blind'))
  const stale = coverage({ crawl_finished_at: '2026-11-10T03:00:00Z', query_page_end: '2026-11-29', speed_ok: 0, speed_refused: 4, inspect_ok: 0, inspect_failed: 0, ga4_synced_at: null, ads_synced_at: null, ai_probe_at: null, orders_synced_at: null }, now)
  check('a 20-day-old crawl counts as blind', stale.find((r) => r.area === 'on_page')?.status === 'blind')
  check('refused speed checks say to add the API key', (stale.find((r) => r.area === 'speed_mobile')?.missing ?? '').includes('PAGESPEED_API_KEY'))
}

// ── seo_audit validation ──
{
  const good = normaliseSeoAudit({
    findings: [
      { area: 'on_page', title: 'Small', evidence: 'n', fix: 'f', effort: 'low', est_monthly_value_ils: 100, value_method: 'm' },
      { area: 'category_pages', title: 'Big', evidence: 'n', fix: 'f', effort: 'medium', est_monthly_value_ils: 900, value_method: 'm', pages: ['https://www.minuto.co.il/a/', 7] },
      { area: 'content', title: 'Unknown value', evidence: 'n', fix: 'f', effort: 'high', est_monthly_value_ils: null },
    ],
    blind_spots: [{ area: 'authority', why: 'no backlink data', needed: 'a backlink API' }],
  })
  check('valid audit accepted', good.ok)
  if (good.ok) {
    check('findings sorted by value, unknown last', good.audit.findings.map((f) => f.title).join(',') === 'Big,Small,Unknown value')
    check('non-string pages dropped', good.audit.findings[0].pages.length === 1)
  }
  const bad = normaliseSeoAudit({ findings: [{ area: 'seo', title: '', evidence: '', fix: '', effort: 'huge', est_monthly_value_ils: -5 }], blind_spots: 'none' })
  check('invalid audit refused with reasons', !bad.ok && bad.problems.length >= 5, JSON.stringify(bad))
  check('missing audit refused', !normaliseSeoAudit(undefined).ok)
  check('value without method refused', !normaliseSeoAudit({ findings: [{ area: 'on_page', title: 't', evidence: 'e', fix: 'f', effort: 'low', est_monthly_value_ils: 50 }], blind_spots: [] }).ok)
  check('empty audit is valid (nothing found, nothing blind)', normaliseSeoAudit({ findings: [], blind_spots: [] }).ok)
}

if (failures) { console.error(`\n${failures} FAILED`); Deno.exit(1) }
console.log('\nall passed')
