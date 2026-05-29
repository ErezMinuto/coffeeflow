// Minuto SEO Agent — Supabase DB helpers.
//
// All reads + writes against seo_tasks / seo_metrics / chat_messages
// funnel through here. Keeps SQL out of the orchestrator / worker /
// chat function bodies and centralizes column-name knowledge.

import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'
import type {
  NewSeoTask,
  SeoTaskRow,
  MetricsSnapshot,
  TaskType,
  TaskStatus,
} from './types.ts'

const SUPABASE_URL  = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

export function createSupabase(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

// ── seo_tasks ────────────────────────────────────────────────────────────

export async function insertTasks(
  supabase: SupabaseClient,
  tasks: NewSeoTask[],
): Promise<SeoTaskRow[]> {
  if (tasks.length === 0) return []
  const { data, error } = await supabase
    .from('seo_tasks')
    .insert(tasks)
    .select()
  if (error) throw new Error(`insertTasks failed: ${error.message}`)
  return (data ?? []) as SeoTaskRow[]
}

// Worker pickup: SELECT FOR UPDATE SKIP LOCKED equivalent via an RPC
// would be cleanest, but we can do it client-side by relying on the
// locked_until contract. The worker UPDATEs a single pending row to
// 'processing' + sets locked_until, returning the row. Concurrent
// workers either get a different row or hit a unique-pickup race that
// the optimistic check resolves.
export async function claimNextTask(
  supabase: SupabaseClient,
  taskType: TaskType,
  workerId: string,
  lockMinutes = 10,
): Promise<SeoTaskRow | null> {
  // Find eligible tasks of this type. Two kinds are claimable:
  //   1. status='pending' (normal queue)
  //   2. status='processing' with an EXPIRED locked_until — a STALE LOCK:
  //      the previous worker was hard-killed (e.g. edge wall-clock limit)
  //      mid-run and never released the lock or flipped status. Without
  //      reclaiming these, a crashed task is stuck in 'processing' forever
  //      and the worker no-ops (processed:0). Self-healing > a separate
  //      sweeper cron.
  const nowIso = new Date().toISOString()
  const { data: candidates, error: selErr } = await supabase
    .from('seo_tasks')
    .select('*')
    .eq('task_type', taskType)
    .lte('scheduled_for', nowIso)
    .or(`status.eq.pending,and(status.eq.processing,locked_until.lt.${nowIso})`)
    .order('scheduled_for', { ascending: true })
    .limit(5)  // small batch — try a few in case of races

  if (selErr) throw new Error(`claimNextTask select failed: ${selErr.message}`)
  if (!candidates || candidates.length === 0) return null

  // Try to atomically claim one. We update with a WHERE on the current
  // status so two workers can't both grab the same row.
  for (const candidate of candidates as SeoTaskRow[]) {
    // Skip if dependencies are not all complete.
    if (candidate.depends_on && candidate.depends_on.length > 0) {
      const { data: deps, error: depErr } = await supabase
        .from('seo_tasks')
        .select('id, status')
        .in('id', candidate.depends_on)
      if (depErr) continue
      const incomplete = (deps ?? []).filter(d => d.status !== 'completed')
      if (incomplete.length > 0) continue
    }

    const isStaleReclaim = candidate.status === 'processing'

    // A stale-locked row that has already burned its attempts is a
    // crash-looper (it keeps dying before it can mark itself failed).
    // Give up: mark it failed permanently instead of reclaiming forever.
    if (isStaleReclaim && candidate.attempts >= candidate.max_attempts) {
      await supabase
        .from('seo_tasks')
        .update({
          status:       'failed',
          error_msg:    `stale lock + attempts exhausted (${candidate.attempts}/${candidate.max_attempts}) — worker repeatedly died mid-run before completing`,
          locked_until: null,
        })
        .eq('id', candidate.id)
        .eq('status', 'processing')
        .lt('locked_until', nowIso)
      continue
    }

    const lockedUntil = new Date(Date.now() + lockMinutes * 60_000).toISOString()
    let upd = supabase
      .from('seo_tasks')
      .update({
        status:        'processing',
        attempts:      candidate.attempts + 1,
        locked_until:  lockedUntil,
        worker_id:     workerId,
        started_at:    new Date().toISOString(),
      })
      .eq('id', candidate.id)
    // Optimistic concurrency guard, scoped to what we're claiming:
    //   - pending row: only succeed if STILL pending
    //   - stale lock: only succeed if STILL processing AND STILL expired
    //     (so two workers can't both reclaim, and we don't steal a row a
    //     fresh worker just re-locked).
    upd = isStaleReclaim
      ? upd.eq('status', 'processing').lt('locked_until', nowIso)
      : upd.eq('status', 'pending')
    const { data: updated, error: updErr } = await upd.select().maybeSingle()
    if (updErr) continue
    if (updated) return updated as SeoTaskRow
    // Lost the race — try the next candidate.
  }
  return null
}

export async function markTaskCompleted(
  supabase: SupabaseClient,
  taskId: string,
  resultData: Record<string, unknown>,
): Promise<void> {
  const { error } = await supabase
    .from('seo_tasks')
    .update({
      status:       'completed',
      result_data:  resultData,
      completed_at: new Date().toISOString(),
      locked_until: null,
      error_msg:    null,
    })
    .eq('id', taskId)
  if (error) throw new Error(`markTaskCompleted failed: ${error.message}`)
}

export async function markTaskFailed(
  supabase: SupabaseClient,
  taskId: string,
  errorMsg: string,
  permanentlyFailed: boolean,
): Promise<void> {
  const { error } = await supabase
    .from('seo_tasks')
    .update({
      status:       permanentlyFailed ? 'failed' : 'pending',
      error_msg:    errorMsg.slice(0, 2000),
      locked_until: null,
    })
    .eq('id', taskId)
  if (error) throw new Error(`markTaskFailed failed: ${error.message}`)
}

// Sweeper: reset rows whose locked_until is in the past back to pending.
// Run from a separate cron every 5 min.
export async function sweepStuckTasks(supabase: SupabaseClient): Promise<number> {
  const { data, error } = await supabase
    .from('seo_tasks')
    .update({ status: 'pending', locked_until: null })
    .eq('status', 'processing')
    .lt('locked_until', new Date().toISOString())
    .select('id')
  if (error) throw new Error(`sweepStuckTasks failed: ${error.message}`)
  return (data ?? []).length
}

// For the orchestrator's self-reflection input — last N tasks of any
// status, newest first.
export async function getRecentTasks(
  supabase: SupabaseClient,
  sinceIsoDate: string,
  limit = 100,
): Promise<SeoTaskRow[]> {
  const { data, error } = await supabase
    .from('seo_tasks')
    .select('*')
    .gte('created_at', sinceIsoDate)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw new Error(`getRecentTasks failed: ${error.message}`)
  return (data ?? []) as SeoTaskRow[]
}

// ── seo_metrics ──────────────────────────────────────────────────────────

export async function insertMetrics(
  supabase: SupabaseClient,
  source: string,
  payload: MetricsSnapshot | Record<string, unknown>,
): Promise<string> {
  const { data, error } = await supabase
    .from('seo_metrics')
    .insert({ source, metrics_payload: payload })
    .select('id')
    .single()
  if (error) throw new Error(`insertMetrics failed: ${error.message}`)
  return (data as { id: string }).id
}

export async function getRecentMetricsSnapshots(
  supabase: SupabaseClient,
  source: string,
  limit = 5,
): Promise<Array<{ logged_at: string; metrics_payload: Record<string, unknown> }>> {
  const { data, error } = await supabase
    .from('seo_metrics')
    .select('logged_at, metrics_payload')
    .eq('source', source)
    .order('logged_at', { ascending: false })
    .limit(limit)
  if (error) throw new Error(`getRecentMetricsSnapshots failed: ${error.message}`)
  return (data ?? []) as Array<{ logged_at: string; metrics_payload: Record<string, unknown> }>
}

// ── chat_messages ───────────────────────────────────────────────────────

export async function appendChatMessage(
  supabase: SupabaseClient,
  args: {
    session_id: string
    role: 'user' | 'assistant' | 'tool' | 'system'
    content: string
    tool_calls?: unknown
    tool_call_id?: string
    metadata?: Record<string, unknown>
  },
): Promise<string> {
  const { data, error } = await supabase
    .from('chat_messages')
    .insert({
      session_id:   args.session_id,
      role:         args.role,
      content:      args.content,
      tool_calls:   args.tool_calls ?? null,
      tool_call_id: args.tool_call_id ?? null,
      metadata:     args.metadata ?? null,
    })
    .select('id')
    .single()
  if (error) throw new Error(`appendChatMessage failed: ${error.message}`)
  return (data as { id: string }).id
}

export async function getChatHistory(
  supabase: SupabaseClient,
  sessionId: string,
  limit = 50,
): Promise<Array<{
  role:         'user' | 'assistant' | 'tool' | 'system'
  content:      string
  tool_calls:   unknown
  tool_call_id: string | null
}>> {
  // CRITICAL: must fetch the MOST-RECENT `limit` messages, not the
  // oldest. Earlier this used `.order(..., ascending:true).limit(50)`
  // which silently truncated the newest messages once a session
  // exceeded 50 rows — including the user message we just persisted —
  // causing the messages array sent to Anthropic to end on an
  // assistant turn, and 400 with "conversation must end with user
  // message".
  // Fetch newest-first, then reverse client-side so the caller still
  // sees chronological order (oldest → newest, latest user message last).
  const { data, error } = await supabase
    .from('chat_messages')
    .select('role, content, tool_calls, tool_call_id, created_at')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw new Error(`getChatHistory failed: ${error.message}`)
  const rows = (data ?? []) as Array<{
    role:         'user' | 'assistant' | 'tool' | 'system'
    content:      string
    tool_calls:   unknown
    tool_call_id: string | null
    created_at:   string
  }>
  // Reverse to chronological order; strip created_at since callers
  // expect the original shape.
  return rows.reverse().map(({ created_at: _ts, ...rest }) => rest)
}

// ── Learnings (cross-session memory) ─────────────────────────────────────
// Insights from admin chat persist here so the next session — and the
// next orchestrator run — can apply them. Soft-supersede pattern: rows
// are never deleted, just marked superseded with a reason.

import type { LearningRow, NewLearning } from './types.ts'

export async function recordLearning(
  supabase: SupabaseClient,
  learning: NewLearning,
): Promise<LearningRow> {
  const { data, error } = await supabase
    .from('seo_learnings')
    .insert({
      scope:             learning.scope,
      insight:           learning.insight,
      evidence_task_ids: learning.evidence_task_ids ?? [],
      created_by:        learning.created_by,
    })
    .select('*')
    .single()
  if (error) throw new Error(`recordLearning failed: ${error.message}`)
  return data as LearningRow
}

// Default read path for both chat prompt + strategist prompt: active
// (non-superseded) learnings, newest first. `scopes` filter is optional
// — the chat agent loads everything, the orchestrator can narrow to
// just the scopes relevant to planning.
export async function getRecentLearnings(
  supabase: SupabaseClient,
  opts: { scopes?: string[]; limit?: number } = {},
): Promise<LearningRow[]> {
  let q = supabase
    .from('seo_learnings')
    .select('*')
    .is('superseded_at', null)
    .order('created_at', { ascending: false })
    .limit(opts.limit ?? 20)
  if (opts.scopes && opts.scopes.length > 0) {
    q = q.in('scope', opts.scopes)
  }
  const { data, error } = await q
  if (error) throw new Error(`getRecentLearnings failed: ${error.message}`)
  return (data ?? []) as LearningRow[]
}

// ── System config — tunable runtime thresholds ─────────────────────────
// Single key-value store readable from any worker / evaluator. Functions
// fetch overrides + fall back to their hardcoded defaults if no row.

export async function getSystemConfig<T = unknown>(
  supabase: SupabaseClient,
  key: string,
  fallback: T,
): Promise<T> {
  const { data, error } = await supabase
    .from('system_config')
    .select('value')
    .eq('key', key)
    .maybeSingle()
  if (error) {
    console.warn(`[db] getSystemConfig('${key}') failed; using fallback: ${error.message}`)
    return fallback
  }
  if (!data) return fallback
  // value is JSONB — could be number / string / object. Cast and trust caller.
  return data.value as T
}

export async function listSystemConfig(supabase: SupabaseClient): Promise<Array<{
  key: string
  value: unknown
  description: string | null
  updated_at: string
  updated_by: string | null
  reasoning: string | null
}>> {
  const { data, error } = await supabase
    .from('system_config')
    .select('*')
    .order('key', { ascending: true })
  if (error) throw new Error(`listSystemConfig failed: ${error.message}`)
  return (data ?? []) as any
}

export async function setSystemConfig(
  supabase: SupabaseClient,
  key: string,
  value: unknown,
  updatedBy: string,
  reasoning: string,
): Promise<void> {
  const { error } = await supabase
    .from('system_config')
    .upsert({
      key,
      value: value as any,
      updated_by: updatedBy,
      reasoning,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'key' })
  if (error) throw new Error(`setSystemConfig('${key}') failed: ${error.message}`)
}

export async function supersedeLearning(
  supabase: SupabaseClient,
  id: string,
  reason: string,
  supersededBy?: string,
): Promise<void> {
  const { error } = await supabase
    .from('seo_learnings')
    .update({
      superseded_at:     new Date().toISOString(),
      superseded_reason: reason,
      superseded_by:     supersededBy ?? null,
    })
    .eq('id', id)
    .is('superseded_at', null)  // don't re-supersede an already-superseded row
  if (error) throw new Error(`supersedeLearning failed: ${error.message}`)
}

// ── Experiments (autonomous A/B testing) ─────────────────────────────────
// The orchestrator queues N variations of a content task under one
// experiment_id, waits for performance data, then auto-scores and writes
// a learning. These helpers are the read/write surface for that loop.

import type { NewExperiment, SeoExperimentRow } from './types.ts'

export async function insertExperiment(
  supabase: SupabaseClient,
  experiment: NewExperiment,
): Promise<SeoExperimentRow> {
  const { data, error } = await supabase
    .from('seo_experiments')
    .insert(experiment)
    .select('*')
    .single()
  if (error) throw new Error(`insertExperiment failed: ${error.message}`)
  return data as SeoExperimentRow
}

// Find experiments due for evaluation: still in 'collecting' status AND
// past their per-experiment min_lookback_days threshold. Each row tells
// the evaluator how to score (primary_metric, min_sample_size, etc.).
export async function getExperimentsDueForEvaluation(
  supabase: SupabaseClient,
  limit = 10,
): Promise<SeoExperimentRow[]> {
  // Postgres can compute the cutoff per-row via the column itself.
  // Using a raw filter: created_at + min_lookback_days * 1day <= now
  const { data, error } = await supabase
    .from('seo_experiments')
    .select('*')
    .eq('status', 'collecting')
    .order('created_at', { ascending: true })
    .limit(limit * 5)  // pull extra; we filter in JS for the date math
  if (error) throw new Error(`getExperimentsDueForEvaluation failed: ${error.message}`)
  const now = Date.now()
  return ((data ?? []) as SeoExperimentRow[])
    .filter(e => {
      const eligible = new Date(e.created_at).getTime() + e.min_lookback_days * 24 * 3600 * 1000
      return eligible <= now
    })
    .slice(0, limit)
}

export async function getExperimentVariations(
  supabase: SupabaseClient,
  experimentId: string,
): Promise<SeoTaskRow[]> {
  const { data, error } = await supabase
    .from('seo_tasks')
    .select('*')
    .eq('experiment_id', experimentId)
    .order('created_at', { ascending: true })
  if (error) throw new Error(`getExperimentVariations failed: ${error.message}`)
  return (data ?? []) as SeoTaskRow[]
}

export async function updateExperimentStatus(
  supabase: SupabaseClient,
  id: string,
  patch: {
    status:                ExperimentStatusUpdate
    winner_task_id?:       string | null
    evaluation_summary?:   Record<string, unknown> | null
    recorded_learning_id?: string | null
  },
): Promise<void> {
  const update: Record<string, unknown> = {
    status:       patch.status,
    evaluated_at: new Date().toISOString(),
  }
  if (patch.winner_task_id !== undefined)       update.winner_task_id = patch.winner_task_id
  if (patch.evaluation_summary !== undefined)   update.evaluation_summary = patch.evaluation_summary
  if (patch.recorded_learning_id !== undefined) update.recorded_learning_id = patch.recorded_learning_id
  const { error } = await supabase
    .from('seo_experiments')
    .update(update)
    .eq('id', id)
  if (error) throw new Error(`updateExperimentStatus failed: ${error.message}`)
}

type ExperimentStatusUpdate = 'evaluating' | 'evaluated' | 'inconclusive' | 'cancelled'
