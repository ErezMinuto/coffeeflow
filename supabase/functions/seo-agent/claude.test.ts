// deno test supabase/functions/seo-agent/claude.test.ts
//
// Run with: deno test --allow-env supabase/functions/seo-agent/claude.test.ts
// (--allow-env only because claude.ts reads ANTHROPIC_API_KEY at module load.)
// withMessageBreakpoint decides where the conversation-history cache
// breakpoint goes. Two properties matter enough to pin down: it must never
// mutate the caller's array (strategist-brain persists state.messages to the
// DB between ticks, so an in-place edit would poison stored state), and it
// must never emit an empty text block (a 400 from the API).

import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { withMessageBreakpoint, parseClaudeJson, type ChatMessage } from './claude.ts'

Deno.test('single message is left alone — nothing to reuse on a one-shot call', () => {
  const one: ChatMessage[] = [{ role: 'user', content: 'hi' }]
  assertEquals(withMessageBreakpoint(one), one)
})

Deno.test('marks the last message and does not mutate the input', () => {
  const hist: ChatMessage[] = [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'reply' },
    { role: 'user', content: 'second' },
  ]
  const before = JSON.stringify(hist)
  const out = withMessageBreakpoint(hist)

  assertEquals(JSON.stringify(hist), before, 'caller array must be untouched')
  assert(typeof out[0].content === 'string', 'earlier turns stay as-is')
  const marked = out[2].content as Array<{ cache_control?: { type: string } }>
  assertEquals(marked[0].cache_control?.type, 'ephemeral')
})

Deno.test('marks only the LAST block of a block-array message', () => {
  const msgs: ChatMessage[] = [
    { role: 'user', content: 'q' },
    { role: 'assistant', content: [
      { type: 'text', text: 'thinking' },
      { type: 'tool_use', id: 't1', name: 'x', input: {} },
    ] },
  ]
  const before = JSON.stringify(msgs)
  const out = withMessageBreakpoint(msgs)

  assertEquals(JSON.stringify(msgs), before, 'caller array must be untouched')
  const blocks = out[1].content as Array<{ cache_control?: { type: string } }>
  assertEquals(blocks[1].cache_control?.type, 'ephemeral')
  assertEquals(blocks[0].cache_control, undefined)
})

Deno.test('skips blank trailing content rather than emitting an empty text block', () => {
  const blank: ChatMessage[] = [{ role: 'user', content: 'q' }, { role: 'assistant', content: '   ' }]
  assertEquals(withMessageBreakpoint(blank), blank)

  const noBlocks: ChatMessage[] = [{ role: 'user', content: 'q' }, { role: 'assistant', content: [] }]
  assertEquals(withMessageBreakpoint(noBlocks), noBlocks)
})

// parseClaudeJson — the writer on 2026-10-21 printed a self-check list
// holding a markdown link before its JSON; the old parser tried the link.
Deno.test('parseClaudeJson skips a markdown link in prose before the JSON', () => {
  const text = [
    '*   *H1:* פולי קפה ערביקה: לא רק טעם',
    '*   Product 1: [פולי קפה טרי 100% ערביקה - Minuto Dark Chocolate](https://www.minuto.co.il/product/x)',
    '',
    '{"title": "t", "slug": "s", "meta_description": "m", "body": "<p>[not a link] {x}</p>"}',
  ].join('\n')
  assertEquals(parseClaudeJson(text), { title: 't', slug: 's', meta_description: 'm', body: '<p>[not a link] {x}</p>' })
})

Deno.test('parseClaudeJson still reads fenced and bare JSON', () => {
  assertEquals(parseClaudeJson('Here it is:\n```json\n{"a": 1}\n```'), { a: 1 })
  assertEquals(parseClaudeJson('[1, 2]'), [1, 2])
})

Deno.test('parseClaudeJson falls back to the whole text when the fence holds no JSON', () => {
  assertEquals(parseClaudeJson('```\nnot json\n```\n{"ok": true}'), { ok: true })
})

Deno.test('parseClaudeJson still throws when nothing parses', () => {
  let threw = false
  try { parseClaudeJson('no json here') } catch { threw = true }
  assert(threw)
  threw = false
  try { parseClaudeJson('{"truncated": "mid') } catch { threw = true }
  assert(threw)
})
