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
import { sendOwnerEmail } from '../_shared/email.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const ANON_KEY     = Deno.env.get('SUPABASE_ANON_KEY')!

// "Post ready for review" admin alert (email via Resend). Fires once per post
// the moment it's staged for review, so the admin learns about it without
// having to sit on the dashboard. All optional — a missing key just skips the
// email (never fails the task). Reuses the same verified sender domain as the
// forms/marketing senders.
const RESEND_KEY        = Deno.env.get('RESEND_API_KEY') ?? ''
const SENDER_EMAIL      = Deno.env.get('SENDER_EMAIL') ?? 'info@minuto.co.il'
const ADMIN_ALERT_EMAIL = Deno.env.get('ADMIN_ALERT_EMAIL') ?? 'erez@minuto.co.il'
const DASHBOARD_URL     = Deno.env.get('DASHBOARD_URL') ?? 'https://coffeeflow-neon.vercel.app'

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

// ── "Post ready for review" admin email ─────────────────────────────────────
// Sent once, the moment a post/story is staged for review. Best-effort: any
// failure (missing key, Resend error) is logged and swallowed — it must NEVER
// fail or retry the task itself. Returns a short status string for the log.
async function notifyPostReadyForReview(args: {
  mediaType: string
  caption: string
  imageUrl: string | null
  taskId: string
  qaFlagged: boolean
}): Promise<string> {
  if (!RESEND_KEY) return 'skipped (no RESEND_API_KEY)'
  const isStory = String(args.mediaType).toLowerCase().includes('story')
  const kind = isStory ? 'Story' : 'Feed post'
  const captionPreview = (args.caption || '').trim().slice(0, 240)
  const reviewUrl = `${DASHBOARD_URL}/admin/seo-agent`
  const subject = `📸 Minuto IG ${isStory ? 'story' : 'post'} ready for review`
  // Plain, scannable HTML — phone-friendly. The image is shown when present so
  // a glance from the email is often enough to decide whether to open the app.
  const html = `<!doctype html><html><body style="margin:0;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;background:#f6f6f4;padding:24px;color:#2b2b2b;">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e7e7e2;">
    <div style="padding:18px 22px;background:#6A7D45;color:#fff;font-size:16px;font-weight:600;">📸 ${kind} ready for review</div>
    ${args.imageUrl ? `<img src="${args.imageUrl}" alt="post preview" style="width:100%;display:block;" />` : ''}
    <div style="padding:18px 22px;">
      ${args.qaFlagged ? `<p style="margin:0 0 12px;padding:8px 12px;background:#fff4e5;border:1px solid #f0c987;border-radius:8px;font-size:13px;color:#8a5a00;">⚠ The image was flagged by visual QA — give it a closer look before approving.</p>` : ''}
      ${captionPreview ? `<p style="margin:0 0 16px;font-size:14px;line-height:1.5;white-space:pre-wrap;color:#444;">${captionPreview}${args.caption.length > 240 ? '…' : ''}</p>` : '<p style="margin:0 0 16px;font-size:14px;color:#888;">(no caption)</p>'}
      <a href="${reviewUrl}" style="display:inline-block;background:#6A7D45;color:#fff;text-decoration:none;padding:11px 20px;border-radius:8px;font-size:14px;font-weight:600;">Review &amp; publish →</a>
      <p style="margin:16px 0 0;font-size:12px;color:#999;">Nothing is published until you approve it here. Task ${args.taskId.slice(0, 8)}.</p>
    </div>
  </div>
</body></html>`
  return await sendOwnerEmail({ subject, html })
}

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
  // HARD GATE: the worker ALWAYS uses 'queue_for_review', regardless of
  // what the strategist requested in the brief. The user explicitly asked
  // 'as for posts, website or instagram, i dont want it to post without
  // my permission' — defense in depth means: strategist prompt forbids
  // 'auto' (see prompts/strategist.ts) AND the worker refuses it here.
  // If the brief asks for 'auto', we still send 'prepare' to meta-publish
  // and log the override so the admin can see what the strategist tried.
  const requestedStrategy = brief?.publish_strategy ?? 'queue_for_review'
  if (requestedStrategy === 'auto') {
    console.warn(`[organic-worker-instagram] ${workerId} brief requested 'auto' publish — overriding to 'queue_for_review' (no-auto-publish gate)`)
  }
  const publishStrategy: 'queue_for_review' = 'queue_for_review'

  if (!caption_he) {
    await safeMarkFailed(supabase, task, 'caption_he is required (non-empty)', true)
    return jsonResponse({ processed: 1, worker_id: workerId, task_id: task.id, ok: false, error: 'caption_he missing' })
  }
  // Worker handles feed_image (regular post), story (9:16 ephemeral), and
  // feed_carousel (multi-slide — the paired visual task renders the slides).
  // reel still needs HITL — we don't have a video pipeline yet.
  // Map our internal media_type → meta-publish's `type` parameter.
  let metaPublishType: 'feed' | 'story' | 'carousel'
  if (mediaType === 'feed_image') {
    metaPublishType = 'feed'
  } else if (mediaType === 'story') {
    metaPublishType = 'story'
  } else if (mediaType === 'feed_carousel') {
    metaPublishType = 'carousel'
  } else {
    await safeMarkFailed(supabase, task, `media_type '${mediaType}' not yet supported by automated worker (supports feed_image + story + feed_carousel; reel requires manual publish)`, true)
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

  const parentResult = (parent.result_data ?? {}) as {
    image_url?: string
    carousel_slides?: Array<{ image_url?: string }>
    review_required?: boolean
  }
  // AUTO-QA IS ADVISORY FOR IG, NOT A HARD GATE. The visual worker's vision-QA
  // loop sometimes rejects perfectly good images, and every IG post already
  // passes through the HUMAN review gate (queue_for_review → admin clicks
  // Publish). Hard-failing a QA-flagged image here meant good images silently
  // never reached the admin to approve. Instead: STILL stage the post and
  // surface it for review, carrying a qa_flagged marker so the review UI can
  // warn — the human makes the final call.
  const qaFlagged = parentResult.review_required === true
  if (qaFlagged) {
    console.warn(`[organic-worker-instagram] ${workerId} parent visual ${task.parent_task_id} is QA-flagged (review_required) — staging for HUMAN review anyway, not auto-failing`)
  }

  // For carousel: resolve the ordered slide URLs into Meta's children[].
  // For single-image flows: resolve one image_url. imageUrl stays the
  // primary field for non-carousel; carouselChildren drives the carousel.
  let imageUrl: string | undefined
  let carouselChildren: Array<{ image_url: string }> | null = null
  if (metaPublishType === 'carousel') {
    const slides = Array.isArray(parentResult.carousel_slides) ? parentResult.carousel_slides : []
    carouselChildren = slides
      .map(s => s?.image_url)
      .filter((u): u is string => typeof u === 'string' && u.length > 0)
      .map(u => ({ image_url: u }))
    if (carouselChildren.length < 2 || carouselChildren.length > 10) {
      await safeMarkFailed(supabase, task, `carousel requires 2-10 slide images from parent visual task ${task.parent_task_id}; got ${carouselChildren.length}`, true)
      return jsonResponse({ processed: 1, worker_id: workerId, task_id: task.id, ok: false, error: 'carousel children count invalid' })
    }
  } else {
    imageUrl = parentResult.image_url
    if (!imageUrl) {
      await safeMarkFailed(supabase, task, `parent visual task ${task.parent_task_id} completed but result_data has no image_url`, true)
      return jsonResponse({ processed: 1, worker_id: workerId, task_id: task.id, ok: false, error: 'image_url missing on parent' })
    }
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
  console.log(`[organic-worker-instagram] ${workerId} action=${action} type=${metaPublishType} ${carouselChildren ? `children=${carouselChildren.length}` : `image_url=${imageUrl}`} caption_len=${finalCaption.length}`)

  // Carousel sends children[]; feed/story send a single image_url.
  const metaBody: Record<string, unknown> = {
    action,
    type: metaPublishType,
    // IG Stories ignore caption text (no text overlay rendered from the
    // caption field), so strip hashtag tail to avoid confusing admin in
    // the prepared-container preview. Keep CTA + product link because
    // those are informational metadata even if not visible on the story.
    caption: metaPublishType === 'story'
      ? finalCaption.replace(/\n#[^\n]+$/, '').trim()
      : finalCaption,
  }
  if (carouselChildren) {
    metaBody.children = carouselChildren
  } else {
    metaBody.image_url = imageUrl
  }

  let metaResult: Record<string, unknown> = {}
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/meta-publish`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ANON_KEY}`, apikey: ANON_KEY },
      body: JSON.stringify(metaBody),
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
      image_url:       imageUrl ?? null,
      carousel_children: carouselChildren ? carouselChildren.map(c => c.image_url) : null,
      caption:         finalCaption,
      caption_length:  finalCaption.length,
      hashtags,
      media_type:      mediaType,
      publish_strategy:  publishStrategy,
      requested_strategy: requestedStrategy,   // surfaced for admin audit
      auto_publish_overridden: requestedStrategy === 'auto',
      meta_action:     action,
      meta_response:   metaResult,
      review_required: reviewRequired,
      // QA had concerns about the image(s) but we staged it for human review
      // anyway — the review UI shows this as a warning next to Publish/Reject.
      qa_flagged:      qaFlagged,
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

  // ── 6b. Notify the admin the post/story is ready for review ─────────────
  // Best-effort + non-blocking: the task is already committed above, so a
  // failed/slow email never affects the pipeline. Only for review-staged posts
  // (the only path this worker takes), so this fires exactly once per post.
  if (reviewRequired) {
    const notifyStatus = await notifyPostReadyForReview({
      mediaType: mediaType,
      caption:   finalCaption,
      imageUrl:  imageUrl ?? (carouselChildren?.[0]?.image_url ?? null),
      taskId:    task.id,
      qaFlagged: qaFlagged,
    })
    console.log(`[organic-worker-instagram] ${workerId} ready-for-review email → ${ADMIN_ALERT_EMAIL}: ${notifyStatus}`)
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
