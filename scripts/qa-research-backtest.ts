// qa-research-backtest.ts — compare the deep-research stack on Claude vs Gemini
// against REAL past questions, before changing anything in production.
//
// READ-ONLY. SELECTs completed deep_research tasks, calls both vendors' APIs,
// writes nothing, deploys nothing, touches no live function.
//
// Run (Deno):
//   SUPABASE_SERVICE_ROLE_KEY=eyJ... ANTHROPIC_API_KEY=sk-ant-... GEMINI_API_KEY=... \
//     deno run --allow-net --allow-env scripts/qa-research-backtest.ts [limit]
//
// ── WHAT THIS DOES AND DOES NOT MEASURE ────────────────────────────────────
//
// 1. IT COMPARES STACKS, NOT JUST MODELS. Production research runs on
//    Anthropic's server-side `web_search`; the Gemini arm uses Google Search
//    grounding. Those are different search engines with different recall. A win
//    here may be the search stack, not the reasoning — so the report separates
//    "sources found" from "quality of synthesis" rather than blending them.
//
// 2. JUDGE BIAS IS REAL AND IS NOT AVERAGED AWAY. Each vendor scores its own
//    output, so BOTH judge every pair, blind, with positions swapped. Agreement
//    between two rival judges is the only signal treated as strong. Where they
//    disagree the report says so instead of picking a winner.
//
// 3. COST IS REPORTED AS TOKENS, NOT DOLLARS. Token counts are facts; a price
//    table here would rot silently. Apply current pricing yourself.
//
// A run costs real money on both vendors. Start with a small limit.

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? 'https://ytydgldyeygpzmlxvpvb.supabase.co'
const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const ANTHROPIC_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? ''
const GEMINI_KEY    = Deno.env.get('GEMINI_API_KEY') ?? ''

// Defaults mirror what production actually runs. GEMINI_MODEL defaults to the
// only Gemini text model already proven in this repo (vertex-imagen-edit's
// visual director); a Pro-tier model is the fairer match for research synthesis
// if you have access — set it explicitly rather than assuming this default.
const CLAUDE_MODEL = Deno.env.get('CLAUDE_MODEL') ?? 'claude-sonnet-4-6'
const GEMINI_MODEL = Deno.env.get('GEMINI_MODEL') ?? 'gemini-3.1-flash'
const LIMIT = Number(Deno.args[0] ?? '6')

if (!SERVICE_KEY || !ANTHROPIC_KEY || !GEMINI_KEY) {
  console.error('Need SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY and GEMINI_API_KEY in env.')
  Deno.exit(1)
}

// Kept in sync with seo-worker-research/index.ts buildSystemPrompt().
const SCOPE_GUIDANCE: Record<string, string> = {
  geo_llmo:             'You are researching GEO/LLMO — how LLMs perceive, cite and recommend brands.',
  competitor_deep_dive: 'You are profiling a specific competitor.',
  content_topic:        'You are evaluating whether a content topic is worth Minuto pursuing.',
  audience_segment:     'You are profiling a specific customer audience.',
  channel_discovery:    'You are hunting for growth channels Minuto is NOT currently using. Minuto today does WP blog SEO + Instagram only.',
  other:                'Open-ended research.',
}
const OUTPUT_GUIDANCE: Record<string, string> = {
  recommendations: 'Output a prioritized list of 3-7 specific recommendations, each with one sentence of what to do, one of why (evidence), and estimated impact.',
  analysis:        'Output a 400-800 word analysis with explicit citations (URLs). Sections: KEY FINDINGS, EVIDENCE, IMPLICATIONS FOR MINUTO.',
  action_plan:     'Output 3-5 concrete tasks to queue next cycle, each with a one-line rationale and expected metric impact.',
}
const sys = (scope: string, out: string) =>
  `You are Minuto's deep-research module. Minuto is a specialty-coffee roastery in Israel.\n\n` +
  `${SCOPE_GUIDANCE[scope] ?? SCOPE_GUIDANCE.other}\n\nOUTPUT — ${out.toUpperCase()}:\n${OUTPUT_GUIDANCE[out] ?? OUTPUT_GUIDANCE.analysis}\n\n` +
  `CITE YOUR SOURCES — every claim references a URL. Unsourced claims are noise. ` +
  `If a question is genuinely unanswerable with available sources, SAY SO rather than fabricating.`

const countUrls = (t: string) => new Set(t.match(/https?:\/\/[^\s)\]]+/g) ?? []).size

async function runClaude(question: string, scope: string, out: string) {
  const t0 = Date.now()
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: CLAUDE_MODEL, max_tokens: 4000, system: sys(scope, out),
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 4 }],
      messages: [{ role: 'user', content: question }],
    }),
  })
  const j = await res.json()
  const text = (j.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('')
  return { text, ms: Date.now() - t0, inTok: j.usage?.input_tokens ?? 0, outTok: j.usage?.output_tokens ?? 0, err: j.error?.message ?? null }
}

async function runGemini(question: string, scope: string, out: string) {
  const t0 = Date.now()
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`,
    { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: sys(scope, out) }] },
        contents: [{ role: 'user', parts: [{ text: question }] }],
        // Google Search grounding — the counterpart to Anthropic's web_search.
        tools: [{ google_search: {} }],
        generationConfig: { maxOutputTokens: 4000 },
      }) })
  const j = await res.json()
  const text = (j.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? '').join('')
  return { text, ms: Date.now() - t0, inTok: j.usageMetadata?.promptTokenCount ?? 0, outTok: j.usageMetadata?.candidatesTokenCount ?? 0, err: j.error?.message ?? null }
}

const JUDGE = `You are grading two research answers to the same question about a small Israeli specialty-coffee roastery.
Judge ONLY on: (1) are claims backed by real, specific sources; (2) is the advice concrete and actionable for a small
boutique roaster, not generic marketing filler; (3) does it admit uncertainty instead of inventing facts.
Length is not quality. Confident vagueness is worse than a short sourced answer.
Reply strict JSON only: {"winner":"A"|"B"|"tie","why":"one sentence"}`

async function judgeWithClaude(q: string, a: string, b: string) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 300, system: JUDGE,
      messages: [{ role: 'user', content: `QUESTION:\n${q}\n\n--- ANSWER A ---\n${a}\n\n--- ANSWER B ---\n${b}` }] }),
  })
  const j = await res.json()
  const t = (j.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('')
  try { return JSON.parse(t.match(/\{[\s\S]*\}/)?.[0] ?? '{}').winner ?? '?' } catch { return '?' }
}
async function judgeWithGemini(q: string, a: string, b: string) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`,
    { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: JUDGE }] },
        contents: [{ role: 'user', parts: [{ text: `QUESTION:\n${q}\n\n--- ANSWER A ---\n${a}\n\n--- ANSWER B ---\n${b}` }] }],
        generationConfig: { maxOutputTokens: 300, responseMimeType: 'application/json' } }) })
  const j = await res.json()
  const t = (j.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? '').join('')
  try { return JSON.parse(t.match(/\{[\s\S]*\}/)?.[0] ?? '{}').winner ?? '?' } catch { return '?' }
}

const rows = await (await fetch(
  `${SUPABASE_URL}/rest/v1/seo_tasks?task_type=eq.deep_research&status=eq.completed&select=id,brief_data&order=created_at.desc&limit=${LIMIT}`,
  { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } })).json()

console.log(`\nDeep-research backtest — ${CLAUDE_MODEL} (web_search) vs ${GEMINI_MODEL} (google_search)`)
console.log(`${rows.length} real past questions. Read-only.\n`)

const tally = { claude: 0, gemini: 0, tie: 0, judgesDisagreed: 0 }
for (const [i, r] of rows.entries()) {
  const b = r.brief_data ?? {}
  const question = b.question ?? b.topic ?? b.objective ?? JSON.stringify(b).slice(0, 400)
  const scope = b.scope ?? 'other', out = b.expected_output ?? 'analysis'

  const [c, g] = await Promise.all([runClaude(question, scope, out), runGemini(question, scope, out)])
  if (c.err || g.err) { console.log(`${i + 1}. SKIPPED — claude:${c.err ?? 'ok'} gemini:${g.err ?? 'ok'}`); continue }

  // Blind + position-swapped: Claude sees claude-as-A, Gemini sees claude-as-B.
  // A judge that always picks its own slot reveals itself as positionally biased.
  const [jc, jg] = await Promise.all([
    judgeWithClaude(question, c.text, g.text),
    judgeWithGemini(question, g.text, c.text),
  ])
  const claudeVote = jc === 'A' ? 'claude' : jc === 'B' ? 'gemini' : 'tie'
  const geminiVote = jg === 'A' ? 'gemini' : jg === 'B' ? 'claude' : 'tie'
  const agreed = claudeVote === geminiVote
  if (!agreed) tally.judgesDisagreed++
  else tally[claudeVote as 'claude' | 'gemini' | 'tie']++

  console.log(
    `${i + 1}. [${scope}/${out}] ${agreed ? `both judges → ${claudeVote.toUpperCase()}` : `DISAGREE (claude→${claudeVote}, gemini→${geminiVote})`}\n` +
    `   claude: ${c.text.length}ch ${countUrls(c.text)} urls ${c.inTok}/${c.outTok} tok ${(c.ms / 1000).toFixed(1)}s\n` +
    `   gemini: ${g.text.length}ch ${countUrls(g.text)} urls ${g.inTok}/${g.outTok} tok ${(g.ms / 1000).toFixed(1)}s`)
}

console.log(`\n── AGREED VERDICTS ──`)
console.log(`  claude ${tally.claude} · gemini ${tally.gemini} · tie ${tally.tie}`)
console.log(`  judges disagreed on ${tally.judgesDisagreed} — those are NOT a result, they are noise.`)
console.log(`\nRemember: this compares two SEARCH STACKS as much as two models, and`)
console.log(`a handful of questions is a signal, not a decision.\n`)
