// Minuto Strategist Brain — runner.
//
// The thin ReAct driver for the strategist tier. Two entry points, mirroring
// the orchestrator-kickoff / worker-advance split, both reusing the proven
// tick-based locking pattern from mission-worker:
//
//   ?mode=kickoff  (weekly cron) — kill-switch check, then open ONE thinking
//                  run seeded with a fresh business snapshot.
//   ?mode=advance  (cron every ~2 min) — claim the active run, run several
//                  ReAct steps in a tight in-process loop (keeps the prompt
//                  cache hot within the invocation), checkpoint, resume next
//                  tick. Concludes by writing the brief + emailing the owner.
//
// PHASE 1 IS THINKING ONLY. The brain reads + reasons + writes its OWN tables
// (runs/briefs/theses/signals/cost ledger). It publishes nothing and spends
// nothing. All heavy lifting lives in shared modules — this file is glue.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createSupabase, logClaudeCost, getMonthToDateSpendUsd } from '../seo-agent/db.ts'
import { callClaude, type ChatMessage, type MessageContentBlock } from '../seo-agent/claude.ts'
import { STRATEGIST_BRAIN_SYSTEM_PROMPT } from '../seo-agent/prompts/strategistBrain.ts'
import { assembleBusinessSnapshot } from '../seo-agent/services/businessSnapshot.ts'
import {
  STRATEGIST_MODEL,
  STRATEGIST_EFFORT,
  STRATEGIST_MAX_STEPS,
  STRATEGIST_MAX_TOKENS,
  BUDGET_CEILING_USD,
  estimateUsd,
} from '../seo-agent/strategistConfig.ts'
import { BRAIN_TOOLS, dispatchTool, type ToolContext } from './tools.ts'
import { sendOwnerEmail } from '../_shared/email.ts'
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'

const DASHBOARD_URL = Deno.env.get('DASHBOARD_URL') ?? 'https://coffeeflow-neon.vercel.app'
const LOCK_MINUTES = 5

// Edge wall-clock realities. Opus 4.8 at high effort can spend most of a minute+
// thinking on one step, and the Supabase edge runtime hard-kills the request near
// ~150s. So: give each Claude call a generous timeout, and only START a step if a
// full timeout still fits the wall-clock — in practice ~one deep step per
// invocation, with the cron driving subsequent steps (the 2-min cadence keeps the
// 5-min prompt cache warm across ticks). A timed-out step is TRANSIENT: we keep
// the run 'thinking' and let the next tick retry the same state, failing only
// after several consecutive transient errors.
const PER_CALL_TIMEOUT_MS  = 120_000
const WALL_CLOCK_BUDGET_MS  = 135_000
const MAX_TRANSIENT_RETRIES = 5

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
}

// Monday (UTC) of the week containing `d` — the week a run reasons about.
function mondayOf(d: Date): string {
  const day = d.getUTCDay()                  // 0=Sun … 6=Sat
  const diff = day === 0 ? -6 : 1 - day      // back up to Monday
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + diff))
    .toISOString().split('T')[0]
}

// ── Run state (checkpointed in strategist_runs.state) ────────────────────────
interface RunState {
  messages: ChatMessage[]   // the evolving ReAct transcript (system is NOT stored here)
  nudged?:  boolean         // did we already remind it to conclude?
  retries?: number          // consecutive transient (timeout/5xx) errors; fails the run past the cap
}
interface CostTotals {
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_creation_tokens: number
  est_usd: number
  calls: number
}
const ZERO_COST: CostTotals = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, est_usd: 0, calls: 0 }

// ─────────────────────────────────────────────────────────────────────────────
// KICKOFF
// ─────────────────────────────────────────────────────────────────────────────
async function kickoff(supabase: SupabaseClient, trigger: string): Promise<Response> {
  // Kill-switch: never start an expensive run once the month's spend has hit
  // the ceiling. Budget gates FREQUENCY (skip this run), never a running run's
  // depth.
  const mtd = await getMonthToDateSpendUsd(supabase)
  if (mtd >= BUDGET_CEILING_USD) {
    const status = await sendOwnerEmail({
      subject: `⚠️ Strategist paused — monthly budget reached ($${mtd.toFixed(2)})`,
      html: `<p>The strategist skipped this week's run: month-to-date Claude spend across the agent stack is <b>$${mtd.toFixed(2)}</b>, at or over the $${BUDGET_CEILING_USD} ceiling. It will resume next cycle after the month rolls over, or once the ceiling is raised.</p>`,
    })
    return json({ ok: false, skipped: 'budget_ceiling_reached', mtd_usd: mtd, email: status })
  }

  const weekStart = mondayOf(new Date())
  let snapshot: unknown
  try {
    snapshot = await assembleBusinessSnapshot(supabase)
  } catch (e) {
    return json({ ok: false, error: `snapshot failed: ${e instanceof Error ? e.message : String(e)}` }, 500)
  }

  const seedState: RunState = { messages: [] }
  const { data, error } = await supabase
    .from('strategist_runs')
    .insert({
      status:     'thinking',
      trigger,
      week_start: weekStart,
      snapshot,
      state:      seedState,
      max_steps:  STRATEGIST_MAX_STEPS,
      cost_tokens: ZERO_COST,
    })
    .select('id')
    .single()

  if (error) {
    // 23505 = the single-active-run unique index fired: a run is already
    // thinking. That's the guard working, not a failure.
    if (error.code === '23505' || /duplicate key|unique/i.test(error.message)) {
      return json({ ok: true, skipped: 'a run is already in progress', mtd_usd: mtd })
    }
    return json({ ok: false, error: `kickoff insert failed: ${error.message}` }, 500)
  }
  return json({ ok: true, started: true, run_id: (data as { id: string }).id, week_start: weekStart, mtd_usd: mtd })
}

// ─────────────────────────────────────────────────────────────────────────────
// ADVANCE — claim + step the active run
// ─────────────────────────────────────────────────────────────────────────────
interface RunRow {
  id: string
  week_start: string | null
  snapshot: Record<string, unknown>
  state: RunState
  steps_taken: number
  max_steps: number
  cost_tokens: CostTotals
}

async function claimRun(supabase: SupabaseClient, workerId: string): Promise<RunRow | null> {
  const nowMs = Date.now()
  // The single-active unique index guarantees at most one 'thinking' run, so we
  // don't need a timestamp-in-or() filter (which serializes unreliably on PATCH
  // in supabase-js). Fetch the thinking run(s), then do the stale-lock check in
  // JS and claim with an optimistic guard on the lock value we saw.
  const { data: cands, error } = await supabase
    .from('strategist_runs')
    .select('id, week_start, snapshot, state, steps_taken, max_steps, cost_tokens, locked_until')
    .eq('status', 'thinking')
    .order('updated_at', { ascending: true })
    .limit(3)
  if (error) throw new Error(`claimRun select failed: ${error.message}`)
  for (const c of (cands ?? []) as Array<RunRow & { locked_until: string | null }>) {
    // Skip a run a live worker still holds (lock not yet expired).
    if (c.locked_until && new Date(c.locked_until).getTime() > nowMs) continue
    const lockedUntil = new Date(nowMs + LOCK_MINUTES * 60_000).toISOString()
    let upd = supabase
      .from('strategist_runs')
      .update({ locked_until: lockedUntil, worker_id: workerId, updated_at: new Date().toISOString() })
      .eq('id', c.id)
      .eq('status', 'thinking')
    // Optimistic concurrency: only claim if the lock is exactly what we saw, so
    // two overlapping ticks can't both grab the same run.
    upd = c.locked_until === null
      ? upd.is('locked_until', null)
      : upd.eq('locked_until', c.locked_until)
    const { data: claimed } = await upd
      .select('id, week_start, snapshot, state, steps_taken, max_steps, cost_tokens')
      .maybeSingle()
    if (claimed) return claimed as RunRow
  }
  return null
}

const SEED_USER_MESSAGE =
  'Begin this cycle. Your business snapshot and active theses are in your system context. ' +
  'Reason step by step, investigate with drilldowns where a decision genuinely depends on data you don\'t yet have, ' +
  'run your adversarial self-check, then call conclude_brief exactly once. Concluding with little or nothing to do is valid if the data supports it.'

async function advance(supabase: SupabaseClient, workerId: string): Promise<Response> {
  const run = await claimRun(supabase, workerId)
  if (!run) return json({ ok: true, idle: 'no active run to advance' })

  const system = STRATEGIST_BRAIN_SYSTEM_PROMPT +
    '\n\n═══ BUSINESS SNAPSHOT (revenue-first; { "error": ... } = a sense that went dark) ═══\n' +
    JSON.stringify(run.snapshot)

  const state: RunState = run.state ?? { messages: [] }
  if (!Array.isArray(state.messages)) state.messages = []
  if (state.messages.length === 0) {
    state.messages.push({ role: 'user', content: SEED_USER_MESSAGE })
  }

  const ctx: ToolContext = {
    runId:        run.id,
    weekStart:    run.week_start ?? mondayOf(new Date()),
    workerId,
    dashboardUrl: DASHBOARD_URL,
  }

  const cost: CostTotals = { ...ZERO_COST, ...(run.cost_tokens ?? {}) }
  let steps = run.steps_taken ?? 0
  let concluded = false
  let briefId: string | undefined
  let failure: string | undefined
  const startMs = Date.now()

  // Start a step only while a full per-call timeout still fits the wall-clock —
  // so the runtime never hard-kills us mid-step (which would strand the lock).
  while (
    Date.now() - startMs + PER_CALL_TIMEOUT_MS <= WALL_CLOCK_BUDGET_MS &&
    steps < run.max_steps && !concluded
  ) {
    let res
    try {
      res = await callClaude({
        model:       STRATEGIST_MODEL,
        system,
        messages:    state.messages,
        tools:       BRAIN_TOOLS,
        effort:      STRATEGIST_EFFORT,
        maxTokens:   STRATEGIST_MAX_TOKENS,
        cachePrefix: true,
        timeoutMs:   PER_CALL_TIMEOUT_MS,
      })
    } catch (e) {
      // TRANSIENT (timeout/abort, 5xx, network): do NOT fail the run. Keep it
      // 'thinking' and let the next tick retry the SAME state — unless we've hit
      // a string of these, which signals a step that genuinely won't fit.
      const retries = (state.retries ?? 0) + 1
      state.retries = retries
      if (retries >= MAX_TRANSIENT_RETRIES) {
        failure = `persistent transient errors (${retries}×): ${e instanceof Error ? e.message : String(e)}`
      }
      break
    }
    state.retries = 0   // a clean call clears the transient counter
    steps++

    // Roll up cost + persist one ledger row per call.
    cost.input_tokens          += res.inputTokens
    cost.output_tokens         += res.outputTokens
    cost.cache_read_tokens     += res.cacheReadTokens
    cost.cache_creation_tokens += res.cacheCreationTokens
    cost.calls                 += 1
    cost.est_usd = Math.round((cost.est_usd + estimateUsd({
      model: res.model, inputTokens: res.inputTokens, outputTokens: res.outputTokens,
      cacheReadTokens: res.cacheReadTokens, cacheCreationTokens: res.cacheCreationTokens,
    })) * 10000) / 10000
    await logClaudeCost(supabase, {
      sourceFn: 'strategist-brain', runId: run.id, model: res.model,
      inputTokens: res.inputTokens, outputTokens: res.outputTokens,
      cacheReadTokens: res.cacheReadTokens, cacheCreationTokens: res.cacheCreationTokens,
    })

    // Record the assistant turn verbatim (tool_use blocks must round-trip exactly).
    state.messages.push({ role: 'assistant', content: res.content })

    if (res.stop_reason === 'tool_use') {
      const toolUses = res.content.filter((b): b is Extract<MessageContentBlock, { type: 'tool_use' }> => b.type === 'tool_use')
      const toolResults: MessageContentBlock[] = []
      for (const tu of toolUses) {
        const outcome = await dispatchTool(supabase, ctx, tu.name, tu.input)
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: JSON.stringify(outcome.result),
        })
        if (outcome.concluded) { concluded = true; briefId = outcome.briefId }
      }
      state.messages.push({ role: 'user', content: toolResults })
      if (concluded) break
    } else {
      // The model ended its turn without calling a tool. The contract requires
      // conclude_brief — nudge once, then fail-safe so we never loop forever.
      if (state.nudged) {
        failure = 'model ended turn twice without calling conclude_brief'
        break
      }
      state.nudged = true
      state.messages.push({
        role: 'user',
        content: 'You ended your turn without concluding. When your analysis is complete you MUST call conclude_brief exactly once (a thin brief is fine). If you still need to investigate, call a drilldown tool.',
      })
    }
  }

  // Hit the step cap without concluding → fail-safe.
  if (!concluded && steps >= run.max_steps && !failure) {
    failure = `reached max_steps (${run.max_steps}) without concluding`
  }

  // Checkpoint. Release the lock either way: a still-thinking run resumes next
  // tick; a concluded/failed run is terminal.
  const patch: Record<string, unknown> = {
    state, steps_taken: steps, cost_tokens: cost,
    locked_until: null, updated_at: new Date().toISOString(),
  }
  if (concluded)      { patch.status = 'brief_ready'; patch.brief_id = briefId }
  else if (failure)   { patch.status = 'failed'; patch.error = failure }
  await supabase.from('strategist_runs').update(patch).eq('id', run.id)

  return json({
    ok: true, run_id: run.id, steps_taken: steps,
    status: concluded ? 'brief_ready' : failure ? 'failed' : 'thinking',
    concluded, brief_id: briefId, failure, cost_calls: cost.calls,
  })
}

// ─────────────────────────────────────────────────────────────────────────────
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  const url = new URL(req.url)
  let mode = url.searchParams.get('mode') ?? ''
  let trigger = url.searchParams.get('trigger') ?? 'cron'
  if (!mode && req.method === 'POST') {
    const body = await req.json().catch(() => ({})) as { mode?: string; trigger?: string }
    mode = body.mode ?? ''
    trigger = body.trigger ?? trigger
  }

  const supabase = createSupabase()
  const workerId = `brain-${crypto.randomUUID().slice(0, 8)}`
  try {
    if (mode === 'kickoff') return await kickoff(supabase, trigger)
    if (mode === 'advance') return await advance(supabase, workerId)
    return json({ ok: false, error: 'mode must be "kickoff" or "advance"' }, 400)
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500)
  }
})
