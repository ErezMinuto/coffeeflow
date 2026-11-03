// Writes to an agent_missions row this worker claimed.
//
// Every write is fenced on the claiming worker_id AND status='active'. A
// mission cancelled mid-step (cancel_mission clears worker_id and sets
// 'cancelled'), or reclaimed by another worker after the lock expired, is then
// left alone instead of being overwritten with this step's state or status.
// Returns false when the fence rejected the write.

// deno-lint-ignore no-explicit-any
type Db = { from(table: string): any }

export async function updateIfOwned(
  supabase: Db,
  missionId: string,
  workerId: string,
  patch: Record<string, unknown>,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('agent_missions')
    .update(patch)
    .eq('id', missionId)
    .eq('worker_id', workerId)
    .eq('status', 'active')
    .select('id')
    .maybeSingle()
  if (error) {
    console.error(`[mission-worker] write to mission ${missionId} failed: ${error.message}`)
    return false
  }
  return !!data
}
