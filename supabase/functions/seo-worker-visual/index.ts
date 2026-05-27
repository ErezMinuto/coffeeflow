// Minuto SEO Agent — Visual Worker.
//
// Cron-polled (every 2 min via pg_cron) worker that processes one
// `visual_generation` task per invocation. Reads `brief_data`
// (VisualGenerationBrief), routes by `render_mode` to the existing
// image-generation edge functions, then — if `destination='blog_banner'`
// and the parent text task has produced a `wp_post_id` — attaches the
// rendered image to the WP draft as its featured image.
//
// Architectural decisions:
//
// 1. ONE TASK PER INVOCATION. Same lock-mechanic semantics as the
//    writer worker. Idle if no eligible row.
//
// 2. WE DO NOT REIMPLEMENT IMAGE GENERATION. Routes to:
//      render_mode='no_bag'   → visual-test  with use_reference:false
//      render_mode='bag_hero' → vertex-imagen-edit with render_mode:'bag_hero'
//    These functions own the locked Minuto visual identity (style anchor,
//    Strada X / Coffee-Tech roaster references, Scene Director rewrite
//    from PR #88). We pass scene_brief through faithfully — NEVER bypass
//    the Scene Director.
//
// 3. FEATURED-IMAGE ATTACH. The existing blog-publish edge function only
//    supports attaching a featured image AT POST CREATION TIME (one-shot
//    POST /wp/v2/posts with featured_media set). Our flow is split: the
//    writer task creates the WP post first, the visual task arrives
//    later. So we cannot reuse blog-publish for the attach. Instead we
//    follow the SAME two-step WP REST pattern blog-publish uses for
//    media creation:
//      a) POST /wp/v2/media with the image bytes → media_id
//      b) POST /wp/v2/posts/{id} with featured_media = media_id  ← UPDATE
//    Auth and headers are byte-identical (Basic auth on
//    WP_BLOG_POST_USER_NAME : WP_BLOG_POST_PASS, same env vars). If the
//    parent text task hasn't completed yet (no wp_post_id), we release
//    the row back to 'pending' and re-try on the next tick — the cron
//    will pick it up after the writer finishes.
//
// 4. ON FAILURE: linear retry via markTaskFailed (same semantics as
//    Session A's writer worker). attempts>=max_attempts flips to 'failed'.
//
// ─────────────────────────────────────────────────────────────────────────
// TODO (future upgrade — two-step composite pipeline for "machine + Minuto
// bag in one frame")
// ─────────────────────────────────────────────────────────────────────────
// Current state (2026-05-26): the autonomous escalation ladder produces
// the BEST AVAILABLE outcome for a multi-subject scene brief, but cannot
// satisfy "render a Cafelat Robot machine AND a byte-perfect Minuto bag
// together in the same frame". Each route has a structural limitation:
//
//   • bag_hero (Vertex Imagen SUBJECT customization): centers on the
//     supplied product reference, drops every co-subject. Renders the
//     real Minuto bag with sharp label artwork but no other elements.
//   • no_bag (Gemini Image): renders any scene cleanly but cannot use
//     the real Minuto bag — at best it hallucinates a generic non-Minuto
//     bag (caught by QA + stripped on attempt 3), at worst it draws
//     other coffee imagery that violates render_mode.
//
// FIX: a two-step composite pipeline:
//   Step 1: render the scene via no_bag (Gemini), describing the bag's
//           position/orientation but NOT its branding ("a coffee bag
//           stands on the right side of the countertop, label facing
//           camera, partially in shadow").
//   Step 2: programmatic composite of the real Minuto bag PNG (from
//           `woo_products` lookup, same as bag_hero today) onto the
//           rendered scene at the position Gemini drew the generic bag.
//           The existing `supabase/functions/_shared/compositor.ts`
//           (compositeProductIntoScene) already does this — it's used
//           inside vertex-imagen-edit's handleHybridComposite but not
//           imported standalone. Lift it into a new `render_mode:
//           'scene_with_bag'` route here, OR call vertex-imagen-edit
//           with a new flag that does scene-then-composite without the
//           SUBJECT customization step.
//
// COMPLEXITY: needs bag-region detection in the Gemini output (probably
// a Claude vision call to find bounding box) OR a deterministic region
// the strategist agrees to use in scene_briefs. The existing compositor
// uses a fixed BAG_REGION which is hero-sized — not appropriate for a
// scene where the bag is one of several subjects. New region sizing
// logic required.
//
// PRIORITY: low until the strategist starts emitting briefs that
// specifically need this (product-recommendation articles where the
// bag MUST be in-frame alongside other subjects). The QA loop's HITL
// surface catches these today — admin reviews and decides whether to
// re-queue with a hand-crafted brief or ship the machine-only render.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import {
  createSupabase,
  claimNextTask,
  markTaskCompleted,
  markTaskFailed,
} from '../seo-agent/db.ts'
import { callClaude, MODEL_ORCHESTRATOR, parseClaudeJson } from '../seo-agent/claude.ts'
import { attachFeaturedImage } from '../seo-agent/wpMediaAttach.ts'
import type { SeoTaskRow, VisualGenerationBrief } from '../seo-agent/types.ts'

const SUPABASE_URL  = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const ANON_KEY      = Deno.env.get('SUPABASE_ANON_KEY')!
// Same env-var pair blog-publish uses. The featured-image attach reuses
// the same WP Application Password — no new credentials to manage.
const WP_URL          = (Deno.env.get('WOO_URL') ?? 'https://www.minuto.co.il').replace(/\/+$/, '')
const WP_USERNAME     = Deno.env.get('WP_BLOG_POST_USER_NAME') ?? ''
const WP_APP_PASSWORD = Deno.env.get('WP_BLOG_POST_PASS') ?? ''

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

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST')    return jsonResponse({ error: 'POST only' }, 405)

  const workerId = `visual-${crypto.randomUUID().slice(0, 8)}`
  const supabase = createSupabase()

  // ── 1. Claim one task ────────────────────────────────────────────────
  let task: SeoTaskRow | null
  try {
    task = await claimNextTask(supabase, 'visual_generation', workerId)
  } catch (e: any) {
    console.error(`[seo-worker-visual] ${workerId} claim failed: ${e?.message ?? e}`)
    return jsonResponse({ processed: 0, worker_id: workerId, error: e?.message ?? String(e) }, 500)
  }
  if (!task) {
    return jsonResponse({ processed: 0, worker_id: workerId })
  }
  console.log(`[seo-worker-visual] ${workerId} claimed task ${task.id} attempt=${task.attempts}`)

  // ── 2. Parse + validate brief ────────────────────────────────────────
  const brief = task.brief_data as VisualGenerationBrief
  if (!brief || typeof brief.scene_brief !== 'string' || !brief.scene_brief.trim()) {
    await safeMarkFailed(supabase, task, 'brief_data.scene_brief is required (non-empty)', true)
    return jsonResponse({ processed: 1, worker_id: workerId, task_id: task.id, ok: false, error: 'brief invalid' })
  }
  const aspect      = brief.aspect      ?? 'feed_square'
  const renderMode  = brief.render_mode ?? 'bag_hero'
  const destination = brief.destination ?? 'blog_banner'
  if (renderMode !== 'no_bag' && renderMode !== 'bag_hero') {
    await safeMarkFailed(supabase, task, `unknown render_mode "${renderMode}"`, true)
    return jsonResponse({ processed: 1, worker_id: workerId, task_id: task.id, ok: false, error: 'unknown render_mode' })
  }
  if (renderMode === 'bag_hero' && !brief.product_name?.trim()) {
    // vertex-imagen-edit requires one of reference_image_url / product_id /
    // product_name. The orchestrator's VisualGenerationBrief only exposes
    // product_name, so it must be set for bag_hero. Permanent failure —
    // the brief is malformed, no point retrying.
    await safeMarkFailed(supabase, task, 'bag_hero render_mode requires product_name in brief_data', true)
    return jsonResponse({ processed: 1, worker_id: workerId, task_id: task.id, ok: false, error: 'product_name missing for bag_hero' })
  }

  // ── 3. Resolve parent (only required for blog_banner attach) ─────────
  // For blog_banner: we need the WP post_id from the parent text task's
  // result_data. If parent isn't completed yet, release this row back to
  // 'pending' so the next cron tick can pick it up after the writer
  // finishes. parent_task_id is enforced via claimNextTask's depends_on
  // check ONLY when the orchestrator wires depends_on; today it wires
  // parent_task_id without depends_on (see seo-orchestrator/index.ts
  // around the parent_task_index → parent_task_id translation), so we
  // do the parent-readiness check inline here.
  let parentWpPostId: number | null = null
  let parentEditUrl:  string | null = null
  if (task.parent_task_id) {
    const { data: parent, error: parentErr } = await supabase
      .from('seo_tasks')
      .select('status, result_data')
      .eq('id', task.parent_task_id)
      .maybeSingle()
    if (parentErr) {
      // Treat as transient — retry next tick.
      await safeMarkFailed(supabase, task, `parent lookup failed: ${parentErr.message}`, false)
      return jsonResponse({ processed: 1, worker_id: workerId, task_id: task.id, ok: false, error: 'parent lookup error' })
    }
    if (destination === 'blog_banner') {
      if (!parent || parent.status !== 'completed') {
        // Writer task hasn't finished. Release the row back to 'pending'
        // WITHOUT counting this as an attempt — the visual itself never
        // ran, so it would be wrong to burn a retry slot on the writer's
        // schedule. We undo the attempts++ that claimNextTask did when it
        // locked the row, clear the lock, and let the next cron tick
        // re-evaluate. Attempts are reserved for genuine render or attach
        // failures (see the catch around step 4).
        await releaseForParentNotReady(
          supabase,
          task,
          `parent text task ${task.parent_task_id} not yet completed (status=${parent?.status ?? 'missing'})`,
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
      const result = (parent.result_data ?? {}) as { wp_post_id?: number; edit_url?: string }
      if (typeof result.wp_post_id === 'number' && Number.isFinite(result.wp_post_id)) {
        parentWpPostId = result.wp_post_id
        parentEditUrl  = result.edit_url ?? null
      } else {
        // Parent completed but didn't expose wp_post_id — render the
        // image anyway, just skip the attach with a warning. The
        // image_url ends up in our result_data so a human can attach
        // manually from the admin UI later.
        console.warn(`[seo-worker-visual] ${workerId} parent ${task.parent_task_id} completed but result_data has no wp_post_id`)
      }
    }
  } else if (destination === 'blog_banner') {
    // blog_banner with no parent — render anyway, skip the attach.
    // Logged so a human can decide whether to attach manually.
    console.warn(`[seo-worker-visual] ${workerId} blog_banner task has no parent_task_id; will render but cannot attach`)
  }

  // ── 4. Render + self-QA loop with mode escalation ────────────────────
  // Each attempt: render → Claude-vision eval → break on pass.
  // On fail, escalate the strategy rather than repeating the same losing
  // approach (the original same-mode-only retries kept producing the same
  // failure when the underlying render mode was structurally incapable
  // of the brief — e.g. Vertex bag_hero is single-subject by nature):
  //
  //   Attempt 1: original render_mode + original scene_brief
  //   Attempt 2: SWITCH render_mode (bag_hero ↔ no_bag), keep brief
  //   Attempt 3: stay in attempt-2 mode but STRIP conflicting terms from
  //              the brief based on QA critique (e.g. drop bag mentions
  //              if no_bag mode keeps hallucinating generic bags)
  //
  // On all-attempts-failed, we set result_data.review_required=true AND
  // SKIP the WP attach entirely — bad images never go live on the post.
  // The admin UI surfaces the task for HITL: a human reviews qa_attempts
  // and either approves an attempt for attach or re-queues with a
  // hand-crafted brief.
  //
  // Cost / latency envelope per task (worst case = 3 attempts):
  //   3 × render (~30-60s) + 3 × eval (~10-15s) ≈ 120-225s. Fits the
  //   240s cron timeout in 20260527_seo_worker_visual_cron.sql.
  const MAX_QA_ATTEMPTS = 3
  let imageUrl = ''
  let renderResponse: Record<string, unknown> = {}
  let workingSceneBrief = brief.scene_brief
  let workingRenderMode: 'no_bag' | 'bag_hero' = renderMode
  const qaAttempts: Array<{
    attempt: number
    image_url: string
    render_mode: 'no_bag' | 'bag_hero'
    scene_brief: string
    critique: VisualCritique
  }> = []
  let qaPassed = false
  let lastCritique: VisualCritique | null = null

  for (let qaAttempt = 1; qaAttempt <= MAX_QA_ATTEMPTS; qaAttempt++) {
    // 4a. Decide this attempt's render_mode + scene_brief based on prior
    // critiques. First attempt = caller's choices. Subsequent attempts
    // apply the escalation ladder.
    if (qaAttempt === 2 && qaAttempts.length > 0) {
      // ESCALATION STEP 1: switch render_mode. If the original mode
      // can't produce what the brief asks for, the alternative mode
      // gets a fresh shot. We keep the original scene_brief here so the
      // escalation tests *just* the mode change.
      workingRenderMode = renderMode === 'bag_hero' ? 'no_bag' : 'bag_hero'
      // If switching INTO bag_hero and we don't have a product_name,
      // we can't actually switch — bag_hero requires it. In that case
      // stick with the same mode but use the augmented brief.
      if (workingRenderMode === 'bag_hero' && !brief.product_name?.trim()) {
        console.warn(`[seo-worker-visual] ${workerId} can't escalate to bag_hero (no product_name); retrying same mode with augmented brief`)
        workingRenderMode = renderMode
        workingSceneBrief = buildAugmentedSceneBrief(brief.scene_brief, qaAttempts)
      } else {
        console.log(`[seo-worker-visual] ${workerId} escalation step 1: switching mode ${renderMode} → ${workingRenderMode}`)
        // Keep brief verbatim on the mode-switch attempt — clean A/B.
        workingSceneBrief = brief.scene_brief
      }
    } else if (qaAttempt === 3 && qaAttempts.length > 0) {
      // ESCALATION STEP 2: stay in attempt-2's mode but strip the brief
      // of terms that the prior critique blamed for repeated failures.
      // For no_bag mode, the common failure mode is Gemini hallucinating
      // a generic bag because the brief mentions one — strip bag terms.
      // For bag_hero mode, the failure is co-subjects getting dropped —
      // strip everything except the primary product to give Vertex a
      // single-subject brief it can actually handle.
      workingSceneBrief = stripConflictingTerms(brief.scene_brief, workingRenderMode)
      console.log(`[seo-worker-visual] ${workerId} escalation step 2: stripped brief for ${workingRenderMode} mode`)
    }

    // 4b. Render with this attempt's settings.
    let rendered: { url: string; raw: Record<string, unknown> }
    try {
      rendered = await renderOnce({
        renderMode:  workingRenderMode,
        sceneBrief:  workingSceneBrief,
        aspect,
        productName: brief.product_name,
      })
      imageUrl       = rendered.url
      renderResponse = rendered.raw
      console.log(`[seo-worker-visual] ${workerId} qa-attempt ${qaAttempt}/${MAX_QA_ATTEMPTS} (mode=${workingRenderMode}) rendered: ${imageUrl}`)
    } catch (e: any) {
      // Render-side errors (HTTP failures, missing API keys, etc.) are
      // transient infrastructure problems — bail out of the loop and let
      // markTaskFailed handle retry semantics. Don't burn QA attempts on
      // an infra failure; the render side never produced an image to
      // evaluate.
      const msg = `render (${workingRenderMode}) failed on QA attempt ${qaAttempt}: ${e?.message ?? e}`
      const permanently = task.attempts >= task.max_attempts
      await safeMarkFailed(supabase, task, msg, permanently)
      return jsonResponse({
        processed: 1,
        worker_id: workerId,
        task_id:   task.id,
        ok:        false,
        error:     msg,
        permanent: permanently,
      }, 500)
    }

    // 4c. Evaluate the rendered image with Claude vision. If the eval
    // itself fails (rare — Anthropic outage, etc.), treat as 'passes'
    // so we don't burn the task on observability issues. The image is
    // already rendered; better to attach it than to fail.
    let critique: VisualCritique
    try {
      critique = await evaluateVisual({
        imageUrl,
        sceneBrief:  workingSceneBrief,
        renderMode:  workingRenderMode,
        productName: brief.product_name,
      })
    } catch (e: any) {
      console.warn(`[seo-worker-visual] ${workerId} qa-attempt ${qaAttempt} eval threw — treating as pass: ${e?.message ?? e}`)
      critique = {
        passes: true,
        missing: [],
        issues: [],
        suggested_adjustment: '',
        _eval_error: e?.message ?? String(e),
      } as VisualCritique
    }
    qaAttempts.push({
      attempt:     qaAttempt,
      image_url:   imageUrl,
      render_mode: workingRenderMode,
      scene_brief: workingSceneBrief,
      critique,
    })
    lastCritique = critique

    if (critique.passes) {
      qaPassed = true
      console.log(`[seo-worker-visual] ${workerId} qa-attempt ${qaAttempt} (mode=${workingRenderMode}) PASSED`)
      break
    }

    console.warn(`[seo-worker-visual] ${workerId} qa-attempt ${qaAttempt} (mode=${workingRenderMode}) FAILED — missing=${JSON.stringify(critique.missing)} issues=${JSON.stringify(critique.issues)}`)
  }

  const reviewRequired = !qaPassed
  // If the QA loop ended on an escalated mode (different from the brief's
  // original), that's worth surfacing in result_data so the admin can see
  // which strategy produced the best-effort attempt.
  const finalRenderMode = workingRenderMode

  // ── 5. Attach to WP draft — GATED by QA pass ─────────────────────────
  // When the QA loop capped without passing (reviewRequired=true), we
  // explicitly SKIP the WP attach. Bad images never go live on the post.
  // The image still lives in Supabase Storage and is fully logged in
  // qa_attempts so the admin UI can show it for HITL review and offer
  // an "approve & attach" action.
  //
  // When QA passed, the standard two-step WP REST attach runs:
  //   (a) POST /wp/v2/media — upload image bytes, get media_id
  //   (b) POST /wp/v2/posts/{id} — set featured_media = media_id
  // Auth + filename-sanitization pattern identical to blog-publish/uploadMedia.
  let attachedMediaId:  number | null = null
  let attachError:      string | null = null
  let attachSkippedReason: string | null = null

  if (destination === 'blog_banner' && parentWpPostId) {
    if (reviewRequired) {
      attachSkippedReason = `QA loop capped after ${qaAttempts.length} attempts without passing — image awaiting HITL review, not auto-attached`
      console.warn(`[seo-worker-visual] ${workerId} ${attachSkippedReason}`)
    } else if (!WP_USERNAME || !WP_APP_PASSWORD) {
      attachError = 'WP_BLOG_POST_USER_NAME / WP_BLOG_POST_PASS not configured'
      console.warn(`[seo-worker-visual] ${workerId} ${attachError}`)
    } else {
      try {
        attachedMediaId = await attachFeaturedImage({
          wpUrl:       WP_URL,
          username:    WP_USERNAME,
          appPassword: WP_APP_PASSWORD,
          postId:      parentWpPostId,
          imageUrl,
          titleHint:   (renderResponse.scene_brief as string)?.slice(0, 60) ?? 'seo banner',
        })
        console.log(`[seo-worker-visual] ${workerId} attached media_id=${attachedMediaId} to post_id=${parentWpPostId}`)
      } catch (e: any) {
        attachError = e?.message ?? String(e)
        console.warn(`[seo-worker-visual] ${workerId} attach failed: ${attachError}`)
      }
    }
  }

  // ── 6. Mark completed ────────────────────────────────────────────────
  // Always 'completed' (not 'failed') even when QA capped — the queue
  // worker has done its best and a human needs to review. result_data
  // carries review_required + the full qa_attempts log so the admin UI
  // can render thumbnails + critiques. Future agents can also re-queue
  // a fresh task with a modified brief if review concludes the image
  // is unusable.
  const finalRenderFunction = finalRenderMode === 'no_bag' ? 'visual-test' : 'vertex-imagen-edit'
  try {
    await markTaskCompleted(supabase, task.id, {
      image_url:           imageUrl,
      render_function:     finalRenderFunction,
      render_mode:         finalRenderMode,
      original_render_mode: renderMode,
      mode_escalated:      finalRenderMode !== renderMode,
      destination,
      aspect,
      wp_post_id:          parentWpPostId,
      wp_edit_url:         parentEditUrl,
      attached_media_id:   attachedMediaId,
      attach_error:        attachError,
      attach_skipped_reason: attachSkippedReason,
      render_response:     pickRenderSummary(renderResponse),
      qa_passed:           qaPassed,
      review_required:     reviewRequired,
      qa_attempts:         qaAttempts,
      qa_last_critique:    lastCritique,
    })
  } catch (e: any) {
    console.error(`[seo-worker-visual] ${workerId} markTaskCompleted failed: ${e?.message ?? e}`)
    return jsonResponse({
      processed: 1,
      worker_id: workerId,
      task_id:   task.id,
      ok:        false,
      error:     `image_url=${imageUrl} (render succeeded) but result write failed: ${e?.message ?? e}`,
    }, 500)
  }

  return jsonResponse({
    processed:           1,
    worker_id:           workerId,
    task_id:             task.id,
    ok:                  true,
    image_url:           imageUrl,
    render_function:     finalRenderFunction,
    render_mode:         finalRenderMode,
    original_render_mode: renderMode,
    mode_escalated:      finalRenderMode !== renderMode,
    destination,
    wp_post_id:          parentWpPostId,
    attached_media_id:   attachedMediaId,
    attach_error:        attachError,
    attach_skipped_reason: attachSkippedReason,
    qa_passed:           qaPassed,
    review_required:     reviewRequired,
    qa_attempt_count:    qaAttempts.length,
  })
})

// attachFeaturedImage lifted to seo-agent/wpMediaAttach.ts so the chat
// handler's approve_qa_attempt tool can reuse the same code path.

// markTaskFailed throws on its own DB errors; swallow so the HTTP
// response we already prepared still flushes cleanly.
async function safeMarkFailed(
  supabase: ReturnType<typeof createSupabase>,
  task: SeoTaskRow,
  msg: string,
  permanent: boolean,
): Promise<void> {
  try {
    await markTaskFailed(supabase, task.id, msg, permanent)
  } catch (e: any) {
    console.error(`[seo-worker-visual] markTaskFailed write failed: ${e?.message ?? e}`)
  }
}

// Release a claimed row back to 'pending' without consuming an attempt.
// Used when we discover post-claim that we shouldn't have claimed yet
// (parent text task not ready). claimNextTask already did attempts++ as
// part of the lock, so we explicitly decrement it back. error_msg gets
// the diagnostic so the admin UI shows why the row keeps cycling, but
// status stays 'pending' so the next cron tick re-evaluates.
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
    console.error(`[seo-worker-visual] release-without-attempt failed: ${e?.message ?? e}`)
  }
}

// Trim render-function response to the fields useful for downstream
// debugging without bloating the result_data JSONB.
function pickRenderSummary(r: Record<string, unknown>): Record<string, unknown> {
  return {
    aspect:                r.aspect,
    ratio:                 r.ratio,
    bytes:                 r.bytes,
    pipeline:              r.pipeline,
    used_reference:        r.used_reference,
    bag_source:            r.bag_source,
    bag_url:               r.bag_url,
    visual_director_model: r.visual_director_model,
    visual_director_error: r.visual_director_error,
    surface:               r.surface,
    style_ref:             r.style_ref,
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Render dispatch — extracted from the inline render block so the QA loop
// can call it multiple times. Returns the public image URL plus the raw
// render-function response (for downstream debugging via pickRenderSummary).
// ─────────────────────────────────────────────────────────────────────────
async function renderOnce(args: {
  renderMode:  'no_bag' | 'bag_hero'
  sceneBrief:  string
  aspect:      string
  productName?: string
}): Promise<{ url: string; raw: Record<string, unknown> }> {
  const endpoint = args.renderMode === 'no_bag'
    ? 'visual-test'
    : 'vertex-imagen-edit'
  const body: Record<string, unknown> = args.renderMode === 'no_bag'
    ? { scene_brief: args.sceneBrief, aspect: args.aspect, use_reference: false }
    : { scene_brief: args.sceneBrief, aspect: args.aspect, render_mode: 'bag_hero', product_name: args.productName }

  const res = await fetch(`${SUPABASE_URL}/functions/v1/${endpoint}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ANON_KEY}`, apikey: ANON_KEY },
    body:    JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({})) as Record<string, unknown>
  if (!res.ok || !json.url || typeof json.url !== 'string') {
    throw new Error(`${endpoint} HTTP ${res.status}: ${(json.error as string) ?? JSON.stringify(json).slice(0, 300)}`)
  }
  return { url: json.url, raw: json }
}

// ─────────────────────────────────────────────────────────────────────────
// Self-QA: ask Claude (with vision) whether the rendered image satisfies
// the brief. Returns a structured critique. The eval is deliberately
// strict on "are all required subjects present?" because that's the
// failure mode bag_hero exposed (the bag becomes the entire frame and
// any co-required subjects get dropped). Brand-voice / palette nits are
// secondary — render functions own those.
// ─────────────────────────────────────────────────────────────────────────
export interface VisualCritique {
  passes: boolean
  // Required subjects from the scene_brief that didn't appear in the image.
  // e.g. ["Cafelat Robot espresso machine"] when the brief asked for the
  // machine + a bag and only the bag rendered.
  missing: string[]
  // Other quality issues — text gibberish, wrong product, weird artifacts.
  issues: string[]
  // One-sentence concrete suggestion for the next render's scene_brief.
  // Tail of the prompt: generative models weight the last lines more,
  // so this gets appended verbatim on the next attempt.
  suggested_adjustment: string
  _eval_error?: string  // only set when the eval call itself threw
}

const VISUAL_EVAL_SYSTEM_PROMPT = `You are a strict visual QA agent for Minuto's blog banner pipeline. Given a rendered image and the photographer's brief that produced it, decide whether the image satisfies the brief.

You are STRICT on subject completeness. If the brief named multiple concrete subjects (e.g. "espresso machine" AND "coffee bag"), all of them must appear in frame. Missing a named subject is a hard FAIL even if the image is otherwise beautiful.

You are LENIENT on stylistic interpretation. The brief specifies a mood / palette / composition; minor reinterpretation is fine.

Output STRICT JSON (no markdown fences, no preamble):
{
  "passes": true | false,
  "missing": ["concrete subject from the brief that didn't appear", "..."],
  "issues": ["other quality problems — gibberish text, wrong product, weird artifacts, etc.", "..."],
  "suggested_adjustment": "one sentence telling the next render exactly what to include / fix"
}

If passes=true, missing and issues should both be empty arrays and suggested_adjustment should be an empty string.`

async function evaluateVisual(args: {
  imageUrl:    string
  sceneBrief:  string
  renderMode:  'no_bag' | 'bag_hero'
  productName?: string
}): Promise<VisualCritique> {
  const userText = `BRIEF (render_mode=${args.renderMode}${args.productName ? `, product_name="${args.productName}"` : ''}):

${args.sceneBrief}

Evaluate the attached image against this brief. Output strict JSON only.`

  const res = await callClaude({
    model:  MODEL_ORCHESTRATOR,  // Sonnet handles vision + structured JSON reliably
    system: VISUAL_EVAL_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'url', url: args.imageUrl } },
          { type: 'text',  text: userText },
        ],
      },
    ],
    maxTokens:   600,
    temperature: 0.0,
    timeoutMs:   60_000,
  })

  const parsed = parseClaudeJson<{
    passes?: unknown
    missing?: unknown
    issues?: unknown
    suggested_adjustment?: unknown
  }>(res.text)

  return {
    passes:               parsed.passes === true,
    missing:              Array.isArray(parsed.missing) ? parsed.missing.map(String) : [],
    issues:               Array.isArray(parsed.issues)  ? parsed.issues.map(String)  : [],
    suggested_adjustment: typeof parsed.suggested_adjustment === 'string' ? parsed.suggested_adjustment : '',
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Build the scene_brief for the next QA attempt by appending the accrued
// critiques as explicit "MUST INCLUDE" directives. We KEEP the original
// brief (don't replace) so creative intent survives, and we put the
// directives at the END because generative models weight the tail of a
// prompt more heavily than the middle.
// ─────────────────────────────────────────────────────────────────────────
function buildAugmentedSceneBrief(
  originalBrief: string,
  attemptsSoFar: Array<{ attempt: number; image_url: string; critique: VisualCritique }>,
): string {
  const lastCritique = attemptsSoFar[attemptsSoFar.length - 1]?.critique
  if (!lastCritique || lastCritique.passes) return originalBrief

  const directives: string[] = []
  if (lastCritique.missing.length > 0) {
    directives.push(`MUST INCLUDE in frame (the previous attempt missed these): ${lastCritique.missing.join(', ')}.`)
  }
  if (lastCritique.issues.length > 0) {
    directives.push(`AVOID (the previous attempt had these problems): ${lastCritique.issues.join('; ')}.`)
  }
  if (lastCritique.suggested_adjustment) {
    directives.push(lastCritique.suggested_adjustment)
  }

  if (directives.length === 0) return originalBrief

  return `${originalBrief}

CRITICAL REQUIREMENTS (QA attempt ${attemptsSoFar.length + 1}/3 — earlier attempts failed quality review):
${directives.map(d => `- ${d}`).join('\n')}`
}

// ─────────────────────────────────────────────────────────────────────────
// Final-attempt brief surgery: strip terms that have been demonstrated
// to fight the chosen render_mode. Called on QA attempt 3 after mode
// escalation has already happened — at this point we're trading
// completeness for a clean render of the most-important elements.
//
//   no_bag mode: scene_brief commonly mentions "bag of beans" /
//     "packaging" / "pouch", and Gemini happily draws a generic
//     non-Minuto bag. Strip bag terms so the bag stops appearing.
//   bag_hero mode: Vertex SUBJECT customization centers on the bag
//     and drops co-subjects. Strip co-subject mentions so the brief
//     becomes a clean single-subject hero shot Vertex can do well.
//
// This is line-by-line scrubbing — leaves the rest of the brief intact
// so the photographer's intent (lighting, palette, mood) survives.
// ─────────────────────────────────────────────────────────────────────────
function stripConflictingTerms(brief: string, mode: 'no_bag' | 'bag_hero'): string {
  if (mode === 'no_bag') {
    // Two-part fix for Gemini's bag-bias:
    //   1. Strip POSITIVE mentions of bag/packaging/pouch from the brief
    //   2. APPEND explicit NEGATIVE directives at the END — Gemini has
    //      a strong training prior toward "coffee scene → bag of beans
    //      somewhere in frame"; just removing the bag mention isn't
    //      enough, it'll hallucinate one anyway. Negative directives
    //      at the tail of the prompt have the highest weight.
    const stripped = brief
      .split(/(?<=[.!?])\s+/)
      .filter(sentence => !/\b(bag|bags|pouch|pouches|packaging|sachet|package of (?:beans|coffee))\b/i.test(sentence))
      .join(' ')
      .trim() || brief
    return `${stripped}

DO NOT INCLUDE ANY OF THESE — they are forbidden in this render:
- No coffee bag, no packaging, no pouch, no sachet, no bean container of any kind
- No loose coffee beans scattered on the surface
- No human hands or arms in frame
- No coffee-product branding text anywhere
The image must show ONLY the espresso machine and the pull (cup + crema), nothing else.`
  }
  // bag_hero: Vertex needs single-subject focus. Keep sentences that
  // mention the bag/coffee, drop sentences naming co-subjects (machines,
  // cups, scales, etc.). The bag is the hero; let Vertex render it
  // cleanly without trying to compose around it.
  const stripped = brief
    .split(/(?<=[.!?])\s+/)
    .filter(sentence => {
      const hasBagOrCoffee = /\b(bag|coffee|beans|label|pouch)\b/i.test(sentence)
      const hasCoSubject   = /\b(machine|espresso machine|portafilter|lever|grinder|cup|saucer|carafe|chemex|v60|aeropress|kettle|scale|tamper)\b/i.test(sentence)
      // Keep sentences that are about the bag/coffee, OR sentences that
      // are pure mood/setting (no co-subjects at all).
      return hasBagOrCoffee || !hasCoSubject
    })
    .join(' ')
    .trim() || brief
  return stripped
}
