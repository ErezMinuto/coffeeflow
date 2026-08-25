// Conversion tests for the Gemini adapter.
//
// These cover the translation layer ONLY — no network. That is deliberate: the
// network call is a thin fetch, while the conversions are where a silent
// mistranslation would corrupt an agent loop without ever raising an error.
// The two failure modes worth guarding are exactly the ones that do not throw:
// a tool result Gemini cannot attribute (wrong function name) and a schema
// keyword that 400s the request before any token is generated.
//
// Run:  deno test supabase/functions/seo-agent/gemini.test.ts

import { assertEquals, assert } from 'https://deno.land/std@0.208.0/assert/mod.ts'
import {
  sanitizeSchema,
  toFunctionDeclarations,
  buildToolNameMap,
  toGeminiContents,
  isGeminiModel,
} from './gemini.ts'
import type { ChatMessage, ToolDefinition } from './claude.ts'

Deno.test('isGeminiModel routes only gemini ids', () => {
  assert(isGeminiModel('gemini-3.1-flash'))
  assert(isGeminiModel('gemini-3.1-pro'))
  assert(!isGeminiModel('claude-sonnet-4-6'))
  assert(!isGeminiModel('claude-fable-5'))
})

Deno.test('sanitizeSchema drops vocabulary Gemini rejects', () => {
  const out = sanitizeSchema({
    $schema:              'https://json-schema.org/draft-07/schema#',
    type:                 'object',
    additionalProperties: false,
    properties: {
      name:  { type: 'string', description: 'keep me', format: 'email' },
      count: { type: 'integer', minimum: 0, maximum: 10 },
    },
    required: ['name'],
  }) as Record<string, any>

  // Unknown keywords gone at every level...
  assertEquals(out.$schema, undefined)
  assertEquals(out.additionalProperties, undefined)
  assertEquals(out.properties.name.format, undefined)
  assertEquals(out.properties.count.minimum, undefined)
  // ...while the meaning-bearing ones survive.
  assertEquals(out.type, 'object')
  assertEquals(out.required, ['name'])
  assertEquals(out.properties.name.description, 'keep me')
  assertEquals(out.properties.count.type, 'integer')
})

Deno.test('sanitizeSchema recurses into arrays and gives every node a type', () => {
  const out = sanitizeSchema({
    type:  'object',
    properties: {
      items: {
        type:  'array',
        items: { type: 'object', properties: { q: { type: 'string' } }, additionalProperties: true },
      },
      // A node carrying no `type` at all would 400 the request; it must be
      // defaulted rather than passed through bare.
      loose: { description: 'no type given', oneOf: [{ type: 'string' }] },
    },
  }) as Record<string, any>

  assertEquals(out.properties.items.items.additionalProperties, undefined)
  assertEquals(out.properties.items.items.properties.q.type, 'string')
  assertEquals(out.properties.loose.type, 'string')
  assertEquals(out.properties.loose.oneOf, undefined)
})

Deno.test('toFunctionDeclarations renames input_schema to parameters', () => {
  const tools: ToolDefinition[] = [{
    name:         'query_minuto',
    description:  'Query internal data',
    input_schema: { type: 'object', properties: { sql: { type: 'string' } }, additionalProperties: false },
  }]
  const [decl] = toFunctionDeclarations(tools) as Array<Record<string, any>>
  assertEquals(decl.name, 'query_minuto')
  assertEquals(decl.description, 'Query internal data')
  assert(decl.parameters, 'input_schema must be carried over as parameters')
  assertEquals(decl.parameters.properties.sql.type, 'string')
  assertEquals(decl.parameters.additionalProperties, undefined)
})

// THE important one. Anthropic keys a tool result by tool_use_id; Gemini keys
// it by function NAME. Losing that mapping does not throw — the model just
// receives a result it cannot attribute and re-calls the same tool forever.
Deno.test('tool_result recovers its function name from the earlier tool_use', async () => {
  const messages: ChatMessage[] = [
    { role: 'user', content: 'How many bags sold?' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Let me check.' },
        { type: 'tool_use', id: 'toolu_abc123', name: 'query_minuto', input: { sql: 'select 1' } },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_abc123', content: '{"rows":[{"n":42}]}' },
      ],
    },
  ]

  assertEquals(buildToolNameMap(messages).get('toolu_abc123'), 'query_minuto')

  const contents = await toGeminiContents(messages)
  assertEquals(contents.length, 3)
  assertEquals(contents[1].role, 'model')              // assistant → model
  assertEquals(contents[1].parts[1].functionCall?.name, 'query_minuto')

  const fr = contents[2].parts[0].functionResponse
  assertEquals(fr?.name, 'query_minuto')               // recovered, not 'unknown_tool'
  assertEquals((fr?.response as any).rows[0].n, 42)    // JSON string parsed into an object
})

Deno.test('non-JSON and error tool results are wrapped, not dropped', async () => {
  const messages: ChatMessage[] = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'fetch_url', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'plain text body' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'fetch_url', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'boom', is_error: true }] },
  ]
  const contents = await toGeminiContents(messages)
  assertEquals((contents[1].parts[0].functionResponse?.response as any).result, 'plain text body')
  assertEquals((contents[3].parts[0].functionResponse?.response as any).error.result, 'boom')
})

Deno.test('empty messages are dropped and the conversation is never empty', async () => {
  // Gemini 400s on an empty part and on an empty contents array; both are
  // reachable from real callers (a blank nudge, an all-image message).
  assertEquals((await toGeminiContents([{ role: 'user', content: '   ' }])).length, 1)
  assertEquals((await toGeminiContents([]))[0].parts[0].text, '(no content)')

  const onlyBlank = await toGeminiContents([
    { role: 'user', content: [{ type: 'text', text: '' }] },
  ])
  assertEquals(onlyBlank[0].parts[0].text, '(no content)')
})

Deno.test('inline base64 images convert without a network fetch', async () => {
  const contents = await toGeminiContents([{
    role: 'user',
    content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      { type: 'text',  text: 'Evaluate this.' },
    ],
  }])
  assertEquals(contents[0].parts[0].inlineData?.mimeType, 'image/png')
  assertEquals(contents[0].parts[0].inlineData?.data, 'AAAA')
  assertEquals(contents[0].parts[1].text, 'Evaluate this.')
})
