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
import type { NewSeoTask, RecommendationRow, TextGenerationBrief, InstagramPostBrief, VisualGenerationBrief } from '../seo-agent/types.ts'
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const COFFEEFLOW_USER_ID = Deno.env.get('COFFEEFLOW_USER_ID') ?? ''

const LOCK_MINUTES = 5
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
const SUPPORTED: RecommendationRow['action_type'][] = ['content_blog', 'content_ig', 'email_campaign']

async function claimRecs(supabase: SupabaseClient, workerId: string): Promise<RecommendationRow[]> {
  const nowMs = Date.now()
  const { data, error } = await supabase
    .from('strategic_recommendations')
    .select('*')
    .eq('status', 'approved')
    .in('action_type', SUPPORTED)
    .order('created_at', { ascending: true })
    .limit(BATCH * 2)
  if (error) throw new Error(`claimRecs select failed: ${error.message}`)
  const claimed: RecommendationRow[] = []
  for (const r of (data ?? []) as RecommendationRow[]) {
    if (r.locked_until && new Date(r.locked_until).getTime() > nowMs) continue
    const lockedUntil = new Date(nowMs + LOCK_MINUTES * 60_000).toISOString()
    let q = supabase
      .from('strategic_recommendations')
      .update({ locked_until: lockedUntil, worker_id: workerId, updated_at: new Date().toISOString() })
      .eq('id', r.id)
      .eq('status', 'approved')
    q = r.locked_until === null ? q.is('locked_until', null) : q.eq('locked_until', r.locked_until)
    const { data: got } = await q.select('*').maybeSingle()
    if (got) claimed.push(got as RecommendationRow)
    if (claimed.length >= BATCH) break
  }
  return claimed
}

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

async function draftBlog(supabase: SupabaseClient, rec: RecommendationRow): Promise<string> {
  const task: NewSeoTask = {
    task_type:           'text_generation',
    brief_data:          blogBrief(rec),
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
async function draftIg(supabase: SupabaseClient, rec: RecommendationRow): Promise<string> {
  const p = rec.action_params ?? {}
  const mediaType = ((p.media_type as string) || 'feed_image') as InstagramPostBrief['media_type']
  const isStory = mediaType === 'story'
  const aspect = ((p.aspect as string) || (isStory ? 'story' : 'feed_square')) as VisualGenerationBrief['aspect']
  // bag_hero needs an exact product name; fall back to no_bag if missing.
  const wantsBag = (p.render_mode as string) === 'bag_hero' && typeof p.product_name === 'string' && (p.product_name as string).length > 0
  const renderMode: VisualGenerationBrief['render_mode'] = wantsBag ? 'bag_hero' : 'no_bag'

  const visualBrief: VisualGenerationBrief = {
    scene_brief: (p.scene_brief as string) || `Editorial Minuto specialty-coffee scene for: ${(p.topic as string) || rec.title}. Warm natural light, shallow depth of field, the locked Minuto visual identity.`,
    aspect,
    render_mode: renderMode,
    destination: 'ig_post',
    ...(wantsBag ? { product_name: p.product_name as string } : {}),
  }
  const [visual] = await insertTasks(supabase, [{
    task_type:           'visual_generation',
    brief_data:          visualBrief,
    rationale:           `[strategist] visual for: ${rec.title}`,
    orchestrator_run_id: runIdOf(rec),
  }])
  if (!visual) throw new Error('visual_generation insert returned no row')

  const igBrief: InstagramPostBrief = {
    caption_he:       (p.caption_he as string) || '',
    hashtags:         Array.isArray(p.hashtags) ? (p.hashtags as string[]) : [],
    media_type:       mediaType,
    publish_strategy: 'queue_for_review',
  }
  if (!igBrief.caption_he) throw new Error('content_ig recommendation missing caption_he')
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
async function draftEmail(rec: RecommendationRow): Promise<string> {
  if (!COFFEEFLOW_USER_ID) throw new Error('COFFEEFLOW_USER_ID not set — cannot draft a campaign')
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

  const res = await fetch(`${SUPABASE_URL}/functions/v1/generate-campaign`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${SERVICE_ROLE}`, 'apikey': SERVICE_ROLE, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'generate', userId: COFFEEFLOW_USER_ID, campaignType: 'strategist', customInstructions: instructions }),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`generate-campaign ${res.status}: ${text.slice(0, 300)}`)
  let id: unknown
  try { id = JSON.parse(text)?.campaign?.id } catch { /* fall through */ }
  if (id == null) throw new Error(`generate-campaign returned no campaign id: ${text.slice(0, 200)}`)
  return `campaign:${id}`
}

async function draftRec(supabase: SupabaseClient, rec: RecommendationRow): Promise<{ id: string; status: string; draft_ref?: string; error?: string }> {
  try {
    let draftRef: string
    switch (rec.action_type) {
      case 'content_blog':   draftRef = await draftBlog(supabase, rec); break
      case 'content_ig':     draftRef = await draftIg(supabase, rec); break
      case 'email_campaign': draftRef = await draftEmail(rec); break
      default:               throw new Error(`action_type ${rec.action_type} not executable`)
    }
    await supabase
      .from('strategic_recommendations')
      .update({ status: 'drafted', draft_ref: draftRef, draft_error: null, locked_until: null, updated_at: new Date().toISOString() })
      .eq('id', rec.id)
    return { id: rec.id, status: 'drafted', draft_ref: draftRef }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await supabase
      .from('strategic_recommendations')
      .update({ status: 'failed', draft_error: msg.slice(0, 1000), locked_until: null, updated_at: new Date().toISOString() })
      .eq('id', rec.id)
    return { id: rec.id, status: 'failed', error: msg }
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  const supabase = createSupabase()
  const workerId = `exec-${crypto.randomUUID().slice(0, 8)}`
  try {
    const recs = await claimRecs(supabase, workerId)
    if (recs.length === 0) return json({ ok: true, idle: 'no approved recommendations to draft' })
    const results = []
    for (const rec of recs) results.push(await draftRec(supabase, rec))
    return json({ ok: true, drafted: results.filter(r => r.status === 'drafted').length, failed: results.filter(r => r.status === 'failed').length, results })
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500)
  }
})
