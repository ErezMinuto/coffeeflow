// strategic_recommendations bookkeeping for the closed loop's critic and
// exporter. Shared by strategist-executor (export) and strategist-evaluator
// (critique), so it lives in _shared/ rather than in either function.

import type { RecommendationRow } from '../seo-agent/types.ts'

// deno-lint-ignore no-explicit-any
type Db = { from(table: string): any }
const TABLE = 'strategic_recommendations'

// ── Closed loop: critique + export claims ────────────────────────────────────
//
// 'awaiting_critique' and 'exporting' rows are unclaimed while worker_id is
// NULL. A claim sets worker_id + a lock, fenced on worker_id IS NULL, so two
// ticks never take the same row. The status itself does not change on claim:
// the finishing update moves it on, fenced on this worker's id.

export const CRITIQUE_LOCK_MINUTES = 4
export const EXPORT_LOCK_MINUTES = 4
export const MAX_CRITIQUE_ATTEMPTS = 3

export async function claimLoopRows(
  supabase: Db,
  status: 'awaiting_critique' | 'exporting',
  workerId: string,
  batch: number,
  nowMs = Date.now(),
): Promise<RecommendationRow[]> {
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .eq('status', status)
    .is('worker_id', null)
    .order('created_at', { ascending: true })
    .limit(batch * 2)
  if (error) throw new Error(`claimLoopRows(${status}) select failed: ${error.message}`)
  const lockMin = status === 'exporting' ? EXPORT_LOCK_MINUTES : CRITIQUE_LOCK_MINUTES
  const claimed: RecommendationRow[] = []
  for (const r of (data ?? []) as RecommendationRow[]) {
    const patch: Record<string, unknown> = {
      worker_id: workerId,
      locked_until: new Date(nowMs + lockMin * 60_000).toISOString(),
      updated_at: new Date(nowMs).toISOString(),
    }
    if (status === 'awaiting_critique') patch.critique_attempts = (r.critique_attempts ?? 0) + 1
    const { data: got } = await supabase
      .from(TABLE)
      .update(patch)
      .eq('id', r.id)
      .eq('status', status)
      .is('worker_id', null)
      .select('*')
      .maybeSingle()
    if (got) claimed.push(got as RecommendationRow)
    if (claimed.length >= batch) break
  }
  return claimed
}

/** Recover loop rows whose worker died. A critique has no side effects, so it is
 *  released for another try, until MAX_CRITIQUE_ATTEMPTS, then handed to Erez.
 *  An export may already have happened (WP draft / campaign row), so it is
 *  marked failed with a note, never silently retried. */
export async function sweepStaleLoop(supabase: Db, nowMs = Date.now()): Promise<number> {
  const nowIso = new Date(nowMs).toISOString()
  let n = 0
  const { data: crit, error: e1 } = await supabase
    .from(TABLE)
    .select('id, critique_attempts, worker_id')
    .eq('status', 'awaiting_critique')
    .lt('locked_until', nowIso)
  if (e1) throw new Error(`sweepStaleLoop select failed: ${e1.message}`)
  for (const r of (crit ?? []) as Array<{ id: string; critique_attempts: number; worker_id: string | null }>) {
    if (!r.worker_id) continue
    const exhausted = (r.critique_attempts ?? 0) >= MAX_CRITIQUE_ATTEMPTS
    const { data } = await supabase
      .from(TABLE)
      .update(exhausted
        ? { status: 'needs_human', draft_error: `critic stopped mid-review ${r.critique_attempts} times; nothing was exported`, worker_id: null, locked_until: null, updated_at: nowIso }
        : { worker_id: null, locked_until: null, updated_at: nowIso })
      .eq('id', r.id)
      .eq('status', 'awaiting_critique')
      .eq('worker_id', r.worker_id)
      .select('id')
      .maybeSingle()
    if (data) n++
  }
  const { data: exp, error: e2 } = await supabase
    .from(TABLE)
    .update({
      status: 'failed',
      draft_error: 'executor stopped mid-export (lock expired). The draft may already exist in WordPress / campaigns / the ad account: check before re-approving.',
      locked_until: null,
      updated_at: nowIso,
    })
    .eq('status', 'exporting')
    .lt('locked_until', nowIso)
    .select('id')
  if (e2) throw new Error(`sweepStaleLoop export sweep failed: ${e2.message}`)
  return n + (exp ?? []).length
}

/** Move a row this worker holds to its next state. Fenced on the status it was
 *  claimed in AND this worker's id; returns null on success, else why not. */
export async function finishLoopRow(
  supabase: Db,
  recId: string,
  workerId: string,
  heldStatus: 'awaiting_critique' | 'exporting',
  patch: Record<string, unknown>,
): Promise<string | null> {
  let last = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data, error } = await supabase
      .from(TABLE)
      .update({ ...patch, locked_until: null, updated_at: new Date().toISOString() })
      .eq('id', recId)
      .eq('status', heldStatus)
      .eq('worker_id', workerId)
      .select('id')
      .maybeSingle()
    if (!error && data) return null
    if (!error) return 'row is no longer held by this worker (swept or changed meanwhile)'
    last = error.message
  }
  return last
}
