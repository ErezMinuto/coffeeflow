// The art director loop (docs/image-pipeline/art-director-design.md), kept
// out of index.ts so it can be driven end-to-end without claiming a task:
// art director (Opus) → brief review (Gemini, text only) → one render
// (visual-test) → critic (Gemini) → one positive revision on FAIL if the run
// budget allows.
import { callClaude } from '../seo-agent/claude.ts'
import {
  AD_CRITIC_MODEL, AD_CRITIC_SYSTEM, AD_MODEL, AD_SYSTEM, BRIEF_REVIEW_SYSTEM, adBriefFixMessage, adRevisionMessage,
  briefReviewMessage, criticQuestions, criticUserMessage, parseArtDirection, parseBriefReview, parseCritic, rankCandidates,
  type ArtDirection, type BriefProblem, type CriticVerdict,
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

const BRIEF_REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    problems: { type: 'array', items: { type: 'object', properties: { quote: { type: 'string' }, why: { type: 'string' }, fix: { type: 'string' } }, required: ['quote', 'why', 'fix'] } },
  },
  required: ['problems'],
}

// The review runs only when a render and its check still fit afterwards: one
// attempt (art director + render + critic) has taken ~70 s in prod, the review
// ~20 s, a fix round ~30 s.
export const BRIEF_REVIEW_MIN_REMAINING_MS = 150_000

// Candidates rendered in parallel per round (owner + Gemini, 2026-11-13).
export const CANDIDATES = 3

async function briefReview(ad: ArtDirection, budget: Budget): Promise<BriefProblem[]> {
  const res = await callClaude({
    sourceFn: 'seo-worker-visual', model: AD_CRITIC_MODEL, system: BRIEF_REVIEW_SYSTEM,
    messages: [{ role: 'user', content: briefReviewMessage(ad) }],
    maxTokens: 16000, responseSchema: BRIEF_REVIEW_SCHEMA, timeoutMs: Math.min(45_000, budget.remainingMs()),
  })
  return parseBriefReview(res.text)
}

async function criticCheck(imageUrl: string, ad: ArtDirection, budget: Budget): Promise<CriticVerdict> {
  const { blocking, notes } = criticQuestions(ad)
  const questions = [...blocking, ...notes]
  const ask = () => callClaude({
    sourceFn: 'seo-worker-visual', model: AD_CRITIC_MODEL, system: AD_CRITIC_SYSTEM,
    messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'url', url: imageUrl } }, { type: 'text', text: criticUserMessage(questions) }] }],
    maxTokens: 16000, responseSchema: CRITIC_SCHEMA, timeoutMs: Math.min(90_000, budget.remainingMs()),
  })
  let res: Awaited<ReturnType<typeof callClaude>>
  try { res = await ask() } catch { res = await ask() }
  return parseCritic(res.text, questions, blocking.length)
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
    // Brief review: catch what a real barista or roaster would never do before
    // a render is spent on it. One fix round; the fixed brief is not re-reviewed.
    let review: Record<string, unknown> | undefined
    if (budget.remainingMs() > BRIEF_REVIEW_MIN_REMAINING_MS) {
      try {
        const problems = await briefReview(ad, budget)
        review = { problems, revised: false }
        if (problems.length) {
          log(`brief review flagged ${problems.length}: ${JSON.stringify(problems.map(p => p.quote.slice(0, 60)))}`)
          conversation.push({ role: 'user', content: adBriefFixMessage(problems) })
          try {
            const fixed = await askArtDirector(conversation, allowed, budget)
            review = { problems, revised: true, before: { prompt: ad.prompt, references: ad.references } }
            ad = fixed.ad
            conversation.push({ role: 'assistant', content: fixed.raw })
          } catch (e: any) {
            // Keep the unfixed brief rather than lose the post; the flags stay on record.
            conversation.pop()
            review = { problems, revised: false, fix_error: String(e?.message ?? e) }
          }
        }
      } catch (e: any) {
        review = { error: String(e?.message ?? e) }
        log(`brief review skipped: ${review.error}`)
      }
    }
    // Owner + Gemini 2026-11-13: render CANDIDATES at once from the same
    // brief and keep the best; every candidate reaches the owner's review so
    // he can choose a different one.
    const brief = ad
    const renders = await Promise.all(Array.from({ length: CANDIDATES }, async () => {
      try {
        const res = await opts.render({ aspect, art_direction: { prompt: brief.prompt, references: brief.references } }, budget.hopMs())
        if (!res.ok || typeof res.json.url !== 'string') throw new Error(String(res.json.error ?? `HTTP ${res.status}`))
        return { url: res.json.url as string, json: res.json }
      } catch (e: any) {
        return { error: `visual-test: ${e?.message ?? e}` }
      }
    }))
    const rendered = renders.filter((r): r is { url: string; json: Record<string, unknown> } => 'url' in r)
    if (!rendered.length) {
      const renderError = (renders[0] as { error: string }).error
      qaAttempts.push({ attempt: qaAttempts.length + 1, round: a, art_direction: ad, brief_review: review, render_error: renderError })
      lastAttemptMs = Date.now() - attemptStart
      // The conversation must end with a user turn before the next call.
      conversation.push({ role: 'user', content: `The render failed: ${renderError}. Fix the cause (for example choose a different reference photo) and reply with the full JSON again.` })
      continue
    }
    const judged = await Promise.all(rendered.map(async r => {
      let v: CriticVerdict
      try { v = await criticCheck(r.url, brief, budget) } catch (e: any) {
        v = { passes: false, description: '', failed: [{ q: 'QA could not run', why: String(e?.message ?? e) }], notes: [], correction: '' }
      }
      return { ...r, v, passes: v.passes, notes: v.notes.length }
    }))
    for (const j of judged) {
      qaAttempts.push({
        attempt: qaAttempts.length + 1, round: a, image_url: j.url, art_direction: ad, brief_review: review, prompt_doc: j.json.prompt_doc,
        critique: { passes: j.v.passes, description: j.v.description, issues: j.v.failed.map(f => `${f.q} → no: ${f.why}`), notes: j.v.notes.map(f => `${f.q} → no: ${f.why}`), correction: j.v.correction },
      })
    }
    const best = rankCandidates(judged)[0]
    // Keep the best of everything rendered so far: a revision round only
    // replaces it if its own best is better.
    if (!verdict || rankCandidates([{ passes: verdict.passes, notes: verdict.notes.length, keep: false }, { passes: best.passes, notes: best.notes, keep: true }])[0].keep) {
      imageUrl = best.url
      renderRaw = best.json
      verdict = best.v
    }
    lastAttemptMs = Date.now() - attemptStart
    log(`art-director round ${a}: ${judged.filter(j => j.passes).length}/${judged.length} candidates passed in ${lastAttemptMs}ms`)
    if (verdict.passes) break
    conversation.push({ role: 'user', content: adRevisionMessage(ad, best.v.failed, best.v.correction) })
  }
  return { ad, imageUrl, renderRaw, verdict, qaAttempts }
}
