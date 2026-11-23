// Reading a strategist run's own message history (state.messages): which
// tools the model called, and what a tool returned. Assistant turns hold
// tool_use blocks (pushed before they are dispatched); the following user
// turn holds the matching tool_result blocks. Pure — no database.

interface Block { type?: string; name?: string; id?: string; input?: unknown; tool_use_id?: string; content?: unknown }
interface Message { role: string; content: unknown }

const blocks = (m: Message): Block[] => (Array.isArray(m.content) ? (m.content as Block[]) : [])

/** Every tool call in the run so far, in order. */
export function toolCallsIn(messages: Message[]): Array<{ name: string; input: Record<string, unknown> }> {
  return messages.flatMap((m) => blocks(m)
    .filter((b) => b?.type === 'tool_use' && typeof b.name === 'string')
    .map((b) => ({ name: b.name as string, input: (b.input ?? {}) as Record<string, unknown> })))
}

/** The parsed result of the most recent call to `toolName`, or null (never called, or unreadable). */
export function latestToolResult(messages: Message[], toolName: string): Record<string, unknown> | null {
  const ids = new Set<string>()
  for (const m of messages) for (const b of blocks(m)) if (b?.type === 'tool_use' && b.name === toolName && b.id) ids.add(b.id)
  for (let i = messages.length - 1; i >= 0; i--) {
    const bs = blocks(messages[i])
    for (let j = bs.length - 1; j >= 0; j--) {   // latest first, also within one turn
      const b = bs[j]
      if (b?.type === 'tool_result' && b.tool_use_id && ids.has(b.tool_use_id)) {
        if (b.content && typeof b.content === 'object' && !Array.isArray(b.content)) return b.content as Record<string, unknown>
        try { return JSON.parse(String(b.content)) as Record<string, unknown> } catch { return null }
      }
    }
  }
  return null
}

/** Every tool result in the run (strings as stored, objects as is) — the data the model actually received. */
export function toolResultValues(messages: Message[]): unknown[] {
  const out: unknown[] = []
  for (const m of messages) for (const b of blocks(m)) if (b?.type === 'tool_result') out.push(b.content ?? null)
  return out
}

/** What a model turn amounts to, for the runner:
 *  - 'tool'   : it called tools (dispatch them);
 *  - 'retry'  : nothing usable — a blank answer, or one cut off at the output
 *               limit before any tool call. Not a decision by the model: drop
 *               it and ask again (Gemini, 2026-11-23: a blank turn in 5 s, and
 *               brief-writing turns cut off at 12k tokens, ended a run as
 *               "model ended turn twice");
 *  - 'ended'  : it answered in text and stopped (nudge it to conclude). */
export function turnKind(content: Array<{ type?: string; text?: string }>, stopReason: string | null | undefined): 'tool' | 'retry' | 'ended' {
  // Cut off first: a tool call written up to the limit may be truncated (never run it).
  // (Gemini reports a complete function call as tool_use even at the limit.)
  if (stopReason === 'max_tokens') return 'retry'
  if (content.some((b) => b?.type === 'tool_use')) return 'tool'
  const said = content.some((b) => b?.type === 'text' && typeof b.text === 'string' && b.text.trim() !== '')
  return said ? 'ended' : 'retry'
}
