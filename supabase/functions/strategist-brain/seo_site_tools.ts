// The strategist's "hands" (Phase 2): read a page's editable fields and FILE
// PROPOSALS for changes. Nothing here writes to the live site — a proposal
// waits in the owner's approvals inbox; approving it runs handle-seo-chat's
// read → back up → write → log path, and it can be undone from there.
//
// Off switch and cap: ops_profile key 'seo_site_proposals' =
//   { "enabled": true, "max_per_run": 6 }   (missing or enabled:false → no proposals)

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.116.0'
import { proposeChange } from '../_shared/site_change_log.ts'
import {
  cleanFaq, readPost, readProduct, readProductStatus, readSeoMeta, readTermDescription, siteEnv, type SeoMeta, type SiteEnv,
} from '../_shared/site_io.ts'
import {
  CATEGORY_TEXT_WORDS, classifyUrl, cleanCategoryText, insertLink, proposalReason, seoProblems, visibleWords, hasWideDash, WIDE_DASH_RULE, PRODUCT_TEXT_WORDS, faqProblems, numbersNotInCatalog } from './seo_site_logic.ts'

interface Ctx { runId: string }

type Resolved =
  | { kind: 'category'; id: number; name: string; url: string }
  | { kind: 'product'; id: number; name: string; url: string }
  | { kind: 'post'; id: number; name: string; url: string }

/** A minuto.co.il address → the WordPress / WooCommerce object behind it. */
async function resolve(url: string): Promise<Resolved | { error: string }> {
  const t = classifyUrl(url)
  if (!t) return { error: 'use the address of a product category, a product or a blog post on minuto.co.il' }
  const env = siteEnv()
  const json = async (u: string) => { const r = await env.fetchFn(u, { headers: { 'User-Agent': 'MinutoStrategist/1.0' } }); return r.ok ? await r.json() : null }
  if (t.kind === 'category') {
    const rows = await json(`${env.wpUrl}/wp-json/wp/v2/product_cat?slug=${encodeURIComponent(t.slug)}&_fields=id,name,link`) as Array<{ id: number; name: string; link: string }> | null
    const path = (l: string) => { try { return decodeURIComponent(new URL(l).pathname).replace(/\/?$/, '/') } catch { return '' } }
    const hit = (rows ?? []).find((r) => path(r.link) === t.path) ?? (rows?.length === 1 ? rows[0] : undefined)
    return hit ? { kind: 'category', id: hit.id, name: hit.name, url: hit.link } : { error: `no product category at ${t.path}` }
  }
  if (t.kind === 'post') {
    const rows = await json(`${env.wpUrl}/wp-json/wp/v2/posts?slug=${encodeURIComponent(t.slug)}&_fields=id,link,title`) as Array<{ id: number; link: string; title: { rendered: string } }> | null
    return rows?.[0] ? { kind: 'post', id: rows[0].id, name: rows[0].title?.rendered ?? '', url: rows[0].link } : { error: `no published blog post with slug ${t.slug}` }
  }
  const rows = await json(`${env.wpUrl}/wp-json/wp/v2/product?slug=${encodeURIComponent(t.slug)}&_fields=id,link,title`) as Array<{ id: number; link: string; title: { rendered: string } }> | null
  return rows?.[0] ? { kind: 'product', id: rows[0].id, name: rows[0].title?.rendered ?? '', url: rows[0].link } : { error: `no published product with slug ${t.slug}` }
}

export async function settings(supabase: Db): Promise<{ enabled: boolean; max: number }> {
  const { data } = await supabase.from('ops_profile').select('value').eq('key', 'seo_site_proposals').maybeSingle()
  const v = (data?.value ?? {}) as { enabled?: unknown; max_per_run?: unknown }
  const max = Number(v.max_per_run)
  return { enabled: v.enabled === true, max: Number.isFinite(max) && max > 0 ? Math.min(max, 20) : 6 }
}

const requester = (ctx: Ctx) => `strategist run ${ctx.runId}`

// deno-lint-ignore no-explicit-any
type Db = { from(table: string): any }

/**
 * Refuses when switched off, when the batch would take this run over its cap,
 * or when a proposal for any of the targets is already waiting. The whole
 * batch is checked at once, so several proposals filed by one call count
 * together against the cap.
 */
export async function gate(supabase: Db, ctx: Ctx, targets: Array<{ target_type: string; target_id: number }>): Promise<string | null> {
  const s = await settings(supabase)
  if (!s.enabled) return 'site proposals are switched off (ops_profile seo_site_proposals.enabled is not true): report the change in the brief instead'
  const { count } = await supabase.from('site_change_log').select('id', { count: 'exact', head: true }).eq('requested_by', requester(ctx))
  if ((count ?? 0) + targets.length > s.max) return `this run may file at most ${s.max} proposals (already ${count ?? 0}, this call adds ${targets.length}): keep the most valuable ones`
  for (const t of targets) {
    const { data: open } = await supabase.from('site_change_log').select('id').eq('target_type', t.target_type).eq('target_id', t.target_id).eq('status', 'proposed').limit(1)
    if (open?.length) return `a proposal for this ${t.target_type} is already waiting for the owner (${open[0].id}); do not file another`
  }
  return null
}

const today = () => new Date().toISOString().slice(0, 10)

/** What the catalog says about a product: the only source of facts for its description and FAQ. */
async function productFacts(env: SiteEnv, id: number): Promise<{ name: string; short_description: string; description: string; attributes: Array<{ name: string; options: string[] }>; categories: string[]; faq: Array<{ q: string; a: string }> }> {
  const base = await readProduct(env, id)
  const r = await env.fetchFn(`${env.wpUrl}/wp-json/wc/v3/products/${id}?_fields=short_description,attributes,categories`, { headers: { Authorization: 'Basic ' + btoa(`${env.wooKey}:${env.wooSecret}`) }, redirect: 'manual' })
  const j = r.ok ? await r.json() as { short_description?: string; attributes?: Array<{ name?: string; options?: string[] }>; categories?: Array<{ name?: string }> } : {}
  if (!r.ok) await r.body?.cancel()
  return {
    name: base.name, description: base.description, faq: base.faq, short_description: String(j.short_description ?? ''),
    attributes: (j.attributes ?? []).map((a) => ({ name: String(a.name ?? ''), options: (a.options ?? []).map(String) })),
    categories: (j.categories ?? []).map((c) => String(c.name ?? '')),
  }
}

const catalogText = (f: Awaited<ReturnType<typeof productFacts>>) =>
  [f.name, f.short_description, f.description, ...f.attributes.flatMap((a) => [a.name, ...a.options]), ...f.categories, ...f.faq.flatMap((p) => [p.q, p.a])].join(' \n ')

// ── read_site_fields ────────────────────────────────────────────────────────
async function readSiteFields(input: { url?: string }) {
  const r = await resolve(String(input?.url ?? ''))
  if ('error' in r) return r
  const env = siteEnv()
  if (r.kind === 'category') {
    const [seo, term] = await Promise.all([readSeoMeta(env, 'product_cat', r.id), readTermDescription(env, r.id)])
    return { type: 'category', id: r.id, name: r.name, url: r.url, seo: seo.meta, category_text_html: term.description, category_text_words: visibleWords(term.description),
      note: "seo fields '' = no custom value (Rank Math template). category_text is the text shown on the category page." }
  }
  if (r.kind === 'product') {
    const [seo, st, facts] = await Promise.all([readSeoMeta(env, 'post', r.id), readProductStatus(env, r.id), productFacts(env, r.id)])
    return { type: 'product', id: r.id, name: r.name, url: r.url, seo: seo.meta, status: st.status,
      description_html: facts.description, description_words: visibleWords(facts.description), faq: facts.faq,
      catalog: { short_description: facts.short_description, attributes: facts.attributes, categories: facts.categories },
      note: 'description_html and faq are what the product page shows now. A new description or FAQ may state only facts found here (name, short_description, description, attributes, categories, faq): every number in the new text must appear in this data.' }
  }
  const [seo, p] = await Promise.all([readSeoMeta(env, 'post', r.id), readPost(env, r.id)])
  return { type: 'post', id: r.id, name: p.title, url: r.url, seo: seo.meta, words: visibleWords(p.content),
    links_out: [...p.content.matchAll(/<a\s[^>]*href\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]).slice(0, 60) }
}

// ── propose_site_change ─────────────────────────────────────────────────────
async function proposeSiteChange(supabase: SupabaseClient, ctx: Ctx, input: Record<string, unknown>) {
  const r = await resolve(String(input?.url ?? ''))
  if ('error' in r) return r
  const why = String(input.reason ?? '').trim(), expected = String(input.expected_result ?? '').trim()
  if (why.length < 20 || expected.length < 10) return { error: 'reason (the evidence, with numbers) and expected_result (what should move, by how much) are required' }
  const reason = proposalReason({ reason: why, expected_result: expected, check_after_days: Number(input.check_after_days ?? 28), today: today() })
  const env = siteEnv()
  const planned: Array<{ target_type: 'seo_meta' | 'term_seo_meta' | 'term_description' | 'product_status' | 'product_description' | 'product_faq'; after: unknown; before: unknown }> = []

  if (input.seo !== undefined) {
    const seo = (input.seo ?? {}) as Record<string, unknown>
    const problems = seoProblems(seo)
    if (problems.length) return { error: `seo: ${problems.join('; ')}` }
    const fields: SeoMeta = {}
    for (const k of ['title', 'description', 'focus_keyword'] as const) if (typeof seo[k] === 'string') fields[k] = (seo[k] as string).trim()
    const cur = (await readSeoMeta(env, r.kind === 'category' ? 'product_cat' : 'post', r.id)).meta
    const changed = Object.fromEntries(Object.entries(fields).filter(([k, v]) => cur[k as keyof typeof cur] !== v))
    if (!Object.keys(changed).length) return { error: 'seo: the proposed values are what the page already has' }
    planned.push({ target_type: r.kind === 'category' ? 'term_seo_meta' : 'seo_meta', after: changed, before: Object.fromEntries(Object.keys(changed).map((k) => [k, cur[k as keyof typeof cur]])) })
  }
  if (input.category_text !== undefined) {
    if (r.kind !== 'category') return { error: 'category_text is only for product category addresses' }
    if (hasWideDash(String(input.category_text ?? ''))) return { error: `category_text: ${WIDE_DASH_RULE}` }
    const c = cleanCategoryText(String(input.category_text ?? ''))
    if (c.words < CATEGORY_TEXT_WORDS.min || c.words > CATEGORY_TEXT_WORDS.max) return { error: `category_text has ${c.words} words; write between ${CATEGORY_TEXT_WORDS.min} and ${CATEGORY_TEXT_WORDS.max}` }
    const cur = (await readTermDescription(env, r.id)).description
    if (cur.trim() === c.html) return { error: 'category_text is what the page already has' }
    planned.push({ target_type: 'term_description', after: c.html, before: cur })
  }
  if (input.product_status !== undefined) {
    if (r.kind !== 'product') return { error: 'product_status is only for product addresses' }
    const st = String(input.product_status)
    if (!['publish', 'draft'].includes(st)) return { error: 'product_status must be publish or draft' }
    const cur = (await readProductStatus(env, r.id)).status
    if (cur === st) return { error: `the product is already ${st}` }
    planned.push({ target_type: 'product_status', after: st, before: cur })
  }
  if (input.product_description !== undefined || input.product_faq !== undefined) {
    if (r.kind !== 'product') return { error: 'product_description and product_faq are only for product addresses' }
    const facts = await productFacts(env, r.id)
    const catalog = catalogText(facts)
    if (input.product_description !== undefined) {
      const raw = String(input.product_description ?? '')
      if (hasWideDash(raw)) return { error: `product_description: ${WIDE_DASH_RULE}` }
      const c = cleanCategoryText(raw)
      if (c.words < PRODUCT_TEXT_WORDS.min || c.words > PRODUCT_TEXT_WORDS.max) return { error: `product_description has ${c.words} words; write between ${PRODUCT_TEXT_WORDS.min} and ${PRODUCT_TEXT_WORDS.max}` }
      const extra = numbersNotInCatalog(c.html, catalog)
      if (extra.length) return { error: `product_description states numbers the catalog does not have (${extra.join(', ')}): use only facts from read_site_fields, or leave the figure out` }
      if (facts.description.trim() === c.html) return { error: 'product_description is what the page already has' }
      planned.push({ target_type: 'product_description', after: c.html, before: facts.description })
    }
    if (input.product_faq !== undefined) {
      const problems = faqProblems(input.product_faq)
      if (problems.length) return { error: `product_faq: ${problems.join('; ')}` }
      const faq = cleanFaq(input.product_faq)
      const extra = numbersNotInCatalog(faq.map((p) => `${p.q} ${p.a}`).join(' '), catalog)
      if (extra.length) return { error: `product_faq states numbers the catalog does not have (${extra.join(', ')}): use only facts from read_site_fields, or leave the figure out` }
      if (JSON.stringify(faq) === JSON.stringify(facts.faq)) return { error: 'product_faq is what the page already has' }
      planned.push({ target_type: 'product_faq', after: faq, before: facts.faq })
    }
  }
  if (!planned.length) return { error: 'nothing to propose: give seo, category_text, product_status, product_description and/or product_faq' }

  const blocked = await gate(supabase, ctx, planned.map((p) => ({ target_type: p.target_type, target_id: r.id })))
  if (blocked) return { error: blocked, filed: [] }
  const filed: Array<{ id: string; target_type: string }> = []
  for (const p of planned) {
    const row = await proposeChange({ target_type: p.target_type, target_id: r.id, target_url: r.url, target_title: r.name, after: p.after, source_fn: 'strategist-brain', requested_by: requester(ctx), reason })
    filed.push({ id: row.id, target_type: p.target_type })
  }
  return { ok: true, filed, note: 'Filed as proposals in the owner\'s approvals inbox. Nothing changes on the site until the owner approves; every approved change can be undone.', current_values: planned.map((p) => ({ target_type: p.target_type, before: p.before })) }
}

// ── propose_internal_link ───────────────────────────────────────────────────
async function proposeInternalLink(supabase: SupabaseClient, ctx: Ctx, input: Record<string, unknown>) {
  const post = await resolve(String(input?.post_url ?? ''))
  if ('error' in post) return post
  if (post.kind !== 'post') return { error: 'post_url must be a blog post' }
  const target = classifyUrl(String(input?.target_url ?? ''))
  if (!target) return { error: 'target_url must be a product category, product or blog post on minuto.co.il' }
  const why = String(input.reason ?? '').trim(), expected = String(input.expected_result ?? '').trim()
  if (why.length < 20 || expected.length < 10) return { error: 'reason and expected_result are required' }
  const env = siteEnv()
  const targetRes = await env.fetchFn(String(input.target_url), { method: 'GET', redirect: 'manual', headers: { 'User-Agent': 'MinutoStrategist/1.0' } })
  await targetRes.body?.cancel()
  if (targetRes.status !== 200) return { error: `target_url answers ${targetRes.status}, not 200: link only to live pages` }
  const p = await readPost(env, post.id)
  const res = insertLink(p.content, String(input.anchor_text ?? ''), String(input.target_url))
  if ('error' in res) return res
  const blocked = await gate(supabase, ctx, [{ target_type: 'post_content', target_id: post.id }])
  if (blocked) return { error: blocked }
  const row = await proposeChange({
    target_type: 'post_content', target_id: post.id, target_url: post.url, target_title: p.title, after: { content: res.html },
    source_fn: 'strategist-brain', requested_by: requester(ctx),
    reason: proposalReason({ reason: `Internal link "${String(input.anchor_text).trim()}" → ${decodeURI(String(input.target_url))}. ${why}`, expected_result: expected, check_after_days: Number(input.check_after_days ?? 28), today: today() }),
  })
  return { ok: true, filed: [{ id: row.id, target_type: 'post_content' }], note: 'Filed in the owner\'s approvals inbox; only the link is added, the rest of the post is unchanged.' }
}

export const SEO_SITE_TOOL_DEFS = [
  {
    name: 'read_site_fields',
    description: 'Read what can be changed on ONE page before proposing a change: for a product category its Rank Math title/description/focus keyword and the text shown on the category page (with word count); for a product its Rank Math fields, status, the description and FAQ the page shows now (with word count) and the catalog facts (short description, attributes, categories) a new description may use; for a blog post its Rank Math fields, word count and the links it already has.',
    input_schema: { type: 'object', properties: { url: { type: 'string', description: 'full minuto.co.il address of a product category, product or blog post' } }, required: ['url'] },
  },
  {
    name: 'propose_site_change',
    description: 'FILE A PROPOSAL (the owner approves or rejects it in the dashboard; nothing changes on the site before that, and every approved change can be undone). Call read_site_fields first. Give any of: seo {title 15–65 chars, description 70–160 chars, focus_keyword} (category, product or post), category_text (category only: the HTML shown on the category page, 120–900 words, Hebrew, facts ONLY from the catalog and the data you read — never invent origins, prices or claims), product_status (publish|draft, product only), product_description (product only: the HTML of the product page description, 150–700 words, Hebrew; simple tags p/h2/h3/ul/li/strong only; facts ONLY from read_site_fields: every number must appear in the product catalog data), product_faq (product only: 3–8 {q, a} pairs in plain Hebrew, replacing the whole FAQ of the page; same fact rule). reason = the evidence with numbers; expected_result = what should move and by how much; check_after_days (default 28). At most a few per run, money first.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        seo: { type: 'object', properties: { title: { type: 'string' }, description: { type: 'string' }, focus_keyword: { type: 'string' } } },
        category_text: { type: 'string' },
        product_status: { type: 'string', enum: ['publish', 'draft'] },
        product_description: { type: 'string' },
        product_faq: { type: 'array', items: { type: 'object', properties: { q: { type: 'string' }, a: { type: 'string' } }, required: ['q', 'a'] } },
        reason: { type: 'string' },
        expected_result: { type: 'string' },
        check_after_days: { type: 'number' },
      },
      required: ['url', 'reason', 'expected_result'],
    },
  },
  {
    name: 'propose_internal_link',
    description: 'FILE A PROPOSAL to add ONE internal link inside an existing blog post: code wraps the first plain-text occurrence of anchor_text (outside headings and existing links) with a link to target_url; the rest of the post is unchanged. Use it to point a post that competes for a search at the page that should win it (e.g. a blog post ranking for a category\'s search → link to the category with that search as the anchor). Quote anchor_text exactly as it appears in the post.',
    input_schema: {
      type: 'object',
      properties: { post_url: { type: 'string' }, anchor_text: { type: 'string' }, target_url: { type: 'string' }, reason: { type: 'string' }, expected_result: { type: 'string' }, check_after_days: { type: 'number' } },
      required: ['post_url', 'anchor_text', 'target_url', 'reason', 'expected_result'],
    },
  },
] as const

export async function dispatchSeoSiteTool(supabase: SupabaseClient, ctx: Ctx, name: string, input: Record<string, unknown>): Promise<unknown | undefined> {
  switch (name) {
    case 'read_site_fields':      return await readSiteFields(input as { url?: string })
    case 'propose_site_change':   return await proposeSiteChange(supabase, ctx, input)
    case 'propose_internal_link': return await proposeInternalLink(supabase, ctx, input)
    default:                      return undefined
  }
}
