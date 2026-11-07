// Minuto Strategist Brain — Phase 2 executor (hands, draft-only).
//
// Claims APPROVED strategic_recommendations and turns them into DRAFTED work in
// the EXISTING pipelines — it never sends or publishes. By action_type:
//   • content_blog  → a text_generation seo_task (Writer Worker → WP draft → review)
//   • content_ig    → a visual_generation + instagram_post pair (IG worker →
//                     queue_for_review; nothing goes live without admin)
//   • email_campaign→ invokes the existing `generate-campaign` (action 'generate')
//                     which writes a campaigns row status='draft'. The human sends
//                     it from the marketing UI (picking the rfm_<segment> audience).
//
// Reuses the seo_tasks queue + Writer/Visual/IG workers + generate-campaign
// wholesale — lean glue, not a second orchestrator. Cron-polled; idle + cheap
// when nothing is approved.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createSupabase, insertTasks } from '../seo-agent/db.ts'
import { validateNewTask } from '../seo-agent/taskValidation.ts'
import { isServiceCaller, unauthorized } from '../_shared/service_caller.ts'
import { runLogged } from '../_shared/run_logged.ts'
import { claimRecs, finishRec, sweepStaleDrafting } from './ledger.ts'
import { checkBlogProducts } from '../_shared/blog_products.ts'
import { fetchMinutoCoffeeCatalog } from '../seo-agent/services/cmsApi.ts'
import type { NewSeoTask, RecommendationRow, TextGenerationBrief, InstagramPostBrief, VisualGenerationBrief, StrategistLoopFields } from '../seo-agent/types.ts'
import { callClaude, parseClaudeJson, MODEL_CAMPAIGN } from '../seo-agent/claude.ts'
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.116.0'
import { applyPlannedShot } from '../_shared/shot_library.ts'
import { ASYNC_DRAFT_HOURS, critiqueOn, LOOP_IMPLEMENTED, readLoopConfig, type LoopConfig } from '../_shared/strategist_loop.ts'
import { claimLoopRows, finishLoopRow, sweepStaleLoop } from '../_shared/strategist_loop_ledger.ts'
import { callLoopAds } from '../_shared/loop_ads_client.ts'
import { checkBlogKeywordLive } from '../_shared/keyword_research.ts'
import { checkCannibalizationForQueue } from '../seo-agent/cannibalizationCheck.ts'
import { GOOGLE_SEARCH_SPEC_SYSTEM, googleSearchSpecProblems } from '../_shared/google_search_spec.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const COFFEEFLOW_USER_ID = Deno.env.get('COFFEEFLOW_USER_ID') ?? ''

const BATCH = 5

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
}

// All three action types now draft (Phase 2b). 'none' is pure advice — skipped.
// ad_meta / ad_google run ONLY through the review loop (draftRec has no non-loop path).
const SUPPORTED: RecommendationRow['action_type'][] = ['content_blog', 'content_ig', 'email_campaign', 'ad_meta', 'ad_google']

const runIdOf = (rec: RecommendationRow) => rec.run_id ?? rec.id

// ── content_blog → text_generation task ──────────────────────────────────────
function blogBrief(rec: RecommendationRow): TextGenerationBrief {
  const p = rec.action_params ?? {}
  const keyword = (p.keyword as string) || (p.topic as string) || rec.title
  return {
    keyword,
    title:               (p.topic as string) || (p.keyword as string) || rec.title,
    key_points:          Array.isArray(p.key_points) ? (p.key_points as string[]) : [],
    products_to_mention: Array.isArray(p.products) ? (p.products as string[]) : [],
    why_now:             (p.why_now as string) || rec.rationale || undefined,
  }
}

async function draftBlog(supabase: SupabaseClient, rec: RecommendationRow, loop?: StrategistLoopFields): Promise<string> {
  // Re-checked here: the catalog can change between the brief and the approval.
  const lineup = (await fetchMinutoCoffeeCatalog(supabase)).map(p => p.name)
  const chk = checkBlogProducts(rec.action_params?.products, lineup)
  if (!chk.ok) throw new Error(`content_blog products: ${chk.error}`)
  // Re-checked here too: a post can appear between the proposal and now.
  // Strict: not in our research, a conflicting post, or an unverifiable check
  // all stop the draft (the rec fails with the reason; nothing is written).
  const gate = await checkBlogKeywordLive(supabase, rec.action_params as Record<string, unknown>, String(rec.action_params?.topic ?? rec.title), checkCannibalizationForQueue)
  if (!gate.ok) throw new Error(`content_blog keyword blocked: ${gate.reason}`)
  const brief: TextGenerationBrief = { ...blogBrief(rec), products_to_mention: chk.products, ...(loop ?? {}) }
  const task: NewSeoTask = {
    task_type:           'text_generation',
    brief_data:          brief,
    rationale:           `[strategist] ${rec.title}`,
    orchestrator_run_id: runIdOf(rec),
  }
  const [inserted] = await insertTasks(supabase, [task])
  if (!inserted) throw new Error('insertTasks returned no row')
  return `task:${inserted.id}`
}

// ── content_ig → visual_generation (parent) + instagram_post (child) ─────────
// The IG worker HARD-REQUIRES a parent visual task, so we emit the visual first,
// then the post pointing at it. Everything stays queue_for_review.
interface IgLoopOptions extends StrategistLoopFields {
  caption_he?:         string   // revised caption
  scene_brief?:        string   // revised scene (only when re-rendering)
  reuse_visual_task?:  string   // revision that keeps the image: no new render
}

async function draftIg(supabase: SupabaseClient, rec: RecommendationRow, loop?: IgLoopOptions): Promise<string> {
  const p: Record<string, any> = { ...(rec.action_params ?? {}), ...(loop?.caption_he ? { caption_he: loop.caption_he } : {}), ...(loop?.scene_brief ? { scene_brief: loop.scene_brief } : {}) }
  // Caption first (docs/image-pipeline/plan.md): no caption, nothing to draft,
  // so check before the visual is inserted rather than orphaning it.
  const caption = typeof p.caption_he === 'string' ? p.caption_he.trim() : ''
  if (!caption) throw new Error('content_ig recommendation missing caption_he')
  const mediaType = ((p.media_type as string) || 'feed_image') as InstagramPostBrief['media_type']
  const isStory = mediaType === 'story'
  const aspect = ((p.aspect as string) || (isStory ? 'story' : 'feed_square')) as VisualGenerationBrief['aspect']
  // bag_hero needs an exact product name; fall back to no_bag if missing.
  const wantsBag = (p.render_mode as string) === 'bag_hero' && typeof p.product_name === 'string' && (p.product_name as string).length > 0
  const renderMode: VisualGenerationBrief['render_mode'] = wantsBag ? 'bag_hero' : 'no_bag'

  // The brain picks a shot from the menu for its caption. The pick fixes
  // render_mode / product_name and, when scene_brief is empty, writes one from
  // the shot. Flag off: kept as planned_shot, rendered on the legacy path.
  const picked = applyPlannedShot({
    scene_brief: typeof p.scene_brief === 'string' ? p.scene_brief : '',
    aspect,
    render_mode: renderMode,
    destination: 'ig_post',
    ...(typeof p.product_name === 'string' && p.product_name ? { product_name: p.product_name } : {}),
    shot_type:  p.shot_type,
    shot_slots: p.shot_slots,
  }, { enabled: Deno.env.get('SHOT_LIBRARY_ENABLED') === 'true', caption })
  if (picked.note) console.warn(`[strategist-executor] rec ${rec.id} shot pick repaired: ${picked.note}`)
  const visualBrief = picked.brief as unknown as VisualGenerationBrief
  if (!visualBrief.scene_brief) {
    visualBrief.scene_brief = `Editorial Minuto specialty-coffee scene for: ${(p.topic as string) || rec.title}. Warm natural light, shallow depth of field, the locked Minuto visual identity.`
  }
  // Legacy no_bag brief (no shot picked): no product, as before.
  if (visualBrief.render_mode === 'no_bag' && !picked.picked) delete visualBrief.product_name

  // Build and check the post BEFORE inserting the visual, so a post the IG
  // worker would reject (e.g. media_type "reel") can't orphan a visual that
  // still renders. Its parent is the visual inserted just below.
  const igBrief: InstagramPostBrief = {
    caption_he:       caption,
    hashtags:         Array.isArray(p.hashtags) ? (p.hashtags as string[]) : [],
    media_type:       mediaType,
    publish_strategy: 'queue_for_review',
    ...(loop ? { strategist_rec_id: loop.strategist_rec_id, hold_for_critique: loop.hold_for_critique, revision: loop.revision } : {}),
  }
  const igProblems = validateNewTask(
    { task_type: 'instagram_post', brief_data: igBrief, rationale: '', orchestrator_run_id: '' },
    { parentLinkedLater: true },
  )
  if (igProblems.length > 0) throw new Error(`content_ig post brief rejected: ${igProblems.join('; ')}`)

  let visual: { id: string } | undefined
  if (loop?.reuse_visual_task) {
    visual = { id: loop.reuse_visual_task }
  } else {
    ;[visual] = await insertTasks(supabase, [{
      task_type:           'visual_generation',
      brief_data:          visualBrief,
      rationale:           `[strategist] visual for: ${rec.title}`,
      orchestrator_run_id: runIdOf(rec),
    }])
  }
  if (!visual) throw new Error('visual_generation insert returned no row')

  const [ig] = await insertTasks(supabase, [{
    task_type:           'instagram_post',
    brief_data:          igBrief,
    rationale:           `[strategist] ${rec.title}`,
    orchestrator_run_id: runIdOf(rec),
    parent_task_id:      visual.id,
  }])
  if (!ig) throw new Error('instagram_post insert returned no row')
  return `task:${ig.id}`
}

// ── email_campaign → reuse generate-campaign (draft only, never send) ─────────
function emailInstructions(rec: RecommendationRow): string {
  const p = rec.action_params ?? {}
  const products = Array.isArray(p.products) ? (p.products as string[]) : []
  // generate-campaign writes the AI copy + HTML + draft row from free-text
  // instructions; we hand it the strategist's angle, subject, products + audience.
  const instructions = [
    (p.angle as string) || rec.rationale || rec.title,
    p.subject_he ? `Preferred Hebrew subject: ${p.subject_he}` : '',
    products.length ? `Feature these Minuto products: ${products.join(', ')}.` : '',
    p.target_segment ? `Audience: the "${p.target_segment}" customer segment.` : '',
  ].filter(Boolean).join('\n')
  return instructions
}

async function callGenerateCampaign(instructions: string, persist: boolean): Promise<string> {
  if (!COFFEEFLOW_USER_ID) throw new Error('COFFEEFLOW_USER_ID not set — cannot draft a campaign')
  const res = await fetch(`${SUPABASE_URL}/functions/v1/generate-campaign`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${SERVICE_ROLE}`, 'apikey': SERVICE_ROLE, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'generate', userId: COFFEEFLOW_USER_ID, campaignType: 'strategist', customInstructions: instructions, persist }),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`generate-campaign ${res.status}: ${text.slice(0, 300)}`)
  return text
}

async function draftEmail(rec: RecommendationRow): Promise<string> {
  const text = await callGenerateCampaign(emailInstructions(rec), true)
  let id: unknown
  try { id = JSON.parse(text)?.campaign?.id } catch { /* fall through */ }
  if (id == null) throw new Error(`generate-campaign returned no campaign id: ${text.slice(0, 200)}`)
  return `campaign:${id}`
}

async function draftRec(supabase: SupabaseClient, rec: RecommendationRow, workerId: string): Promise<{ id: string; status: string; draft_ref?: string; error?: string }> {
  let draftRef: string
  try {
    switch (rec.action_type) {
      case 'content_blog':   draftRef = await draftBlog(supabase, rec); break
      case 'content_ig':     draftRef = await draftIg(supabase, rec); break
      case 'email_campaign': draftRef = await draftEmail(rec); break
      default:               throw new Error(`action_type ${rec.action_type} not executable`)
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const notRecorded = await finishRec(supabase, rec.id, workerId, { status: 'failed', draft_error: msg.slice(0, 1000) })
    if (notRecorded) console.error(`[strategist-executor] ${rec.id} failed (${msg}) but the failure was not recorded: ${notRecorded}`)
    return { id: rec.id, status: 'failed', error: msg }
  }
  // The draft exists now. If recording it fails the row stays 'drafting' (never
  // re-claimed) and the sweep later flags it, so it is not drafted twice.
  const notRecorded = await finishRec(supabase, rec.id, workerId, { status: 'drafted', draft_ref: draftRef, draft_error: null })
  if (notRecorded) {
    console.error(`[strategist-executor] ${rec.id} drafted as ${draftRef} but not recorded: ${notRecorded}`)
    return { id: rec.id, status: 'drafted_unrecorded', draft_ref: draftRef, error: notRecorded }
  }
  return { id: rec.id, status: 'drafted', draft_ref: draftRef }
}

// ── Closed loop (docs/plans/2026-11-02-strategist-closed-loop.md) ────────────
// For action types with the critic on, a draft is produced WITHOUT leaving
// CoffeeFlow, kept in artifact_snapshot for the critic, and exported only after
// it passes (or Erez sends a needs_human draft on anyway).

/** The revision request appended to a drafter's instructions. */
function revisionNote(rec: RecommendationRow): string {
  if (!rec.last_feedback) return ''
  const prev = rec.artifact_snapshot ? JSON.stringify(rec.artifact_snapshot).slice(0, 6000) : '(not kept)'
  return `\n\nREVISION ${rec.revision_count ?? 1}: a reviewer rejected the previous draft. Write a new draft that fixes every point below and keeps what was not criticised.\nREVIEWER FEEDBACK:\n${rec.last_feedback}\nPREVIOUS DRAFT:\n${prev}`
}

async function snapshotEmail(rec: RecommendationRow): Promise<Record<string, unknown>> {
  const text = await callGenerateCampaign(emailInstructions(rec) + revisionNote(rec), false)
  let campaign: Record<string, unknown> | null = null
  try { campaign = JSON.parse(text)?.campaign ?? null } catch { /* fall through */ }
  if (!campaign || typeof campaign.subject !== 'string' || typeof campaign.body !== 'string') {
    throw new Error(`generate-campaign (persist:false) returned no draft: ${text.slice(0, 200)}`)
  }
  return { kind: 'email', ...campaign }
}

// ── ad_meta: PAUSED Meta campaign, built by marketing-advisor's Meta builder ──
// The spec is drafted and critiqued inside CoffeeFlow; nothing reaches Meta
// until the critic passes it, and then only as a PAUSED campaign created via
// callLoopAds (create only). Only Erez activates it, in Ads Manager.
async function snapshotMetaAd(supabase: SupabaseClient, rec: RecommendationRow): Promise<Record<string, unknown>> {
  const p = (rec.action_params ?? {}) as Record<string, any>
  const product = typeof p.product === 'string' ? p.product.trim() : ''
  if (!product) throw new Error('ad_meta recommendation needs action_params.product (an exact Minuto coffee name)')
  // Real product photo: the ad shows the actual sealed bag, never a generated one.
  const catalog = await fetchMinutoCoffeeCatalog(supabase)
  const hit = catalog.find(c => c.name === product)
  if (!hit) throw new Error(`ad_meta product "${product}" is not in the Minuto coffee catalog`)
  if (hit.stock_status !== 'instock') throw new Error(`ad_meta product "${product}" is out of stock`)
  if (!hit.image_url) throw new Error(`ad_meta product "${product}" has no image in woo_products`)
  const idea = [
    `${rec.title}. ${rec.rationale ?? ''}`,
    p.angle ? `Angle: ${p.angle}` : '',
    `Product: ${product} (${hit.permalink ?? ''})`,
    p.audience ? `Audience: ${p.audience}` : '',
  ].filter(Boolean).join('\n') + revisionNote(rec)
  const res = await fetch(`${SUPABASE_URL}/functions/v1/marketing-advisor`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SERVICE_ROLE}`, apikey: SERVICE_ROLE },
    body: JSON.stringify({
      agent: 'build_meta_campaign', idea,
      ...(p.daily_budget_ils != null ? { daily_budget_ils: Number(p.daily_budget_ils) } : {}),
      ...(p.duration_days != null ? { duration_days: Number(p.duration_days) } : {}),
      ...(p.objective ? { objective_override: String(p.objective) } : {}),
    }),
  })
  const out = await res.json().catch(() => ({})) as { success?: boolean; spec?: Record<string, unknown>; error?: string }
  if (!res.ok || !out.success || !out.spec || typeof out.spec !== 'object') {
    throw new Error(`build_meta_campaign failed (${res.status}): ${out.error ?? 'no spec'}`)
  }
  return { kind: 'ad_meta', spec: out.spec, image_url: hit.image_url, product, product_url: hit.permalink ?? null }
}

// ── ad_google: PAUSED Google SEARCH campaign ─────────────────────────────────
// No Google spec builder exists outside the chat, so the executor writes the
// spec (one Claude call), checks Google's limits locally, then asks Google to
// validate it (validate_only: Google writes nothing). One rebuild with the
// error before giving up. Created only after the critic passes it.
async function snapshotGoogleAd(supabase: SupabaseClient, rec: RecommendationRow): Promise<Record<string, unknown>> {
  const p = (rec.action_params ?? {}) as Record<string, any>
  const keywords = Array.isArray(p.keywords) ? p.keywords.filter((k: unknown) => typeof k === 'string' && k.trim()) : []
  if (keywords.length === 0) throw new Error('ad_google recommendation needs action_params.keywords (grounded in search terms / GSC)')
  let landing = typeof p.landing_url === 'string' ? p.landing_url : ''
  if (typeof p.product === 'string' && p.product.trim()) {
    const hit = (await fetchMinutoCoffeeCatalog(supabase)).find(c => c.name === p.product.trim())
    if (!hit) throw new Error(`ad_google product "${p.product}" is not in the Minuto coffee catalog`)
    if (hit.stock_status !== 'instock') throw new Error(`ad_google product "${p.product}" is out of stock`)
    landing = hit.permalink ?? landing
  }
  if (!landing) throw new Error('ad_google recommendation needs action_params.product or landing_url')
  const brief = [
    `Brief: ${rec.title}. ${rec.rationale ?? ''}`,
    p.angle ? `Angle: ${p.angle}` : '',
    `Keywords: ${keywords.join(', ')}`,
    `Landing URL: ${landing}`,
    `Daily budget ILS: ${p.daily_budget_ils ?? 40}. Duration days: ${p.duration_days ?? 14}.`,
  ].filter(Boolean).join('\n') + revisionNote(rec)
  let lastError = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await callClaude({
      sourceFn: 'strategist-executor', runId: rec.run_id, model: MODEL_CAMPAIGN,
      system: GOOGLE_SEARCH_SPEC_SYSTEM,
      messages: [{ role: 'user', content: brief + (lastError ? `\n\nYOUR PREVIOUS SPEC WAS REJECTED. Fix exactly this:\n${lastError}` : '') }],
      maxTokens: 3000, timeoutMs: 60_000,
    })
    let spec: Record<string, unknown>
    try { spec = parseClaudeJson<Record<string, unknown>>(res.text) } catch { lastError = 'output was not valid JSON'; continue }
    spec.campaign_type = 'search'
    const local = googleSearchSpecProblems(spec)
    if (local.length) { lastError = local.join('; '); continue }
    try {
      await callLoopAds({ supabaseUrl: SUPABASE_URL, serviceKey: SERVICE_ROLE }, 'google', 'create',
        { idea_id: `srec:${rec.id}`, spec, validate_only: true })
    } catch (e) { lastError = e instanceof Error ? e.message : String(e); continue }
    return { kind: 'ad_google', spec, keywords, landing_url: landing }
  }
  throw new Error(`ad_google spec not valid after 2 attempts: ${lastError.slice(0, 600)}`)
}

/** Produce a draft for the critic. Synchronous drafters return the snapshot;
 *  async ones (blog/IG, later) enqueue a job and return null. */
/** The loop flags every strategist brief carries while it is under review. */
function loopFields(rec: RecommendationRow): StrategistLoopFields {
  return {
    strategist_rec_id: rec.id,
    hold_for_critique: true,
    ...(rec.last_feedback ? { revision: { feedback: rec.last_feedback, previous: rec.artifact_snapshot ?? undefined, number: rec.revision_count ?? 1 } } : {}),
  }
}

/** Rewrite an IG caption (and, if the image itself was criticised, the scene)
 *  from the critic's feedback. The caption comes from the brain, not a worker,
 *  so the executor is the drafter that revises it. */
async function reviseIg(rec: RecommendationRow): Promise<IgLoopOptions> {
  const prev = (rec.artifact_snapshot ?? {}) as Record<string, any>
  const res = await callClaude({
    sourceFn:  'strategist-executor',
    runId:     rec.run_id,
    model:     MODEL_CAMPAIGN,
    system:    'You revise Instagram posts for Minuto Coffee (מינוטו קפה בית קלייה ספיישלטי), a specialty roaster that roasts weekly. Hebrew, warm, specific, gender-inclusive, no em-dashes, never mention competitors, never invent product facts. Fix exactly what the reviewer asked and keep the rest. Return JSON only: {"caption_he": string, "rerender_image": boolean, "scene_brief": string}. rerender_image is true ONLY if the feedback criticises the image itself; then scene_brief describes the new scene in English, otherwise scene_brief is "".',
    messages:  [{ role: 'user', content: `Brief: ${rec.title}\nRationale: ${rec.rationale ?? ''}\nPrevious caption:\n${prev.caption_he ?? rec.action_params?.caption_he ?? ''}\nPrevious scene: ${rec.action_params?.scene_brief ?? '(from shot library)'}\n\nREVIEWER FEEDBACK:\n${rec.last_feedback ?? ''}` }],
    maxTokens: 2000,
    timeoutMs: 60_000,
  })
  const out = parseClaudeJson<{ caption_he?: string; rerender_image?: boolean; scene_brief?: string }>(res.text)
  const caption = typeof out.caption_he === 'string' ? out.caption_he.trim() : ''
  if (!caption) throw new Error('IG reviser returned no caption')
  const rerender = out.rerender_image === true || !prev.visual_task_id
  return {
    caption_he: caption,
    ...(rerender ? { scene_brief: typeof out.scene_brief === 'string' && out.scene_brief.trim() ? out.scene_brief.trim() : undefined } : { reuse_visual_task: String(prev.visual_task_id) }),
  }
}

/** An async drafter (writer / IG worker) now owns the draft: keep the rec in
 *  'drafting' under the task's id with a long lock, until the worker hands it
 *  back (handBackForCritique) or the sweep fails it after ASYNC_DRAFT_HOURS.
 *  finishRec would clear the lock, hence a dedicated fenced update. */
async function holdForAsyncDraft(supabase: SupabaseClient, recId: string, workerId: string, taskRef: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('strategic_recommendations')
    .update({ worker_id: `async:${taskRef}`, locked_until: new Date(Date.now() + ASYNC_DRAFT_HOURS * 3600_000).toISOString(), draft_ref: taskRef, draft_error: null, updated_at: new Date().toISOString() })
    .eq('id', recId)
    .eq('status', 'drafting')
    .eq('worker_id', workerId)
    .select('id')
    .maybeSingle()
  if (error) return error.message
  if (data) return null
  // The worker may already have finished and handed the draft back (normally
  // impossible: workers poll every 5 minutes, but cheap to tolerate).
  const { data: now } = await supabase.from('strategic_recommendations').select('status').eq('id', recId).maybeSingle()
  return now?.status === 'awaiting_critique' ? null : 'row is no longer held by this worker'
}

async function draftForCritique(supabase: SupabaseClient, rec: RecommendationRow, workerId: string): Promise<{ id: string; status: string; error?: string }> {
  let snapshot: Record<string, unknown> | null = null
  let asyncTask: string | null = null
  try {
    switch (rec.action_type) {
      case 'email_campaign': snapshot = await snapshotEmail(rec); break
      case 'ad_meta':        snapshot = await snapshotMetaAd(supabase, rec); break
      case 'ad_google':      snapshot = await snapshotGoogleAd(supabase, rec); break
      case 'content_blog':   asyncTask = await draftBlog(supabase, rec, loopFields(rec)); break
      case 'content_ig':     asyncTask = await draftIg(supabase, rec, { ...loopFields(rec), ...(rec.last_feedback ? await reviseIg(rec) : {}) }); break
      default: throw new Error(`action_type ${rec.action_type} has no closed-loop drafter`)
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const notRecorded = await finishRec(supabase, rec.id, workerId, { status: 'failed', draft_error: msg.slice(0, 1000) })
    if (notRecorded) console.error(`[strategist-executor] ${rec.id} loop draft failed (${msg}) and was not recorded: ${notRecorded}`)
    return { id: rec.id, status: 'failed', error: msg }
  }
  if (asyncTask) {
    const notHeld = await holdForAsyncDraft(supabase, rec.id, workerId, asyncTask)
    if (notHeld) return { id: rec.id, status: 'unrecorded', error: notHeld }
    return { id: rec.id, status: 'drafting_async' }
  }
  // worker_id NULL = unclaimed for the critic.
  const notRecorded = await finishRec(supabase, rec.id, workerId, { status: 'awaiting_critique', artifact_snapshot: snapshot, worker_id: null, draft_error: null })
  if (notRecorded) return { id: rec.id, status: 'unrecorded', error: notRecorded }
  return { id: rec.id, status: 'awaiting_critique' }
}

async function exportEmail(supabase: SupabaseClient, rec: RecommendationRow): Promise<string> {
  const c = (rec.artifact_snapshot ?? {}) as Record<string, any>
  if (!COFFEEFLOW_USER_ID) throw new Error('COFFEEFLOW_USER_ID not set — cannot write the campaign draft')
  const { data, error } = await supabase.from('campaigns').insert({
    user_id:       COFFEEFLOW_USER_ID,
    channel:       'email',
    subject:       c.subject,
    message:       c.body,
    html_content:  c.htmlContent,
    status:        'draft',   // never sent from here: Erez sends it from the marketing UI
    campaign_type: c.campaignType || 'strategist',
    product_ids:   Array.isArray(c.productIds) ? c.productIds : [],
    preheader:     c.preheader,
    cta_text:      c.ctaText,
    cta_url:       c.ctaUrl,
  }).select('id').single()
  if (error || !data) throw new Error(`campaigns insert failed: ${error?.message ?? 'no row'}`)
  return `campaign:${data.id}`
}

async function exportBlog(supabase: SupabaseClient, rec: RecommendationRow): Promise<string> {
  const d = (rec.artifact_snapshot ?? {}) as Record<string, any>
  if (!d.title || !d.body) throw new Error('blog snapshot has no title/body')
  const res = await fetch(`${SUPABASE_URL}/functions/v1/blog-publish`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SERVICE_ROLE}`, apikey: SERVICE_ROLE },
    // Same body the writer sends. status 'draft': Erez publishes in WP admin.
    body: JSON.stringify({ title: d.title, content_markdown: d.body, slug: d.slug ?? undefined, excerpt: d.meta_description ?? '', status: 'draft' }),
  })
  const pub = await res.json().catch(() => ({})) as { ok?: boolean; id?: number; edit_url?: string; link?: string; error?: string; warnings?: string[] }
  if (!res.ok || !pub.ok || !pub.id) throw new Error(`blog-publish failed HTTP ${res.status}: ${pub.error ?? '(no error body)'}`)
  // Best-effort: show the WP draft on the writer task too.
  if (d.task_id) {
    const { data: t } = await supabase.from('seo_tasks').select('result_data').eq('id', d.task_id).maybeSingle()
    await supabase.from('seo_tasks').update({ result_data: { ...(t?.result_data ?? {}), wp_post_id: pub.id, edit_url: pub.edit_url, link: pub.link, exported_by_loop_at: new Date().toISOString() } }).eq('id', d.task_id)
  }
  return `wp:${pub.id}`
}

async function exportIg(supabase: SupabaseClient, rec: RecommendationRow): Promise<string> {
  const d = (rec.artifact_snapshot ?? {}) as Record<string, any>
  if (!d.ig_task_id || !d.caption || !d.meta_type) throw new Error('ig snapshot incomplete (ig_task_id / caption / meta_type)')
  // The same 'prepare' the IG worker sends: stages a container for review.
  // Nothing goes live here; Erez publishes from the review queue.
  const metaBody: Record<string, unknown> = {
    action: 'prepare',
    type: d.meta_type,
    caption: d.meta_type === 'story' ? String(d.caption).replace(/\n#[^\n]+$/, '').trim() : d.caption,
  }
  if (Array.isArray(d.carousel_children) && d.carousel_children.length) metaBody.children = d.carousel_children.map((u: string) => ({ image_url: u }))
  else if (d.image_url) metaBody.image_url = d.image_url
  else throw new Error('ig snapshot has no image')
  const res = await fetch(`${SUPABASE_URL}/functions/v1/meta-publish`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SERVICE_ROLE}`, apikey: SERVICE_ROLE },
    body: JSON.stringify(metaBody),
  })
  const meta = await res.json().catch(() => ({})) as Record<string, unknown>
  if (!res.ok) throw new Error(`meta-publish prepare HTTP ${res.status}: ${(meta.error as string) ?? JSON.stringify(meta).slice(0, 300)}`)
  // Put the staged post in the existing review queue (SeoTaskQueue / inbox).
  const { data: t } = await supabase.from('seo_tasks').select('result_data').eq('id', d.ig_task_id).maybeSingle()
  const { error } = await supabase.from('seo_tasks').update({ result_data: {
    ...(t?.result_data ?? {}),
    held_for_critique: false, exported_by_loop_at: new Date().toISOString(), prepared_at: new Date().toISOString(),
    meta_action: 'prepare', meta_response: meta, review_required: true,
    ig_creation_id: (meta.creation_id as string | undefined) ?? null,
  } }).eq('id', d.ig_task_id)
  if (error) throw new Error(`container ${meta.creation_id} staged but the review task was not updated: ${error.message}`)
  return `task:${d.ig_task_id}`
}

async function exportMetaAd(rec: RecommendationRow): Promise<string> {
  const d = (rec.artifact_snapshot ?? {}) as Record<string, any>
  if (!d.spec || !d.image_url) throw new Error('ad_meta snapshot has no spec / image')
  // create = a NEW campaign, created PAUSED by meta-ads-draft, under its budget
  // guards. idea_id makes a repeated export return the same campaign.
  const out = await callLoopAds({ supabaseUrl: SUPABASE_URL, serviceKey: SERVICE_ROLE }, 'meta', 'create',
    { idea_id: `srec:${rec.id}`, spec: d.spec, image_url: d.image_url })
  const id = out.campaign_id
  if (id == null || id === '') throw new Error('meta-ads-draft returned no campaign_id')
  return `meta_ad:${id}`
}

async function exportGoogleAd(rec: RecommendationRow): Promise<string> {
  const d = (rec.artifact_snapshot ?? {}) as Record<string, any>
  const problems = googleSearchSpecProblems(d.spec)
  if (problems.length) throw new Error(`ad_google snapshot spec invalid: ${problems.join('; ')}`)
  // create = a NEW campaign, created PAUSED by google-ads-draft after its claim
  // and budget guards. Same idea_id returns the existing campaign on a retry.
  const out = await callLoopAds({ supabaseUrl: SUPABASE_URL, serviceKey: SERVICE_ROLE }, 'google', 'create',
    { idea_id: `srec:${rec.id}`, spec: d.spec })
  const id = out.campaign_id
  if (id == null || id === '') throw new Error('google-ads-draft returned no campaign_id')
  return `google_ad:${id}`
}

async function exportRec(supabase: SupabaseClient, rec: RecommendationRow, workerId: string): Promise<{ id: string; status: string; draft_ref?: string; error?: string }> {
  let draftRef: string
  try {
    switch (rec.action_type) {
      case 'email_campaign': draftRef = await exportEmail(supabase, rec); break
      case 'content_blog':   draftRef = await exportBlog(supabase, rec); break
      case 'content_ig':     draftRef = await exportIg(supabase, rec); break
      case 'ad_meta':        draftRef = await exportMetaAd(rec); break
      case 'ad_google':      draftRef = await exportGoogleAd(rec); break
      default: throw new Error(`action_type ${rec.action_type} has no exporter`)
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const notRecorded = await finishLoopRow(supabase, rec.id, workerId, 'exporting', { status: 'failed', draft_error: `export failed: ${msg.slice(0, 900)}` })
    if (notRecorded) console.error(`[strategist-executor] ${rec.id} export failed (${msg}) and was not recorded: ${notRecorded}`)
    return { id: rec.id, status: 'failed', error: msg }
  }
  const notRecorded = await finishLoopRow(supabase, rec.id, workerId, 'exporting', { status: 'ready_for_review', draft_ref: draftRef, draft_error: null })
  if (notRecorded) {
    console.error(`[strategist-executor] ${rec.id} exported as ${draftRef} but not recorded: ${notRecorded}`)
    return { id: rec.id, status: 'exported_unrecorded', draft_ref: draftRef, error: notRecorded }
  }
  return { id: rec.id, status: 'ready_for_review', draft_ref: draftRef }
}

async function runLoop(supabase: SupabaseClient, cfg: LoopConfig, workerId: string) {
  const loopTypes = [...LOOP_IMPLEMENTED].filter(t => critiqueOn(cfg, t))
  const out: Array<Record<string, unknown>> = []
  // Export first: those drafts already passed and Erez is waiting on them.
  for (const rec of await claimLoopRows(supabase, 'exporting', workerId, BATCH)) out.push(await exportRec(supabase, rec, workerId))
  if (loopTypes.length) {
    // Revisions call the drafter again (~30-50 s each): 2 per tick keeps the tick bounded.
    for (const rec of await claimRecs(supabase, workerId, loopTypes, 2, Date.now(), 'revising')) out.push(await draftForCritique(supabase, rec, workerId))
  }
  return { loopTypes, results: out }
}

serve(runLogged('strategist-executor', async (req, _log) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  // Only cron (and other functions) run this. The gateway's verify_jwt still
  // admits the public anon key, so the caller is checked here.
  if (!(await isServiceCaller(req))) return unauthorized(CORS)
  const supabase = createSupabase()
  const workerId = `exec-${crypto.randomUUID().slice(0, 8)}`
  try {
    const cfg = await readLoopConfig(supabase)
    const swept = (await sweepStaleDrafting(supabase)) + (await sweepStaleLoop(supabase))
    const loop = await runLoop(supabase, cfg, workerId)
    const recs = await claimRecs(supabase, workerId, SUPPORTED, BATCH)
    if (recs.length === 0 && loop.results.length === 0) return json({ ok: true, idle: 'no approved recommendations to draft', swept_stale: swept || undefined })
    const results: Array<Record<string, unknown>> = []
    // Critic on for this type → draft for review; otherwise the original path.
    for (const rec of recs) results.push(critiqueOn(cfg, rec.action_type) ? await draftForCritique(supabase, rec, workerId) : await draftRec(supabase, rec, workerId))
    return json({
      ok: true,
      drafted: results.filter(r => r.status === 'drafted').length,
      for_critique: results.filter(r => r.status === 'awaiting_critique').length || undefined,
      failed: results.filter(r => r.status === 'failed').length,
      unrecorded: results.filter(r => r.status === 'drafted_unrecorded').length || undefined,
      swept_stale: swept || undefined,
      results,
      loop: loop.results.length ? loop.results : undefined,
    })
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500)
  }
}, {
  // Counts only: `results` and `loop` carry draft text and recommendation detail.
  judge: (out) => {
    const failed = Number(out?.failed ?? 0)
    return {
      status: out?.ok === true && failed > 0 ? 'partial' : undefined,
      summary: {
        idle: out?.idle ? true : undefined, drafted: out?.drafted, for_critique: out?.for_critique,
        failed: out?.failed, unrecorded: out?.unrecorded, swept_stale: out?.swept_stale,
        loop_results: Array.isArray(out?.loop) ? out.loop.length : undefined,
      },
      warnings: [
        ...(failed > 0 ? [['drafts.failed', `${failed} recommendation draft(s) failed`, { failed }] as [string, string, Record<string, unknown>]] : []),
        ...(Number(out?.unrecorded ?? 0) > 0 ? [['drafts.unrecorded', `${out.unrecorded} draft(s) created but not recorded`, { unrecorded: out.unrecorded }] as [string, string, Record<string, unknown>]] : []),
      ],
    }
  },
}))
