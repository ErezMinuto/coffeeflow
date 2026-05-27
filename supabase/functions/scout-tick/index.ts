// Minuto Organic Marketing — daily scout tick.
//
// The orchestrator runs Sun + Wed. That leaves 5 days where fresh signals
// from Meta-sync (04:30 UTC daily) or industry-intel-sync (03:30 UTC daily)
// would otherwise sit unacted-upon until the next strategic cycle. The
// scout closes that latency window: runs daily at 07:00 UTC (after the
// data syncs land), detects URGENCY signals only, and creates a focused
// dynamic_experiment task per signal so the admin sees a proposal in the
// existing task queue with the existing approve/cancel UX.
//
// Scope is deliberately narrow — the scout does NOT do strategic
// planning, themed campaign work, or A/B experimentation. Those stay
// bounded to Sun/Wed. The scout only fires when something is urgent
// enough that a 2-3-day delay would lose the moment.
//
// V1 signals:
//   1. Meta engagement spike — IG post with engagement_rate >2× the 7d median
//   2. Fresh high-relevance industry article — relevance ≥0.85, ingested last 24h
//
// V2 candidates (not in v1):
//   3. GA4 conversion drop (page lost >50% week-over-week)
//   4. Inventory urgency (bestseller out of stock)
//   5. AI visibility shift (mention rate dropped on a high-intent query)
//   6. VoC pattern spike (new pattern with frequency ≥3 in 24h)

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { callClaude, parseClaudeJson } from '../seo-agent/claude.ts'
import { getSystemConfig } from '../seo-agent/db.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

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

// Fallback thresholds — overridable via system_config table at runtime.
// See migration 20260528_system_config.sql. Functions read overrides on
// each invocation so admin updates take effect on the next scout run.
const FALLBACK_META_SPIKE_MULTIPLIER  = 2.0
const FALLBACK_INDUSTRY_MIN_RELEVANCE = 0.85
// These remain hardcoded — not user-tunable (defensive lower bounds).
const META_SPIKE_MIN_IMPRESSIONS = 100  // skip tiny-sample posts where the rate is noisy
const META_LOOKBACK_DAYS         = 7
const INDUSTRY_LOOKBACK_HOURS    = 24
// Hard upper bound on scout output per tick — even if 5 things spiked,
// only the top N get tasks. Admin would otherwise get spammed.
const MAX_TASKS_PER_TICK         = 3

interface UrgentSignal {
  source:           'meta_spike' | 'industry_article'
  signal_summary:   string         // short label for the rationale
  signal_payload:   unknown        // structured data the strategist later sees
  priority_score:   number         // higher = more urgent; used to cap MAX_TASKS_PER_TICK
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST')    return jsonResponse({ error: 'POST only' }, 405)

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE)

  // Fetch runtime thresholds — overridable via system_config.
  const [metaMultiplier, industryMinRel] = await Promise.all([
    getSystemConfig<number>(supabase, 'scout.meta_spike_multiplier',  FALLBACK_META_SPIKE_MULTIPLIER),
    getSystemConfig<number>(supabase, 'scout.industry_min_relevance', FALLBACK_INDUSTRY_MIN_RELEVANCE),
  ])
  console.log(`[scout-tick] thresholds — meta_spike_multiplier=${metaMultiplier} industry_min_relevance=${industryMinRel}`)

  // 1. Detect signals (parallel — independent queries).
  const [metaSignals, industrySignals] = await Promise.all([
    detectMetaEngagementSpikes(supabase, metaMultiplier),
    detectFreshHighRelevanceArticles(supabase, industryMinRel),
  ])
  const allSignals = [...metaSignals, ...industrySignals]
    .sort((a, b) => b.priority_score - a.priority_score)
    .slice(0, MAX_TASKS_PER_TICK)

  if (allSignals.length === 0) {
    return jsonResponse({
      ok: true,
      signals_found: 0,
      tasks_created: 0,
      note: 'all quiet — no urgency signals above threshold',
      probed: { meta: metaSignals.length, industry: industrySignals.length },
    })
  }

  // 2. For each signal, ask Claude (Haiku) to draft a focused recommended
  // action. The action is what goes into the dynamic_experiment.description
  // for the admin to approve/skip. Sequential to keep cost predictable.
  const runId = crypto.randomUUID()
  const created: string[] = []
  for (const signal of allSignals) {
    try {
      const recommendation = await synthesizeRecommendation(signal)
      const { data, error } = await supabase
        .from('seo_tasks')
        .insert({
          task_type:    'dynamic_experiment',
          task_subtype: 'scout_alert',
          brief_data: {
            description:            recommendation.description,
            approval_required:      true,
            estimated_effort_hours: recommendation.effort_hours ?? 1,
            details: {
              signal_source:       signal.source,
              signal_summary:      signal.signal_summary,
              signal_payload:      signal.signal_payload,
              recommended_action:  recommendation.action,
              urgency_rationale:   recommendation.urgency_rationale,
            },
          },
          rationale:           `[scout] ${signal.signal_summary}`,
          orchestrator_run_id: runId,
        })
        .select('id')
        .single()
      if (error) {
        console.warn(`[scout-tick] insert failed for "${signal.signal_summary}": ${error.message}`)
        continue
      }
      created.push(data.id as string)
    } catch (e: any) {
      console.warn(`[scout-tick] synth/insert threw for "${signal.signal_summary}": ${e?.message ?? e}`)
    }
  }

  return jsonResponse({
    ok: true,
    signals_found: allSignals.length,
    tasks_created: created.length,
    task_ids:      created,
    scout_run_id:  runId,
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Signal detector — Meta organic engagement spike.
// ─────────────────────────────────────────────────────────────────────────
async function detectMetaEngagementSpikes(
  supabase: ReturnType<typeof createClient>,
  spikeMultiplier: number,
): Promise<UrgentSignal[]> {
  const since = new Date(Date.now() - META_LOOKBACK_DAYS * 24 * 3600 * 1000).toISOString()
  const { data, error } = await supabase
    .from('meta_organic_posts')
    .select('post_id, post_type, message, impressions, likes, comments, shares, saves, created_at')
    .gte('created_at', since)
    .limit(200)
  if (error) {
    console.warn(`[scout-tick] meta query failed: ${error.message}`)
    return []
  }
  const rows = (data ?? []) as Array<{
    post_id: string
    post_type: string | null
    message: string | null
    impressions: number | null
    likes: number | null
    comments: number | null
    shares: number | null
    saves: number | null
    created_at: string
  }>

  // Compute engagement_rate per post (engagement / impressions). Skip
  // posts under MIN_IMPRESSIONS — rate noise on small samples drowns out signal.
  const enriched = rows
    .map(r => {
      const imp = r.impressions ?? 0
      const eng = (r.likes ?? 0) + (r.comments ?? 0) + (r.shares ?? 0) + (r.saves ?? 0)
      return { ...r, eng_rate: imp > 0 ? eng / imp : 0, imp }
    })
    .filter(r => r.imp >= META_SPIKE_MIN_IMPRESSIONS)
  if (enriched.length < 3) return []   // can't compute meaningful median with <3 posts

  // Median engagement rate as the baseline.
  const rates = enriched.map(r => r.eng_rate).sort((a, b) => a - b)
  const median = rates[Math.floor(rates.length / 2)]
  if (median === 0) return []

  const spikes = enriched
    .filter(r => r.eng_rate >= median * spikeMultiplier)
    .sort((a, b) => b.eng_rate - a.eng_rate)
    .slice(0, 5)   // pre-cap before MAX_TASKS_PER_TICK applies globally

  return spikes.map(s => ({
    source:         'meta_spike',
    signal_summary: `IG ${s.post_type ?? 'post'} ${s.post_id.slice(-6)} engagement_rate ${(s.eng_rate * 100).toFixed(2)}% vs 7d median ${(median * 100).toFixed(2)}% (${(s.eng_rate / median).toFixed(1)}×)`,
    signal_payload: {
      post_id:         s.post_id,
      post_type:       s.post_type,
      message_preview: (s.message ?? '').slice(0, 200),
      engagement_rate: s.eng_rate,
      median_7d:       median,
      multiplier:      s.eng_rate / median,
      impressions:     s.imp,
      likes:           s.likes,
      comments:        s.comments,
      shares:          s.shares,
      saves:           s.saves,
      published_at:    s.created_at,
    },
    priority_score: s.eng_rate / median,   // multiplier = priority; bigger spike = more urgent
  }))
}

// ─────────────────────────────────────────────────────────────────────────
// Signal detector — fresh high-relevance industry article.
// ─────────────────────────────────────────────────────────────────────────
async function detectFreshHighRelevanceArticles(
  supabase: ReturnType<typeof createClient>,
  minRelevance: number,
): Promise<UrgentSignal[]> {
  const since = new Date(Date.now() - INDUSTRY_LOOKBACK_HOURS * 3600 * 1000).toISOString()
  const { data, error } = await supabase
    .from('industry_articles')
    .select('id, source_name, title, url, insight, relevance, tags, summarized_at')
    .gte('summarized_at', since)
    .gte('relevance', minRelevance)
    .order('relevance', { ascending: false })
    .limit(5)
  if (error) {
    console.warn(`[scout-tick] industry query failed: ${error.message}`)
    return []
  }
  const rows = (data ?? []) as Array<{
    id: string
    source_name: string
    title: string
    url: string
    insight: string
    relevance: number
    tags: string[] | null
  }>
  return rows.map(r => ({
    source:         'industry_article',
    signal_summary: `${r.source_name} (rel ${r.relevance.toFixed(2)}): "${r.title.slice(0, 80)}"`,
    signal_payload: {
      article_id: r.id,
      source:     r.source_name,
      title:      r.title,
      url:        r.url,
      insight:    r.insight,
      relevance:  r.relevance,
      tags:       r.tags,
    },
    // Industry articles get a lower base priority than Meta spikes (which
    // are time-sensitive); high-relevance articles still come through.
    priority_score: 0.5 + r.relevance,   // 1.35 for relevance=0.85, max 1.5
  }))
}

// ─────────────────────────────────────────────────────────────────────────
// Recommendation synthesizer — Haiku turns a signal into a single proposed
// action the admin can approve/skip. Strict about scope: the proposed
// action MUST fit one of the strategist's approved channels (WP draft, IG
// post, dynamic_experiment fix), nothing out of scope.
// ─────────────────────────────────────────────────────────────────────────
const SYNTH_SYSTEM_PROMPT = `You are the scout for Minuto's organic-marketing agent. The orchestrator only plans strategically twice weekly. Your job runs daily: when a signal lands that's urgent enough to act on within 24-48h (not wait for Sunday), you propose ONE focused action for the admin to approve.

SCOPE — your proposed action must fit ONE of:
  • A follow-up content piece (blog draft OR IG post) that ride-alongs a current moment
  • A small technical SEO move (schema, internal link, llms.txt edit) — anything that doesn't require deep strategic planning
  • Surface as 'noteworthy, no action required' if the signal is informational only

Be conservative. The bar is "would I want a human marketer to drop their other work and respond in 24h?". If no, recommend 'noteworthy, no action'. Better to under-fire than over-spam.

OUTPUT (strict JSON, no markdown fences):
{
  "description":       "1-3 sentences explaining what to do + why now. Admin reads this as the dynamic_experiment description and decides approve/skip.",
  "action":            "concise verb-led summary of the recommended move (e.g. 'Write a 600-word V60 follow-up blog post that cites this article')",
  "urgency_rationale": "why this can't wait until Sunday",
  "effort_hours":      0.5-3
}`

async function synthesizeRecommendation(signal: UrgentSignal): Promise<{
  description:        string
  action:             string
  urgency_rationale:  string
  effort_hours:       number
}> {
  const userMessage = `SIGNAL SOURCE: ${signal.source}
SUMMARY: ${signal.signal_summary}
PAYLOAD: ${JSON.stringify(signal.signal_payload).slice(0, 2000)}

Propose ONE focused action per the system prompt. Output strict JSON only.`

  const res = await callClaude({
    model:       'claude-haiku-4-5',
    system:      SYNTH_SYSTEM_PROMPT,
    messages:    [{ role: 'user', content: userMessage }],
    maxTokens:   500,
    temperature: 0.3,
    timeoutMs:   30_000,
  })

  const parsed = parseClaudeJson<{ description?: unknown; action?: unknown; urgency_rationale?: unknown; effort_hours?: unknown }>(res.text)
  return {
    description:       typeof parsed.description       === 'string' ? parsed.description       : `(synth failed for ${signal.signal_summary})`,
    action:            typeof parsed.action            === 'string' ? parsed.action            : '(no action proposed)',
    urgency_rationale: typeof parsed.urgency_rationale === 'string' ? parsed.urgency_rationale : '',
    effort_hours:      typeof parsed.effort_hours      === 'number' ? Math.max(0.5, Math.min(4, parsed.effort_hours)) : 1,
  }
}
