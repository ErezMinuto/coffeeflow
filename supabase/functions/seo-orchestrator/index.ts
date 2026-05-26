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
} from '../seo-agent/db.ts'
import { fetchTopKeywords, computePositionDeltas } from '../seo-agent/services/googleApi.ts'
import {
  fetchRecentBlogPosts,
  fetchActiveCatalog,
  fetchInventoryAlerts,
} from '../seo-agent/services/cmsApi.ts'
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
  console.log(`[seo-orchestrator] run=${runId} trigger=${trigger} focus="${focus.slice(0, 100)}"`)

  try {
    const supabase = createSupabase()

    // ── 1. Fetch source data ──────────────────────────────────────────
    console.log('[seo-orchestrator] fetching source data…')
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
    ])

    console.log(
      `[seo-orchestrator] sources — gsc:${gscKeywords.length} ` +
      `blog:${blogPosts.length} catalog:${catalog.length} ` +
      `inv:${inventoryAlerts.length} recentTasks:${recentTasks.length} ` +
      `priorSnapshots:${priorSnapshots.length} learnings:${learnings.length}`,
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
    console.log(`[seo-orchestrator] snapshot inserted id=${snapshotId}`)

    // ── 3. Build user message for the strategist ─────────────────────
    const userMessage = buildStrategistUserMessage({
      focus,
      snapshot,
      recentTasks,
      blogPosts,
      catalog,
      inventoryAlerts,
      learnings,
    })

    // ── 4. Call Claude ───────────────────────────────────────────────
    console.log(`[seo-orchestrator] calling ${MODEL_ORCHESTRATOR}…`)
    const claudeRes = await callClaude({
      model:    MODEL_ORCHESTRATOR,
      system:   STRATEGIST_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
      maxTokens:  8192,
      temperature: 0.7,  // balanced — needs creativity but also structure
    })
    console.log(
      `[seo-orchestrator] strategist done — tokens: ` +
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
      console.error('[seo-orchestrator] failed to parse strategist output:', e?.message)
      console.error('[seo-orchestrator] raw text:', claudeRes.text.slice(0, 1000))
      return jsonResponse({
        error:             'strategist returned unparseable JSON',
        run_id:            runId,
        snapshot_id:       snapshotId,
        raw:               claudeRes.text.slice(0, 2000),
      }, 502)
    }
    const emittedTasks = Array.isArray(plan.tasks) ? plan.tasks : []
    console.log(
      `[seo-orchestrator] plan parsed — ` +
      `summary="${(plan.summary ?? '').slice(0, 80)}" ` +
      `reflections=${plan.self_reflection?.length ?? 0} ` +
      `tasks=${emittedTasks.length}`,
    )

    // ── 6. Insert tasks with parent/dependency wiring ────────────────
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
        // Omit scheduled_for entirely (don't set undefined — Supabase
        // serializes undefined as null and the column is NOT NULL) so
        // the column's DEFAULT NOW() fires when no offset is set.
        if (et.scheduled_offset_hours) {
          base.scheduled_for = new Date(Date.now() + et.scheduled_offset_hours * 3600 * 1000).toISOString()
        }
        return base
      })
      insertedRows = await insertTasks(supabase, newTasks)
      console.log(`[seo-orchestrator] first-pass insert: ${insertedRows.length} rows`)

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
        if (error) console.warn(`[seo-orchestrator] wire-up update failed for ${u.id}: ${error.message}`)
      }
      console.log(`[seo-orchestrator] wire-up updates: ${updates.length}`)
    }

    // ── 7. Return summary ────────────────────────────────────────────
    return jsonResponse({
      success:        true,
      run_id:         runId,
      snapshot_id:    snapshotId,
      summary:        plan.summary ?? '',
      self_reflection: plan.self_reflection ?? [],
      tasks_emitted:  insertedRows.length,
      task_ids:       insertedRows.map(r => r.id),
      tokens: {
        input:  claudeRes.inputTokens,
        output: claudeRes.outputTokens,
        cache_read: claudeRes.cacheReadTokens,
      },
    })
  } catch (e: any) {
    console.error('[seo-orchestrator] failed:', e?.message ?? e)
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
}): string {
  const { focus, snapshot, recentTasks, blogPosts, catalog, inventoryAlerts, learnings } = args

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
${focusBlock}
Now perform your self-reflection and emit a plan per the system prompt's format. Return strict JSON only.`
}
