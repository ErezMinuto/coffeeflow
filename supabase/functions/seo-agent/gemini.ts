// Minuto SEO Agent — Google Gemini client, shaped as a drop-in for callClaude.
//
// WHY THIS EXISTS. The organic agent's job is to rank in Google's index, and
// Gemini can ground on that index natively. Anthropic's web_search runs against
// a third-party index — a structural gap for SEO work that no prompt fixes.
// Secondary wins: a very large context removes the curate-and-truncate
// architecture (today 4KB per competitor page, 6KB per URL, top-20 posts only),
// and responseSchema removes the parseClaudeJson fence-stripping failure class
// that most of the qa_pattern learnings are about.
//
// THIS IS A SWITCH, NOT A REPLACEMENT. callGemini deliberately returns the same
// CallClaudeResult shape that every caller already handles, and callClaude
// routes here purely on the model id. A function moves by changing one model
// constant — which reads from an env var — so moving one back is an env edit,
// not a redeploy. Both providers stay live indefinitely.
//
// NOT IN SCOPE: image GENERATION is already 100% Gemini elsewhere
// (vertex-imagen-edit, visual-test). Nothing here touches it.

import { estimateUsd, type TokenUsage } from './pricing.ts'
import type {
  CallClaudeOptions,
  CallClaudeResult,
  ChatMessage,
  MessageContentBlock,
  ToolDefinition,
} from './claude.ts'

const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY') ?? ''
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'

export function isGeminiModel(model: string): boolean {
  return model.startsWith('gemini')
}

// ── Request shapes (only the fields we use) ─────────────────────────────────
interface GeminiPart {
  text?:             string
  inlineData?:       { mimeType: string; data: string }
  functionCall?:     { name: string; args: Record<string, unknown> }
  functionResponse?: { name: string; response: Record<string, unknown> }
}
interface GeminiContent {
  role:  'user' | 'model'
  parts: GeminiPart[]
}

// ─────────────────────────────────────────────────────────────────────────────
// TOOL SCHEMA CONVERSION
//
// Gemini's functionDeclarations take an OpenAPI-flavoured subset of JSON Schema
// and REJECT the whole request (400) on vocabulary it does not know — including
// keys Anthropic accepts happily: $schema, additionalProperties, oneOf/anyOf/
// allOf, const, and format on a string. Passing our tool schemas through
// untouched fails before a single token is generated, so they are pruned
// rather than trusted.
//
// Pruning is deliberately conservative: an unknown keyword is DROPPED, never
// guessed at. Dropping a constraint makes the schema more permissive, which
// costs a little validation strictness; mistranslating one would silently
// change what the model is asked for.
// ─────────────────────────────────────────────────────────────────────────────
const SCHEMA_KEYS_KEPT = new Set([
  'type', 'description', 'properties', 'required', 'items', 'enum', 'nullable',
])

export function sanitizeSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitizeSchema)
  if (node === null || typeof node !== 'object') return node

  const src = node as Record<string, unknown>
  const out: Record<string, unknown> = {}

  for (const [k, v] of Object.entries(src)) {
    if (!SCHEMA_KEYS_KEPT.has(k)) continue
    if (k === 'properties' && v && typeof v === 'object') {
      const props: Record<string, unknown> = {}
      for (const [pk, pv] of Object.entries(v as Record<string, unknown>)) {
        props[pk] = sanitizeSchema(pv)
      }
      out[k] = props
    } else if (k === 'items') {
      out[k] = sanitizeSchema(v)
    } else {
      out[k] = v
    }
  }

  // Gemini requires `type` on every schema node. A node that only carried
  // e.g. {description, oneOf} would be left typeless by the prune above and
  // 400 the request, so default it to the one type that accepts anything.
  if (!out.type) out.type = 'string'
  return out
}

export function toFunctionDeclarations(tools: ToolDefinition[]): Array<Record<string, unknown>> {
  return tools.map(t => ({
    name:        t.name,
    description: t.description,
    parameters:  sanitizeSchema(t.input_schema),
  }))
}

// ─────────────────────────────────────────────────────────────────────────────
// MESSAGE CONVERSION
//
// THE TOOL-NAME PROBLEM. Anthropic identifies a tool result by tool_use_id
// alone; Gemini's functionResponse is keyed by the function NAME and has no
// id concept at all. So the id→name mapping has to be recovered by walking the
// preceding assistant turns for the tool_use that opened each id. Without this
// the loop silently degrades: Gemini receives results it cannot attribute and
// re-calls the same tool forever.
// ─────────────────────────────────────────────────────────────────────────────
export function buildToolNameMap(messages: ChatMessage[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const m of messages) {
    if (typeof m.content === 'string') continue
    for (const b of m.content) {
      if (b.type === 'tool_use') map.set(b.id, b.name)
    }
  }
  return map
}

// Vision input. Anthropic takes a public URL directly; Gemini needs the bytes
// inline, so a URL source is fetched and base64'd here. Failure is non-fatal:
// a dropped image is far better than a failed research run, and the omission
// is logged rather than silently swallowed.
async function imagePartFromBlock(block: Extract<MessageContentBlock, { type: 'image' }>): Promise<GeminiPart | null> {
  try {
    if (block.source.type === 'base64') {
      return { inlineData: { mimeType: block.source.media_type, data: block.source.data } }
    }
    const res = await fetch(block.source.url)
    if (!res.ok) {
      console.error(`[gemini] image fetch ${res.status} for ${block.source.url.slice(0, 120)} — dropping block`)
      return null
    }
    const mimeType = res.headers.get('content-type')?.split(';')[0] || 'image/png'
    const buf = new Uint8Array(await res.arrayBuffer())
    let bin = ''
    for (let i = 0; i < buf.length; i += 0x8000) {
      bin += String.fromCharCode(...buf.subarray(i, i + 0x8000))
    }
    return { inlineData: { mimeType, data: btoa(bin) } }
  } catch (e: any) {
    console.error(`[gemini] image conversion threw — dropping block: ${e?.message ?? e}`)
    return null
  }
}

export async function toGeminiContents(messages: ChatMessage[]): Promise<GeminiContent[]> {
  const toolNames = buildToolNameMap(messages)
  const out: GeminiContent[] = []

  for (const m of messages) {
    const role: 'user' | 'model' = m.role === 'assistant' ? 'model' : 'user'

    if (typeof m.content === 'string') {
      if (m.content.trim() === '') continue   // an empty part is a 400
      out.push({ role, parts: [{ text: m.content }] })
      continue
    }

    const parts: GeminiPart[] = []
    for (const b of m.content) {
      if (b.type === 'text') {
        if (b.text.trim() !== '') parts.push({ text: b.text })
      } else if (b.type === 'tool_use') {
        parts.push({ functionCall: { name: b.name, args: b.input ?? {} } })
      } else if (b.type === 'tool_result') {
        // Gemini wants a JSON object. Our tool results are strings (often JSON
        // already), so parse when possible and wrap when not — a bare string
        // would be rejected.
        let response: Record<string, unknown>
        try {
          const parsed = JSON.parse(b.content)
          response = (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
            ? parsed as Record<string, unknown>
            : { result: parsed }
        } catch {
          response = { result: b.content }
        }
        if (b.is_error) response = { error: response }
        parts.push({
          functionResponse: {
            name:     toolNames.get(b.tool_use_id) ?? 'unknown_tool',
            response,
          },
        })
      } else if (b.type === 'image') {
        const p = await imagePartFromBlock(b)
        if (p) parts.push(p)
      }
    }
    if (parts.length > 0) out.push({ role, parts })
  }

  // Gemini rejects an empty conversation outright.
  if (out.length === 0) out.push({ role: 'user', parts: [{ text: '(no content)' }] })
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// GROUNDING REDIRECT RESOLUTION
//
// Gemini does not hand back the publisher's URL. Every grounded citation is a
// Google redirect:
//
//   https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQ...
//
// seo-worker-research attaches these to its report as the source list, so
// without resolution a Gemini-backed report cites opaque tokens where the
// Anthropic path cites real domains — and those tokens are not durable, so an
// old report degrades to dead links. That is a straight downgrade on the exact
// axis this migration is meant to improve.
//
// Resolution is one HTTP hop per source with redirect:'manual', reading the
// Location header — no page body is fetched. Two fallbacks, in order, because
// the redirect could be served as a 3xx today and something else tomorrow:
//   1. Location header from a manual-redirect HEAD
//   2. res.url after following redirects (GET, but body left unread)
// If both fail the ORIGINAL redirect URL is kept. A citation that still works
// beats no citation, so this can degrade but never lose a source.
//
// All sources resolve concurrently against one short deadline, so the added
// latency is one hop rather than N — which matters inside seo-worker-research's
// 60s web-phase cap.
const REDIRECT_HOST = 'vertexaisearch.cloud.google.com'
const RESOLVE_TIMEOUT_MS = 4_000

async function resolveOneRedirect(url: string): Promise<string> {
  if (!url.includes(REDIRECT_HOST)) return url   // already a real URL
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), RESOLVE_TIMEOUT_MS)
  try {
    const head = await fetch(url, { method: 'HEAD', redirect: 'manual', signal: ctl.signal })
    const loc = head.headers.get('location')
    if (loc && /^https?:\/\//.test(loc) && !loc.includes(REDIRECT_HOST)) return loc

    const got = await fetch(url, { method: 'GET', redirect: 'follow', signal: ctl.signal })
    // Release the connection without buffering the page.
    try { await got.body?.cancel() } catch { /* already closed */ }
    if (got.url && !got.url.includes(REDIRECT_HOST)) return got.url
    return url
  } catch (e: any) {
    console.warn(`[gemini] grounding redirect unresolved (keeping redirect url): ${e?.message ?? e}`)
    return url
  } finally {
    clearTimeout(t)
  }
}

async function resolveGroundingUrls(
  sources: Array<{ title: string; url: string }>,
): Promise<Array<{ title: string; url: string }>> {
  if (sources.length === 0) return sources
  const resolved = await Promise.all(sources.map(async s => ({ ...s, url: await resolveOneRedirect(s.url) })))
  // Distinct redirects can land on the same article, so dedupe AFTER resolving.
  // Keep the first title seen — Gemini's titles are ordered by relevance.
  const seen = new Set<string>()
  const out: Array<{ title: string; url: string }> = []
  for (const s of resolved) {
    if (seen.has(s.url)) continue
    seen.add(s.url)
    out.push(s)
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC ENTRY
// ─────────────────────────────────────────────────────────────────────────────
export interface CallGeminiExtras {
  // Google Search grounding — the reason this adapter exists. Mutually
  // exclusive with functionDeclarations in Gemini's API: a request carrying
  // both is rejected, which is why seo-worker-research already runs its search
  // phase as an isolated turn with its own tool set.
  googleSearch?: boolean
  // Structured output. When set, Gemini is constrained to emit JSON matching
  // this schema, so the response needs no fence-stripping and cannot come back
  // as prose. Ignored when tools are in play (Gemini forbids the combination).
  responseSchema?: Record<string, unknown>
}

export async function callGemini(
  opts: CallClaudeOptions & CallGeminiExtras,
): Promise<CallClaudeResult> {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY env var not set')

  // Fallback only — every Wave A slot passes an explicit model. It must still
  // be a REAL id: 'gemini-3.1-flash' was used here originally and does not
  // exist on this endpoint (404 NOT_FOUND on every call). Verify any new id
  // against GET /v1beta/models before using it.
  const model = opts.model ?? 'gemini-2.5-flash'
  const contents = await toGeminiContents(opts.messages)

  const body: Record<string, unknown> = {
    contents,
    systemInstruction: { parts: [{ text: opts.system }] },
    generationConfig: {
      maxOutputTokens: opts.maxTokens ?? 8192,
      ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
      // THINKING EATS THE OUTPUT BUDGET. Gemini 2.5+ defaults to dynamic
      // "thinking", and those tokens are drawn from maxOutputTokens BEFORE any
      // visible text — so a caller with a tight cap gets a truncated or empty
      // answer with finishReason STOP and no error anywhere. Measured on
      // scout-tick (maxTokens 500): three calls returned out=8, out=8, out=142
      // tokens, the JSON was unparseable, and the worker reported
      // "signals_found 3, tasks_created 0" with nothing in the logs.
      //
      // vertex-imagen-edit hit this same trap and disables thinking outright.
      // Here it is tied to `effort`, the knob callers already use to ask for
      // reasoning depth: no effort → no thinking, which suits the structured
      // extraction and short-synthesis calls that make up Wave A. A caller that
      // sets effort keeps Gemini's default dynamic thinking, and must budget
      // maxTokens for it.
      ...(opts.effort ? {} : { thinkingConfig: { thinkingBudget: 0 } }),
    },
  }

  // Tool wiring. google_search and functionDeclarations cannot coexist, so the
  // caller picks one; grounding wins if both are somehow set, because a caller
  // asking for grounding is asking for the thing this adapter is for.
  if (opts.googleSearch) {
    body.tools = [{ google_search: {} }]
  } else if (opts.tools && opts.tools.length > 0) {
    body.tools = [{ functionDeclarations: toFunctionDeclarations(opts.tools) }]
  } else if (opts.responseSchema) {
    // responseSchema is only legal without tools.
    ;(body.generationConfig as Record<string, unknown>).responseMimeType = 'application/json'
    ;(body.generationConfig as Record<string, unknown>).responseSchema = sanitizeSchema(opts.responseSchema)
  }

  const controller = new AbortController()
  const timeoutMs = opts.timeoutMs ?? 110_000   // stay under the 150s edge cap
  const t = setTimeout(() => controller.abort(), timeoutMs)

  let res: Response
  try {
    res = await fetch(`${GEMINI_API_BASE}/${model}:generateContent`, {
      method: 'POST',
      headers: {
        'x-goog-api-key': GEMINI_API_KEY,
        'content-type':   'application/json',
      },
      body:   JSON.stringify(body),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(t)
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(`Gemini ${model} ${res.status}: ${errText.slice(0, 500)}`)
  }

  const json = await res.json() as {
    candidates?: Array<{
      content?:      { parts?: GeminiPart[] }
      finishReason?: string
      groundingMetadata?: {
        groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>
      }
    }>
    usageMetadata?: {
      promptTokenCount?:        number
      candidatesTokenCount?:    number
      cachedContentTokenCount?: number
    }
  }

  const cand  = json.candidates?.[0]
  const parts = cand?.content?.parts ?? []

  // Map Gemini parts back into Anthropic-shaped blocks so every existing caller
  // — which switches on block.type — keeps working untouched. Gemini has no
  // tool-call ids, so one is synthesized per call; it only has to be unique
  // within this response for the caller's tool loop to pair result to call.
  const content: MessageContentBlock[] = []
  let text = ''
  let sawFunctionCall = false
  parts.forEach((p, i) => {
    if (typeof p.text === 'string' && p.text !== '') {
      text += p.text
      content.push({ type: 'text', text: p.text })
    }
    if (p.functionCall) {
      sawFunctionCall = true
      content.push({
        type:  'tool_use',
        id:    `gemini_${Date.now()}_${i}`,
        name:  p.functionCall.name,
        input: p.functionCall.args ?? {},
      })
    }
  })

  // stop_reason is normalized to Anthropic's vocabulary because callers branch
  // on those exact strings. A function call outranks the raw finishReason:
  // Gemini reports STOP alongside a functionCall, which a caller would read as
  // "conversation over" and drop the pending tool call on the floor.
  const finish = cand?.finishReason ?? 'STOP'
  const stop_reason = sawFunctionCall
    ? 'tool_use'
    : finish === 'MAX_TOKENS' ? 'max_tokens'
    : finish === 'STOP'       ? 'end_turn'
    : finish.toLowerCase()

  const inputTokens  = json.usageMetadata?.promptTokenCount ?? 0
  const outputTokens = json.usageMetadata?.candidatesTokenCount ?? 0
  // Gemini reports cached tokens INSIDE promptTokenCount, unlike Anthropic
  // which reports them separately. Subtract so the two providers' ledger rows
  // mean the same thing and uncached input is never double-counted.
  const cacheReadTokens = json.usageMetadata?.cachedContentTokenCount ?? 0
  const uncachedInput   = Math.max(0, inputTokens - cacheReadTokens)

  // GROUNDING SOURCES. Anthropic returns cited URLs as web_search_tool_result
  // content blocks; Gemini returns them out-of-band in groundingMetadata, with
  // no equivalent block in the parts array. Callers that need real source URLs
  // (seo-worker-research attaches them to its report rather than trusting the
  // model to repeat them in prose) therefore cannot use one extractor for both,
  // so the normalized list is surfaced here as its own field.
  const groundingSources: Array<{ title: string; url: string }> = []
  const seenUrls = new Set<string>()
  for (const chunk of cand?.groundingMetadata?.groundingChunks ?? []) {
    const url = chunk.web?.uri?.trim()
    if (!url || seenUrls.has(url)) continue
    seenUrls.add(url)
    groundingSources.push({ title: chunk.web?.title?.trim() || url, url })
  }

  // Only pay the resolution hop when grounding actually returned something.
  const resolvedSources = groundingSources.length > 0
    ? await resolveGroundingUrls(groundingSources.slice(0, 12))
    : groundingSources

  logGeminiCost(opts, { model, inputTokens: uncachedInput, outputTokens, cacheReadTokens })

  return {
    text,
    content,
    stop_reason,
    inputTokens:         uncachedInput,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens: 0,   // Gemini's explicit cache is not used here
    model,
    groundingSources:    resolvedSources.length > 0 ? resolvedSources : undefined,
  }
}

// Cost ledger, deliberately mirroring claude.ts's logCost so both providers
// land in one table and the migration can actually be costed. It is duplicated
// rather than imported on purpose: claude.ts imports callGemini from here, so a
// VALUE import back would close a runtime import cycle. The type imports above
// are erased at runtime and are therefore safe.
//
// Same waitUntil guard as claude.ts: a bare un-awaited fetch races isolate
// teardown, and getMonthToDateSpendUsd sums this table to enforce the budget
// ceiling — dropped rows read as under-spend and the kill-switch can miss.
function logGeminiCost(
  opts: CallClaudeOptions,
  usage: { model: string; inputTokens: number; outputTokens: number; cacheReadTokens: number },
): void {
  if (!opts.sourceFn) return   // unattributed call — nothing useful to record
  const url = Deno.env.get('SUPABASE_URL')
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !key) return

  const full: TokenUsage = { ...usage, cacheCreationTokens: 0 }
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
      cache_creation_tokens: 0,
      est_usd:               estimateUsd(full),
    }),
  })
    .then(r => { if (!r.ok) return r.text().then(t => console.warn(`[cost-ledger] ${opts.sourceFn} insert ${r.status}: ${t.slice(0, 200)}`)) })
    .catch(e => console.warn(`[cost-ledger] ${opts.sourceFn} insert failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`))
  // @ts-ignore — EdgeRuntime is injected by the Supabase edge runtime.
  if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime?.waitUntil) {
    // @ts-ignore
    EdgeRuntime.waitUntil(post)
  }
}
