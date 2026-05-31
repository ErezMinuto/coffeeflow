// Minuto Organic Marketing — deep-research worker.
//
// Drains 'deep_research' tasks via the same claim-lock pattern other
// workers use. Each task gets a multi-turn Claude reasoning loop with
// Anthropic's native web_search tool + the worker's own URL-fetch +
// query-our-data tools. Output: structured research report stored in
// result_data.
//
// Use cases this enables (per user, 2026-05-27):
//   • GEO/LLMO research — "how do LLMs describe Minuto when asked about
//     Israeli specialty coffee? what authority signals would make them
//     cite us more?"
//   • Competitor deep dives — "profile Aroma's full content+SEO strategy"
//   • Content-topic research — "is there organic demand for cold-brew
//     content in IL Hebrew search? what angle would win?"
//   • Audience-segment research — "what do at-risk customers (>90d
//     since last) care about that we're not addressing?"
//
// Tools available to the research loop:
//   1. web_search       — Anthropic's native, returns web results inline
//   2. fetch_url        — read a specific URL the model wants to deep-read
//   3. query_minuto     — execute one of a small allowlist of safe SQL
//                          queries against our own tables (ai_visibility_probes,
//                          ga4_pages_daily, industry_articles, customer_rfm)
//
// The loop is capped at brief.max_research_turns (default 5).

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import {
  createSupabase,
  claimNextTask,
  markTaskCompleted,
  markTaskFailed,
} from '../seo-agent/db.ts'
import {
  callClaude,
  MODEL_ORCHESTRATOR,
  type MessageContentBlock,
  type ToolDefinition,
  type ChatMessage as ApiChatMessage,
} from '../seo-agent/claude.ts'
import type { SeoTaskRow, DeepResearchBrief } from '../seo-agent/types.ts'
import { writeBriefing } from '../seo-agent/briefingWriter.ts'

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

const DEFAULT_MAX_TURNS = 5

// ─────────────────────────────────────────────────────────────────────────
// Tool catalogue — what the research model can do.
//
// web_search is Anthropic's native tool — they execute the search server-
// side, return results as part of the same response stream. Cannot fail
// transport-side; the model sees the results immediately.
//
// fetch_url + query_minuto are worker-side tools — we get a tool_use
// block from Claude, execute server-side, and feed the result back as
// a tool_result content block on the next user message.
// ─────────────────────────────────────────────────────────────────────────

const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'fetch_url',
    description: 'Fetch the readable text of a specific URL. Returns the first ~6KB of body text (HTML stripped). Use when web_search surfaces a result that needs deeper reading. Do NOT use for paywalled / JS-heavy SPAs.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full http(s) URL.' },
      },
      required: ['url'],
    },
  },
  {
    name: 'query_minuto',
    description: 'Run one of a small allowlist of safe pre-defined queries against Minuto\'s own data. Use to ground research in our actual performance / customer / competitor state.',
    input_schema: {
      type: 'object',
      properties: {
        query_name: {
          type: 'string',
          description: 'One of: "top_landing_pages_by_conversions", "ai_visibility_summary", "competitor_co_mentions", "recent_industry_insights", "customer_rfm_segments", "active_learnings", "products_catalog".',
        },
        days: { type: 'number', description: 'Optional lookback window in days. Default 30.' },
        filter_name: { type: 'string', description: 'For products_catalog: optional substring (case-insensitive) to narrow by name (e.g. "Colombia", "decaf", "Lelit"). Omit to return the whole in-stock catalog (up to 200).' },
      },
      required: ['query_name'],
    },
  },
]

// ─────────────────────────────────────────────────────────────────────────
// HTTP entry point — claim one task, run loop, write result.
// ─────────────────────────────────────────────────────────────────────────
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST')    return jsonResponse({ error: 'POST only' }, 405)

  const workerId = `research-${crypto.randomUUID().slice(0, 8)}`
  const supabase = createSupabase()

  let task: SeoTaskRow | null
  try {
    task = await claimNextTask(supabase, 'deep_research', workerId)
  } catch (e: any) {
    console.error(`[seo-worker-research] ${workerId} claim failed: ${e?.message ?? e}`)
    return jsonResponse({ processed: 0, worker_id: workerId, error: e?.message ?? String(e) }, 500)
  }
  if (!task) return jsonResponse({ processed: 0, worker_id: workerId })
  console.log(`[seo-worker-research] ${workerId} claimed task ${task.id}`)

  const brief = task.brief_data as DeepResearchBrief
  const question = (brief?.question ?? '').trim()
  if (!question) {
    await safeMarkFailed(supabase, task, 'brief.question is required (non-empty)', true)
    return jsonResponse({ processed: 1, worker_id: workerId, task_id: task.id, ok: false, error: 'question missing' })
  }
  const scope         = brief.scope ?? 'other'
  const expectedOut   = brief.expected_output ?? 'analysis'
  const maxTurns      = brief.max_research_turns ?? DEFAULT_MAX_TURNS

  console.log(`[seo-worker-research] ${workerId} scope=${scope} expected=${expectedOut} max_turns=${maxTurns}`)

  // Build the system prompt — calibrated to the expected_output shape.
  const systemPrompt = buildResearchSystemPrompt({ scope, expected_output: expectedOut })

  // Multi-turn tool-use loop.
  const messages: ApiChatMessage[] = [{ role: 'user', content: question }]
  const researchLog: Array<{ turn: number; tool_calls: string[]; text_snippet: string }> = []
  let turn = 0
  let finalText = ''
  let lastAssistantText = ''
  let totalInputTokens = 0
  let totalOutputTokens = 0
  let hitTimeBudget = false

  // WALL-CLOCK BUDGET. maxTurns × the old 120s per-turn timeout could reach
  // ~600s — far past the edge isolate's hard ~150-200s wall-clock cap, so
  // the worker got HARD-KILLED mid-run and left its task stuck in
  // 'processing' with an expired lock (claimNextTask now self-heals those,
  // but the real fix is to never crash). Bound the whole loop to ~135s and
  // size each turn's timeout to the remaining budget so we always finalize
  // gracefully (mark the task complete with a partial report) instead of
  // dying.
  // 110s loop budget (not 135s): leaves ~40s headroom for claim +
  // finalize + the channel_discovery briefing write + response
  // serialization, so even a SYNCHRONOUS caller gets a clean response
  // inside the 150s gateway window (the cron drainer is fire-and-forget
  // and doesn't care, but manual/chat triggers do).
  // TWO-PHASE BUDGET (isolate hard-killed at ~150s wall-clock):
  //   phase 1 — research/tool-gathering, confined to the first GATHER_DEADLINE_MS
  //   phase 2 — a GUARANTEED text-only synthesis with SYNTH_TIMEOUT_MS to itself
  // The earlier single-budget design starved synthesis: a 2.7k-token report
  // needs ~45-50s to generate, but a hung web_search turn left synthesis only
  // 15-30s, so it aborted MID-GENERATION and saved an empty final_text (the
  // exact failure: turn-3 abort → starved synth → final_len 0). Now research
  // is hard-stopped at 85s and synthesis always gets its own 50s, all inside
  // a ~140s envelope so even a synchronous caller stays under the 150s cap.
  const GATHER_DEADLINE_MS   = 85_000   // stop STARTING research turns after this
  const RESEARCH_TURN_CAP_MS = 38_000   // a single stalled turn aborts here
  const SYNTH_TIMEOUT_MS     = 50_000   // synthesis gets its own full window
  const ISOLATE_CEILING_MS   = 145_000  // never run a call past this elapsed
  const MIN_TURN_MS          = 16_000
  const loopStartedAt        = Date.now()

  // Track tools to enable Anthropic web_search via the per-call config —
  // it's not in our generic ToolDefinition type since it's a built-in.
  // We pass it as an extra in the body via the `tools` array; Anthropic
  // recognizes `{type: 'web_search_20250305', name: 'web_search'}`.
  const fullTools: any[] = [
    // Keep total searches LOW. web_search is server-executed by Anthropic and
    // each search adds latency; letting the model front-load many in one turn
    // is what produces the >38s hangs that abort the turn. A budget-bounded
    // run only completes ~2-3 turns anyway, so 6 searches is ample and keeps
    // every turn comfortably under the per-turn cap.
    { type: 'web_search_20250305', name: 'web_search', max_uses: Math.min(6, maxTurns * 2) },
    ...TOOL_DEFINITIONS,
  ]

  let loopError: string | null = null
  try {
  while (turn < maxTurns) {
    // Stop STARTING research turns once we're inside GATHER_DEADLINE_MS, so
    // the guaranteed synthesis phase below always has its full window.
    const gatherLeftMs = GATHER_DEADLINE_MS - (Date.now() - loopStartedAt)
    if (gatherLeftMs < MIN_TURN_MS) {
      hitTimeBudget = true
      break
    }
    turn++
    const res = await callClaude({
      model:       MODEL_ORCHESTRATOR,
      system:      systemPrompt,
      messages,
      tools:       fullTools as any,
      maxTokens:   4096,
      temperature: 0.3,
      // Cap a single research turn so a stalled web_search aborts fast, well
      // before it can eat into the synthesis phase.
      timeoutMs:   Math.min(RESEARCH_TURN_CAP_MS, gatherLeftMs),
    })
    totalInputTokens  += res.inputTokens
    totalOutputTokens += res.outputTokens

    const toolUses = res.content.filter((b): b is Extract<MessageContentBlock, { type: 'tool_use' }> => b.type === 'tool_use')
    const assistantText = res.text
    if (assistantText.trim().length > 0) lastAssistantText = assistantText
    researchLog.push({
      turn,
      tool_calls:   toolUses.map(t => `${t.name}(${JSON.stringify(t.input).slice(0, 100)})`),
      text_snippet: assistantText.slice(0, 200),
    })
    console.log(`[seo-worker-research] ${workerId} turn ${turn}: ${toolUses.length} tool_use, ${assistantText.length} text chars`)

    // Echo this assistant turn back into messages.
    const echoBlocks: MessageContentBlock[] = []
    if (assistantText.length > 0) echoBlocks.push({ type: 'text', text: assistantText })
    for (const t of toolUses) echoBlocks.push(t)
    if (echoBlocks.length > 0) {
      messages.push({ role: 'assistant', content: echoBlocks.length === 1 && echoBlocks[0].type === 'text' ? echoBlocks[0].text : echoBlocks })
    }

    // Stop if no more tool calls or model declared end_turn.
    if (toolUses.length === 0 || res.stop_reason === 'end_turn') {
      finalText = assistantText
      break
    }

    // Execute each worker-side tool. web_search is server-executed by
    // Anthropic; we never see those as tool_use blocks needing local
    // execution (the results come inline in the response).
    const toolResults: MessageContentBlock[] = []
    for (const call of toolUses) {
      const result = await executeTool(supabase, call.name, (call.input ?? {}) as Record<string, unknown>)
      toolResults.push({
        type:        'tool_result',
        tool_use_id: call.id,
        content:     JSON.stringify(result.payload).slice(0, 8000),
        is_error:    !result.ok,
      })
    }
    if (toolResults.length > 0) messages.push({ role: 'user', content: toolResults })
  }
  } catch (e: any) {
    // A turn threw (Claude timeout, web_search error, transient API fault).
    // DON'T let it crash the worker — that leaves the row stuck in
    // 'processing' until a reclaim, only to crash again and burn every
    // attempt with NULL output (the exact failure reported in 19bf5740).
    // Capture it, stop the loop, and finalize with whatever we have so the
    // task COMPLETES with a partial report instead of dying.
    loopError = e?.message ?? String(e)
    console.error(`[seo-worker-research] ${workerId} loop threw at turn ${turn} (saving partial, not crashing): ${loopError}`)
  }

  // FORCED SYNTHESIS. The loop emits text only on a clean end_turn — but a
  // budget-stop or an aborted web_search turn ends the loop mid-gathering,
  // when every prior turn was a silent tool call. That left final_text EMPTY
  // even though real evidence sits in `messages`. Recover it: one text-only
  // call (NO tools, so it can't hang on web_search or loop) that synthesizes
  // a report from whatever was gathered. Runs inside the reserved budget.
  let synthRan = false
  let synthError: string | null = null
  if (!finalText.trim() && messages.length > 1) {
    const elapsed = Date.now() - loopStartedAt
    // Give synthesis its full window, bounded only by the isolate ceiling so
    // we never start a call we can't finish. With gather hard-stopped at 85s
    // this is the full 50s; even if a turn overran, synthesis still gets the
    // time left under the 145s ceiling.
    const synthMs = Math.max(20_000, Math.min(SYNTH_TIMEOUT_MS, ISOLATE_CEILING_MS - elapsed))
    synthRan = true
    try {
      const nudge = `You are out of research time. Do NOT call any tools. Using ONLY the information already gathered in this conversation, write your final ${expectedOut.toUpperCase()} now, following the required output shape and staying within its length limit (do not exceed it). If the evidence is thin, say so explicitly rather than fabricating.`
      const synthMsgs: ApiChatMessage[] = [...messages]
      const last = synthMsgs[synthMsgs.length - 1]
      // Keep roles alternating: research turns always leave a trailing
      // user (tool_result) message, so fold the nudge into it; only push a
      // fresh user turn in the unexpected case the last message is assistant.
      if (last && last.role === 'user') {
        synthMsgs[synthMsgs.length - 1] = typeof last.content === 'string'
          ? { role: 'user', content: `${last.content}\n\n${nudge}` }
          : { role: 'user', content: [...last.content, { type: 'text', text: nudge }] }
      } else {
        synthMsgs.push({ role: 'user', content: nudge })
      }
      const synth = await callClaude({
        model:       MODEL_ORCHESTRATOR,
        system:      systemPrompt,
        messages:    synthMsgs,
        // No tools — guarantees this call returns text and cannot stall on a
        // web_search. Cap output at 3000 so generation finishes inside the
        // window (a 400-800 word report is ~1.2k tokens; this is ample).
        maxTokens:   3000,
        temperature: 0.3,
        timeoutMs:   synthMs,
      })
      totalInputTokens  += synth.inputTokens
      totalOutputTokens += synth.outputTokens
      if (synth.text.trim()) {
        finalText = synth.text
        lastAssistantText = synth.text
        researchLog.push({ turn: turn + 1, tool_calls: ['<forced_synthesis>'], text_snippet: synth.text.slice(0, 200) })
        console.log(`[seo-worker-research] ${workerId} forced synthesis produced ${synth.text.length} chars (had ${synthMs}ms)`)
      } else {
        synthError = `empty response (stop_reason=${synth.stop_reason})`
      }
    } catch (e: any) {
      // Persisted into result_data below so we can diagnose WITHOUT the
      // (invisible) edge console logs.
      synthError = e?.message ?? String(e)
      console.error(`[seo-worker-research] ${workerId} forced synthesis failed: ${synthError}`)
    }
  }

  // Fall back to the last substantive assistant text so a budget-stop OR a
  // mid-loop error still yields a usable partial report rather than empty.
  if (!finalText.trim() && lastAssistantText.trim()) {
    finalText = lastAssistantText
  }
  // Flag the report as partial so the reader (and the agent) treats it as
  // preliminary, not a complete answer.
  if ((hitTimeBudget || loopError) && finalText.trim()) {
    const why = loopError ? 'an error mid-run' : 'the time budget'
    finalText = `⚠️ PARTIAL RESULT — research was cut short after ${turn} turn(s) by ${why}; treat as preliminary.\n\n${finalText}`
  }

  // ── Persist result ─────────────────────────────────────────────────
  try {
    await markTaskCompleted(supabase, task.id, {
      question,
      scope,
      expected_output:        expectedOut,
      final_text:             finalText,
      research_log:           researchLog,
      turns_used:             turn,
      max_turns:              maxTurns,
      hit_time_budget:        hitTimeBudget,
      loop_error:             loopError,
      synth_ran:              synthRan,
      synth_error:            synthError,
      partial:                Boolean(hitTimeBudget || loopError),
      tokens: { input: totalInputTokens, output: totalOutputTokens },
    })
  } catch (e: any) {
    console.error(`[seo-worker-research] ${workerId} markTaskCompleted failed: ${e?.message ?? e}`)
    return jsonResponse({ processed: 1, worker_id: workerId, task_id: task.id, ok: false, error: e?.message ?? String(e) }, 500)
  }

  // ── Surface channel_discovery findings as a briefing ────────────────
  // The "channel & tactic explorer" runs weekly to hunt for new ways to
  // grow OUTSIDE the current blog+IG playbook. Its whole point is to put
  // fresh ideas in front of the admin — so when one completes, drop the
  // report into the briefings thread (the "while you were away" surface).
  // Best-effort; never fails the task.
  if (scope === 'channel_discovery' && finalText.trim().length > 0) {
    try {
      await writeBriefing(supabase, {
        subtype: 'scout_alert',
        title:   'New growth ideas — channel & tactic explorer',
        body:    `I went looking for ways to grow Minuto OUTSIDE the current blog + Instagram playbook. Findings below — these are PROPOSALS for you to greenlight, nothing is acted on automatically.\n\n${finalText.slice(0, 3500)}`,
        context: { task_id: task.id, scope: 'channel_discovery', source: 'channel_explorer' },
      })
    } catch (e: any) {
      console.warn(`[seo-worker-research] ${workerId} channel-discovery briefing failed (non-fatal): ${e?.message ?? e}`)
    }
  }

  return jsonResponse({
    processed:    1,
    worker_id:    workerId,
    task_id:      task.id,
    ok:           true,
    turns_used:   turn,
    text_length:  finalText.length,
    tokens:       { input: totalInputTokens, output: totalOutputTokens },
  })
})

// ─────────────────────────────────────────────────────────────────────────
// System prompt — calibrated per scope + output shape.
// ─────────────────────────────────────────────────────────────────────────
function buildResearchSystemPrompt(args: {
  scope:           DeepResearchBrief['scope']
  expected_output: DeepResearchBrief['expected_output']
}): string {
  const scopeGuidance: Record<DeepResearchBrief['scope'], string> = {
    geo_llmo:             'You are researching GEO/LLMO (Generative Engine Optimization) — how LLMs perceive, cite, and recommend brands. Use web_search to find recent articles on the field, fetch_url to deep-read the most-relevant pieces, query_minuto to ground findings in Minuto\'s actual AI-visibility data.',
    competitor_deep_dive: 'You are profiling a specific competitor. Use web_search to find their website + recent coverage + reviews. fetch_url for their about-page, product-page, blog. query_minuto for competitor_co_mentions to see how often they show up alongside Minuto.',
    content_topic:        'You are evaluating whether a specific content topic is worth Minuto pursuing. Use web_search to gauge demand + existing coverage. query_minuto for ai_visibility_summary and recent_industry_insights. Output should help the strategist decide go/no-go + angle if go.',
    audience_segment:     'You are profiling a specific customer audience (typically from RFM segmentation). Use query_minuto for customer_rfm_segments. Cross-reference with industry articles on segment psychology. Output should tell the strategist what content this segment would respond to.',
    channel_discovery:    'You are HUNTING FOR NEW WAYS TO GROW that Minuto is not currently using. Minuto today does WP blog SEO + Instagram only. Your job: find channels, content formats, communities, and tactics OUTSIDE that current playbook that could realistically reach an Israeli specialty-coffee audience. Use web_search aggressively — how do specialty roasters + premium-gear brands (in Israel AND abroad) acquire customers beyond blog+IG? Consider: emerging platforms (e.g. video-first, audio, niche social), community plays (forums, WhatsApp/Telegram groups, local events, subscriptions/clubs), earned media + PR, creator/affiliate partnerships, GEO/LLM visibility, UGC, referral mechanics, marketplace presence. query_minuto for active_learnings + competitor_co_mentions + ai_visibility_summary to ground in our actual position. PRIORITIZE ideas that (a) fit a boutique Israeli roaster\'s budget/scale, (b) are NOT just "post more on IG", (c) could be tested cheaply. Be bold but realistic — flag which ideas are quick experiments vs bigger bets.',
    other:                'Open-ended research. Use whichever tools fit the question.',
  }

  const outputGuidance: Record<DeepResearchBrief['expected_output'], string> = {
    recommendations: 'Output a prioritized list of 3-7 specific recommendations. Each: one sentence what to do + one sentence why (evidence) + estimated impact (high/med/low). No fluff, no preamble.',
    analysis:        'Output a 400-800 word narrative analysis with explicit citations to your sources (URLs, query results). Sections: KEY FINDINGS, EVIDENCE, IMPLICATIONS FOR MINUTO. Markdown OK.',
    action_plan:     'Output a concrete action plan: list of 3-5 specific tasks the strategist should queue next cycle. For each: brief_data shape (text_generation / instagram_post / dynamic_experiment / etc.), one-line rationale, expected metric impact.',
  }

  return `You are Minuto's deep-research module. Twice-weekly the orchestrator may queue you a hard strategic question that doesn\'t fit in a single LLM turn. Your job: use the available tools to investigate thoroughly and return a structured answer matching the expected_output shape.

${scopeGuidance[args.scope]}

OUTPUT SHAPE — ${args.expected_output.toUpperCase()}:
${outputGuidance[args.expected_output]}

OPERATING PRINCIPLES:
- Tool-use loop is bounded (typically 5 turns). Spend turns wisely — front-load web_search + query_minuto for evidence-gathering, then use the last turn(s) to synthesize.
- CITE YOUR SOURCES. Every claim should reference a URL or a query_minuto result. Unsourced claims are noise.
- BE CONSERVATIVE about extrapolation. Coffee market in Israel is small; what works for US specialty roasters may not transfer.
- If a question is genuinely unanswerable with available tools (no public data, paywalled sources), say so explicitly — don't fabricate.
- Your final turn should be PURE TEXT (no tool calls). That's how the worker knows you're done.`
}

// ─────────────────────────────────────────────────────────────────────────
// Tool execution dispatch.
// ─────────────────────────────────────────────────────────────────────────
async function executeTool(
  supabase: ReturnType<typeof createSupabase>,
  name: string,
  input: Record<string, unknown>,
): Promise<{ ok: boolean; payload: unknown }> {
  try {
    if (name === 'fetch_url') {
      const url = String(input.url ?? '').trim()
      if (!url || !/^https?:\/\//.test(url)) return { ok: false, payload: { error: 'fetch_url requires http(s) URL' } }
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MinutoResearchAgent/1.0)' } })
      if (!res.ok) return { ok: false, payload: { error: `HTTP ${res.status}` } }
      const html = await res.text()
      const body = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 6000)
      return { ok: true, payload: { url, body_text: body, length: body.length } }
    }

    if (name === 'query_minuto') {
      const queryName = String(input.query_name ?? '').trim()
      const days      = typeof input.days === 'number' ? Math.max(1, Math.min(180, input.days)) : 30
      const since     = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString()

      switch (queryName) {
        case 'top_landing_pages_by_conversions': {
          const { data } = await supabase
            .from('ga4_pages_daily').select('page_path, sessions, conversions, conversion_value')
            .eq('channel_group', 'Organic Search').gte('date', since.split('T')[0]).limit(500)
          return { ok: true, payload: { source: 'ga4_pages_daily', rows: aggregateByPage(data ?? []) } }
        }
        case 'ai_visibility_summary': {
          const { data } = await supabase
            .from('ai_visibility_probes').select('query_text, minuto_mentioned, competitors_mentioned')
            .gte('ran_at', since).is('error', null).limit(500)
          return { ok: true, payload: { source: 'ai_visibility_probes', rows: data ?? [] } }
        }
        case 'competitor_co_mentions': {
          const { data } = await supabase
            .from('ai_visibility_probes').select('competitors_mentioned')
            .gte('ran_at', since).is('error', null).limit(500)
          const counter: Record<string, number> = {}
          for (const r of (data ?? []) as Array<{ competitors_mentioned: string[] | null }>) {
            for (const c of (r.competitors_mentioned ?? [])) counter[c] = (counter[c] ?? 0) + 1
          }
          return { ok: true, payload: { competitors: Object.entries(counter).sort((a, b) => b[1] - a[1]).slice(0, 20) } }
        }
        case 'recent_industry_insights': {
          const { data } = await supabase
            .from('industry_articles').select('source_name, title, url, insight, relevance, tags')
            .gte('summarized_at', since).not('summarized_at', 'is', null)
            .order('relevance', { ascending: false }).limit(20)
          return { ok: true, payload: { source: 'industry_articles', rows: data ?? [] } }
        }
        case 'customer_rfm_segments': {
          const { data } = await supabase
            .from('customer_rfm').select('segment, total_spent_ils, order_count, days_since_last').limit(2000)
          const bySeg = new Map<string, { count: number; totSpent: number; totOrders: number; totDays: number }>()
          for (const r of (data ?? []) as Array<any>) {
            const seg = r.segment ?? 'unknown'
            const agg = bySeg.get(seg) ?? { count: 0, totSpent: 0, totOrders: 0, totDays: 0 }
            agg.count++; agg.totSpent += Number(r.total_spent_ils ?? 0); agg.totOrders += Number(r.order_count ?? 0); agg.totDays += Number(r.days_since_last ?? 0)
            bySeg.set(seg, agg)
          }
          return { ok: true, payload: { segments: Array.from(bySeg.entries()).map(([seg, a]) => ({ segment: seg, count: a.count, avg_total_spent_ils: Math.round(a.totSpent / Math.max(1, a.count)), avg_order_count: a.totOrders / Math.max(1, a.count), avg_days_since_last: a.totDays / Math.max(1, a.count) })) } }
        }
        case 'active_learnings': {
          const { data } = await supabase
            .from('seo_learnings').select('scope, insight, created_by, evidence_score, created_at')
            .is('superseded_at', null).order('created_at', { ascending: false }).limit(50)
          return { ok: true, payload: { rows: data ?? [] } }
        }
        case 'products_catalog': {
          // Minuto's live in-stock catalog. Use this whenever you need the
          // exact name + URL of a product so the article links correctly.
          // SEARCH SPANS name + short_description + slug because Minuto's
          // products mix Hebrew + English (e.g. "Velvet Star" is real, but
          // its name field is "פולי קפה ספשלטי ... קולומביה - Minuto Velvet
          // Star" — an English-only search of `name` for "Colombia" would
          // miss it). Always cross-check both languages.
          // DISCOVERY only — name, url, short_description. For depth on a
          // specific product the agent fetches its permalink live (fetch_url
          // already exists for that). No pre-staged long descriptions.
          const filterName = typeof input.filter_name === 'string' ? input.filter_name.trim() : ''
          let pq = supabase
            .from('woo_products')
            .select('woo_id, name, slug, permalink, short_description, categories, price')
            .eq('stock_status', 'instock')
            .limit(filterName ? 100 : 200)
          if (filterName) {
            const esc = filterName.replace(/[%_]/g, m => `\\${m}`)
            pq = pq.or(`name.ilike.%${esc}%,short_description.ilike.%${esc}%,slug.ilike.%${esc}%`)
          }
          const { data: prods, error: pErr } = await pq
          if (pErr) return { ok: false, payload: { error: `woo_products query failed: ${pErr.message}` } }
          const trim = (s: unknown, n: number) => typeof s === 'string'
            ? s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n)
            : ''
          const rows = (prods ?? []).map((p: any) => ({
            woo_id:            Number(p.woo_id),
            name:              p.name,
            slug:              p.slug,
            url:               p.permalink,
            price_ils:         p.price ? Number(p.price) : null,
            short_description: trim(p.short_description, 400),
            categories:        Array.isArray(p.categories) ? p.categories.slice(0, 6) : [],
          }))
          return { ok: true, payload: { source: 'woo_products', count: rows.length, filter_name: filterName || null, rows, hint: 'For full description on a specific product, fetch_url its permalink.' } }
        }
        default:
          return { ok: false, payload: { error: `unknown query_name "${queryName}". Allowed: top_landing_pages_by_conversions | ai_visibility_summary | competitor_co_mentions | recent_industry_insights | customer_rfm_segments | active_learnings | products_catalog` } }
      }
    }

    return { ok: false, payload: { error: `unknown tool "${name}"` } }
  } catch (e: any) {
    return { ok: false, payload: { error: e?.message ?? String(e) } }
  }
}

function aggregateByPage(rows: Array<{ page_path: string; sessions: number | null; conversions: number | null; conversion_value: number | null }>): Array<{ page_path: string; sessions: number; conversions: number; conversion_value: number }> {
  const byPage = new Map<string, { sessions: number; conversions: number; conversion_value: number }>()
  for (const r of rows) {
    const cur = byPage.get(r.page_path) ?? { sessions: 0, conversions: 0, conversion_value: 0 }
    cur.sessions       += r.sessions ?? 0
    cur.conversions    += Number(r.conversions ?? 0)
    cur.conversion_value += Number(r.conversion_value ?? 0)
    byPage.set(r.page_path, cur)
  }
  return Array.from(byPage.entries()).map(([page_path, v]) => ({ page_path, ...v }))
    .sort((a, b) => b.conversions - a.conversions).slice(0, 25)
}

async function safeMarkFailed(
  supabase: ReturnType<typeof createSupabase>,
  task: SeoTaskRow,
  msg: string,
  permanent: boolean,
): Promise<void> {
  try {
    await markTaskFailed(supabase, task.id, msg, permanent)
  } catch (e: any) {
    console.error(`[seo-worker-research] markTaskFailed write failed: ${e?.message ?? e}`)
  }
}
