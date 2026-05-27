// Minuto Organic Marketing — AI shopping-agent visibility probe.
//
// Weekly cron-driven. For each active row in ai_visibility_queries,
// asks each enabled LLM provider the prompt, parses the response for:
//   • whether Minuto is mentioned at all
//   • how many times, and where (position in the response)
//   • which known competitors are co-mentioned
// Writes one row per (query × provider × run) into ai_visibility_probes.
//
// Orchestrator's strategist reads aggregated stats — mention rate per
// query over the last 30 days — to know whether AI-search visibility is
// trending up/down. Strategist then proposes dynamic_experiment tasks
// (e.g. 'add llms.txt', 'publish authoritative comparison piece') to
// improve visibility, scored against future probe runs via the
// experiment loop.
//
// Provider lineup (v1):
//   ✓ claude-sonnet-4-6 (Anthropic) — ANTHROPIC_API_KEY already in secrets
//   ⏳ perplexity-sonar — needs PERPLEXITY_API_KEY (admin to add)
//   ⏳ gpt-4o          — needs OPENAI_API_KEY (admin to add)
//   ⏳ gemini-2.5-flash — needs GOOGLE_AI_API_KEY (admin to add)
//
// Skipped-provider behavior: silently no-op per query, log once. Don't
// fail the whole run because one provider is unconfigured.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL      = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE      = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? ''
const PERPLEXITY_API_KEY = Deno.env.get('PERPLEXITY_API_KEY') ?? ''
const OPENAI_API_KEY    = Deno.env.get('OPENAI_API_KEY') ?? ''

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}

// Known Israeli specialty coffee competitors. From the brand-voice memory
// note 'no disparagement' — plus a few common roasters. Static for v1;
// future iteration could mine this list dynamically from market_research.
// Known competitors. NOTE: avoid generic English words like 'Roasters'
// that appear in phrases like 'specialty coffee roasters' — substring
// match will false-positive every response. Stick to distinctive proper
// nouns. Hebrew 'רוסטרס' is fine (no false-positive risk).
const KNOWN_COMPETITORS = [
  'Aroma', 'ארומה',
  'Nahat', 'נחת',
  'Jera', "ג'רה",
  'Agro', 'אגרו',
  'Origem', 'אוריג\'ם',
  'Cofix', 'קפיקס',
  'רוסטרס',                          // Hebrew Roasters — proper noun in IL coffee context
  'Spectro',
  'Coffee Klatch',
  // English-international names sometimes name-dropped by LLMs in IL context
  'Stumptown', 'Blue Bottle', 'Counter Culture',
]

// Max response chars to store. ~8KB is more than enough — most shopping
// queries get 500-2000 word answers.
const MAX_RESPONSE_CHARS = 8000

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST')    return jsonResponse({ error: 'POST only' }, 405)

  // Body params (all optional for cron use):
  //   { query_ids?: string[], providers?: string[] }
  // Defaults: all active queries, all configured providers.
  let body: { query_ids?: string[]; providers?: string[] } = {}
  try { body = await req.json() } catch { /* empty body ok */ }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE)

  // 1. Load active queries.
  let qBuilder = supabase.from('ai_visibility_queries').select('*').eq('active', true)
  if (body.query_ids && body.query_ids.length > 0) qBuilder = qBuilder.in('id', body.query_ids)
  const { data: queries, error: qErr } = await qBuilder
  if (qErr) return jsonResponse({ error: `query load failed: ${qErr.message}` }, 500)
  if (!queries || queries.length === 0) return jsonResponse({ ok: true, note: 'no active queries' })

  // 2. Determine which providers are configured. Filter by body.providers if set.
  const allProviders = [
    { name: 'claude-sonnet-4-6', enabled: !!ANTHROPIC_API_KEY, callFn: callClaude },
    { name: 'perplexity-sonar',  enabled: !!PERPLEXITY_API_KEY, callFn: callPerplexity },
    { name: 'gpt-4o',            enabled: !!OPENAI_API_KEY, callFn: callOpenAI },
  ]
  const enabledProviders = allProviders.filter(p => p.enabled && (!body.providers || body.providers.includes(p.name)))
  if (enabledProviders.length === 0) {
    return jsonResponse({
      ok:    true,
      note:  'no configured providers. Set ANTHROPIC_API_KEY (already present), PERPLEXITY_API_KEY, or OPENAI_API_KEY via `supabase secrets set`.',
      providers_status: allProviders.map(p => ({ name: p.name, enabled: p.enabled })),
    })
  }
  console.log(`[ai-visibility-probe] ${queries.length} queries × ${enabledProviders.length} providers = ${queries.length * enabledProviders.length} probes`)

  // 3. Run all (query × provider) combinations. Sequential for simplicity
  // and to avoid rate limits — total runtime ≈ 13 queries × N providers ×
  // ~5s each. Single-provider run ≈ 65s. Within the 240s edge cap.
  const stats = {
    runs:               0,
    minuto_mentioned:   0,
    errors:             0,
    by_provider:        {} as Record<string, { runs: number; mentioned: number; errors: number }>,
  }

  for (const query of queries as Array<{ id: string; query: string }>) {
    for (const provider of enabledProviders) {
      stats.runs++
      const provStats = (stats.by_provider[provider.name] ??= { runs: 0, mentioned: 0, errors: 0 })
      provStats.runs++

      try {
        const result   = await provider.callFn(query.query)
        const response = (result.text ?? '').slice(0, MAX_RESPONSE_CHARS)
        const parse    = parseResponse(response)

        await supabase.from('ai_visibility_probes').insert({
          query_id:                query.id,
          query_text:              query.query,
          llm_provider:            provider.name,
          response_text:           response,
          minuto_mentioned:        parse.mentioned,
          minuto_mention_count:    parse.count,
          minuto_mention_context:  parse.context,
          competitors_mentioned:   parse.competitors,
          minuto_position_chars:   parse.position,
          response_tokens:         result.tokens ?? null,
          cost_usd:                result.cost  ?? null,
          error:                   null,
        })

        if (parse.mentioned) { stats.minuto_mentioned++; provStats.mentioned++ }
      } catch (e: any) {
        stats.errors++; provStats.errors++
        await supabase.from('ai_visibility_probes').insert({
          query_id:      query.id,
          query_text:    query.query,
          llm_provider:  provider.name,
          response_text: '',
          error:         (e?.message ?? String(e)).slice(0, 500),
        })
      }
    }
  }

  return jsonResponse({ ok: true, stats })
})

// ─────────────────────────────────────────────────────────────────────────
// Response parser. Counts Minuto mentions, captures ±200 char context
// around the first one, extracts known competitor names. Case-insensitive
// for English; Hebrew is naturally case-insensitive.
// ─────────────────────────────────────────────────────────────────────────
function parseResponse(response: string): {
  mentioned: boolean
  count:     number
  context:   string | null
  position:  number | null
  competitors: string[]
} {
  if (!response) return { mentioned: false, count: 0, context: null, position: null, competitors: [] }

  // Minuto mention detection — match 'minuto' (case-insensitive) or 'מינוטו'.
  // 'Minuto' is also Italian for 'minute' so brand-context disambiguation
  // matters; but in shopping-LLM responses to coffee prompts, false
  // positives are vanishingly rare.
  const minutoRe   = /(minuto|מינוטו)/gi
  const matches    = [...response.matchAll(minutoRe)]
  const mentioned  = matches.length > 0
  const count      = matches.length
  const firstPos   = matches[0]?.index ?? null
  const context    = firstPos != null
    ? response.slice(Math.max(0, firstPos - 200), Math.min(response.length, firstPos + 200))
    : null

  // Competitor detection — substring match against KNOWN_COMPETITORS list.
  const lowered = response.toLowerCase()
  const competitors: string[] = []
  for (const comp of KNOWN_COMPETITORS) {
    const test = comp.toLowerCase()
    if (lowered.includes(test) && !competitors.includes(comp)) competitors.push(comp)
  }

  return { mentioned, count, context, position: firstPos, competitors }
}

// ─────────────────────────────────────────────────────────────────────────
// Provider implementations. Each returns { text, tokens?, cost? }.
// All are best-effort — errors propagate up and get logged as a probe row.
// ─────────────────────────────────────────────────────────────────────────
interface ProbeResult { text: string; tokens?: number; cost?: number }

async function callClaude(prompt: string): Promise<ProbeResult> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: {
      'x-api-key':         ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type':      'application/json',
    },
    body: JSON.stringify({
      // Claude Sonnet 4.6 — same model the rest of the agent uses.
      model:      'claude-sonnet-4-6',
      max_tokens: 1500,
      // System prompt mimics how a customer-facing AI would behave —
      // recommendation-style, no Minuto-friendly priming.
      system:    'You are a helpful shopping assistant. When the user asks for product or brand recommendations, give concrete names and short reasons. Be specific.',
      messages:  [{ role: 'user', content: prompt }],
    }),
  })
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text().catch(() => '')}`)
  const json = await res.json()
  const text = (json.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n')
  const tokens = (json.usage?.input_tokens ?? 0) + (json.usage?.output_tokens ?? 0)
  // Rough Sonnet 4.6 pricing: $3/$15 per million input/output.
  const cost = ((json.usage?.input_tokens ?? 0) * 3 + (json.usage?.output_tokens ?? 0) * 15) / 1_000_000
  return { text, tokens, cost }
}

async function callPerplexity(prompt: string): Promise<ProbeResult> {
  const res = await fetch('https://api.perplexity.ai/chat/completions', {
    method:  'POST',
    headers: {
      Authorization:  `Bearer ${PERPLEXITY_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model:    'sonar',  // Perplexity's search-grounded conversational model
      messages: [{ role: 'user', content: prompt }],
    }),
  })
  if (!res.ok) throw new Error(`Perplexity ${res.status}: ${await res.text().catch(() => '')}`)
  const json = await res.json()
  const text = json.choices?.[0]?.message?.content ?? ''
  const tokens = json.usage?.total_tokens
  return { text, tokens }
}

async function callOpenAI(prompt: string): Promise<ProbeResult> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method:  'POST',
    headers: {
      Authorization:  `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model:    'gpt-4o',
      messages: [
        { role: 'system', content: 'You are a helpful shopping assistant. When the user asks for product or brand recommendations, give concrete names and short reasons. Be specific.' },
        { role: 'user',   content: prompt },
      ],
    }),
  })
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text().catch(() => '')}`)
  const json = await res.json()
  const text = json.choices?.[0]?.message?.content ?? ''
  const tokens = json.usage?.total_tokens
  return { text, tokens }
}
