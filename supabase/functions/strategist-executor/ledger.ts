// strategic_recommendations bookkeeping for the executor: claim, finish, sweep.
//
// A claim moves the row approved → drafting. Only 'approved' rows are ever
// claimed, so once a worker has a row no other worker can draft it again, even
// after its lock expires. (Before, the claim only set locked_until on an
// 'approved' row and the final 'drafted' update was unchecked: when that update
// failed the row stayed approved and was drafted a second time once the lock
// ran out.)
//
// The finishing update is fenced on status='drafting' AND this worker's id and
// its result is checked, so a row the sweep (or a human) has already moved is
// never overwritten.
//
// A row left in 'drafting' past its lock means the worker died mid-draft. The
// sweep marks it failed and says a draft may already exist, rather than
// silently drafting it again.

import type { RecommendationRow } from '../seo-agent/types.ts'

export const LOCK_MINUTES = 5
const TABLE = 'strategic_recommendations'

// deno-lint-ignore no-explicit-any
type Db = { from(table: string): any }

export async function sweepStaleDrafting(supabase: Db, nowMs = Date.now()): Promise<number> {
  const nowIso = new Date(nowMs).toISOString()
  const { data, error } = await supabase
    .from(TABLE)
    .update({
      status: 'failed',
      draft_error: 'executor stopped mid-draft (lock expired). A draft may already exist: check the drafts before approving this again.',
      locked_until: null,
      updated_at: nowIso,
    })
    .eq('status', 'drafting')
    .lt('locked_until', nowIso)
    .select('id')
  if (error) throw new Error(`sweepStaleDrafting failed: ${error.message}`)
  return (data ?? []).length
}

export async function claimRecs(
  supabase: Db,
  workerId: string,
  actionTypes: string[],
  batch: number,
  nowMs = Date.now(),
): Promise<RecommendationRow[]> {
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .eq('status', 'approved')
    .in('action_type', actionTypes)
    .order('created_at', { ascending: true })
    .limit(batch * 2)
  if (error) throw new Error(`claimRecs select failed: ${error.message}`)
  const claimed: RecommendationRow[] = []
  for (const r of (data ?? []) as RecommendationRow[]) {
    const { data: got } = await supabase
      .from(TABLE)
      .update({
        status: 'drafting',
        locked_until: new Date(nowMs + LOCK_MINUTES * 60_000).toISOString(),
        worker_id: workerId,
        updated_at: new Date(nowMs).toISOString(),
      })
      .eq('id', r.id)
      .eq('status', 'approved')
      .select('*')
      .maybeSingle()
    if (got) claimed.push(got as RecommendationRow)
    if (claimed.length >= batch) break
  }
  return claimed
}

/** Write the outcome for a row this worker holds. Returns null on success, or
 *  why the row was not updated (a DB error, or the row is no longer ours). */
export async function finishRec(
  supabase: Db,
  recId: string,
  workerId: string,
  patch: Record<string, unknown>,
): Promise<string | null> {
  let last = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data, error } = await supabase
      .from(TABLE)
      .update({ ...patch, locked_until: null, updated_at: new Date().toISOString() })
      .eq('id', recId)
      .eq('status', 'drafting')
      .eq('worker_id', workerId)
      .select('id')
      .maybeSingle()
    if (!error && data) return null
    if (!error) return 'row is no longer held by this worker (swept or changed meanwhile)'
    last = error.message
  }
  return last
}
