// Pure checks for the strategist's site-change proposals (Phase 2). No I/O:
// tested in seo_site_logic_test.ts. The tools that use them file PROPOSALS
// only; nothing reaches the live site until the owner approves it.

export type SiteTarget =
  | { kind: 'category'; path: string; slug: string }
  | { kind: 'product'; slug: string }
  | { kind: 'post'; slug: string }

const HOST = /^(www\.)?minuto\.co\.il$/i

/** Which kind of page a minuto.co.il address is, or null (other sites, home, cart…). */
export function classifyUrl(url: string): SiteTarget | null {
  let u: URL
  try { u = new URL(url) } catch { return null }
  if (!HOST.test(u.hostname)) return null
  let path = u.pathname
  try { path = decodeURIComponent(path) } catch { /* keep encoded */ }
  const parts = path.split('/').filter(Boolean)
  if (parts[0] === 'product-category' && parts.length >= 2) return { kind: 'category', path: '/' + parts.join('/') + '/', slug: parts[parts.length - 1] }
  if (parts[0] === 'product' && parts.length === 2) return { kind: 'product', slug: parts[1] }
  if (parts[0] === 'blog' && parts.length === 2 && !['category', 'tag', 'page'].includes(parts[1])) return { kind: 'post', slug: parts[1] }
  return null
}

// Google shows about 60 characters of a title and 155–160 of a description.
export const SEO_LIMITS = { title: { min: 15, max: 65 }, description: { min: 70, max: 160 }, focus_keyword: { min: 2, max: 60 } }

const chars = (s: string) => [...s].length

/** An href value made safe for an attribute: entities decoded once, then &, ", <, > encoded. */
export function escAttr(v: string): string {
  const raw = v.replace(/&quot;/g, '"').replace(/&#0*39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  return raw.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** A link that stays on minuto.co.il: a site path ('/x', never '//host' or '/\\host') or an https minuto.co.il address. */
export function isSiteLink(href: string): boolean {
  const h = href.trim()
  if (/^\/(?![\/\\])/.test(h)) return true
  return /^https:\/\/(www\.)?minuto\.co\.il\//i.test(h)
}

/**
 * Wide dashes (– — and their kin). The owner wants none in site text: write a
 * comma, a colon or a plain hyphen (-) instead.
 */
export const WIDE_DASH = /[\u2012-\u2015\u2E3A\u2E3B\uFE58\uFE63]/
const WIDE_DASH_ENTITY = /&(ndash|mdash|horbar|dash);|&#0*(8210|8211|8212|8213);|&#x0*(2012|2013|2014|2015);/i
/** True when the text has a wide dash, written as the character or as an HTML entity (&ndash; &#8211; …). */
export function hasWideDash(s: string): boolean { return WIDE_DASH.test(s) || WIDE_DASH_ENTITY.test(s) }
export const WIDE_DASH_RULE = 'no wide dashes (– or —) in site text: use a comma, a colon or a plain hyphen (-)'

/** Problems with proposed SEO fields ([] = fine). Only the fields given are checked. */
export function seoProblems(f: { title?: unknown; description?: unknown; focus_keyword?: unknown }): string[] {
  const out: string[] = []
  const given = (['title', 'description', 'focus_keyword'] as const).filter((k) => f[k] !== undefined)
  if (!given.length) out.push('give at least one of title, description, focus_keyword')
  for (const k of given) {
    const v = f[k]
    if (typeof v !== 'string' || !v.trim()) { out.push(`${k} must be non-empty text`); continue }
    const n = chars(v.trim()), lim = SEO_LIMITS[k]
    if (n < lim.min || n > lim.max) out.push(`${k} is ${n} characters; keep it between ${lim.min} and ${lim.max}`)
    if (/<[^>]+>/.test(v)) out.push(`${k} must be plain text (no HTML)`)
    if (hasWideDash(v)) out.push(`${k}: ${WIDE_DASH_RULE}`)
  }
  return out
}

const ALLOWED_TAGS = new Set(['p', 'h2', 'h3', 'ul', 'ol', 'li', 'strong', 'em', 'a', 'br'])

/**
 * A category text made safe: only simple formatting tags survive, links only
 * to minuto.co.il, no attributes but href. Returns the cleaned HTML and its
 * visible word count.
 */
export function cleanCategoryText(html: string): { html: string; words: number } {
  let s = String(html ?? '')
  s = s.replace(/<(script|style|iframe|object|embed|form)[\s\S]*?<\/\1>/gi, '')
  s = s.replace(/<!--[\s\S]*?-->/g, '')
  // One pass over the tags; each <a> remembers whether it was kept, so its own
  // </a> is kept or dropped with it (a dropped outside link keeps its words).
  const keptLinks: boolean[] = []
  s = s.replace(/<\/?([a-z0-9]+)([^>]*)>/gi, (tag, name: string, attrs: string) => {
    const t = name.toLowerCase()
    if (!ALLOWED_TAGS.has(t)) return ''
    const closing = tag.startsWith('</')
    if (t === 'a') {
      if (closing) return keptLinks.pop() ? '</a>' : ''
      const m = attrs.match(/href\s*=\s*"([^"]*)"|href\s*=\s*'([^']*)'/i)
      const href = (m?.[1] ?? m?.[2] ?? '').trim()
      const ok = !!href && isSiteLink(href)
      keptLinks.push(ok)
      return ok ? `<a href="${escAttr(href)}">` : ''
    }
    if (closing) return t === 'br' ? '' : `</${t}>`
    return t === 'br' ? '<br>' : `<${t}>`
  })
  // A kept <a> that was never closed gets closed at the end.
  s += '</a>'.repeat(keptLinks.filter(Boolean).length)
  const words = visibleWords(s)
  return { html: s.trim(), words }
}

export function visibleWords(html: string): number {
  const t = String(html).replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim()
  return t ? t.split(' ').filter((w) => /[\p{L}\p{N}]/u.test(w)).length : 0
}

export const CATEGORY_TEXT_WORDS = { min: 120, max: 900 }

/**
 * Prices in page text. The product page shows the price (and the price per
 * 100 g) itself; a price written into a description or FAQ duplicates it and
 * goes stale the day the price changes.
 */
export const PRICE_IN_TEXT = /₪|(^|[^\u0590-\u05FF])(ש["״]ח|שקלים|שקל)(?![\u0590-\u05FF])|מחיר ל-?\s*\d/
export const PRICE_RULE = 'no prices in page text (the product page already shows the price and the price per 100 g)'

export const PRODUCT_TEXT_WORDS = { min: 150, max: 700 }
export const PRODUCT_FAQ = { min: 3, max: 8, q: { min: 8, max: 160 }, a: { min: 30, max: 700 } }

/** Problems with a proposed product FAQ ([] = fine): 3–8 plain-text pairs, each a real question with a real answer. */
export function faqProblems(pairs: unknown): string[] {
  if (!Array.isArray(pairs)) return ['product_faq must be a list of {q, a}']
  const out: string[] = []
  if (pairs.length < PRODUCT_FAQ.min || pairs.length > PRODUCT_FAQ.max) out.push(`product_faq has ${pairs.length} questions; give ${PRODUCT_FAQ.min}–${PRODUCT_FAQ.max}`)
  const seen = new Set<string>()
  pairs.forEach((p, i) => {
    const q = typeof (p as { q?: unknown })?.q === 'string' ? (p as { q: string }).q.trim() : ''
    const a = typeof (p as { a?: unknown })?.a === 'string' ? (p as { a: string }).a.trim() : ''
    const n = i + 1
    if ([...q].length < PRODUCT_FAQ.q.min || [...q].length > PRODUCT_FAQ.q.max) out.push(`question ${n} is ${[...q].length} characters; keep it ${PRODUCT_FAQ.q.min}–${PRODUCT_FAQ.q.max}`)
    if (q && !/[?؟]$/.test(q)) out.push(`question ${n} must end with "?"`)
    if ([...a].length < PRODUCT_FAQ.a.min || [...a].length > PRODUCT_FAQ.a.max) out.push(`answer ${n} is ${[...a].length} characters; keep it ${PRODUCT_FAQ.a.min}–${PRODUCT_FAQ.a.max}`)
    if (/<[^>]+>/.test(q + a)) out.push(`question ${n}: plain text only (no HTML)`)
    if (hasWideDash(q + ' ' + a)) out.push(`question ${n}: ${WIDE_DASH_RULE}`)
    if (PRICE_IN_TEXT.test(q + ' ' + a)) out.push(`question ${n}: ${PRICE_RULE}`)
    const key = q.replace(/\s+/g, ' ').toLowerCase()
    if (key && seen.has(key)) out.push(`question ${n} repeats an earlier question`)
    seen.add(key)
  })
  return out
}

/**
 * Numbers in new product text that the catalog does not have. A product text
 * may only state figures the catalog states (blend percentages, weights,
 * sizes); a number that appears nowhere in the product's own data is how an
 * invented claim ("roasted 48 hours ago", "fresh for 6 weeks") shows up.
 */
export function numbersNotInCatalog(text: string, catalog: string): string[] {
  const nums = (s: string) => [...String(s).replace(/<[^>]+>/g, ' ').matchAll(/\d+(?:[.,]\d+)?/g)].map((m) => m[0].replace(',', '.'))
  const have = new Set(nums(catalog).flatMap((n) => [n, String(Number(n))]))
  return [...new Set(nums(text))].filter((n) => !have.has(n) && !have.has(String(Number(n))))
}

/**
 * Wrap the first occurrence of `anchor` in the post body with a link to
 * `href`, outside existing links, headings and tags. Returns the new HTML,
 * or a reason it cannot (anchor not found, already linked there).
 */
export function insertLink(html: string, anchor: string, href: string): { html: string } | { error: string } {
  const a = anchor.trim()
  if (!a) return { error: 'anchor_text is empty' }
  const norm = (u: string) => { try { return decodeURIComponent(new URL(u, 'https://www.minuto.co.il').pathname).replace(/\/?$/, '/').toLowerCase() } catch { return u } }
  const target = norm(href)
  for (const m of html.matchAll(/<a\s[^>]*href\s*=\s*["']([^"']+)["']/gi)) {
    if (norm(m[1]) === target) return { error: 'the post already links to that page' }
  }
  // Walk the HTML: text outside tags, tracking whether we are inside <a> or a heading.
  const tokens = html.split(/(<[^>]+>)/)
  let inA = 0, inH = 0
  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i]
    if (tk.startsWith('<')) {
      if (/^<a[\s>]/i.test(tk)) inA++
      else if (/^<\/a>/i.test(tk)) inA = Math.max(0, inA - 1)
      else if (/^<h[1-6][\s>]/i.test(tk)) inH++
      else if (/^<\/h[1-6]>/i.test(tk)) inH = Math.max(0, inH - 1)
      continue
    }
    if (inA || inH) continue
    const at = tk.indexOf(a)
    if (at === -1) continue
    tokens[i] = tk.slice(0, at) + `<a href="${escAttr(href)}">${a}</a>` + tk.slice(at + a.length)
    return { html: tokens.join('') }
  }
  return { error: `"${a}" was not found as plain text in the post (outside existing links and headings): quote words exactly as they appear` }
}

/** The proposal's reason, in one place the owner reads in the inbox. */
export function proposalReason(p: { reason: string; expected_result: string; check_after_days: number; today: string }): string {
  const days = Math.min(Math.max(Math.round(p.check_after_days) || 28, 7), 90)
  const check = new Date(Date.parse(p.today + 'T00:00:00Z') + days * 864e5).toISOString().slice(0, 10)
  return `Why: ${p.reason.trim()}\nExpected: ${p.expected_result.trim()}\nCheck on: ${check}`
}
