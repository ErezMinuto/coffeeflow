// deno run supabase/functions/strategist-brain/seo_audit_analysis_test.ts
import { productPagesToImprove,
  AUDIT_AREA_KEYS, coverage, materialSignals, crawlIssues, expectedCtr, inlinkCounts, normaliseSeoAudit, pageKey, pagesWithIssue,
  searchTotals, searchView, summarizeShopping, valuePerSession, issueCtx, citedNumbers, evidenceIndex, inEvidence, dismissalNumberProblems, PRIORITY_CATEGORY_PATH, type CrawlPage, type QpRow, sitelinkRows } from './seo_audit_analysis.ts'
import { clicksByPage } from './seo_audit_tools.ts'

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
{
  const redirected = P('https://www.minuto.co.il/product/old/', { redirects: 1, final_url: 'https://www.minuto.co.il/product-category/beans/', schema_types: ['BreadcrumbList'] })
  const withRedirect = [...pages, redirected]
  check('a redirected product counts as a redirect', pagesWithIssue(withRedirect, 'redirected_in_sitemap').some((p) => p.url.endsWith('/product/old/')))
  check('…and not as missing Product markup on the page it lands on', !pagesWithIssue(withRedirect, 'missing_product_schema').some((p) => p.url.endsWith('/product/old/')))
}
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

// ── Google Shopping (Merchant Center) ──
{
  const now = Date.parse('2026-11-30T09:00:00Z')
  const blank = { crawl_finished_at: null, query_page_end: null, speed_ok: 0, speed_refused: 0, inspect_ok: 0, inspect_failed: 0, ga4_synced_at: null, ads_synced_at: null, ai_probe_at: null, orders_synced_at: null }
  const shop = (s: Record<string, unknown>) => coverage({ ...blank, ...s }, now).find((r) => r.area === 'shopping')!
  check('shopping: fresh sync with products → covered', shop({ merchant_synced_at: '2026-11-30T03:00:00Z', merchant_products: 40 }).status === 'covered')
  check('shopping: never synced → blind, says to reconnect', shop({}).status === 'blind' && (shop({}).missing ?? '').includes('reconnects Google'))
  check('shopping: 5-day-old sync → blind, asks for a fresh sync', shop({ merchant_synced_at: '2026-11-25T03:00:00Z', merchant_products: 40 }).status === 'blind' && (shop({ merchant_synced_at: '2026-11-25T03:00:00Z', merchant_products: 40 }).missing ?? '').includes('last 3 days'))
  check('shopping: fresh but zero products → blind', shop({ merchant_synced_at: '2026-11-30T03:00:00Z', merchant_products: 0 }).status === 'blind')

  check('summarizeShopping: no rows → null', summarizeShopping([]) === null)
  const iss = (code: string, severity: string) => ({ code, severity, description: code, attribute: null })
  const r = (id: string, worst: string, issues: ReturnType<typeof iss>[], approved = true, disapproved = false) => ({ offer_id: id, title: id, link: `https://minuto.co.il/p/${id}`, worst_severity: worst, approved_anywhere: approved, disapproved_anywhere: disapproved, item_issues: issues, synced_at: '2026-11-30T03:00:00Z' })
  const sum = summarizeShopping([
    r('a', 'NOT_IMPACTED', [iss('missing_gtin', 'NOT_IMPACTED'), iss('missing_gtin', 'NOT_IMPACTED')]),
    r('b', 'DISAPPROVED', [iss('price_mismatch', 'DISAPPROVED'), iss('missing_gtin', 'NOT_IMPACTED')], false, true),
    r('c', 'NOT_IMPACTED', [iss('missing_gtin', 'NOT_IMPACTED')]),
    r('d', 'NONE', []),
  ])!
  check('summarizeShopping: totals', sum.products === 4 && sum.approved_somewhere === 3 && sum.disapproved_somewhere === 1)
  check('summarizeShopping: by worst issue', sum.by_worst_issue.disapproved === 1 && sum.by_worst_issue.warning_only === 2 && sum.by_worst_issue.none === 1)
  check('summarizeShopping: disapproval ranks before a more common warning', sum.issues[0].code === 'price_mismatch' && sum.issues[1].code === 'missing_gtin')
  check('summarizeShopping: a product counts once per issue across destinations', sum.issues[1].products === 3)
  check('summarizeShopping: examples carry the shop link', sum.issues[0].examples[0].link === 'https://minuto.co.il/p/b')
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

// ── material signals + strict audit (ctx) ──
{
  const sig = materialSignals(pages, cur, prev)
  const ids = sig.map((x) => x.id)
  check('signal: category lost 50 clicks', ids.includes('page_loss:/product-category/beans/'), ids.join(','))
  check('signal: CTR gap at position 3', ids.some((i) => i.startsWith('ctr_gap:פולי קפה|')))
  check('no page-type signal below 100 clicks before', !ids.some((i) => i.startsWith('type_loss:')))
  const big = materialSignals(pages, [Q('x', 'https://www.minuto.co.il/product-category/beans/', 60, 900, 3)], [Q('x', 'https://www.minuto.co.il/product-category/beans/', 150, 900, 3)])
  check('signal: whole page type losing clicks (150 → 60)', big.some((x) => x.id === 'type_loss:category' && x.area === 'category_pages'), big.map((x) => x.id).join(','))
  check('signal areas map by page type', sig.find((x) => x.id === 'page_loss:/product-category/beans/')?.area === 'category_pages')

  const now = Date.parse('2026-11-30T09:00:00Z')
  const cov = coverage({ crawl_finished_at: '2026-11-30T03:00:00Z', query_page_end: '2026-11-29', speed_ok: 0, speed_refused: 4, inspect_ok: 0, inspect_failed: 60, ga4_synced_at: '2026-11-30T06:00:00Z', ads_synced_at: '2026-11-30T03:00:00Z', ai_probe_at: '2026-11-28T22:00:00Z', orders_synced_at: '2026-11-30T09:00:00Z' }, now)
  const ctx = { coverage: cov, signals: sig }
  const statusOf = (a: string) => cov.find((c) => c.area === a)?.status
  const allVerdicts = (problemAreas: string[]) => AUDIT_AREA_KEYS.map((a) => ({
    area: a,
    verdict: statusOf(a) === 'blind' ? 'blind' : problemAreas.includes(a) ? 'problem' : statusOf(a) === 'partial' ? 'partial' : 'ok',
    note: 'checked',
  }))
  // The fixture's "פולי קפה" searches are coffee-beans searches our beans category does not rank for,
  // so they cannot be dismissed (must_address): the finding takes them.
  const locked = sig.filter((x) => x.must_address).map((x) => x.id)
  check('fixture: the two "פולי קפה" signals are locked', locked.length === 2 && locked.every((i) => i.includes('פולי קפה')), locked.join(','))
  const finding = { area: 'category_pages', title: 'Beans category losing clicks', evidence: '60 → 10', fix: 'rewrite', effort: 'low', est_monthly_value_ils: 500, value_method: 'm', signals: ['page_loss:/product-category/beans/', ...locked] }
  const rest = sig.filter((x) => !finding.signals.includes(x.id)).map((x) => ({ id: x.id, reason: 'too small this week' }))

  const good = normaliseSeoAudit({ findings: [finding], blind_spots: [], area_verdicts: allVerdicts(['category_pages']), dismissed_signals: rest }, ctx)
  check('complete audit accepted', good.ok, good.ok ? '' : good.problems.join(' | '))
  if (good.ok) {
    check('blind areas added by code', ['authority', 'local', 'shopping', 'other_engines'].every((a) => good.audit.blind_spots.some((b) => b.area === a)))
    check('partial gaps added too (speed refused)', good.audit.blind_spots.some((b) => b.area === 'speed_mobile' && b.needed.includes('PAGESPEED_API_KEY')))
    check('signals counted', good.audit.signals_checked === sig.length)
  }
  const unanswered = normaliseSeoAudit({ findings: [finding], blind_spots: [], area_verdicts: allVerdicts(['category_pages']), dismissed_signals: [] }, ctx)
  check('unanswered signals refused', !unanswered.ok && unanswered.problems.some((p) => p.includes('not answered')))
  const missingArea = normaliseSeoAudit({ findings: [finding], blind_spots: [], area_verdicts: allVerdicts(['category_pages']).slice(1), dismissed_signals: rest }, ctx)
  check('a missing area verdict refused', !missingArea.ok && missingArea.problems.some((p) => p.includes('missing')))
  const blindClaimedOk = normaliseSeoAudit({ findings: [finding], blind_spots: [], area_verdicts: allVerdicts(['category_pages']).map((v) => v.area === 'authority' ? { ...v, verdict: 'ok' } : v), dismissed_signals: rest }, ctx)
  check("can't call a blind area ok", !blindClaimedOk.ok && blindClaimedOk.problems.some((p) => p.includes('authority')))
  const problemNoFinding = normaliseSeoAudit({ findings: [finding], blind_spots: [], area_verdicts: allVerdicts(['category_pages', 'on_page']), dismissed_signals: rest }, ctx)
  check("'problem' area needs a finding", !problemNoFinding.ok && problemNoFinding.problems.some((p) => p.includes("on_page is 'problem'")))
  const partialOk = normaliseSeoAudit({ findings: [finding], blind_spots: [], area_verdicts: allVerdicts(['category_pages']).map((v) => v.area === 'speed_mobile' ? { ...v, verdict: 'ok' } : v), dismissed_signals: rest }, ctx)
  check("can't call a partly visible area 'ok'", !partialOk.ok && partialOk.problems.some((p) => p.includes('speed_mobile') && p.includes('partly visible')))
  const coveredPartial = normaliseSeoAudit({ findings: [finding], blind_spots: [], area_verdicts: allVerdicts(['category_pages']).map((v) => v.area === 'on_page' ? { ...v, verdict: 'partial' } : v), dismissed_signals: rest }, ctx)
  check("a fully visible area can't be 'partial'", !coveredPartial.ok && coveredPartial.problems.some((p) => p.includes('on_page')))
  check('competitors and site changes are honest blind spots', statusOf('competitors') === 'blind' && statusOf('site_changes') === 'blind')

  // Look before you dismiss.
  const crawlIds = rest.filter((d) => d.id.startsWith('crawl:'))
  check('test data has crawl signals to dismiss', crawlIds.length > 0)
  const notLooked = normaliseSeoAudit({ findings: [finding], blind_spots: [], area_verdicts: allVerdicts(['category_pages']), dismissed_signals: rest }, { ...ctx, toolCalls: [{ name: 'get_seo_audit_overview', input: {} }] })
  check('dismissing a crawl issue without opening its pages is refused', !notLooked.ok && notLooked.problems.some((p) => p.includes('without looking')))
  const looked = normaliseSeoAudit({ findings: [finding], blind_spots: [], area_verdicts: allVerdicts(['category_pages']), dismissed_signals: rest }, { ...ctx, toolCalls: crawlIds.map((d) => ({ name: 'get_seo_issue_pages', input: { issue: d.id.slice('crawl:'.length) } })) })
  check('dismissing after opening the pages is accepted', looked.ok, looked.ok ? '' : looked.problems.join(' | '))
  check('crawl signal text includes the page-type mix', sig.filter((x) => x.kind === 'crawl_issue').every((x) => /\(\d+ \w+/.test(x.summary)), sig.filter((x) => x.kind === 'crawl_issue').map((x) => x.summary).join(' / '))

  const findingInOkArea = normaliseSeoAudit({ findings: [finding], blind_spots: [], area_verdicts: allVerdicts([]), dismissed_signals: rest }, ctx)
  check("finding in an 'ok' area refused", !findingInOkArea.ok)
  const unpriced = normaliseSeoAudit({ findings: [{ ...finding, est_monthly_value_ils: undefined, value_method: '' }], blind_spots: [], area_verdicts: allVerdicts(['category_pages']), dismissed_signals: rest }, ctx)
  check('unpriced finding without a reason refused', !unpriced.ok && unpriced.problems.some((p) => p.includes('no_value_reason')))
  const unpricedOk = normaliseSeoAudit({ findings: [{ ...finding, est_monthly_value_ils: undefined, value_method: '', no_value_reason: 'no traffic data for these pages' }], blind_spots: [], area_verdicts: allVerdicts(['category_pages']), dismissed_signals: rest }, ctx)
  check('unpriced finding with a reason accepted', unpricedOk.ok)
  const bogus = normaliseSeoAudit({ findings: [finding], blind_spots: [], area_verdicts: allVerdicts(['category_pages']), dismissed_signals: [...rest, { id: 'made-up', reason: 'x' }] }, ctx)
  check('unknown signal id ignored, not refused', bogus.ok)
  const blindFinding = normaliseSeoAudit({ findings: [finding, { ...finding, area: 'authority', title: 'Backlinks', signals: [] }], blind_spots: [], area_verdicts: allVerdicts(['category_pages']), dismissed_signals: rest }, ctx)
  check('a finding in a blind area is refused with a clear message', !blindFinding.ok && blindFinding.problems.some((p) => p.includes('cannot have findings')))
}

// ── Memoized crawl-check inputs (one strategist step can ask for a dozen issue lists) ──
{
  check('issueCtx: same pages array → same cached object', issueCtx(pages) === issueCtx(pages))
  const copy = pages.map((p) => ({ ...p }))
  check('issueCtx: a different array is computed afresh', issueCtx(copy) !== issueCtx(pages))
  const ids = ['orphan', 'missing_h1', 'duplicate_title', 'duplicate_description', 'missing_product_schema']
  const urls = (ps: CrawlPage[], id: string) => pagesWithIssue(ps, id).map((p) => p.url).join('|')
  check('cached and fresh inputs give identical issue lists', ids.every((id) => urls(pages, id) === urls(copy, id)))
  check('repeated calls give identical results', ids.every((id) => urls(pages, id) === urls(pages, id)) && JSON.stringify(crawlIssues(pages)) === JSON.stringify(crawlIssues(pages)))
  // A changed site is a new array: the cache must not leak the old answer.
  const linked = [...copy, { ...copy[0], url: 'https://minuto.co.il/linker/', page_type: 'other', internal_links: [...copy.map((p) => p.url)] } as CrawlPage]
  check('new array with a link to the orphan → it is no longer an orphan', urls(pages, 'orphan').includes('/blog/x/') && !urls(linked, 'orphan').includes('/blog/x/'))
  const big = Array.from({ length: 3000 }, (_, i) => ({ ...pages[0], url: `https://minuto.co.il/p/${i}/`, title: `t${i % 50}`, internal_links: [`https://minuto.co.il/p/${(i + 1) % 3000}/`] }) as CrawlPage)
  pagesWithIssue(big, 'orphan')
  const t0 = performance.now(); for (const id of ids.concat(ids, ids)) pagesWithIssue(big, id)
  const ms = performance.now() - t0
  check('15 issue lists on 3,000 pages after the first stay cheap (< 300 ms)', ms < 300, `${Math.round(ms)} ms`)

  const rows: QpRow[] = [
    { query: 'a', page: 'https://minuto.co.il/x/', clicks: 2, impressions: 10, position: 3 },
    { query: 'b', page: 'https://minuto.co.il/x', clicks: 3, impressions: 5, position: 4 },
    { query: 'c', page: 'https://minuto.co.il/y/', clicks: 1, impressions: 1, position: 9 },
  ]
  const m = clicksByPage(rows)
  check('clicksByPage sums all searches of one page', m.get(pageKey('https://minuto.co.il/x/'))?.clicks === 5 && m.get(pageKey('https://minuto.co.il/x/'))?.impressions === 15)
  check('clicksByPage: same rows → same cached map', clicksByPage(rows) === m)
  check('clicksByPage: other rows → computed afresh', clicksByPage(rows.slice(0, 1)).get(pageKey('https://minuto.co.il/x/'))?.clicks === 2)
}

// ── Priority: coffee-beans searches cannot be dismissed while the beans category ranks badly ──
{
  const beans = 'https://www.minuto.co.il' + encodeURI(PRIORITY_CATEGORY_PATH)
  const blog = 'https://www.minuto.co.il/blog/%D7%9B%D7%9C-%D7%9E%D7%94/'
  // The real case from the third audit: blog post at 10.4 with 2,533 impressions, beans category at 33.5.
  const real = [Q('פולי קפה', blog, 2, 2533, 10.4), Q('פולי קפה', beans, 0, 53, 33.5), Q('מטחנה', 'https://www.minuto.co.il/product/a/', 5, 900, 12)]
  const s1 = materialSignals(pages, real, [])
  const st = s1.find((x) => x.id.startsWith('striking:פולי קפה|/blog/'))
  check('real case: "פולי קפה" striking signal exists', !!st, s1.map((x) => x.id).join(','))
  check('real case: it is locked, naming the category position', !!st?.must_address && st.must_address.includes('33.5'), st?.must_address ?? '')
  check('a non-beans search is not locked', !s1.find((x) => x.id.startsWith('striking:מטחנה'))?.must_address)
  check('locked signals come first (never cut by the 50 cap)', s1[0].must_address !== undefined)
  // Once the beans category is in the top 3 for the search, the same signal may be dismissed.
  const s2 = materialSignals(pages, [Q('פולי קפה', blog, 2, 2533, 10.4), Q('פולי קפה', beans, 300, 3000, 2.4)], [])
  check('beans category in the top 3 → not locked', s2.filter((x) => x.id.includes('פולי קפה')).every((x) => !x.must_address), JSON.stringify(s2.map((x) => [x.id, x.must_address])))
  const sub = 'https://www.minuto.co.il' + encodeURI(PRIORITY_CATEGORY_PATH + 'ברזיל/')
  const s3 = materialSignals(pages, [Q('פולי קפה ברזיל', blog, 1, 900, 9), Q('פולי קפה ברזיל', sub, 40, 900, 2)], [])
  check('a beans sub-category in the top 3 counts as the category', s3.filter((x) => x.id.includes('ברזיל')).every((x) => !x.must_address))
  check('English "coffee beans" search is priority too', !!materialSignals(pages, [Q('Coffee Beans Israel', blog, 1, 900, 9)], []).find((x) => x.id.startsWith('striking:'))?.must_address)
  // The lock states how much text the category has next to the page Google shows instead.
  const withWords: CrawlPage[] = [...pages,
    { url: beans, final_url: beans, status: 200, page_type: 'category', word_count: 900, category_text_words: 43 } as CrawlPage,
    { url: blog, final_url: blog, status: 200, page_type: 'post', word_count: 748 } as CrawlPage]
  const sw = materialSignals(withWords, real, []).find((x) => x.id.startsWith('striking:פולי קפה|/blog/'))
  check('lock names the category text words and the competing page words', !!sw?.must_address && sw.must_address.includes('43 words of its own text') && sw.must_address.includes('748 words'), sw?.must_address ?? '')
  check('without word data the lock still works (no word facts)', !!st?.must_address && !st.must_address.includes('words of its own text'))
  const loss = materialSignals(pages, [Q('x', beans, 10, 500, 5)], [Q('x', beans, 80, 500, 5)])
  check('a coffee-beans page losing clicks is locked', !!loss.find((x) => x.id.startsWith('page_loss:' + PRIORITY_CATEGORY_PATH))?.must_address, loss.map((x) => x.id).join(','))
}

// ── Sitelinks and our own brand ad (real case, 28 days to 2026-11-23) ──
{
  const H = 'https://www.minuto.co.il'
  const brand = [Q('מינוטו קפה', H + '/', 38, 600, 2.0), Q('מינוטו קפה', H + '/about/', 2, 585, 2.2), Q('מינוטו קפה', H + '/shop/', 5, 583, 2.0),
    Q('מינוטו קפה', H + '/contact/', 1, 577, 2.1), Q('מינוטו קפה', H + encodeURI('/product-category/פולי-קפה/'), 3, 582, 2.1)]
  brand.push(Q('מינוטו קפה', H + encodeURI('/product/פולי-קפה-טרי-ספשלטי-קפה-מינוטו-אינטנסו/'), 0, 355, 2.6), Q('מינוטו קפה', H + encodeURI('/product/פולי-קפה-טרי-ספשלטי-קפה-מינוטו-פרסטיז-mi/'), 0, 312, 2.0))
  const links = sitelinkRows(brand)
  check('sitelinks: about/shop/contact/category and rotating product links under the homepage are sitelinks', links.size === 6 && links.has('מינוטו קפה|/about/') && links.has('מינוטו קפה|/product/פולי-קפה-טרי-ספשלטי-קפה-מינוטו-אינטנסו/') && !links.has('מינוטו קפה|/'), [...links].join(','))
  check('sitelinks: no homepage row → none', sitelinkRows(brand.slice(1)).size === 0)
  check('sitelinks: rarely shown pages (<20% of homepage impressions) are not sitelinks', sitelinkRows([Q('x', H + '/', 10, 600, 2), Q('x', H + '/a/', 1, 100, 2), Q('x', H + '/b/', 1, 90, 2.1)]).size === 0)
  check('sitelinks: a page at a different position is a separate result', sitelinkRows([Q('x', H + '/', 10, 600, 2), Q('x', H + '/a/', 1, 500, 4), Q('x', H + '/b/', 1, 550, 3.5)]).size === 0)
  const sig = materialSignals(pages, brand, [])
  check('sitelinks do not raise a cannibalization signal', !sig.some((x) => x.id === 'cannibal:מינוטו קפה'), sig.map((x) => x.id).join(','))
  check('sitelinks do not raise CTR gaps for about/shop/contact', !sig.some((x) => x.id.startsWith('ctr_gap:מינוטו קפה|/about/') || x.id.startsWith('ctr_gap:מינוטו קפה|/contact/')))
  check('without ad data the homepage CTR gap is still raised (90 expected, 38 got)', sig.some((x) => x.id === 'ctr_gap:מינוטו קפה|/'), sig.map((x) => x.id).join(','))
  const withAd = materialSignals(pages, brand, [], new Map([['מינוטו קפה', { clicks: 199, impressions: 626 }]]))
  check('our own ad\'s 199 clicks cover the homepage gap → no CTR signal', !withAd.some((x) => x.id === 'ctr_gap:מינוטו קפה|/'), withAd.map((x) => x.id).join(','))
  const small = materialSignals(pages, [Q('y', H + '/p/', 10, 1000, 2)], [], new Map([['y', { clicks: 20, impressions: 50 }]]))
  const g = small.find((x) => x.id === 'ctr_gap:y|/p/')
  check('a gap bigger than our ad clicks stays, net of them, and says so', !!g && g.size === 120 && g.summary.includes('own Google Ads ad'), JSON.stringify(g))
  const cann = searchView('cannibalization', [...brand, Q('מינוטו קפה', H + '/blog/x/', 5, 300, 6)], []) as Array<{ query: string; pages: unknown[] }>
  check('real competing page next to sitelinks still counts as cannibalization', cann.some((c) => c.query === 'מינוטו קפה' && c.pages.length === 2), JSON.stringify(cann))
}

// ── Product pages the weekly run may improve ──
{
  const H = 'https://www.minuto.co.il/product/'
  const prods = [
    { woo_id: 1, name: 'thin, busy', permalink: H + 'a/', description: '<p>' + 'מילה '.repeat(60) + '</p>', stock_status: 'instock', catalog_visibility: 'visible' },
    { woo_id: 2, name: 'thin, quiet', permalink: H + 'b/', description: '<p>קצר</p>', stock_status: 'instock', catalog_visibility: 'visible' },
    { woo_id: 3, name: 'full', permalink: H + 'c/', description: '<p>' + 'מילה '.repeat(250) + '</p>', stock_status: 'instock', catalog_visibility: 'visible' },
    { woo_id: 4, name: 'out of stock', permalink: H + 'd/', description: '<p>קצר</p>', stock_status: 'outofstock', catalog_visibility: 'visible' },
    { woo_id: 5, name: 'hidden', permalink: H + 'e/', description: '<p>קצר</p>', stock_status: 'instock', catalog_visibility: 'hidden' },
    { woo_id: 6, name: 'changed recently', permalink: H + 'f/', description: '<p>קצר</p>', stock_status: 'instock', catalog_visibility: 'visible' },
    { woo_id: 7, name: 'thin, busier', permalink: H + 'g/', description: '<p>קצר</p>', stock_status: 'instock', catalog_visibility: 'visible' },
  ]
  const clicks = new Map([['/product/a/', { clicks: 2, impressions: 100 }], ['/product/b/', { clicks: 0, impressions: 5 }], ['/product/c/', { clicks: 0, impressions: 500 }],
    ['/product/d/', { clicks: 0, impressions: 500 }], ['/product/e/', { clicks: 0, impressions: 500 }], ['/product/f/', { clicks: 0, impressions: 500 }], ['/product/g/', { clicks: 1, impressions: 300 }]])
  const got = productPagesToImprove(prods, clicks, new Set([6]))
  check('product candidates: thin, in stock, visible, demand >= 20, not recently changed, busiest first', got.map((p) => p.name).join('|') === 'thin, busier|thin, busy', JSON.stringify(got.map((p) => p.name)))
  check('product candidates carry words and impressions', got[1].description_words === 60 && got[1].impressions === 100)
}

// ── Numbers in a dismissal must come from the data ──
{
  const n = (t: string) => citedNumbers(t).map((c) => [c.value, c.lo, c.hi, c.percent])
  check('cited: digits inside names are not numbers', citedNumbers('our hero product (Oak8) and the Mara X PL62X').length === 0, JSON.stringify(citedNumbers('our hero product (Oak8) and the Mara X PL62X')))
  check('cited: a name with digits does not satisfy the number rule', dismissalNumberProblems('Acceptable split with Oak8.', evidenceIndex([8]))[0]?.includes('no number'))
  check('cited: a unit glued on still counts (316 SKUs, 4k)', citedNumbers('316 SKUs').length === 1 && citedNumbers('4k visits')[0]?.value === 4000)
  check('cited: time windows are periods, not claims', citedNumbers('in 28 days, 90d, 4 weeks').every((c) => c.period))
  check('only a time window → refused (cites no count)', dismissalNumberProblems('nothing in 28 days', evidenceIndex({})).length === 1)
  check('cited: comma thousands', JSON.stringify(n('1,051 pages')) === JSON.stringify([[1051, 1050.5, 1051.5, false]]))
  check('cited: "4+ million" means 4M–5M', JSON.stringify(n('4+ million impressions')) === JSON.stringify([[4e6, 4e6, 5e6, false]]))
  check('cited: decimal keeps its precision', (() => { const c = citedNumbers('pos 10.6')[0]; return Math.abs(c.lo - 10.55) < 1e-9 && Math.abs(c.hi - 10.65) < 1e-9 })())
  check('cited: percent flagged', citedNumbers('a 15% drop')[0].percent)
  check('cited: "1000+" means 1000–2000', JSON.stringify(n('1000+ files')) === JSON.stringify([[1000, 1000, 2000, false]]))
  check('cited: "4.2k" → 4,200 ± 50', JSON.stringify(n('4.2k')) === JSON.stringify([[4200, 4150, 4250, false]]))

  const idx = evidenceIndex({ total: 1051, position: 9.1, clicks: 29, impressions: 2533, ads: 337, change: -29 })
  // Identifiers, raw units, URLs and dates are not evidence (a UUID fragment once "proved" 4 million).
  const noise = evidenceIndex({ id: 'c4845111-12a9-4f00-8000-000000000001', run_id: 4500000, cost_micros: 4500000, synced_at: '2026-11-23T18:47:51Z',
    note: 'see https://www.minuto.co.il/p/4400000/ on 2026-04-27, ref c4845111-12a9-4f00-8000-000000000002', summary: '"פולי קפה" (2,533 impressions) split across 2 pages' })
  check('evidence: ids, micros, URLs, dates and UUIDs ignored', !inEvidence(noise, 1e6, 1e10) && !inEvidence(noise, 2026, 2026), Array.from(noise).join(','))
  check('evidence: numbers written in text kept (2,533)', inEvidence(noise, 2533, 2533) && inEvidence(noise, 2, 2))
  check('evidence: JSON-text tool results are parsed (ids inside skipped)', !inEvidence(evidenceIndex(JSON.stringify({ campaign_id: 4500000, n: 7 })), 4e6, 5e6) && inEvidence(evidenceIndex(JSON.stringify({ n: 7 })), 7, 7))
  check('evidence: range lookup', inEvidence(idx, 2533, 2533) && !inEvidence(idx, 2534, 2600))
  check('no number → refused', dismissalNumberProblems('Standard WooCommerce bloat.', idx)[0]?.includes('no number'))
  check('only a percentage → refused (cites no count)', dismissalNumberProblems('drop of 15%', idx).length === 1)
  check('the real "4+ million" claim against real ad numbers → refused', dismissalNumberProblems('We dominate via Google Ads (4+ million impressions).', idx)[0]?.includes('4+ million'))
  check('"1000+ files" against 1,051 → accepted', dismissalNumberProblems('Bulk issue across 1000+ files', idx).length === 0)
  check('"pos 9" against 9.1 → accepted', dismissalNumberProblems('4 clicks expected at pos 9... ', evidenceIndex([4, 9.1])).length === 0)
  check('"29 clicks" against a −29 change → accepted', dismissalNumberProblems('Small drop (29 clicks).', idx).length === 0)
  check('one bad number among good ones → refused, naming it', dismissalNumberProblems('2533 impressions, 2 clicks, 7,170 more', idx)[0]?.includes('7,170'))

  // Through normaliseSeoAudit: only dismissals of real signals are checked.
  const sig = [{ id: 'crawl:orphan', kind: 'crawl_issue', area: 'internal_links' as const, summary: '212 pages', size: 212 }]
  const cov = coverage({ crawl_finished_at: '2026-11-30T03:00:00Z', query_page_end: '2026-11-29', speed_ok: 4, speed_refused: 0, inspect_ok: 50, inspect_failed: 0, ga4_synced_at: '2026-11-30T06:00:00Z', ads_synced_at: '2026-11-30T03:00:00Z', ai_probe_at: '2026-11-28T22:00:00Z', orders_synced_at: '2026-11-30T09:00:00Z' }, Date.parse('2026-11-30T09:00:00Z'))
  const verdicts = AUDIT_AREA_KEYS.map((a) => { const st = cov.find((c) => c.area === a)?.status; return { area: a, verdict: st === 'blind' ? 'blind' : st === 'partial' ? 'partial' : 'ok', note: 'checked' } })
  const looked = [{ name: 'get_seo_issue_pages', input: { issue: 'orphan' } }]
  const ev = evidenceIndex('{"total":212,"organic_sessions_28d":3}')   // a tool result as stored: JSON text
  const audit = (reason: string, extra: unknown[] = []) => normaliseSeoAudit({ findings: [], blind_spots: [], area_verdicts: verdicts, dismissed_signals: [{ id: 'crawl:orphan', reason }, ...extra] }, { coverage: cov, signals: sig, toolCalls: looked, evidence: ev })
  const vague = audit('Mostly old pages or minor accessory products.')
  check('vague dismissal refused through conclude', !vague.ok && vague.problems.some((p) => p.includes('crawl:orphan') && p.includes('no number')))
  const grounded = audit('212 pages, together 3 organic sessions in 28 days')
  check('grounded dismissal accepted', grounded.ok, grounded.ok ? '' : grounded.problems.join(' | '))
  check('an unknown signal id is not number-checked', audit('212 pages', [{ id: 'old:gone', reason: 'no numbers here' }]).ok)
  const noEvidence = normaliseSeoAudit({ findings: [], blind_spots: [], area_verdicts: verdicts, dismissed_signals: [{ id: 'crawl:orphan', reason: 'vague' }] }, { coverage: cov, signals: sig, toolCalls: looked })
  check('without evidence in ctx the number check is skipped (unit callers)', noEvidence.ok)
}

// ── Discontinued products and listings Google cannot page through ──
{
  const live = (url: string, o: Partial<CrawlPage> = {}) => P(url, o)
  const ps: CrawlPage[] = [
    live('https://www.minuto.co.il/', { page_type: 'home', internal_links: ['/product-category/beans/'] }),
    live('https://www.minuto.co.il/product-category/beans/', { page_type: 'category', listing_issue: 'no_page_links', listing_pages: 0, internal_links: ['/product/sold/'] }),
    live('https://www.minuto.co.il/product-category/ok/', { page_type: 'category', listing_issue: null, listing_pages: 5 }),
    live('https://www.minuto.co.il/product/sold/'),
    live('https://www.minuto.co.il/product/gone-open/', { catalog_hidden: true }),
    live('https://www.minuto.co.il/product/gone-closed/', { catalog_hidden: true, robots_meta: 'noindex, follow' }),
    live('https://www.minuto.co.il/product/forgotten/'),
  ]
  const ids = (issue: string) => pagesWithIssue(ps, issue).map((p) => p.url.replace('https://www.minuto.co.il', ''))
  check('a hidden product is not called an orphan', !ids('orphan').includes('/product/gone-open/') && !ids('orphan').includes('/product/gone-closed/'))
  check('a visible product nobody links to is still an orphan', ids('orphan').includes('/product/forgotten/'))
  check('hidden product Google can index → reported', JSON.stringify(ids('hidden_product_indexable')) === JSON.stringify(['/product/gone-open/']), JSON.stringify(ids('hidden_product_indexable')))
  check('hidden product already noindex → not reported', !ids('hidden_product_indexable').includes('/product/gone-closed/'))
  check('category Google cannot page through → reported', JSON.stringify(ids('listing_not_crawlable')) === JSON.stringify(['/product-category/beans/']))
  const sig = materialSignals(ps, [], [])
  check('one broken listing is a material signal (below the usual 5)', sig.some((x) => x.id === 'crawl:listing_not_crawlable'), sig.map((x) => x.id).join(','))
  check('one open discontinued product is a material signal', sig.some((x) => x.id === 'crawl:hidden_product_indexable'))
  check('crawl pages without the new fields behave as before', !pagesWithIssue(pages, 'listing_not_crawlable').length && !pagesWithIssue(pages, 'hidden_product_indexable').length)
}

if (failures) { console.error(`\n${failures} FAILED`); Deno.exit(1) }
console.log('\nall passed')
