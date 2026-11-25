// Reads and writes of the live site's SEO fields, shared by the functions
// that change them and by the undo path (handle-seo-chat). Each reader
// returns the value in the SAME shape the change log stores, so "current
// value" and "what a change wrote" can be compared before an undo.
//
//   post_faq            FaqPair[]                       ([] = no FAQ)
//   product_faq         FaqPair[]                       ([] = no FAQ)
//   product_description string                          (Woo long description, HTML)
//   post_content        { title?: string; content?: string }  (raw, as WP stores it)
//   post_featured_image number                          (media id, 0 = none)
//   redirect            string | null                   (301 target from the page, null = none)
//   post_status         'publish' | 'draft'
//
// Credentials come from the same secrets the existing writers use:
// WOO_URL (canonical, with www), WP_BLOG_POST_USER_NAME / WP_BLOG_POST_PASS
// (WP Application Password), WOO_KEY / WOO_SECRET.

export interface FaqPair { q: string; a: string }

export interface SiteEnv {
  wpUrl:     string
  wpUser:    string
  wpPass:    string
  wooKey:    string
  wooSecret: string
  fetchFn:   typeof fetch
}

export function siteEnv(over: Partial<SiteEnv> = {}): SiteEnv {
  return {
    wpUrl:     (over.wpUrl ?? Deno.env.get('WOO_URL') ?? 'https://www.minuto.co.il').replace(/\/+$/, ''),
    wpUser:    over.wpUser ?? Deno.env.get('WP_BLOG_POST_USER_NAME') ?? '',
    wpPass:    over.wpPass ?? Deno.env.get('WP_BLOG_POST_PASS') ?? '',
    wooKey:    over.wooKey ?? Deno.env.get('WOO_KEY') ?? '',
    wooSecret: over.wooSecret ?? Deno.env.get('WOO_SECRET') ?? '',
    fetchFn:   over.fetchFn ?? fetch,
  }
}

export const FAQ_META_KEY = '_minuto_faq_published'

/** Keeps only well-formed {q,a} pairs, trimmed. Never throws. */
export function cleanFaq(input: unknown): FaqPair[] {
  if (!Array.isArray(input)) return []
  const out: FaqPair[] = []
  for (const item of input) {
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    const q = typeof r.q === 'string' ? r.q.trim() : ''
    const a = typeof r.a === 'string' ? r.a.trim() : ''
    if (q && a) out.push({ q, a })
  }
  return out
}

/** The stored meta is a JSON string (or already-decoded array). '' / missing = no FAQ. */
export function parseStoredFaq(raw: unknown): FaqPair[] {
  if (Array.isArray(raw)) return cleanFaq(raw)
  if (typeof raw !== 'string' || !raw.trim()) return []
  try { return cleanFaq(JSON.parse(raw)) } catch { return [] }
}

/** Pulls the minuto-product-faq FAQPage JSON-LD out of a rendered page. null = not found. */
export function faqFromHtml(html: string): FaqPair[] | null {
  const m = html.match(/<script type="application\/ld\+json" data-source="minuto-product-faq">([\s\S]*?)<\/script>/)
  if (!m) return null
  try {
    const data = JSON.parse(m[1]) as { mainEntity?: Array<{ name?: string; acceptedAnswer?: { text?: string } }> }
    return cleanFaq((data.mainEntity ?? []).map((e) => ({ q: e.name ?? '', a: e.acceptedAnswer?.text ?? '' })))
  } catch {
    return null
  }
}

function wpAuth(env: SiteEnv): string {
  if (!env.wpUser || !env.wpPass) throw new Error('WP_BLOG_POST_USER_NAME / WP_BLOG_POST_PASS not set')
  return 'Basic ' + btoa(`${env.wpUser}:${env.wpPass}`)
}

// Woo REST over HTTPS with Basic auth in a header — never keys in the URL,
// which would leak into logs and error messages.
function wooUrl(env: SiteEnv, path: string): string {
  return `${env.wpUrl}/wp-json/wc/v3/${path}`
}
function wooHeaders(env: SiteEnv, extra: Record<string, string> = {}): Record<string, string> {
  if (!env.wooKey || !env.wooSecret) throw new Error('WOO_KEY / WOO_SECRET not set')
  return { Authorization: 'Basic ' + btoa(`${env.wooKey}:${env.wooSecret}`), ...extra }
}

async function readJson(res: Response, what: string): Promise<Record<string, unknown>> {
  if (res.status >= 300 && res.status < 400) {
    throw new Error(`${what}: redirect ${res.status} → ${res.headers.get('location') ?? '(none)'} (WOO_URL must be canonical, with www)`)
  }
  const text = await res.text()
  let body: unknown
  try { body = JSON.parse(text) } catch { throw new Error(`${what}: non-JSON (status ${res.status}): ${text.slice(0, 200)}`) }
  if (!res.ok) throw new Error(`${what}: HTTP ${res.status}: ${text.slice(0, 300)}`)
  return (body ?? {}) as Record<string, unknown>
}

// ── WordPress posts ─────────────────────────────────────────────────────────

export interface PostInfo { id: number; type: string; status: string; link: string; title: string; content: string; featured_media: number }

/** Any post type with REST support. Tries posts, then products (FAQ plugin covers both). */
export async function readPost(env: SiteEnv, postId: number): Promise<PostInfo> {
  const auth = wpAuth(env)
  for (const base of ['posts', 'product']) {
    const res = await env.fetchFn(`${env.wpUrl}/wp-json/wp/v2/${base}/${postId}?context=edit&_fields=id,type,status,link,title,content,featured_media`, {
      headers: { Authorization: auth }, redirect: 'manual',
    })
    if (res.status === 404) { await res.body?.cancel(); continue }
    const j = await readJson(res, `read ${base} ${postId}`)
    const raw = (v: unknown) => (v && typeof v === 'object' ? String((v as Record<string, unknown>).raw ?? (v as Record<string, unknown>).rendered ?? '') : '')
    return {
      id: Number(j.id), type: String(j.type ?? base), status: String(j.status ?? ''), link: String(j.link ?? ''),
      title: raw(j.title), content: raw(j.content), featured_media: Number(j.featured_media ?? 0) || 0,
    }
  }
  throw new Error(`post ${postId} not found`)
}

/** Only the fields a change touches, so before/after compare like for like. */
export function pickPostFields(p: { title?: string; content?: string }, fields: { title?: unknown; content?: unknown }): { title?: string; content?: string } {
  const out: { title?: string; content?: string } = {}
  if (fields.title !== undefined) out.title = p.title ?? ''
  if (fields.content !== undefined) out.content = p.content ?? ''
  return out
}

export async function writePostFields(env: SiteEnv, postId: number, fields: { title?: string; content?: string; featured_media?: number }): Promise<void> {
  const res = await env.fetchFn(`${env.wpUrl}/wp-json/wp/v2/posts/${postId}`, {
    method: 'POST',  // WP accepts POST for partial updates on /posts/{id}
    headers: { Authorization: wpAuth(env), 'Content-Type': 'application/json' },
    redirect: 'manual',
    body: JSON.stringify(fields),
  })
  await readJson(res, `update post ${postId}`)
}

/**
 * Current FAQ on a post (or product, via the plugin). Prefers the plugin's
 * authenticated read route (minuto-product-faq v0.5.0+), which returns the
 * stored value. On an older plugin it falls back to the FAQ JSON-LD on the
 * live page, which may be a cached copy — the source is returned so the log
 * says which one was used.
 */
export async function readPostFaq(env: SiteEnv, postId: number, link?: string): Promise<{ faq: FaqPair[]; source: 'wp_plugin' | 'live_page' }> {
  const res = await env.fetchFn(`${env.wpUrl}/wp-json/minuto-faq/v1/get/${postId}`, { headers: { Authorization: wpAuth(env) }, redirect: 'manual' })
  if (res.status !== 404) {
    const j = await readJson(res, `read FAQ ${postId}`)
    return { faq: parseStoredFaq(j.faq), source: 'wp_plugin' }
  }
  await res.body?.cancel()
  const url = link || (await readPost(env, postId)).link
  if (!url) throw new Error(`post ${postId} has no public link to read its FAQ from`)
  const page = await env.fetchFn(url, { headers: { 'User-Agent': 'MinutoFaqReader/1.0' } })
  if (!page.ok) { await page.body?.cancel(); throw new Error(`page fetch HTTP ${page.status} for ${url}`) }
  return { faq: faqFromHtml(await page.text()) ?? [], source: 'live_page' }
}

// ── WooCommerce products ────────────────────────────────────────────────────

export interface ProductInfo { id: number; name: string; permalink: string; description: string; faq: FaqPair[] }

export async function readProduct(env: SiteEnv, productId: number): Promise<ProductInfo> {
  const res = await env.fetchFn(wooUrl(env, `products/${productId}`), { headers: wooHeaders(env), redirect: 'manual' })
  const j = await readJson(res, `read product ${productId}`)
  if (typeof j.id !== 'number') throw new Error(`read product ${productId}: no id in response`)
  const meta = Array.isArray(j.meta_data) ? j.meta_data as Array<{ key?: string; value?: unknown }> : []
  const faqMeta = meta.find((m) => m?.key === FAQ_META_KEY)
  return {
    id: j.id, name: String(j.name ?? ''), permalink: String(j.permalink ?? ''),
    description: String(j.description ?? ''), faq: parseStoredFaq(faqMeta?.value),
  }
}

export async function writeProduct(env: SiteEnv, productId: number, patch: { description?: string; faq?: FaqPair[] }): Promise<{ id: number; name: string }> {
  const body: Record<string, unknown> = {}
  if (patch.description !== undefined) body.description = patch.description
  if (patch.faq !== undefined) body.meta_data = [{ key: FAQ_META_KEY, value: patch.faq.length ? JSON.stringify(patch.faq) : '' }]
  const res = await env.fetchFn(wooUrl(env, `products/${productId}`), {
    method: 'PUT', headers: wooHeaders(env, { 'Content-Type': 'application/json' }), redirect: 'manual', body: JSON.stringify(body),
  })
  const j = await readJson(res, `update product ${productId}`)
  if (typeof j.id !== 'number') throw new Error(`update product ${productId}: ${JSON.stringify(j).slice(0, 300)}`)
  return { id: j.id, name: String(j.name ?? '') }
}

// ── Rank Math SEO fields (minuto-product-faq v0.6.0+) ───────────────────────
//   seo_meta       { title?, description?, focus_keyword? } on a post, page or product (WP post id)
//   term_seo_meta  the same on a product category (term id)
// '' = no custom value (Rank Math uses its template). A change stores only the
// fields it touches, before and after, like post_content.

export type SeoField = 'title' | 'description' | 'focus_keyword'
export type SeoMeta = Partial<Record<SeoField, string>>
export const SEO_FIELDS: SeoField[] = ['title', 'description', 'focus_keyword']

/** Only the SEO fields a change names, as strings; null if it names none or one is not text. */
export function pickSeoFields(v: unknown): SeoMeta | null {
  if (!v || typeof v !== 'object') return null
  const out: SeoMeta = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (!(SEO_FIELDS as string[]).includes(k)) return null
    if (typeof val !== 'string') return null
    out[k as SeoField] = val
  }
  return Object.keys(out).length ? out : null
}

export interface SeoInfo { id: number; name: string; url: string; meta: Record<SeoField, string> }

export async function readSeoMeta(env: SiteEnv, kind: 'post' | 'product_cat', id: number): Promise<SeoInfo> {
  const res = await env.fetchFn(`${env.wpUrl}/wp-json/minuto-faq/v1/seo/${kind}/${id}`, { headers: { Authorization: wpAuth(env) }, redirect: 'manual' })
  if (res.status === 404) {
    const j = await res.json().catch(() => ({})) as Record<string, unknown>
    // rest_no_route = the plugin on the site is older than v0.6.0.
    throw new Error(j.code === 'rest_no_route' ? 'SEO fields need minuto-product-faq v0.6.0 on the site' : `read SEO fields ${kind} ${id}: ${String(j.message ?? 'not found')}`)
  }
  const j = await readJson(res, `read SEO fields ${kind} ${id}`)
  const m = (j.meta ?? {}) as Record<string, unknown>
  return {
    id: Number(j.id), name: String(j.name ?? ''), url: String(j.url ?? ''),
    meta: { title: String(m.title ?? ''), description: String(m.description ?? ''), focus_keyword: String(m.focus_keyword ?? '') },
  }
}

export async function writeSeoMeta(env: SiteEnv, kind: 'post' | 'product_cat', id: number, fields: SeoMeta): Promise<SeoInfo> {
  const res = await env.fetchFn(`${env.wpUrl}/wp-json/minuto-faq/v1/seo/${kind}/${id}`, {
    method: 'POST', headers: { Authorization: wpAuth(env), 'Content-Type': 'application/json' }, redirect: 'manual', body: JSON.stringify(fields),
  })
  const j = await readJson(res, `update SEO fields ${kind} ${id}`)
  const m = (j.meta ?? {}) as Record<string, unknown>
  return { id: Number(j.id), name: String(j.name ?? ''), url: String(j.url ?? ''), meta: { title: String(m.title ?? ''), description: String(m.description ?? ''), focus_keyword: String(m.focus_keyword ?? '') } }
}

/** The stored values of just these fields (for before/after). */
export function seoSubset(meta: Record<SeoField, string>, fields: SeoMeta): SeoMeta {
  const out: SeoMeta = {}
  for (const k of Object.keys(fields) as SeoField[]) out[k] = meta[k] ?? ''
  return out
}

// ── Product category text (WooCommerce) ─────────────────────────────────────
//   term_description  string (HTML), shown on the category page

export interface TermInfo { id: number; name: string; slug: string; description: string }

export async function readTermDescription(env: SiteEnv, id: number): Promise<TermInfo> {
  const res = await env.fetchFn(wooUrl(env, `products/categories/${id}`), { headers: wooHeaders(env), redirect: 'manual' })
  const j = await readJson(res, `read category ${id}`)
  if (typeof j.id !== 'number') throw new Error(`read category ${id}: no id in response`)
  return { id: j.id, name: String(j.name ?? ''), slug: String(j.slug ?? ''), description: String(j.description ?? '') }
}

export async function writeTermDescription(env: SiteEnv, id: number, description: string): Promise<TermInfo> {
  const res = await env.fetchFn(wooUrl(env, `products/categories/${id}`), {
    method: 'PUT', headers: wooHeaders(env, { 'Content-Type': 'application/json' }), redirect: 'manual', body: JSON.stringify({ description }),
  })
  const j = await readJson(res, `update category ${id}`)
  if (typeof j.id !== 'number') throw new Error(`update category ${id}: ${JSON.stringify(j).slice(0, 300)}`)
  return { id: j.id, name: String(j.name ?? ''), slug: String(j.slug ?? ''), description: String(j.description ?? '') }
}

// ── Product status (WooCommerce) ────────────────────────────────────────────
//   product_status  'publish' | 'draft' | 'pending' | 'private'

export const PRODUCT_STATUSES = ['publish', 'draft', 'pending', 'private'] as const
export type ProductStatus = typeof PRODUCT_STATUSES[number]
export const isProductStatus = (v: unknown): v is ProductStatus => typeof v === 'string' && (PRODUCT_STATUSES as readonly string[]).includes(v)

export async function readProductStatus(env: SiteEnv, id: number): Promise<{ id: number; name: string; permalink: string; status: string }> {
  const res = await env.fetchFn(wooUrl(env, `products/${id}`), { headers: wooHeaders(env), redirect: 'manual' })
  const j = await readJson(res, `read product ${id}`)
  if (typeof j.id !== 'number') throw new Error(`read product ${id}: no id in response`)
  return { id: j.id, name: String(j.name ?? ''), permalink: String(j.permalink ?? ''), status: String(j.status ?? '') }
}

export async function writeProductStatus(env: SiteEnv, id: number, status: ProductStatus): Promise<string> {
  const res = await env.fetchFn(wooUrl(env, `products/${id}`), {
    method: 'PUT', headers: wooHeaders(env, { 'Content-Type': 'application/json' }), redirect: 'manual', body: JSON.stringify({ status }),
  })
  const j = await readJson(res, `update product ${id}`)
  if (typeof j.id !== 'number') throw new Error(`update product ${id}: ${JSON.stringify(j).slice(0, 300)}`)
  return String(j.status ?? '')
}

// ── Product short description (WooCommerce) ─────────────────────────────────
//   product_short_description  string (HTML), shown next to the price

export async function readProductShortDescription(env: SiteEnv, id: number): Promise<{ id: number; name: string; permalink: string; short_description: string }> {
  const res = await env.fetchFn(wooUrl(env, `products/${id}`), { headers: wooHeaders(env), redirect: 'manual' })
  const j = await readJson(res, `read product ${id}`)
  if (typeof j.id !== 'number') throw new Error(`read product ${id}: no id in response`)
  return { id: j.id, name: String(j.name ?? ''), permalink: String(j.permalink ?? ''), short_description: String(j.short_description ?? '') }
}

export async function writeProductShortDescription(env: SiteEnv, id: number, shortDescription: string): Promise<string> {
  const res = await env.fetchFn(wooUrl(env, `products/${id}`), {
    method: 'PUT', headers: wooHeaders(env, { 'Content-Type': 'application/json' }), redirect: 'manual', body: JSON.stringify({ short_description: shortDescription }),
  })
  const j = await readJson(res, `update product ${id}`)
  if (typeof j.id !== 'number') throw new Error(`update product ${id}: ${JSON.stringify(j).slice(0, 300)}`)
  return String(j.short_description ?? '')
}

// ── Redirects (minuto-product-faq v0.7.0) ───────────────────────────────────
//   redirect  string | null   absolute target URL of the 301 from a page, null = none

async function pluginJson(res: Response, what: string): Promise<Record<string, unknown>> {
  if (res.status === 404) {
    const j = await res.json().catch(() => ({})) as Record<string, unknown>
    // rest_no_route = the plugin on the site is older than v0.7.0.
    throw new Error(j.code === 'rest_no_route' ? 'redirects need minuto-product-faq v0.7.0 on the site' : `${what}: ${String(j.message ?? 'not found')}`)
  }
  return await readJson(res, what)
}

export async function readRedirect(env: SiteEnv, sourceUrl: string): Promise<{ source: string; target: string | null }> {
  const res = await env.fetchFn(`${env.wpUrl}/wp-json/minuto-faq/v1/redirect?source=${encodeURIComponent(sourceUrl)}`, { headers: { Authorization: wpAuth(env) }, redirect: 'manual' })
  const j = await pluginJson(res, 'read redirect')
  return { source: String(j.source ?? ''), target: typeof j.target === 'string' && j.target ? j.target : null }
}

/** Sets (target) or removes (null) the 301 from sourceUrl. Returns what the site stored. */
export async function writeRedirect(env: SiteEnv, sourceUrl: string, target: string | null): Promise<string | null> {
  const res = await env.fetchFn(`${env.wpUrl}/wp-json/minuto-faq/v1/redirect`, {
    method: 'POST', headers: { Authorization: wpAuth(env), 'Content-Type': 'application/json' }, redirect: 'manual',
    body: JSON.stringify({ source: sourceUrl, target: target ?? '' }),
  })
  const j = await pluginJson(res, 'write redirect')
  return typeof j.target === 'string' && j.target ? j.target : null
}

// ── Blog post status ────────────────────────────────────────────────────────
//   post_status  'publish' | 'draft'   (blog posts only; products use product_status)

export const POST_STATUSES = ['publish', 'draft'] as const
export type PostStatus = typeof POST_STATUSES[number]
export const isPostStatus = (v: unknown): v is PostStatus => typeof v === 'string' && (POST_STATUSES as readonly string[]).includes(v)

export async function readPostStatus(env: SiteEnv, id: number): Promise<{ id: number; title: string; link: string; status: string }> {
  const p = await readPost(env, id)
  if (p.type !== 'post') throw new Error(`#${id} is a ${p.type}, not a blog post`)
  return { id: p.id, title: p.title, link: p.link, status: p.status }
}

export async function writePostStatus(env: SiteEnv, id: number, status: PostStatus): Promise<string> {
  const res = await env.fetchFn(`${env.wpUrl}/wp-json/wp/v2/posts/${id}`, {
    method: 'POST', headers: { Authorization: wpAuth(env), 'Content-Type': 'application/json' }, redirect: 'manual',
    body: JSON.stringify({ status }),
  })
  const j = await readJson(res, `update post ${id} status`)
  return String(j.status ?? '')
}
