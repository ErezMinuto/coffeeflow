// Minuto SEO Agent — Anthropic Messages API client.
//
// Self-contained wrapper used by the orchestrator, workers, and chat
// handler. NOT imported from supabase/functions/_shared so the SEO agent
// stays independent — the existing generic-agents framework can keep
// using its own Claude helper, and ours can evolve separately.
//
// Why a local copy instead of a shared one:
//   - The SEO agent gets its own model defaults, retry policy, tool-use
//     handling, and streaming. Sharing risks one side's change breaking
//     the other.

import { estimateUsd, type TokenUsage } from './pricing.ts'
import { callGemini, isGeminiModel } from './gemini.ts'
// Re-exported so call sites can branch on the provider (e.g. the research
// worker picks Google Search grounding vs Anthropic web_search) without
// importing gemini.ts directly — claude.ts stays the single entry point.
export { isGeminiModel }

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'

// Claude model IDs. The content-planner stack (orchestrator, writers, chat)
// runs on Sonnet — cheap, fast, good at structured planning. The STRATEGIST
// BRAIN runs on Opus 4.8: it reasons deeply over the whole business once a
// week, so quality-per-decision matters far more than per-token cost.
const MODEL_ORCHESTRATOR_DEFAULT = 'claude-sonnet-4-6'
const MODEL_WRITER_DEFAULT      = 'claude-sonnet-4-6'
const MODEL_CHAT_DEFAULT        = 'claude-sonnet-4-6'
// Fable 5: chosen over Opus 4.8 after a real-snapshot backtest (found a wasting
// ad, a bean oversell, and gated the email better; zero refusals). Refusal→Opus
// fallback is wired in callClaude below as a seatbelt.
const MODEL_STRATEGIST_DEFAULT  = 'claude-fable-5'

// ── PROVIDER SWITCH (Gemini migration, Wave A) ──────────────────────────────
//
// The organic agent's job is to rank in Google's index, and Gemini grounds on
// that index natively; Anthropic's web_search runs against a third-party index,
// which is a structural gap for SEO work that no prompt fixes. So these four
// slots are moving to Gemini one at a time.
//
// Each slot reads an env var with a CLAUDE DEFAULT. Nothing changes on deploy:
// flipping a function to Gemini is `supabase secrets set MODEL_RESEARCH=
// gemini-2.5-pro`, and flipping it BACK is unsetting that var. No redeploy, no
// code change, no PR — which is the whole point of a switch rather than a
// replacement. callClaude routes on the resolved model id (see below), so the
// call sites themselves never learn which provider served them.
// VERIFY ANY GEMINI ID AGAINST THE LIVE MODEL LIST BEFORE SETTING A SLOT:
//   curl -s "https://generativelanguage.googleapis.com/v1beta/models?key=$GEMINI_API_KEY" \
//     | jq -r '.models[] | select(.supportedGenerationMethods[]? == "generateContent") | .name'
// The ids are NOT guessable from the marketing names. 'gemini-3.1-flash' looks
// entirely plausible and does not exist — it 404s every call, which surfaced as
// scout-tick finding 3 signals and silently creating 0 tasks. Note also that a
// Vertex AI model id is NOT necessarily valid on this endpoint; that is exactly
// where the bad id was copied from.
function modelSlot(slot: string, fallback: string): string {
  const v = Deno.env.get(`MODEL_${slot}`)?.trim()
  if (v && v !== '') {
    // Fail loudly at module load rather than once per call deep inside a worker.
    if (!/^(claude|gemini)/.test(v)) {
      console.error(`[model-slot] MODEL_${slot}="${v}" matches no known provider prefix — calls will fail`)
    }
    return v
  }
  return fallback
}
// The SEO/content PLANNER — reads GSC keywords, blog history and past tasks and
// decides what to write. This is the slot where Gemini's index access is most
// plausibly an edge: the job is literally "what should rank on Google".
//
// Unlike the strategist it is a SINGLE call with NO tools, so the fan-out and
// resumed-state hazards do not apply. One hazard does apply: it caps maxTokens
// at 7000 for a ~3500-token plan, and on a THINKING-ONLY Gemini model those
// tokens are spent before any visible output — a truncated plan fails
// parseClaudeJson and the cycle emits NOTHING. Prefer a model whose thinking can
// be disabled (gemini-2.5-flash), or raise the cap first.
export const MODEL_ORCHESTRATOR   = modelSlot('ORCHESTRATOR', MODEL_ORCHESTRATOR_DEFAULT)
export const MODEL_TECHSEO        = modelSlot('TECHSEO',        'claude-sonnet-4-6')
export const MODEL_SCOUT          = modelSlot('SCOUT',          'claude-haiku-4-5')
export const MODEL_RESEARCH       = modelSlot('RESEARCH',       'claude-sonnet-4-6')
export const MODEL_VISUAL_CRITIC  = modelSlot('VISUAL_CRITIC',  'claude-sonnet-4-6')
// The admin chat is the single largest line in agent_cost_ledger — $4.03 over
// 14 days, ~37% of all spend, more than strategist-brain and 13x the entire
// migrated organic stack. Its output goes to the owner, not to customers, so a
// regression is visible immediately and nothing gets published in the meantime.
//
// It carries a large tool set. Gemini forbids google_search alongside
// functionDeclarations, so this slot gets TOOLS and no grounding — which is
// correct here: the chat's value is in its tools, not in web search.
export const MODEL_CHAT           = modelSlot('CHAT',           MODEL_CHAT_DEFAULT)
// The chat's URL-synthesis sub-call — same shape as the industry ingester's:
// fetch a page, summarise it as one insight. Cheap, structured, no judgement,
// and its output is a suggestion the admin reads. Slotted separately so it can
// run on a cheap tier while the chat loop itself runs on a strong one.
export const MODEL_CHAT_SYNTH     = modelSlot('CHAT_SYNTH',     'claude-haiku-4-5')
// The blog WRITER — customer-facing Hebrew published to the site. Slotted last
// of the organic tier because its output is the most public thing in the stack.
export const MODEL_WRITER         = modelSlot('WRITER',         MODEL_WRITER_DEFAULT)
// The BRAIN. Fable 5 was not a default — it WON a real-snapshot backtest over
// Opus 4.8 (found a wasting ad, a bean oversell, gated the email better, zero
// refusals). Slotting it does not overturn that; it only makes the choice
// changeable without a deploy. Anything put here should beat Fable on the same
// backtest first, because the brain's output drives spend decisions.
export const MODEL_STRATEGIST     = modelSlot('STRATEGIST',     MODEL_STRATEGIST_DEFAULT)
// Slots for the four functions that used to call Anthropic directly. Those
// hand-rolled fetches are why they were invisible in agent_cost_ledger and
// unreachable by a provider switch.
// NOTE: there is deliberately NO slot for ai-visibility-probe or for
// seo-worker-research's backtest arm. Both call Claude as a SUBJECT OF
// MEASUREMENT, not as a tool: the probe files rows under llm_provider='claude',
// and the backtest is the Claude-vs-Gemini comparison that justified this
// migration. Pointing either at Gemini would corrupt the data it exists to
// produce, so they keep their direct calls on purpose.
export const MODEL_ANALYST        = modelSlot('ANALYST',        'claude-sonnet-4-6')
export const MODEL_CAMPAIGN       = modelSlot('CAMPAIGN',       'claude-sonnet-4-6')
export const MODEL_CAMPAIGN_CHEAP = modelSlot('CAMPAIGN_CHEAP', 'claude-haiku-4-5')

// Opus 4.7+/Fable use adaptive thinking and REJECT temperature/top_p/
// budget_tokens (400). Detect them so callClaude omits sampling params and
// sends thinking:adaptive instead. Sonnet/Haiku keep the temperature path.
function usesAdaptiveThinking(model: string): boolean {
  return /^claude-opus-4-(7|8)/.test(model) || model.startsWith('claude-fable')
}

// Anthropic Messages API shapes — minimal, just what we use.

// A cache breakpoint. Legal on any content block; caches the whole rendered
// prefix (tools → system → messages) up to and including that block.
export interface CacheControl { type: 'ephemeral'; ttl?: '5m' | '1h' }

export interface MessageContentText {
  type: 'text'
  text: string
  cache_control?: CacheControl
}
export interface MessageContentToolUse {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
  cache_control?: CacheControl
  // Gemini 3.x REQUIRES that the thought_signature it attached to a functionCall
  // be replayed when that call is sent back as history. Omit it and the SECOND
  // tool-loop turn dies with 400 INVALID_ARGUMENT ("Function call is missing a
  // thought_signature ... position 2"). It rides on the Anthropic-shaped block
  // because that is the only thing that survives a caller's tool loop; it is
  // stripped again before any Anthropic request (see stripProviderFields).
  thoughtSignature?: string
}
export interface MessageContentToolResult {
  type: 'tool_result'
  tool_use_id: string
  content: string
  is_error?: boolean
  cache_control?: CacheControl
}
// Vision input. Anthropic accepts source.type='url' (added 2024) for any
// publicly-fetchable image URL, or source.type='base64' for inline bytes.
// We use URL source — rendered visuals already live in the public
// Supabase Storage bucket.
export interface MessageContentImage {
  type: 'image'
  source:
    | { type: 'url'; url: string }
    | { type: 'base64'; media_type: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; data: string }
  cache_control?: CacheControl
}
export type MessageContentBlock =
  | MessageContentText
  | MessageContentToolUse
  | MessageContentToolResult
  | MessageContentImage

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string | MessageContentBlock[]
}

export interface ToolDefinition {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

export interface CallClaudeOptions {
  model?: string
  system: string
  messages: ChatMessage[]
  maxTokens?: number
  // Ignored by adaptive-thinking models (Opus 4.7+/Fable) — they reject it.
  temperature?: number
  // Reasoning depth vs token-spend tradeoff (GA; Opus 4.5+ / Sonnet 4.6).
  // 'high' is the strategist default; omit for the cheap Sonnet workers.
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  tools?: ToolDefinition[]
  timeoutMs?: number
  // Prompt caching — when true, marks the system prompt + last tool with
  // cache_control:'ephemeral' so Anthropic caches the (system + tools)
  // prefix for ~5 min. First call in a chat turn pays full input cost;
  // subsequent calls within the TTL get the cached prefix at ~10% cost
  // AND respond several×faster (the cached input is processed at near-
  // zero latency). Huge win for the chat handler where one turn can fire
  // 4-8 Claude calls back-to-back with identical system + tools.
  //
  // It ALSO marks the last block of the last message (see
  // withMessageBreakpoint). In a tool loop the system+tools prefix is a
  // fixed cost but `messages` GROWS every turn, and without a breakpoint
  // there the whole accumulated history is re-billed at full price on
  // every single turn. Measured on a real strategist-brain run: turn 2
  // paid full price on 9,129 input tokens, turn 3 on 16,282 — while the
  // 33,776-token system prefix was correctly served from cache both times.
  cachePrefix?: boolean
  // Cost ledger attribution. When sourceFn is set, every call writes one
  // agent_cost_ledger row (fire-and-forget) so spend and cache-hit rate are
  // observable per function. Without it the call is unattributed and skipped
  // — which is why only strategist-brain/-evaluator had any cost history.
  sourceFn?: string
  runId?: string | null
  // ── Gemini-only options (ignored when an Anthropic model is serving) ──────
  // Both are no-ops on Claude rather than errors, so a slot can be flipped
  // between providers by env var alone without the call site changing shape.
  //
  // googleSearch turns on Google Search grounding — the reason for the
  // migration. Claude's nearest equivalent is its own web_search tool, which
  // call sites still pass explicitly via `tools`, so there is nothing sensible
  // to map this onto on the Anthropic path.
  googleSearch?: boolean
  // responseSchema constrains Gemini to emit JSON matching the schema, which
  // removes the fence-stripping failure class parseClaudeJson exists to paper
  // over. On Claude the call site keeps using parseClaudeJson, which is why
  // ignoring this is safe rather than silently lossy.
  responseSchema?: Record<string, unknown>
}

// Attach a cache breakpoint to the final block of the final message, so the
// NEXT turn in a tool loop reads this turn's history instead of re-paying for
// it. Returns a shallow-cloned array — callers like strategist-brain persist
// `state.messages` to the DB, so mutating in place would poison stored state.
export function withMessageBreakpoint(messages: ChatMessage[]): ChatMessage[] {
  // A single message means a one-shot call: there is no prior turn to read and
  // no next turn to be read by, so a breakpoint here would write an entry
  // nobody ever hits — a pure +25% on those tokens. Only loops benefit.
  if (messages.length < 2) return messages
  const last = messages[messages.length - 1]
  let blocks: MessageContentBlock[]
  if (typeof last.content === 'string') {
    // An empty text block is a 400 — leave a blank message unmarked.
    if (last.content.trim() === '') return messages
    blocks = [{ type: 'text', text: last.content }]
  } else {
    if (last.content.length === 0) return messages
    blocks = last.content.slice()
  }
  blocks[blocks.length - 1] = {
    ...blocks[blocks.length - 1],
    cache_control: { type: 'ephemeral' },
  }
  const out = messages.slice()
  out[out.length - 1] = { ...last, content: blocks }
  return out
}

export interface CallClaudeResult {
  // Concatenated text blocks (empty if the response was purely tool_use).
  text: string
  // Raw content blocks so callers can inspect tool_use entries.
  content: MessageContentBlock[]
  // 'end_turn' = model finished; 'tool_use' = model wants tool results;
  // 'max_tokens' = hit the cap; 'stop_sequence' = matched a stop seq.
  stop_reason: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  model: string
  // Gemini-only. Grounded source URLs, which Gemini returns out-of-band in
  // groundingMetadata rather than as content blocks. Undefined on the Anthropic
  // path, where the same information arrives as web_search_tool_result blocks
  // inside `content` and callers extract it from there.
  groundingSources?: Array<{ title: string; url: string }>
}

// Anthropic rejects unknown fields inside content blocks, and thoughtSignature
// is a Gemini-only field we attach to tool_use blocks. A conversation started on
// Gemini and continued on Claude — exactly what a model-slot flip does mid-loop —
// would otherwise 400. Strip on the way out rather than never storing it, because
// the signature has to survive the caller's loop to be replayed to Gemini.
function stripProviderFields(messages: ChatMessage[]): ChatMessage[] {
  return messages.map(m => {
    if (typeof m.content === 'string') return m
    let touched = false
    const blocks = m.content.map(b => {
      if (b.type === 'tool_use' && b.thoughtSignature !== undefined) {
        touched = true
        const { thoughtSignature: _drop, ...rest } = b
        return rest as MessageContentBlock
      }
      return b
    })
    return touched ? { ...m, content: blocks } : m
  })
}

export async function callClaude(opts: CallClaudeOptions): Promise<CallClaudeResult> {
  const model = opts.model ?? MODEL_ORCHESTRATOR

  // PROVIDER SWITCH. Routing on the model id keeps every call site provider-
  // agnostic: a function moves to Gemini by its slot env var resolving to a
  // gemini-* id, and nothing at the call site changes. callGemini returns this
  // same CallClaudeResult shape, so callers cannot tell the difference.
  //
  // Anthropic-only options are dropped rather than approximated, because Gemini
  // has no equivalent: cache_control (its explicit cache has different
  // semantics and a different billing model), thinking:adaptive, output_config
  // effort, and the Fable refusal fallback. Silently pretending to honour them
  // would be worse than not honouring them.
  if (isGeminiModel(model)) {
    return await callGemini({ ...opts, model })
  }

  if (!ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY env var not set')
  }

  const adaptive = usesAdaptiveThinking(model)
  // Fable 5's safety classifiers can decline a request as stop_reason:"refusal".
  // In an unattended weekly cron that would silently fail the run, so opt into
  // server-side fallback: on a policy decline Anthropic transparently re-serves
  // the SAME request on Opus 4.8 within this one call (repriced automatically).
  // Gated to Fable — the param/header is unnecessary for other models. A refused
  // partial is billed but discarded server-side; a pre-output decline isn't billed.
  const fableFallback = model.startsWith('claude-fable')
  const body: Record<string, unknown> = {
    model,
    max_tokens: opts.maxTokens ?? 8192,
    // System: when caching, send as a content-block array with a
    // cache_control marker on the (only) block. Otherwise send as a
    // plain string — Anthropic accepts both shapes.
    system: opts.cachePrefix
      ? [{ type: 'text', text: opts.system, cache_control: { type: 'ephemeral' } }]
      : opts.system,
    messages: stripProviderFields(opts.cachePrefix ? withMessageBreakpoint(opts.messages) : opts.messages),
  }
  if (adaptive) {
    // Adaptive thinking is the only on-mode for Opus 4.7+/Fable; Claude
    // decides how much to think per request. Sending temperature would 400.
    body.thinking = { type: 'adaptive' }
  } else if (opts.temperature != null) {
    body.temperature = opts.temperature
  }
  // effort is opt-in, so existing Sonnet callers (no effort) are unchanged.
  if (opts.effort) body.output_config = { effort: opts.effort }
  if (fableFallback) body.fallbacks = [{ model: 'claude-opus-4-8' }]
  if (opts.tools && opts.tools.length > 0) {
    // Tools: when caching, attach cache_control to the LAST tool. The
    // marker caches the WHOLE prefix up to and including that block, so
    // one marker on the final tool caches all 30 tool schemas in one
    // chunk. Order matters — Anthropic requires the tool list be stable
    // between calls for the cache to hit.
    body.tools = opts.cachePrefix
      ? opts.tools.map((t, i) =>
          i === opts.tools!.length - 1
            ? { ...t, cache_control: { type: 'ephemeral' } }
            : t,
        )
      : opts.tools
  }

  const controller = new AbortController()
  const timeoutMs = opts.timeoutMs ?? 110_000  // stay under 150s edge cap
  const t = setTimeout(() => controller.abort(), timeoutMs)

  let res: Response
  try {
    res = await fetch(ANTHROPIC_API_URL, {
      method:  'POST',
      headers: {
        'x-api-key':         ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
        ...(fableFallback ? { 'anthropic-beta': 'server-side-fallback-2026-06-01' } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(t)
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(`Claude ${model} ${res.status}: ${errText.slice(0, 500)}`)
  }

  const json = await res.json() as {
    content?: MessageContentBlock[]
    stop_reason?: string
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
    }
    model?: string
  }

  const content = json.content ?? []
  const text = content
    .filter((b): b is MessageContentText => b.type === 'text')
    .map(b => b.text)
    .join('')

  const inputTokens         = json.usage?.input_tokens ?? 0
  const outputTokens        = json.usage?.output_tokens ?? 0
  const cacheReadTokens     = json.usage?.cache_read_input_tokens ?? 0
  const cacheCreationTokens = json.usage?.cache_creation_input_tokens ?? 0
  const servedModel         = json.model ?? model

  // A measured READ is the only proof caching pays. write>0 with read=0 across
  // a whole run means the prefix is never reused (or sits under the model's
  // minimum cacheable size) — that costs +25% and should be reverted, not kept.
  if (cacheReadTokens || cacheCreationTokens) {
    console.log(`[cache] model=${servedModel} write=${cacheCreationTokens} read=${cacheReadTokens} input=${inputTokens}`)
  }
  logCost(opts, { model: servedModel, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens })

  return {
    text,
    content,
    stop_reason:        json.stop_reason ?? 'unknown',
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    model:              json.model ?? model,
  }
}

// ── Cost ledger ──────────────────────────────────────────────────────────────
// One agent_cost_ledger row per call, written here rather than at each call
// site so instrumentation can't drift out of sync with the calls themselves.
// (It had: only strategist-brain and strategist-evaluator ever called
// logClaudeCost, leaving ~14 other Claude-calling functions with zero spend or
// cache-hit visibility.)
//
// Never throws and never blocks the caller: a lost cost row is far cheaper
// than failing an expensive reasoning step that already completed and was
// already billed by Anthropic. Posts straight to PostgREST instead of going
// through db.ts, so callers don't have to thread a SupabaseClient through and
// claude.ts stays free of a db.ts import.
//
// The POST is handed to EdgeRuntime.waitUntil rather than left dangling. A bare
// un-awaited fetch races isolate teardown, and the row most at risk is the one
// we can least afford to lose: strategist-brain starts a step only while a full
// per-call timeout still fits its wall-clock budget, so an invocation typically
// makes ONE call and returns right after. getMonthToDateSpendUsd sums this table
// to enforce BUDGET_CEILING_USD, so dropped rows read as under-spend and the
// kill-switch can miss. Same guard shape as organic-orchestrator/google-sync;
// outside the edge runtime (deno test) it stays plain fire-and-forget.
function logCost(opts: CallClaudeOptions, usage: TokenUsage): void {
  if (!opts.sourceFn) return   // unattributed call — nothing useful to record
  const url = Deno.env.get('SUPABASE_URL')
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !key) return
  const post = fetch(`${url}/rest/v1/agent_cost_ledger`, {
    method: 'POST',
    headers: {
      apikey:          key,
      Authorization:   `Bearer ${key}`,
      'Content-Type':  'application/json',
      Prefer:          'return=minimal',
    },
    body: JSON.stringify({
      source_fn:             opts.sourceFn,
      run_id:                opts.runId ?? null,
      model:                 usage.model,
      input_tokens:          usage.inputTokens,
      output_tokens:         usage.outputTokens,
      cache_read_tokens:     usage.cacheReadTokens,
      cache_creation_tokens: usage.cacheCreationTokens,
      est_usd:               estimateUsd(usage),
    }),
  })
    .then(r => { if (!r.ok) return r.text().then(t => console.warn(`[cost-ledger] ${opts.sourceFn} insert ${r.status}: ${t.slice(0, 200)}`)) })
    .catch(e => console.warn(`[cost-ledger] ${opts.sourceFn} insert failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`))
  // `post` already swallows its own errors, so waitUntil can never see a rejection.
  // @ts-ignore — EdgeRuntime is injected by the Supabase edge runtime.
  if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime?.waitUntil) {
    // @ts-ignore
    EdgeRuntime.waitUntil(post)
  }
}

// Robust JSON parser for Claude's text output. Claude sometimes wraps
// JSON in markdown fences (```json ... ```) or prepends a one-line
// "Here's the JSON:" preamble. This finds the first {...} or [...]
// block and parses it.
export function parseClaudeJson<T = unknown>(text: string): T {
  // Strip leading/trailing markdown fences if present.
  let cleaned = text.trim()
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
  if (fenceMatch) cleaned = fenceMatch[1].trim()

  // Find first balanced JSON object/array.
  const firstBrace = cleaned.indexOf('{')
  const firstBracket = cleaned.indexOf('[')
  let start: number
  if (firstBrace === -1) start = firstBracket
  else if (firstBracket === -1) start = firstBrace
  else start = Math.min(firstBrace, firstBracket)
  if (start < 0) throw new Error(`No JSON in Claude response: ${text.slice(0, 200)}`)

  // Walk from start, tracking depth, to find the matching close.
  const openChar  = cleaned[start]
  const closeChar = openChar === '{' ? '}' : ']'
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < cleaned.length; i++) {
    const c = cleaned[i]
    if (escaped) { escaped = false; continue }
    if (c === '\\' && inString) { escaped = true; continue }
    if (c === '"') { inString = !inString; continue }
    if (inString) continue
    if (c === openChar) depth++
    else if (c === closeChar) {
      depth--
      if (depth === 0) {
        const slice = cleaned.slice(start, i + 1)
        return JSON.parse(slice) as T
      }
    }
  }
  throw new Error(`Unbalanced JSON in Claude response: ${cleaned.slice(start, start + 200)}`)
}
