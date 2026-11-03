// Rules for an innovation pitch the strategist brain submits (emit_innovation_pitch).
// Pure, so they are unit-tested; the DB side (cap per run, unique dedupe_key,
// the CHECK in 20261103a) enforces the same rules again.
// Plan: docs/plans/2026-11-02-strategist-closed-loop.md, B3.
//
// Grounding: every source URL must be one the week's research actually
// returned (the scan's web_sources or a recent industry_articles link). A
// pitch citing a URL nobody fetched is refused: that is how invented sources
// would get in.

export const MAX_PITCHES_PER_RUN = 3
export const RESEARCH_MAX_AGE_DAYS = 7
export const PITCH_METRICS = ['bean_revenue', 'orders', 'repeat_purchase_rate', 'roas', 'cpa', 'email_ctr', 'organic_sessions'] as const
export const PITCH_EFFORTS = ['small', 'medium', 'large'] as const

export interface PitchInput {
  title:                string   // the tool / method, e.g. "Meta Advantage+ catalog ads"
  why_it_matters:       string
  hypothesis:           string   // which metric moves, from what baseline, how to test cheaply
  check_metric:         string
  effort:               string
  cost_estimate?:       string
  implementation_steps: string[]
  sources:              Array<{ url: string; title?: string; published?: string }>
}

/** Stable key so the same idea is not pitched twice (case, spacing, punctuation, Hebrew niqqud ignored). */
export function pitchDedupeKey(title: string): string {
  const base = String(title ?? '')
    .normalize('NFKD')
    .replace(/[֑-ׇ]/g, '')            // Hebrew niqqud / cantillation
    .replace(/[̀-ͯ]/g, '')            // Latin diacritics
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, '-')
  return base ? `pitch:${base.slice(0, 120)}` : ''
}

/** Normalise a URL for comparison: https/http only, no hash, no trailing slash. */
export function normaliseUrl(u: unknown): string | null {
  try {
    const x = new URL(String(u))
    if (x.protocol !== 'https:' && x.protocol !== 'http:') return null
    x.hash = ''
    return x.href.replace(/\/$/, '')
  } catch { return null }
}

const str = (v: unknown, max: number) => typeof v === 'string' && v.trim().length > 0 && v.length <= max

/** Every problem with a pitch; [] when it may be inserted. */
export function pitchProblems(input: unknown, allowedSources: ReadonlySet<string>): string[] {
  const p: string[] = []
  if (!input || typeof input !== 'object') return ['pitch must be an object']
  const x = input as Record<string, unknown>
  if (!str(x.title, 140)) p.push('title: 1-140 characters naming the tool or method')
  if (!str(x.why_it_matters, 1500)) p.push('why_it_matters: required, <= 1500 characters')
  if (!str(x.hypothesis, 1500)) p.push('hypothesis: required: which metric moves, from what baseline, and the cheapest test (no invented ROI numbers)')
  if (!(PITCH_METRICS as readonly string[]).includes(String(x.check_metric))) p.push(`check_metric: one of ${PITCH_METRICS.join(', ')}`)
  if (!(PITCH_EFFORTS as readonly string[]).includes(String(x.effort))) p.push(`effort: one of ${PITCH_EFFORTS.join(', ')}`)
  if (x.cost_estimate != null && !str(x.cost_estimate, 200)) p.push('cost_estimate: <= 200 characters when given')
  const steps = x.implementation_steps
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > 12 || steps.some(s => !str(s, 400))) {
    p.push('implementation_steps: 1-12 non-empty steps, each <= 400 characters')
  }
  const sources = x.sources
  if (!Array.isArray(sources) || sources.length < 1 || sources.length > 8) {
    p.push('sources: 1-8 sources from this week\'s research')
  } else {
    sources.forEach((s, i) => {
      const url = normaliseUrl((s as Record<string, unknown>)?.url)
      if (!url) p.push(`sources[${i}]: not an http(s) URL`)
      else if (!allowedSources.has(url)) p.push(`sources[${i}]: ${url} is not in this week's research results; cite only URLs the research returned`)
    })
  }
  if (!pitchDedupeKey(String(x.title ?? ''))) p.push('title produces an empty dedupe key')
  return p
}

/** Research older than RESEARCH_MAX_AGE_DAYS (or none) means no pitches this week. */
export function researchIsFresh(completedAt: string | null | undefined, now = new Date()): boolean {
  if (!completedAt) return false
  const t = new Date(completedAt).getTime()
  if (!Number.isFinite(t)) return false
  const age = now.getTime() - t
  return age >= 0 && age <= RESEARCH_MAX_AGE_DAYS * 86_400_000
}
