// Strategist brain: research + innovation-pitch tools.
// Plan: docs/plans/2026-11-02-strategist-closed-loop.md, B3.
//
//   get_research_findings   this week's innovation scan + recent industry articles
//   get_ops_profile         non-secret operating facts (ops_profile; never secrets)
//   get_seo_learnings       standing lessons Erez and the agents recorded
//   get_current_capabilities what CoffeeFlow already does (so it does not pitch it)
//   emit_innovation_pitch   submit ONE pitch for Erez (max 3 per run)
//
// A pitch is accepted only when the research is fresh, every source is a URL
// that research actually returned, and it is not a repeat of an earlier pitch
// (including declined ones). Approving a pitch builds nothing.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.116.0'
import { getRecentLearnings } from '../seo-agent/db.ts'
import {
  MAX_PITCHES_PER_RUN, normaliseUrl, pitchDedupeKey, pitchProblems, researchIsFresh, PITCH_EFFORTS, PITCH_METRICS,
  RESEARCH_MAX_AGE_DAYS, type PitchInput,
} from '../_shared/innovation_pitch.ts'

const ARTICLE_DAYS = 14

export interface ResearchFindings {
  fresh:            boolean
  completed_at:     string | null
  max_age_days:     number
  report:           string
  sources:          Array<{ title: string; url: string }>
  industry_articles: Array<{ title: string; url: string; insight: string | null; published_at: string | null; relevance: number | null }>
  note?:            string
}

export async function getResearchFindings(supabase: SupabaseClient): Promise<ResearchFindings> {
  const [scan, articles] = await Promise.all([
    supabase.from('seo_tasks')
      .select('completed_at, result_data')
      .eq('task_type', 'deep_research').eq('status', 'completed').eq('brief_data->>innovation_scan', 'true')
      .order('completed_at', { ascending: false, nullsFirst: false }).limit(1).maybeSingle(),
    supabase.from('industry_articles')
      .select('title, url, insight, published_at, relevance')
      .gte('fetched_at', new Date(Date.now() - ARTICLE_DAYS * 86_400_000).toISOString())
      .gte('relevance', 0.5)
      .order('relevance', { ascending: false }).limit(20),
  ])
  if (scan.error) throw new Error(`innovation scan read failed: ${scan.error.message}`)
  if (articles.error) throw new Error(`industry_articles read failed: ${articles.error.message}`)
  const rd = (scan.data?.result_data ?? {}) as Record<string, any>
  const completedAt = (scan.data?.completed_at as string | null) ?? null
  const sources = (Array.isArray(rd.web_sources) ? rd.web_sources : [])
    .filter((s: any) => s && typeof s.url === 'string')
    .map((s: any) => ({ title: String(s.title ?? s.url).slice(0, 200), url: s.url }))
  const fresh = researchIsFresh(completedAt)
  return {
    fresh,
    completed_at: completedAt,
    max_age_days: RESEARCH_MAX_AGE_DAYS,
    report: String(rd.final_text ?? '').slice(0, 12_000),
    sources,
    industry_articles: ((articles.data ?? []) as any[]).map(a => ({
      title: String(a.title ?? ''), url: String(a.url ?? ''), insight: a.insight ?? null, published_at: a.published_at ?? null, relevance: a.relevance ?? null,
    })),
    ...(fresh ? {} : { note: `No research completed in the last ${RESEARCH_MAX_AGE_DAYS} days: do not pitch this week (emit_innovation_pitch will refuse).` }),
  }
}

/** ops_profile minus anything that is not plain context. It holds no secrets
 *  by design (secrets live in Vault); the loop switches are left out too, they
 *  are Erez's controls, not planning input. */
export async function getOpsProfile(supabase: SupabaseClient): Promise<Array<{ key: string; value: unknown; description: string | null }>> {
  const { data, error } = await supabase.from('ops_profile').select('key, value, description').order('key')
  if (error) throw new Error(`ops_profile read failed: ${error.message}`)
  return ((data ?? []) as Array<{ key: string; value: unknown; description: string | null }>)
    .filter(r => r.key !== 'strategist_loop')
}

export async function getCurrentCapabilities(supabase: SupabaseClient): Promise<{ capabilities: unknown; note?: string }> {
  const { data, error } = await supabase.from('ops_profile').select('value').eq('key', 'current_capabilities').maybeSingle()
  if (error) throw new Error(`ops_profile read failed: ${error.message}`)
  if (!data) return { capabilities: [], note: 'No capability list recorded (ops_profile.current_capabilities). Treat anything you pitch as possibly already built and say so.' }
  return { capabilities: data.value }
}

export async function getSeoLearnings(supabase: SupabaseClient, input: { limit?: number }): Promise<unknown[]> {
  const limit = Math.min(Math.max(Math.trunc(Number(input?.limit ?? 30)) || 30, 1), 60)
  return await getRecentLearnings(supabase, { limit })
}

export async function handleEmitInnovationPitch(
  supabase: SupabaseClient,
  ctx: { runId: string },
  input: PitchInput,
): Promise<Record<string, unknown>> {
  const research = await getResearchFindings(supabase)
  if (!research.fresh) {
    return { error: `refused: no innovation research completed in the last ${RESEARCH_MAX_AGE_DAYS} days, so there is nothing current to ground a pitch in. Do not pitch this week.` }
  }
  const allowed = new Set<string>()
  for (const u of [...research.sources.map(s => s.url), ...research.industry_articles.map(a => a.url)]) {
    const n = normaliseUrl(u)
    if (n) allowed.add(n)
  }
  const problems = pitchProblems(input, allowed)
  if (problems.length) return { error: `pitch NOT saved: ${problems.join(' ; ')}. Fix and call again.` }

  // Cap per run, counted in the DB: the brain resumes across invocations.
  const { count, error: cErr } = await supabase.from('strategist_signals')
    .select('id', { count: 'exact', head: true }).eq('kind', 'innovation_pitch').eq('run_id', ctx.runId)
  if (cErr) return { error: `pitch NOT saved: could not count this run's pitches (${cErr.message})` }
  if ((count ?? 0) >= MAX_PITCHES_PER_RUN) return { error: `refused: ${MAX_PITCHES_PER_RUN} pitches already submitted this run. Keep only the strongest.` }

  const dedupeKey = pitchDedupeKey(input.title)
  const { data, error } = await supabase.from('strategist_signals').insert({
    kind:                 'innovation_pitch',
    title:                input.title.trim(),
    detail:               input.why_it_matters.trim(),
    leverage:             input.hypothesis.trim(),
    evidence:             { hypothesis: input.hypothesis.trim(), research_completed_at: research.completed_at },
    sources:              input.sources.map(s => ({ url: normaliseUrl(s.url), title: s.title ?? null, published: s.published ?? null })),
    implementation_steps: input.implementation_steps.map(s => s.trim()),
    effort:               input.effort,
    cost_estimate:        input.cost_estimate?.trim() || null,
    check_metric:         input.check_metric,
    dedupe_key:           dedupeKey,
    run_id:               ctx.runId,
    status:               'open',
  }).select('id').single()
  if (error) {
    if ((error as { code?: string }).code === '23505') return { error: 'refused: this idea was already pitched (it may have been declined). Do not pitch it again.' }
    return { error: `pitch NOT saved: ${error.message}` }
  }
  return { ok: true, signal_id: data.id, note: 'Saved for Erez to approve or decline. Approval builds nothing by itself.' }
}

export const RESEARCH_TOOL_DEFS = [
  {
    name: 'get_research_findings',
    description: `This week's innovation research (a sourced web report on platform changes, tools and methods) plus recent high-relevance industry articles. "fresh" is false when no research completed in the last ${RESEARCH_MAX_AGE_DAYS} days.`,
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_ops_profile',
    description: 'Non-secret operating facts about Minuto and CoffeeFlow (bag size, revenue source, which bot owns what).',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_seo_learnings',
    description: 'Standing lessons recorded by Erez and the agents (what worked, what was decided against).',
    input_schema: { type: 'object', properties: { limit: { type: 'number', description: '1-60, default 30' } } },
  },
  {
    name: 'get_current_capabilities',
    description: 'What CoffeeFlow already does. A pitch for something listed here is a duplicate.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'emit_innovation_pitch',
    description: `Submit ONE innovation pitch for Erez to approve or decline: a new tool, method or platform change from this week's research. At most ${MAX_PITCHES_PER_RUN} per run. Refused when the research is stale, a source is not a URL the research returned, or the idea was pitched before. Expected impact is a testable hypothesis on check_metric, never an invented ROI number.`,
    input_schema: {
      type: 'object',
      properties: {
        title:                { type: 'string', description: 'the tool or method, <= 140 chars' },
        why_it_matters:       { type: 'string', description: 'why it matters for Minuto specifically' },
        hypothesis:           { type: 'string', description: 'which metric should move, its baseline now, and the cheapest way to test it' },
        check_metric:         { type: 'string', enum: [...PITCH_METRICS] },
        effort:               { type: 'string', enum: [...PITCH_EFFORTS] },
        cost_estimate:        { type: 'string' },
        implementation_steps: { type: 'array', items: { type: 'string' }, description: '1-12 concrete steps' },
        sources:              { type: 'array', items: { type: 'object', properties: { url: { type: 'string' }, title: { type: 'string' }, published: { type: 'string' } }, required: ['url'] }, description: '1-8 URLs exactly as returned by get_research_findings' },
      },
      required: ['title', 'why_it_matters', 'hypothesis', 'check_metric', 'effort', 'implementation_steps', 'sources'],
    },
  },
] as const
