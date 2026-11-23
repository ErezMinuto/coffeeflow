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
    for (const b of blocks(messages[i])) {
      if (b?.type === 'tool_result' && b.tool_use_id && ids.has(b.tool_use_id)) {
        try { return JSON.parse(String(b.content)) as Record<string, unknown> } catch { return null }
      }
    }
  }
  return null
}
