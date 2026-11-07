// The art director loop (docs/image-pipeline/art-director-design.md), kept
// out of index.ts so it can be driven end-to-end without claiming a task:
// art director (Opus) → one render (visual-test) → critic (Gemini) → one
// positive revision on FAIL if the run budget allows.
import { callClaude } from '../seo-agent/claude.ts'
import {
  AD_CRITIC_MODEL, AD_CRITIC_SYSTEM, AD_MODEL, AD_SYSTEM, adRevisionMessage, criticQuestions, criticUserMessage,
  parseArtDirection, parseCritic, type ArtDirection, type CriticVerdict,
} from '../_shared/art_director.ts'
import type { shotBudget } from './shotBudget.ts'

type Budget = ReturnType<typeof shotBudget>
type Turn = { role: 'user' | 'assistant'; content: string }

async function askArtDirector(messages: Turn[], allowed: ReadonlySet<string>, budget: Budget): Promise<{ ad: ArtDirection; raw: string; warnings: string[] }> {
  const call = (msgs: typeof messages) => callClaude({
    sourceFn: 'seo-worker-visual', model: AD_MODEL, system: AD_SYSTEM, messages: msgs,
    maxTokens: 16000, effort: 'high', timeoutMs: Math.min(90_000, budget.remainingMs()),
  })
  let res = await call(messages)
  let parsed = parseArtDirection(res.text, allowed)
  if (!parsed.ok) {
    // One fix round: hand the errors back in the same conversation.
    res = await call([...messages, { role: 'assistant', content: res.text }, { role: 'user', content: `Fix these problems and reply with the full JSON again:\n- ${parsed.errors.join('\n- ')}` }])
    parsed = parseArtDirection(res.text, allowed)
    if (!parsed.ok) throw new Error(`art director: ${parsed.errors.join('; ')}`)
  }
  return { ad: parsed.value, raw: res.text, warnings: parsed.warnings }
}

const CRITIC_SCHEMA = {
  type: 'object',
  properties: {
    description: { type: 'string' },
    answers: { type: 'array', items: { type: 'object', properties: { n: { type: 'integer' }, answer: { type: 'string', enum: ['yes', 'no'] }, why: { type: 'string' } }, required: ['n', 'answer', 'why'] } },
    correction: { type: 'string' },
  },
  required: ['description', 'answers', 'correction'],
}

async function criticCheck(imageUrl: string, ad: ArtDirection, budget: Budget): Promise<CriticVerdict> {
  const questions = criticQuestions(ad)
  const ask = () => callClaude({
    sourceFn: 'seo-worker-visual', model: AD_CRITIC_MODEL, system: AD_CRITIC_SYSTEM,
    messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'url', url: imageUrl } }, { type: 'text', text: criticUserMessage(questions) }] }],
    maxTokens: 4000, responseSchema: CRITIC_SCHEMA, timeoutMs: Math.min(60_000, budget.remainingMs()),
  })
  let res: Awaited<ReturnType<typeof callClaude>>
  try { res = await ask() } catch { res = await ask() }
  return parseCritic(res.text, questions)
}

export interface ArtDirectorRun {
  ad: ArtDirection | null
  imageUrl: string | null
  renderRaw: Record<string, unknown>
  verdict: CriticVerdict | null
  qaAttempts: Array<Record<string, unknown>>
}

export async function runArtDirector(opts: {
  conversation: Turn[]
  aspect: string
  allowed: ReadonlySet<string>
  budget: Budget
  render: (body: Record<string, unknown>, timeoutMs: number) => Promise<{ ok: boolean; status: number; json: Record<string, unknown> }>
  log?: (m: string) => void
}): Promise<ArtDirectorRun> {
  const { conversation, aspect, allowed, budget } = opts
  const log = opts.log ?? (() => {})
  const qaAttempts: Array<Record<string, unknown>> = []
  let ad: ArtDirection | null = null
  let imageUrl: string | null = null
  let renderRaw: Record<string, unknown> = {}
  let verdict: CriticVerdict | null = null
  let lastAttemptMs = 0
  for (let a = 1; a <= 2; a++) {
    if (a > 1 && !budget.fits(lastAttemptMs)) {
      log(`art-director revision skipped: last attempt took ${lastAttemptMs}ms, ${budget.remainingMs()}ms left`)
      break
    }
    const attemptStart = Date.now()
    try {
      const out = await askArtDirector(conversation, allowed, budget)
      ad = out.ad
      conversation.push({ role: 'assistant', content: out.raw })
      if (out.warnings.length) log(`art director warnings: ${out.warnings.join('; ')}`)
    } catch (e: any) {
      qaAttempts.push({ attempt: a, art_director_error: String(e?.message ?? e) })
      break
    }
    let json: Record<string, unknown> = {}
    try {
      const res = await opts.render({ aspect, art_direction: { prompt: ad.prompt, references: ad.references } }, budget.hopMs())
      json = res.json
      if (!res.ok || typeof json.url !== 'string') throw new Error(String(json.error ?? `HTTP ${res.status}`))
    } catch (e: any) {
      qaAttempts.push({ attempt: a, art_direction: ad, render_error: `visual-test: ${e?.message ?? e}` })
      lastAttemptMs = Date.now() - attemptStart
      continue
    }
    imageUrl = json.url as string
    renderRaw = json
    try {
      verdict = await criticCheck(imageUrl, ad, budget)
    } catch (e: any) {
      verdict = { passes: false, description: '', failed: [{ q: 'QA could not run', why: String(e?.message ?? e) }], correction: '' }
    }
    qaAttempts.push({
      attempt: a, image_url: imageUrl, art_direction: ad, prompt_doc: json.prompt_doc,
      critique: { passes: verdict.passes, description: verdict.description, issues: verdict.failed.map(f => `${f.q} → no: ${f.why}`), correction: verdict.correction },
    })
    lastAttemptMs = Date.now() - attemptStart
    log(`art-director attempt ${a} ${verdict.passes ? 'PASSED' : `FAILED ${JSON.stringify(verdict.failed.map(f => f.q.slice(0, 60)))}`} in ${lastAttemptMs}ms`)
    if (verdict.passes) break
    conversation.push({ role: 'user', content: adRevisionMessage(ad, verdict.failed, verdict.correction) })
  }
  return { ad, imageUrl, renderRaw, verdict, qaAttempts }
}
