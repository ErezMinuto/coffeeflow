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

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'

// Latest Claude model IDs. Updated 2026-05-26 to Opus 4.7 / Sonnet 4.6
// / Haiku 4.5 per the platform's current naming. The orchestrator uses
// Sonnet for self-reflection (better at structured planning than Haiku,
// cheaper than Opus). The chat handler can use Sonnet by default and
// upgrade to Opus on-demand for hard tasks.
export const MODEL_ORCHESTRATOR = 'claude-sonnet-4-6'
export const MODEL_WRITER       = 'claude-sonnet-4-6'
export const MODEL_CHAT         = 'claude-sonnet-4-6'

// Anthropic Messages API shapes — minimal, just what we use.

export interface MessageContentText {
  type: 'text'
  text: string
}
export interface MessageContentToolUse {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}
export interface MessageContentToolResult {
  type: 'tool_result'
  tool_use_id: string
  content: string
  is_error?: boolean
}
export type MessageContentBlock =
  | MessageContentText
  | MessageContentToolUse
  | MessageContentToolResult

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
  temperature?: number
  tools?: ToolDefinition[]
  timeoutMs?: number
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
  const body: Record<string, unknown> = {
    model,
    max_tokens: opts.maxTokens ?? 8192,
    system: opts.system,
    messages: opts.messages,
  }
  if (opts.temperature != null) body.temperature = opts.temperature
  if (opts.tools && opts.tools.length > 0) body.tools = opts.tools

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

  return {
    text,
    content,
    stop_reason:        json.stop_reason ?? 'unknown',
    inputTokens:        json.usage?.input_tokens ?? 0,
    outputTokens:       json.usage?.output_tokens ?? 0,
    cacheReadTokens:    json.usage?.cache_read_input_tokens ?? 0,
    cacheCreationTokens: json.usage?.cache_creation_input_tokens ?? 0,
    model:              json.model ?? model,
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
