// Request shape callClaude sends for Opus 5.5 vs a pre-5 model. The request is
// captured by stubbing fetch, so no network or key is needed.
//
// Run:  deno test --allow-env supabase/functions/seo-agent/claude.opus55.test.ts

import { assert, assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts'
import { claudeBody, claudeText } from '../_shared/claude.ts'

// claude.ts reads ANTHROPIC_API_KEY at module load, so set it before importing.
Deno.env.set('ANTHROPIC_API_KEY', 'test-key')
const { callClaude, CLAUDE_DEFAULT_MODEL } = await import('./claude.ts')

type Captured = { body: Record<string, any>; headers: Record<string, string> }

async function capture(opts: Parameters<typeof callClaude>[0], reply: unknown): Promise<{ sent: Captured; res: Awaited<ReturnType<typeof callClaude>> }> {
  const realFetch = globalThis.fetch
  let sent: Captured | null = null
  globalThis.fetch = ((_url: string, init: RequestInit) => {
    sent = { body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> }
    return Promise.resolve(new Response(JSON.stringify(reply), { status: 200 }))
  }) as typeof fetch
  try {
    const res = await callClaude(opts)
    return { sent: sent!, res }
  } finally {
    globalThis.fetch = realFetch
  }
}

const REPLY = {
  model: 'claude-opus-5-5',
  stop_reason: 'end_turn',
  content: [
    { type: 'thinking', thinking: '', signature: 'sig' },
    { type: 'text', text: '{"ok":true}' },
  ],
  usage: { input_tokens: 10, output_tokens: 5 },
}

Deno.test('every Claude slot defaults to Opus 5.5', () => {
  assertEquals(CLAUDE_DEFAULT_MODEL, 'claude-opus-5-5')
})

Deno.test('Opus 5.5: no temperature, floored max_tokens, explicit effort, fallback, drop_block', async () => {
  const { sent } = await capture(
    { model: 'claude-opus-5-5', system: 's', messages: [{ role: 'user', content: 'hi' }], maxTokens: 200, temperature: 0.3 },
    REPLY,
  )
  assertEquals(sent.body.temperature, undefined)
  assertEquals(sent.body.max_tokens, 16_000)
  assertEquals(sent.body.output_config, { effort: 'medium' })
  assertEquals(sent.body.fallbacks, 'default')
  assertEquals(sent.body.thinking, { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } })
  const betas = sent.headers['anthropic-beta'].split(',')
  assert(betas.includes('server-side-fallback-2026-07-01'))
  assert(betas.includes('thinking-binding-controls-2026-08-01'))
})

Deno.test('Opus 5.5: a caller-supplied effort wins over the default', async () => {
  const { sent } = await capture(
    { model: 'claude-opus-5-5', system: 's', messages: [{ role: 'user', content: 'hi' }], effort: 'high' },
    REPLY,
  )
  assertEquals(sent.body.output_config, { effort: 'high' })
})

Deno.test('Opus 5.5: a leading thinking block does not hide the text', async () => {
  const { res } = await capture({ model: 'claude-opus-5-5', system: 's', messages: [{ role: 'user', content: 'hi' }] }, REPLY)
  assertEquals(res.text, '{"ok":true}')
  assertEquals(res.content.length, 2)   // thinking block kept for tool-loop replay
})

Deno.test('a slot rolled back to Sonnet 4.6 keeps its old request shape', async () => {
  const { sent } = await capture(
    { model: 'claude-sonnet-4-6', system: 's', messages: [{ role: 'user', content: 'hi' }], maxTokens: 200, temperature: 0.3 },
    { ...REPLY, content: [{ type: 'text', text: 'x' }] },
  )
  assertEquals(sent.body.temperature, 0.3)
  assertEquals(sent.body.max_tokens, 200)
  assertEquals(sent.body.fallbacks, undefined)
  assertEquals(sent.body.thinking, undefined)
  assertEquals(sent.headers['anthropic-beta'], undefined)
})

Deno.test('a slot rolled back to Fable 5 keeps its pinned Opus 4.8 fallback', async () => {
  const { sent } = await capture({ model: 'claude-fable-5', system: 's', messages: [{ role: 'user', content: 'hi' }] }, REPLY)
  assertEquals(sent.body.fallbacks, [{ model: 'claude-opus-4-8' }])
  assertEquals(sent.headers['anthropic-beta'], 'server-side-fallback-2026-06-01')
})

// ── _shared/claude.ts (direct-fetch callers) ────────────────────────────────

Deno.test('claudeBody floors max_tokens and defaults to low effort + fallback', () => {
  const b = claudeBody({ messages: [], maxTokens: 120 })
  assertEquals(b.model, 'claude-opus-5-5')
  assertEquals(b.max_tokens, 16_000)
  assertEquals(b.output_config, { effort: 'low' })
  assertEquals(b.fallbacks, 'default')
  assertEquals('temperature' in b, false)
})

Deno.test('claudeText skips thinking blocks and tolerates an error body', () => {
  assertEquals(claudeText(REPLY), '{"ok":true}')
  assertEquals(claudeText({ error: { message: 'x' } } as any), '')
  assertEquals(claudeText(null), '')
})
