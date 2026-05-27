// Minuto SEO Agent — Orchestrator (autonomous strategist).
//
// Triggered by pg_cron on a cadence (twice weekly to start; tunable
// without redeploy via supabase/migrations/<date>_seo_orchestrator_cron.sql),
// or manually via POST { trigger: "manual" } from the admin dashboard.
//
// Flow:
//   1. Fetch fresh GSC keywords, blog history, inventory, recent tasks
//   2. Snapshot all of it into seo_metrics for auditability + delta-tracking
//   3. Build self-reflection user message (anti-recycling enforced via
//      explicit history of past tasks)
//   4. Call Claude Sonnet with the Strategist system prompt
//   5. Parse the structured plan
//   6. Insert tasks into seo_tasks with proper parent/dependency wiring
//   7. Return summary
//
// The orchestrator NEVER writes content or generates images itself. It
// only specs work for the workers (seo-worker-writer, seo-worker-visual)
// to pick up via cron-polled SELECT FOR UPDATE SKIP LOCKED.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { STRATEGIST_SYSTEM_PROMPT } from '../seo-agent/prompts/strategist.ts'
import { callClaude, parseClaudeJson, MODEL_ORCHESTRATOR } from '../seo-agent/claude.ts'
import {
  createSupabase,
  insertTasks,
  insertMetrics,
  getRecentTasks,
  getRecentMetricsSnapshots,
  getRecentLearnings,
  insertExperiment,
} from '../seo-agent/db.ts'
import { evaluateDueExperiments } from '../seo-agent/experimentEvaluator.ts'
import { detectWpPublishTransitions } from '../seo-agent/wpPublishDetector.ts'
import { collectPostFollowback, type PostFollowback } from '../seo-agent/postPerformanceFollowback.ts'
import {
  fetchTopKeywords,
  computePositionDeltas,
  fetchTopConvertingPaidKeywords,
  fetchTopConvertingSearchTerms,
  fetchTopOrganicLandingPages,
} from '../seo-agent/services/googleApi.ts'
import {
  fetchRecentBlogPosts,
  fetchActiveCatalog,
  fetchInventoryAlerts,
  fetchVocInsights,
  fetchKeywordOpportunities,
  fetchRecentMarketResearch,
  fetchIndustryInsights,
  fetchAiVisibilitySummary,
} from '../seo-agent/services/cmsApi.ts'
import {
  fetchTopOrganicPosts,
  fetchTopConvertingAds,
} from '../seo-agent/services/metaApi.ts'
import type {
  MetricsSnapshot,
  NewSeoTask,
  OrchestratorEmittedTask,
  SeoTaskRow,
} from '../seo-agent/types.ts'

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

serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS })
  if (req.method !== 'POST')    return jsonResponse({ error: 'POST only' }, 405)

  // Parse trigger (manual vs cron). Both are accepted; the body is
  // informational only. orchestrator_run_id is generated server-side.
  let body: { trigger?: 'manual' | 'cron'; focus?: string } = {}
  try { body = await req.json() } catch { /* empty body is fine */ }
  const trigger = body.trigger ?? 'manual'
  const focus   = body.focus   ?? ''
  const runId   = crypto.randomUUID()
  console.log(`[organic-orchestrator] run=${runId} trigger=${trigger} focus="${focus.slice(0, 100)}"`)

  try {
    const supabase = createSupabase()

    // ── 0a. WP PUBLISH DETECTOR — settle wp_published flags ────────────
    // Writer worker creates drafts; admin manually publishes via WP admin.
    // Without polling, the orchestrator can't tell which drafts went live.
    // This call queries WP REST for tasks where wp_published is still
    // null and patches result_data accordingly.
    console.log('[organic-orchestrator] polling WP draft→publish transitions…')
    let wpDetectorSummary: Awaited<ReturnType<typeof detectWpPublishTransitions>>
    try {
      wpDetectorSummary = await detectWpPublishTransitions(supabase, 60)
    } catch (e: any) {
      console.error(`[organic-orchestrator] WP publish detector threw — continuing: ${e?.message ?? e}`)
      wpDetectorSummary = { checked: 0, newly_live: 0, still_draft: 0, errors: [{ task_id: '-', error: e?.message ?? String(e) }] }
    }
    console.log(`[organic-orchestrator] WP detector — checked:${wpDetectorSummary.checked} newly_live:${wpDetectorSummary.newly_live} still_draft:${wpDetectorSummary.still_draft}`)

    // ── 0b. SELF-LEARNING TICK ────────────────────────────────────────
    // Before planning anything new, score any past experiments whose
    // data has settled. Winners get written into seo_learnings with
    // scope='experiment_winner' + created_by='orchestrator'. The
    // STANDING LEARNINGS fetch below then pulls them and the strategist
    // applies them to the new plan. The loop closes here.
    console.log('[organic-orchestrator] evaluating due experiments…')
    let experimentEvalSummary: Awaited<ReturnType<typeof evaluateDueExperiments>>
    try {
      experimentEvalSummary = await evaluateDueExperiments(supabase)
    } catch (e: any) {
      console.error(`[organic-orchestrator] experiment evaluation threw — continuing planning: ${e?.message ?? e}`)
      experimentEvalSummary = { evaluated: 0, inconclusive: 0, winners: [], skipped: [{ experiment_id: 'eval-pass', reason: e?.message ?? String(e) }] }
    }
    console.log(`[organic-orchestrator] experiment eval — evaluated:${experimentEvalSummary.evaluated} inconclusive:${experimentEvalSummary.inconclusive} skipped:${experimentEvalSummary.skipped.length}`)

    // ── 0c. PER-POST FOLLOW-BACK ───────────────────────────────────────
    // Gather per-task performance for the last 14 days so the strategist
    // can see "the tasks I queued in prior cycles — here is each one's
    // current status + performance". Different from the aggregate
    // top-performers blocks (those show site-wide winners; this shows
    // the agent's own recent emissions).
    console.log('[organic-orchestrator] collecting per-post follow-back…')
    let postFollowback: PostFollowback[] = []
    try {
      postFollowback = await collectPostFollowback(supabase, 14)
    } catch (e: any) {
      console.error(`[organic-orchestrator] follow-back collection threw — continuing: ${e?.message ?? e}`)
    }
    console.log(`[organic-orchestrator] follow-back — ${postFollowback.length} task(s) reported`)

    // ── 1. Fetch source data ──────────────────────────────────────────
    console.log('[organic-orchestrator] fetching source data…')
    const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString()
    const sixtyDaysAgo    = new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString()

    const [
      gscKeywords,
      blogPosts,
      catalog,
      inventoryAlerts,
      recentTasks,
      priorSnapshots,
      learnings,
      // New data sources — already-synced tables previously unused by strategist
      paidKeywords,
      searchTerms,
      organicPosts,
      paidAds,
      vocInsights,
      keywordOpportunities,
      marketResearch,
      ga4LandingPages,
      industryInsights,
      aiVisibility,
    ] = await Promise.all([
      fetchTopKeywords(supabase, 30, 30),
      fetchRecentBlogPosts(supabase, sixtyDaysAgo, 100),
      fetchActiveCatalog(supabase),
      fetchInventoryAlerts(supabase),
      getRecentTasks(supabase, fourteenDaysAgo, 100),
      getRecentMetricsSnapshots(supabase, 'orchestrator_run', 2),
      // Cross-session learnings — scopes most relevant to strategist planning.
      // Excludes brand_voice (the writer worker enforces those via its own
      // prompt) and qa_pattern (the visual worker handles those internally).
      getRecentLearnings(supabase, {
        scopes: ['visual_style', 'render_strategy', 'content_topic', 'other'],
        limit: 30,
      }),
      // Google Ads — which paid keywords convert; seed organic content for them
      fetchTopConvertingPaidKeywords(supabase, 30, 15),
      fetchTopConvertingSearchTerms(supabase, 30, 15),
      // Meta — which organic posts resonate; which ads convert
      fetchTopOrganicPosts(supabase, 30, 10),
      fetchTopConvertingAds(supabase, 30, 10),
      // Customer research — VoC mined from real customer interactions, untapped
      // keyword opportunities, competitor scans
      fetchVocInsights(supabase, 15),
      fetchKeywordOpportunities(supabase, 15),
      fetchRecentMarketResearch(supabase, 30, 5),
      // GA4 — real organic-traffic landing-page performance (sessions +
      // conversions per page). Closes the loop on "did past articles
      // actually drive sales?" rather than just impressions.
      fetchTopOrganicLandingPages(supabase, 30, 20),
      // Industry intelligence — relevance-filtered insights from
      // marketing/SEO/social/coffee feeds. Daily-ingested via
      // industry-intelligence-sync. Strategist reads to update its
      // understanding of best practices independent of Minuto's own data.
      fetchIndustryInsights(supabase, { minRelevance: 0.5, lookbackDays: 14, limit: 12 }),
      // AI shopping-agent visibility — per-query Minuto mention rate
      // across LLM probes (Claude / Perplexity / GPT-4o etc). Populated
      // weekly by ai-visibility-probe. Strategist proposes
      // dynamic_experiment tasks (e.g. 'add llms.txt', 'publish
      // authoritative comparison piece') to improve discoverability
      // inside AI shopping assistants.
      fetchAiVisibilitySummary(supabase, 30),
    ])

    console.log(
      `[organic-orchestrator] sources — gsc:${gscKeywords.length} ` +
      `blog:${blogPosts.length} catalog:${catalog.length} ` +
      `inv:${inventoryAlerts.length} recentTasks:${recentTasks.length} ` +
      `priorSnapshots:${priorSnapshots.length} learnings:${learnings.length} ` +
      `paidKw:${paidKeywords.length} searchTerms:${searchTerms.length} ` +
      `organicPosts:${organicPosts.length} paidAds:${paidAds.length} ` +
      `voc:${vocInsights.length} kwOps:${keywordOpportunities.length} ` +
      `research:${marketResearch.length} ga4Pages:${ga4LandingPages.length}`,
    )

    // ── 2. Snapshot fresh metrics ─────────────────────────────────────
    // Prior snapshot[0] is the LAST orchestrator run's snapshot (if any).
    const priorPayload = (priorSnapshots[0]?.metrics_payload ?? null) as unknown as MetricsSnapshot | null
    const priorKeywords = priorPayload?.gsc_top_keywords ?? null
    const positionDeltas = priorKeywords
      ? computePositionDeltas(gscKeywords, priorKeywords)
      : null

    const tasksCompletedSinceLast = recentTasks.filter(t => t.status === 'completed').length
    const tasksFailedSinceLast    = recentTasks.filter(t => t.status === 'failed').length

    const blogPostsLast7  = blogPosts.filter(p => {
      if (!p.published_at) return false
      return new Date(p.published_at).getTime() > Date.now() - 7 * 24 * 3600 * 1000
    }).length
    const blogPostsLast30 = blogPosts.filter(p => {
      if (!p.published_at) return false
      return new Date(p.published_at).getTime() > Date.now() - 30 * 24 * 3600 * 1000
    }).length

    const snapshot: MetricsSnapshot = {
      gsc_top_keywords:               gscKeywords,
      gsc_position_deltas:            positionDeltas,
      blog_published_count_30d:       blogPostsLast30,
      blog_published_count_7d:        blogPostsLast7,
      tasks_completed_since_last_run: tasksCompletedSinceLast,
      tasks_failed_since_last_run:    tasksFailedSinceLast,
      extras: {
        inventory_critical: inventoryAlerts.filter(i => i.state === 'critical').map(i => i.name),
        inventory_low:      inventoryAlerts.filter(i => i.state === 'low').map(i => i.name),
        orchestrator_run_id: runId,
        trigger,
      },
    }
    const snapshotId = await insertMetrics(supabase, 'orchestrator_run', snapshot)
    console.log(`[organic-orchestrator] snapshot inserted id=${snapshotId}`)

    // ── 3. Build user message for the strategist ─────────────────────
    const userMessage = buildStrategistUserMessage({
      focus,
      snapshot,
      recentTasks,
      blogPosts,
      catalog,
      inventoryAlerts,
      learnings,
      paidKeywords,
      searchTerms,
      organicPosts,
      paidAds,
      vocInsights,
      keywordOpportunities,
      marketResearch,
      ga4LandingPages,
      industryInsights,
      aiVisibility,
      postFollowback,
    })

    // ── 4. Call Claude ───────────────────────────────────────────────
    console.log(`[organic-orchestrator] calling ${MODEL_ORCHESTRATOR}…`)
    const claudeRes = await callClaude({
      model:    MODEL_ORCHESTRATOR,
      system:   STRATEGIST_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
      maxTokens:  8192,
      temperature: 0.7,  // balanced — needs creativity but also structure
    })
    console.log(
      `[organic-orchestrator] strategist done — tokens: ` +
      `in=${claudeRes.inputTokens} out=${claudeRes.outputTokens} ` +
      `cache_read=${claudeRes.cacheReadTokens}`,
    )

    // ── 5. Parse the plan ────────────────────────────────────────────
    let plan: {
      summary?:         string
      self_reflection?: string[]
      tasks?:           OrchestratorEmittedTask[]
    }
    try {
      plan = parseClaudeJson(claudeRes.text)
    } catch (e: any) {
      console.error('[organic-orchestrator] failed to parse strategist output:', e?.message)
      console.error('[organic-orchestrator] raw text:', claudeRes.text.slice(0, 1000))
      return jsonResponse({
        error:             'strategist returned unparseable JSON',
        run_id:            runId,
        snapshot_id:       snapshotId,
        raw:               claudeRes.text.slice(0, 2000),
      }, 502)
    }
    const emittedTasks       = Array.isArray(plan.tasks) ? plan.tasks : []
    const emittedExperiments = Array.isArray(plan.experiments) ? plan.experiments : []
    console.log(
      `[organic-orchestrator] plan parsed — ` +
      `summary="${(plan.summary ?? '').slice(0, 80)}" ` +
      `reflections=${plan.self_reflection?.length ?? 0} ` +
      `experiments=${emittedExperiments.length} ` +
      `tasks=${emittedTasks.length}`,
    )

    // ── 6a. Materialize experiments. Each experiment_group string from
    // the strategist becomes one seo_experiments row; the row's UUID is
    // then stamped onto every task that referenced the same group.
    const experimentIdByGroup = new Map<string, string>()
    for (const exp of emittedExperiments) {
      if (!exp.experiment_group || !exp.hypothesis || !exp.task_type || !exp.primary_metric) {
        console.warn(`[organic-orchestrator] skipping malformed experiment: ${JSON.stringify(exp).slice(0, 200)}`)
        continue
      }
      try {
        const row = await insertExperiment(supabase, {
          hypothesis:            exp.hypothesis,
          task_type:             exp.task_type,
          primary_metric:        exp.primary_metric,
          min_lookback_days:     exp.min_lookback_days     ?? 7,
          min_sample_size:       exp.min_sample_size       ?? 50,
          win_margin_multiplier: exp.win_margin_multiplier ?? 1.5,
          orchestrator_run_id:   runId,
        })
        experimentIdByGroup.set(exp.experiment_group, row.id)
      } catch (e: any) {
        console.warn(`[organic-orchestrator] insertExperiment failed for "${exp.experiment_group}": ${e?.message ?? e}`)
      }
    }
    console.log(`[organic-orchestrator] experiments materialized: ${experimentIdByGroup.size}/${emittedExperiments.length}`)

    // ── 6b. Insert tasks with parent/dependency wiring ────────────────
    // Two-pass: first pass inserts tasks WITHOUT parent_task_id /
    // depends_on so we get UUIDs back. Second pass updates the rows
    // that have parent_task_index / depends_on_index references.
    let insertedRows: SeoTaskRow[] = []
    if (emittedTasks.length > 0) {
      const newTasks: NewSeoTask[] = emittedTasks.map(et => {
        const base: NewSeoTask = {
          task_type:           et.task_type,
          task_subtype:        et.task_subtype ?? null,
          brief_data:          et.brief_data,
          rationale:           et.rationale ?? '',
          orchestrator_run_id: runId,
        }
        // Stamp the experiment_id onto the task at insert time. If the
        // strategist named an experiment_group but we failed to insert it
        // above, the task ships WITHOUT experiment tagging (graceful
        // degradation — better one good task than zero).
        if (et.experiment_group && experimentIdByGroup.has(et.experiment_group)) {
          base.experiment_id   = experimentIdByGroup.get(et.experiment_group)!
          base.variation_label = et.variation_label ?? null
        }
        // Omit scheduled_for entirely (don't set undefined — Supabase
        // serializes undefined as null and the column is NOT NULL) so
        // the column's DEFAULT NOW() fires when no offset is set.
        if (et.scheduled_offset_hours) {
          base.scheduled_for = new Date(Date.now() + et.scheduled_offset_hours * 3600 * 1000).toISOString()
        }
        return base
      })
      insertedRows = await insertTasks(supabase, newTasks)
      console.log(`[organic-orchestrator] first-pass insert: ${insertedRows.length} rows`)

      // Wire parent_task_id + depends_on from indexes → UUIDs.
      // Each emittedTask[i] corresponds to insertedRows[i].
      const updates: Array<{ id: string; patch: Record<string, unknown> }> = []
      for (let i = 0; i < emittedTasks.length; i++) {
        const et = emittedTasks[i]
        const row = insertedRows[i]
        if (!row) continue
        const patch: Record<string, unknown> = {}

        if (typeof et.parent_task_index === 'number') {
          const parentRow = insertedRows[et.parent_task_index]
          if (parentRow && parentRow.id !== row.id) {
            patch.parent_task_id = parentRow.id
          }
        }
        if (typeof et.depends_on_index === 'number') {
          const depRow = insertedRows[et.depends_on_index]
          if (depRow && depRow.id !== row.id) {
            patch.depends_on = [depRow.id]
          }
        }
        if (Object.keys(patch).length > 0) updates.push({ id: row.id, patch })
      }
      for (const u of updates) {
        const { error } = await supabase
          .from('seo_tasks')
          .update(u.patch)
          .eq('id', u.id)
        if (error) console.warn(`[organic-orchestrator] wire-up update failed for ${u.id}: ${error.message}`)
      }
      console.log(`[organic-orchestrator] wire-up updates: ${updates.length}`)
    }

    // ── 7. Return summary ────────────────────────────────────────────
    return jsonResponse({
      success:        true,
      run_id:         runId,
      snapshot_id:    snapshotId,
      summary:        plan.summary ?? '',
      self_reflection: plan.self_reflection ?? [],
      experiments_evaluated: experimentEvalSummary,    // Step 0 reinforcement-loop output
      experiments_emitted:   experimentIdByGroup.size,
      tasks_emitted:  insertedRows.length,
      task_ids:       insertedRows.map(r => r.id),
      tokens: {
        input:  claudeRes.inputTokens,
        output: claudeRes.outputTokens,
        cache_read: claudeRes.cacheReadTokens,
      },
    })
  } catch (e: any) {
    console.error('[organic-orchestrator] failed:', e?.message ?? e)
    console.error(e?.stack ?? '')
    return jsonResponse({
      error:  e?.message ?? String(e),
      run_id: runId,
    }, 500)
  }
})

// ── User-message construction ──────────────────────────────────────────
// Kept in this file (not in seo-agent/) so iterating on the orchestrator
// doesn't require touching the shared module. If this grows past ~100
// lines, move to seo-agent/orchestrator_user_message.ts.

function buildStrategistUserMessage(args: {
  focus:           string
  snapshot:        MetricsSnapshot
  recentTasks:     SeoTaskRow[]
  blogPosts:       Array<{ title: string; url: string; published_at: string | null }>
  catalog:         Array<{ name: string; price: number | null; permalink: string | null; stock_status: string | null }>
  inventoryAlerts: Array<{ name: string; packed_stock: number; state: string }>
  learnings:       Array<{ id: string; scope: string; insight: string; created_at: string }>
  paidKeywords:    Array<{ keyword: string; match_type: string | null; impressions: number; clicks: number; cost_ils: number; conversions: number; conv_value: number; ctr: number; cost_per_conv: number | null }>
  searchTerms:     Array<{ search_term: string; triggering_keyword: string | null; impressions: number; clicks: number; conversions: number; cost_ils: number }>
  organicPosts:    Array<{ post_id: string; post_type: string | null; message: string | null; created_at: string; impressions: number; engagement_rate: number; likes: number; comments: number; shares: number; saves: number }>
  paidAds:         Array<{ ad_id: string; campaign_id: string | null; impressions: number; clicks: number; spend_ils: number; conversions: number; cost_per_conv: number | null }>
  vocInsights:     Array<{ pattern: string; real_meaning: string | null; customer_stage: string | null; product_context: string | null; frequency: number; example_phrases: unknown }>
  keywordOpportunities: Array<{ keyword: string; avg_monthly_searches: number | null; competition: string | null; competition_index: number | null }>
  marketResearch:  Array<{ research_date: string; source: string; summary: string | null }>
  ga4LandingPages: Array<{ page_path: string; sessions: number; active_users: number; engaged_sessions: number; conversions: number; conversion_value: number; avg_bounce_rate: number | null; avg_session_duration: number | null }>
  industryInsights: Array<{ source_name: string; source_category: string; title: string; url: string; insight: string; relevance: number; tags: string[]; published_at: string | null }>
  aiVisibility:    Array<{ query: string; category: string; language: string; probes_total: number; mentions_total: number; mention_rate: number; avg_mention_position: number | null; top_competitors: Array<{ name: string; count: number }>; last_run: string }>
  postFollowback:  PostFollowback[]
}): string {
  const { focus, snapshot, recentTasks, blogPosts, catalog, inventoryAlerts, learnings,
          paidKeywords, searchTerms, organicPosts, paidAds, vocInsights, keywordOpportunities, marketResearch,
          ga4LandingPages, industryInsights, aiVisibility, postFollowback } = args

  const focusBlock = focus
    ? `\n=== FOCUS DIRECTIVE FROM ADMIN ===\n${focus}\n(Treat this as a strong hint, not an override. Anti-recycling rules still apply.)\n`
    : ''

  // GSC keywords — full list, since they're the orchestrator's primary input.
  const gscBlock = snapshot.gsc_top_keywords.length > 0
    ? snapshot.gsc_top_keywords
        .map(k => `  "${k.keyword}" — imp:${k.impressions} clicks:${k.clicks} ctr:${(k.ctr * 100).toFixed(1)}% pos:${k.position.toFixed(1)}`)
        .join('\n')
    : '  (no GSC data this cycle)'

  // Position deltas — only show movement keywords (delta != 0).
  const deltaBlock = snapshot.gsc_position_deltas
    ? snapshot.gsc_position_deltas
        .filter(d => d.prev_position != null && Math.abs(d.delta) >= 0.5)
        .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
        .slice(0, 20)
        .map(d => {
          const arrow = d.delta < 0 ? '↑' : '↓'
          return `  ${arrow} "${d.keyword}" — ${d.prev_position?.toFixed(1)} → ${d.new_position.toFixed(1)} (Δ${d.delta.toFixed(1)})`
        })
        .join('\n')
    : '  (no prior snapshot — first orchestrator run for this brand)'

  // Recent tasks — the anti-recycling proof. Group by status.
  const tasksByStatus = {
    completed:  recentTasks.filter(t => t.status === 'completed'),
    failed:     recentTasks.filter(t => t.status === 'failed'),
    pending:    recentTasks.filter(t => t.status === 'pending'),
    processing: recentTasks.filter(t => t.status === 'processing'),
  }
  function renderTask(t: SeoTaskRow): string {
    const brief = JSON.stringify(t.brief_data).slice(0, 200)
    const sub = t.task_subtype ? `:${t.task_subtype}` : ''
    return `  [${t.status.toUpperCase()}] ${t.task_type}${sub} — ${t.rationale ?? ''} | brief: ${brief}…`
  }
  const recentTasksBlock = recentTasks.length === 0
    ? '  (no prior tasks in last 14 days)'
    : [
        `COMPLETED (${tasksByStatus.completed.length}):`,
        ...tasksByStatus.completed.slice(0, 30).map(renderTask),
        `FAILED (${tasksByStatus.failed.length}):`,
        ...tasksByStatus.failed.slice(0, 10).map(renderTask),
        `STILL PENDING / PROCESSING (${tasksByStatus.pending.length + tasksByStatus.processing.length}):`,
        ...[...tasksByStatus.pending, ...tasksByStatus.processing].slice(0, 20).map(renderTask),
      ].join('\n')

  // Published blog posts — the forbidden-topics list.
  const blogBlock = blogPosts.length === 0
    ? '  (no published posts in last 60 days)'
    : blogPosts.slice(0, 50).map(p => {
        const when = p.published_at ? new Date(p.published_at).toISOString().split('T')[0] : ''
        return `  • ${p.title}${when ? ` (${when})` : ''}`
      }).join('\n')

  // Catalog — just names with stock/price, for products_to_mention picking.
  const catalogBlock = catalog.length === 0
    ? '  (catalog empty)'
    : catalog.slice(0, 50).map(p => {
        const stock = p.stock_status ? ` ${p.stock_status}` : ''
        const price = p.price ? ` ₪${p.price}` : ''
        return `  • ${p.name}${price}${stock}`
      }).join('\n')

  // Inventory alerts — surface low/critical so the strategist factors them in.
  const inventoryBlock = inventoryAlerts.length === 0
    ? '  (no inventory alerts)'
    : inventoryAlerts
        .filter(i => i.state !== 'healthy')
        .map(i => `  ${i.state === 'critical' ? '⛔' : '⚠️'} ${i.name} — ${i.packed_stock} bags`)
        .join('\n') || '  (all inventory healthy)'

  // Standing learnings — cross-session memory recorded via the chat
  // agent or future orchestrator self-writes. These are PRESCRIPTIVE
  // rules the strategist must honor when planning. Grouped by scope.
  const learningsBlock = learnings.length === 0
    ? '  (no standing learnings yet)'
    : (() => {
        const grouped: Record<string, string[]> = {}
        for (const l of learnings) {
          const k = l.scope || 'other'
          if (!grouped[k]) grouped[k] = []
          grouped[k].push(`  • ${l.insight}`)
        }
        return Object.entries(grouped)
          .map(([scope, lines]) => `${scope}:\n${lines.join('\n')}`)
          .join('\n\n')
      })()

  return `=== CURRENT CYCLE METRICS ===

GSC top keywords (last 30d, ranked by impressions):
${gscBlock}

POSITION DELTAS vs prior orchestrator run (only movement ≥0.5 shown):
${deltaBlock}

Blog cadence — published in last 7 days: ${snapshot.blog_published_count_7d}, last 30 days: ${snapshot.blog_published_count_30d}

Task outcomes since last cycle — completed: ${snapshot.tasks_completed_since_last_run}, failed: ${snapshot.tasks_failed_since_last_run}

=== INVENTORY ALERTS ===
${inventoryBlock}

=== RECENT TASKS (LAST 14 DAYS) — ANTI-RECYCLING SOURCE OF TRUTH ===

You MUST read every entry below before proposing new tasks. Anything you propose that matches a brief here (by topic, keyword cluster, or angle) is FORBIDDEN — even if you re-word it.

${recentTasksBlock}

=== PUBLISHED BLOG POSTS (LAST 60 DAYS) — FORBIDDEN AS NEW ARTICLE TOPICS ===

${blogBlock}

=== PRODUCT CATALOG (for products_to_mention picking; use EXACT names) ===

${catalogBlock}

=== STANDING LEARNINGS (cross-session memory — apply unless explicitly contradicted by this cycle's data) ===

These are durable rules surfaced by the admin via chat (or written by earlier strategist runs). Treat them as constraints on your plan: every brief you emit should respect them, and your self_reflection should explicitly note when a learning shaped your choices.

${learningsBlock}

=== GOOGLE ADS — PAID-INTENT SIGNALS (last 30d) ===

Where Minuto is paying for clicks AND seeing conversions. These are validated commercial intents — write organic content that ranks for these queries so you stop paying for clicks you could earn for free.

Top converting paid keywords (sorted by conversions):
${paidKeywords.length === 0 ? '  (no paid keyword data)' : paidKeywords.map(k =>
  `  "${k.keyword}" [${k.match_type ?? '-'}] — conv:${k.conversions.toFixed(1)} clicks:${k.clicks} cost:₪${k.cost_ils.toFixed(0)} ${k.cost_per_conv ? `cpa:₪${k.cost_per_conv.toFixed(0)}` : ''}`,
).join('\n')}

Actual search terms users typed (what's reaching ads):
${searchTerms.length === 0 ? '  (no search term data)' : searchTerms.map(t =>
  `  "${t.search_term}" → triggered by "${t.triggering_keyword ?? '-'}" — conv:${t.conversions.toFixed(1)} clicks:${t.clicks}`,
).join('\n')}

=== META ORGANIC + ADS — SOCIAL SIGNALS (last 30d) ===

Top organic posts by engagement rate (engagements per impression — small posts with high engagement matter more than viral low-engagement ones):
${organicPosts.length === 0 ? '  (no organic post data)' : organicPosts.map(p => {
  const msg = (p.message ?? '').replace(/\s+/g, ' ').slice(0, 100)
  return `  ${p.post_type ?? 'post'}/${p.post_id.slice(-6)} — er:${(p.engagement_rate * 100).toFixed(2)}% imp:${p.impressions} ❤${p.likes} 💬${p.comments} 🔁${p.shares} 🔖${p.saves} | "${msg}${(p.message?.length ?? 0) > 100 ? '…' : ''}"`
}).join('\n')}

Top converting paid ads (last 30d):
${paidAds.length === 0 ? '  (no paid ad data)' : paidAds.map(a =>
  `  ad/${a.ad_id.slice(-6)} (campaign ${a.campaign_id?.slice(-6) ?? '-'}) — conv:${a.conversions.toFixed(1)} clicks:${a.clicks} spend:₪${a.spend_ils.toFixed(0)} ${a.cost_per_conv ? `cpa:₪${a.cost_per_conv.toFixed(0)}` : ''}`,
).join('\n')}

=== CUSTOMER RESEARCH — VoC + UNTAPPED KEYWORDS + COMPETITOR SCANS ===

VoC insights (real customer patterns from IG DMs / support / interactions — mined by marketing-advisor):
${vocInsights.length === 0 ? '  (no VoC insights yet)' : vocInsights.map(v => {
  const examples = Array.isArray(v.example_phrases)
    ? (v.example_phrases as unknown[]).slice(0, 2).map(String).join(' / ')
    : ''
  return `  • [${v.customer_stage ?? '?'}/${v.product_context ?? '?'}] ${v.pattern} (freq:${v.frequency})${v.real_meaning ? ` — meaning: ${v.real_meaning}` : ''}${examples ? ` — e.g. "${examples}"` : ''}`
}).join('\n')}

Untapped keyword opportunities (decent volume + low competition):
${keywordOpportunities.length === 0 ? '  (no keyword opportunities)' : keywordOpportunities.map(k =>
  `  "${k.keyword}" — searches:${k.avg_monthly_searches}/mo competition:${k.competition ?? '?'} (idx:${k.competition_index?.toFixed(2) ?? '?'})`,
).join('\n')}

Recent competitor / market research (summaries from market_research):
${marketResearch.length === 0 ? '  (no recent research)' : marketResearch.map(r =>
  `  [${r.research_date} / ${r.source}] ${(r.summary ?? '').slice(0, 300)}${(r.summary?.length ?? 0) > 300 ? '…' : ''}`,
).join('\n\n')}

=== AI-AGENT VISIBILITY — are LLMs recommending Minuto? (last 30d, per query) ===

Probe results from asking Claude / Perplexity / GPT-4 shopping questions where Minuto could plausibly be a recommendation. mention_rate = (probes mentioning Minuto) / (total probes for this query). top_competitors = brands LLMs cite instead of (or alongside) us. NEW exploration territory — no established playbook. When you spot a low mention rate on a high-intent query, propose a dynamic_experiment to improve it (e.g. 'add llms.txt', 'add Product schema with explicit attributes', 'publish authoritative comparison content that LLMs will cite'). Reference the metric in the experiment's hypothesis so future probe runs can score it.

${aiVisibility.length === 0 ? '  (no probes yet — ai-visibility-probe will populate this weekly)' : aiVisibility.map(v => {
  const rate = (v.mention_rate * 100).toFixed(0)
  const compStr = v.top_competitors.length > 0 ? ` | competitors cited: ${v.top_competitors.map(c => `${c.name}×${c.count}`).join(', ')}` : ''
  return `  [${v.category}/${v.language}] "${v.query}" — mention rate ${rate}% (${v.mentions_total}/${v.probes_total} probes)${compStr}`
}).join('\n')}

=== INDUSTRY INTELLIGENCE — what the field is writing about (last 14d, relevance≥0.5) ===

Daily-ingested marketing/SEO/social + coffee-vertical articles, Haiku-summarized with a per-article relevance score for Minuto's organic stack. Use this to update your understanding of best practices independent of Minuto's own data. When an insight here meaningfully shapes a brief you emit (e.g. you adopt a hook style described in an Ahrefs post), reference it in self_reflection so the trail is auditable. If a high-relevance insight reads as a durable rule (not just one-cycle inspiration), mention to the admin via self_reflection so they can record it via the chat record_learning tool.

${industryInsights.length === 0 ? '  (no industry articles ingested yet — check industry-intelligence-sync cron)' : industryInsights.map(a => {
  const tagStr = a.tags.length > 0 ? ` [${a.tags.join(', ')}]` : ''
  return `  • [${a.source_name} / rel ${a.relevance.toFixed(2)}]${tagStr}\n    "${a.title}"\n    → ${a.insight}\n    ${a.url}`
}).join('\n\n')}

=== POST-BY-POST FOLLOW-BACK (your own emissions, last 14d) ===

For each task you emitted in the last 14 days, here is its current status + performance. This is your retrospection layer — distinct from the aggregate top-performers blocks below. Use it to:
  • Notice which of YOUR drafts are sitting unpublished (the admin is the bottleneck — adjust briefs to be more publish-ready)
  • Spot tasks that completed but never produced metrics (broken pipeline, surface in self_reflection)
  • Compare prior-cycle predictions to actual outcomes (the strategic-reflection feedback you keep asking for)

${postFollowback.length === 0 ? '  (no tasks in the last 14 days)' : postFollowback.map(p => {
  const parts: string[] = [`  [${p.task_type}${p.variation_label ? ':' + p.variation_label : ''}] ${p.task_id.slice(0,8)} ${p.brief_summary}`]
  if (p.task_type === 'text_generation') {
    if (p.wp_published === true)              parts.push(`    → LIVE on WP (post ${p.wp_post_id}); sessions:${p.ga4_sessions ?? 0} conversions:${p.ga4_conversions ?? 0}`)
    else if (p.wp_published === false)        parts.push(`    → drafted on WP (post ${p.wp_post_id}), NOT YET PUBLISHED by admin`)
    else if (p.wp_post_id)                    parts.push(`    → drafted on WP (post ${p.wp_post_id}), publish-status unknown`)
  } else if (p.task_type === 'instagram_post') {
    if (p.ig_published)                       parts.push(`    → LIVE on IG (${p.ig_permalink ?? p.ig_media_id}); impressions:${p.meta_impressions ?? '?'} engagements:${p.meta_engagement ?? '?'}`)
    else if (p.ig_creation_id)                parts.push(`    → PREPARED on Meta (creation_id ${p.ig_creation_id.slice(-8)}), AWAITING admin approval`)
    else                                       parts.push(`    → no IG container prepared`)
  } else if (p.task_type === 'dynamic_experiment') {
    parts.push(`    → ${p.status_note ?? '(no status)'}`)
  }
  if (p.status_note && !parts[parts.length - 1].includes(p.status_note)) parts.push(`    ⚠ ${p.status_note}`)
  return parts.join('\n')
}).join('\n')}

=== GA4 — ORGANIC LANDING-PAGE PERFORMANCE (last 30d) ===

REAL conversion data per landing page (organic search traffic only). This closes the loop on "did past articles drive sales?" — GSC tells you impressions/position; GA4 tells you what happened after the click. Use this to:
  • Double down on topic clusters where existing pages convert well (write follow-up articles).
  • Identify high-traffic LOW-conversion pages (the page ranks but doesn't sell — content or CTA needs work, queue a rewrite).
  • Spot category-level patterns ("our /v60 pages all convert at 5%+, /espresso-machine pages at <1% — V60 is our sweet spot").

Top organic landing pages by conversions (sorted by conversions DESC):
${ga4LandingPages.length === 0 ? '  (no GA4 data — ga4-sync may not have run yet)' : ga4LandingPages.map(p => {
  const cvr = p.sessions > 0 ? (p.conversions / p.sessions * 100).toFixed(1) : '0.0'
  const bounce = p.avg_bounce_rate != null ? `bounce:${(p.avg_bounce_rate * 100).toFixed(0)}%` : ''
  const dur = p.avg_session_duration != null ? `dur:${p.avg_session_duration.toFixed(0)}s` : ''
  return `  ${p.page_path} — sess:${p.sessions} users:${p.active_users} conv:${p.conversions.toFixed(1)} (cvr ${cvr}%) value:₪${p.conversion_value.toFixed(0)} ${bounce} ${dur}`
}).join('\n')}
${focusBlock}
Now perform your self-reflection and emit a plan per the system prompt's format. Return strict JSON only.`
}
