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
