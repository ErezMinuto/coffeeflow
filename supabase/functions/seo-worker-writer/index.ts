// Minuto SEO Agent — Writer Worker.
//
// Cron-polled worker that processes one `text_generation` task per
// invocation from seo_tasks. Reads a TextGenerationBrief, resolves the
// brief's products_to_mention against woo_products to get real
// WooCommerce permalinks, calls Claude (MODEL_WRITER) with
// WRITER_SYSTEM_PROMPT, sanitizes Hebrew AI-tells, then POSTs to
// blog-publish so the result lands as a WordPress draft for human
// review.
//
// Lifecycle (one invocation = one task, at most):
//   1. claimNextTask('text_generation', workerId) — atomic, SKIP-LOCKED-ish
//   2. Build product permalink map (catalog-exact name → URL with UTM)
//   3. Call Claude (WRITER_SYSTEM_PROMPT + brief + permalink map)
//   4. Parse JSON {title, slug, meta_description, body}
//   5. Substitute any PERMALINK placeholders the writer emitted verbatim
//   6. Strip Hebrew AI-tells (em-dash → comma etc.) — same regex as the
//      organic blog writer in marketing-advisor (kept in sync intentionally)
//   7. POST blog-publish with status='draft'
//   8. markTaskCompleted with {wp_post_id, edit_url, link}
//   9. On failure: markTaskFailed (permanent if attempts >= max_attempts)
//
// NOT in this worker's job:
//   - Generating images. The orchestrator emits a separate
//     visual_generation task for that; seo-worker-visual handles it.
//   - Publishing live. We only push to WP as draft. Owner approves
//     manually in WP admin.
//   - Iterating the writer prompt. That lives in seo-agent/prompts/writer.ts
//     and is iterated in a dedicated prompt-tuning session.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { WRITER_SYSTEM_PROMPT } from '../seo-agent/prompts/writer.ts'
import { callClaude, parseClaudeJson, MODEL_WRITER } from '../seo-agent/claude.ts'
import {
  createSupabase,
  claimNextTask,
  markTaskCompleted,
  markTaskFailed,
} from '../seo-agent/db.ts'
import type { TextGenerationBrief, SeoTaskRow } from '../seo-agent/types.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const ANON_KEY     = Deno.env.get('SUPABASE_ANON_KEY')!

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}

serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS })
  if (req.method !== 'POST')    return jsonResponse({ error: 'POST only' }, 405)

  const workerId = `writer-${crypto.randomUUID().slice(0, 8)}`
  console.log(`[seo-worker-writer] start worker=${workerId}`)

  const supabase = createSupabase()

  // ── 1. Claim a task ────────────────────────────────────────────────────
  let task: SeoTaskRow | null
  try {
    task = await claimNextTask(supabase, 'text_generation', workerId)
  } catch (e: any) {
    console.error(`[seo-worker-writer] claimNextTask threw: ${e?.message ?? e}`)
    return jsonResponse({ error: `claim failed: ${e?.message ?? e}` }, 500)
  }

  if (!task) {
    console.log(`[seo-worker-writer] no pending tasks worker=${workerId}`)
    return jsonResponse({ processed: 0, worker_id: workerId })
  }

  console.log(`[seo-worker-writer] claimed task=${task.id} attempt=${task.attempts}/${task.max_attempts}`)

  // ── 2..N: process — wrap so any throw flips the task to failed ─────────
  try {
    const brief = task.brief_data as TextGenerationBrief
    validateBrief(brief, task.id)

    // ── 2. Resolve products_to_mention → permalink+UTM map ──────────────
    const permalinkMap = await buildPermalinkMap(
      supabase,
      brief.products_to_mention ?? [],
      brief.keyword,
    )
    console.log(`[seo-worker-writer] permalink map size=${Object.keys(permalinkMap).length}`)

    // ── 3. Call Claude ──────────────────────────────────────────────────
    const userMessage = buildWriterUserMessage(brief, permalinkMap)
    console.log(`[seo-worker-writer] calling ${MODEL_WRITER} keyword="${brief.keyword.slice(0, 60)}"`)

    const claudeRes = await callClaude({
      model:       MODEL_WRITER,
      system:      WRITER_SYSTEM_PROMPT,
      messages:    [{ role: 'user', content: userMessage }],
      maxTokens:   8192,
      temperature: 0.6,
    })
    console.log(
      `[seo-worker-writer] writer done tokens in=${claudeRes.inputTokens} ` +
      `out=${claudeRes.outputTokens} cache_read=${claudeRes.cacheReadTokens}`,
    )

    // ── 4. Parse the JSON draft ─────────────────────────────────────────
    interface WriterOutput {
      title:            string
      slug:             string
      meta_description: string
      body:             string
    }
    let draft: WriterOutput
    try {
      draft = parseClaudeJson<WriterOutput>(claudeRes.text)
    } catch (e: any) {
      throw new Error(`writer returned unparseable JSON: ${e?.message ?? e} — raw: ${claudeRes.text.slice(0, 400)}`)
    }
    if (!draft.title?.trim() || !draft.body?.trim()) {
      throw new Error(`writer output missing title or body — raw: ${JSON.stringify(draft).slice(0, 400)}`)
    }

    // ── 5. Substitute PERMALINK placeholders the writer may have emitted
    //     verbatim instead of inlining the real URL. The prompt asks for
    //     [שם המוצר](PERMALINK) which the runner replaces with the actual
    //     permalink. Cheap defense-in-depth — most writes will already
    //     contain real URLs from the prompt's permalink map.
    let body = substitutePermalinks(draft.body, permalinkMap)

    // ── 6. Strip Hebrew AI-tells (em-dashes, " - " etc.) ────────────────
    body = sanitizeHebrew(body)
    const title           = sanitizeHebrew(draft.title)
    const metaDescription = sanitizeHebrew(draft.meta_description ?? '')

    // ── 7. POST to blog-publish (WordPress draft) ───────────────────────
    const slug = (draft.slug ?? '').trim().slice(0, 60) || undefined
    const pubRes = await fetch(`${SUPABASE_URL}/functions/v1/blog-publish`, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ANON_KEY}`,
        apikey: ANON_KEY,
      },
      body: JSON.stringify({
        title:            title,
        content_markdown: body,
        slug,
        excerpt:          metaDescription,
        status:           'draft',
      }),
    })
    const pubJson = await pubRes.json().catch(() => ({})) as {
      ok?:        boolean
      id?:        number
      link?:      string
      edit_url?:  string
      status?:    string
      error?:     string
      warnings?:  string[]
    }
    if (!pubRes.ok || !pubJson.ok || !pubJson.id) {
      throw new Error(`blog-publish failed HTTP ${pubRes.status}: ${pubJson.error ?? '(no error body)'}`)
    }

    // ── 8. Mark completed ───────────────────────────────────────────────
    await markTaskCompleted(supabase, task.id, {
      wp_post_id: pubJson.id,
      edit_url:   pubJson.edit_url,
      link:       pubJson.link,
      status:     pubJson.status,
      title,
      slug,
      keyword:    brief.keyword,
      warnings:   pubJson.warnings,
      tokens: {
        input:      claudeRes.inputTokens,
        output:     claudeRes.outputTokens,
        cache_read: claudeRes.cacheReadTokens,
      },
      completed_at: new Date().toISOString(),
    })

    console.log(`[seo-worker-writer] ✓ task=${task.id} wp_id=${pubJson.id} edit_url=${pubJson.edit_url}`)
    return jsonResponse({
      processed: 1,
      worker_id: workerId,
      task_id:   task.id,
      wp_post_id: pubJson.id,
      edit_url:   pubJson.edit_url,
    })
  } catch (e: any) {
    const msg = e?.message ?? String(e)
    console.error(`[seo-worker-writer] ✗ task=${task.id} failed: ${msg}`)
    console.error(e?.stack ?? '')

    // attempts has already been incremented by claimNextTask, so the
    // current value is the count INCLUDING this attempt.
    const permanentlyFailed = task.attempts >= task.max_attempts
    try {
      await markTaskFailed(supabase, task.id, msg, permanentlyFailed)
    } catch (markErr: any) {
      console.error(`[seo-worker-writer] markTaskFailed also threw: ${markErr?.message ?? markErr}`)
    }

    return jsonResponse({
      processed: 0,
      worker_id: workerId,
      task_id:   task.id,
      failed:    true,
      permanent: permanentlyFailed,
      error:     msg,
    }, 200)  // 200 so cron doesn't retry-storm us; the task lifecycle is the source of truth
  }
})

// ── helpers ────────────────────────────────────────────────────────────

function validateBrief(brief: TextGenerationBrief, taskId: string): void {
  if (!brief || typeof brief !== 'object') {
    throw new Error(`task ${taskId} brief_data is not an object`)
  }
  if (!brief.keyword?.trim()) throw new Error(`task ${taskId} brief.keyword is required`)
  if (!brief.title?.trim())   throw new Error(`task ${taskId} brief.title is required`)
  if (!Array.isArray(brief.key_points) || brief.key_points.length === 0) {
    throw new Error(`task ${taskId} brief.key_points must be a non-empty array`)
  }
  if (!Array.isArray(brief.products_to_mention)) {
    // products_to_mention is required by the type but the orchestrator
    // could emit [] legitimately. Coerce to [] for the catalog lookup.
    (brief as any).products_to_mention = []
  }
}

// products_to_mention is *supposed* to be an array of catalog-exact strings,
// but in the wild it arrives in two broken shapes that both produced
// link-free articles:
//   1. generic phrases the LLM invented ("קפה אתיופיה", "קפה מינוטו") that
//      never equal a real woo_products.name, so a strict .in() match dropped
//      every product.
//   2. objects { name, url } instead of plain strings — String(item) became
//      "[object Object]", so even a correct product with its real URL right
//      there in the payload resolved to nothing.
// So normalize the entries to { name, permalink? } first.
function normalizeProductItems(raw: unknown): Array<{ name: string; permalink: string | null }> {
  if (!Array.isArray(raw)) return []
  const out: Array<{ name: string; permalink: string | null }> = []
  for (const item of raw) {
    if (typeof item === 'string') {
      const name = item.trim()
      if (name) out.push({ name, permalink: null })
    } else if (item && typeof item === 'object') {
      const o = item as Record<string, unknown>
      const name = String(o.name ?? o.product ?? o.title ?? '').trim()
      const pl   = String(o.permalink ?? o.url ?? o.link ?? '').trim()
      if (name) out.push({ name, permalink: isMinutoUrl(pl) ? pl : null })
    }
  }
  return out
}

function isMinutoUrl(u: string): boolean {
  return /^https?:\/\/(www\.)?minuto\.co\.il\//i.test(u)
}

// Lowercase, strip niqqud, collapse everything that isn't a latin/digit/Hebrew
// letter to single spaces. Lets us match a short token the LLM actually wrote
// ("Yirgacheffe", "קפה אתיופיה דיי בנסה") against the long bilingual catalog
// name ("פולי קפה אתיופיה דיי בנסה חד זני - Minuto Daye Bensa...").
function normalizeForMatch(s: string): string {
  return (s ?? '')
    .toLowerCase()
    .replace(/[֑-ׇ]/g, '')              // niqqud / cantillation
    .replace(/[^a-z0-9֐-׿]+/g, ' ')     // keep latin, digits, Hebrew
    .replace(/\s+/g, ' ')
    .trim()
}

// Best fuzzy match of a requested product name against the live catalog.
// Two-level rank:
//   1. matchScore — exact-normalized (3) > catalog-contains-request (2, the
//      common case: short token inside the long bilingual name) > request-
//      contains-catalog (1).
//   2. quality — among equal matches, prefer a roasted Minuto RETAIL bag and
//      penalize GREEN/unroasted SKUs ("קפה ירוק", sold by the kg for home
//      roasters), which a consumer article must never link. Ties then go to
//      the shortest name (most specific).
// Skips ultra-generic tokens (< 4 letters, e.g. "קפה" alone).
function bestCatalogMatch(
  name: string,
  catalog: Array<{ name: string; permalink: string; norm: string }>,
): { name: string; permalink: string } | null {
  const q = normalizeForMatch(name)
  if (q.replace(/\s/g, '').length < 4) return null
  let best: { row: { name: string; permalink: string }; matchScore: number; quality: number; len: number } | null = null
  for (const row of catalog) {
    let matchScore = 0
    if (row.norm === q) matchScore = 3
    else if (row.norm.includes(q)) matchScore = 2
    else if (q.includes(row.norm) && row.norm.replace(/\s/g, '').length >= 4) matchScore = 1
    if (matchScore === 0) continue
    let quality = 0
    if (row.norm.includes('minuto'))   quality += 1   // our own roastery line
    if (row.norm.includes('פולי קפה')) quality += 1   // whole roasted beans
    if (row.norm.includes('ירוק'))     quality -= 3   // green/unroasted — wrong for a consumer post
    const better = !best
      || matchScore > best.matchScore
      || (matchScore === best.matchScore && quality > best.quality)
      || (matchScore === best.matchScore && quality === best.quality && row.name.length < best.len)
    if (better) best = { row: { name: row.name, permalink: row.permalink }, matchScore, quality, len: row.name.length }
  }
  return best ? best.row : null
}

// Resolve products_to_mention → { displayName → permalink+UTM }. An entry that
// already carries a real Minuto URL uses it directly; otherwise we fuzzy-match
// the name against the live catalog. Keyed by the name the WRITER will use as
// anchor text, so the prompt's products block + substitutePermalinks line up.
// Truly unresolvable names are dropped (no invented URLs).
async function buildPermalinkMap(
  supabase: ReturnType<typeof createSupabase>,
  rawProducts: unknown,
  keyword: string,
): Promise<Record<string, string>> {
  const items = normalizeProductItems(rawProducts)
  if (items.length === 0) return {}

  const utmCampaign = slugifyKeyword(keyword)
  const map: Record<string, string> = {}

  // Catalog snapshot (name + permalink) for fuzzy matching. Only fetched if
  // at least one item needs a lookup (i.e. has no embedded permalink).
  // PostgREST caps a plain select at db-max-rows (1000) and woo_products has
  // more than that, so PAGINATE — otherwise the tail of the catalog (e.g. the
  // Colombian single-origins) is invisible and those products never resolve.
  let catalog: Array<{ name: string; permalink: string; norm: string }> = []
  if (items.some(i => !i.permalink)) {
    const PAGE = 1000
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from('woo_products')
        .select('name, permalink')
        .range(from, from + PAGE - 1)
      if (error) {
        console.warn(`[seo-worker-writer] woo_products lookup failed: ${error.message}`)
        break
      }
      const rows = data ?? []
      for (const r of rows) {
        if (typeof r.permalink === 'string' && r.permalink.length > 0) {
          catalog.push({ name: r.name as string, permalink: r.permalink, norm: normalizeForMatch(r.name as string) })
        }
      }
      if (rows.length < PAGE) break
    }
  }

  for (const item of items) {
    if (item.permalink) { map[item.name] = withUtm(item.permalink, utmCampaign); continue }
    const match = bestCatalogMatch(item.name, catalog)
    if (match) map[item.name] = withUtm(match.permalink, utmCampaign)
  }

  const missing = items.filter(i => !(i.name in map)).map(i => i.name)
  if (missing.length > 0) {
    console.log(`[seo-worker-writer] no permalink for: ${missing.join(' | ')}`)
  }
  return map
}

function withUtm(url: string, campaign: string): string {
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}utm_source=blog&utm_medium=article&utm_campaign=${encodeURIComponent(campaign)}`
}

// Convert a Hebrew/Latin keyword to a UTM-safe campaign id. Latin chars
// + digits stay; everything else (Hebrew, spaces, punctuation) becomes
// a hyphen. Hebrew works fine in URLs but UTM tooling prefers ASCII.
function slugifyKeyword(keyword: string): string {
  return (keyword ?? '')
    .toLowerCase()
    .replace(/[֑-ׇ]/g, '')   // strip niqqud
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'seo'
}

// The writer prompt instructs the model to format product links as
// `[שם המוצר](PERMALINK)`. We pre-compute real permalinks and pass them
// in the user message, so the model usually writes the real URL inline.
// But if the model emits the literal token `PERMALINK` (or `(PERMALINK)`
// with no scheme) for a product whose name appears in the link text, we
// patch it post-hoc. Belt-and-suspenders against the model copy-pasting
// the prompt verbatim.
function substitutePermalinks(body: string, map: Record<string, string>): string {
  if (!body) return body
  // Pattern: [link text](PERMALINK)  — with PERMALINK literal
  return body.replace(/\[([^\]]+)\]\(\s*PERMALINK\s*\)/g, (full, anchor: string) => {
    const trimmedAnchor = anchor.trim()
    // Try exact match first, then case-insensitive contains.
    if (map[trimmedAnchor]) return `[${trimmedAnchor}](${map[trimmedAnchor]})`
    const ciKey = Object.keys(map).find(k => k.toLowerCase() === trimmedAnchor.toLowerCase())
    if (ciKey) return `[${trimmedAnchor}](${map[ciKey]})`
    const containsKey = Object.keys(map).find(k => trimmedAnchor.includes(k) || k.includes(trimmedAnchor))
    if (containsKey) return `[${trimmedAnchor}](${map[containsKey]})`
    // No match — leave the placeholder for human review (better than
    // emitting a broken link that 404s on a published post).
    console.warn(`[seo-worker-writer] PERMALINK placeholder not resolved for anchor="${trimmedAnchor}"`)
    return full
  })
}

// Hebrew sanitizer — kept identical to marketing-advisor's blog body
// strip so the two writer paths produce the same output style. Em-dashes
// and " - " are the loudest AI-tells in Hebrew copy and the model keeps
// emitting them despite the prompt rule. PRESERVED on purpose: Hebrew
// prefix hyphens (ב-, ל-, מ-) and markdown bullets ("- " at line start)
// — the " - " regex requires whitespace on both sides.
function sanitizeHebrew(text: string): string {
  if (!text) return text
  return text
    .replace(/—/g, ',')   // em-dash → comma
    .replace(/–/g, ',')   // en-dash → comma
    .replace(/‒/g, ',')   // figure dash → comma
    .replace(/―/g, ',')   // horizontal bar → comma
    .replace(/‐/g, '-')   // unicode hyphen → ASCII hyphen
    .replace(/‑/g, '-')   // non-breaking hyphen → ASCII hyphen
    .replace(/ -- /g, ', ')    // " -- "
    .replace(/ - /g, ', ')     // " - " (the big AI tell)
}

// Build the user message for the Writer. Pairs the brief with the
// resolved permalink map so the model can inline real URLs (instead of
// the literal `PERMALINK` placeholder from the system prompt example).
function buildWriterUserMessage(
  brief: TextGenerationBrief,
  permalinkMap: Record<string, string>,
): string {
  const keyPointsBlock = brief.key_points
    .map((kp, i) => `  ${i + 1}. ${kp}`)
    .join('\n')

  const productNames = normalizeProductItems(brief.products_to_mention).map(i => i.name)
  const productsBlock = productNames.length === 0
    ? '  (none — orchestrator chose not to anchor to specific SKUs this round)'
    : productNames
        .map(name => {
          const url = permalinkMap[name]
          return url ? `  • "${name}" → ${url}` : `  • "${name}" → (no permalink in catalog — DROP this product, do not invent a URL)`
        })
        .join('\n')

  const internalLinksBlock = (brief.internal_links ?? []).length === 0
    ? ''
    : `\nINTERNAL LINKS to weave in where natural (URL → anchor):\n` +
      (brief.internal_links ?? [])
        .map(l => `  • ${l.url} → "${l.anchor}"`)
        .join('\n') + '\n'

  const optionalLines = [
    brief.why_now             ? `WHY NOW: ${brief.why_now}` : '',
    brief.target_word_count   ? `TARGET WORD COUNT: ~${brief.target_word_count} (±20% OK)` : '',
    brief.current_position    ? `CURRENT GSC POSITION: ${brief.current_position} (we are optimizing an existing-rank keyword)` : '',
    brief.search_volume_signal ? `SEARCH VOLUME SIGNAL: ${brief.search_volume_signal}` : '',
    brief.competitive_angle   ? `COMPETITIVE ANGLE: ${brief.competitive_angle}` : '',
  ].filter(Boolean).join('\n')

  return `=== ARTICLE BRIEF ===

KEYWORD: "${brief.keyword}"
TITLE (H1): ${brief.title}

KEY POINTS to cover (each becomes 1-3 paragraphs):
${keyPointsBlock}

PRODUCTS TO MENTION (catalog-exact names + their real permalinks already resolved — inline these URLs directly in the markdown links):
${productsBlock}
${internalLinksBlock}${optionalLines ? '\n' + optionalLines + '\n' : ''}
=== INSTRUCTIONS ===

Write the full article body in Hebrew markdown per the system prompt. EVERY product above that has a resolved URL MUST appear in the body as a real markdown link [שם המוצר](THAT_URL) at least once, woven naturally into the relevant section — substitute the real URL, NOT the literal text PERMALINK, and do not skip a resolved product. If a product has no resolved URL, drop it entirely; do not invent a link. An article that recommends or discusses a coffee we sell but links zero products is a failure — prefer placing the product link where the reader is most likely to act (next to a tasting note, brew recommendation, or "which beans" mention).

Return strict JSON only:
{
  "title":            "Hebrew H1",
  "slug":             "english-url-slug",
  "meta_description": "150-160 char Hebrew SERP description",
  "body":             "full Hebrew markdown article body with H2 subheads and real product links"
}`
}
