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

  // ── 3. ONE reasoning step ───────────────────────────────────────────
  const system = buildMissionSystemPrompt(inflight)
  const userMsg =
    `MISSION OBJECTIVE:\n${mission.objective}\n\n` +
    `STEP ${mission.steps_taken + 1} of max ${mission.max_steps}.\n\n` +
    `PROGRESS NOTES SO FAR:\n${(state.progress_notes ?? []).slice(-12).map(n => `- ${n}`).join('\n') || '(none yet)'}\n\n` +
    `SUB-TASKS YOU'VE QUEUED (${inflight} still in-flight):\n${subtaskSummary}\n\n` +
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
        const inserted = await insertTasks(supabase, [{
          task_type,
          brief_data: norm.brief as NewSeoTask['brief_data'],
          rationale:  `[mission ${mission.id.slice(0, 8)}] ${rationale}`,
          orchestrator_run_id: crypto.randomUUID(),
        }])
        if (inserted[0]?.id) newTaskIds.push(inserted[0].id)
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
- Decompose big objectives into concrete, gated tasks the pipeline can execute. Use deep_research (scope channel_discovery / geo_llmo / etc.) for "figure out HOW", text/visual/IG for content, dynamic_experiment for anything novel that needs the admin to greenlight a new capability.
- KNOW WHEN TO STOP. When the objective is genuinely achieved (or you've done all you autonomously can and the rest needs the admin), complete_mission with a clear summary. Don't spin in circles to burn steps.
- Stay in Minuto's organic-growth lane; respect any standing brand rules. Anything outside your execution tools → propose as a dynamic_experiment for the admin.

BRIEF SHAPES — queue_subtask.brief_data MUST carry the required fields for the task_type, or the sub-task FAILS validation and is wasted. Required (✱) and optional fields:
- deep_research → { question✱ (a specific researchable question), scope ("channel_discovery"|"geo_llmo"|"content_topic"|"other"), expected_output ("analysis") }
- text_generation → { keyword✱ (target search keyword), title✱ (H1/headline), key_points✱ (non-empty array of the points the article must cover), products_to_mention (array of product names) }
- visual_generation → { scene_brief✱ (one concrete scene to render), render_mode ("vertex"|"gemini"), aspect ("1:1"|"4:5"|"9:16"), destination } — OR for a carousel: { slides✱ (array of { scene_brief, heading, body }) }
- instagram_post → needs a COMPLETED visual_generation parent first (its render feeds the post); brief: { caption_he✱, hashtags (array), media_type } — never queue this before the visual exists.
- technical_seo → { subtype: "faq_injection"✱, target_post_url OR target_post_id✱ }
- dynamic_experiment → { description✱, approval_required: true }
Fill every ✱ field with real content. If you lack the info for a required field, do deep_research first or note_progress — do NOT queue a task with placeholder/missing fields.

Output your reasoning briefly as text, then the tool call(s) for this step's action.`
}
