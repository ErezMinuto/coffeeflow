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
import { isServiceCaller, unauthorized } from '../_shared/service_caller.ts'
import {
  createSupabase,
  claimNextTask,
  markTaskCompleted,
  markTaskFailed,
  insertTasks,
} from '../seo-agent/db.ts'
import { callClaude, MODEL_VISUAL_CRITIC, parseClaudeJson, type MessageContentBlock } from '../seo-agent/claude.ts'
import { attachFeaturedImage, fetchPostStatus } from '../seo-agent/wpMediaAttach.ts'
import { checkLabelText, LABEL_TRANSCRIBE_PROMPT, type LabelTranscript } from '../_shared/bag_label_check.ts'
import { BAG_LOCKUP_TEXT } from '../_shared/bag_references.ts'
import { buildBrandIndex, screenHeroProduct } from '../seo-agent/services/brandGuard.ts'
import type { SeoTaskRow, VisualGenerationBrief, NewSeoTask } from '../seo-agent/types.ts'
import { noBagTail } from './no_bag_tail.ts'
import { BEST_EFFORT_POST_STATUSES, pickBestEffortAttempt } from './best_effort.ts'

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
  // Only cron and other functions run this. The gateway's verify_jwt still admits
  // the public anon key, so the caller is checked here.
  if (!(await isServiceCaller(req))) return unauthorized(CORS_HEADERS)
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
  // BRAND GUARD — last line of defence, at the point of no return. bag_hero
  // composites the real white Minuto bag around whatever product_name says, so
  // a reseller or green-coffee name here produces an image that misrepresents
  // what Minuto sells. Four such renders reached completion (Veneto Delux on
  // 2026-09-13, Veneto Premium on 09-23, a green Brazil 1kg on 09-20) despite
  // the rule existing in prompts since May.
  //
  // Name-only classification on purpose: this runs per task, and pulling the
  // full catalogue for categories on every render would cost a 1000-row select
  // to re-derive what the planners already checked with categories in hand.
  // The regex is verified against every real off-brand SKU (see
  // brandGuard.test.ts). Permanent failure — a brief naming a banned product
  // is malformed, and retrying renders it again.
  {
    const verdict = screenHeroProduct(brief.product_name, buildBrandIndex([]))
    if (!verdict.ok) {
      console.error(`[seo-worker-visual] ${workerId} BRAND GUARD blocked task ${task.id}: ${verdict.why}`)
      await safeMarkFailed(supabase, task, `brand guard: ${verdict.why}`, true)
      return jsonResponse({ processed: 1, worker_id: workerId, task_id: task.id, ok: false, error: 'brand guard blocked product_name' })
    }
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
      const parentStatus = parent?.status ?? 'missing'
      if (parentStatus === 'pending' || parentStatus === 'processing') {
        // Writer task hasn't finished YET (still queued or running).
        // Release the row back to 'pending' WITHOUT counting this as an
        // attempt — the visual itself never ran, so it would be wrong to
        // burn a retry slot on the writer's schedule. We undo the
        // attempts++ that claimNextTask did when it locked the row, clear
        // the lock, PUSH scheduled_for FORWARD (see
        // releaseForParentNotReady — without the push this row starves the
        // whole queue), and let a later cron tick re-evaluate. Attempts are
        // reserved for genuine render or attach failures (see the catch
        // around step 4).
        const backoffMinutes = await releaseForParentNotReady(
          supabase,
          task,
          `parent text task ${task.parent_task_id} not yet completed (status=${parentStatus})`,
        )
        return jsonResponse({
          processed: 1,
          worker_id: workerId,
          task_id:   task.id,
          ok:        false,
          retry:     true,
          reason:    'parent_not_ready',
          retry_in_minutes: backoffMinutes,
        })
      }
      if (!parent || parent.status !== 'completed') {
        // Parent is 'failed' (or gone) — it will NEVER produce a
        // wp_post_id, so deferring again would defer forever. Render the
        // image anyway and skip the attach, exactly like the
        // no-parent_task_id branch below: the image_url lands in
        // result_data so a human can attach it manually from the admin UI.
        console.warn(`[seo-worker-visual] ${workerId} parent ${task.parent_task_id} is ${parentStatus} — will render but cannot attach`)
      } else {
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
    // Exact prompt the image model got (from visual-test), so a bad image
    // can be traced. Shown in the IG review email for the chosen attempt.
    prompt_doc?: string
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
        realPhoto:   !!rendered.raw.real_photo,
        ...critiqueContext(rendered.raw),
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
      prompt_doc:  typeof rendered.raw.prompt_doc === 'string' ? rendered.raw.prompt_doc : undefined,
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
  // 'qa_pass' = the normal path. 'best_effort' = QA and every brief regen
  // failed, so the least-bad attempt of the whole regen chain went onto the
  // still-DRAFT post for the reviewer (see best_effort.ts). review_required
  // stays true either way for a best-effort attach.
  let attachMode: 'qa_pass' | 'best_effort' | null = null
  let bestEffortPick: { task_id: string; attempt: number; image_url: string } | null = null

  // ── 4b. BRIEF-REGENERATION ESCALATION ─────────────────────────────────
  // Before falling back to HITL, give the brief itself one rewrite chance.
  // The QA loop's intra-task escalation (mode switch + term stripping)
  // tries variants of the SAME scene_brief. This escalation calls Claude
  // to write a DIFFERENT scene_brief based on what failed, then queues
  // a fresh visual_generation task with the new brief. New task inherits
  // brief_regen_count + 1; recursion caps at MAX_BRIEF_REGENS.
  const currentRegenCount = ((task.brief_data as VisualGenerationBrief & { _brief_regen_count?: number })._brief_regen_count) ?? 0
  let regenQueuedTaskId: string | null = null
  // Brief-regen spawns a FRESH visual_generation task. For blog_banner that's
  // worthwhile (the banner auto-attaches, so a better brief ships unattended).
  // For ig_post it is NOT: a review-flagged IG visual already stages for HITL
  // review (vision-QA is advisory there, not a gate), so a human picks the best
  // attempt — auto-respawning just multiplies renders. Combined with the daily
  // IG cadence, each flagged visual used to fan out into 2 more, compounding the
  // mission's per-tick queuing into hundreds of renders/day. Skip regen for IG.
  const regenAllowed = destination !== 'ig_post'
  if (reviewRequired && regenAllowed && currentRegenCount < MAX_BRIEF_REGENS) {
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
  } else if (reviewRequired && !regenAllowed) {
    console.log(`[seo-worker-visual] ${workerId} IG visual flagged for review — staging for HITL (no auto-regen for ig_post)`)
  } else if (reviewRequired && currentRegenCount >= MAX_BRIEF_REGENS) {
    console.warn(`[seo-worker-visual] ${workerId} brief-regen cap reached (${currentRegenCount}/${MAX_BRIEF_REGENS}) — HITL is the path forward`)
  }

  if (destination === 'blog_banner' && parentWpPostId) {
    if (reviewRequired && regenQueuedTaskId) {
      // A rewritten brief is already queued; its task attaches (or falls
      // back to best-effort) when it finishes.
      attachSkippedReason = `QA capped after ${qaAttempts.length} attempts; brief regenerated as task ${regenQueuedTaskId} (regen ${currentRegenCount + 1}/${MAX_BRIEF_REGENS}) — current task not attached, retry awaiting worker`
      console.warn(`[seo-worker-visual] ${workerId} ${attachSkippedReason}`)
    } else if (!WP_USERNAME || !WP_APP_PASSWORD) {
      attachError = 'WP_BLOG_POST_USER_NAME / WP_BLOG_POST_PASS not configured'
      console.warn(`[seo-worker-visual] ${workerId} ${attachError}`)
    } else {
      const wp = { wpUrl: WP_URL, username: WP_USERNAME, appPassword: WP_APP_PASSWORD, postId: parentWpPostId }
      let attachUrl: string | null = imageUrl
      if (reviewRequired) {
        // End of the line: QA failed and no regen is coming. Attach the
        // least-bad attempt of the whole regen chain, but only while the post
        // is still a draft a human must approve.
        attachUrl = null
        const capNote = `QA capped after ${qaAttempts.length} attempts, brief-regen ${currentRegenCount >= MAX_BRIEF_REGENS ? 'cap reached' : 'failed'}`
        try {
          const postStatus = await fetchPostStatus(wp)
          if (!BEST_EFFORT_POST_STATUSES.has(postStatus)) {
            attachSkippedReason = `${capNote}; post ${parentWpPostId} is '${postStatus}', not a draft — best-effort attach refused, HITL required`
          } else {
            const chain = [
              ...await loadRegenChainAttempts(supabase, task),
              ...qaAttempts.map(a => ({ ...a, task_id: task.id })),
            ]
            const pick = pickBestEffortAttempt(chain)
            if (!pick) {
              attachSkippedReason = `${capNote}; no attempt with an image to fall back on — HITL required`
            } else {
              attachUrl = pick.image_url
              bestEffortPick = { task_id: pick.task_id, attempt: pick.attempt, image_url: pick.image_url }
              console.warn(`[seo-worker-visual] ${workerId} ${capNote}; best-effort attaching task ${pick.task_id.slice(0, 8)} attempt ${pick.attempt} to draft ${parentWpPostId}`)
            }
          }
        } catch (e: any) {
          attachSkippedReason = `${capNote}; best-effort attach skipped, post status unknown (${e?.message ?? e}) — HITL required`
        }
        if (attachSkippedReason) console.warn(`[seo-worker-visual] ${workerId} ${attachSkippedReason}`)
      }
      if (attachUrl) {
        try {
          attachedMediaId = await attachFeaturedImage({
            ...wp,
            imageUrl:    attachUrl,
            titleHint:   (renderResponse.scene_brief as string)?.slice(0, 60) ?? 'seo banner',
          })
          attachMode = reviewRequired ? 'best_effort' : 'qa_pass'
          console.log(`[seo-worker-visual] ${workerId} attached media_id=${attachedMediaId} to post_id=${parentWpPostId} (${attachMode})`)
        } catch (e: any) {
          attachError = e?.message ?? String(e)
          console.warn(`[seo-worker-visual] ${workerId} attach failed: ${attachError}`)
        }
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
    await markTaskCompleted(supabase, task, {
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
      attach_mode:         attachMode,
      best_effort_pick:    bestEffortPick,
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
    attach_mode:         attachMode,
    best_effort_pick:    bestEffortPick,
    qa_passed:           qaPassed,
    review_required:     reviewRequired,
    qa_attempt_count:    qaAttempts.length,
  })
})

// attachFeaturedImage lifted to seo-agent/wpMediaAttach.ts so the chat
// handler's approve_qa_attempt tool can reuse the same code path.

// The QA attempts of the tasks this one was regenerated from, oldest first,
// each tagged with its task id. Follows brief_data._regenerated_from, which
// brief-regen sets; at most MAX_BRIEF_REGENS hops. A lookup error just ends
// the walk: the fallback then picks from fewer attempts, never fails the task.
async function loadRegenChainAttempts(
  supabase: ReturnType<typeof createSupabase>,
  task: SeoTaskRow,
): Promise<Array<{ task_id: string; attempt: number; image_url: string; critique: VisualCritique }>> {
  const out: Array<{ task_id: string; attempt: number; image_url: string; critique: VisualCritique }> = []
  let fromId = (task.brief_data as { _regenerated_from?: string })._regenerated_from
  for (let hop = 0; fromId && hop < MAX_BRIEF_REGENS; hop++) {
    const { data, error } = await supabase.from('seo_tasks').select('id, brief_data, result_data').eq('id', fromId).maybeSingle()
    if (error || !data) break
    const attempts = ((data.result_data ?? {}) as { qa_attempts?: Array<{ attempt: number; image_url: string; critique: VisualCritique }> }).qa_attempts ?? []
    out.unshift(...attempts.filter(a => a?.critique).map(a => ({ ...a, task_id: data.id as string })))
    fromId = (data.brief_data as { _regenerated_from?: string } | null)?._regenerated_from
  }
  return out
}

// markTaskFailed throws on its own DB errors; swallow so the HTTP
// response we already prepared still flushes cleanly.
async function safeMarkFailed(
  supabase: ReturnType<typeof createSupabase>,
  task: SeoTaskRow,
  msg: string,
  permanent: boolean,
): Promise<void> {
  try {
    await markTaskFailed(supabase, task, msg, permanent)
  } catch (e: any) {
    console.error(`[seo-worker-visual] markTaskFailed write failed: ${e?.message ?? e}`)
  }
}

// Release a claimed row back to 'pending' without consuming an attempt.
// Used when we discover post-claim that we shouldn't have claimed yet
// (parent text task not ready). claimNextTask already did attempts++ as
// part of the lock, so we explicitly decrement it back. error_msg gets
// the diagnostic so the admin UI shows why the row keeps cycling, but
// status stays 'pending' so a later cron tick re-evaluates.
//
// ⚠️ scheduled_for MUST move forward here — this is the whole reason the
// queue used to stall. claimNextTask orders eligible rows by scheduled_for
// ASC and returns the FIRST claimable one, and this worker processes exactly
// ONE task per invocation. So a row released back to 'pending' with its
// ORIGINAL scheduled_for is the oldest candidate again on the very next
// tick: the worker re-claims it, defers it again, and returns — burning
// every 2-minute tick on the one task that cannot run while every other
// pending visual task behind it is never even looked at. (That is exactly
// how three story tasks sat pending with attempts=0 from Aug 3 onward while
// the worker reported processed:1 / reason:parent_not_ready each tick.)
// Pushing scheduled_for out sends this row to the BACK of the queue, so the
// runnable tasks drain first and the deferred one is rechecked on its own
// cadence. Returns the backoff it applied (minutes) for the HTTP response.
async function releaseForParentNotReady(
  supabase: ReturnType<typeof createSupabase>,
  task: SeoTaskRow,
  reason: string,
): Promise<number> {
  const restoredAttempts = Math.max(0, (task.attempts ?? 1) - 1)
  const backoffMinutes   = parentWaitBackoffMinutes(task)
  const nextScheduledFor = new Date(Date.now() + backoffMinutes * 60_000).toISOString()
  try {
    const { error } = await supabase
      .from('seo_tasks')
      .update({
        status:        'pending',
        attempts:      restoredAttempts,
        worker_id:     null,
        locked_until:  null,
        scheduled_for: nextScheduledFor,
        error_msg:     `[deferred ${backoffMinutes}m] ${reason}`,
      })
      .eq('id', task.id)
    if (error) throw error
  } catch (e: any) {
    console.error(`[seo-worker-visual] release-without-attempt failed: ${e?.message ?? e}`)
  }
  return backoffMinutes
}

// How far to push scheduled_for on a parent-not-ready deferral. Escalates
// with how long the task has already been waiting: a writer task normally
// finishes within a couple of cron ticks, so recheck a fresh task soon, but
// stop re-polling a long-waiting one every few minutes. We deliberately
// never give up on a 'pending'/'processing' parent — the orchestrator is
// allowed to time-shift a parent weeks out (scheduled_for exists for exactly
// that) — the deferral just gets cheap, and it no longer blocks anyone.
function parentWaitBackoffMinutes(task: SeoTaskRow): number {
  const createdMs = Date.parse(task.created_at ?? '')
  const waitedMs  = Number.isFinite(createdMs) ? Date.now() - createdMs : 0
  if (waitedMs < 30 * 60_000)      return 5    // first half hour: recheck quickly
  if (waitedMs < 4 * 60 * 60_000)  return 15
  return 30
}

// Trim render-function response to the fields useful for downstream
// debugging without bloating the result_data JSONB.
function pickRenderSummary(r: Record<string, unknown>): Record<string, unknown> {
  return {
    aspect:                r.aspect,
    ratio:                 r.ratio,
    // Actual rendered pixel dimensions + whether they match the requested
    // ratio. visual-test measures the returned image; a false here means
    // the render came back the wrong shape (e.g. a horizontal "story").
    width:                 r.width,
    height:                r.height,
    aspect_ok:             r.aspect_ok,
    bytes:                 r.bytes,
    pipeline:              r.pipeline,
    used_reference:        r.used_reference,
    bag_source:            r.bag_source,
    bag_url:               r.bag_url,
    visual_director_model: r.visual_director_model,
    visual_director_error: r.visual_director_error,
    surface:               r.surface,
    style_ref:             r.style_ref,
    // Traceability: the full prompt is kept per attempt in qa_attempts[].prompt_doc.
    scene_brief_sent:      r.scene_brief,
    brief_rewrite_changes: r.brief_rewrite_changes,
    brief_rewrite_error:   r.brief_rewrite_error,
    real_photo:            r.real_photo,
    roaster_ref:           r.roaster_ref,
    machine_ref:           r.machine_ref,
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
    await markTaskCompleted(supabase, task, {
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
  const attempts: Array<{ attempt: number; image_url: string; scene_brief: string; critique: VisualCritique; prompt_doc?: string }> = []
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
        realPhoto:   !!bg.raw.real_photo,
        ...critiqueContext(bg.raw),
      })
    } catch (e: any) {
      console.warn(`[seo-worker-visual] ${workerId} slide ${slideIndex + 1} eval threw — treating as pass: ${e?.message ?? e}`)
      critique = { passes: true, missing: [], issues: [], suggested_adjustment: '' } as VisualCritique
    }
    attempts.push({ attempt: a, image_url: bgUrl, scene_brief: baseBrief, critique, prompt_doc: typeof bg.raw.prompt_doc === 'string' ? bg.raw.prompt_doc : undefined })
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
  // visual-overlay accepts the service role only.
  const res = await fetch(`${SUPABASE_URL}/functions/v1/visual-overlay`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SERVICE_ROLE}`, apikey: SERVICE_ROLE },
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
  // Blocking quality issues — wrong wordmark/product name, wrong product,
  // physics defects. Any entry here fails the attempt.
  issues: string[]
  // Non-blocking notes the critic saw but must not fail on: the bag's fine
  // print (descriptor lines, address, URL), small flag/emblem details, soft
  // ambiguous background shapes. Image models can't render bag micro-text
  // reliably: of the 9 attempts for post 82937 on 2026-10-25, 6 were failed
  // over it and 3 over nothing else. So it's recorded for the reviewer instead.
  minor_issues?: string[]
  // One-sentence concrete suggestion for the next render's scene_brief.
  // Tail of the prompt: generative models weight the last lines more,
  // so this gets appended verbatim on the next attempt.
  suggested_adjustment: string
  _eval_error?: string  // only set when the eval call itself threw
}

const VISUAL_EVAL_SYSTEM_PROMPT = `You are a strict visual QA agent for Minuto's blog banner pipeline. Given a rendered image and the photographer's brief that produced it, decide whether the image satisfies the brief.

You are STRICT on subject completeness. If the brief named multiple concrete subjects (e.g. "espresso machine" AND "coffee bag"), all of them must appear in frame. Missing a named subject is a hard FAIL even if the image is otherwise beautiful.

The bag label has TWO tiers. Judge them differently.

TIER 1, the IDENTITY (STRICT): the "MINUTO" wordmark, the line "Café Roastery" directly beneath it, and the product name (the largest line of text after the wordmark, e.g. "Brazil Sertão", "Dark Chocolate"). These MUST be correct. If any of them is garbled, scrambled, misspelled, replaced by invented wording or another brand, or drawn in malformed glyphs (Latin OR Hebrew), that is a hard FAIL: a fabricated brand or product name misrepresents the product. Add a specific "issues" entry like "bag product name reads 'Brasil Sertoa'". The stag-head emblem is also tier 1, but only for being PRESENT and RECOGNISABLY A STAG HEAD: fail it only when it is missing, replaced by a different logo, or no longer reads as a stag head at all. A stag whose antlers or line-work are simplified, fuzzy or imperfect is tier 2. When the tier-1 elements are correct, the bag is correctly identified.

TIER 2, the FINE PRINT (NEVER A FAIL): everything on the label smaller than the product name. That is the descriptor / tasting-note lines, the address, the URL, weight, roast date, footer lines, any text inside the flag or origin band, plus the small graphic details: the exact shape of the flag (a missing diamond, a wrong stripe), the precise colour of the band, ornaments. Image models cannot render this reliably at this size, and on a blog banner it is a few pixels tall. Do NOT fail an image for it, whether it is soft OR sharp, readable or garbled, and do NOT put it in "issues" or "missing". Nor fail the bag for being in sharper focus than the brief asked, which only makes the fine print show. Record what you saw in "minor_issues" instead (e.g. "descriptor lines under the product name are garbled", "URL reads minute.co.il") so a human reviewer can see it. (Incidental background text is always exempt and needs no note.)

BAG COLOUR: when a photo of the real bag is attached, the rendered bag's body must be the same colour as in that photo. A white bag rendered clearly beige, cream, kraft, yellowed or grey is a FAIL; add an issue like "bag colour drifted from white to beige". Warm or cool light falling on a white bag, and its shadows, are not a colour change.

You are LENIENT on soft background props. Objects that are clearly out of focus in the background (blurred shelves, canisters, ceramics, windowsill items, wall décor) are set dressing, not what the brief's "no X" exclusions are about: do not fail an image or list an issue for them. The brief's exclusions apply in full to everything in focus: the subject, the props beside it and the surface it stands on. Even when soft, these still FAIL: any coffee bag, packaging or brand logo in a no_bag render; a second machine, roaster, kettle or grinder that is clearly identifiable as one; tea; anything physically impossible. A soft, dark or ambiguous shape that only "might be" an appliance is set dressing: note it in "minor_issues", do not fail.

You are STRICT on PHYSICAL REALISM. Judge the image the way a professional barista scrolling Instagram would: anything that could not exist in a real photo of a real cafe is a hard FAIL, even if the brief is otherwise satisfied. Check specifically:
  • Espresso machine anatomy — a steam wand, pipe or handle growing out of a group head or portafilter; more than one portafilter per group; parts floating, merged or attached to nothing; an invented panel, shield or cover (e.g. a translucent blue/green/white plate hanging beside the group head). Minuto's Strada X has clear glass ONLY as its large outer side window at the far end of the machine — never as a small piece next to the portafilter.
  • Liquid physics — coffee or milk coming from anywhere other than portafilter spouts or a hand-held pitcher; streams that miss the cup or defy gravity.
  • Espresso context — a portafilter is only ever locked into an espresso machine's group head. Espresso pouring from a portafilter with no machine body around it, a portafilter hovering over a table, or a cup being filled from a portafilter while it stands on a table or counter instead of the machine's drip-tray grate, is a hard FAIL (even if the brief asked for the cup "on a wood surface").
  • Support and gravity — every object rests on something or is held. A kettle, pitcher, portafilter, grinder, scoop or other tool floating in mid-air, or pouring with nothing holding it, is a hard FAIL. A tool being operated must be held the way a person would hold it: a hand-grinder crank turned while the grinder body is not gripped by the other hand, a kettle pouring with no hand on the handle.
  • Hands — wrong finger count, fused or boneless fingers, a hand holding nothing or merging into an object, or a disembodied hand or forearm that enters the frame at an angle no attached arm could reach from (e.g. a flat hand sliding in from the top edge). Hands must look like a real person standing just out of frame. Two hands must be one person's LEFT and RIGHT hand: two forearms entering side by side from the SAME edge, two left or two right hands, or arms whose angles could not meet at one pair of shoulders is a hard FAIL.
  • Objects — cups/pitchers with impossible handles, duplicated or melted props, objects intersecting each other.
  • Sharp, legible text anywhere in the scene (equipment plates, signs, cups) that is misspelled or garbled, e.g. "LA MAAZOCCO". Soft/out-of-focus background text is exempt. Text on the hero bag follows the two label tiers above, not this rule.
Name each defect concretely in "issues" (what and where), so the next render can avoid it.

You are LENIENT on stylistic interpretation. The brief specifies a mood / palette / composition; minor reinterpretation is fine. When the message starts with a SURFACE OVERRIDE, the surface material is out of scope: never fail or list an issue because the surface is not the material the brief names.

HANDS CHECK — whenever any hand is visible, do this BEFORE deciding: for each hand, say whether it is a LEFT or RIGHT hand (find the thumb: on a hand seen from the back, a right hand's thumb is on its left side and a left hand's on its right side, measured along the direction the fingers point), which frame edge its forearm enters from, and whether both hands could belong to one person. Write this in "hands_check". Two hands of the same side, or two forearms side by side from the same edge, is a hard FAIL.

Output STRICT JSON (no markdown fences, no preamble):
{
  "hands_check": "per-hand LEFT/RIGHT + entry edge + one-person verdict, or 'no hands'",
  "passes": true | false,
  "missing": ["concrete subject from the brief that didn't appear", "..."],
  "issues": ["blocking quality problems — wrong tier-1 label text, wrong product, physics defects, etc.", "..."],
  "minor_issues": ["non-blocking notes — tier-2 fine print, small graphic details, ambiguous soft background shapes", "..."],
  "suggested_adjustment": "one sentence telling the next render exactly what to include / fix"
}

"passes" depends ONLY on "missing" and "issues": if both are empty, passes=true, whatever "minor_issues" holds. If passes=true, suggested_adjustment should be an empty string.`

async function evaluateVisual(args: {
  imageUrl:    string
  sceneBrief:  string
  renderMode:  'no_bag' | 'bag_hero'
  productName?: string
  realPhoto?:  boolean
  // The real bag photo the renderer was given (visual-test's bag_url). When
  // present the label is judged against THIS, not against productName:
  // productName is the WooCommerce catalog title ("פולי קפה טרי 100% ערביקה
  // - Minuto Dark Chocolate"), which is not what the bag prints ("Dark
  // Chocolate"). Comparing to the title failed correct bags.
  bagRefUrl?:  string
  // The surface visual-test chose (pickSurface), which deliberately overrides
  // any surface the brief names — so the brief's surface must not be judged.
  surface?:    string
  // What the real bag's label prints (visual-test's bag_label_text), when the
  // bag has real photos. The Minuto lockup is always checked on bag renders.
  labelText?:  string[]
}): Promise<VisualCritique> {
  const bagRef = args.renderMode === 'bag_hero' && args.bagRefUrl ? args.bagRefUrl : undefined
  const userText = `${args.surface ? `SURFACE OVERRIDE: the renderer was ordered to place this scene on ${args.surface}, replacing any surface, table or counter material the brief below names. Ignore the brief's surface material completely: a surface that differs from the brief is CORRECT, never an issue and never missing.

` : ''}BRIEF (render_mode=${args.renderMode}${args.productName ? `, product_name="${args.productName}"` : ''}):

${args.sceneBrief}
${args.renderMode === 'bag_hero' && args.productName ? `
NOTE ON THE PRODUCT NAME: product_name above is the online-store catalog title, NOT the text printed on the bag. The real bag prints a shorter name (e.g. the catalog title "פולי קפה טרי 100% ערביקה - Minuto Dark Chocolate" is printed on the bag as just "Dark Chocolate"). Never fail the bag because it does not show the full catalog title.${bagRef ? ' The SECOND attached image is a photo of the REAL bag: judge the rendered label against THAT photo. Text that appears on the real bag is correct; fail only text that is garbled, misspelled, or not on the real bag.' : ''}
` : ''}${args.realPhoto ? `
NOTE: this image is an EDIT of a real photograph of Minuto's own bar/roastery (reframed and relit). The equipment, people, cups and existing signage/logos are REAL — do not fail it for how the real machine looks or for real, correctly-spelled signage, menu boards or cup logos that were in the photo, and do not require equipment details the brief describes differently. DO still fail anything added by the edit that is unrealistic (e.g. an impossible liquid stream, an invented bag or product, warped/duplicated equipment at the extended edges).
` : ''}
Evaluate the ${bagRef ? 'FIRST' : ''} attached image against this brief. Output strict JSON only.`

  const content = (withRef: boolean) => [
    { type: 'image' as const, source: { type: 'url' as const, url: args.imageUrl } },
    ...(withRef && bagRef ? [{ type: 'image' as const, source: { type: 'url' as const, url: bagRef } }] : []),
    { type: 'text' as const, text: withRef ? userText : userText.replace(/ The SECOND attached image[^\n]*/, '') },
  ]
  let res: Awaited<ReturnType<typeof callClaude>>
  try {
    res = await critic(content(true))
  } catch (e) {
    // A reference the API cannot fetch must not turn into "eval threw →
    // treated as pass" upstream: retry once judging the render alone.
    if (!bagRef) throw e
    console.warn(`[seo-worker-visual] eval with bag reference failed, retrying without it: ${e instanceof Error ? e.message : String(e)}`)
    res = await critic(content(false))
  }

  const parsed = parseClaudeJson<{
    passes?: unknown
    missing?: unknown
    issues?: unknown
    minor_issues?: unknown
    suggested_adjustment?: unknown
  }>(res.text)

  const missing      = Array.isArray(parsed.missing)      ? parsed.missing.map(String)      : []
  const issues       = Array.isArray(parsed.issues)       ? parsed.issues.map(String)       : []
  const minorIssues  = Array.isArray(parsed.minor_issues) ? parsed.minor_issues.map(String) : []
  const critique: VisualCritique = {
    // A fail whose only reasons are minor_issues is a pass: the prompt says
    // they never block, so a "false" with nothing blocking is the critic
    // contradicting itself. A bare false with no reasons at all stands.
    passes:               parsed.passes === true || (missing.length === 0 && issues.length === 0 && minorIssues.length > 0),
    missing,
    issues,
    minor_issues:         minorIssues,
    suggested_adjustment: typeof parsed.suggested_adjustment === 'string' ? parsed.suggested_adjustment : '',
  }
  // Only worth a call when the critic passed: a failed attempt retries anyway.
  if (critique.passes && args.renderMode === 'bag_hero' && !args.realPhoto) await applyLabelCheck(critique, args.imageUrl, [...BAG_LOCKUP_TEXT, ...(args.labelText ?? [])])
  return critique
}

// Spell-check the rendered label (see _shared/bag_label_check.ts). A near miss
// fails the attempt so the QA loop re-renders it; text the model cannot read
// is skipped. Fails open: if the transcription call errors, the critic's
// verdict stands.
async function applyLabelCheck(critique: VisualCritique, imageUrl: string, expected: string[]): Promise<void> {
  try {
    const res = await callClaude({
      sourceFn:    'seo-worker-visual',
      model:       MODEL_VISUAL_CRITIC,
      system:      LABEL_TRANSCRIBE_PROMPT,
      messages:    [{ role: 'user', content: [
        { type: 'image', source: { type: 'url', url: imageUrl } },
        { type: 'text', text: 'Transcribe the bag label. Output strict JSON only.' },
      ] }],
      maxTokens:   300,
      temperature: 0.0,
      timeoutMs:   60_000,
    })
    const t = parseClaudeJson<Partial<LabelTranscript>>(res.text)
    const check = checkLabelText({ bag_visible: t.bag_visible === true, lines: Array.isArray(t.lines) ? t.lines.map(String) : [] }, expected)
    if (check.ok) return
    critique.passes = false
    for (const m of check.misspelled) critique.issues.push(`bag label misspelled: reads "${m.found}" instead of "${m.expected}"`)
    if (!critique.suggested_adjustment) critique.suggested_adjustment = `Render the bag label exactly as in the reference: ${check.misspelled.map(m => `"${m.expected}"`).join(', ')}.`
  } catch (e) {
    console.warn(`[seo-worker-visual] label check failed, keeping the critic's verdict: ${e instanceof Error ? e.message : String(e)}`)
  }
}

function critic(content: MessageContentBlock[]) {
  return callClaude({
    sourceFn: 'seo-worker-visual',
    // SELF-CRITIQUE BLIND SPOT — watch this one. The image is GENERATED by
    // Gemini (vertex-imagen-edit / visual-test, both already 100% Gemini).
    // Today a different vendor judges it, which is a large part of why this
    // loop catches anything at all. Pointing this slot at Gemini makes the
    // same family both author and grader. Before trusting a quality jump,
    // compare the first-attempt passes:true rate against the Claude baseline:
    // a sharp rise is at least as likely to mean a lenient judge as a better
    // image, and 11 visual_style/render_strategy learnings came from this loop.
    model:  MODEL_VISUAL_CRITIC,
    system: VISUAL_EVAL_SYSTEM_PROMPT,
    messages: [{ role: 'user', content }],
    maxTokens:   600,
    temperature: 0.0,
    // Opus 5.5 always thinks, and the HANDS CHECK makes it reason before the
    // verdict: 60 s aborted real calls, and an aborted eval counts as a PASS
    // upstream. 120 s keeps a 3-attempt loop inside the worker's wall clock.
    timeoutMs:   120_000,
  })
}

// What the renderer actually used, from visual-test's response, so the critic
// judges the image against that rather than against brief text the renderer
// was told to override. The surface is only passed when visual-test says it
// overrode the brief (not for studio/props-free briefs, not for real photos).
function critiqueContext(raw: Record<string, unknown>): { bagRefUrl?: string; surface?: string; labelText?: string[] } {
  return {
    labelText: Array.isArray(raw.bag_label_text) ? raw.bag_label_text.map(String) : undefined,
    bagRefUrl: raw.used_reference === true && typeof raw.bag_url === 'string' ? raw.bag_url : undefined,
    surface:   raw.surface_overrides_brief === true && !raw.real_photo && typeof raw.surface === 'string' ? raw.surface : undefined,
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
    // Only the bag ban is unconditional — see no_bag_tail.ts for the bug the
    // old fixed tail caused (an espresso machine forced into every brief).
    return `${stripped}\n\n${noBagTail(stripped)}`
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
    sourceFn:    'seo-worker-visual',
    model:       MODEL_VISUAL_CRITIC,
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
