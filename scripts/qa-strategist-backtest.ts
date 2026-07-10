// qa-strategist-backtest.ts — compare the strategist BRAIN on two models
// (baseline Opus 4.8 vs candidate Fable 5) before flipping MODEL_STRATEGIST live.
//
// READ-ONLY. It SELECTs past snapshots from strategist_runs, replays each one
// through the FULL production ReAct loop on both models, and prints the two
// resulting briefs + investigation paths side by side. It writes NOTHING: the
// three write-tools (record_thesis / emit_signal / conclude_brief) are stubbed,
// so no thesis, signal, brief, or ledger row is ever persisted, and no function
// is deployed. The only DB traffic is read-only: the strategist_runs SELECT and
// the drilldown_* tools (which are live prod SELECTs against woo_orders etc.).
//
// Why a NEW harness (not qa-model-backtest.ts): that one is single-shot binary
// pass/fail on rendered images. The strategist is a multi-step tool-using loop
// producing a qualitative brief with no "correct" answer — you judge the two
// briefs yourself. This harness IMPORTS the real prod prompt/tools/loop so the
// comparison can't drift from what production actually runs.
//
// ⚠️ Fable 5 requires 30-day data retention on the workspace (Console) or every
//    call 400s. Enable that before running with the candidate = fable.
//
// Run (Deno):
//   SUPABASE_SERVICE_ROLE_KEY=eyJ... ANTHROPIC_API_KEY=sk-ant-... \
//     deno run --allow-net --allow-env scripts/qa-strategist-backtest.ts [limit]
//
// Optional env: SUPABASE_URL (defaults to prod),
//   STRATEGIST_BASELINE_MODEL  (default claude-opus-4-8),
//   STRATEGIST_CANDIDATE_MODEL (default claude-fable-5).

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { callClaude, type ChatMessage, type MessageContentBlock } from '../supabase/functions/seo-agent/claude.ts'
import { STRATEGIST_BRAIN_SYSTEM_PROMPT } from '../supabase/functions/seo-agent/prompts/strategistBrain.ts'
import { BRAIN_TOOLS, dispatchTool, type ToolContext } from '../supabase/functions/strategist-brain/tools.ts'
import { STRATEGIST_EFFORT, STRATEGIST_MAX_TOKENS, estimateUsd } from '../supabase/functions/seo-agent/strategistConfig.ts'

const SUPABASE_URL  = Deno.env.get('SUPABASE_URL') ?? 'https://ytydgldyeygpzmlxvpvb.supabase.co'
const SERVICE_KEY   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const ANTHROPIC_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? ''
const BASELINE  = Deno.env.get('STRATEGIST_BASELINE_MODEL')  ?? 'claude-opus-4-8'
const CANDIDATE = Deno.env.get('STRATEGIST_CANDIDATE_MODEL') ?? 'claude-fable-5'
const LIMIT = Number(Deno.args[0] ?? '4')      // strategist runs are expensive — default small
const MAX_STEPS = 12                            // mirror STRATEGIST_MAX_STEPS

if (!SERVICE_KEY || !ANTHROPIC_KEY) {
  console.error('Missing SUPABASE_SERVICE_ROLE_KEY and/or ANTHROPIC_API_KEY in env.')
  Deno.exit(1)
}

// Same system-prompt assembly as strategist-brain/index.ts advance().
const SNAPSHOT_SEP = '\n\n═══ BUSINESS SNAPSHOT (revenue-first; { "error": ... } = a sense that went dark) ═══\n'
const SEED_USER_MESSAGE =
  'Begin this cycle. Your business snapshot and active theses are in your system context. ' +
  'Reason step by step, investigate with drilldowns where a decision genuinely depends on data you don\'t yet have, ' +
  'run your adversarial self-check, then call conclude_brief exactly once. Concluding with little or nothing to do is valid if the data supports it.'

const WRITE_TOOLS = new Set(['record_thesis', 'emit_signal', 'conclude_brief'])

// Read-only dispatch: real drilldowns pass through; write-tools are stubbed so
// the loop runs to a real brief without persisting anything.
async function dispatchReadOnly(
  supabase: SupabaseClient, ctx: ToolContext, name: string, input: Record<string, unknown>,
): Promise<{ result: unknown; concluded?: boolean; brief?: Record<string, unknown> }> {
  if (name === 'conclude_brief') return { result: { ok: true, note: 'backtest — brief captured, not persisted' }, concluded: true, brief: input }
  if (name === 'record_thesis')  return { result: { ok: true, thesis_id: 'backtest-stub', note: 'not persisted' } }
  if (name === 'emit_signal')    return { result: { ok: true, signal_id: 'backtest-stub', note: 'not persisted' } }
  return await dispatchTool(supabase, ctx, name, input)   // drilldown_* — real, read-only
}

interface RunResult {
  model: string
  concluded: boolean
  stopReason: string
  refused: boolean
  errored: string | null             // set if a step timed out / threw
  steps: number
  toolPath: string[]                 // ordered tool names the model called
  brief: Record<string, unknown> | null
  usd: number
}

async function replay(
  supabase: SupabaseClient, model: string, snapshot: unknown, ctx: ToolContext,
): Promise<RunResult> {
  const system = STRATEGIST_BRAIN_SYSTEM_PROMPT + SNAPSHOT_SEP + JSON.stringify(snapshot)
  const messages: ChatMessage[] = [{ role: 'user', content: SEED_USER_MESSAGE }]
  const toolPath: string[] = []
  let steps = 0, usd = 0, concluded = false, refused = false, stopReason = 'unknown'
  let errored: string | null = null
  let brief: Record<string, unknown> | null = null

  while (steps < MAX_STEPS && !concluded) {
    steps++
    // Generous per-step timeout: no edge wall-clock here, and Fable at high
    // effort can spend several minutes on one hard reasoning step. A step that
    // times out or throws is RECORDED (not fatal), like prod's transient path.
    let res
    try {
      res = await callClaude({
        model, system, messages, tools: BRAIN_TOOLS,
        effort: STRATEGIST_EFFORT, maxTokens: STRATEGIST_MAX_TOKENS,
        cachePrefix: true, timeoutMs: 600_000,
      })
    } catch (e) {
      errored = (e instanceof Error && e.name === 'AbortError')
        ? 'step exceeded 10min timeout'
        : (e instanceof Error ? e.message : String(e))
      break
    }
    stopReason = res.stop_reason
    usd += estimateUsd({ model: res.model, inputTokens: res.inputTokens, outputTokens: res.outputTokens, cacheReadTokens: res.cacheReadTokens, cacheCreationTokens: res.cacheCreationTokens })

    if (res.stop_reason === 'refusal') { refused = true; break }   // Fable safety classifier — prod would fall back to Opus

    messages.push({ role: 'assistant', content: res.content })
    if (res.stop_reason === 'tool_use') {
      const toolUses = res.content.filter((b): b is Extract<MessageContentBlock, { type: 'tool_use' }> => b.type === 'tool_use')
      const toolResults: MessageContentBlock[] = []
      for (const tu of toolUses) {
        toolPath.push(tu.name)
        const outcome = await dispatchReadOnly(supabase, ctx, tu.name, tu.input)
        toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(outcome.result) })
        if (outcome.concluded) { concluded = true; brief = outcome.brief ?? null }
      }
      messages.push({ role: 'user', content: toolResults })
    } else {
      // Ended turn without a tool — nudge once toward conclude_brief, like prod.
      messages.push({ role: 'user', content: 'You ended your turn without concluding. Call conclude_brief exactly once (a thin brief is fine), or a drilldown if you still need data.' })
    }
  }
  return { model, concluded, stopReason, refused, errored, steps, toolPath, brief, usd }
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY)

console.log(`Pulling up to ${LIMIT} past strategist runs from ${SUPABASE_URL} ...`)
const { data: runs, error } = await supabase
  .from('strategist_runs')
  .select('id, week_start, snapshot')
  .not('snapshot', 'is', null)
  .order('created_at', { ascending: false })
  .limit(LIMIT)
if (error) { console.error(`strategist_runs fetch failed: ${error.message}`); Deno.exit(1) }
if (!runs?.length) { console.log('No past runs with a stored snapshot. Nothing to compare.'); Deno.exit(0) }
console.log(`-> ${runs.length} snapshot(s) to replay on ${BASELINE} vs ${CANDIDATE}\n`)

let baseUsd = 0, candUsd = 0
for (const run of runs) {
  const ctx: ToolContext = { runId: `backtest-${run.id}`, weekStart: run.week_start, workerId: 'backtest', dashboardUrl: 'https://backtest.local' }
  console.log(`\n════════ snapshot from run ${String(run.id).slice(0, 8)} (week ${run.week_start}) ════════`)

  // Baseline first, then candidate — sequential so we don't double the rate-limit burst.
  const base = await replay(supabase, BASELINE, run.snapshot, ctx)
  const cand = await replay(supabase, CANDIDATE, run.snapshot, ctx)
  baseUsd += base.usd; candUsd += cand.usd

  for (const r of [base, cand]) {
    console.log(`\n── ${r.model} ──`)
    if (r.refused) { console.log(`  ⚠️ REFUSED (stop_reason=refusal) — prod would fall back to Opus here.`); continue }
    if (r.errored) { console.log(`  ⚠️ ERRORED after ${r.steps} step(s): ${r.errored}  (~$${r.usd.toFixed(4)} spent before failure)`); continue }
    console.log(`  concluded=${r.concluded}  steps=${r.steps}  ~$${r.usd.toFixed(4)}  stop=${r.stopReason}`)
    console.log(`  investigation path: ${r.toolPath.join(' → ') || '(none)'}`)
    if (r.brief) console.log(`  BRIEF:\n${JSON.stringify(r.brief, null, 2).split('\n').map((l) => '    ' + l).join('\n')}`)
  }
}

console.log('\n──────────── COST SUMMARY ────────────')
console.log(`${BASELINE}:  ~$${baseUsd.toFixed(4)} over ${runs.length} run(s)  (~$${(baseUsd / runs.length).toFixed(4)}/run)`)
console.log(`${CANDIDATE}: ~$${candUsd.toFixed(4)} over ${runs.length} run(s)  (~$${(candUsd / runs.length).toFixed(4)}/run)`)
console.log('\n──────────── READ ────────────')
console.log('• Strategy has no "correct" answer — read the two briefs per snapshot and judge:')
console.log('  – Did the candidate surface a real, revenue-relevant move the baseline missed (or vice-versa)?')
console.log('  – Is its investigation path purposeful (drilldowns that a decision hinged on) or wandering?')
console.log('  – Any refusals? Those are the case for wiring the Opus fallback before going live.')
console.log(`• Cost: Fable is $10/$50 vs Opus $5/$25 per MTok. Weigh any quality gain against ~2× spend + the $${150}/mo ceiling.`)
