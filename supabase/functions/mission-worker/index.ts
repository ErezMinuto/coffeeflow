// Minuto SEO Agent — mission worker.
//
// Drives persistent missions: open-ended objectives the agent pursues
// autonomously in the background (see 20260529_agent_missions.sql), long
// after the admin has closed the browser. Cron-invoked (~every 10 min).
//
// ONE reasoning step per tick: the worker claims an active mission, looks
// at its progress + the results of sub-tasks it queued earlier, and makes
// ONE decision — queue more (gated) work, note progress, or declare the
// objective met. Each step is a single Claude call (bounded well under the
// 150s edge wall-clock); a mission spans many ticks.
//
// Everything it queues flows through the normal seo_tasks pipeline and its
// publish gates (blog→drafts, IG→queue-for-review, FAQ→review_required), so
// a mission runs hands-off WITHOUT ever publishing live without the admin.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createSupabase, insertTasks } from '../seo-agent/db.ts'
import {
  callClaude,
  MODEL_ORCHESTRATOR,
  type MessageContentBlock,
  type ToolDefinition,
  type ChatMessage,
} from '../seo-agent/claude.ts'
import { writeBriefing } from '../seo-agent/briefingWriter.ts'
import { fetchMinutoCoffeeCatalog, fetchRecentBlogPosts, type WooProduct } from '../seo-agent/services/cmsApi.ts'
import { fetchTopKeywords } from '../seo-agent/services/googleApi.ts'
import type { MissionRow, MissionState, NewSeoTask } from '../seo-agent/types.ts'

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
}

// Max sub-tasks allowed in-flight (pending/processing) before the worker
// stops queuing more and waits — prevents a mission from flooding the queue.
const MAX_INFLIGHT = 3

const TOOLS: ToolDefinition[] = [
  {
    name: 'queue_subtask',
    description: 'Queue ONE unit of work toward the mission. It flows through the normal pipeline + publish gates (nothing goes live without the admin). Queue at most 1-3 per step, then WAIT for results before queuing dependent work.',
    input_schema: {
      type: 'object',
      properties: {
        task_type:  { type: 'string', description: 'text_generation | visual_generation | instagram_post | technical_seo | deep_research | dynamic_experiment' },
        brief_data: { type: 'object', description: 'Brief payload matching the task_type (see types.ts). For instagram_post you must also be able to point at a visual; if unsure, prefer text_generation / deep_research / dynamic_experiment.' },
        rationale:  { type: 'string', description: 'One line: how this advances the mission.' },
      },
      required: ['task_type', 'brief_data', 'rationale'],
    },
  },
  {
    name: 'note_progress',
    description: 'Record a short progress note / observation for your future self and the admin. Use when the right move this step is to WAIT for queued sub-tasks, or to capture a finding. No external effect.',
    input_schema: {
      type: 'object',
      properties: { note: { type: 'string', description: 'One or two sentences.' } },
      required: ['note'],
    },
  },
  {
    name: 'complete_mission',
    description: 'Declare the objective met (or no further meaningful progress possible). Ends the mission. Provide a summary of what was accomplished.',
    input_schema: {
      type: 'object',
      properties: { summary: { type: 'string', description: 'What the mission achieved (or why it is stopping).' } },
      required: ['summary'],
    },
  },
]

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST')    return json({ error: 'POST only' }, 405)

  const workerId = `mission-${crypto.randomUUID().slice(0, 8)}`
  const supabase = createSupabase()
  const nowIso = new Date().toISOString()

  // ── 1. Claim one active mission (expired-lock self-heal) ────────────
  const { data: candidates, error: selErr } = await supabase
    .from('agent_missions')
    .select('*')
    .eq('status', 'active')
    .or(`locked_until.is.null,locked_until.lt.${nowIso}`)
    .order('last_step_at', { ascending: true, nullsFirst: true })
    .limit(3)
  if (selErr) return json({ processed: 0, worker_id: workerId, error: selErr.message }, 500)
  if (!candidates || candidates.length === 0) return json({ processed: 0, worker_id: workerId })

  let mission: MissionRow | null = null
  const lockUntil = new Date(Date.now() + 8 * 60_000).toISOString()
  for (const c of candidates as MissionRow[]) {
    // Optimistic claim: only succeed if the row is STILL in the exact state
    // we saw it in (no one else re-locked between SELECT and UPDATE).
    // Using .or() here was a footgun: PostgREST's UPDATE+RETURNING with .or()
    // sometimes returned null even though the row WAS updated, leaving the
    // mission locked but the worker thinking it didn't claim it (→ processed:0,
    // → mission stuck forever). Conditional .eq/.is is the same pattern as
    // claimNextTask's stale-lock reclaim and is unambiguous.
    let updQ = supabase
      .from('agent_missions')
      .update({ locked_until: lockUntil, worker_id: workerId, updated_at: nowIso })
      .eq('id', c.id)
      .eq('status', 'active')
    updQ = c.locked_until === null
      ? updQ.is('locked_until', null)
      : updQ.eq('locked_until', c.locked_until)
    const { data: locked } = await updQ.select().maybeSingle()
    if (locked) { mission = locked as MissionRow; break }
  }
  if (!mission) return json({ processed: 0, worker_id: workerId })
  console.log(`[mission-worker] ${workerId} claimed mission ${mission.id} step ${mission.steps_taken}/${mission.max_steps}`)

  const state: MissionState = (mission.state ?? {}) as MissionState
  const queuedIds = Array.isArray(state.queued_task_ids) ? state.queued_task_ids : []

  // ── 2. Gather the status/results of sub-tasks queued earlier ────────
  let inflight = 0
  let subtaskSummary = '(no sub-tasks queued yet)'
  if (queuedIds.length > 0) {
    const { data: subs } = await supabase
      .from('seo_tasks')
      .select('id, task_type, status, rationale, result_data, error_msg')
      .in('id', queuedIds.slice(-30))
    const rows = (subs ?? []) as Array<{ id: string; task_type: string; status: string; rationale: string | null; result_data: any; error_msg: string | null }>
    inflight = rows.filter(r => r.status === 'pending' || r.status === 'processing').length
    subtaskSummary = rows.map(r => {
      const rd = r.result_data ?? {}
      // Surface the FAILURE REASON for failed tasks. Without this the mission
      // only saw "[failed] deep_research" with no cause, so it re-queued the
      // same malformed brief forever. Now it can read the gate error (e.g.
      // "brief.question is required") and correct the next sub-task.
      const out = r.status === 'failed'
          ? `FAILED — ${(r.error_msg ?? 'unknown error').slice(0, 220)}`
        : typeof rd.final_text === 'string' ? rd.final_text.slice(0, 300)
        : rd.review_required ? '(awaiting admin review)'
        : r.status === 'completed' ? '(completed)' : ''
      return `- [${r.status}] ${r.task_type} (${r.id.slice(0, 8)}) — ${(r.rationale ?? '').slice(0, 70)}${out ? ` → ${out}` : ''}`
    }).join('\n')
  }

  // ── 2.5 Grounding data — content choices must be research-led, not random ──
  // The mission used to pick topics + product mentions out of thin air (e.g. it
  // invented generic phrases like "קפה אתיופיה" for products_to_mention that
  // resolve to nothing, or picked a green 1kg / reseller bag as the hero). Feed
  // it the same kind of real signals the strategist sees so it grounds topic +
  // EXACT-product choices in data: Minuto's OWN coffee lineup (the only products
  // valid as a content hero — green home-roasting SKUs and resold brands like
  // Veneto/Toddy are filtered out), GSC demand (what people actually search),
  // and the last 90d of posts (so it doesn't re-write a topic we just covered).
  // All guarded — a single source failing degrades the block, never the step.
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString()
  const [catalog, gscKeywords, recentPosts] = await Promise.all([
    fetchMinutoCoffeeCatalog(supabase).catch((e: any) => { console.warn(`[mission-worker] catalog fetch failed: ${e?.message ?? e}`); return [] as WooProduct[] }),
    fetchTopKeywords(supabase, 30, 25).catch((e: any) => { console.warn(`[mission-worker] GSC fetch failed: ${e?.message ?? e}`); return [] }),
    fetchRecentBlogPosts(supabase, ninetyDaysAgo, 40).catch((e: any) => { console.warn(`[mission-worker] blog fetch failed: ${e?.message ?? e}`); return [] }),
  ])

  const catalogBlock = catalog.length === 0
    ? '(catalog unavailable this step)'
    : catalog.map(p => `- ${p.name}${p.stock_status && p.stock_status !== 'instock' ? ` [${p.stock_status}]` : ''}`).join('\n')
  const gscBlock = gscKeywords.length === 0
    ? '(no GSC data this step)'
    : gscKeywords.slice(0, 25).map(k => `- "${k.keyword}" — ${k.impressions} impr, ${k.clicks} clicks, avg pos ${k.position.toFixed(1)}`).join('\n')
  const recentBlock = recentPosts.length === 0
    ? '(no posts published in the last 90 days)'
    : recentPosts.slice(0, 30).map(p => `- ${p.title}`).join('\n')

  // ── 3. ONE reasoning step ───────────────────────────────────────────
  const system = buildMissionSystemPrompt(inflight)
  const userMsg =
    `MISSION OBJECTIVE:\n${mission.objective}\n\n` +
    `STEP ${mission.steps_taken + 1} of max ${mission.max_steps}.\n\n` +
    `PROGRESS NOTES SO FAR:\n${(state.progress_notes ?? []).slice(-12).map(n => `- ${n}`).join('\n') || '(none yet)'}\n\n` +
    `SUB-TASKS YOU'VE QUEUED (${inflight} still in-flight):\n${subtaskSummary}\n\n` +
    `=== MINUTO COFFEE LINEUP (the ONLY products to feature — copy an EXACT name into products_to_mention; products_to_mention[0] becomes the article's banner hero bag. Never invent a name or feature anything not on this list) ===\n${catalogBlock}\n\n` +
    `=== SEARCH DEMAND — top GSC keywords, last 30d (what real people search; ground topic choices here) ===\n${gscBlock}\n\n` +
    `=== ALREADY PUBLISHED — blog posts, last 90d (do NOT re-write a topic we just covered) ===\n${recentBlock}\n\n` +
    `Decide the SINGLE next move toward the objective. If sub-tasks are still in-flight and you have nothing independent to do, note_progress and wait. If the objective is met, complete_mission.`

  let res
  try {
    res = await callClaude({
      model:       MODEL_ORCHESTRATOR,
      system,
      messages:    [{ role: 'user', content: userMsg }] as ChatMessage[],
      tools:       TOOLS,
      maxTokens:   3000,
      temperature: 0.4,
      timeoutMs:   110_000,
    })
  } catch (e: any) {
    // Don't crash → unlock so the next tick retries. (Self-heal would also
    // catch it, but unlocking cleanly is tidier.)
    await supabase.from('agent_missions').update({ locked_until: null, worker_id: null, updated_at: new Date().toISOString() }).eq('id', mission.id)
    return json({ processed: 1, mission_id: mission.id, ok: false, error: `reasoning step failed: ${e?.message ?? e}` }, 500)
  }

  // ── 4. Apply the step's actions ─────────────────────────────────────
  const toolUses = res.content.filter((b): b is Extract<MessageContentBlock, { type: 'tool_use' }> => b.type === 'tool_use')
  const newNotes: string[] = []
  const newTaskIds: string[] = []
  let completed = false
  let completionSummary = ''

  for (const call of toolUses) {
    const input = (call.input ?? {}) as Record<string, unknown>
    if (call.name === 'note_progress') {
      const note = String(input.note ?? '').trim()
      if (note) newNotes.push(note)
    } else if (call.name === 'complete_mission') {
      completed = true
      completionSummary = String(input.summary ?? '').trim() || 'Objective met.'
    } else if (call.name === 'queue_subtask') {
      // Throttle: never let a mission exceed MAX_INFLIGHT queued-but-unfinished.
      if (inflight + newTaskIds.length >= MAX_INFLIGHT) {
        newNotes.push(`(held off queuing "${String(input.rationale ?? '').slice(0, 60)}" — ${MAX_INFLIGHT} sub-tasks already in-flight; waiting for them.)`)
        continue
      }
      const task_type  = String(input.task_type ?? '').trim()
      const rawBrief   = (input.brief_data ?? {}) as Record<string, unknown>
      const rationale  = String(input.rationale ?? '').trim()
      if (!task_type) continue
      // PRE-INSERT VALIDATION. A malformed brief inserts fine (brief_data is
      // raw JSONB) but then dies at the worker's claim-time gate — and the
      // mission, seeing only a failed sub-task, used to re-queue the same
      // broken shape forever. Validate + light-repair HERE so we never queue
      // a doomed task. If a brief is genuinely unrecoverable, skip it and
      // leave a precise note the next step can act on (instead of burning the
      // step on a guaranteed failure).
      const norm = normalizeBrief(task_type, rawBrief)
      if (!norm.ok) {
        newNotes.push(`(did NOT queue ${task_type} — ${norm.error}. Re-queue next step with that field filled.)`)
        continue
      }
      try {
        const runId = crypto.randomUUID()
        const inserted = await insertTasks(supabase, [{
          task_type,
          brief_data: norm.brief as NewSeoTask['brief_data'],
          rationale:  `[mission ${mission.id.slice(0, 8)}] ${rationale}`,
          orchestrator_run_id: runId,
        }])
        const textId = inserted[0]?.id
        if (textId) newTaskIds.push(textId)
        // BANNER PAIRING. The strategist path emits a matching visual_generation
        // (parent_task_index → parent_task_id) for every article so the post
        // ships with a banner; the mission path queued the text task ALONE, so
        // mission-produced drafts went out bannerless. Mirror the strategist:
        // auto-pair a blog_banner visual whose parent is this text task. The
        // visual worker waits for the text task's wp_post_id, then attaches the
        // render as the WP featured image. bag_hero when the article features a
        // real Minuto product (products_to_mention), else no_bag editorial.
        if (textId && task_type === 'text_generation') {
          try {
            const visualBrief = buildBannerBrief(norm.brief)
            const insVisual = await insertTasks(supabase, [{
              task_type:           'visual_generation',
              brief_data:          visualBrief as NewSeoTask['brief_data'],
              rationale:           `[mission ${mission.id.slice(0, 8)}] banner for the article above`,
              parent_task_id:      textId,
              orchestrator_run_id: runId,
            }])
            if (insVisual[0]?.id) newTaskIds.push(insVisual[0].id)
          } catch (e: any) {
            newNotes.push(`(article queued but banner pairing failed: ${e?.message ?? e})`)
          }
        }
      } catch (e: any) {
        newNotes.push(`(failed to queue ${task_type}: ${e?.message ?? e})`)
      }
    }
  }
  if (res.text.trim()) newNotes.push(res.text.trim().slice(0, 400))

  // ── 5. Persist mission state + decide lifecycle ─────────────────────
  const stepsTaken = mission.steps_taken + 1
  const hitCap     = stepsTaken >= mission.max_steps
  const finishing  = completed || hitCap
  const nextState: MissionState = {
    ...state,
    progress_notes:  [...(state.progress_notes ?? []), ...newNotes].slice(-50),
    queued_task_ids: [...queuedIds, ...newTaskIds].slice(-100),
  }

  const patch: Record<string, unknown> = {
    state:        nextState,
    steps_taken:  stepsTaken,
    last_step_at: new Date().toISOString(),
    updated_at:   new Date().toISOString(),
    locked_until: null,            // release the lock for the next tick
    worker_id:    null,
  }
  if (finishing) {
    patch.status         = completed ? 'done' : 'failed'
    patch.result_summary = completed ? completionSummary
      : `Stopped at the ${mission.max_steps}-step safety cap without an explicit completion.`
  }
  await supabase.from('agent_missions').update(patch).eq('id', mission.id)

  // ── 6. Briefing — on completion, or when work was queued this step ──
  try {
    if (finishing) {
      await writeBriefing(supabase, {
        subtype: 'orchestrator_cycle',
        title:   completed ? `Mission complete: ${mission.objective.slice(0, 60)}` : `Mission stopped (step cap): ${mission.objective.slice(0, 60)}`,
        body:    `${completed ? '✅' : '⚠️'} ${patch.result_summary}\n\n_Mission ran ${stepsTaken} step(s) and queued ${nextState.queued_task_ids?.length ?? 0} sub-task(s) total. Any drafts/proposals are waiting for your review._`,
        context: { mission_id: mission.id, status: patch.status, steps: stepsTaken },
      })
    } else if (newTaskIds.length > 0) {
      await writeBriefing(supabase, {
        subtype: 'orchestrator_cycle',
        title:   `Mission progress: ${mission.objective.slice(0, 60)}`,
        body:    `Step ${stepsTaken}: queued ${newTaskIds.length} new sub-task(s) toward the mission.\n${newNotes.map(n => `- ${n}`).join('\n').slice(0, 800)}`,
        context: { mission_id: mission.id, step: stepsTaken, queued: newTaskIds.length },
      })
    }
  } catch (e: any) {
    console.warn(`[mission-worker] ${workerId} briefing failed (non-fatal): ${e?.message ?? e}`)
  }

  return json({
    processed:    1,
    worker_id:    workerId,
    mission_id:   mission.id,
    ok:           true,
    step:         stepsTaken,
    status:       finishing ? patch.status : 'active',
    queued_now:   newTaskIds.length,
    inflight,
    completed,
  })
})

// ── Brief validation + light repair ──────────────────────────────────────
// The mission LLM authors brief_data freehand and insertTasks writes it as
// raw JSONB (no validation), so a brief missing a worker-required field used
// to insert successfully then fail at claim time. We validate the auto-
// executed types missions actually use, recovering values from the alternate
// keys the model tends to invent (e.g. `topic`/`query` → `question`). Unknown
// / HITL types pass through unchanged (their workers or admin review handle
// shape). Returns the normalized brief, or a precise error the mission acts on.
type BriefResult = { ok: true; brief: Record<string, unknown> } | { ok: false; error: string }

function firstNonEmpty(obj: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return ''
}
function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(x => (typeof x === 'string' ? x.trim() : String(x ?? '').trim())).filter(Boolean)
  if (typeof v === 'string' && v.trim()) {
    // Accept a newline / bullet-delimited block as a fallback.
    return v.split(/\r?\n|•|^\s*[-*]\s+/m).map(s => s.replace(/^\s*[-*]\s+/, '').trim()).filter(Boolean)
  }
  return []
}

function normalizeBrief(taskType: string, raw: Record<string, unknown>): BriefResult {
  const b: Record<string, unknown> = { ...raw }
  if (taskType === 'deep_research') {
    const question = firstNonEmpty(b, ['question', 'query', 'topic', 'objective', 'prompt', 'goal', 'research_question'])
    if (!question) return { ok: false, error: 'deep_research needs brief.question (the strategic question to research)' }
    b.question = question
    if (!firstNonEmpty(b, ['scope']))           b.scope = 'other'
    if (!firstNonEmpty(b, ['expected_output'])) b.expected_output = 'analysis'
    return { ok: true, brief: b }
  }
  if (taskType === 'text_generation') {
    const keyword = firstNonEmpty(b, ['keyword', 'topic', 'subject', 'focus_keyword', 'target_keyword'])
    if (!keyword) return { ok: false, error: 'text_generation needs brief.keyword (the target keyword/topic)' }
    b.keyword = keyword
    b.title = firstNonEmpty(b, ['title', 'headline', 'h1']) || keyword
    const keyPoints = asStringArray(b.key_points ?? b.points ?? b.outline ?? b.bullets ?? b.sections)
    if (keyPoints.length === 0) return { ok: false, error: 'text_generation needs brief.key_points (a non-empty array of points the article must cover)' }
    b.key_points = keyPoints
    b.products_to_mention = asStringArray(b.products_to_mention)
    return { ok: true, brief: b }
  }
  if (taskType === 'visual_generation') {
    const hasSlides = Array.isArray((b as { slides?: unknown }).slides) && ((b as { slides: unknown[] }).slides).length > 0
    const sceneBrief = firstNonEmpty(b, ['scene_brief', 'scene', 'description', 'prompt'])
    if (!hasSlides && !sceneBrief) return { ok: false, error: 'visual_generation needs brief.scene_brief (or a slides[] array for a carousel)' }
    if (sceneBrief) b.scene_brief = sceneBrief
    return { ok: true, brief: b }
  }
  // technical_seo, dynamic_experiment, instagram_post, novel experiment
  // subtypes → pass through; their workers or the admin review handle shape.
  return { ok: true, brief: b }
}

// ── Banner brief for a mission-queued article ────────────────────────────
// Builds the paired visual_generation brief for a text_generation task. We
// author it here (not the LLM) because the mission queues one task at a time
// and never emitted a visual. The visual worker uses brief.scene_brief as the
// render prompt verbatim and HARD-REQUIRES product_name for bag_hero — so a
// complete brief matters. bag_hero when the article features a real Minuto
// product (so the byte-perfect bag appears in-frame); otherwise a bag-free
// editorial scene (writing a bag into a no_bag brief yields a generic off-brand
// bag — the documented anti-pattern, so we keep no_bag bag-free).
function buildBannerBrief(textBrief: Record<string, unknown>): Record<string, unknown> {
  const topic = firstNonEmpty(textBrief, ['title', 'keyword', 'subject']) || 'specialty coffee'
  const products = asStringArray(textBrief.products_to_mention)
  const product = products[0] ?? ''
  if (product) {
    return {
      scene_brief:
        `Editorial product banner for a Minuto specialty-coffee blog article about "${topic}". ` +
        `A single Minuto coffee bag is the hero, standing upright and in sharp focus on a warm natural surface (pale wood or stone). ` +
        `Soft daylight rakes from one side, shallow depth of field, a few scattered light-cinnamon roasted beans, minimal uncluttered props. ` +
        `Premium, calm, magazine-quality still life with generous negative space. No text, no logos other than what is on the bag.`,
      aspect:      'feed_square',
      render_mode: 'bag_hero',
      product_name: product,
      destination: 'blog_banner',
    }
  }
  return {
    scene_brief:
      `Editorial banner for a Minuto specialty-coffee blog article about "${topic}". ` +
      `A warm, inviting coffee scene in the locked Minuto identity: natural daylight, pale wood or stone surface, ` +
      `light-cinnamon roasted beans and brewing details, shallow depth of field, minimal premium props, generous negative space. ` +
      `Do NOT include any coffee bag, pouch, packaging, or label of any kind. No text, no logos.`,
    aspect:      'feed_square',
    render_mode: 'no_bag',
    destination: 'blog_banner',
  }
}

function buildMissionSystemPrompt(inflight: number): string {
  return `You are Minuto's autonomous MISSION EXECUTOR. Minuto is a specialty-coffee roastery in Israel (minuto.co.il) doing organic growth (blog SEO + Instagram + more). You pursue ONE long-running objective across many short sessions — you wake roughly every 10 minutes, take ONE step, and sleep. A mission spans hours or days.

THIS SESSION: read the objective + your progress + the results of sub-tasks you queued earlier, then take the SINGLE most valuable next action.

YOUR ACTIONS (tools):
- queue_subtask — queue one unit of work (text_generation, visual_generation, instagram_post, technical_seo, deep_research, dynamic_experiment). It flows through the normal pipeline and its PUBLISH GATES — blog posts become drafts, IG posts queue for review, FAQs need approval. You NEVER publish anything live; the admin approves what ships.
- note_progress — record a finding / decision for your future self + the admin (use this when waiting is the right move).
- complete_mission — end the mission when the objective is met or no further progress is possible.

OPERATING RULES:
- ONE focused step. Queue at most 1-3 sub-tasks, then WAIT — you'll see their results next session and build on them. ${inflight >= MAX_INFLIGHT ? `You already have ${inflight} sub-tasks in-flight — do NOT queue more this step; note progress and wait.` : ''}
- Be data-driven: read the sub-task results you can see and ADAPT. Don't re-queue work that's still in-flight.
- RESEARCH BEFORE YOU WRITE — never decide a topic, angle, or expression arbitrarily. Every content sub-task (text_generation / instagram_post / a content visual) must be JUSTIFIED by the data in this message: tie the topic to a real SEARCH DEMAND keyword (or to a completed deep_research finding you can see above), confirm the angle isn't an ALREADY PUBLISHED topic, and choose products_to_mention by copying EXACT names from the PRODUCT CATALOG. If the data above doesn't yet support a confident content choice, queue a deep_research sub-task FIRST (or note_progress) instead of writing a speculative post. In your rationale, state which signal grounds the choice (e.g. the keyword, the research finding, the catalog SKU). A post you can't ground in the data is a random post — don't queue it.
- products_to_mention values MUST be verbatim names from the MINUTO COFFEE LINEUP above — that list is the ONLY set of products you may feature. Do NOT invent generic phrases (e.g. "קפה אתיופיה") and do NOT feature any product not on the list. products_to_mention[0] becomes the auto-paired banner's hero bag, so it must be a real Minuto coffee from the lineup. If no lineup coffee fits the article, leave products_to_mention empty (the banner falls back to a bag-free editorial scene) rather than guessing.
- Decompose big objectives into concrete, gated tasks the pipeline can execute. Use deep_research (scope channel_discovery / geo_llmo / etc.) for "figure out HOW", text/visual/IG for content, dynamic_experiment for anything novel that needs the admin to greenlight a new capability.
- KNOW WHEN TO STOP. When the objective is genuinely achieved (or you've done all you autonomously can and the rest needs the admin), complete_mission with a clear summary. Don't spin in circles to burn steps.
- Stay in Minuto's organic-growth lane; respect any standing brand rules. Anything outside your execution tools → propose as a dynamic_experiment for the admin.

BRIEF SHAPES — queue_subtask.brief_data MUST carry the required fields for the task_type, or the sub-task FAILS validation and is wasted. Required (✱) and optional fields:
- deep_research → { question✱ (a specific researchable question), scope ("channel_discovery"|"geo_llmo"|"content_topic"|"other"), expected_output ("analysis") }
- text_generation → { keyword✱ (target search keyword), title✱ (H1/headline), key_points✱ (non-empty array of the points the article must cover), products_to_mention (array of EXACT names copied from the MINUTO COFFEE LINEUP block — when set, the auto-paired banner shows that real bag, so never invent a name or use anything off the list) }. A matching blog banner is queued AUTOMATICALLY for every article — do NOT queue a separate visual_generation for a blog post.
- visual_generation → { scene_brief✱ (one concrete scene to render), aspect ("feed_square"|"feed_portrait"|"reel_cover"), render_mode ("bag_hero"|"no_bag" — bag_hero composites the real Minuto bag and REQUIRES product_name set to an exact Minuto product; no_bag is a bag-free editorial scene and must NOT mention any bag/pouch/packaging), product_name (exact Minuto product name, required when render_mode="bag_hero"), destination ("blog_banner"|"ig_post") } — OR for a carousel: { slides✱ (array of { scene_brief, heading, body }) }. (Blog articles get a banner auto-paired — only queue this for IG visuals or standalone scenes.)
- instagram_post → needs a COMPLETED visual_generation parent first (its render feeds the post); brief: { caption_he✱, hashtags (array), media_type } — never queue this before the visual exists.
- technical_seo → { subtype: "faq_injection"✱, target_post_url OR target_post_id✱ }
- dynamic_experiment → { description✱, approval_required: true }
Fill every ✱ field with real content. If you lack the info for a required field, do deep_research first or note_progress — do NOT queue a task with placeholder/missing fields.

Output your reasoning briefly as text, then the tool call(s) for this step's action.`
}
