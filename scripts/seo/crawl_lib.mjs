// Pure helpers for the weekly site crawl (scripts/seo/crawl.mjs).
// SEO agent build plan, Phase 1. No network, no database: tested by
// scripts/seo/crawl_lib.test.mjs (node --test).

import { parse } from 'node-html-parser'

/** <loc> values from a sitemap or sitemap index. */
export function sitemapLocs(xml) {
  const out = []
  const re = /<loc>\s*([^<\s]+)\s*<\/loc>/gi
  let m
  while ((m = re.exec(xml))) out.push(m[1].replace(/&amp;/g, '&'))
  return out
}

export function isSitemapIndex(xml) {
  return /<sitemapindex[\s>]/i.test(xml)
}

/** Sitemap URLs listed in robots.txt. */
export function robotsSitemaps(robotsTxt) {
  return [...String(robotsTxt).matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1])
}

/**
 * What kind of page a URL is, from the sitemap it came from (Rank Math names
 * them product-sitemap.xml, product_cat-sitemap.xml, post-sitemap.xml, …) or
 * else from its path.
 */
export function pageType(url, sitemapUrl = '') {
  const sm = String(sitemapUrl).toLowerCase()
  let path = '/'
  try { path = decodeURIComponent(new URL(url).pathname) } catch { /* keep / */ }
  if (path === '/' || path === '') return 'home'
  if (sm.includes('product_cat') || path.startsWith('/product-category/')) return 'category'
  if (/\/product-sitemap/.test(sm) || path.startsWith('/product/')) return 'product'
  if (sm.includes('post-sitemap') || path.startsWith('/blog/')) return 'post'
  if (sm.includes('page-sitemap')) return 'page'
  return 'other'
}

/** Every @type in the page's JSON-LD, including inside @graph. Unparseable blocks are skipped. */
export function schemaTypes(jsonLdBlocks) {
  const types = new Set()
  const walk = (v) => {
    if (Array.isArray(v)) { v.forEach(walk); return }
    if (!v || typeof v !== 'object') return
    const t = v['@type']
    if (typeof t === 'string') types.add(t)
    else if (Array.isArray(t)) t.forEach((x) => typeof x === 'string' && types.add(x))
    for (const val of Object.values(v)) if (val && typeof val === 'object') walk(val)
  }
  for (const block of jsonLdBlocks) {
    try { walk(JSON.parse(block)) } catch { /* invalid JSON-LD: not counted */ }
  }
  return [...types].sort()
}

const SKIP_LINK = /^(mailto:|tel:|javascript:|#|whatsapp:|sms:)/i

/** Normalised internal path (no query/fragment, trailing slash kept as is), or null if external. */
export function internalPath(href, pageUrl, siteHost) {
  if (!href || SKIP_LINK.test(href.trim())) return undefined
  let u
  try { u = new URL(href.trim(), pageUrl) } catch { return undefined }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined
  const host = u.host.replace(/^www\./, '')
  if (host !== siteHost.replace(/^www\./, '')) return null
  return u.pathname
}

// Tags become spaces, so words in neighbouring elements are never glued
// together (node-html-parser's .text concatenates them).
function visibleText(html) {
  return String(html)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&[a-z]+;|&#\d+;/gi, ' ')
}

function countWords(text) {
  const t = String(text).replace(/\s+/g, ' ').trim()
  return t ? t.split(' ').filter((w) => /[\p{L}\p{N}]/u.test(w)).length : 0
}

/** Everything the audit needs from one HTML page. */
export function extractPage(html, pageUrl, siteHost) {
  const root = parse(html, { comment: false, blockTextElements: { script: true, style: true, noscript: true, pre: true } })
  const meta = (name) => root.querySelector(`meta[name="${name}"]`)?.getAttribute('content')?.trim() ?? null
  const h1s = root.querySelectorAll('h1').map((h) => h.text.replace(/\s+/g, ' ').trim()).filter(Boolean)

  const jsonLd = root.querySelectorAll('script[type="application/ld+json"]').map((s) => s.rawText ?? s.text)

  const internal = new Set()
  let external = 0
  const listing = new Map()   // page number → absolute URL of a further listing page of THIS page
  for (const a of root.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href')
    const p = internalPath(href, pageUrl, siteHost)
    if (p === null) external++
    else if (p) internal.add(p)
    const n = listingPageNumber(href, pageUrl, siteHost)
    if (n && n > 1 && !listing.has(n)) listing.set(n, new URL(href.trim(), pageUrl).href)
  }
  const relNext = root.querySelector('link[rel="next"]')?.getAttribute('href')?.trim() || null

  const imgs = root.querySelectorAll('img')
  const missingAlt = imgs.filter((i) => !(i.getAttribute('alt') ?? '').trim()).length

  // Visible words in the main content: <main>, else <article>, else <body>
  // without header/footer/nav and non-text elements.
  const main = root.querySelector('main') ?? root.querySelector('article') ?? root.querySelector('body') ?? root
  for (const el of main.querySelectorAll('script, style, noscript, header, footer, nav, svg, form')) el.remove()

  return {
    title:              root.querySelector('title')?.text.replace(/\s+/g, ' ').trim() || null,
    meta_description:   meta('description'),
    h1:                 h1s[0] ?? null,
    h1_count:           h1s.length,
    canonical:          root.querySelector('link[rel="canonical"]')?.getAttribute('href')?.trim() ?? null,
    robots_meta:        meta('robots'),
    lang:               root.querySelector('html')?.getAttribute('lang') ?? null,
    word_count:         countWords(visibleText(main.innerHTML)),
    schema_types:       schemaTypes(jsonLd),
    internal_links:     [...internal].sort(),
    external_links:     external,
    images:             imgs.length,
    images_missing_alt: missingAlt,
    // Used by the crawler only (not stored as columns):
    listing_page_urls:  [...listing].sort((a, b) => a[0] - b[0]).map(([, u]) => u),
    rel_next:           absUrl(relNext, pageUrl),
    product_paths:      [...internal].filter((x) => x.startsWith('/product/')).sort(),
  }
}

/** Absolute URL, or null when missing or unparseable. */
function absUrl(href, base) {
  if (!href) return null
  try { return new URL(href, base).href } catch { return null }
}

/**
 * The page number a link points to, when it is a further listing page of the
 * same page (same host and path, with ?page=N or a /page/N/ suffix); else null.
 */
export function listingPageNumber(href, pageUrl, siteHost) {
  if (!href || SKIP_LINK.test(href.trim())) return null
  let u, base
  try { u = new URL(href.trim(), pageUrl); base = new URL(pageUrl) } catch { return null }
  if (u.host.replace(/^www\./, '') !== siteHost.replace(/^www\./, '')) return null
  const strip = (path) => decodeURIComponent(path).toLowerCase().replace(/\/page\/\d+\/?$/, '/').replace(/\/?$/, '/')
  if (strip(u.pathname) !== strip(base.pathname)) return null
  const q = u.searchParams.get('page')
  if (q && /^\d{1,4}$/.test(q)) return Number(q)
  const m = decodeURIComponent(u.pathname).match(/\/page\/(\d{1,4})\/?$/)
  return m ? Number(m[1]) : null
}

/**
 * Can Google page through this category's listing? From page 1's extract and
 * the product paths of the page its rel=next points to (null if not fetched):
 *   null                 — fine (one page, or real page links that work)
 *   'no_page_links'      — there is a next page (rel=next) but no real link to any further page
 *   'next_repeats_first' — the next page shows exactly the products of page 1
 */
export function listingIssue(page1, nextProductPaths) {
  const hasNext = !!page1.rel_next || (page1.listing_page_urls ?? []).length > 0
  if (!hasNext) return null
  if (!(page1.listing_page_urls ?? []).length) return 'no_page_links'
  const first = (page1.product_paths ?? []).join('|')
  if (nextProductPaths && first && nextProductPaths.join('|') === first) return 'next_repeats_first'
  return null
}

/** Run `fn` over `items` with at most `limit` in flight. Keeps input order in the result. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

// Every column a crawl row can carry. PostgREST refuses a bulk insert whose
// rows have different keys ("All object keys must match"), and a page that
// failed to load carries fewer fields than one that loaded — so every row is
// sent with all of them, missing ones as null.
export const CRAWL_ROW_COLUMNS = [
  'crawl_id', 'url', 'page_type', 'in_sitemap', 'status', 'final_url', 'redirects', 'title', 'meta_description',
  'h1', 'h1_count', 'canonical', 'robots_meta', 'x_robots_tag', 'lang', 'word_count', 'schema_types',
  'internal_links', 'external_links', 'images', 'images_missing_alt', 'html_bytes', 'response_ms', 'error',
  'listing_pages', 'listing_issue',
]

export function toCrawlRow(page) {
  const row = {}
  for (const c of CRAWL_ROW_COLUMNS) row[c] = page[c] ?? null
  if (row.redirects == null) row.redirects = 0
  if (row.in_sitemap == null) row.in_sitemap = true
  return row
}
