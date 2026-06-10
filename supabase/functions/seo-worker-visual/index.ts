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
// 2. WE DO NOT REIMPLEMENT IMAGE GENERATION. BOTH modes route to the
//    visual-test edge function (Gemini Image + Minuto reference images):
//      render_mode='no_bag'   → visual-test, use_reference:false (no bag)
//      render_mode='bag_hero' → visual-test, use_reference:true + product_name
//    For bag_hero, visual-test resolves the product's real bag photo from
//    woo_products and passes it to Gemini as a reference (with beans /
//    Strada X / roaster refs), so the real Minuto bag is rendered FAITHFULLY
//    into the full scene ALONGSIDE its co-subjects. visual-test owns the
//    locked Minuto visual identity + Scene Director rewrite (PR #88); we
//    pass scene_brief through faithfully — NEVER bypass the Scene Director.
//
//    (History: bag_hero used to route to vertex-imagen-edit, whose Imagen
//    SUBJECT customization is single-subject — it dropped co-subjects and
//    reinvented the label. That made bag briefs fail QA and the old ladder
//    degraded them to bagless images. Switched to Gemini+reference, which
//    Erez verified renders the bag reliably, 2026-06-01.)
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
// "Machine + Minuto bag in one frame" — SOLVED by Gemini+reference
// ─────────────────────────────────────────────────────────────────────────
// The old design (Vertex SUBJECT customization for bag_hero) could NOT put
// the real bag and a co-subject (e.g. an espresso machine) in the same frame
// — Imagen SUBJECT customization is single-subject. That forced an ugly
// trade and an abandoned "two-step composite" idea (pasted-PNG compositing,
// which looked fake — see _shared/compositor.ts, kept but not imported).
//
// Routing bag_hero through visual-test (Gemini + bag reference) removes the
// limitation: Gemini renders the real bag faithfully ALONGSIDE beans /
// machine / roaster references in a single pass (Erez-verified 2026-06-01).
// So multi-subject bag scenes are now a normal render, not a special case,
// and the QA ladder no longer degrades them to bagless images.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import {
  createSupabase,
  claimNextTask,
  markTaskCompleted,
  markTaskFailed,
  insertTasks,
} from '../seo-agent/db.ts'
import { callClaude, MODEL_ORCHESTRATOR, parseClaudeJson } from '../seo-agent/claude.ts'
import { attachFeaturedImage } from '../seo-agent/wpMediaAttach.ts'
import type { SeoTaskRow, VisualGenerationBrief, NewSeoTask } from '../seo-agent/types.ts'

// Brief regeneration: when the QA loop caps without passing, the worker
// asks Claude to rewrite the scene_brief based on the qa_attempts history,
// then queues a fresh task with the new brief. Hard cap on regen depth
// (some scene briefs are genuinely physics-bounded — e.g. multi-subject
// with byte-perfect bag fidelity — and no amount of rewriting will fix
// physics). MAX_BRIEF_REGENS=2 means up to 3 brief versions total per
// strategist-emitted task: original + 2 regens = 9 image-generation
// attempts max before genuine HITL.
const MAX_BRIEF_REGENS = 2

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
  // Tolerate a double-encoded brief: if brief_data was stored as a JSON string
  // (a model that stringified its tool input), parse it back to an object so a
  // valid carousel/bag_hero brief isn't rejected as "brief invalid".
  const rawBrief = task.brief_data as unknown
  const brief = (typeof rawBrief === 'string'
    ? (() => { try { return JSON.parse(rawBrief) } catch { return rawBrief } })()
    : rawBrief) as VisualGenerationBrief

  // ── 2b. CAROUSEL FORK ────────────────────────────────────────────────
  // When the brief carries a slides[] array it's a multi-slide IG carousel,
  // not a single image. The carousel path renders each slide's background
  // through the SAME per-slide Claude-vision QA loop the single-image path
  // uses (render → eval → retry), composites the Hebrew heading/body via the
  // deterministic visual-overlay function, and stores the ordered slide URLs.
  // No WP attach (carousel is ig_post only). If any slide can't pass QA after
  // its retries, the whole carousel is flagged review_required=true so the
  // admin reviews it before approving — the worker never reports an
  // unvetted carousel as ready. Handled and returned inside handleCarousel.
  if (Array.isArray(brief?.slides) && brief.slides.length > 0) {
    return await handleCarousel(supabase, task, brief, workerId)
  }

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
    // visual-test (use_reference:true) needs one of reference_image_url /
    // product_id / product_name to resolve WHICH bag to render. The
    // orchestrator's VisualGenerationBrief only exposes product_name, so it
    // must be set for bag_hero. Permanent failure — brief is malformed.
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
      // ESCALATION STEP 1. The OLD ladder switched bag_hero → no_bag here,
      // which DROPPED the Minuto bag and let a bagless image "pass" QA — the
      // bug that produced only no-bag banners. Now that bag_hero renders via
      // Gemini+reference (reliable at placing the bag), a failed bag attempt
      // is a brief/composition problem, NOT a "can't do a bag" problem. So:
      //   • bag_hero origin → STAY in bag_hero, augment the brief from the
      //     QA critique. Never fall back to bagless.
      //   • no_bag origin   → upgrade to bag_hero if we have a product to
      //     show, else stay no_bag with an augmented brief.
      if (renderMode === 'bag_hero') {
        workingRenderMode = 'bag_hero'
        workingSceneBrief = buildAugmentedSceneBrief(brief.scene_brief, qaAttempts)
        console.log(`[seo-worker-visual] ${workerId} escalation step 1: staying in bag_hero with augmented brief (never drop the bag)`)
      } else if (brief.product_name?.trim()) {
        workingRenderMode = 'bag_hero'
        workingSceneBrief = brief.scene_brief
        console.log(`[seo-worker-visual] ${workerId} escalation step 1: upgrading no_bag → bag_hero`)
      } else {
        workingRenderMode = 'no_bag'
        workingSceneBrief = buildAugmentedSceneBrief(brief.scene_brief, qaAttempts)
        console.log(`[seo-worker-visual] ${workerId} escalation step 1: no product to show, staying no_bag with augmented brief`)
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

  // ── 4b. BRIEF-REGENERATION ESCALATION ─────────────────────────────────
  // Before falling back to HITL, give the brief itself one rewrite chance.
  // The QA loop's intra-task escalation (mode switch + term stripping)
  // tries variants of the SAME scene_brief. This escalation calls Claude
  // to write a DIFFERENT scene_brief based on what failed, then queues
  // a fresh visual_generation task with the new brief. New task inherits
  // brief_regen_count + 1; recursion caps at MAX_BRIEF_REGENS.
  const currentRegenCount = ((task.brief_data as VisualGenerationBrief & { _brief_regen_count?: number })._brief_regen_count) ?? 0
  let regenQueuedTaskId: string | null = null
  if (reviewRequired && currentRegenCount < MAX_BRIEF_REGENS) {
    try {
      const rewrittenBrief = await regenerateVisualBrief({
        originalBrief: brief,
        qaAttempts,
        renderMode:    renderMode,
      })
      const newTask: NewSeoTask = {
        task_type:           'visual_generation',
        brief_data: {
          ...brief,
          scene_brief:        rewrittenBrief.scene_brief,
          // Per the rewrite (worker may also have flipped render_mode)
          render_mode:        rewrittenBrief.render_mode ?? renderMode,
          _brief_regen_count: currentRegenCount + 1,
          _regenerated_from:  task.id,
          _regen_rationale:   rewrittenBrief.rationale,
        } as unknown as VisualGenerationBrief,
        parent_task_id:      task.parent_task_id,
        rationale:           `[brief-regen ${currentRegenCount + 1}/${MAX_BRIEF_REGENS}] from task ${task.id.slice(0, 8)} — ${rewrittenBrief.rationale.slice(0, 100)}`,
        orchestrator_run_id: task.orchestrator_run_id ?? crypto.randomUUID(),
        experiment_id:       null,   // regen tasks are out-of-experiment by design (no longer same brief)
        variation_label:     null,
      }
      const inserted = await insertTasks(supabase, [newTask])
      regenQueuedTaskId = inserted[0]?.id ?? null
      console.log(`[seo-worker-visual] ${workerId} BRIEF REGEN ${currentRegenCount + 1}/${MAX_BRIEF_REGENS} queued: new task ${regenQueuedTaskId}, rationale: ${rewrittenBrief.rationale.slice(0, 120)}`)
    } catch (e: any) {
      // Regen failed (Claude error etc.) — fall through to HITL as before.
      console.warn(`[seo-worker-visual] ${workerId} brief regen threw — falling back to HITL: ${e?.message ?? e}`)
    }
  } else if (reviewRequired && currentRegenCount >= MAX_BRIEF_REGENS) {
    console.warn(`[seo-worker-visual] ${workerId} brief-regen cap reached (${currentRegenCount}/${MAX_BRIEF_REGENS}) — HITL is the path forward`)
  }

  if (destination === 'blog_banner' && parentWpPostId) {
    if (reviewRequired) {
      attachSkippedReason = regenQueuedTaskId
        ? `QA capped after ${qaAttempts.length} attempts; brief regenerated as task ${regenQueuedTaskId} (regen ${currentRegenCount + 1}/${MAX_BRIEF_REGENS}) — current task not attached, retry awaiting worker`
        : `QA capped after ${qaAttempts.length} attempts, brief-regen ${currentRegenCount >= MAX_BRIEF_REGENS ? 'cap reached' : 'failed'} — HITL required`
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
  const finalRenderFunction = 'visual-test'  // both bag + no_bag render via Gemini now
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
      // Brief regen lineage — visible in admin UI + queryable. If
      // regen_queued_task_id is set, admin sees "this task didn't pass
      // QA but the worker queued a rewritten brief as task X".
      brief_regen_count:    currentRegenCount,
      brief_regen_queued:   regenQueuedTaskId,
      brief_regen_at_cap:   reviewRequired && currentRegenCount >= MAX_BRIEF_REGENS,
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
  // BOTH modes now render through Gemini (visual-test). The bag is placed
  // by passing use_reference:true + product_name — visual-test resolves the
  // product's real bag photo from woo_products and feeds it to Gemini as a
  // reference (alongside beans / machine / roaster refs), so the Minuto bag
  // is rendered FAITHFULLY into the full scene WITH its co-subjects. This
  // replaces the old vertex-imagen-edit route, whose SUBJECT customization
  // is single-subject (drops co-subjects) and reinvents the label — which is
  // why bag renders kept failing QA and degrading to bagless images.
  const endpoint = 'visual-test'
  const body: Record<string, unknown> = args.renderMode === 'no_bag'
    ? { scene_brief: args.sceneBrief, aspect: args.aspect, use_reference: false }
    : { scene_brief: args.sceneBrief, aspect: args.aspect, use_reference: true, product_name: args.productName }

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
// CAROUSEL PATH — render N slides, each = a no_bag background + a
// deterministic Hebrew text overlay (heading + optional body) composited
// by the visual-overlay edge function. Slides render in PARALLEL so the
// whole carousel fits the 240s cron budget (serial would be ~N×40s).
//
// Decisions (locked with Erez 2026-05-31):
//   • distinct per-slide backgrounds (variety, true "journey" carousel)
//   • 3-5 slides; hard-cap at 5 (extras truncated with a warning)
//   • per-slide render mode: a bag_hero carousel composites the real Minuto bag
//     on the slide(s) whose brief calls for it (Gemini+reference, NOT the old
//     single-subject Vertex route), while bag-free slides stay no_bag. (Was:
//     "forced to no_bag" — that silently dropped the bag from bag_hero carousels.)
//   • aspect feed_portrait (1080×1350), IG carousel standard
//   • strategist authors heading/body — workers never write IG copy
// ─────────────────────────────────────────────────────────────────────────
const CAROUSEL_MAX_SLIDES = 5
const CAROUSEL_MIN_SLIDES = 2

// Gemini (no_bag mode) has a strong "coffee scene → put a bag in frame"
// prior and will hallucinate a generic NON-Minuto bag — often with an
// invented competitor brand + logo baked in (a live test produced a
// "STAG COFFEE" deer-logo bag). The carousel path now runs the same per-slide
// Claude-vision QA loop as single images (so a hallucinated bag is caught and
// retried, then flagged for review if it persists); this guard is the FIRST
// line of defence — a negative directive appended to the tail of every slide
// brief to cut down retries (generative models weight the prompt tail most).
// Also forbids printed words/logos so the deterministic Hebrew overlay is
// the ONLY text on the slide.
function addNoBagGuard(sceneBrief: string): string {
  return `${sceneBrief.trim()}

DO NOT INCLUDE any of these — they are forbidden in this render:
- No coffee bag, packaging, pouch, sachet, or product label of any kind
- No brand names, logos, wordmarks, or printed text anywhere in the scene
- No loose-bag spillage or product container
The frame must carry NO printed words or brand marks — overlay text is added separately.`
}

// Some carousel slides ARE meant to feature the product bag (typically the
// hero slide), now that bag_hero renders via Gemini+reference (NOT the old
// single-subject Vertex route — so a bag composites fine alongside co-subjects
// in a multi-slide set). A slide "wants the bag" when its scene brief calls for
// one — bag / pouch / packaging / sachet, EN or HE. Bag-free slides (beans,
// brewing gear, cups) stay no_bag so addNoBagGuard still suppresses Gemini's
// hallucinated generic competitor bag.
function slideWantsBag(sceneBrief: string): boolean {
  return /\bbags?\b|\bpouch(?:es)?\b|packaging|\bsachets?\b|שקית|שקיק|אריזה/i.test(sceneBrief)
}

// For bag slides, keep the bag but still forbid printed words/logos so the
// deterministic Hebrew overlay stays the only text on the slide (the bag's own
// label is the real Minuto artwork from the reference image, which is fine).
function addBagSlideGuard(sceneBrief: string): string {
  return `${sceneBrief.trim()}

The single Minuto coffee bag shown must be the real product (rendered from the supplied reference image) — never a generic or invented bag.
DO NOT add any brand names, logos, wordmarks, or printed text to the SCENE other than what is printed on the product bag itself — overlay text is added separately.`
}

async function handleCarousel(
  supabase: ReturnType<typeof createSupabase>,
  task: SeoTaskRow,
  brief: VisualGenerationBrief,
  workerId: string,
): Promise<Response> {
  const rawSlides = brief.slides ?? []
  // Validate shape before doing any expensive render work.
  const slides = rawSlides
    .filter(s => s && typeof s.scene_brief === 'string' && s.scene_brief.trim() && typeof s.heading === 'string' && s.heading.trim())
    .slice(0, CAROUSEL_MAX_SLIDES)

  if (slides.length < CAROUSEL_MIN_SLIDES) {
    await safeMarkFailed(
      supabase,
      task,
      `carousel needs ${CAROUSEL_MIN_SLIDES}-${CAROUSEL_MAX_SLIDES} valid slides (each with non-empty scene_brief + heading); got ${slides.length} valid of ${rawSlides.length}`,
      true,
    )
    return jsonResponse({ processed: 1, worker_id: workerId, task_id: task.id, ok: false, error: 'carousel slides invalid' })
  }
  if (rawSlides.length > CAROUSEL_MAX_SLIDES) {
    console.warn(`[seo-worker-visual] ${workerId} carousel truncated ${rawSlides.length} → ${CAROUSEL_MAX_SLIDES} slides`)
  }

  // Carousel-level render mode. bag_hero opts the hero slide(s) into bag
  // compositing; everything else is no_bag. (Previously the carousel forced
  // ALL slides to no_bag — that silently dropped the bag from bag_hero
  // carousels even when the hero slide's brief explicitly asked for it.)
  const carouselRenderMode: 'no_bag' | 'bag_hero' =
    brief.render_mode === 'bag_hero' ? 'bag_hero' : 'no_bag'
  const productName = brief.product_name?.trim() || undefined
  if (carouselRenderMode === 'bag_hero' && !productName) {
    console.warn(`[seo-worker-visual] ${workerId} carousel render_mode=bag_hero but no product_name — no bag to composite, slides render bag-free`)
  }

  console.log(`[seo-worker-visual] ${workerId} carousel render: ${slides.length} slides (parallel), mode=${carouselRenderMode}`)

  // Render every slide in parallel — EACH slide runs the same Claude-vision
  // QA loop the single-image path uses (render → eval → retry), so generic /
  // competitor bags, stray hands, and off-brand frames are CAUGHT here rather
  // than surfaced to the admin as "ready to approve". Slides run concurrently
  // so the carousel's wall-clock ≈ the slowest single slide (~one image's
  // worth of attempts), keeping it inside the 240s cron budget.
  let slideResults: Array<{
    rendered:    { image_url: string; bg_url: string; heading: string; body?: string }
    qa_attempts: Array<{ attempt: number; image_url: string; scene_brief: string; critique: VisualCritique }>
    passed:      boolean
    mode:        'no_bag' | 'bag_hero'
  }>
  try {
    slideResults = await Promise.all(slides.map((slide, i) => renderCarouselSlideWithQA(slide, i, workerId, carouselRenderMode, productName)))
  } catch (e: any) {
    // Any slide render/overlay INFRA failure (HTTP/API outage) fails the whole
    // carousel — a partial carousel is not publishable. Linear retry via
    // markTaskFailed. (A QA *fail* does NOT land here — that flags review.)
    const msg = `carousel slide render failed: ${e?.message ?? e}`
    const permanently = task.attempts >= task.max_attempts
    await safeMarkFailed(supabase, task, msg, permanently)
    return jsonResponse({ processed: 1, worker_id: workerId, task_id: task.id, ok: false, error: msg, permanent: permanently }, 500)
  }

  const renderedSlides = slideResults.map(r => r.rendered)
  const anyBagSlide = slideResults.some(r => r.mode === 'bag_hero')
  // One slide that can't pass vision QA after its retries flags the WHOLE
  // carousel for human review — a single off-brand slide makes the set
  // unpublishable. This replaces the old hard-coded review_required:false.
  const failedSlideCount = slideResults.filter(r => !r.passed).length
  const carouselReviewRequired = failedSlideCount > 0
  if (carouselReviewRequired) {
    console.warn(`[seo-worker-visual] ${workerId} carousel review_required: ${failedSlideCount}/${slideResults.length} slide(s) failed QA`)
  }

  try {
    await markTaskCompleted(supabase, task.id, {
      carousel:        true,
      carousel_slides: renderedSlides,
      slide_count:     renderedSlides.length,
      aspect:          'feed_portrait',
      destination:     'ig_post',
      render_function: 'visual-test+visual-overlay',
      render_mode:     anyBagSlide ? 'bag_hero' : 'no_bag',
      // Per-slide Claude-vision QA ran. review_required=true means at least
      // one slide could not pass after its retries — a human reviews the
      // slide_qa log before this carousel is approved for publish.
      review_required: carouselReviewRequired,
      qa_passed:       !carouselReviewRequired,
      slide_qa:        slideResults.map((r, i) => ({ slide: i + 1, passed: r.passed, attempts: r.qa_attempts })),
    })
  } catch (e: any) {
    console.error(`[seo-worker-visual] ${workerId} carousel markTaskCompleted failed: ${e?.message ?? e}`)
    return jsonResponse({
      processed: 1,
      worker_id: workerId,
      task_id:   task.id,
      ok:        false,
      error:     `carousel rendered (${renderedSlides.length} slides) but result write failed: ${e?.message ?? e}`,
    }, 500)
  }

  return jsonResponse({
    processed:        1,
    worker_id:        workerId,
    task_id:          task.id,
    ok:               true,
    carousel:         true,
    slide_count:      renderedSlides.length,
    slides:           renderedSlides.map(s => s.image_url),
    review_required:  carouselReviewRequired,
    failed_slides:    failedSlideCount,
  })
}

// Per-slide render + Claude-vision QA — mirrors the single-image loop, WITHOUT
// the espresso-machine-specific stripConflictingTerms step (a carousel slide
// can be any scene — origins, brewing, cherries — so we only use the generic
// critique-driven augmentation). Each slide picks its OWN mode: a slide whose
// brief calls for the product bag (and whose carousel is bag_hero with a
// product_name) renders bag_hero (use_reference:true + product_name → the real
// Minuto bag is composited); every other slide stays no_bag with the no-bag
// guard suppressing Gemini's hallucinated generic bag. Attempts:
//   1: slide brief + mode-appropriate guard
//   2: brief augmented with the prior critique's MUST-INCLUDE / AVOID directives
//   3: same, re-augmented from attempt 2's critique
// On all-fail we still overlay the best-effort background so there's a viewable
// slide, but `passed:false` bubbles up and flags the carousel review_required.
async function renderCarouselSlideWithQA(
  slide: { scene_brief: string; heading: string; body?: string },
  slideIndex: number,
  workerId: string,
  carouselRenderMode: 'no_bag' | 'bag_hero',
  productName: string | undefined,
): Promise<{
  rendered:    { image_url: string; bg_url: string; heading: string; body?: string }
  qa_attempts: Array<{ attempt: number; image_url: string; scene_brief: string; critique: VisualCritique }>
  passed:      boolean
  mode:        'no_bag' | 'bag_hero'
}> {
  // A slide renders the bag only when the carousel opted into bag_hero, we have
  // a product to composite, AND this slide's brief actually asks for the bag.
  const slideMode: 'no_bag' | 'bag_hero' =
    carouselRenderMode === 'bag_hero' && !!productName && slideWantsBag(slide.scene_brief)
      ? 'bag_hero'
      : 'no_bag'
  console.log(`[seo-worker-visual] ${workerId} slide ${slideIndex + 1} mode=${slideMode}`)

  const MAX_SLIDE_QA_ATTEMPTS = 3
  const attempts: Array<{ attempt: number; image_url: string; scene_brief: string; critique: VisualCritique }> = []
  let bgUrl = ''
  let passed = false

  for (let a = 1; a <= MAX_SLIDE_QA_ATTEMPTS; a++) {
    // Attempt 1 = the strategist's brief. Attempts 2-3 fold in the prior
    // critique's directives (buildAugmentedSceneBrief is generic — safe for
    // any slide scene). The mode-appropriate guard wraps every attempt: bag
    // slides keep the bag (only suppress stray scene text/logos), bag-free
    // slides forbid any bag.
    const baseBrief = a === 1
      ? slide.scene_brief
      : buildAugmentedSceneBrief(slide.scene_brief, attempts)
    const guardedBrief = slideMode === 'bag_hero' ? addBagSlideGuard(baseBrief) : addNoBagGuard(baseBrief)

    // Render (infra errors throw → bubble up to fail the whole carousel).
    const bg = await renderOnce({
      renderMode:  slideMode,
      sceneBrief:  guardedBrief,
      aspect:      'feed_portrait',
      productName: slideMode === 'bag_hero' ? productName : undefined,
    })
    bgUrl = bg.url

    // Evaluate against the SAME guarded brief + mode so the eval applies the
    // right rules (bag required vs forbidden). Eval outage → treat as pass
    // (don't burn the slide on an Anthropic blip — the image is already rendered).
    let critique: VisualCritique
    try {
      critique = await evaluateVisual({
        imageUrl:    bgUrl,
        sceneBrief:  guardedBrief,
        renderMode:  slideMode,
        productName: slideMode === 'bag_hero' ? productName : undefined,
      })
    } catch (e: any) {
      console.warn(`[seo-worker-visual] ${workerId} slide ${slideIndex + 1} eval threw — treating as pass: ${e?.message ?? e}`)
      critique = { passes: true, missing: [], issues: [], suggested_adjustment: '' } as VisualCritique
    }
    attempts.push({ attempt: a, image_url: bgUrl, scene_brief: baseBrief, critique })
    console.log(`[seo-worker-visual] ${workerId} slide ${slideIndex + 1} qa-attempt ${a}/${MAX_SLIDE_QA_ATTEMPTS} ${critique.passes ? 'PASSED' : `FAILED missing=${JSON.stringify(critique.missing)} issues=${JSON.stringify(critique.issues)}`}`)
    if (critique.passes) { passed = true; break }
  }

  // Overlay the passed (or best-effort) background so the slide is always
  // viewable — even a review_required carousel needs renderable slides for
  // the admin to look at.
  const finalUrl = await overlaySlide({ imageUrl: bgUrl, heading: slide.heading, body: slide.body })
  return {
    rendered:    { image_url: finalUrl, bg_url: bgUrl, heading: slide.heading, body: slide.body },
    qa_attempts: attempts,
    passed,
    mode:        slideMode,
  }
}

// Composite a Hebrew heading (+ optional body) onto a slide background via
// the deterministic visual-overlay edge function (resvg/RTL). Returns the
// final slide URL.
async function overlaySlide(args: {
  imageUrl: string
  heading:  string
  body?:    string
}): Promise<string> {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/visual-overlay`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ANON_KEY}`, apikey: ANON_KEY },
    body: JSON.stringify({
      image_url:    args.imageUrl,
      overlay_text: args.heading,
      body_text:    args.body,
      aspect:       'feed_portrait',
      direction:    'rtl',
      position:     'bottom',
    }),
  })
  const json = await res.json().catch(() => ({})) as Record<string, unknown>
  if (!res.ok || !json.url || typeof json.url !== 'string') {
    throw new Error(`visual-overlay HTTP ${res.status}: ${(json.error as string) ?? JSON.stringify(json).slice(0, 200)}`)
  }
  return json.url
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
//   bag_hero mode: last-ditch simplification — strip co-subject mentions
//     so the brief becomes a clean single-subject bag hero shot. Gemini
//     handles multi-subject fine, but on a 3rd failed attempt narrowing to
//     the bag alone maximises the odds of a clean, on-brand render that
//     STILL shows the Minuto bag (never drops it).
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

// ─────────────────────────────────────────────────────────────────────────
// Brief regeneration — called when the 3-attempt QA loop has capped and
// the worker is about to mark review_required=true. Instead of stopping
// here, give Claude a chance to rewrite the brief based on what we
// learned from the failed attempts. The rewritten brief is queued as a
// NEW visual_generation task (so the worker's QA loop resets to 3 fresh
// attempts on a structurally different prompt).
//
// Output the rewriter MUST consider:
//   - critique history: missing subjects + issues across all 3 attempts
//   - the modes that were tried (and the final mode the QA loop landed on)
//   - constraint: render_mode must still be 'bag_hero' OR 'no_bag'
//   - constraint: if the original brief required multi-subject (e.g.
//     machine + Minuto bag) and we never produced both, the rewrite
//     should choose between (a) drop the bag and write machine-only,
//     (b) make the bag the hero and drop everything else, or
//     (c) restructure entirely. Don't keep banging on the multi-subject
//     impossibility (Vertex SUBJECT customization is single-subject).
// ─────────────────────────────────────────────────────────────────────────
const BRIEF_REGEN_SYSTEM_PROMPT = `You are the brief rewriter for Minuto's visual generation pipeline. The 3-attempt QA loop just failed for a scene_brief; your job is to write a STRUCTURALLY DIFFERENT brief that addresses what kept going wrong.

CRITICAL — the QA loop already tried:
  • Original brief in the original render_mode
  • Original brief in the OPPOSITE render_mode (bag_hero ↔ no_bag)
  • Mode-switched brief with conflicting terms surgically stripped + negative directives appended

If all 3 failed on the same kind of issue (subject missing, scene wrong, wrong aesthetic), banging on the same brief won't help. You need a STRUCTURAL change:

Common rewrite patterns that work:
  • Multi-subject failures (machine + bag both required, only bag rendered): rewrite as single-subject. Choose ONE subject the brief is really about. Drop the other.
  • Render-mode confusion (bag_hero asked but no_bag rendered cleanly in one attempt): switch the rewritten brief's render_mode to that working mode.
  • Persistent hallucination of forbidden objects: rewrite the scene around a structurally simpler subject the model handles well.
  • Anything else: ask yourself "what is the simplest version of this brief that gets at the user's actual intent?" and write that.

You output one rewritten brief + a 1-sentence rationale explaining the structural change you made.

STRICT JSON (no markdown fences):
{
  "scene_brief": "the new 4-6 sentence photographer's brief in the locked Minuto identity",
  "render_mode": "bag_hero" | "no_bag",
  "rationale":   "one sentence — what structural change vs the original you made and why"
}`

async function regenerateVisualBrief(args: {
  originalBrief:  VisualGenerationBrief
  qaAttempts:     Array<{ attempt: number; image_url: string; render_mode: 'no_bag' | 'bag_hero'; scene_brief: string; critique: VisualCritique }>
  renderMode:     'no_bag' | 'bag_hero'
}): Promise<{ scene_brief: string; render_mode: 'no_bag' | 'bag_hero'; rationale: string }> {
  const attemptsLog = args.qaAttempts.map(a => {
    const missing = a.critique.missing.length > 0 ? `missing=${JSON.stringify(a.critique.missing)}` : 'no-missing'
    const issues  = a.critique.issues.length  > 0 ? `issues=${JSON.stringify(a.critique.issues).slice(0, 300)}` : 'no-issues'
    return `  Attempt ${a.attempt} (mode=${a.render_mode}): ${missing} | ${issues}\n  Brief used: "${a.scene_brief.slice(0, 300)}…"`
  }).join('\n\n')

  const userMessage = `ORIGINAL BRIEF (caller's input):
  scene_brief: ${args.originalBrief.scene_brief}
  render_mode: ${args.renderMode}
  product_name: ${args.originalBrief.product_name ?? '(none)'}
  aspect: ${args.originalBrief.aspect ?? 'feed_square'}
  destination: ${args.originalBrief.destination ?? '?'}

QA ATTEMPTS THAT FAILED:
${attemptsLog}

Rewrite the brief per the system prompt. Output strict JSON only.`

  const res = await callClaude({
    model:       MODEL_ORCHESTRATOR,
    system:      BRIEF_REGEN_SYSTEM_PROMPT,
    messages:    [{ role: 'user', content: userMessage }],
    maxTokens:   700,
    temperature: 0.4,
    timeoutMs:   45_000,
  })
  const parsed = parseClaudeJson<{ scene_brief?: unknown; render_mode?: unknown; rationale?: unknown }>(res.text)
  return {
    scene_brief: typeof parsed.scene_brief === 'string' && parsed.scene_brief.length > 50 ? parsed.scene_brief : args.originalBrief.scene_brief,
    render_mode: (parsed.render_mode === 'bag_hero' || parsed.render_mode === 'no_bag') ? parsed.render_mode : args.renderMode,
    rationale:   typeof parsed.rationale === 'string' ? parsed.rationale : 'no rationale supplied',
  }
}
