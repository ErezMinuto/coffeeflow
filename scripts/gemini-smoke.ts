#!/usr/bin/env -S deno run --allow-net --allow-env
//
// Live smoke test for the Gemini provider switch (seo-agent/gemini.ts).
//
// Exercises the adapter END TO END against the real API — not the raw Gemini
// endpoint, but our own callGemini, so a passing run proves the CONVERSIONS
// work, which is where the risk actually is. gemini.test.ts already covers the
// conversions offline; this covers the half that only a real request can prove:
// that the model ids exist, the key works, the schemas are accepted rather than
// 400'd, grounding returns real source URLs, and a tool call round-trips.
//
// It NEVER writes to the database and never touches a task queue. sourceFn is
// deliberately left unset so not even a cost-ledger row is produced.
//
// Usage — the key is READ FROM THE ENVIRONMENT, never pasted as an argument
// (an argv secret lands in shell history and in `ps`):
//
//   read -rs GEMINI_API_KEY && export GEMINI_API_KEY
//   deno run --allow-net --allow-env scripts/gemini-smoke.ts
//
// Optional: pick the model to probe (defaults to the cheap flash tier)
//   GEMINI_SMOKE_MODEL=gemini-2.5-pro deno run ... scripts/gemini-smoke.ts
//
// LIST THE REAL MODEL IDS before picking one — they are not guessable, and a
// wrong id fails as 404 NOT_FOUND on every call:
//   curl -s "https://generativelanguage.googleapis.com/v1beta/models?key=$GEMINI_API_KEY" \
//     | jq -r '.models[] | select(.supportedGenerationMethods[]? == "generateContent") | .name'

import { callGemini } from '../supabase/functions/seo-agent/gemini.ts'
import type { ToolDefinition } from '../supabase/functions/seo-agent/claude.ts'

const MODEL = Deno.env.get('GEMINI_SMOKE_MODEL') ?? 'gemini-2.5-flash'

if (!Deno.env.get('GEMINI_API_KEY')) {
  console.error('GEMINI_API_KEY is not set. Run:  read -rs GEMINI_API_KEY && export GEMINI_API_KEY')
  Deno.exit(2)
}

let passed = 0
let failed = 0

async function check(name: string, fn: () => Promise<string | null>): Promise<void> {
  const started = Date.now()
  try {
    const problem = await fn()
    const ms = Date.now() - started
    if (problem) {
      failed++
      console.log(`  FAIL  ${name}  (${ms}ms)\n        ${problem}`)
    } else {
      passed++
      console.log(`  ok    ${name}  (${ms}ms)`)
    }
  } catch (e: any) {
    failed++
    console.log(`  FAIL  ${name}  (${Date.now() - started}ms)\n        threw: ${e?.message ?? e}`)
  }
}

console.log(`\nGemini adapter smoke test — model=${MODEL}\n`)

// 1. The floor: does a plain call work at all, and does usage come back?
// If this fails, nothing else is worth reading — it is the key or the model id.
await check('plain text completion', async () => {
  const r = await callGemini({
    model:     MODEL,
    system:    'You answer with a single word, nothing else.',
    messages:  [{ role: 'user', content: 'What colour is a ripe coffee cherry?' }],
    maxTokens: 20,
  })
  if (!r.text.trim()) return 'empty text'
  if (r.stop_reason !== 'end_turn') return `stop_reason=${r.stop_reason}, expected end_turn`
  if (r.inputTokens <= 0 || r.outputTokens <= 0) {
    return `usage not reported (in=${r.inputTokens} out=${r.outputTokens}) — the cost ledger would record zeros`
  }
  console.log(`        → "${r.text.trim().slice(0, 60)}"  [in=${r.inputTokens} out=${r.outputTokens}]`)
  return null
})

// 2. responseSchema — the thing that removes the parseClaudeJson failure class.
// Proves our sanitizeSchema output is ACCEPTED (a rejected schema is a 400) and
// that the reply needs no fence-stripping.
await check('responseSchema returns clean JSON', async () => {
  const r = await callGemini({
    model:    MODEL,
    system:   'You extract structured data. Output only what the schema allows.',
    messages: [{ role: 'user', content: 'Two Ethiopian coffee regions with a one-line flavour note each.' }],
    maxTokens: 400,
    responseSchema: {
      type: 'object',
      properties: {
        regions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              note: { type: 'string' },
            },
            required: ['name', 'note'],
          },
        },
      },
      required: ['regions'],
    },
  })
  // The whole point: parse WITHOUT any fence stripping.
  let parsed: any
  try {
    parsed = JSON.parse(r.text)
  } catch {
    return `reply was not raw JSON (would need fence-stripping): ${r.text.slice(0, 120)}`
  }
  if (!Array.isArray(parsed?.regions) || parsed.regions.length === 0) return 'no regions array'
  if (!parsed.regions[0].name || !parsed.regions[0].note) return 'schema fields missing on first item'
  console.log(`        → ${parsed.regions.length} regions, first = ${parsed.regions[0].name}`)
  return null
})

// 3. Google Search grounding — THE reason for the migration. A pass here means
// the agent can cite Google's own index. groundingSources is checked because
// seo-worker-research attaches those URLs to its report rather than trusting
// the model to repeat them in prose.
await check('google_search grounding returns real sources', async () => {
  const r = await callGemini({
    model:        MODEL,
    system:       'You are a research assistant. Cite what you find.',
    messages:     [{ role: 'user', content: 'What is Israeli specialty coffee roaster Minuto known for? Search the web.' }],
    maxTokens:    600,
    googleSearch: true,
  })
  if (!r.text.trim()) return 'empty text'
  if (!r.groundingSources || r.groundingSources.length === 0) {
    return 'no groundingSources — grounding did not run, or groundingMetadata parsing is wrong. ' +
           'This is the migration\'s whole purpose; do NOT flip MODEL_RESEARCH until it passes.'
  }
  const bad = r.groundingSources.find(s => !/^https?:\/\//.test(s.url))
  if (bad) return `source url is not http(s): ${bad.url}`
  // THE CITATIONS MUST BE REAL PUBLISHER URLS. Gemini hands back
  // vertexaisearch.cloud.google.com/grounding-api-redirect/<token> links;
  // seo-worker-research puts these straight into its report as the source list,
  // so an unresolved redirect means the report cites opaque, non-durable tokens
  // where the Anthropic path cites real domains — a downgrade on the exact axis
  // this migration exists to improve. callGemini resolves them; this asserts it.
  const unresolved = r.groundingSources.filter(s => s.url.includes('vertexaisearch.cloud.google.com'))
  if (unresolved.length === r.groundingSources.length) {
    return `all ${unresolved.length} citations are still Google redirect URLs — resolution did not run. `
         + 'Do NOT flip MODEL_RESEARCH: reports would cite opaque, expiring links.'
  }
  console.log(`        → ${r.groundingSources.length} sources`
    + (unresolved.length ? ` (${unresolved.length} unresolved)` : ' (all resolved)'))
  for (const s of r.groundingSources.slice(0, 3)) {
    console.log(`             ${s.url.slice(0, 78)}`)
  }
  return null
})

// 4. Tool calling — proves input_schema→parameters conversion is accepted and
// that a functionCall is surfaced as an Anthropic-shaped tool_use block with
// stop_reason 'tool_use'. Callers branch on exactly that; Gemini reports STOP
// alongside a functionCall, so a naive mapping would drop the pending call.
await check('tool call surfaces as tool_use', async () => {
  const tools: ToolDefinition[] = [{
    name:        'get_stock_level',
    description: 'Look up the current packed stock for one coffee product.',
    input_schema: {
      // Deliberately includes keys Gemini rejects, so this also proves the
      // sanitizer is doing its job on a real request.
      $schema:              'https://json-schema.org/draft-07/schema#',
      type:                 'object',
      additionalProperties: false,
      properties: {
        product_name: { type: 'string', description: 'Product name', format: 'text' },
      },
      required: ['product_name'],
    },
  }]
  const r = await callGemini({
    model:     MODEL,
    system:    'Use the provided tool when asked about stock. Do not guess.',
    messages:  [{ role: 'user', content: 'How many bags of Minuto Aristo do we have in stock right now?' }],
    tools,
    maxTokens: 300,
  })
  const toolUse = r.content.find(b => b.type === 'tool_use') as { name?: string; input?: any } | undefined
  if (!toolUse) return `no tool_use block; stop_reason=${r.stop_reason}, text="${r.text.slice(0, 100)}"`
  if (r.stop_reason !== 'tool_use') return `stop_reason=${r.stop_reason}, expected tool_use`
  if (toolUse.name !== 'get_stock_level') return `called "${toolUse.name}"`
  console.log(`        → ${toolUse.name}(${JSON.stringify(toolUse.input).slice(0, 60)})`)
  return null
})

// 5. THE TIGHT-BUDGET CHECK. Gemini 2.5+ spends "thinking" tokens out of
// maxOutputTokens BEFORE any visible text, so a caller with a small cap gets a
// truncated or empty answer with finishReason STOP and no error at all. Checks
// 1-4 all use generous caps and sail past it; scout-tick uses 500 and returned
// out=8 tokens in production. This mirrors a real worker call — small cap,
// structured output — so the trap cannot come back unnoticed.
await check('tight maxTokens still returns usable output (thinking off)', async () => {
  const r = await callGemini({
    model:     MODEL,
    system:    'You extract structured data. Be terse.',
    messages:  [{ role: 'user', content: 'Name one Ethiopian coffee region and a three-word flavour note. Think about which is most distinctive.' }],
    maxTokens: 500,
    temperature: 0.3,
    responseSchema: {
      type: 'object',
      properties: {
        region:       { type: 'string' },
        note:         { type: 'string' },
        confidence:   { type: 'number', description: '0 to 1' },
      },
      required: ['region', 'note', 'confidence'],
    },
  })
  if (r.outputTokens < 10) {
    return `only ${r.outputTokens} output tokens — thinking is eating the budget. ` +
           'generationConfig.thinkingConfig.thinkingBudget must be 0 for tight-cap calls.'
  }
  let parsed: any
  try { parsed = JSON.parse(r.text) } catch {
    return `unparseable at maxTokens=500 (out=${r.outputTokens}): ${r.text.slice(0, 120)}`
  }
  if (!parsed?.region || typeof parsed.confidence !== 'number') {
    return `schema not honoured: ${JSON.stringify(parsed).slice(0, 120)}`
  }
  console.log(`        → ${parsed.region} (${parsed.note}) conf=${parsed.confidence}  [out=${r.outputTokens} tokens]`)
  return null
})

console.log(`\n${failed === 0 ? 'ALL PASSED' : 'FAILURES PRESENT'} — ${passed} passed, ${failed} failed\n`)
if (failed > 0) {
  console.log('Do not flip any MODEL_* slot to Gemini until these pass.\n')
}
Deno.exit(failed === 0 ? 0 : 1)
