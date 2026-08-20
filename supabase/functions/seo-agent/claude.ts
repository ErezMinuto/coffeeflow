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

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'

// Claude model IDs. The content-planner stack (orchestrator, writers, chat)
// runs on Sonnet — cheap, fast, good at structured planning. The STRATEGIST
// BRAIN runs on Opus 4.8: it reasons deeply over the whole business once a
// week, so quality-per-decision matters far more than per-token cost.
export const MODEL_ORCHESTRATOR = 'claude-sonnet-4-6'
export const MODEL_WRITER       = 'claude-sonnet-4-6'
export const MODEL_CHAT         = 'claude-sonnet-4-6'
// Fable 5: chosen over Opus 4.8 after a real-snapshot backtest (found a wasting
// ad, a bean oversell, and gated the email better; zero refusals). Refusal→Opus
// fallback is wired in callClaude below as a seatbelt.
export const MODEL_STRATEGIST   = 'claude-fable-5'

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
}

export async function callClaude(opts: CallClaudeOptions): Promise<CallClaudeResult> {
  if (!ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY env var not set')
  }

  const model = opts.model ?? MODEL_ORCHESTRATOR
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
    messages: opts.cachePrefix ? withMessageBreakpoint(opts.messages) : opts.messages,
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
// Deliberately NOT awaited and never throws: a lost cost row is far cheaper
// than failing an expensive reasoning step that already completed and was
// already billed by Anthropic. Posts straight to PostgREST instead of going
// through db.ts, so callers don't have to thread a SupabaseClient through and
// claude.ts stays free of a db.ts import.
function logCost(opts: CallClaudeOptions, usage: TokenUsage): void {
  if (!opts.sourceFn) return   // unattributed call — nothing useful to record
  const url = Deno.env.get('SUPABASE_URL')
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !key) return
  fetch(`${url}/rest/v1/agent_cost_ledger`, {
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
