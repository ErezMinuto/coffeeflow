#!/usr/bin/env node
// Weekly crawl of minuto.co.il for the SEO agent's audit (build plan, Phase 1).
// Run by .github/workflows/seo-audit-weekly.yml.
//
//   1. robots.txt + every sitemap → every URL the site asks Google to index
//   2. fetch each page (4 at a time, polite user agent) → site_crawl_pages
//   3. Google PageSpeed for the busiest page of each type → page_speed
//   4. Google's index status for the pages that earn money → gsc_url_inspection
//      (through the google-search-sync edge function, which holds the Google login)
//
// Reads/writes Supabase with SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.
// Optional PAGESPEED_API_KEY (sent as a header); without it Google may refuse
// PageSpeed requests, and the audit reports speed as a blind spot.
//
// The repository is public, so this prints counts only: never page content,
// traffic or business numbers.
//
//   node scripts/seo/crawl.mjs              full run
//   node scripts/seo/crawl.mjs --dry-run    crawl 20 URLs, write nothing

import { extractPage, isSitemapIndex, mapLimit, pageType, robotsSitemaps, sitemapLocs } from './crawl_lib.mjs'

const SITE = (process.env.SITE_URL || 'https://www.minuto.co.il').replace(/\/+$/, '')
const SITE_HOST = new URL(SITE).host
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '')
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
const PSI_KEY = process.env.PAGESPEED_API_KEY || ''
const DRY = process.argv.includes('--dry-run')
const UA = 'Mozilla/5.0 (compatible; MinutoSEOAudit/1.0; +https://www.minuto.co.il/)'
const MAX_URLS = 4000
const KEEP_DAYS = 60

if (!DRY && (!SUPABASE_URL || !KEY)) { console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing'); process.exit(1) }

async function db(path, init = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Prefer: init.prefer ?? 'return=minimal' },
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`db ${init.method ?? 'GET'} ${path.split('?')[0]} → ${res.status}`)
  return text ? JSON.parse(text) : null
}

/** Every row of a query, 1,000 at a time: PostgREST caps one response at its max-rows (1,000). */
async function dbAll(path, { pageSize = 1000, maxRows = 200000 } = {}) {
  const out = []
  for (;;) {
    const sep = path.includes('?') ? '&' : '?'
    const rows = await db(`${path}${sep}limit=${pageSize}&offset=${out.length}`)
    out.push(...(rows ?? []))
    if (!rows || rows.length < pageSize) return out
    if (out.length >= maxRows) throw new Error(`more than ${maxRows} rows for ${path.split('?')[0]}`)
  }
}

async function get(url, { timeoutMs = 20000 } = {}) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/xml;q=0.9,*/*;q=0.8' }, redirect: 'manual', signal: ctrl.signal })
  } finally { clearTimeout(t) }
}

/** Follows up to 5 redirects by hand, so the count and the final URL are known. */
async function fetchPage(url) {
  const started = Date.now()
  let current = url
  for (let hops = 0; hops <= 5; hops++) {
    const res = await get(current)
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      await res.body?.cancel()
      current = new URL(res.headers.get('location'), current).href
      continue
    }
    const html = (res.headers.get('content-type') || '').includes('html') ? await res.text() : (await res.body?.cancel(), '')
    return { status: res.status, final_url: current, redirects: hops, html, x_robots_tag: res.headers.get('x-robots-tag'), response_ms: Date.now() - started }
  }
  return { status: 0, final_url: current, redirects: 6, html: '', x_robots_tag: null, response_ms: Date.now() - started, error: 'more than 5 redirects' }
}

async function collectUrls() {
  const robotsRes = await get(`${SITE}/robots.txt`)
  const robotsTxt = robotsRes.ok ? await robotsRes.text() : ''
  const roots = robotsSitemaps(robotsTxt)
  if (!roots.length) roots.push(`${SITE}/sitemap_index.xml`)
  const urls = new Map()       // url → sitemap it came from
  const sitemaps = []
  const queue = [...roots]
  const seen = new Set()
  while (queue.length && seen.size < 50) {
    const sm = queue.shift()
    if (seen.has(sm)) continue
    seen.add(sm)
    const res = await get(sm).catch(() => null)
    if (!res?.ok) { sitemaps.push({ url: sm, urls: 0, error: `HTTP ${res?.status ?? 'fetch failed'}` }); continue }
    const xml = await res.text()
    const locs = sitemapLocs(xml)
    if (isSitemapIndex(xml)) { queue.push(...locs); continue }
    sitemaps.push({ url: sm, urls: locs.length })
    for (const u of locs) if (!urls.has(u) && urls.size < MAX_URLS) urls.set(u, sm)
  }
  return { robotsTxt, sitemaps, urls }
}

async function pageSpeed(url, page_type) {
  const api = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&strategy=mobile&category=performance`
  try {
    const res = await fetch(api, { headers: PSI_KEY ? { 'X-goog-api-key': PSI_KEY } : {}, signal: AbortSignal.timeout(90000) })
    const j = await res.json().catch(() => ({}))
    if (!res.ok) return { url, page_type, error: `HTTP ${res.status}: ${String(j?.error?.message ?? '').slice(0, 200)}` }
    const a = j.lighthouseResult?.audits ?? {}
    const f = j.loadingExperience?.metrics ?? {}
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null)
    return {
      url, page_type, strategy: 'mobile',
      performance_score: j.lighthouseResult?.categories?.performance?.score ?? null,
      lcp_ms: num(a['largest-contentful-paint']?.numericValue),
      cls: a['cumulative-layout-shift']?.numericValue ?? null,
      tbt_ms: num(a['total-blocking-time']?.numericValue),
      field_lcp_p75_ms: num(f.LARGEST_CONTENTFUL_PAINT_MS?.percentile),
      field_inp_p75_ms: num(f.INTERACTION_TO_NEXT_PAINT?.percentile),
      field_cls_p75: typeof f.CUMULATIVE_LAYOUT_SHIFT_SCORE?.percentile === 'number' ? f.CUMULATIVE_LAYOUT_SHIFT_SCORE.percentile / 100 : null,
      field_category: j.loadingExperience?.overall_category ?? null,
    }
  } catch (e) {
    return { url, page_type, error: String(e?.message ?? e).slice(0, 200) }
  }
}

/** The busiest organic landing page of each type (GA4, last 28 days), plus the homepage. */
async function speedTargets(pages) {
  const byPath = new Map(pages.filter((p) => p.status === 200).map((p) => [new URL(p.url).pathname, p]))
  const since = new Date(Date.now() - 28 * 864e5).toISOString().slice(0, 10)
  const rows = await dbAll(`ga4_pages_daily?select=page_path,sessions&channel_group=eq.Organic%20Search&date=gte.${since}&order=date,page_path`).catch(() => [])
  const sessions = new Map()
  for (const r of rows ?? []) sessions.set(r.page_path, (sessions.get(r.page_path) ?? 0) + (r.sessions ?? 0))
  const best = new Map()
  for (const [path, s] of [...sessions].sort((a, b) => b[1] - a[1])) {
    const p = byPath.get(path)
    if (p && !best.has(p.page_type)) best.set(p.page_type, p)
  }
  const home = pages.find((p) => p.page_type === 'home' && p.status === 200)
  if (home) best.set('home', home)
  return [...best.values()].slice(0, 6)
}

/** Pages worth asking Google about: every category, then the pages with the most search clicks. */
async function inspectTargets(pages) {
  const cats = pages.filter((p) => p.page_type === 'category' && p.status === 200).map((p) => p.url)
  const since = new Date(Date.now() - 28 * 864e5).toISOString().slice(0, 10)
  const rows = await dbAll(`google_search_console?select=page,clicks&keyword=eq.__page__&date=gte.${since}&order=date,page`).catch(() => [])
  const clicks = new Map()
  for (const r of rows ?? []) if (r.page) clicks.set(r.page, (clicks.get(r.page) ?? 0) + (r.clicks ?? 0))
  const top = [...clicks].sort((a, b) => b[1] - a[1]).map(([u]) => u)
  return [...new Set([...cats.slice(0, 30), ...top])].slice(0, 60)
}

let crawlId = null

async function main() {
  const { robotsTxt, sitemaps, urls } = await collectUrls()
  let list = [...urls.entries()]
  if (DRY) list = list.slice(0, 20)
  console.log(`sitemaps: ${sitemaps.length}, urls: ${urls.size}${DRY ? ' (dry run: 20)' : ''}`)

  if (!DRY) {
    const [row] = await db('site_crawls?select=id', { method: 'POST', prefer: 'return=representation', body: JSON.stringify({ robots_txt: robotsTxt.slice(0, 20000), sitemaps }) })
    crawlId = row.id
  }

  const pages = await mapLimit(list, 4, async ([url, sm]) => {
    const base = { crawl_id: crawlId, url, page_type: pageType(url, sm), in_sitemap: true }
    try {
      const r = await fetchPage(url)
      const extracted = r.html ? extractPage(r.html, r.final_url, SITE_HOST) : {}
      return { ...base, status: r.status, final_url: r.final_url, redirects: r.redirects, x_robots_tag: r.x_robots_tag, response_ms: r.response_ms, html_bytes: r.html.length, error: r.error ?? null, ...extracted }
    } catch (e) {
      return { ...base, status: 0, error: String(e?.message ?? e).slice(0, 300) }
    }
  })
  const ok = pages.filter((p) => p.status === 200).length
  console.log(`pages fetched: ${pages.length}, ok: ${ok}, not ok: ${pages.length - ok}`)

  if (DRY) { console.log('dry run: nothing written'); return }

  for (let i = 0; i < pages.length; i += 200) {
    await db('site_crawl_pages', { method: 'POST', body: JSON.stringify(pages.slice(i, i + 200)) })
  }
  await db(`site_crawls?id=eq.${crawlId}`, { method: 'PATCH', body: JSON.stringify({ status: 'done', finished_at: new Date().toISOString(), urls_total: pages.length, urls_ok: ok, urls_error: pages.length - ok }) })

  // Page speed: a handful of URLs, one at a time (Google rate-limits).
  const speed = []
  for (const p of await speedTargets(pages)) speed.push(await pageSpeed(p.url, p.page_type))
  if (speed.length) await db('page_speed', { method: 'POST', body: JSON.stringify(speed) })
  console.log(`page speed: ${speed.length} measured, ${speed.filter((s) => s.error).length} refused`)

  // Index status, through the edge function that holds the Google login.
  const targets = await inspectTargets(pages)
  if (targets.length) {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/google-search-sync`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'inspect', urls: targets }),
      signal: AbortSignal.timeout(170000),
    }).catch((e) => ({ ok: false, status: 0, json: async () => ({ error: String(e) }) }))
    const j = await res.json().catch(() => ({}))
    console.log(`index status: HTTP ${res.status}, inspected ${j.records ?? 0}, failed ${j.failed ?? '?'}`)
  }

  // Keep two months of crawls.
  const cutoff = new Date(Date.now() - KEEP_DAYS * 864e5).toISOString()
  await db(`site_crawls?started_at=lt.${cutoff}`, { method: 'DELETE' })
}

main().catch(async (e) => {
  const msg = String(e?.message ?? e).slice(0, 300)
  console.error(`crawl failed: ${msg}`)
  if (crawlId) await db(`site_crawls?id=eq.${crawlId}`, { method: 'PATCH', body: JSON.stringify({ status: 'failed', finished_at: new Date().toISOString(), error: msg }) }).catch(() => {})
  process.exit(1)
})
