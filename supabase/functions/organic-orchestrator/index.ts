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
import { callClaude, parseClaudeJson, MODEL_ORCHESTRATOR, isGeminiModel } from '../seo-agent/claude.ts'
import {
  createSupabase,
  insertTasks,
  insertMetrics,
  getRecentTasks,
  fetchRecentIgCaptions,
  getRecentMetricsSnapshots,
  getRecentLearnings,
  insertExperiment,
} from '../seo-agent/db.ts'
import { detectWpPublishTransitions } from '../seo-agent/wpPublishDetector.ts'
import {
  checkCannibalizationForQueue,
  buildCannibalizationConflictBrief,
  type CannibalConflict,
} from '../seo-agent/cannibalizationCheck.ts'
import { collectPostFollowback, type PostFollowback } from '../seo-agent/postPerformanceFollowback.ts'
import { writeBriefing, buildOrchestratorCycleBriefing } from '../seo-agent/briefingWriter.ts'
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
  fetchCustomerSegmentSummary,
  fetchCompetitorIntelligence,
} from '../seo-agent/services/cmsApi.ts'
import {
  fetchTopOrganicPosts,
  fetchTopConvertingAds,
} from '../seo-agent/services/metaApi.ts'
import {
  buildBrandIndex,
  screenProductList,
  screenHeroProduct,
  type BrandIndex,
} from '../seo-agent/services/brandGuard.ts'
import { getCalendarContext, renderCalendarBlock, type CalendarContext } from '../seo-agent/services/calendarContext.ts'
import {
  getActiveStoryThemeLock,
  screenStoryScene,
  renderStoryLockPolicy,
  type StoryThemeLock,
} from '../seo-agent/services/storyThemeLock.ts'
import type {
  MetricsSnapshot,
  NewSeoTask,
  OrchestratorEmittedTask,
  OrchestratorEmittedExperiment,
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

  // The full cycle (10 data sources + a ~2min strategist call + experiment
  // eval + followback + FAQ scan + briefing) exceeds the edge gateway's
  // 150s request-idle timeout. So we run it as a tracked BACKGROUND task
  // via EdgeRuntime.waitUntil and return 202 immediately. The cron
  // (pg_net) fires-and-forgets; results land in seo_tasks + seo_metrics +
  // the briefings chat session, which is where callers should look — not
  // the HTTP response body.
  const runCycle = async (): Promise<void> => {
   let phase = 'init'
   try {
    const supabase = createSupabase()

    // ── 0. Experiment evaluation moved OUT of the orchestrator's critical
    // path. The daily evaluator-tick cron (06:30 UTC) owns experiment
    // scoring — it reuses the same experimentEvaluator module and writes
    // winners into seo_learnings (created_by='orchestrator'). Running it
    // HERE too made a SECOND Claude call inside the cycle (winner synthesis)
    // and added tens of seconds racing the edge wall-clock — a prime reason
    // full cycles weren't completing. The strategist still inherits recent
    // winners via the STANDING LEARNINGS fetch below (daily ticks keep it
    // current). Zeroed summary preserves the briefing/log shape.
    const experimentEvalSummary = {
      evaluated: 0,
      inconclusive: 0,
      winners: [] as Array<{ experiment_id: string; winner_label: string; learning_id: string }>,
      skipped: [] as Array<{ experiment_id: string; reason: string }>,
    }

    // ── 1. Gather EVERYTHING in one parallel batch ────────────────────
    // Previously WP-publish detection (0a) + per-post follow-back (0c) ran
    // SEQUENTIALLY before the data fetch — ~3 min of pre-Claude work that
    // raced the edge wall-clock. Neither feeds the data fetch, so they now
    // run concurrently with the 18 data sources: total pre-Claude time
    // collapses to the slowest single operation. The two external-API calls
    // are .catch-guarded so one failure can't reject the whole batch. WP
    // detector scope tightened 60→25 (its only job is the wp_published
    // side-effect; bounding it caps worst-case latency).
    console.log('[organic-orchestrator] gathering all sources + housekeeping in parallel…')
    phase = 'gather'
    const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString()
    const sixtyDaysAgo    = new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString()

    const [
      wpDetectorSummary,
      postFollowback,
      gscKeywords,
      blogPosts,
      catalog,
      inventoryAlerts,
      recentTasks,
      recentIgCaptions,
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
      customerSegments,
      competitorIntel,
      calendar,
      storyLock,
    ] = await Promise.all([
      // Housekeeping (side-effecting / strategist-input) — guarded so a
      // single failure degrades gracefully instead of killing the cycle.
      detectWpPublishTransitions(supabase, 25).catch((e: any) => {
        console.error(`[organic-orchestrator] WP detector failed (non-fatal): ${e?.message ?? e}`)
        return { checked: 0, newly_live: 0, still_draft: 0, errors: [{ task_id: '-', error: e?.message ?? String(e) }] }
      }),
      collectPostFollowback(supabase, 14).catch((e: any) => {
        console.error(`[organic-orchestrator] follow-back failed (non-fatal): ${e?.message ?? e}`)
        return [] as PostFollowback[]
      }),
      fetchTopKeywords(supabase, 30, 30),
      fetchRecentBlogPosts(supabase, sixtyDaysAgo, 100),
      fetchActiveCatalog(supabase),
      fetchInventoryAlerts(supabase),
      getRecentTasks(supabase, fourteenDaysAgo, 100),
      // Last 20 IG captions we actually shipped — the strategist's
      // anti-repetition reference so it stops reusing the same openers /
      // hooks / themes. Not time-boxed (see fetchRecentIgCaptions).
      fetchRecentIgCaptions(supabase, 20),
      getRecentMetricsSnapshots(supabase, 'orchestrator_run', 2),
      // Cross-session learnings — scopes most relevant to strategist planning.
      // Excludes brand_voice (the writer worker enforces those via its own
      // prompt) and qa_pattern (the visual worker handles those internally).
      // Limit was 30 while 31 active learnings existed in these scopes, so the
      // oldest was being silently dropped every cycle — and the two
      // green-coffee rules sat at positions 26 and 30, two new learnings away
      // from falling off the edge entirely. 120 leaves real headroom; the
      // cheap fix for volume is superseding stale rows, not truncating live
      // ones without telling anyone.
      getRecentLearnings(supabase, {
        scopes: ['visual_style', 'render_strategy', 'content_topic', 'other'],
        limit: 120,
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
      // weekly by ai-visibility-probe.
      fetchAiVisibilitySummary(supabase, 30),
      // Customer segment structure from RFM table — strategist sees
      // audience composition, not individual customers.
      fetchCustomerSegmentSummary(supabase),
      // Competitor intelligence — aggregated from existing tables (LLM
      // probe co-mentions + market_research scans). No new scrapers.
      fetchCompetitorIntelligence(supabase, 30),
      // Where we are in the year. Until 2026-09-23 the strategist was never
      // told the date, so "take season and holidays into account" was not
      // something it was declining to do — it had no calendar to do it with.
      // Fails open to date+season if the holiday API is unreachable.
      getCalendarContext(),
      // The orchestrator queues story visuals too (run aa0f58a7 did on
      // 2026-09-23), so the story theme lock has to bind here as well — not
      // only in mission-worker's daily cadence.
      getActiveStoryThemeLock(supabase, new Date().toISOString().slice(0, 10))
        .catch((e: any) => { console.warn(`[organic-orchestrator] story lock fetch failed: ${e?.message ?? e}`); return null }),
    ])

    console.log(
      `[organic-orchestrator] sources — gsc:${gscKeywords.length} ` +
      `blog:${blogPosts.length} catalog:${catalog.length} ` +
      `inv:${inventoryAlerts.length} recentTasks:${recentTasks.length} ` +
      `igCaptions:${recentIgCaptions.length} ` +
      `priorSnapshots:${priorSnapshots.length} learnings:${learnings.length} ` +
      `paidKw:${paidKeywords.length} searchTerms:${searchTerms.length} ` +
      `organicPosts:${organicPosts.length} paidAds:${paidAds.length} ` +
      `voc:${vocInsights.length} kwOps:${keywordOpportunities.length} ` +
      `research:${marketResearch.length} ga4Pages:${ga4LandingPages.length} ` +
      `wpDetector(newly_live:${wpDetectorSummary.newly_live}) followback:${postFollowback.length}`,
    )

    // ── 2. Snapshot fresh metrics ─────────────────────────────────────
    phase = 'snapshot'
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
    // One classifier for the whole cycle: it shapes the catalog the
    // strategist sees, and the same instance screens the plan it returns.
    const brandIndex = buildBrandIndex(catalog.map(p => ({ name: p.name, categories: p.categories ?? null })))

    const userMessage = buildStrategistUserMessage({
      focus,
      snapshot,
      recentTasks,
      recentIgCaptions,
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
      customerSegments,
      competitorIntel,
      postFollowback,
      calendar,
      brandIndex,
      storyLock,
    })

    // ── 3b. SERP REALITY CHECK (Gemini only) ─────────────────────────
    // The planner has always chosen keywords from OUR OWN history — GSC
    // impressions, past posts, keyword_ideas volumes. It has never looked at
    // what actually ranks for a keyword before committing an article to it, so
    // it can happily target a query owned by Wikipedia or a national retailer
    // and lose before writing a word.
    //
    // Gemini can ground on Google's live index, which is the one index that
    // matters here. This runs it as an ISOLATED phase and folds the findings
    // into the planning prompt as plain text.
    //
    // WHY A SEPARATE CALL rather than grounding the planning call itself: the
    // planner must return STRICT JSON for parseClaudeJson. Grounded replies come
    // back as prose with citations, so grounding the planning call would break
    // the parse and the cycle would emit NOTHING — silently, which is the
    // failure mode this codebase keeps getting bitten by. seo-worker-research
    // already uses this same isolate-then-synthesise shape.
    //
    // Best-effort throughout: any failure logs and leaves the block empty, so
    // the planner degrades to exactly its previous behaviour.
    let serpBlock = ''
    if (isGeminiModel(MODEL_ORCHESTRATOR) && keywordOpportunities.length > 0) {
      phase = 'serp_grounding'
      const candidates = keywordOpportunities.slice(0, 6).map(k => k.keyword)
      try {
        const serp = await callClaude({
          sourceFn: 'organic-orchestrator',
          model:    MODEL_ORCHESTRATOR,
          system:   'You are an SEO analyst checking live Hebrew/Israeli search results. '
                  + 'Be terse and factual. Never speculate about rankings you did not see.',
          messages: [{ role: 'user', content:
            'For each Hebrew keyword below, search Google and report what ACTUALLY ranks in Israel today.\n\n'
            + candidates.map((k, i) => `${i + 1}. ${k}`).join('\n')
            + '\n\nFor each, give ONE line:\n'
            + '  keyword — who owns the top results (retailer / publisher / forum / brand), '
            + "and whether a specialty roastery's blog post could realistically compete.\n\n"
            + 'Mark a keyword WINNABLE only if the top results are thin, dated, or not already '
            + 'a large retailer or encyclopedia. Say NOT WINNABLE plainly when it is not — '
            + 'that is more useful than optimism.' }],
          googleSearch: true,
          maxTokens:    2000,
          timeoutMs:    60_000,
        })
        if (serp.text.trim()) {
          serpBlock = '\n\n=== LIVE SERP CHECK (Google, today — grounded) ===\n'
                    + 'What actually ranks for your top keyword candidates. Prefer WINNABLE ones; '
                    + 'do NOT queue an article for a keyword marked NOT WINNABLE.\n'
                    + serp.text.trim()
                    + (serp.groundingSources?.length
                        ? `\nSources: ${serp.groundingSources.slice(0, 6).map(x => x.url).join(' ')}`
                        : '')
          console.log(`[organic-orchestrator] SERP check: ${serp.text.length} chars, `
                    + `${serp.groundingSources?.length ?? 0} sources`)
        }
      } catch (e: any) {
        console.warn(`[organic-orchestrator] SERP check failed (non-fatal, planning continues): ${e?.message ?? e}`)
      }
    }
    // ── 4. Call Claude ───────────────────────────────────────────────
    console.log(`[organic-orchestrator] calling ${MODEL_ORCHESTRATOR}…`)
    phase = 'strategist_claude'
    const claudeRes = await callClaude({
      sourceFn: 'organic-orchestrator',
      model:    MODEL_ORCHESTRATOR,
      system:   STRATEGIST_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage + serpBlock }],
      // maxTokens 7000: the strategist prompt now caps the plan at ~3500
      // output tokens (OUTPUT BUDGET section), so 7000 is 2× headroom — a
      // compact plan completes WITHOUT truncating, and ~3500-4500 tokens
      // generates in ~80-110s, comfortably under the 150s wall-clock. (A
      // bare 6000 cap truncated a too-large plan in run 7c94f062; the real
      // fix was bounding the plan size in the prompt, not the cap.)
      maxTokens:  7000,
      temperature: 0.7,  // balanced — needs creativity but also structure
      // CRITICAL: keep this BELOW the platform's hard wall-clock cap. At
      // 200s the isolate was being killed mid-call before this
      // AbortController could fire, so NO catch ran and failures were
      // invisible (no tasks, no briefing). 150s lets the call abort
      // GRACEFULLY (→ crash briefing names phase='strategist_claude') and,
      // with gather now ~1s, leaves room to actually finish.
      timeoutMs: 150_000,
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
      experiments?:     OrchestratorEmittedExperiment[]
    }
    phase = 'parse_plan'
    try {
      plan = parseClaudeJson(claudeRes.text)
    } catch (e: any) {
      console.error(`[organic-orchestrator] run=${runId} failed to parse strategist output:`, e?.message)
      console.error('[organic-orchestrator] raw text:', claudeRes.text.slice(0, 1000))
      // Background task — can't return an HTTP error (we already 202'd).
      // Surface it to the briefings thread so the failure is VISIBLE
      // (not just a console log we can't read), then abort the cycle.
      try {
        await writeBriefing(supabase, {
          subtype: 'health_alert',
          title:   `Orchestrator run ${runId.slice(0, 8)} failed: unparseable strategist output`,
          body:    `The strategist returned ${claudeRes.outputTokens} output tokens but the JSON did not parse (likely truncated at maxTokens or wrapped in prose).\n\nParse error: ${e?.message ?? e}\n\nFirst 600 chars of raw output:\n${claudeRes.text.slice(0, 600)}`,
          context: { orchestrator_run_id: runId, phase: 'parse_plan', output_tokens: claudeRes.outputTokens },
        })
      } catch { /* best-effort */ }
      return
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

    // ── 5b. CANNIBALIZATION GATE (text_generation only) ────────────────
    // ONE mechanism, TWO detection sources.
    //
    // Production and git had grown SEPARATE solutions to this. Prod dropped
    // colliding tasks — which forced cascade-dropping their dependents and
    // remapping every positional parent/depends index. Git converted the task
    // in place. Unified here on convert-in-place: it leaves the array's length
    // and order untouched, so ~50 lines of index bookkeeping that existed only
    // to compensate for removing items mid-array are simply not needed.
    //
    // Neither detection source subsumes the other, so both run:
    //   • WP (checkCannibalizationForQueue) sees anything published or drafted
    //     on the site, including posts far older than our task table.
    //   • The local pass sees what WP cannot — two articles colliding inside
    //     THIS plan, and articles already queued in seo_tasks but not yet
    //     written. Neither exists on WP yet, so WP cannot object to them.
    //
    // On a conflict the task BECOMES a dynamic_experiment
    // (cannibalization_conflict, approval_required), landing in the admin's
    // pending-approvals queue rather than vanishing from the plan silently.
    phase = 'cannibalization_gate'
    let cannibalConflictsFiled = 0

    const normKw   = (s: unknown) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
    const briefStr = (b: unknown, k: string) =>
      String((b as Record<string, unknown> | null)?.[k] ?? '').trim()

    const fileConflict = (
      et: (typeof emittedTasks)[number],
      keyword: string,
      title: string,
      conflicts: CannibalConflict[],
      why: string,
    ) => {
      et.task_type    = 'dynamic_experiment'
      et.task_subtype = 'cannibalization_conflict'
      et.brief_data   = buildCannibalizationConflictBrief({ keyword, title, conflicts })
      et.rationale    = `[cannibalization-gate] did NOT queue "${keyword}" — ${why}`
      // Strip experiment tagging — a conflict proposal is not an A/B variation.
      delete et.experiment_group
      delete et.variation_label
      cannibalConflictsFiled++
      console.warn(`[organic-orchestrator] cannibalization: "${keyword}" — ${why}`)
    }

    // Pass 1 — local, no network. In-plan duplicates and already-queued blog
    // tasks (recentTasks spans pending/completed/failed, so in-flight drafts
    // count). Runs first so pass 2 never spends a WP call on a task already
    // resolved here.
    const queuedTitleByKw = new Map<string, string>()
    for (const t of recentTasks) {
      if (t.task_type !== 'text_generation') continue
      const kw = normKw(briefStr(t.brief_data, 'keyword'))
      if (kw) queuedTitleByKw.set(kw, briefStr(t.brief_data, 'title') || kw)
    }
    const seenKw = new Set<string>()
    for (const et of emittedTasks) {
      if (et.task_type !== 'text_generation') continue
      const raw = briefStr(et.brief_data, 'keyword')
      const kw  = normKw(raw)
      if (!kw) continue                                   // no keyword to dedup on
      const title = briefStr(et.brief_data, 'title')
      if (seenKw.has(kw)) {
        fileConflict(et, raw, title,
          [{ id: 0, title: 'another article in this same plan', status: 'in_plan', link: '' }],
          'a second article on this keyword in the same plan')
        continue
      }
      const queued = queuedTitleByKw.get(kw)
      if (queued !== undefined) {
        fileConflict(et, raw, title,
          [{ id: 0, title: queued, status: 'queued (not yet published)', link: '' }],
          'already queued as a blog task')
        continue
      }
      seenKw.add(kw)
    }

    // Pass 2 — WP. Only tasks that survived pass 1 are still text_generation.
    // Fails open per task: a WP outage must never block the whole plan.
    await Promise.all(emittedTasks.map(async (et) => {
      if (et.task_type !== 'text_generation') return
      const keyword = briefStr(et.brief_data, 'keyword')
      const title   = briefStr(et.brief_data, 'title')
      if (!keyword) return
      let gate
      try { gate = await checkCannibalizationForQueue(keyword, title) }
      catch (e: any) {
        console.warn(`[organic-orchestrator] cannibalization check threw for "${keyword}" (fail-open): ${e?.message ?? e}`)
        return
      }
      if (gate.checked && gate.conflicts.length > 0) {
        fileConflict(et, keyword, title, gate.conflicts, `${gate.conflicts.length} existing post(s) overlap`)
      }
    }))

    if (cannibalConflictsFiled > 0) {
      console.log(`[organic-orchestrator] cannibalization gate: ${cannibalConflictsFiled} task(s) converted to conflict proposals`)
    }

    // ── 5b. BRAND GUARD ──────────────────────────────────────────────
    // The plan is screened before anything is inserted. Two outcomes, chosen
    // to match how recoverable the violation is:
    //
    //   • products_to_mention → SCRUBBED in place. An article that named a
    //     green 1kg sack is still a perfectly good article without it, so the
    //     offending entries are dropped and the task ships. (2026-09-20 shows
    //     why this matters: that brief carried two green SKUs and the article
    //     completed.)
    //   • a banned bag_hero product_name → the task CANNOT be repaired, since
    //     the scene_brief names the bag in prose. It becomes a
    //     dynamic_experiment (brand_guard_block) so the block is visible in
    //     the admin UI instead of vanishing, with approval_required false —
    //     it is a record, not a decision anyone needs to make.
    //
    // Converting in place rather than removing keeps parent_task_index /
    // depends_on_index valid, same reasoning as the cannibalization gate.
    phase = 'brand_guard'
    let brandScrubbed = 0
    let brandBlocked  = 0

    for (const et of emittedTasks) {
      const brief = (et.brief_data ?? {}) as Record<string, unknown>

      // 1. products_to_mention — scrub.
      if (Array.isArray(brief.products_to_mention)) {
        const { kept, dropped } = screenProductList(brief.products_to_mention, brandIndex)
        if (dropped.length > 0) {
          brief.products_to_mention = kept
          brandScrubbed++
          const why = dropped.map(d => `"${d.name}" (${d.why})`).join('; ')
          et.rationale = `${et.rationale ?? ''}\n[brand-guard] dropped ${dropped.length} product(s): ${why}`.trim()
          console.warn(`[organic-orchestrator] brand-guard scrubbed ${dropped.length} product(s) from a ${et.task_type} brief: ${why}`)
        }
      }

      // 2. Story theme lock. Applies to story visuals the STRATEGIST plans;
      // mission-worker screens its own daily story separately. Blocking one
      // here costs nothing: the daily story is mission-worker's standing
      // deliverable and still gets queued on its next tick.
      if (storyLock && et.task_type === 'visual_generation') {
        const aspect = String(brief.aspect ?? '').toLowerCase()
        if (aspect === 'story') {
          const verdict = screenStoryScene(brief.scene_brief, storyLock)
          if (!verdict.ok) {
            et.task_type    = 'dynamic_experiment'
            et.task_subtype = 'story_theme_block'
            et.brief_data   = {
              description:
                `Story theme lock blocked a story visual — ${verdict.why}. ` +
                `Allowed subjects until ${storyLock.until}: ${storyLock.themes.join(', ')}. ` +
                `The daily story is mission-worker's standing deliverable and is unaffected; ` +
                `this only drops an off-theme story the strategist proposed.`,
              approval_required: false,
              details: {
                conflict_subtype: 'story_theme_block',
                lock_until:       storyLock.until,
                lock_themes:      storyLock.themes,
                original_brief:   brief,
              },
            }
            et.rationale = `[story-theme-lock] did NOT queue — ${verdict.why}`
            delete et.experiment_group
            delete et.variation_label
            brandBlocked++
            console.warn(`[organic-orchestrator] story theme lock blocked a scene: ${verdict.why}`)
            continue
          }
        }
      }

      // 3. bag_hero product_name — block.
      const heroVerdict = screenHeroProduct(brief.product_name, brandIndex)
      if (!heroVerdict.ok) {
        const blockedName = String(brief.product_name ?? '')
        const original    = { task_type: et.task_type, brief }
        et.task_type    = 'dynamic_experiment'
        et.task_subtype = 'brand_guard_block'
        et.brief_data   = {
          description:
            `Brand guard blocked a ${original.task_type} task — ${heroVerdict.why}. ` +
            `The scene named this product as the hero, so the brief could not be repaired automatically ` +
            `(the bag is described in the scene prose too). Nothing was rendered. ` +
            `If this product genuinely should be featured, fix its classification in WooCommerce ` +
            `or lift the rule, then re-plan.`,
          approval_required: false,
          details: {
            conflict_subtype: 'brand_guard_block',
            blocked_product:  blockedName,
            verdict:          heroVerdict.verdict,
            original_task_type: original.task_type,
            original_brief:     original.brief,
          },
        }
        et.rationale = `[brand-guard] did NOT queue — ${heroVerdict.why}`
        delete et.experiment_group
        delete et.variation_label
        brandBlocked++
        console.warn(`[organic-orchestrator] brand-guard BLOCKED "${blockedName}": ${heroVerdict.why}`)
      }
    }

    if (brandScrubbed > 0 || brandBlocked > 0) {
      console.log(`[organic-orchestrator] brand guard: ${brandScrubbed} brief(s) scrubbed, ${brandBlocked} task(s) blocked`)
    }

    // ── 6a. Materialize experiments. Each experiment_group string from
    // the strategist becomes one seo_experiments row; the row's UUID is
    // then stamped onto every task that referenced the same group.
    phase = 'emit_tasks'
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

    // Per-task emit record, so a "nothing was produced this cycle" run is
    // visible at a glance instead of showing only a bare count. Restored after
    // a deploy from git silently dropped it — it had been live in production
    // and never committed.
    //
    // Simpler than the version it replaces: convert-in-place keeps
    // emittedTasks[i] aligned with insertedRows[i], so this needs no dropped-
    // index bookkeeping. A task that became a cannibalization_conflict is still
    // inserted — as a proposal — so it shows as 'inserted', which is accurate.
    const emitLog = emittedTasks.map((et, i) => ({
      task_type: et.task_type,
      outcome:   (insertedRows[i] ? 'inserted' : 'dropped') as 'inserted' | 'dropped',
      task_id:   insertedRows[i]?.id ?? null,
    }))
    console.log(`[organic-orchestrator] task emit log (${insertedRows.length} inserted of ${emittedTasks.length} planned): ${JSON.stringify(emitLog)}`)

    // ── 6b-FAQ. Identify ranking blog articles missing FAQ → queue proposals ─
    // Deterministic technical-SEO scan (NOT routed through the strategist
    // LLM — pure data). Top organic blog landing pages from GA4 that don't
    // already have a recent technical_seo task get a faq_injection task.
    // seo-worker-techseo authors a Hebrew FAQ proposal (and itself skips
    // articles that already carry FAQ schema); the admin approves each via
    // approve_post_faq before anything writes live. Best-effort.
    let faqCandidatesQueued = 0
    try {
      const WP_URL = (Deno.env.get('WOO_URL') ?? 'https://www.minuto.co.il').replace(/\/+$/, '')
      const sinceDate = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().split('T')[0]
      const { data: ga4Rows } = await supabase
        .from('ga4_pages_daily')
        .select('page_path, sessions')
        .eq('channel_group', 'Organic Search')
        .gte('date', sinceDate)
        .like('page_path', '/blog/%')
        .limit(2000)
      const sessionsByPath = new Map<string, number>()
      for (const r of (ga4Rows ?? []) as Array<{ page_path: string; sessions: number | null }>) {
        sessionsByPath.set(r.page_path, (sessionsByPath.get(r.page_path) ?? 0) + (r.sessions ?? 0))
      }
      const topPaths = Array.from(sessionsByPath.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5)

      // Avoid re-queuing: collect technical_seo targets from the last 30d.
      const { data: existingFaqTasks } = await supabase
        .from('seo_tasks')
        .select('brief_data')
        .eq('task_type', 'technical_seo')
        .gte('created_at', new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString())
        .limit(500)
      const norm = (u: string) => u.replace(/\/+$/, '')
      const existingTargets = new Set(
        (existingFaqTasks ?? []).map((t: any) => norm(String(t.brief_data?.target_post_url ?? ''))),
      )

      const faqTasks: NewSeoTask[] = []
      for (const [path, sessions] of topPaths) {
        const url = norm(`${WP_URL}${path}`)
        if (!url || existingTargets.has(url)) continue
        faqTasks.push({
          task_type:           'technical_seo',
          brief_data:          {
            subtype:          'faq_injection',
            target_post_url:  url + '/',
            rationale_signal: { ga4_organic_sessions_30d: sessions },
          },
          rationale:           `[faq-gap-scan] top organic blog page (${sessions} sessions/30d) — propose FAQ schema`,
          orchestrator_run_id: runId,
        })
      }
      if (faqTasks.length > 0) {
        const insertedFaq = await insertTasks(supabase, faqTasks)
        faqCandidatesQueued = insertedFaq.length
      }
      console.log(`[organic-orchestrator] faq-gap-scan queued ${faqCandidatesQueued} technical_seo task(s)`)
    } catch (e: any) {
      console.warn(`[organic-orchestrator] faq-gap-scan failed (non-fatal): ${e?.message ?? e}`)
    }

    // ── 6d. CHANNEL & TACTIC EXPLORER (weekly) ────────────────────────
    // Once a week, queue a deep_research task whose whole job is to hunt
    // for NEW ways to grow OUTSIDE the current blog+IG playbook — emerging
    // platforms, communities, earned media, partnerships, GEO plays, etc.
    // The research worker (already cron-drained) investigates via web
    // search and drops a briefing of fresh, testable ideas for the admin
    // to greenlight. The agent generates the ideas; acting on them stays
    // gated. Gated to Sunday (orchestrator runs Sun+Wed → this fires once
    // a week), with a 6-day dedup guard as belt-and-suspenders. Best-effort.
    let channelExplorerQueued = false
    try {
      if (new Date().getUTCDay() === 0) {  // Sunday
        const sixDaysAgo = new Date(Date.now() - 6 * 24 * 3600 * 1000).toISOString()
        const { data: recentExplorer } = await supabase
          .from('seo_tasks')
          .select('id, brief_data')
          .eq('task_type', 'deep_research')
          .gte('created_at', sixDaysAgo)
          .limit(50)
        const alreadyQueued = (recentExplorer ?? []).some(
          (t: any) => (t.brief_data?.scope) === 'channel_discovery',
        )
        if (!alreadyQueued) {
          await insertTasks(supabase, [{
            task_type:           'deep_research',
            brief_data:          {
              question:        'What are the highest-potential ways for Minuto — a boutique Israeli specialty-coffee roaster currently doing ONLY WP blog SEO + Instagram — to grow that we are NOT using yet? Surface concrete, testable channel / format / community / tactic ideas beyond blog+IG, sized for a boutique budget.',
              scope:           'channel_discovery',
              expected_output: 'recommendations',
              max_research_turns: 5,
            },
            rationale:           '[channel-explorer] weekly hunt for new growth channels/tactics beyond blog+IG',
            orchestrator_run_id: runId,
          }])
          channelExplorerQueued = true
        }
      }
      console.log(`[organic-orchestrator] channel-explorer queued: ${channelExplorerQueued}`)
    } catch (e: any) {
      console.warn(`[organic-orchestrator] channel-explorer queue failed (non-fatal): ${e?.message ?? e}`)
    }

    // ── 6c. Write proactive briefing for admin ───────────────────────
    // Captures what happened this cycle into a chat_messages row the
    // admin will see when they open the dashboard. Best-effort; doesn't
    // fail the cycle if briefing write errors.
    try {
      await writeBriefing(supabase, buildOrchestratorCycleBriefing({
        runId,
        summary:              plan.summary ?? '',
        selfReflection:       plan.self_reflection ?? [],
        experimentsEmitted:   experimentIdByGroup.size,
        experimentsEvaluated: experimentEvalSummary,
        tasksEmitted:         insertedRows.length,
        taskIds:              insertedRows.map(r => r.id),
        emitLog,
      }))
    } catch (e: any) {
      console.warn(`[organic-orchestrator] briefing write failed (non-fatal): ${e?.message ?? e}`)
    }

    // ── 7. Done — log the summary (no HTTP return; we already 202'd). ─
    console.log('[organic-orchestrator] cycle complete: ' + JSON.stringify({
      run_id:                runId,
      snapshot_id:           snapshotId,
      summary:               (plan.summary ?? '').slice(0, 300),
      experiments_evaluated: experimentEvalSummary,
      experiments_emitted:   experimentIdByGroup.size,
      tasks_emitted:         insertedRows.length,
      faq_candidates_queued: faqCandidatesQueued,
      tokens: {
        input:  claudeRes.inputTokens,
        output: claudeRes.outputTokens,
        cache_read: claudeRes.cacheReadTokens,
      },
    }))
   } catch (e: any) {
    console.error(`[organic-orchestrator] run=${runId} failed at phase=${phase}:`, e?.message ?? e)
    console.error(e?.stack ?? '')
    // Surface the failure (with the phase it died in) to the briefings
    // thread — the catch can't see `supabase` (declared in the try), so
    // make a fresh client. Best-effort; never throws out of the catch.
    try {
      const sb = createSupabase()
      await writeBriefing(sb, {
        subtype: 'health_alert',
        title:   `Orchestrator run ${runId.slice(0, 8)} crashed in phase '${phase}'`,
        body:    `The cycle threw before completing.\n\nPhase: ${phase}\nError: ${e?.message ?? String(e)}\n\nStack (truncated):\n${(e?.stack ?? '').slice(0, 800)}`,
        context: { orchestrator_run_id: runId, phase, error: e?.message ?? String(e) },
      })
    } catch (be: any) {
      console.error(`[organic-orchestrator] failed to write crash briefing: ${be?.message ?? be}`)
    }
   }
  }   // ── end runCycle ──

  // Kick off the cycle in the background and return immediately so the
  // edge gateway's 150s idle timeout never fires. waitUntil keeps the
  // isolate alive until runCycle settles.
  // @ts-ignore — EdgeRuntime is injected by the Supabase edge runtime.
  if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime?.waitUntil) {
    // @ts-ignore
    EdgeRuntime.waitUntil(runCycle())
  } else {
    runCycle()  // local/dev fallback (no EdgeRuntime)
  }
  return jsonResponse({
    accepted: true,
    run_id:   runId,
    trigger,
    note:     'orchestrator running in background; results land in seo_tasks + seo_metrics + the briefings chat session',
  }, 202)
})

// ── User-message construction ──────────────────────────────────────────
// Kept in this file (not in seo-agent/) so iterating on the orchestrator
// doesn't require touching the shared module. If this grows past ~100
// lines, move to seo-agent/orchestrator_user_message.ts.

function buildStrategistUserMessage(args: {
  focus:           string
  snapshot:        MetricsSnapshot
  recentTasks:     SeoTaskRow[]
  recentIgCaptions: Array<{ created_at: string; caption_he: string }>
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
  customerSegments: { total_customers: number; by_segment: Array<{ segment: string; count: number; avg_total_spent_ils: number; avg_order_count: number; avg_days_since_last: number }>; new_in_last_30d: number; at_risk_count: number }
  competitorIntel:  { llm_co_mentions: Array<{ name: string; mention_count_30d: number; queries_appearing_in: number }>; recent_research: Array<{ source: string; research_date: string; summary_excerpt: string }> }
  postFollowback:  PostFollowback[]
  calendar:        CalendarContext
  brandIndex:      BrandIndex
  storyLock:       StoryThemeLock | null
}): string {
  const { focus, snapshot, recentTasks, recentIgCaptions, blogPosts, catalog, inventoryAlerts, learnings,
          paidKeywords, searchTerms, organicPosts, paidAds, vocInsights, keywordOpportunities, marketResearch,
          ga4LandingPages, industryInsights, aiVisibility, customerSegments, competitorIntel, postFollowback,
          calendar, brandIndex, storyLock } = args

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
  //
  // Banned SKUs are removed BEFORE the slice, not merely forbidden in prose.
  // This list is the candidate set: while Veneto and the green 1kg sacks were
  // in it, the strategist picked them (2026-09-09 → 09-23, six times), because
  // a catalog that says "use EXACT names from this list" reads as permission.
  // Equipment stays — a grinder or a machine is a perfectly good thing to link
  // from an article, and nothing here narrows the catalog to coffee only.
  const catalogVisible = catalog.filter(p => !brandIndex.isBanned(p.name))

  // THE WINDOW BUG. This was `catalogVisible.slice(0, 50)` on a name-ordered
  // catalogue of 1,231 products, which is how the strategist came to spend
  // months unable to see a single Minuto roast:
  //
  //   position   6 — 1 ק״ג פולי קפה Veneto Delux
  //   position   7 — 1 ק״ג פולי קפה Veneto Premium
  //   positions 1-3 — three Toddy cold-brew SKUs (they start with " and ( )
  //   positions 4-50 — granita ice-coffee powder, descaling tablets, cleaning sachets
  //   position 917 — the FIRST Minuto roasted coffee
  //
  // So "it keeps featuring Veneto" was not the model ignoring a rule. Veneto
  // was the only roasted coffee inside its candidate set, sitting at #6, while
  // all 24 of our own roasts sat ~900 rows past the cut. Removing Veneto in the
  // brand guard fixed the wrong half of that: on the 2026-09-23 cycle the
  // strategist, left with no coffee at all, picked five Toddy filter SKUs for
  // an article about digital scales.
  //
  // Minuto's own roasts now go in unconditionally and in full — 24 rows, the
  // thing the entire content operation exists to sell. Equipment follows as a
  // bounded, in-stock sample, and the count of what was omitted is stated so
  // the strategist knows the equipment list is partial rather than complete.
  const EQUIPMENT_SHOWN = 60
  const roastRows = catalogVisible.filter(p => brandIndex.classify(p.name) === 'minuto_roast')
  const otherRows = catalogVisible.filter(p => brandIndex.classify(p.name) !== 'minuto_roast')
  // Out-of-stock gear should not be promoted in the first place, so it is the
  // natural thing to drop when the list has to be bounded.
  const otherInStock = otherRows.filter(p => (p.stock_status ?? 'instock') === 'instock')
  const otherShown   = otherInStock.slice(0, EQUIPMENT_SHOWN)

  const renderRow = (p: { name: string; price: number | null; stock_status: string | null }) => {
    const stock = p.stock_status && p.stock_status !== 'instock' ? ` [${p.stock_status}]` : ''
    const price = p.price ? ` ₪${p.price}` : ''
    // Toddy is brewing gear Minuto resells. Allowed as a subject and as a
    // link, but only alongside one of our roasts ("which Minuto coffee to
    // brew in your Toddy"), never as the sole product. Enforced in the
    // brand-guard gate; flagged here so the plan arrives correct.
    const pairing = brandIndex.classify(p.name) === 'paired_equipment'
      ? '  ⚠️ resold gear — only valid alongside a Minuto roast, never as the sole product'
      : ''
    return `  • ${p.name}${price}${stock}${pairing}`
  }

  const catalogBlock = catalogVisible.length === 0
    ? '  (catalog empty)'
    : [
        `MINUTO'S OWN ROASTED COFFEE — all ${roastRows.length}, the only coffees valid as a hero or a featured bean:`,
        roastRows.length ? roastRows.map(renderRow).join('\n') : '  (none resolved this cycle — do NOT substitute a reseller bean; ship the piece without a coffee)',
        '',
        `EQUIPMENT & ACCESSORIES — ${otherShown.length} of ${otherInStock.length} in stock (partial list; fine to link from an article, never a coffee substitute):`,
        otherShown.map(renderRow).join('\n'),
      ].join('\n')

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
        // Dated, newest first within each scope. The block used to print the
        // insight alone, which made conflicting rules unresolvable: a
        // 2026-07-23 learning asking for siphon/V60/French press variety in
        // the story rotation sat beside a 2026-09-17 learning banning exactly
        // those, and nothing on the page said which came later.
        const grouped: Record<string, string[]> = {}
        for (const l of [...learnings].sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))) {
          const k = l.scope || 'other'
          if (!grouped[k]) grouped[k] = []
          grouped[k].push(`  • [${(l.created_at ?? '').slice(0, 10)}] ${l.insight}`)
        }
        return Object.entries(grouped)
          .map(([scope, lines]) => `${scope}:\n${lines.join('\n')}`)
          .join('\n\n')
      })()

  // An active story theme lock goes near the TOP, not buried among the
  // learnings. It is a hard constraint enforced at queue time, so a plan that
  // ignores it simply loses those tasks.
  const storyLockBlock = storyLock
    ? `=== DAILY STORY THEME LOCK — ACTIVE ===\n\n${renderStoryLockPolicy(storyLock)}\n`
    : ''

  return `${renderCalendarBlock(calendar)}

${storyLockBlock}=== CURRENT CYCLE METRICS ===

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

=== PRODUCT CATALOG (for products_to_mention picking; use EXACT names, copied character for character) ===

Two sections. The roasts are the complete list; the equipment is a sample. If an article is about gear, still anchor it to a coffee from the first section — an article that links equipment and no coffee sells someone else's product for us.

${catalogBlock}

=== STANDING LEARNINGS (cross-session memory — apply unless explicitly contradicted by this cycle's data) ===

These are durable rules surfaced by the admin via chat (or written by earlier strategist runs). Treat them as constraints on your plan: every brief you emit should respect them, and your self_reflection should explicitly note when a learning shaped your choices.

Every line is dated and listed newest first. When two learnings contradict each other, THE NEWER ONE WINS — the admin's latest word supersedes an older preference, and you should say so in self_reflection rather than silently splitting the difference.

Note on products: a separate brand guard removes off-brand SKUs from the catalog above and screens every brief you emit. Do not treat that as a topic restriction — it gates which PRODUCTS may be featured or linked, never which SUBJECTS you may cover. Any brew method, any seasonal angle, any holiday tie-in remains yours to choose.

${learningsBlock}

=== GOOGLE ADS — PAID-INTENT SIGNALS (last 30d) ===

Per-keyword + per-search-term Google Ads totals, last 30d. Paid keywords + actual search-term reports with conversion counts and cost-per-conversion. Top converting paid keywords (by conversions):
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

=== RECENTLY SHIPPED IG CAPTIONS — DO NOT REPEAT THESE OPENERS / HOOKS / THEMES ===

The last ${recentIgCaptions.length} Instagram captions you actually published (newest first) — these are captions YOU wrote in earlier cycles. Before writing any new caption_he, read these and deliberately pick a DIFFERENT opening line, hook structure, framing angle, and theme. Repeating an opener or angle already in this list is a failure. Fresh angle every post.
${recentIgCaptions.length === 0 ? '  (no shipped IG captions yet)' : recentIgCaptions.map(c => {
  const when   = c.created_at ? c.created_at.split('T')[0] : ''
  const opener = c.caption_he.split('\n')[0].trim().slice(0, 120)
  const body   = c.caption_he.replace(/\s+/g, ' ').slice(0, 300)
  return `  • [${when}] opener: "${opener}"\n    ${body}${c.caption_he.length > 300 ? '…' : ''}`
}).join('\n\n')}

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

Per-query Minuto mention rate from LLM shopping probes. mention_rate = (probes mentioning Minuto) / (total probes). top_competitors = brands LLMs cited in the same response. Each weekly probe re-runs every active query; old probes age out of the 30d window.

${aiVisibility.length === 0 ? '  (no probes yet — ai-visibility-probe will populate this weekly)' : aiVisibility.map(v => {
  const rate = (v.mention_rate * 100).toFixed(0)
  const compStr = v.top_competitors.length > 0 ? ` | competitors cited: ${v.top_competitors.map(c => `${c.name}×${c.count}`).join(', ')}` : ''
  return `  [${v.category}/${v.language}] "${v.query}" — mention rate ${rate}% (${v.mentions_total}/${v.probes_total} probes)${compStr}`
}).join('\n')}

=== INDUSTRY INTELLIGENCE — what the field is writing about (last 14d, relevance≥0.5) ===

Daily-ingested marketing/SEO/social + coffee-vertical articles, Haiku-summarized with a per-article relevance score for Minuto's organic stack. Read what the field is publishing. If an insight shapes a brief you emit, cite it in self_reflection so the audit trail is intact.

${industryInsights.length === 0 ? '  (no industry articles ingested yet — check industry-intelligence-sync cron)' : industryInsights.map(a => {
  const tagStr = a.tags.length > 0 ? ` [${a.tags.join(', ')}]` : ''
  return `  • [${a.source_name} / rel ${a.relevance.toFixed(2)}]${tagStr}\n    "${a.title}"\n    → ${a.insight}\n    ${a.url}`
}).join('\n\n')}

=== CUSTOMER SEGMENTS (RFM rollup) ===

Audience structure from customer_rfm. Aggregated rows only — no individual customer records.

  total_customers: ${customerSegments.total_customers}
  new_in_last_30d: ${customerSegments.new_in_last_30d}
  at_risk (>90d since last + repeat customer): ${customerSegments.at_risk_count}

  By segment:
${customerSegments.by_segment.length === 0 ? '  (no segments)' : customerSegments.by_segment.map(s =>
  `    [${s.segment}] count=${s.count}  avg_spent=₪${s.avg_total_spent_ils}  avg_orders=${s.avg_order_count}  avg_days_since=${s.avg_days_since_last}`,
).join('\n')}

=== COMPETITOR INTELLIGENCE (aggregated from existing signals) ===

LLM co-mentions over last 30d — competitors who keep showing up alongside Minuto (or instead of Minuto) in shopping-query probes:
${competitorIntel.llm_co_mentions.length === 0 ? '  (none — no LLM probes have surfaced competitors yet)' : competitorIntel.llm_co_mentions.map(c =>
  `  ${c.name} — mentioned ${c.mention_count_30d}× across ${c.queries_appearing_in} different queries`,
).join('\n')}

Recent market-research scans:
${competitorIntel.recent_research.length === 0 ? '  (none in last 30d)' : competitorIntel.recent_research.map(r =>
  `  [${r.research_date}] ${r.source} — ${r.summary_excerpt}…`,
).join('\n\n')}

=== POST-BY-POST FOLLOW-BACK (your own emissions, last 14d) ===

Current status + performance for each task you emitted in the last 14 days. Distinct from the aggregate top-performers blocks (those show site-wide winners; this shows your own emissions).

${postFollowback.length === 0 ? '  (no tasks in the last 14 days)' : postFollowback.map(p => {
  const parts: string[] = [`  [${p.task_type}${p.variation_label ? ':' + p.variation_label : ''}] ${p.task_id.slice(0,8)} ${p.brief_summary}`]
  if (p.task_type === 'text_generation') {
    if (p.wp_published === true)              parts.push(`    → LIVE on WP (post ${p.wp_post_id}); sessions:${p.ga4_sessions ?? 0} conversions:${p.ga4_conversions ?? 0}`)
    else if (p.wp_published === false)        parts.push(`    → drafted on WP (post ${p.wp_post_id}), NOT YET PUBLISHED by admin`)
    else if (p.wp_post_id)                    parts.push(`    → drafted on WP (post ${p.wp_post_id}), publish-status unknown`)
  } else if (p.task_type === 'instagram_post') {
    if (p.ig_published)                       parts.push(`    → LIVE on IG (${p.ig_permalink ?? p.ig_media_id}); reach:${p.meta_reach ?? '?'} engagements:${p.meta_engagement ?? '?'}`)
    else if (p.ig_creation_id)                parts.push(`    → PREPARED on Meta (creation_id ${p.ig_creation_id.slice(-8)}), AWAITING admin approval`)
    else                                       parts.push(`    → no IG container prepared`)
  } else if (p.task_type === 'dynamic_experiment') {
    parts.push(`    → ${p.status_note ?? '(no status)'}`)
  }
  if (p.status_note && !parts[parts.length - 1].includes(p.status_note)) parts.push(`    ⚠ ${p.status_note}`)
  return parts.join('\n')
}).join('\n')}

=== GA4 — ORGANIC LANDING-PAGE PERFORMANCE (last 30d) ===

Per-page sessions + conversions + value for organic search traffic, last 30d. Top pages by conversions:
${ga4LandingPages.length === 0 ? '  (no GA4 data — ga4-sync may not have run yet)' : ga4LandingPages.map(p => {
  const cvr = p.sessions > 0 ? (p.conversions / p.sessions * 100).toFixed(1) : '0.0'
  const bounce = p.avg_bounce_rate != null ? `bounce:${(p.avg_bounce_rate * 100).toFixed(0)}%` : ''
  const dur = p.avg_session_duration != null ? `dur:${p.avg_session_duration.toFixed(0)}s` : ''
  return `  ${p.page_path} — sess:${p.sessions} users:${p.active_users} conv:${p.conversions.toFixed(1)} (cvr ${cvr}%) value:₪${p.conversion_value.toFixed(0)} ${bounce} ${dur}`
}).join('\n')}
${focusBlock}
Now perform your self-reflection and emit a plan per the system prompt's format. Return strict JSON only.`
}
