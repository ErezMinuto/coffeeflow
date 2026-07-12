// Minuto Organic Marketing — technical-SEO worker (FAQ authoring).
//
// Drains 'technical_seo' tasks (subtype 'faq_injection'). For each target
// blog article it:
//   1. Resolves the post id (from id or url).
//   2. Fetches the LIVE page and checks whether an FAQ already exists
//      (data-source="minuto-product-faq"). If so → no-op skip.
//   3. Fetches the article text via the public WP REST API.
//   4. Calls Claude to author 3-6 Hebrew Q&A grounded in the article,
//      following Minuto brand voice.
//   5. Stores the proposal in result_data with review_required=true and
//      faq_written=false. It does NOT write to the live page — that
//      happens only when the admin approves via the approve_post_faq chat
//      tool (the no-auto-publish gate, applied to live FAQ writes too).
//
// Identification (WHICH articles) is done upstream by the orchestrator,
// which queues these tasks from top organic blog landing pages. The worker
// is the authoring half; the admin is the gate.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import {
  createSupabase,
  claimNextTask,
  markTaskCompleted,
  markTaskFailed,
} from '../seo-agent/db.ts'
import { callClaude, MODEL_ORCHESTRATOR, parseClaudeJson } from '../seo-agent/claude.ts'
import type { SeoTaskRow, TechnicalSeoBrief } from '../seo-agent/types.ts'

const WP_URL = (Deno.env.get('WOO_URL') ?? 'https://www.minuto.co.il').replace(/\/+$/, '')

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } })
}

interface FaqPair { q: string; a: string }

const SYSTEM_PROMPT = `You are Minuto's Hebrew technical-SEO copywriter. Given a blog article, you author a short FAQ (שאלות נפוצות) that will be added to the page as an accordion + FAQPage structured data (schema.org) to improve organic visibility.

RULES:
- Write in HEBREW.
- Author ONLY questions a real searcher would type, that the article genuinely answers. Ground every answer in the article's own content — do NOT invent facts, prices, or claims the article doesn't support.
- Brand voice: gender-inclusive (avoid masculine-only 2nd-person verbs like תחזור/תיהנה — use plural or restructure); NO em-dashes (use commas); use "אלו ש..." not "מי ש..."; never disparage other brands, gear, or supermarket coffee — positive framing only.
- Answers: 1-3 sentences, concrete and useful. Aftertaste = "סיומת" (feminine). Prefer "מתיקות עדינה" over "ממתקת".
- Questions should target the article's head term naturally (helps the FAQ rank for long-tail variants).

OUTPUT: strict JSON only, no preamble:
{"faq":[{"q":"...","a":"..."}, ...]}`

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST')    return jsonResponse({ error: 'POST only' }, 405)

  const workerId = `techseo-${crypto.randomUUID().slice(0, 8)}`
  const supabase = createSupabase()

  let task: SeoTaskRow | null
  try {
    task = await claimNextTask(supabase, 'technical_seo', workerId)
  } catch (e: any) {
    console.error(`[seo-worker-techseo] ${workerId} claim failed: ${e?.message ?? e}`)
    return jsonResponse({ processed: 0, worker_id: workerId, error: e?.message ?? String(e) }, 500)
  }
  if (!task) return jsonResponse({ processed: 0, worker_id: workerId })
  console.log(`[seo-worker-techseo] ${workerId} claimed task ${task.id}`)

  const brief = task.brief_data as TechnicalSeoBrief
  if ((brief?.subtype ?? 'faq_injection') !== 'faq_injection') {
    await safeMarkFailed(supabase, task, `unsupported technical_seo subtype '${brief?.subtype}' (worker handles faq_injection only)`, true)
    return jsonResponse({ processed: 1, worker_id: workerId, task_id: task.id, ok: false, error: 'unsupported subtype' })
  }

  // The canonical brief fields are target_post_id / target_post_url, but the
  // chat queue_task tool routinely emits the bare post_id / post_url aliases —
  // every other FAQ tool in that same toolset (set_post_faq, get_post_faq,
  // approve_post_faq) speaks post_id/post_url, so the agent naturally reuses
  // them here. Accept both, or the task dies at "unresolved target" before the
  // resolver (and its #191 HTML fallback) ever runs.
  const briefAlias   = brief as unknown as Record<string, unknown>
  const briefPostId  = coercePostId(brief.target_post_id) || coercePostId(briefAlias.post_id)
  const briefPostUrl = coerceUrl(brief.target_post_url) || coerceUrl(briefAlias.post_url)

  // ── 1. Resolve target post id ──────────────────────────────────────
  let postId = briefPostId
  if (!postId && briefPostUrl) {
    const resolved = await resolvePostId(briefPostUrl)
    if (resolved) postId = resolved
  }
  if (!postId) {
    await safeMarkFailed(supabase, task, 'could not resolve target post (need target_post_id or a resolvable target_post_url)', true)
    return jsonResponse({ processed: 1, worker_id: workerId, task_id: task.id, ok: false, error: 'unresolved target' })
  }

  // ── 2. Skip if the article already has an FAQ ──────────────────────
  const pageUrl = briefPostUrl || `${WP_URL}/?p=${postId}`
  try {
    const pageRes = await fetch(pageUrl, { headers: { 'User-Agent': 'MinutoTechSeoWorker/1.0' } })
    if (pageRes.ok) {
      const html = await pageRes.text()
      if (html.includes('data-source="minuto-product-faq"')) {
        await markTaskCompleted(supabase, task.id, {
          subtype: 'faq_injection',
          target_post_id: postId,
          target_post_url: briefPostUrl || null,
          skipped: 'already_has_faq',
          review_required: false,
          faq_written: false,
        })
        console.log(`[seo-worker-techseo] ${workerId} post ${postId} already has FAQ — skip`)
        return jsonResponse({ processed: 1, worker_id: workerId, task_id: task.id, ok: true, skipped: 'already_has_faq' })
      }
    }
  } catch (e: any) {
    // Non-fatal: if the page fetch fails we still proceed to author a
    // proposal (the admin gate catches any duplicate before it goes live).
    console.warn(`[seo-worker-techseo] ${workerId} page check failed (non-fatal): ${e?.message ?? e}`)
  }

  // ── 3. Fetch article content (public WP REST) ──────────────────────
  let title = brief.article_title ?? ''
  let bodyText = ''
  try {
    const res = await fetch(`${WP_URL}/wp-json/wp/v2/posts/${postId}?_fields=title,content,link`)
    if (!res.ok) {
      await safeMarkFailed(supabase, task, `WP REST returned ${res.status} for post ${postId} (is it a 'post'? products aren't supported here)`, true)
      return jsonResponse({ processed: 1, worker_id: workerId, task_id: task.id, ok: false, error: `wp ${res.status}` })
    }
    const data = await res.json() as { title?: { rendered?: string }; content?: { rendered?: string } }
    title = data.title?.rendered ?? title
    bodyText = (data.content?.rendered ?? '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&[a-z]+;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 6000)
  } catch (e: any) {
    await safeMarkFailed(supabase, task, `article fetch failed: ${e?.message ?? e}`, false)
    return jsonResponse({ processed: 1, worker_id: workerId, task_id: task.id, ok: false, error: 'article fetch failed' })
  }
  if (bodyText.length < 200) {
    await safeMarkFailed(supabase, task, `article body too short (${bodyText.length} chars) to author a grounded FAQ`, true)
    return jsonResponse({ processed: 1, worker_id: workerId, task_id: task.id, ok: false, error: 'article too short' })
  }

  // ── 4. Author the FAQ via Claude ───────────────────────────────────
  const targetCount = Math.max(3, Math.min(6, brief.target_faq_count ?? 5))
  const userMsg = `כותרת המאמר: ${title}\n\nתוכן המאמר (טקסט נקי):\n${bodyText}\n\nכתוב/כתבי ${targetCount} שאלות ותשובות נפוצות (FAQ) המבוססות אך ורק על תוכן המאמר. החזר JSON בלבד בפורמט {"faq":[{"q":"...","a":"..."}]}.`

  let proposedFaq: FaqPair[] = []
  let tokens = { input: 0, output: 0 }
  try {
    const res = await callClaude({
      model:       MODEL_ORCHESTRATOR,
      system:      SYSTEM_PROMPT,
      messages:    [{ role: 'user', content: userMsg }],
      maxTokens:   2048,
      temperature: 0.4,
      timeoutMs:   90_000,
    })
    tokens = { input: res.inputTokens, output: res.outputTokens }
    const parsed = parseClaudeJson<{ faq?: Array<{ q?: unknown; a?: unknown }> }>(res.text)
    proposedFaq = (Array.isArray(parsed?.faq) ? parsed.faq : [])
      .map(p => ({ q: typeof p.q === 'string' ? p.q.trim() : '', a: typeof p.a === 'string' ? p.a.trim() : '' }))
      .filter(p => p.q && p.a)
  } catch (e: any) {
    const permanent = task.attempts >= task.max_attempts
    await safeMarkFailed(supabase, task, `FAQ authoring failed: ${e?.message ?? e}`, permanent)
    return jsonResponse({ processed: 1, worker_id: workerId, task_id: task.id, ok: false, error: 'authoring failed', permanent })
  }
  if (proposedFaq.length < 2) {
    await safeMarkFailed(supabase, task, `Claude returned only ${proposedFaq.length} valid Q&A — too few to propose`, task.attempts >= task.max_attempts)
    return jsonResponse({ processed: 1, worker_id: workerId, task_id: task.id, ok: false, error: 'too few pairs' })
  }

  // ── 5. Store the PROPOSAL — no live write. review_required gates it. ─
  try {
    await markTaskCompleted(supabase, task.id, {
      subtype:          'faq_injection',
      target_post_id:   postId,
      target_post_url:  briefPostUrl || null,
      article_title:    title,
      rationale_signal: brief.rationale_signal ?? null,
      proposed_faq:     proposedFaq,
      faq_count:        proposedFaq.length,
      review_required:  true,   // surfaces the amber HITL chip in SeoTaskQueue
      faq_written:      false,  // flips true only after approve_post_faq
      tokens,
    })
  } catch (e: any) {
    console.error(`[seo-worker-techseo] ${workerId} markTaskCompleted failed: ${e?.message ?? e}`)
    return jsonResponse({ processed: 1, worker_id: workerId, task_id: task.id, ok: false, error: e?.message ?? String(e) }, 500)
  }

  console.log(`[seo-worker-techseo] ${workerId} proposed ${proposedFaq.length} Q&A for post ${postId} (awaiting approval)`)
  return jsonResponse({
    processed:   1,
    worker_id:   workerId,
    task_id:     task.id,
    ok:          true,
    target_post_id: postId,
    faq_count:   proposedFaq.length,
    review_required: true,
  })
})

// Coerce a brief value to a positive integer post id. Tolerates the number
// the canonical brief carries and the numeric string an LLM-built brief may
// emit; anything else → 0 (falsy, so the URL resolver takes over).
function coercePostId(v: unknown): number {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v.trim()) : NaN)
  return Number.isInteger(n) && n > 0 ? n : 0
}

// Coerce a brief value to a non-empty trimmed URL string, else ''.
function coerceUrl(v: unknown): string {
  return typeof v === 'string' && v.trim() ? v.trim() : ''
}

// Resolve a post URL → numeric id.
//
// First tries the fast public slug lookup. That can miss on this Hebrew site:
// GA4 page_paths carry percent-encoded Hebrew slugs whose sanitized form does
// not always round-trip against WP's stored post_name, and some top organic
// /blog/* URLs aren't a plain post slug at all. So when the slug lookup finds
// nothing, fall back to the post id WordPress reliably emits in the rendered
// page HTML (shortlink ?p= / body "postid-" class / embedded REST link) —
// encoding- and permalink-agnostic.
async function resolvePostId(url: string): Promise<number | null> {
  let slug = ''
  try {
    const path = new URL(url).pathname.replace(/\/+$/, '')
    slug = decodeURIComponent(path.split('/').filter(Boolean).pop() ?? '')
  } catch { return null }

  if (slug) {
    try {
      const res = await fetch(`${WP_URL}/wp-json/wp/v2/posts?slug=${encodeURIComponent(slug)}&_fields=id`)
      if (res.ok) {
        const arr = await res.json()
        if (Array.isArray(arr) && arr[0] && typeof arr[0].id === 'number') return arr[0].id
      }
    } catch { /* fall through to the HTML parse below */ }
  }

  // Fallback: the WP-rendered page carries its own post id in stable places.
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'MinutoTechSeoWorker/1.0' } })
    if (res.ok) {
      const id = extractPostIdFromHtml(await res.text())
      if (id) return id
    }
  } catch { /* noop */ }
  return null
}

// Pull the numeric post id out of a WordPress-rendered page. WP emits it in
// several stable places regardless of slug encoding or permalink structure.
function extractPostIdFromHtml(html: string): number | null {
  const patterns = [
    /rel=["']shortlink["'][^>]*?href=["'][^"']*?[?&]p=(\d+)/i,        // <link rel=shortlink href=".../?p=123">
    /href=["'][^"']*?[?&]p=(\d+)["'][^>]*?rel=["']shortlink["']/i,    // same, attrs reversed
    /<body[^>]*\bclass=["'][^"']*\bpostid-(\d+)/i,                    // <body class="... postid-123 ...">
    /wp-json\\?\/wp\\?\/v2\\?\/posts\\?\/(\d+)/i,                     // embedded REST link (raw or JSON-escaped)
  ]
  for (const re of patterns) {
    const m = html.match(re)
    if (m) {
      const id = Number(m[1])
      if (Number.isInteger(id) && id > 0) return id
    }
  }
  return null
}

async function safeMarkFailed(supabase: ReturnType<typeof createSupabase>, task: SeoTaskRow, msg: string, permanent: boolean): Promise<void> {
  try { await markTaskFailed(supabase, task.id, msg, permanent) }
  catch (e: any) { console.error(`[seo-worker-techseo] markTaskFailed write failed: ${e?.message ?? e}`) }
}
