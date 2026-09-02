// qa-strategist-backtest.ts — replay REAL strategist runs on a rival model
// before letting one anywhere near the weekly cron.
//
// Fable 5 holds the strategist seat because a real-snapshot backtest beat Opus
// 4.8. Replacing it on weaker evidence than it was chosen on would be a step
// down, so this is the same bar: real snapshots, real tools, blind cross-judging.
//
// Run (Deno):
//   SUPABASE_SERVICE_ROLE_KEY=eyJ... ANTHROPIC_API_KEY=sk-ant-... GEMINI_API_KEY=... \
//     deno run --allow-net --allow-env scripts/qa-strategist-backtest.ts [snapshots]
//
// Optional:
//   CHALLENGER_MODEL=gemini-3.1-pro-preview  (default; NEVER a flash tier —
//                                      the incumbent is a top reasoning model)
//   INCUMBENT_MODEL=claude-fable-5
//   MAX_STEPS=8
//
// ── WHAT THIS IS, AND WHAT IT IS NOT ────────────────────────────────────────
//
// 1. READ-ONLY. The brain has three WRITE tools — record_thesis, emit_signal,
//    conclude_brief. They are INTERCEPTED here: the payload is captured and a
//    synthetic success is returned, so nothing is persisted. Those captured
//    payloads ARE the output being compared. The nine read tools run for real.
//
// 2. IT IS MODEL-VS-MODEL, NOT A HISTORICAL REPRODUCTION. The snapshot is the
//    real one from that week, but the read tools query LIVE data — today's, not
//    that week's. Both arms see exactly the same conditions, so the head-to-head
//    is fair; it just is not a reconstruction of what happened then. Do not read
//    a difference here as "what the agent would have decided in August".
//
// 3. JUDGE BIAS IS NOT AVERAGED AWAY. Each vendor would flatter its own output,
//    so BOTH judge every pair, blind, with positions swapped between them.
//    Agreement between two rival judges is the only signal treated as strong;
//    where they disagree the report says so instead of inventing a winner.
//
// 4. COST IS REPORTED AS TOKENS. Prices rot; token counts do not. Note that the
//    incumbent's real economics also depend on prompt caching, which the Gemini
//    path does not reproduce — see strategistConfig.ts.
//
// A run costs real money on both vendors. Start with 1-2 snapshots.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { callClaude, type ChatMessage } from '../supabase/functions/seo-agent/claude.ts'
import { STRATEGIST_BRAIN_SYSTEM_PROMPT } from '../supabase/functions/seo-agent/prompts/strategistBrain.ts'
import { BRAIN_TOOLS, dispatchTool, type ToolContext } from '../supabase/functions/strategist-brain/tools.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? 'https://ytydgldyeygpzmlxvpvb.supabase.co'
const PROJECT_REF  = SUPABASE_URL.replace(/^https:\/\//, '').split('.')[0]

// Prefer fetching the CURRENT service_role key over having a human paste one.
//
// Pasting it is where this harness kept dying, and for a subtle reason: a key
// can carry the right ref, the right role and a valid expiry and STILL be
// rejected, because it was signed with a JWT secret that has since been
// rotated. Nothing about the token looks wrong — the project just stopped
// trusting it. (Same failure took down the MFlow scraper in June 2026.)
//
// SUPABASE_ACCESS_TOKEN is the CLI's own credential, already present on any
// machine that has run `supabase login`, and asking the Management API for the
// key always returns the live one. An explicit SUPABASE_SERVICE_ROLE_KEY still
// wins if you set it.
async function keyWorks(key: string): Promise<boolean> {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/strategist_runs?select=id&limit=1`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } })
    return r.ok
  } catch { return false }
}

async function resolveServiceKey(): Promise<string> {
  // An explicit key is TESTED, not trusted. A stale one left exported in the
  // shell from an earlier attempt looks identical to a good one and would
  // silently shadow the live key on every subsequent run — which is exactly how
  // three runs in a row failed with the same 'Invalid API key'.
  const explicit = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')?.trim()
  if (explicit) {
    if (await keyWorks(explicit)) return explicit
    console.warn(`SUPABASE_SERVICE_ROLE_KEY is set (${explicit.length}c) but the project REJECTS it — `
               + 'most likely signed with a rotated JWT secret. Ignoring it and fetching the live key.')
  }
  const token = Deno.env.get('SUPABASE_ACCESS_TOKEN')?.trim()
  if (!token) return ''
  try {
    const r = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/api-keys`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!r.ok) return ''
    const keys = await r.json() as Array<{ name: string; api_key: string }>
    const k = keys.find(x => x.name === 'service_role')?.api_key ?? ''
    if (k) console.log('service_role key fetched from the Management API (current, not pasted)')
    return k
  } catch { return '' }
}
const SERVICE_KEY = await resolveServiceKey()
const INCUMBENT    = Deno.env.get('INCUMBENT_MODEL')  ?? 'claude-fable-5'
// gemini-2.5-pro is NOT usable: the API returns 404 "no longer available to new
// users. Please update your code to use models/gemini-3.1-pro-preview". Note it
// still APPEARS in ListModels — listing a model does not mean this key may call
// it, and only a real call proves it. Same trap as gemini-3.1-flash.
const CHALLENGER   = Deno.env.get('CHALLENGER_MODEL') ?? 'gemini-3.1-pro-preview'
const MAX_STEPS    = Number(Deno.env.get('MAX_STEPS') ?? '8')
const N_SNAPSHOTS  = Number(Deno.args[0] ?? '2')

if (!SERVICE_KEY) {
  console.error('No Supabase service_role key. Either run `supabase login` (then this fetches the')
  console.error('current key itself) or export SUPABASE_SERVICE_ROLE_KEY explicitly.')
  Deno.exit(1)
}
if (!Deno.env.get('ANTHROPIC_API_KEY') || !Deno.env.get('GEMINI_API_KEY')) {
  console.error('Need ANTHROPIC_API_KEY and GEMINI_API_KEY in env.')
  Deno.exit(1)
}
if (/flash/i.test(CHALLENGER)) {
  console.error(`CHALLENGER_MODEL="${CHALLENGER}" is a flash tier. The incumbent is a top-tier reasoning`)
  console.error('model chosen by backtest; comparing against flash tells you nothing useful. Use a pro tier.')
  Deno.exit(1)
}

console.log(`keys loaded: supabase=${SERVICE_KEY.length}c anthropic=${(Deno.env.get('ANTHROPIC_API_KEY') ?? '').length}c gemini=${(Deno.env.get('GEMINI_API_KEY') ?? '').length}c`)

const supabase = createClient(SUPABASE_URL, SERVICE_KEY)

// Mirrors strategist-brain/index.ts.
const SEED_USER_MESSAGE =
  'Study the snapshot. Investigate what looks wrong or promising using your tools, ' +
  'run your adversarial self-check, then call conclude_brief exactly once. ' +
  'Concluding with little or nothing to do is valid if the data supports it.'

const WRITE_TOOLS = new Set(['record_thesis', 'emit_signal', 'conclude_brief'])

interface ArmResult {
  model:        string
  steps:        number
  toolCalls:    string[]
  writes:       Array<{ tool: string; input: Record<string, unknown> }>
  inputTokens:  number
  outputTokens: number
  concluded:    boolean
  error?:       string
}

// One full ReAct loop, with writes intercepted.
async function runArm(model: string, snapshot: unknown, weekStart: string): Promise<ArmResult> {
  const system = STRATEGIST_BRAIN_SYSTEM_PROMPT +
    '\n\n═══ BUSINESS SNAPSHOT (revenue-first; { "error": ... } = a sense that went dark) ═══\n' +
    JSON.stringify(snapshot)

  const messages: ChatMessage[] = [{ role: 'user', content: SEED_USER_MESSAGE }]
  const ctx: ToolContext = {
    runId:        crypto.randomUUID(),
    weekStart,
    workerId:     'backtest',
    dashboardUrl: 'https://coffeeflow-neon.vercel.app',
  }
  const out: ArmResult = {
    model, steps: 0, toolCalls: [], writes: [],
    inputTokens: 0, outputTokens: 0, concluded: false,
  }

  while (out.steps < MAX_STEPS && !out.concluded) {
    // A step can legitimately take a minute or more. Without a heartbeat the
    // whole arm looks hung, which is exactly how the first run was read.
    Deno.stdout.writeSync(new TextEncoder().encode(
      `\r\x1b[2K    ${model} step ${out.steps + 1}/${MAX_STEPS} … `))
    let res
    try {
      res = await callClaude({
        model,
        system,
        messages,
        tools:     BRAIN_TOOLS,
        effort:    'high',
        maxTokens: 12000,
        timeoutMs: 120_000,
        // No sourceFn: a backtest must not pollute the production cost ledger.
      })
    } catch (e: any) {
      out.error = e?.message ?? String(e)
      // What the model had just asked for is the evidence for WHY the next call
      // was rejected — a 400 with no request context is undebuggable.
      const lastAsst = messages[messages.length - 2]
      const lastUser = messages[messages.length - 1]
      if (lastUser && Array.isArray(lastUser.content)) {
        const names = (lastUser.content as any[])
          .filter(b => b?.type === 'tool_result').length
        const asstNames = Array.isArray((lastAsst as any)?.content)
          ? ((lastAsst as any).content as any[]).filter(b => b?.type === 'tool_use').map(b => b.name)
          : []
        out.error += `\n   context: previous turn requested [${asstNames.join(', ')}]`
                   + ` and we replied with ${names} tool_result block(s)`
                   + (new Set(asstNames).size !== asstNames.length
                       ? ' — NOTE: DUPLICATE function names in one turn' : '')
      }
      break
    }
    out.steps++
    out.inputTokens  += res.inputTokens
    out.outputTokens += res.outputTokens

    const toolUses = res.content.filter(b => b.type === 'tool_use') as Array<
      { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }>
    Deno.stdout.writeSync(new TextEncoder().encode(
      `${toolUses.length ? toolUses.map(t => t.name).join(',') : '(prose, done)'}`))
    if (toolUses.length === 0) break   // model answered in prose; loop is done

    messages.push({ role: 'assistant', content: res.content })
    const results: any[] = []
    for (const tu of toolUses) {
      out.toolCalls.push(tu.name)
      if (WRITE_TOOLS.has(tu.name)) {
        // THE INTERCEPT. Capture what it wanted to write; persist nothing.
        out.writes.push({ tool: tu.name, input: tu.input })
        if (tu.name === 'conclude_brief') out.concluded = true
        results.push({
          type: 'tool_result', tool_use_id: tu.id,
          content: JSON.stringify({ ok: true, note: 'backtest: captured, not persisted' }),
        })
        continue
      }
      const r = await dispatchTool(supabase, ctx, tu.name, tu.input)
      results.push({
        type: 'tool_result', tool_use_id: tu.id,
        content: typeof r === 'string' ? r : JSON.stringify(r),
      })
    }
    messages.push({ role: 'user', content: results })
  }
  return out
}

// ── Blind cross-judging ─────────────────────────────────────────────────────
const JUDGE_SYSTEM = `You are grading two strategic briefs produced for the SAME Israeli specialty-coffee
business from the SAME data snapshot. They are labelled A and B; you do not know which model wrote either,
and the order is randomised.

Judge ONLY on decision quality for the business owner:
  · Is the reasoning grounded in the actual numbers, or generic advice?
  · Does it identify something non-obvious and act on it?
  · Would following it plausibly move bean revenue?
  · Is it honest about uncertainty rather than confidently vague?

Ignore length, formatting and tone. A shorter brief that finds a real problem beats a longer one that
restates the dashboard.

Reply with STRICT JSON only:
{"winner":"A"|"B"|"tie","confidence":"low"|"medium"|"high","why":"one or two sentences"}`

async function judge(model: string, a: string, b: string): Promise<{ winner: string; confidence: string; why: string } | null> {
  try {
    const res = await callClaude({
      model,
      system:    JUDGE_SYSTEM,
      messages:  [{ role: 'user', content: `=== BRIEF A ===\n${a}\n\n=== BRIEF B ===\n${b}` }],
      // 6000, not 700. On a thinking-only model (gemini-3.1-pro-preview cannot
      // disable thinking) those tokens come out of THIS budget before any
      // visible text, so a tight cap returns an empty answer with no error at
      // all — which is how the judge silently returned '?' while the HTTP call
      // succeeded. Judging two briefs is worth thinking about anyway.
      maxTokens: 6000,
      timeoutMs: 120_000,
      // Gemini-only, ignored by Claude: makes the verdict impossible to mangle.
      responseSchema: {
        type: 'object',
        properties: {
          winner:     { type: 'string', description: 'A, B or tie' },
          confidence: { type: 'string', description: 'low, medium or high' },
          why:        { type: 'string' },
        },
        required: ['winner', 'confidence', 'why'],
      },
    })
    const m = res.text.match(/\{[\s\S]*\}/)
    if (!m) {
      // Say WHY there is no verdict. A judge that returns nothing is a broken
      // judge, not a neutral one, and must never be mistaken for disagreement.
      console.warn(`   judge ${model} produced no JSON `
        + `(out=${res.outputTokens} tokens, stop=${res.stop_reason}) — `
        + (res.outputTokens < 20 ? 'output truncated, almost certainly thinking eating the budget'
                                 : `text: ${res.text.slice(0, 120)}`))
      return null
    }
    return JSON.parse(m[0])
  } catch (e: any) {
    console.warn(`   judge ${model} failed: ${e?.message ?? e}`)
    return null
  }
}

const briefText = (r: ArmResult): string =>
  r.writes.length === 0
    ? '(no brief produced)'
    : r.writes.map(w => `[${w.tool}] ${JSON.stringify(w.input)}`).join('\n\n')

// ── Main ────────────────────────────────────────────────────────────────────
const { data: runs, error } = await supabase
  .from('strategist_runs')
  .select('id, week_start, snapshot')
  .eq('status', 'brief_ready')
  .not('snapshot', 'is', null)
  .order('created_at', { ascending: false })
  .limit(N_SNAPSHOTS)
if (error || !runs?.length) {
  console.error('Could not load strategist_runs:', error?.message ?? 'none found')
  Deno.exit(1)
}

console.log(`\nStrategist backtest — ${INCUMBENT} (incumbent) vs ${CHALLENGER} (challenger)`)
console.log(`${runs.length} real snapshot(s), max ${MAX_STEPS} steps per arm, writes intercepted\n`)

const tally = { incumbent: 0, challenger: 0, tie: 0, disagreed: 0, failed: 0, judgeless: 0 }

for (const run of runs) {
  console.log(`\n══ week ${run.week_start} (run ${String(run.id).slice(0, 8)}) ══`)

  const inc = await runArm(INCUMBENT,  run.snapshot, run.week_start)
  console.log('')
  console.log(`  ${INCUMBENT.padEnd(18)} steps=${inc.steps} tools=${inc.toolCalls.length} `
            + `writes=${inc.writes.length} in=${inc.inputTokens} out=${inc.outputTokens}`
            + `${inc.error ? ' ERROR (full):\n' + inc.error : ''}`)

  const chl = await runArm(CHALLENGER, run.snapshot, run.week_start)
  console.log('')
  console.log(`  ${CHALLENGER.padEnd(18)} steps=${chl.steps} tools=${chl.toolCalls.length} `
            + `writes=${chl.writes.length} in=${chl.inputTokens} out=${chl.outputTokens}`
            + `${chl.error ? ' ERROR (full):\n' + chl.error : ''}`)

  // An arm that ERRORED produced nothing to judge. Judging it anyway burns money
  // and, worse, files the result as "inconclusive" when the truth is "the run
  // did not happen" — which is how a totally broken run can look like a tie.
  if (inc.error || chl.error) {
    tally.failed++
    console.log('  → ARM FAILED — nothing to judge. Fix the error above and re-run;')
    console.log('    this is NOT evidence about either model.')
    continue
  }

  // Positions swapped between the two judges so neither sees its own output in
  // the same slot — a judge that simply favours position A cancels out.
  const incText = briefText(inc), chlText = briefText(chl)
  console.log('  judging (both vendors, blind, positions swapped) …')
  const jClaude = await judge(INCUMBENT,  incText, chlText)   // A=incumbent
  const jGemini = await judge(CHALLENGER, chlText, incText)   // A=challenger

  const claudeSays = jClaude ? (jClaude.winner === 'A' ? 'incumbent' : jClaude.winner === 'B' ? 'challenger' : 'tie') : '?'
  const geminiSays = jGemini ? (jGemini.winner === 'A' ? 'challenger' : jGemini.winner === 'B' ? 'incumbent' : 'tie') : '?'
  console.log(`  judge(${INCUMBENT}):  ${claudeSays}  [${jClaude?.confidence ?? '-'}] ${jClaude?.why ?? ''}`)
  console.log(`  judge(${CHALLENGER}): ${geminiSays}  [${jGemini?.confidence ?? '-'}] ${jGemini?.why ?? ''}`)

  if (claudeSays === '?' && geminiSays === '?') {
    tally.judgeless++
    console.log('  → BOTH JUDGES FAILED — no verdict. Not disagreement, not evidence.')
  } else if (claudeSays === geminiSays && claudeSays !== '?') {
    if (claudeSays === 'incumbent')  tally.incumbent++
    else if (claudeSays === 'challenger') tally.challenger++
    else tally.tie++
    console.log(`  → AGREED: ${claudeSays}`)
  } else {
    tally.disagreed++
    console.log('  → judges DISAGREE — no winner recorded for this snapshot')
  }
}

console.log('\n───────────────────────────────────────────')
console.log(`agreed incumbent wins : ${tally.incumbent}`)
console.log(`agreed challenger wins: ${tally.challenger}`)
console.log(`agreed ties           : ${tally.tie}`)
console.log(`judges disagreed      : ${tally.disagreed}   ← not evidence either way`)
console.log(`arms that ERRORED     : ${tally.failed}   ← run did not happen; fix and re-run`)
console.log(`both judges failed    : ${tally.judgeless}   ← no verdict, not a tie`)
console.log('\nOnly AGREED results are signal. A challenger that does not clearly win should not')
console.log('take the seat: the incumbent is the known quantity and switching has its own costs')
console.log('(prompt caching lost, refusal fallback replaced, resumed-state path unproven).\n')
