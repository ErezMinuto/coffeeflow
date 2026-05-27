// Minuto Organic Marketing — Instagram worker.
//
// Cron-polled (every 2 min via pg_cron) worker that processes one
// `instagram_post` task per invocation. Reads `brief_data`
// (InstagramPostBrief), resolves the image from the parent
// visual_generation task, builds the caption (verbatim from brief +
// optional CTA + hashtags), and either:
//   • publish_strategy='auto'             → calls meta-publish action='publish_now'
//   • publish_strategy='queue_for_review' → calls meta-publish action='prepare'
//                                            (creates IG container, returns
//                                             creation_id, no quota burn).
//                                            Admin reviews + manually publishes.
//
// Architectural decisions:
//
// 1. WE DO NOT WRITE CAPTIONS. The strategist writes caption_he verbatim
//    in the brief. This worker just packages it. Keeps the brand-voice
//    contract single-source-of-truth (strategist owns voice; worker owns
//    execution). If captions need rewriting per cycle, that's a
//    strategist-prompt problem, not a worker problem.
//
// 2. IMAGE RESOLUTION VIA PARENT TASK. The orchestrator pairs each
//    instagram_post with a visual_generation task via parent_task_id.
//    We look up parent.result_data.image_url after the visual worker
//    completes. If the parent isn't ready yet, we release the row back
//    to pending WITHOUT counting an attempt (same pattern as the
//    visual worker's parent-not-ready release).
//
// 3. QUOTA AWARENESS. meta-publish already tracks the 50-posts/24h IG
//    quota and refuses to publish past it. We surface that error
//    cleanly: failed task with quota_exhausted=true so the admin
//    knows to wait, not to debug.
//
// 4. ON FAILURE: linear retry via markTaskFailed (same semantics as
//    the writer + visual workers). attempts>=max_attempts flips to 'failed'.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import {
  createSupabase,
  claimNextTask,
  markTaskCompleted,
  markTaskFailed,
} from '../seo-agent/db.ts'
import type { SeoTaskRow, InstagramPostBrief } from '../seo-agent/types.ts'

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

// IG caption hard limit. meta-publish also enforces this; we duplicate
// the check here for a clearer failure path (brief invalid vs. API rejected).
const IG_CAPTION_MAX = 2200

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST')    return jsonResponse({ error: 'POST only' }, 405)

  const workerId = `ig-${crypto.randomUUID().slice(0, 8)}`
  const supabase = createSupabase()

  // ── 1. Claim one task ───────────────────────────────────────────────
  let task: SeoTaskRow | null
  try {
    task = await claimNextTask(supabase, 'instagram_post', workerId)
  } catch (e: any) {
    console.error(`[organic-worker-instagram] ${workerId} claim failed: ${e?.message ?? e}`)
    return jsonResponse({ processed: 0, worker_id: workerId, error: e?.message ?? String(e) }, 500)
  }
  if (!task) return jsonResponse({ processed: 0, worker_id: workerId })
  console.log(`[organic-worker-instagram] ${workerId} claimed task ${task.id} attempt=${task.attempts}`)

  // ── 2. Parse + validate brief ───────────────────────────────────────
  const brief = task.brief_data as InstagramPostBrief
  const caption_he = (brief?.caption_he ?? '').trim()
  const hashtags = Array.isArray(brief?.hashtags) ? brief.hashtags : []
  const mediaType = brief?.media_type ?? 'feed_image'
  const publishStrategy = brief?.publish_strategy ?? 'queue_for_review'

  if (!caption_he) {
    await safeMarkFailed(supabase, task, 'caption_he is required (non-empty)', true)
    return jsonResponse({ processed: 1, worker_id: workerId, task_id: task.id, ok: false, error: 'caption_he missing' })
  }
  if (mediaType !== 'feed_image') {
    // v1 only handles feed_image. Other types get flagged for HITL
    // (admin still sees the brief in the queue, can publish manually).
    await safeMarkFailed(supabase, task, `media_type '${mediaType}' not yet supported by automated worker (v1 = feed_image only) — admin must publish manually via meta-publish`, true)
    return jsonResponse({ processed: 1, worker_id: workerId, task_id: task.id, ok: false, error: 'media_type unsupported in v1' })
  }

  // ── 3. Resolve image from parent visual_generation task ─────────────
  // Same parent-not-ready release pattern as seo-worker-visual uses for
  // its blog_banner attach: if the visual worker hasn't completed yet,
  // release this row back to pending WITHOUT counting an attempt.
  if (!task.parent_task_id) {
    await safeMarkFailed(supabase, task, 'instagram_post requires parent_task_id pointing at a visual_generation task that produces the image', true)
    return jsonResponse({ processed: 1, worker_id: workerId, task_id: task.id, ok: false, error: 'parent_task_id missing' })
  }

  const { data: parent, error: parentErr } = await supabase
    .from('seo_tasks')
    .select('id, status, result_data')
    .eq('id', task.parent_task_id)
    .maybeSingle()

  if (parentErr) {
    await safeMarkFailed(supabase, task, `parent lookup failed: ${parentErr.message}`, false)
    return jsonResponse({ processed: 1, worker_id: workerId, task_id: task.id, ok: false, error: 'parent lookup error' })
  }
  if (!parent || parent.status !== 'completed') {
    // Visual worker hasn't finished. Release back to pending without
    // counting an attempt — visual generation has its own QA loop that
    // can take 2-3 min, and we shouldn't burn a retry slot waiting.
    await releaseForParentNotReady(
      supabase,
      task,
      `parent visual task ${task.parent_task_id} not yet completed (status=${parent?.status ?? 'missing'})`,
    )
    return jsonResponse({
      processed: 1,
      worker_id: workerId,
      task_id:   task.id,
      ok:        false,
      retry:     true,
      reason:    'parent_not_ready',
    })
  }

  const parentResult = (parent.result_data ?? {}) as { image_url?: string; review_required?: boolean }
  if (parentResult.review_required === true) {
    // Visual worker capped without passing QA → the image is bad. Don't
    // post a bad image to IG. Mark this task for HITL too so admin can
    // re-queue the whole pair with a better visual brief.
    await safeMarkFailed(supabase, task, `parent visual task ${task.parent_task_id} did NOT pass QA (review_required=true). Re-queue with a refined scene_brief before publishing.`, true)
    return jsonResponse({ processed: 1, worker_id: workerId, task_id: task.id, ok: false, error: 'parent visual failed QA' })
  }
  const imageUrl = parentResult.image_url
  if (!imageUrl) {
    await safeMarkFailed(supabase, task, `parent visual task ${task.parent_task_id} completed but result_data has no image_url`, true)
    return jsonResponse({ processed: 1, worker_id: workerId, task_id: task.id, ok: false, error: 'image_url missing on parent' })
  }

  // ── 4. Build the final caption ──────────────────────────────────────
  // Strategist writes caption_he verbatim. We append optional CTA (own
  // line) + product permalink line (if product_reference set) + hashtags
  // (own line, space-separated). Keep total under IG's 2200 char cap.
  const finalCaption = buildFinalCaption({
    caption_he:        caption_he,
    cta:               brief.cta,
    product_reference: brief.product_reference,
    hashtags,
  })
  if (finalCaption.length > IG_CAPTION_MAX) {
    await safeMarkFailed(supabase, task, `final caption ${finalCaption.length} chars exceeds IG cap ${IG_CAPTION_MAX}. Strategist must trim caption_he.`, true)
    return jsonResponse({ processed: 1, worker_id: workerId, task_id: task.id, ok: false, error: 'caption too long' })
  }

  // ── 5. Call meta-publish based on publish_strategy ──────────────────
  const action = publishStrategy === 'auto' ? 'publish_now' : 'prepare'
  console.log(`[organic-worker-instagram] ${workerId} action=${action} image_url=${imageUrl} caption_len=${finalCaption.length}`)

  let metaResult: Record<string, unknown> = {}
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/meta-publish`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ANON_KEY}`, apikey: ANON_KEY },
      body: JSON.stringify({
        action,
        type:      'feed',
        caption:   finalCaption,
        image_url: imageUrl,
      }),
    })
    const json = await res.json().catch(() => ({})) as Record<string, unknown>
    if (!res.ok) {
      const errMsg = (json.error as string) ?? JSON.stringify(json).slice(0, 300)
      // Detect quota exhaustion so admin gets a clear signal.
      const quotaExhausted = errMsg.toLowerCase().includes('quota') || errMsg.toLowerCase().includes('limit')
      const permanently = quotaExhausted || (task.attempts >= task.max_attempts)
      await safeMarkFailed(supabase, task, `meta-publish HTTP ${res.status}: ${errMsg}`, permanently)
      return jsonResponse({
        processed: 1,
        worker_id: workerId,
        task_id:   task.id,
        ok:        false,
        error:     errMsg,
        quota_exhausted: quotaExhausted,
        permanent: permanently,
      }, 500)
    }
    metaResult = json
    console.log(`[organic-worker-instagram] ${workerId} meta-publish ${action} ok — ${JSON.stringify(json).slice(0, 200)}`)
  } catch (e: any) {
    const msg = `meta-publish call failed: ${e?.message ?? e}`
    const permanently = task.attempts >= task.max_attempts
    await safeMarkFailed(supabase, task, msg, permanently)
    return jsonResponse({ processed: 1, worker_id: workerId, task_id: task.id, ok: false, error: msg, permanent: permanently }, 500)
  }

  // ── 6. Mark completed ──────────────────────────────────────────────
  // For 'auto' publishes, metaResult should contain { media_id, permalink, ... }
  // For 'prepare', metaResult contains { creation_id, ... } — admin still
  // needs to manually call meta-publish with {action:'publish', creation_id}
  // (or use the dashboard's publish controls). review_required flags this
  // so the admin UI surfaces it.
  const reviewRequired = action === 'prepare'

  try {
    await markTaskCompleted(supabase, task.id, {
      image_url:       imageUrl,
      caption:         finalCaption,
      caption_length:  finalCaption.length,
      hashtags,
      media_type:      mediaType,
      publish_strategy: publishStrategy,
      meta_action:     action,
      meta_response:   metaResult,
      review_required: reviewRequired,
      ig_creation_id:  (metaResult.creation_id as string | undefined) ?? null,
      ig_media_id:     (metaResult.media_id as string | undefined) ?? null,
      ig_permalink:    (metaResult.permalink as string | undefined) ?? null,
    })
  } catch (e: any) {
    console.error(`[organic-worker-instagram] ${workerId} markTaskCompleted failed: ${e?.message ?? e}`)
    return jsonResponse({
      processed: 1,
      worker_id: workerId,
      task_id:   task.id,
      ok:        false,
      error:     `meta-publish succeeded but result write failed: ${e?.message ?? e}`,
      meta_response: metaResult,
    }, 500)
  }

  return jsonResponse({
    processed:        1,
    worker_id:        workerId,
    task_id:          task.id,
    ok:               true,
    meta_action:      action,
    review_required:  reviewRequired,
    ig_creation_id:   metaResult.creation_id ?? null,
    ig_media_id:      metaResult.media_id ?? null,
    ig_permalink:     metaResult.permalink ?? null,
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Caption assembly. Strategist owns caption_he verbatim; we append the
// optional CTA, optional product link (UTM-tagged), and hashtags.
// ─────────────────────────────────────────────────────────────────────────
function buildFinalCaption(args: {
  caption_he:        string
  cta?:              string
  product_reference?: { name: string; permalink: string }
  hashtags:          string[]
}): string {
  const parts: string[] = [args.caption_he.trim()]

  if (args.cta?.trim()) {
    parts.push('')  // blank line
    parts.push(args.cta.trim())
  }

  if (args.product_reference?.permalink) {
    // UTM-tag the link so GA4 attributes traffic correctly to the
    // organic IG channel. Hebrew product names → ASCII-safe utm_campaign.
    const utmCampaign = (args.product_reference.name || 'ig-organic')
      .replace(/[^\x20-\x7e]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'ig-organic'
    const sep = args.product_reference.permalink.includes('?') ? '&' : '?'
    const taggedUrl = `${args.product_reference.permalink}${sep}utm_source=instagram&utm_medium=organic&utm_campaign=${utmCampaign}`
    parts.push('')
    parts.push(`🔗 ${taggedUrl}`)
  }

  if (args.hashtags.length > 0) {
    parts.push('')
    parts.push(args.hashtags.map(t => t.startsWith('#') ? t : `#${t}`).join(' '))
  }

  return parts.join('\n')
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers shared in shape with seo-worker-visual (the parent-not-ready
// release pattern). Inlined here rather than lifted into seo-agent/db.ts
// because the contract differs in one place: the IG worker also rejects
// when the parent visual capped without passing QA (image is known-bad).
// ─────────────────────────────────────────────────────────────────────────
async function safeMarkFailed(
  supabase: ReturnType<typeof createSupabase>,
  task: SeoTaskRow,
  msg: string,
  permanent: boolean,
): Promise<void> {
  try {
    await markTaskFailed(supabase, task.id, msg, permanent)
  } catch (e: any) {
    console.error(`[organic-worker-instagram] markTaskFailed write failed: ${e?.message ?? e}`)
  }
}

async function releaseForParentNotReady(
  supabase: ReturnType<typeof createSupabase>,
  task: SeoTaskRow,
  reason: string,
): Promise<void> {
  const restoredAttempts = Math.max(0, (task.attempts ?? 1) - 1)
  try {
    const { error } = await supabase
      .from('seo_tasks')
      .update({
        status:       'pending',
        attempts:     restoredAttempts,
        worker_id:    null,
        locked_until: null,
        error_msg:    `[deferred] ${reason}`,
      })
      .eq('id', task.id)
    if (error) throw error
  } catch (e: any) {
    console.error(`[organic-worker-instagram] release-without-attempt failed: ${e?.message ?? e}`)
  }
}
