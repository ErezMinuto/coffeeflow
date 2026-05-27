// Minuto Organic Marketing — Self-Optimizing Reinforcement Loop.
//
// This is the BRAIN that turns real-world performance into self-written
// rules. Called by the orchestrator at the start of each cron tick,
// BEFORE planning new tasks.
//
// Logic (in plain English):
//   1. Pull every experiment in 'collecting' status whose lookback window
//      has elapsed (enough days passed for the metrics to settle).
//   2. For each, fetch performance per variation from the appropriate
//      source — GA4 for text_generation, Meta organic for instagram_post.
//   3. Build a comparison table. Check two gates:
//        (a) min_sample_size — every variation must have enough volume
//            (e.g., ≥50 sessions per blog page) for the comparison to mean
//            anything. If not, mark 'inconclusive' and move on.
//        (b) win_margin_multiplier — winner's metric must be ≥ N× the
//            runner-up's. 1.5× by default. Below this is noise.
//   4. If both gates pass, ask Claude (with the full comparison table) to
//      write ONE prescriptive heuristic that future planning should apply.
//      Strict prompt: be conservative ("this single experiment showed X"
//      not "always do X"), cite the metric and the magnitude.
//   5. Write the heuristic into seo_learnings with scope='experiment_winner'
//      and created_by='orchestrator'. Mark the experiment evaluated +
//      link the learning + the winning task.
//   6. Future strategist runs auto-inject these learnings (the existing
//      STANDING LEARNINGS block already pulls scope='experiment_winner' →
//      the loop closes itself).
//
// Why split into a separate module: keeping the orchestrator/index.ts lean
// and making the eval logic unit-testable + reusable from the chat handler
// (admin can ask "evaluate experiments now" via tool).

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  getExperimentsDueForEvaluation,
  getExperimentVariations,
  updateExperimentStatus,
  recordLearning,
} from './db.ts'
import { callClaude, MODEL_ORCHESTRATOR, parseClaudeJson } from './claude.ts'
import type {
  SeoExperimentRow,
  SeoTaskRow,
  ExperimentMetric,
} from './types.ts'

// ─────────────────────────────────────────────────────────────────────────
// PUBLIC ENTRY — call from orchestrator at start of cron tick.
// Returns a summary of what got scored so the orchestrator can log + reflect.
// ─────────────────────────────────────────────────────────────────────────
export async function evaluateDueExperiments(
  supabase: SupabaseClient,
): Promise<{
  evaluated:     number
  inconclusive:  number
  winners:       Array<{ experiment_id: string; winner_label: string; learning_id: string }>
  skipped:       Array<{ experiment_id: string; reason: string }>
}> {
  const due = await getExperimentsDueForEvaluation(supabase, 10)
  if (due.length === 0) {
    console.log('[evaluator] no experiments due for evaluation')
    return { evaluated: 0, inconclusive: 0, winners: [], skipped: [] }
  }

  console.log(`[evaluator] ${due.length} experiment(s) due — scoring`)
  const winners: Array<{ experiment_id: string; winner_label: string; learning_id: string }> = []
  const skipped: Array<{ experiment_id: string; reason: string }> = []
  let evaluated = 0
  let inconclusive = 0

  for (const exp of due) {
    try {
      const result = await evaluateOne(supabase, exp)
      if (result.outcome === 'winner') {
        winners.push({ experiment_id: exp.id, winner_label: result.winnerLabel!, learning_id: result.learningId! })
        evaluated++
      } else if (result.outcome === 'inconclusive') {
        inconclusive++
      } else {
        skipped.push({ experiment_id: exp.id, reason: result.skipReason ?? 'unknown' })
      }
    } catch (e: any) {
      console.error(`[evaluator] experiment ${exp.id} threw — skipping: ${e?.message ?? e}`)
      skipped.push({ experiment_id: exp.id, reason: e?.message ?? String(e) })
    }
  }

  console.log(`[evaluator] done — evaluated:${evaluated} inconclusive:${inconclusive} skipped:${skipped.length}`)
  return { evaluated, inconclusive, winners, skipped }
}

// ─────────────────────────────────────────────────────────────────────────
// One-experiment scoring.
// ─────────────────────────────────────────────────────────────────────────
interface EvalResult {
  outcome:      'winner' | 'inconclusive' | 'skipped'
  winnerLabel?: string
  learningId?:  string
  skipReason?:  string
}

async function evaluateOne(
  supabase: SupabaseClient,
  exp: SeoExperimentRow,
): Promise<EvalResult> {
  // Mark the experiment 'evaluating' so concurrent ticks don't re-score it.
  await updateExperimentStatus(supabase, exp.id, { status: 'evaluating' })

  const variations = await getExperimentVariations(supabase, exp.id)
  if (variations.length < 2) {
    await updateExperimentStatus(supabase, exp.id, {
      status: 'inconclusive',
      evaluation_summary: { reason: `only ${variations.length} variation(s) found; need ≥2 to compare` },
    })
    return { outcome: 'inconclusive', skipReason: 'fewer-than-2-variations' }
  }

  // Make sure every variation has completed (so result_data has the artifact ID).
  const incomplete = variations.filter(v => v.status !== 'completed')
  if (incomplete.length > 0) {
    // Don't change status — keep 'collecting' so the next cron tick retries
    // once the missing variations finish. The 'evaluating' lock auto-expires
    // when this function returns and no one writes back. Actually we DID set
    // 'evaluating' above. Set it back to 'collecting' so retry works.
    await updateExperimentStatus(supabase, exp.id, {
      status: 'collecting',
      evaluation_summary: { reason: `${incomplete.length}/${variations.length} variation(s) not yet completed — retrying next cycle` },
    } as any)  // 'collecting' isn't in the narrow type; cast for retry-only path
    return { outcome: 'skipped', skipReason: 'variations-incomplete' }
  }

  // Fetch performance per variation. Metric source depends on task_type.
  const performance = await fetchPerformancePerVariation(
    supabase,
    variations,
    exp.task_type,
    exp.primary_metric,
  )

  // Apply min_sample_size gate (per-variation).
  const sampleSizeField = sampleSizeFieldFor(exp.primary_metric)
  const undersized = performance.filter(p => (p[sampleSizeField] ?? 0) < exp.min_sample_size)
  if (undersized.length > 0) {
    const summary = {
      reason: `${undersized.length}/${performance.length} variation(s) under min_sample_size=${exp.min_sample_size} on '${sampleSizeField}'`,
      performance,
    }
    await updateExperimentStatus(supabase, exp.id, { status: 'inconclusive', evaluation_summary: summary })
    return { outcome: 'inconclusive', skipReason: 'undersized' }
  }

  // Pick winner by primary_metric.
  const sorted = [...performance].sort((a, b) =>
    Number(b[exp.primary_metric] ?? 0) - Number(a[exp.primary_metric] ?? 0)
  )
  const winner    = sorted[0]
  const runnerUp  = sorted[1]
  const winnerVal = Number(winner[exp.primary_metric] ?? 0)
  const runnerVal = Number(runnerUp[exp.primary_metric] ?? 0)

  // Apply win-margin gate. Avoid division-by-zero: if runnerVal is 0 and
  // winner is non-zero, treat as infinite ratio (clear winner). If both
  // are 0, no signal.
  const winRatio = runnerVal > 0 ? winnerVal / runnerVal : (winnerVal > 0 ? Infinity : 1)
  if (winRatio < exp.win_margin_multiplier) {
    const summary = {
      reason: `top variation '${winner.variation_label}' only ${winRatio.toFixed(2)}× runner-up '${runnerUp.variation_label}' on ${exp.primary_metric} — below threshold ${exp.win_margin_multiplier}×`,
      performance,
      win_ratio: winRatio,
    }
    await updateExperimentStatus(supabase, exp.id, { status: 'inconclusive', evaluation_summary: summary })
    return { outcome: 'inconclusive', skipReason: 'win-margin-too-thin' }
  }

  // We have a winner. Synthesize a prescriptive heuristic via Claude.
  const heuristic = await synthesizeHeuristic({
    hypothesis:           exp.hypothesis,
    task_type:            exp.task_type,
    primary_metric:       exp.primary_metric,
    win_ratio:            winRatio,
    performance,
    winner_label:         winner.variation_label as string,
  })

  // Record the learning. Evidence = the winning task's id.
  const learning = await recordLearning(supabase, {
    scope:              'experiment_winner',
    insight:            heuristic.rule,
    evidence_task_ids:  [winner.task_id],
    created_by:         'orchestrator',
  })

  await updateExperimentStatus(supabase, exp.id, {
    status:               'evaluated',
    winner_task_id:       winner.task_id,
    recorded_learning_id: learning.id,
    evaluation_summary: {
      performance,
      winner:        winner.variation_label,
      win_ratio:     winRatio,
      heuristic:     heuristic.rule,
      claude_reasoning: heuristic.reasoning,
    },
  })

  console.log(`[evaluator] experiment ${exp.id} → winner '${winner.variation_label}' (${winRatio.toFixed(2)}× on ${exp.primary_metric}) → learning ${learning.id}`)
  return { outcome: 'winner', winnerLabel: winner.variation_label as string, learningId: learning.id }
}

// ─────────────────────────────────────────────────────────────────────────
// Performance fetcher — routes to the right data source per task_type.
// Returns one row per variation with all relevant metrics + the sample-size
// field so the caller can apply the min_sample_size gate uniformly.
// ─────────────────────────────────────────────────────────────────────────
interface VariationPerformance {
  task_id:                  string
  variation_label:          string
  // Common fields populated based on task_type:
  ga4_sessions?:            number
  ga4_conversions?:         number
  ga4_conversion_value?:    number
  meta_impressions?:        number
  meta_engagement_rate?:    number
  meta_reach?:              number
  // Allow indexing by metric name string.
  [k: string]: unknown
}

async function fetchPerformancePerVariation(
  supabase: SupabaseClient,
  variations: SeoTaskRow[],
  taskType: string,
  primaryMetric: ExperimentMetric,
): Promise<VariationPerformance[]> {
  if (taskType === 'text_generation') {
    return fetchGa4PerformanceForBlogVariations(supabase, variations)
  }
  if (taskType === 'instagram_post') {
    return fetchMetaPerformanceForIgVariations(supabase, variations)
  }
  // Visual-only experiments are unusual; we still return the bare metric
  // matrix so the caller doesn't blow up. Caller's min_sample_size gate
  // will catch the all-zeros case.
  console.warn(`[evaluator] task_type='${taskType}' has no performance source wired; primary_metric='${primaryMetric}' will read 0`)
  return variations.map(v => ({
    task_id:         v.id,
    variation_label: v.variation_label ?? '?',
    [primaryMetric]: 0,
  }))
}

// Map blog-text variation → GA4 page metrics. The writer worker stores
// the final WP permalink in result_data.link, from which we derive the
// page_path GA4 reports against.
async function fetchGa4PerformanceForBlogVariations(
  supabase: SupabaseClient,
  variations: SeoTaskRow[],
): Promise<VariationPerformance[]> {
  const out: VariationPerformance[] = []
  for (const v of variations) {
    const result   = (v.result_data ?? {}) as { link?: string; wp_post_id?: number }
    const pagePath = result.link ? new URL(result.link).pathname : null
    if (!pagePath) {
      out.push({ task_id: v.id, variation_label: v.variation_label ?? '?', ga4_sessions: 0, ga4_conversions: 0, ga4_conversion_value: 0 })
      continue
    }
    // Aggregate the entire post-publish window. The orchestrator's
    // min_lookback_days already gated when this row is eligible; reading
    // everything since the task completed is the most-data-cheapest path.
    const since = v.completed_at ?? v.created_at
    const { data, error } = await supabase
      .from('ga4_pages_daily')
      .select('sessions, conversions, conversion_value')
      .eq('page_path', pagePath)
      .eq('channel_group', 'Organic Search')
      .gte('date', since.split('T')[0])
    if (error) {
      console.warn(`[evaluator] GA4 fetch failed for ${pagePath}: ${error.message}`)
      out.push({ task_id: v.id, variation_label: v.variation_label ?? '?', ga4_sessions: 0, ga4_conversions: 0, ga4_conversion_value: 0 })
      continue
    }
    const sessions    = (data ?? []).reduce((s, r: any) => s + (r.sessions ?? 0), 0)
    const conversions = (data ?? []).reduce((s, r: any) => s + Number(r.conversions ?? 0), 0)
    const convValue   = (data ?? []).reduce((s, r: any) => s + Number(r.conversion_value ?? 0), 0)
    out.push({
      task_id:               v.id,
      variation_label:       v.variation_label ?? '?',
      ga4_sessions:          sessions,
      ga4_conversions:       conversions,
      ga4_conversion_value:  convValue,
    })
  }
  return out
}

// Map IG-post variation → Meta organic post metrics. The IG worker
// stores ig_media_id in result_data; meta_organic_posts.post_id is the
// same identifier (post-Graph-API ingestion via meta-sync).
async function fetchMetaPerformanceForIgVariations(
  supabase: SupabaseClient,
  variations: SeoTaskRow[],
): Promise<VariationPerformance[]> {
  const out: VariationPerformance[] = []
  const mediaIds = variations
    .map(v => ((v.result_data ?? {}) as { ig_media_id?: string }).ig_media_id)
    .filter((id): id is string => !!id)
  if (mediaIds.length === 0) {
    return variations.map(v => ({
      task_id:               v.id,
      variation_label:       v.variation_label ?? '?',
      meta_impressions:      0,
      meta_engagement_rate:  0,
      meta_reach:            0,
    }))
  }
  const { data, error } = await supabase
    .from('meta_organic_posts')
    .select('post_id, reach, impressions, likes, comments, shares, saves')
    .in('post_id', mediaIds)
  if (error) {
    console.warn(`[evaluator] meta_organic_posts fetch failed: ${error.message}`)
    return variations.map(v => ({ task_id: v.id, variation_label: v.variation_label ?? '?', meta_impressions: 0, meta_engagement_rate: 0, meta_reach: 0 }))
  }
  const byMediaId = new Map((data ?? []).map((r: any) => [r.post_id as string, r]))
  for (const v of variations) {
    const mediaId = ((v.result_data ?? {}) as { ig_media_id?: string }).ig_media_id
    const row     = mediaId ? byMediaId.get(mediaId) : null
    const imp     = row ? (row.impressions ?? 0) : 0
    const eng     = row ? ((row.likes ?? 0) + (row.comments ?? 0) + (row.shares ?? 0) + (row.saves ?? 0)) : 0
    const engRate = imp > 0 ? eng / imp : 0
    out.push({
      task_id:               v.id,
      variation_label:       v.variation_label ?? '?',
      meta_impressions:      imp,
      meta_engagement_rate:  engRate,
      meta_reach:            row?.reach ?? 0,
    })
  }
  return out
}

// Which field the min_sample_size gate looks at. Sample size is volume,
// not the optimization target — even for engagement_rate experiments we
// gate on impressions (the denominator).
function sampleSizeFieldFor(metric: ExperimentMetric): string {
  switch (metric) {
    case 'ga4_conversions':
    case 'ga4_conversion_value':
      return 'ga4_sessions'
    case 'meta_engagement_rate':
    case 'meta_reach':
      return 'meta_impressions'
    default:
      return 'ga4_sessions'  // safe default
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Heuristic synthesizer — turns a comparison table into ONE prescriptive
// rule. Conservative by design: cites the specific experiment + magnitude,
// avoids over-generalizing from a single test.
// ─────────────────────────────────────────────────────────────────────────
const HEURISTIC_SYSTEM_PROMPT = `You are the autonomous learning module of Minuto's organic marketing agent. Your job: read the results of ONE A/B experiment and write ONE prescriptive rule that future planning should apply.

CRITICAL CONSTRAINTS — these prevent the rule corpus from becoming useless noise:

1. CONSERVATIVE LANGUAGE. This is a single experiment. Don't say "always" or "never". Use "evidence from one experiment suggests" / "preliminary signal: X outperformed Y by Nx" / "candidate rule, monitor in subsequent cycles". Future cycles will either reinforce or contradict — and only then does the rule harden.

2. CITE THE METRIC + MAGNITUDE. Without the number, the rule is empty. Bad: "technical hooks work". Good: "preliminary signal: technical-hook variation outperformed emotional-hook by 3.2× on ga4_conversions (n=120 vs n=110 sessions)".

3. SCOPED, NOT GLOBAL. Tie the rule to the experiment's context (channel, content type, audience proxy). Don't extrapolate. Bad: "shorter is better". Good: "for V60 brewing topics on the blog, the listicle format (~600 words) outperformed the long-form (~1400 words) on ga4_conversions by 2.1×".

4. ONE RULE, ONE SENTENCE (or two). Future strategist runs read these into a prompt. Bloat dilutes signal.

OUTPUT (strict JSON, no markdown fences):
{
  "rule": "the single prescriptive sentence (≤200 chars, scoped, with metric+magnitude)",
  "reasoning": "one to three sentences explaining why this rule follows from the data — for human auditing"
}`

async function synthesizeHeuristic(args: {
  hypothesis:      string
  task_type:       string
  primary_metric:  string
  win_ratio:       number
  performance:     VariationPerformance[]
  winner_label:    string
}): Promise<{ rule: string; reasoning: string }> {
  const perfTable = args.performance
    .map(p => `  • ${p.variation_label}: ${args.primary_metric}=${Number(p[args.primary_metric] ?? 0).toFixed(2)}  (sample: ${JSON.stringify(p).slice(0, 200)})`)
    .join('\n')

  const userMessage = `EXPERIMENT
hypothesis: ${args.hypothesis}
task_type:  ${args.task_type}
primary_metric: ${args.primary_metric}
winner: ${args.winner_label}
win_ratio: ${args.win_ratio.toFixed(2)}×

PERFORMANCE PER VARIATION:
${perfTable}

Write the single prescriptive rule per the system prompt. Output strict JSON only.`

  const res = await callClaude({
    model:       MODEL_ORCHESTRATOR,
    system:      HEURISTIC_SYSTEM_PROMPT,
    messages:    [{ role: 'user', content: userMessage }],
    maxTokens:   500,
    temperature: 0.2,
    timeoutMs:   60_000,
  })

  const parsed = parseClaudeJson<{ rule?: unknown; reasoning?: unknown }>(res.text)
  return {
    rule:      typeof parsed.rule === 'string' ? parsed.rule : `(empty rule from synthesizer for experiment "${args.hypothesis}")`,
    reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
  }
}
